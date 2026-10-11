/**
 * src/brain/mode-manager.js
 *
 * Decides the operating mode and which alerts each mode allows.
 *
 * The boat spends most of its powered-on time alongside: every boot used to
 * start in "sailing", so the first AIS scan announced collisions with the boats
 * moving in the marina and the depth check announced shallow water at every low
 * tide. Hence:
 *
 *   - start in "moored" (or "anchored" when the anchor was down at shutdown);
 *   - leave "moored" on its own once the boat really moves, whoever selected it:
 *     forgetting to switch mode must never take the boat to sea without
 *     collision alerts;
 *   - never leave "anchored" on its own: at anchor, moving means dragging, and
 *     that is the anchor alarm's job, not a reason to change mode;
 *   - at anchor, warn about depth once per anchorage, ahead of time from the
 *     tide when possible, instead of on every check.
 *
 * Pure logic (no timers, no I/O) so it can be tested with plain values.
 */

const KNOTS_PER_MS = 1.943844;

const STATIONARY_MODES = ['moored', 'anchored'];

const DEFAULTS = {
    // Underway once SOG stays above this for `movingSustainSeconds`...
    movingSogKnots: 1.5,
    movingSustainSeconds: 45,
    // ...or once the boat is this far from where it was when moored. GPS noise
    // alongside stays well under 30 m; leaving a berth covers 100 m in a minute.
    movingDistanceMeters: 120
};

/** Great-circle distance in metres between two {latitude, longitude}. */
function distanceMeters(a, b) {
    const R = 6371000;
    const rad = Math.PI / 180;
    const dLat = (b.latitude - a.latitude) * rad;
    const dLon = (b.longitude - a.longitude) * rad;
    const h = Math.sin(dLat / 2) ** 2
        + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

function validPosition(p) {
    return p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude) ? p : null;
}

class ModeManager {
    /**
     * @param {object} [options]  thresholds overriding DEFAULTS
     */
    constructor(options = {}) {
        this.options = { ...DEFAULTS, ...options };
        this.mode = 'moored';
        this.source = 'startup';
        this._resetMovement();
    }

    /**
     * Mode at startup.
     * @param {boolean} anchorDown  anchor dropped (persisted) when the system stopped
     * @returns {string}
     */
    startupMode(anchorDown) {
        return anchorDown ? 'anchored' : 'moored';
    }

    /**
     * Record a mode change.
     * @param {string} mode
     * @param {'startup'|'auto'|'user'} source
     */
    setMode(mode, source) {
        this.mode = mode;
        this.source = source;
        this._resetMovement();
    }

    /** @returns {boolean} true for the modes where the boat is not under way */
    isStationary(mode = this.mode) {
        return STATIONARY_MODES.includes(mode);
    }

    /**
     * Feed one observation; returns the mode to switch to, or null.
     *
     * @param {object} obs
     * @param {number|null} obs.sogMs          speed over ground, m/s
     * @param {object|null} obs.position       { latitude, longitude }
     * @param {boolean}     obs.engineRunning
     * @param {number}      obs.now            epoch ms
     * @returns {string|null}
     */
    observe({ sogMs, position, engineRunning, now }) {
        if (this.mode !== 'moored') return null;

        const pos = validPosition(position);
        if (pos && !this._reference) this._reference = pos;

        const sogKn = Number.isFinite(sogMs) ? sogMs * KNOTS_PER_MS : null;
        if (sogKn !== null && sogKn >= this.options.movingSogKnots) {
            if (this._movingSince === null) this._movingSince = now;
        } else {
            this._movingSince = null;
        }

        const sustained = this._movingSince !== null
            && now - this._movingSince >= this.options.movingSustainSeconds * 1000;
        const displaced = pos && this._reference
            && distanceMeters(this._reference, pos) >= this.options.movingDistanceMeters;

        if (!sustained && !displaced) return null;
        return engineRunning ? 'motoring' : 'sailing';
    }

    /**
     * Which alerts the current mode allows.
     * @returns {{ collision: boolean, depth: 'continuous'|'once'|'off', routine: boolean }}
     *   collision: AIS collision announcements
     *   depth:     'continuous' under way, 'once' per anchorage, 'off' alongside
     *   routine:   periodic spoken updates (navigation point)
     */
    alertPolicy(mode = this.mode) {
        if (mode === 'moored') return { collision: false, depth: 'off', routine: false };
        if (mode === 'anchored') return { collision: false, depth: 'once', routine: false };
        return { collision: true, depth: 'continuous', routine: true };
    }

    _resetMovement() {
        this._reference = null;
        this._movingSince = null;
    }
}

/**
 * Lowest depth expected before the next high water, from the current depth and
 * the tide. Null when the tide does not say the water is going down.
 *
 * @param {number} depth  current depth (below keel, else transducer), metres
 * @param {object|null} tide  output of TidesProvider.getTideData()
 * @param {Date} now
 * @returns {{ depth: number, time: Date }|null}
 */
function lowestDepthAhead(depth, tide, now = new Date()) {
    const low = tide?.next?.low;
    const height = tide?.current?.height;
    if (!Number.isFinite(depth) || !low || !Number.isFinite(low.height) || !Number.isFinite(height)) {
        return null;
    }
    const lowTime = low.time instanceof Date ? low.time : new Date(low.time);
    const high = tide?.next?.high;
    const highTime = high ? (high.time instanceof Date ? high.time : new Date(high.time)) : null;
    // Only when low water comes before the next high water and is still ahead
    if (lowTime <= now || (highTime && highTime < lowTime)) return null;
    const drop = height - low.height;
    if (!(drop > 0)) return null;
    return { depth: depth - drop, time: lowTime };
}

ModeManager.DEFAULTS = DEFAULTS;
ModeManager.distanceMeters = distanceMeters;
ModeManager.lowestDepthAhead = lowestDepthAhead;

module.exports = ModeManager;
