/**
 * AIS Collision Detection Module
 *
 * Monitors nearby vessels via SignalK AIS data and calculates:
 * - CPA  (Closest Point of Approach) in nautical miles
 * - TCPA (Time to CPA) in minutes
 * - Risk classification (danger / caution / watch / safe)
 * - Right of way under COLREG / RIPAM (rules 12-19, see colregs.js): our
 *   role, the rule and the action to take
 *
 * Thresholds follow IRPCS (International Regulations for Preventing
 * Collisions at Sea) best-practice guidance for coastal sailing.
 */

const colregs = require('./colregs');
const { textUtils } = require('../common');

/** Metres per nautical mile */
const NM = 1852;

/** How urgent each action is: a more urgent one is announced at once */
const ACTION_URGENCY = {
    stand_on: 0, give_way_slow: 1, give_way_astern: 1, give_way_starboard: 1, head_on_starboard: 2,
    restricted_visibility: 2, stand_on_ready: 2, stand_on_act: 3,
};

/** Risk ordering for sorting targets (most dangerous first) */
const RISK_ORDER = { danger: 0, caution: 1, watch: 2, safe: 3 };

class AISAnalyzer {
    /**
     * @param {object} app       SignalK app object
     * @param {object} config    Plugin configuration
     * @param {object} voice     Voice module for announcements
     */
    constructor(app, config, voice, cm) {
        this.app = app;
        this.config = config;
        this.voice = voice;
        this.cm = cm;

        // Thresholds (configurable)
        this.dangerCPA  = config.ais?.dangerCPA  ?? 0.25;  // NM
        this.cautionCPA = config.ais?.cautionCPA ?? 0.5;   // NM
        this.watchCPA   = config.ais?.watchCPA   ?? 1.0;   // NM
        this.maxTCPA    = config.ais?.maxTCPA    ?? 30;     // minutes
        this.maxRange   = config.ais?.maxRange   ?? 5;      // NM – ignore targets further away

        // Suppression: don't re-announce same vessel within N minutes, unless
        // the action required becomes more urgent (rule 17: act now)
        this._announced = new Map();
        this._lastAction = new Map();
        this.announceCooldown = (config.ais?.announceCooldownMinutes ?? 5) * 60_000;
    }

    /**
     * Scan all AIS targets and return risk-sorted list.
     * @param {object} ownVessel  Own vessel data (position, sog, cog)
     * @returns {Array<object>}   Targets sorted by risk (highest first)
     */
    analyzeTargets(ownVessel) {
        const ownPos = this._extractPosition(ownVessel);
        const ownSog = this._extractSOG(ownVessel);
        const ownCog = this._extractCOG(ownVessel);

        if (!ownPos) {
            this.app.debug('AIS: Own position unavailable, skipping scan');
            return [];
        }

        const targets = this._readAISTargets();
        const results = [];
        const own = {
            course: ownCog ?? 0,
            speed: ownSog ?? 0,
            category: colregs.ownCategory(this._ownStatus()),
        };
        const twd = this._selfNumber('environment.wind.directionTrue', 180 / Math.PI);
        const visibilityM = this._selfNumber('environment.outside.visibility', 1);
        const visibilityNm = Number.isFinite(visibilityM) ? visibilityM / NM : null;

        for (const target of targets) {
            const tgtPos = target.position;
            if (!tgtPos) continue;

            const range = this._distanceNM(ownPos, tgtPos);
            if (range > this.maxRange) continue;

            const bearing = this._bearing(ownPos, tgtPos);
            const relativeBearing = this._normalizeAngle(bearing - (ownCog ?? 0));

            const cpaResult = this._calculateCPA(
                ownPos, ownSog ?? 0, ownCog ?? 0,
                tgtPos, target.sog ?? 0, target.cog ?? 0
            );

            const risk = this._classifyRisk(cpaResult.cpa, cpaResult.tcpa);
            const north = (tgtPos.latitude - ownPos.latitude) * 60 * NM;
            const east = (tgtPos.longitude - ownPos.longitude) * 60 * NM * Math.cos(ownPos.latitude * Math.PI / 180);
            const advice = colregs.advise({
                own,
                target: {
                    x: east, y: north, course: target.cog ?? 0, speed: target.sog ?? 0,
                    category: colregs.targetCategory(target),
                },
                twd,
                cpaNm: cpaResult.cpa,
                tcpaMin: cpaResult.tcpa,
                visibilityNm,
                dangerCpaNm: this.dangerCPA,
            });

            results.push({
                mmsi: target.mmsi,
                name: target.name || `MMSI ${target.mmsi}`,
                callsign: target.callsign,
                shipType: target.shipType,
                range: Math.round(range * 100) / 100,
                bearing: Math.round(bearing),
                relativeBearing: Math.round(relativeBearing),
                cpa: Math.round(cpaResult.cpa * 100) / 100,
                tcpa: Math.round(cpaResult.tcpa * 10) / 10,
                risk,
                // Situation key, kept for older consumers (LLM prompt, logbook)
                colregs: advice.situation,
                role: advice.ownRole,
                rule: advice.rule,
                reason: advice.reason,
                action: advice.action,
                category: colregs.targetCategory(target),
                position: tgtPos,
                sog: target.sog,
                cog: target.cog
            });
        }

        results.sort((a, b) => {
            const diff = (RISK_ORDER[a.risk] ?? 4) - (RISK_ORDER[b.risk] ?? 4);
            if (diff !== 0) return diff;
            return a.cpa - b.cpa;
        });

        return results;
    }

    /**
     * Get the most dangerous targets that need announcement.
     * @param {object} ownVessel Own vessel data
     * @returns {{targets: Array, speech: string|null, alerts: Array}}
     */
    checkCollisionRisks(ownVessel) {
        const allTargets = this.analyzeTargets(ownVessel);
        const dangerous = allTargets.filter(t => t.risk === 'danger' || t.risk === 'caution');
        const alerts = [];

        for (const target of dangerous) {
            const key = target.mmsi || target.name;
            const lastAnnounce = this._announced.get(key);
            const escalated = ACTION_URGENCY[target.action] > (ACTION_URGENCY[this._lastAction.get(key)] ?? -1);
            this._lastAction.set(key, target.action);
            if (lastAnnounce && (Date.now() - lastAnnounce) < this.announceCooldown && !escalated) {
                continue;
            }

            this._announced.set(key, Date.now());

            const alert = {
                type: 'collision_risk',
                severity: target.risk === 'danger' || target.action === 'stand_on_act' ? 'alarm' : 'warn',
                mmsi: target.mmsi,
                target: target.name,
                role: target.role,
                rule: target.rule,
                action: target.action,
                cpa: target.cpa,
                tcpa: target.tcpa,
                range: target.range,
                bearing: target.bearing,
                colregs: target.colregs,
                message: this._buildAlertMessage(target),
            };
            // Read aloud: decimals and units spelled out; the logbook keeps the written text
            alert.speech = textUtils?.cleanForTTS ? textUtils.cleanForTTS(alert.message, this.cm.language || 'en') : alert.message;
            alerts.push(alert);
        }

        let speech = null;
        if (alerts.length > 0) {
            speech = alerts.map(a => a.speech).join('. ');
        }

        return {
            targets: allTargets,
            dangerCount: allTargets.filter(t => t.risk === 'danger').length,
            cautionCount: allTargets.filter(t => t.risk === 'caution').length,
            totalInRange: allTargets.length,
            alerts,
            speech
        };
    }

    /**
     * Alert message for a collision risk target, as written (logbook, display).
     * @param {object} target  Target data
     * @returns {string}       Alert message
     */
    _buildAlertMessage(target) {
        const params = {
            name: target.name, distance: target.range,
            cpa: target.cpa, tcpa: Math.round(target.tcpa),
            role: this.cm.t(`ais.reason.${target.reason}`),
            rule: target.rule,
            action: this.cm.t(`ais.action.${target.action}`),
        };
        return this.cm.t(target.risk === 'danger' ? 'ais.alert.danger_vessel' : 'ais.alert.caution_vessel', params);
    }

    // ────────── CPA / TCPA CALCULATION ──────────

    /**
     * Calculate CPA and TCPA between own vessel and target.
     * Uses linear motion model (adequate for short-range collision avoidance).
     * @returns {{cpa: number, tcpa: number}} CPA in NM, TCPA in minutes
     */
    _calculateCPA(ownPos, ownSog, ownCog, tgtPos, tgtSog, tgtCog) {
        const ownVx = ownSog * Math.sin(ownCog * Math.PI / 180);
        const ownVy = ownSog * Math.cos(ownCog * Math.PI / 180);
        const tgtVx = tgtSog * Math.sin(tgtCog * Math.PI / 180);
        const tgtVy = tgtSog * Math.cos(tgtCog * Math.PI / 180);

        const dvx = tgtVx - ownVx;
        const dvy = tgtVy - ownVy;

        const dLat = (tgtPos.latitude - ownPos.latitude) * 60;
        const dLon = (tgtPos.longitude - ownPos.longitude) * 60 *
            Math.cos(ownPos.latitude * Math.PI / 180);

        const vSquared = dvx * dvx + dvy * dvy;
        if (vSquared < 0.0001) {
            const dist = Math.sqrt(dLon * dLon + dLat * dLat);
            return { cpa: dist, tcpa: 0 };
        }

        const tcpaHours = -(dLon * dvx + dLat * dvy) / vSquared;
        if (tcpaHours < 0) {
            const dist = Math.sqrt(dLon * dLon + dLat * dLat);
            return { cpa: dist, tcpa: 0 };
        }

        const cpaLon = dLon + dvx * tcpaHours;
        const cpaLat = dLat + dvy * tcpaHours;
        const cpa = Math.sqrt(cpaLon * cpaLon + cpaLat * cpaLat);

        return { cpa, tcpa: tcpaHours * 60 };
    }

    // ────────── RISK CLASSIFICATION ──────────

    /**
     * Classify risk level based on CPA and TCPA.
     * @returns {'danger'|'caution'|'watch'|'safe'}
     */
    _classifyRisk(cpa, tcpa) {
        if (tcpa <= 0 || tcpa > this.maxTCPA) return 'safe';
        if (cpa < this.dangerCPA && tcpa < 15) return 'danger';
        if (cpa < this.cautionCPA && tcpa < 20) return 'caution';
        if (cpa < this.watchCPA) return 'watch';
        return 'safe';
    }

    // ────────── OWN STATUS ──────────

    /** Our navigation status and whether an engine turns (rule 3: motor-sailing is power) */
    _ownStatus() {
        const navState = this._selfValue('navigation.state');
        let engineRunning = false;
        const propulsion = this._selfValue('propulsion');
        if (propulsion && typeof propulsion === 'object') {
            for (const engine of Object.values(propulsion)) {
                const rev = engine?.revolutions?.value ?? engine?.revolutions;
                const state = engine?.state?.value ?? engine?.state;
                if ((typeof rev === 'number' && rev > 1) || state === 'started') engineRunning = true;
            }
        }
        return { navState, engineRunning, sailboat: this.config.boatType !== 'motor' };
    }

    _selfValue(path) {
        try {
            const v = this.app.getSelfPath?.(path);
            return v && typeof v === 'object' && 'value' in v ? v.value : v;
        } catch {
            return undefined;
        }
    }

    /** A numeric own path, scaled (e.g. radians to degrees), or null */
    _selfNumber(path, scale) {
        const v = this._selfValue(path);
        return typeof v === 'number' && Number.isFinite(v) ? v * scale : null;
    }

    // ────────── DATA READING ──────────

    /**
     * Read all AIS targets from SignalK context.
     * SignalK stores AIS targets under atons.* and vessels.* contexts.
     * @returns {Array<object>}
     */
    _readAISTargets() {
        const targets = [];
        try {
            const vessels = this._getOtherVessels();
            if (!vessels) return targets;

            const selfId = this._getSelfId();

            for (const [id, vessel] of Object.entries(vessels)) {
                // `vessels` includes our own vessel. Without this filter the boat
                // reports itself as a target at CPA 0 / TCPA 0, which then sorts
                // first and is announced as an imminent collision even with no AIS
                // receiver connected at all.
                if (selfId && id === selfId) continue;

                const pos = this._extractNestedValue(vessel, 'navigation.position');
                if (!pos || pos.latitude === undefined) continue;

                const sogRaw = this._extractNestedValue(vessel, 'navigation.speedOverGround');
                const cogRaw = this._extractNestedValue(vessel, 'navigation.courseOverGroundTrue');
                const sog = typeof sogRaw === 'number' ? sogRaw * 1.94384 : null;
                const cog = typeof cogRaw === 'number' ? cogRaw * (180 / Math.PI) : null;

                const callsign = this._extractNestedValue(vessel, 'communication.callsignVhf');
                const name = this._extractNestedValue(vessel, 'name')
                    || this._extractNestedValue(vessel, 'meta.name')
                    || callsign
                    || null;

                const shipType = this._extractNestedValue(vessel, 'design.aisShipType');
                targets.push({
                    mmsi: id,
                    name: name || this.cm.t('ais.unknown_vessel'),
                    navState: this._extractNestedValue(vessel, 'navigation.state'),
                    shipType: shipType?.id ?? shipType?.name ?? null,
                    shipTypeName: shipType?.name ?? null,
                    callsign,
                    position: { latitude: pos.latitude, longitude: pos.longitude },
                    sog,
                    cog
                });
            }
        } catch (error) {
            this.app.debug('AIS: Error reading targets:', error.message);
        }
        return targets;
    }

    /**
     * Resolve our own vessel key inside the `vessels` context.
     *
     * Signal K exposes it as `self` in the form `vessels.urn:mrn:signalk:uuid:…`,
     * while the keys of the `vessels` object are the bare URNs.
     * @returns {string|null}
     */
    _getSelfId() {
        try {
            const raw = this.app.selfId
                || this.app.selfContext
                || (typeof this.app.getSelfPath === 'function' ? this.app.selfContext : null);
            if (typeof raw === 'string' && raw.length) {
                return raw.startsWith('vessels.') ? raw.slice('vessels.'.length) : raw;
            }
        } catch (error) {
            this.app.debug('AIS: Cannot resolve self id:', error.message);
        }
        return null;
    }

    /**
     * Get other vessels from the SignalK data model.
     * @returns {object|null}
     */
    _getOtherVessels() {
        try {
            if (this.app.getPath && typeof this.app.getPath === 'function') {
                return this.app.getPath('vessels') || null;
            }
            if (this.app.signalk && this.app.signalk.retrieve) {
                const full = this.app.signalk.retrieve();
                return full?.vessels || null;
            }
        } catch (error) {
            this.app.debug('AIS: Cannot access vessels context:', error.message);
        }
        return null;
    }

    /**
     * Extract a nested value from a SignalK vessel object.
     * Handles both raw values and {value: ...} wrappers.
     */
    _extractNestedValue(obj, path) {
        const parts = path.split('.');
        let current = obj;
        for (const part of parts) {
            if (current === undefined || current === null) return undefined;
            current = current[part];
        }
        if (current && typeof current === 'object' && 'value' in current) {
            return current.value;
        }
        return current;
    }

    _extractPosition(vesselData) {
        const nav = vesselData?.navigation;
        // Handle SignalK {value: {latitude, longitude}} wrapper
        const pos = nav?.position?.value ?? nav?.position;
        if (pos?.latitude !== undefined) return pos;
        const directPos = vesselData?.position?.value ?? vesselData?.position;
        if (directPos?.latitude !== undefined) return directPos;
        return null;
    }

    _extractSOG(vesselData) {
        const raw = vesselData?.navigation?.speedOverGround;
        const sog = (raw !== null && typeof raw === 'object' && 'value' in raw) ? raw.value : raw;
        return typeof sog === 'number' ? sog * 1.94384 : null;
    }

    _extractCOG(vesselData) {
        const raw = vesselData?.navigation?.courseOverGroundTrue;
        const cog = (raw !== null && typeof raw === 'object' && 'value' in raw) ? raw.value : raw;
        return typeof cog === 'number' ? cog * (180 / Math.PI) : null;
    }

    // ────────── GEOMETRY HELPERS ──────────

    /**
     * Distance between two positions in nautical miles.
     */
    _distanceNM(pos1, pos2) {
        const R = 3440.065; // Earth radius in NM
        const dLat = (pos2.latitude - pos1.latitude) * Math.PI / 180;
        const dLon = (pos2.longitude - pos1.longitude) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(pos1.latitude * Math.PI / 180) *
            Math.cos(pos2.latitude * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(a));
    }

    /**
     * Bearing from pos1 to pos2 in degrees.
     */
    _bearing(pos1, pos2) {
        const dLon = (pos2.longitude - pos1.longitude) * Math.PI / 180;
        const lat1 = pos1.latitude * Math.PI / 180;
        const lat2 = pos2.latitude * Math.PI / 180;
        const y = Math.sin(dLon) * Math.cos(lat2);
        const x = Math.cos(lat1) * Math.sin(lat2) -
            Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
        return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    }

    _normalizeAngle(angle) {
        angle = angle % 360;
        if (angle > 180) angle -= 360;
        if (angle < -180) angle += 360;
        return angle;
    }

    /**
     * Cleanup old announcement entries.
     */
    cleanup() {
        const now = Date.now();
        for (const [key, time] of this._announced) {
            if (now - time > this.announceCooldown * 3) {
                this._announced.delete(key);
            }
        }
    }
}

module.exports = AISAnalyzer;
