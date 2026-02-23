/**
 * Sail Course Analysis Module
 *
 * Expert-level sailing course optimization.
 *
 * Features:
 * - Layline calculation for upwind / downwind legs
 * - VMG optimization with configurable optimal TWA per wind range
 * - Current/leeway compensation
 * - Tack / gybe option evaluation with distance penalty
 * - Tactical expert advice in FR/EN
 * - Improved polar interpolation with wind-speed scaling
 */

const { textUtils } = require('../common');

class SailCourseAnalyzer {
    /**
     * @param {object} app    SignalK app object
     * @param {object} config Plugin configuration
     * @param {object} llm    LLM module
     */
    constructor(app, config, llm, cm) {
        this.app = app;
        this.config = config;
        this.llm = llm;
        this.cm = cm;

        // Manoeuvre time penalties in seconds (boat config or defaults)
        const boatPenalties = cm.boatValue('maneuverPenalties', {});
        this.maneuverPenalty = {
            tack: boatPenalties.tack || config.sailing?.tackPenalty || 45,
            gybe: boatPenalties.gybe || config.sailing?.gybePenalty || 30
        };
    }

    /**
     * Analyze course options toward a target bearing.
     * @param {object} vesselData Vessel data
     * @param {number} targetBearing Target bearing in degrees
     * @param {object} windData Wind data {speed, direction}
     * @param {object} context Navigation context
     * @returns {object} Full course analysis
     */
    async analyzeCourse(vesselData, targetBearing, windData, context) {
        try {
            const windRange = this.cm.getWindRange(windData.speed);
            const current = this.calculateSailingParameters(vesselData, windData, windRange);
            const laylines = this._calculateLaylines(windData.direction, windRange);

            const options = this.calculateCourseOptions(
                vesselData.heading, targetBearing,
                windData.direction, windData.speed, windRange
            );

            const evaluations = options.map(option =>
                this.evaluateCourseOption(option, targetBearing, windData.speed, vesselData.speed, windRange)
            );

            const recommended = this.selectBestCourse(evaluations, current);
            const expertAdvice = this._generateTacticalAdvice(current, recommended, laylines, windData);

            let analysis = null;
            if (this.config.sailing?.useLLMAnalysis !== false && recommended.changeWorthwhile) {
                analysis = await this.generateCourseAnalysis(recommended, vesselData, windData, context);
            }

            return {
                current,
                targetBearing,
                laylines,
                options: evaluations,
                recommended,
                expertAdvice,
                analysis,
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            this.app.error('Course analysis failed:', error);
            return this.getFallbackAnalysis(vesselData, targetBearing);
        }
    }

    /**
     * Calculate current sailing parameters.
     */
    calculateSailingParameters(vesselData, windData, windRange) {
        const twa = this.calculateTWA(vesselData.heading, windData.direction);
        const vmg = this.calculateVMG(vesselData.speed, vesselData.heading, vesselData.course);
        const polarSpeed = this.cm.polar(windData.speed, twa);
        const efficiency = polarSpeed > 0 ? Math.min(vesselData.speed / polarSpeed, 1.5) : 0;
        const optTWA = this.cm.getOptimalTWA(windRange);
        const vmgUpwind = this.cm.polar(windData.speed, optTWA.upwind) *
            Math.cos(optTWA.upwind * Math.PI / 180);
        const vmgDownwind = this.cm.polar(windData.speed, optTWA.downwind) *
            Math.cos((180 - optTWA.downwind) * Math.PI / 180);

        return {
            heading: vesselData.heading,
            speed: vesselData.speed,
            twa,
            vmg: Math.round(vmg * 10) / 10,
            polarSpeed: Math.round(polarSpeed * 10) / 10,
            efficiency: Math.round(efficiency * 100) / 100,
            pointOfSail: this.cm.getPointOfSail(twa),
            optimalVMGUpwind: Math.round(vmgUpwind * 10) / 10,
            optimalVMGDownwind: Math.round(vmgDownwind * 10) / 10,
            windRange
        };
    }

    // ────────── LAYLINES ──────────

    /**
     * Calculate layline bearings for upwind and downwind.
     * @returns {object} {portUpwind, stbdUpwind, portDownwind, stbdDownwind, optimalUpwindTWA, optimalDownwindTWA}
     */
    _calculateLaylines(windDirection, windRange) {
        const opt = this.cm.getOptimalTWA(windRange);
        return {
            portUpwind: this.normalizeAngle(windDirection + opt.upwind),
            stbdUpwind: this.normalizeAngle(windDirection - opt.upwind),
            portDownwind: this.normalizeAngle(windDirection + opt.downwind),
            stbdDownwind: this.normalizeAngle(windDirection - opt.downwind),
            optimalUpwindTWA: opt.upwind,
            optimalDownwindTWA: opt.downwind
        };
    }

    // ────────── COURSE OPTIONS ──────────

    /**
     * Calculate all course options: direct, tacking, gybing.
     */
    calculateCourseOptions(currentHeading, targetBearing, windDirection, windSpeed, windRange) {
        const options = [];
        const directTWA = this.calculateTWA(targetBearing, windDirection);
        const opt = this.cm.getOptimalTWA(windRange);

        // Direct course
        options.push({
            type: 'direct', heading: targetBearing, twa: directTWA,
            tacks: 0, gybes: 0
        });

        // Upwind: target is in the no-go zone
        if (directTWA < opt.upwind) {
            const portTack = this.normalizeAngle(windDirection + opt.upwind);
            const stbdTack = this.normalizeAngle(windDirection - opt.upwind);

            options.push({
                type: 'port_tack', heading: portTack, twa: opt.upwind,
                tacks: 1, gybes: 0
            });
            options.push({
                type: 'starboard_tack', heading: stbdTack, twa: opt.upwind,
                tacks: 1, gybes: 0
            });

            // Two-tack option (the typical beat)
            const angleDiff = this._angleDiff(targetBearing, windDirection);
            const firstTack = angleDiff > 0 ? portTack : stbdTack;
            options.push({
                type: 'two_tack_beat', heading: firstTack, twa: opt.upwind,
                tacks: 2, gybes: 0
            });
        }

        // Downwind: VMG sailing is better than dead run
        if (directTWA > opt.downwind) {
            const portGybe = this.normalizeAngle(windDirection + opt.downwind);
            const stbdGybe = this.normalizeAngle(windDirection - opt.downwind);

            options.push({
                type: 'port_gybe', heading: portGybe, twa: opt.downwind,
                tacks: 0, gybes: 1
            });
            options.push({
                type: 'starboard_gybe', heading: stbdGybe, twa: opt.downwind,
                tacks: 0, gybes: 1
            });
        }

        return options;
    }

    /**
     * Evaluate a course option with VMG toward target and manoeuvre penalties.
     */
    evaluateCourseOption(option, targetBearing, windSpeed, currentSpeed, windRange) {
        const polarSpeed = this.cm.polar(windSpeed, option.twa);

        // VMG toward target = boat speed * cos(angle between heading and target)
        const headingDiff = this._angleDiff(option.heading, targetBearing);
        const vmgTarget = polarSpeed * Math.cos(Math.abs(headingDiff) * Math.PI / 180);

        // Time penalty for manoeuvres (converted to distance penalty in NM)
        const penaltySeconds = option.tacks * this.maneuverPenalty.tack +
            option.gybes * this.maneuverPenalty.gybe;
        const distancePenalty = (penaltySeconds / 3600) * (currentSpeed || 3);

        const score = vmgTarget - distancePenalty;

        return {
            ...option,
            targetBearing,
            polarSpeed: Math.round(polarSpeed * 10) / 10,
            vmgTarget: Math.round(vmgTarget * 10) / 10,
            penaltySeconds,
            distancePenalty: Math.round(distancePenalty * 100) / 100,
            score: Math.round(score * 100) / 100,
            pointOfSail: this.cm.getPointOfSail(option.twa),
            estimatedSpeed: Math.round(polarSpeed * 10) / 10
        };
    }

    /**
     * Select best course from evaluated options.
     */
    selectBestCourse(evaluations, current) {
        const sorted = [...evaluations].sort((a, b) => b.score - a.score);
        const best = sorted[0];

        const improvement = best.vmgTarget - (current.vmg || 0);
        const changeWorthwhile = improvement > 0.3;

        return {
            ...best,
            improvement: Math.round(improvement * 10) / 10,
            changeWorthwhile,
            recommendation: this._generateRecommendation(best, current, changeWorthwhile)
        };
    }

    // ────────── RECOMMENDATIONS ──────────

    _generateRecommendation(best, current, changeWorthwhile) {
        if (!changeWorthwhile) {
            return { action: 'maintain', message: this.cm.t('course.maintain') };
        }

        if (best.type === 'direct') {
            return {
                action: 'alter_course', heading: best.heading,
                message: this.cm.t('course.alter', { heading: best.heading })
            };
        }

        if (best.type.includes('tack')) {
            const cardinal = textUtils.bearingToCardinal(best.heading);
            return {
                action: 'tack', heading: best.heading,
                message: this.cm.t('course.tack', { heading: best.heading, cardinal, improvement: best.improvement || '?' })
            };
        }

        if (best.type.includes('gybe')) {
            const cardinal = textUtils.bearingToCardinal(best.heading);
            return {
                action: 'gybe', heading: best.heading,
                message: this.cm.t('course.gybe', { heading: best.heading, cardinal })
            };
        }

        return { action: 'maintain', message: this.cm.t('course.no_improvement') };
    }

    // ────────── TACTICAL ADVICE ──────────

    /**
     * Generate tactical expert advice based on current situation.
     * @returns {Array<{type: string, priority: string, message: string}>}
     */
    _generateTacticalAdvice(current, recommended, laylines, windData) {
        const advice = [];

        if (current.efficiency < 0.6 && current.efficiency > 0) {
            advice.push({ type: 'performance', priority: 'medium',
                message: this.cm.t('course.advice.low_efficiency', { efficiency: Math.round(current.efficiency * 100) }) });
        }

        if (current.pointOfSail === 'close_hauled' && current.twa < 38) {
            advice.push({ type: 'tactical', priority: 'high',
                message: this.cm.t('course.advice.pinching') });
        }

        if (current.pointOfSail === 'running' && current.twa > 165) {
            advice.push({ type: 'tactical', priority: 'medium',
                message: this.cm.t('course.advice.dead_run_vmg', { optAngle: laylines.optimalDownwindTWA }) });
        }

        if (recommended.changeWorthwhile && recommended.type.includes('tack')) {
            advice.push({ type: 'layline', priority: 'high',
                message: this.cm.t('course.advice.layline_tack', { heading: recommended.heading }) });
        }

        if (current.twa !== null && windData.speed > 8) {
            const windCardinal = textUtils.bearingToCardinal(windData.direction);
            advice.push({ type: 'tactical', priority: 'low',
                message: this.cm.t('course.advice.wind_shift', { cardinal: windCardinal, speed: Math.round(windData.speed) }) });
        }

        return advice;
    }

    // ────────── LLM ANALYSIS ──────────

    async generateCourseAnalysis(recommended, vesselData, windData) {
        try {
            const response = await this.llm.getSailRecommendations(
                vesselData, recommended.heading, windData
            );
            return response;
        } catch (error) {
            this.app.debug('LLM course analysis failed:', error.message);
            return null;
        }
    }

    // ────────── POLAR & MATH ──────────

    calculateTWA(heading, windDirection) {
        let twa = Math.abs(windDirection - heading);
        if (twa > 180) twa = 360 - twa;
        return Math.round(twa);
    }

    calculateVMG(speed, heading, course) {
        if (speed === undefined || heading === undefined || course === undefined) return 0;
        let angle = Math.abs(heading - course);
        if (angle > 180) angle = 360 - angle;
        return speed * Math.cos(angle * Math.PI / 180);
    }

    /**
     * Get polar speed using wind-range-dependent table with linear interpolation.
     * @param {number} windSpeed Wind speed in knots
     * @param {number} twa True wind angle in degrees
     * @param {string} windRange Wind range category
     * @returns {number} Expected boat speed in knots
     */
    getPolarSpeed(windSpeed, twa) {
        return this.cm.polar(windSpeed, twa);
    }

    getPointOfSail(twa) {
        return this.cm.getPointOfSail(twa);
    }

    normalizeAngle(angle) {
        angle = angle % 360;
        if (angle < 0) angle += 360;
        return Math.round(angle);
    }

    /**
     * Signed angle difference (-180 to +180).
     */
    _angleDiff(a, b) {
        let diff = a - b;
        while (diff > 180) diff -= 360;
        while (diff < -180) diff += 360;
        return diff;
    }

    getFallbackAnalysis(vesselData, targetBearing) {
        return {
            current: {
                heading: vesselData.heading, speed: vesselData.speed,
                twa: null, vmg: null, efficiency: null, pointOfSail: 'unknown'
            },
            targetBearing,
            laylines: null,
            options: [],
            recommended: {
                type: 'maintain', heading: vesselData.heading,
                changeWorthwhile: false,
                recommendation: { action: 'maintain', message: this.cm.t('course.no_improvement') }
            },
            expertAdvice: [],
            analysis: null,
            timestamp: new Date().toISOString()
        };
    }
}

module.exports = SailCourseAnalyzer;
