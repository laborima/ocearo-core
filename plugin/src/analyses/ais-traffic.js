/**
 * src/analyses/ais-traffic.js
 *
 * Decides which AIS collision alerts are worth saying aloud and writing to the
 * logbook. The AIS analyzer flags every vessel at risk; spoken one by one, a
 * busy channel became a stream of alarms (5 in 4 minutes leaving La Rochelle
 * on 2026-10-10, 101 logbook entries that day) until the crew silenced
 * everything, the real alarms included.
 *
 *   - one vessel at risk: said, said once more if the risk lasts, then not
 *     again for that encounter;
 *   - busy waters (several vessels at risk at once: a channel, a harbour
 *     approach): one grouped announcement, repeated once, then silence while
 *     it stays busy — except a vessel about to be on top of us;
 *   - back to calm: single-vessel alerts again, for the one nobody saw coming.
 *
 * Pure logic (no timers, no I/O): fed the analyzer's result and the time.
 */

const DEFAULTS = {
    busyCount: 3,          // vessels at risk at once for busy waters
    calmCount: 1,          // at most this many at risk...
    calmMs: 2 * 60_000,    // ...for this long ends busy waters
    groupRepeatMs: 3 * 60_000,
    maxRepeats: 2,         // times a vessel (or a busy episode) is announced
    encounterEndMs: 5 * 60_000, // a vessel no longer at risk this long: new encounter
    // On top of us: always said, busy or not
    extremeCpaNm: 0.02,    // about 40 m
    extremeTcpaMin: 1.5
};

const atRisk = (t) => t.risk === 'danger' || t.risk === 'caution';
const keyOf = (t) => t.mmsi || t.target || t.name || 'unknown';

class AisTrafficGate {
    constructor(options = {}) {
        this.options = { ...DEFAULTS, ...options };
        this.busy = false;
        this._calmSince = null;
        this._groupAnnounced = 0;
        this._groupAt = 0;
        this._encounters = new Map(); // key -> { announced, lastAtRisk }
    }

    /** True for a vessel about to be on top of us */
    isExtreme(alert) {
        const { extremeCpaNm, extremeTcpaMin } = this.options;
        return Number.isFinite(alert.cpa) && Number.isFinite(alert.tcpa)
            && alert.cpa <= extremeCpaNm && alert.tcpa > 0 && alert.tcpa <= extremeTcpaMin;
    }

    /**
     * @param {{ targets: object[], alerts: object[] }} result  AISAnalyzer.checkCollisionRisks()
     * @param {number} now  epoch ms
     * @returns {{
     *   busy: boolean,
     *   alerts: object[],          // single-vessel alerts to say and log
     *   group: null | { count: number, nearest: object, repeat: boolean, started: boolean }
     * }}
     */
    update(result, now) {
        const risky = (result.targets || []).filter(atRisk);
        const o = this.options;

        // Encounters: forget vessels no longer at risk for a while (before
        // refreshing, so a vessel back after a long gap starts a new one)
        for (const [k, e] of this._encounters) {
            if (now - e.lastAtRisk > o.encounterEndMs) this._encounters.delete(k);
        }
        for (const t of risky) {
            const k = keyOf(t);
            const e = this._encounters.get(k) || { announced: 0, lastAtRisk: now };
            e.lastAtRisk = now;
            this._encounters.set(k, e);
        }

        // Busy waters: enter at busyCount, leave after calmMs at or under calmCount
        let started = false;
        if (risky.length >= o.busyCount) {
            if (!this.busy) {
                this.busy = true;
                started = true;
                this._groupAnnounced = 0;
            }
            this._calmSince = null;
        } else if (this.busy) {
            if (risky.length <= o.calmCount) {
                this._calmSince = this._calmSince ?? now;
                if (now - this._calmSince >= o.calmMs) {
                    this.busy = false;
                    this._calmSince = null;
                }
            } else {
                this._calmSince = null;
            }
        }

        let group = null;
        if (this.busy && risky.length >= 2) {
            const due = this._groupAnnounced === 0
                || (this._groupAnnounced < o.maxRepeats && now - this._groupAt >= o.groupRepeatMs);
            if (due) {
                const nearest = [...risky].sort((a, b) => (a.cpa ?? Infinity) - (b.cpa ?? Infinity))[0];
                group = { count: risky.length, nearest, repeat: this._groupAnnounced > 0, started };
                this._groupAnnounced += 1;
                this._groupAt = now;
            }
        }

        const alerts = [];
        for (const alert of result.alerts || []) {
            const e = this._encounters.get(keyOf(alert)) || { announced: 0, lastAtRisk: now };
            const extreme = this.isExtreme(alert);
            if (this.busy && !extreme) continue;
            if (e.announced >= o.maxRepeats && !extreme) continue;
            e.announced += 1;
            this._encounters.set(keyOf(alert), e);
            alerts.push(alert);
        }

        return { busy: this.busy, alerts, group };
    }
}

AisTrafficGate.DEFAULTS = DEFAULTS;
module.exports = AisTrafficGate;
