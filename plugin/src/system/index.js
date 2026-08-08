/**
 * System metrics for the host Raspberry Pi.
 *
 * Everything here is read from /proc and /sys — no shelling out, so it stays
 * cheap enough to poll from the UI on a Pi that is also driving two kiosks.
 */

const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const HZ = 100;                 // USER_HZ, fixed at 100 on Raspberry Pi OS
const PAGE_SIZE = 4096;

/** Read a file, returning null instead of throwing when it is absent. */
function readOr(path, fallback = null) {
    try {
        return fs.readFileSync(path, 'utf8');
    } catch {
        return fallback;
    }
}

/**
 * SoC temperature in °C.
 * @returns {number|null}
 */
function cpuTemperature() {
    const raw = readOr('/sys/class/thermal/thermal_zone0/temp');
    if (raw === null) return null;
    const milli = parseInt(raw.trim(), 10);
    return Number.isFinite(milli) ? Math.round(milli / 100) / 10 : null;
}

/**
 * Throttling flags from the VideoCore firmware, decoded.
 * Bit 0/1/2/3 = currently under-voltage / freq-capped / throttled / soft temp limit.
 * Bits 16-19 = the same, but "has occurred since boot".
 * @returns {object|null}
 */
function throttling() {
    // No sysfs entry exists on Pi OS bookworm/Pi 5, so vcgencmd it is. Cheap
    // enough (single firmware mailbox round-trip) at UI polling rates.
    let raw = readOr('/sys/devices/platform/soc/soc:firmware/get_throttled');
    if (raw === null) {
        try {
            raw = execFileSync('vcgencmd', ['get_throttled'], { timeout: 2000, encoding: 'utf8' })
                .split('=')[1];
        } catch {
            return null;
        }
    }
    const bits = parseInt(String(raw).trim(), 16);
    if (!Number.isFinite(bits)) return null;
    return {
        raw: '0x' + bits.toString(16),
        underVoltageNow: !!(bits & 0x1),
        frequencyCappedNow: !!(bits & 0x2),
        throttledNow: !!(bits & 0x4),
        softTempLimitNow: !!(bits & 0x8),
        underVoltageSinceBoot: !!(bits & 0x10000),
        frequencyCappedSinceBoot: !!(bits & 0x20000),
        throttledSinceBoot: !!(bits & 0x40000),
        softTempLimitSinceBoot: !!(bits & 0x80000)
    };
}

/** Aggregate + per-core CPU jiffies. @returns {{total:number, idle:number}[]} */
function readCpuJiffies() {
    const stat = readOr('/proc/stat', '');
    const out = [];
    for (const line of stat.split('\n')) {
        if (!/^cpu\d*\s/.test(line)) continue;
        const v = line.trim().split(/\s+/).slice(1).map(Number);
        const idle = (v[3] || 0) + (v[4] || 0);          // idle + iowait
        const total = v.reduce((a, b) => a + (b || 0), 0);
        out.push({ total, idle });
    }
    return out;
}

/** Memory, in bytes. @returns {object} */
function memory() {
    const info = readOr('/proc/meminfo', '');
    const kb = {};
    for (const line of info.split('\n')) {
        const m = line.match(/^(\w+):\s+(\d+) kB/);
        if (m) kb[m[1]] = parseInt(m[2], 10);
    }
    const total = (kb.MemTotal || 0) * 1024;
    const available = (kb.MemAvailable || 0) * 1024;
    return {
        total,
        available,
        used: total - available,
        usedPercent: total ? Math.round(((total - available) / total) * 1000) / 10 : null,
        swapTotal: (kb.SwapTotal || 0) * 1024,
        swapUsed: ((kb.SwapTotal || 0) - (kb.SwapFree || 0)) * 1024
    };
}

/** Root filesystem usage, in bytes. @returns {object|null} */
function disk() {
    try {
        const s = fs.statfsSync('/');
        const total = s.blocks * s.bsize;
        const free = s.bavail * s.bsize;
        return {
            total,
            free,
            used: total - free,
            usedPercent: total ? Math.round(((total - free) / total) * 1000) / 10 : null
        };
    } catch {
        return null;
    }
}

/**
 * Top processes by CPU share since the previous call, then by RSS.
 *
 * CPU percentages are meaningless from a single sample, so the first call
 * establishes a baseline and reports RSS-ordered processes with cpuPercent null.
 */
class SystemMetrics {
    constructor() {
        this._prevProc = new Map();   // pid -> jiffies
        this._prevCpu = null;         // aggregate jiffies
        this._prevAt = 0;
    }

    _topProcesses(limit, elapsedTotalJiffies) {
        const procs = [];
        let pids;
        try {
            pids = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n));
        } catch {
            return [];
        }

        const nextProc = new Map();
        for (const pid of pids) {
            const stat = readOr(`/proc/${pid}/stat`);
            if (stat === null) continue;
            // comm can contain spaces and parentheses — split on the last ')'
            const close = stat.lastIndexOf(')');
            const open = stat.indexOf('(');
            if (close < 0 || open < 0) continue;
            const name = stat.slice(open + 1, close);
            const rest = stat.slice(close + 2).split(' ');
            const utime = Number(rest[11]);
            const stime = Number(rest[12]);
            const rss = Number(rest[21]);
            if (!Number.isFinite(utime) || !Number.isFinite(stime)) continue;

            const jiffies = utime + stime;
            nextProc.set(pid, jiffies);

            let cpuPercent = null;
            const prev = this._prevProc.get(pid);
            if (prev !== undefined && elapsedTotalJiffies > 0) {
                cpuPercent = Math.round(((jiffies - prev) / elapsedTotalJiffies) * 100 * 10) / 10;
                if (cpuPercent < 0) cpuPercent = 0;
            }

            procs.push({
                pid: Number(pid),
                name,
                cpuPercent,
                memoryBytes: Number.isFinite(rss) ? rss * PAGE_SIZE : null
            });
        }
        this._prevProc = nextProc;

        const haveCpu = procs.some(p => p.cpuPercent !== null);
        procs.sort((a, b) => haveCpu
            ? (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1)
            : (b.memoryBytes ?? -1) - (a.memoryBytes ?? -1));

        return procs.slice(0, limit);
    }

    /**
     * @param {number} [topN=8] - how many processes to return
     * @returns {object} host metrics
     */
    snapshot(topN = 8) {
        const cpus = readCpuJiffies();
        const aggregate = cpus[0] || null;

        let cpuPercent = null;
        let perCore = null;
        let elapsedTotal = 0;

        if (aggregate && this._prevCpu) {
            const dTotal = aggregate.total - this._prevCpu[0].total;
            const dIdle = aggregate.idle - this._prevCpu[0].idle;
            elapsedTotal = dTotal;
            if (dTotal > 0) {
                cpuPercent = Math.round(((dTotal - dIdle) / dTotal) * 1000) / 10;
            }
            perCore = cpus.slice(1).map((c, i) => {
                const p = this._prevCpu[i + 1];
                if (!p) return null;
                const dt = c.total - p.total;
                const di = c.idle - p.idle;
                return dt > 0 ? Math.round(((dt - di) / dt) * 1000) / 10 : null;
            });
        }
        this._prevCpu = cpus;
        this._prevAt = Date.now();

        return {
            timestamp: new Date().toISOString(),
            hostname: os.hostname(),
            uptimeSeconds: Math.round(os.uptime()),
            cpu: {
                percent: cpuPercent,
                perCore,
                cores: Math.max(cpus.length - 1, 0),
                loadAverage: os.loadavg().map(v => Math.round(v * 100) / 100),
                temperature: cpuTemperature(),
                throttling: throttling()
            },
            memory: memory(),
            disk: disk(),
            processes: this._topProcesses(topN, elapsedTotal)
        };
    }
}

module.exports = SystemMetrics;
module.exports.cpuTemperature = cpuTemperature;
