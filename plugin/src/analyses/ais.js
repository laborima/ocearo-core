/**
 * AIS Collision Detection Module
 *
 * Monitors nearby vessels via SignalK AIS data and calculates:
 * - CPA  (Closest Point of Approach) in nautical miles
 * - TCPA (Time to CPA) in minutes
 * - Risk classification (danger / caution / watch / safe)
 * - COLREGs situation (overtaking, crossing, head-on)
 *
 * Thresholds follow IRPCS (International Regulations for Preventing
 * Collisions at Sea) best-practice guidance for coastal sailing.
 */

const { conversions, textUtils } = require('../common');

/** Metres per nautical mile */
const NM = 1852;

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

        // Suppression: don't re-announce same vessel within N minutes
        this._announced = new Map();
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
            const colregs = this._classifyCOLREGs(relativeBearing, target.sog ?? 0, ownSog ?? 0);

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
                colregs,
                position: tgtPos,
                sog: target.sog,
                cog: target.cog
            });
        }

        results.sort((a, b) => {
            const riskOrder = { danger: 0, caution: 1, watch: 2, safe: 3 };
            const diff = (riskOrder[a.risk] ?? 4) - (riskOrder[b.risk] ?? 4);
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
            if (lastAnnounce && (Date.now() - lastAnnounce) < this.announceCooldown) {
                continue;
            }

            this._announced.set(key, Date.now());

            const alert = {
                type: 'collision_risk',
                severity: target.risk === 'danger' ? 'alarm' : 'warn',
                target: target.name,
                cpa: target.cpa,
                tcpa: target.tcpa,
                range: target.range,
                bearing: target.bearing,
                colregs: target.colregs,
                message: this._buildAlertMessage(target)
            };
            alerts.push(alert);
        }

        let speech = null;
        if (alerts.length > 0) {
            speech = alerts.map(a => a.message).join('. ');
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
     * Build a spoken alert message for a collision risk target.
     * @param {object} target  Target data
     * @param {string} lang    Language code
     * @returns {string}       Alert message
     */
    _buildAlertMessage(target) {
        const colregsKey = this._colregsToKey(target.colregs);
        const colregsText = this.cm.t(`ais.colregs.${colregsKey}`);
        const evasiveKey = this._evasiveActionKey(target.colregs);
        const evasiveText = this.cm.t(`ais.alert.evasive.${evasiveKey}`);

        if (target.risk === 'danger') {
            return this.cm.t('ais.alert.danger_vessel', {
                name: target.name, distance: target.range,
                cpa: target.cpa, tcpa: Math.round(target.tcpa),
                colregs: colregsText, evasive: evasiveText
            });
        }
        return this.cm.t('ais.alert.caution_vessel', {
            name: target.name, distance: target.range,
            cpa: target.cpa, tcpa: Math.round(target.tcpa)
        });
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

    /**
     * Classify COLREGs situation based on relative bearing and speeds.
     * @returns {'head_on'|'crossing_starboard'|'crossing_port'|'overtaking'|'being_overtaken'|'safe_passing'}
     */
    _classifyCOLREGs(relativeBearing, targetSog, ownSog) {
        const absBearing = Math.abs(relativeBearing);

        if (absBearing < 10) return 'head_on';
        if (absBearing > 112.5 && absBearing < 247.5) {
            return targetSog > ownSog ? 'being_overtaken' : 'overtaking';
        }
        if (relativeBearing > 0 && relativeBearing < 112.5) return 'crossing_starboard';
        if (relativeBearing < 0 || relativeBearing > 247.5) return 'crossing_port';
        return 'safe_passing';
    }

    // ────────── COLREGs HELPERS ──────────

    /**
     * Map internal COLREGs situation to locale key.
     * @param {string} situation
     * @returns {string}
     */
    _colregsToKey(situation) {
        const map = {
            head_on: 'head_on',
            crossing_starboard: 'crossing_give_way',
            crossing_port: 'crossing_stand_on',
            overtaking: 'overtaking',
            being_overtaken: 'being_overtaken',
            safe_passing: 'crossing_stand_on'
        };
        return map[situation] || situation;
    }

    /**
     * Map COLREGs situation to evasive action locale key.
     * @param {string} situation
     * @returns {string}
     */
    _evasiveActionKey(situation) {
        const map = {
            head_on: 'alter_starboard',
            crossing_starboard: 'give_way',
            crossing_port: 'maintain_course',
            overtaking: 'give_way',
            being_overtaken: 'maintain_course',
            safe_passing: 'maintain_course'
        };
        return map[situation] || 'maintain_course';
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

            for (const [id, vessel] of Object.entries(vessels)) {
                const pos = this._extractNestedValue(vessel, 'navigation.position');
                if (!pos || pos.latitude === undefined) continue;

                const sogRaw = this._extractNestedValue(vessel, 'navigation.speedOverGround');
                const cogRaw = this._extractNestedValue(vessel, 'navigation.courseOverGroundTrue');
                const sog = typeof sogRaw === 'number' ? sogRaw * 1.94384 : null;
                const cog = typeof cogRaw === 'number' ? cogRaw * (180 / Math.PI) : null;

                targets.push({
                    mmsi: id,
                    name: this._extractNestedValue(vessel, 'name') || id,
                    callsign: this._extractNestedValue(vessel, 'communication.callsignVhf'),
                    shipType: this._extractNestedValue(vessel, 'design.aisShipType.value.name'),
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
