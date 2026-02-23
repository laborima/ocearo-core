/**
 * Sail Settings Analysis Module
 *
 * Expert-level sail trim and configuration recommendations.
 *
 * Features:
 * - Detailed trim advice per point of sail and wind strength
 * - Preventer / boom vang safety logic for downwind
 * - Reef timing recommendations based on gust factor and heel angle
 * - Headsail selection matrix (genoa / jib / working jib / storm jib)
 * - Expert commentary in FR/EN like a real rigger would give
 */

const { textUtils } = require('../common');

class SailSettingsAnalyzer {
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

        // Sail selection matrix: [windStrength] → sail plan
        this.sailSelection = {
            light: { main: 'full', headsail: 'genoa_150', spinnaker: 'light_air', reefAdvice: 'none' },
            moderate: { main: 'full', headsail: 'genoa_135', spinnaker: 'standard', reefAdvice: 'none' },
            fresh: { main: 'reef_1', headsail: 'jib_100', spinnaker: 'heavy_or_none', reefAdvice: 'reef_now' },
            strong: { main: 'reef_2', headsail: 'working_jib', spinnaker: 'none', reefAdvice: 'deep_reef' },
            near_gale: { main: 'reef_3', headsail: 'storm_jib', spinnaker: 'none', reefAdvice: 'storm_config' },
            gale: { main: 'trysail_or_bare_poles', headsail: 'storm_jib_or_none', spinnaker: 'none', reefAdvice: 'survival' }
        };
    }

    /**
     * Analyze sail settings and provide detailed expert recommendations.
     * @param {object} vesselData Vessel data
     * @param {object} windData   Wind data {speed, direction}
     * @param {object} context    Navigation context
     * @returns {object}          Full sail settings analysis
     */
    async analyzeSailSettings(vesselData, windData, context) {
        try {
            const conditions = this.assessConditions(vesselData, windData);
            const trimRecommendations = this.getTrimRecommendations(conditions);
            const sailRecommendations = this.getSailRecommendations(conditions);
            const adjustments = this.identifyAdjustments(conditions, trimRecommendations, sailRecommendations);
            const expertAdvice = this._generateExpertAdvice(conditions, sailRecommendations);

            let analysis = null;
            if (adjustments.length > 0 && this.config.sailing?.useLLMAnalysis !== false) {
                analysis = await this.generateSettingsAnalysis(conditions, adjustments, vesselData, windData, context);
            }

            return {
                conditions,
                trimRecommendations,
                sailRecommendations,
                adjustments,
                expertAdvice,
                analysis,
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            this.app.error('Sail settings analysis failed:', error);
            return this.getFallbackAnalysis();
        }
    }

    /**
     * Assess current sailing conditions with apparent wind calculation.
     */
    assessConditions(vesselData, windData) {
        if (!vesselData || !windData || vesselData.heading === undefined || windData.direction === undefined) {
            return {
                twa: null, pointOfSail: 'unknown', windStrength: 'unknown',
                heeling: 0, speed: 0, gustFactor: 1
            };
        }

        const twa = this.calculateTWA(vesselData.heading, windData.direction);
        const apparentWind = this.calculateApparentWind(
            vesselData.speed || 0, vesselData.heading,
            windData.speed || 0, windData.direction
        );
        const gustFactor = windData.gustSpeed && windData.speed > 0
            ? windData.gustSpeed / windData.speed : 1;

        return {
            twa,
            trueWindSpeed: windData.speed,
            gustSpeed: windData.gustSpeed || null,
            gustFactor: Math.round(gustFactor * 100) / 100,
            apparentWindSpeed: apparentWind.speed,
            apparentWindAngle: apparentWind.angle,
            pointOfSail: this.cm.getPointOfSail(twa),
            windStrength: this.cm.getWindStrength(windData.speed),
            heeling: vesselData.attitude?.roll || 0,
            speed: vesselData.speed
        };
    }

    /**
     * Get detailed trim recommendations based on conditions.
     */
    getTrimRecommendations(conditions) {
        const base = this.cm.getTrim(conditions.pointOfSail);
        const recommendations = { ...base };

        // Depower adjustments in heavy air
        if (conditions.windStrength === 'strong' || conditions.windStrength === 'near_gale' || conditions.windStrength === 'gale') {
            recommendations.mainsheet = 'eased_to_depower';
            recommendations.traveler = 'down_to_leeward';
            recommendations.cunningham = 'tight_to_flatten_entry';
            recommendations.boom_vang = 'very_tight';
            recommendations.outhaul = 'max_flat';
        }

        // Heavy gusts: ease and depower proactively
        if (conditions.gustFactor > 1.4) {
            recommendations.mainsheet = 'ready_to_dump';
            recommendations.traveler = 'down_to_leeward';
        }

        // Excessive heeling: immediate action
        if (Math.abs(conditions.heeling) > 30) {
            recommendations.mainsheet = 'dump_immediately';
            recommendations.traveler = 'full_leeward';
            recommendations._urgentHeel = true;
        } else if (Math.abs(conditions.heeling) > 25) {
            recommendations.mainsheet = 'ease_to_reduce_heel';
            recommendations.traveler = 'drop_to_leeward';
        }

        // Preventer logic for downwind
        if (conditions.pointOfSail === 'running' || conditions.pointOfSail === 'dead_run') {
            if (conditions.windStrength !== 'light') {
                recommendations.preventer = 'mandatory';
            }
        } else if (conditions.pointOfSail === 'broad_reach' && conditions.trueWindSpeed > 15) {
            recommendations.preventer = 'recommended';
        }

        return recommendations;
    }

    /**
     * Get sail plan recommendations based on conditions.
     */
    getSailRecommendations(conditions) {
        const selection = this.sailSelection[conditions.windStrength] || this.sailSelection.moderate;
        const recommendations = { ...selection };

        // Downwind sail optimization
        if (conditions.pointOfSail === 'running' || conditions.pointOfSail === 'dead_run' ||
            conditions.pointOfSail === 'broad_reach') {
            if (conditions.windStrength === 'light' || conditions.windStrength === 'moderate') {
                recommendations.spinnaker = 'recommended';
                recommendations.headsail = 'furled_or_poled_out';
            }
        }

        // Upwind in gusts: consider earlier reefing
        if (conditions.gustFactor > 1.3 && conditions.twa !== null && conditions.twa < 60) {
            if (conditions.windStrength === 'moderate') {
                recommendations.reefAdvice = 'prepare_reef_gusty';
                recommendations.main = 'consider_reef_1';
            }
        }

        // Fresh wind close-hauled: smaller headsail for pointing
        if (conditions.windStrength === 'fresh' && conditions.pointOfSail === 'close_hauled') {
            recommendations.headsail = 'working_jib';
        }

        return recommendations;
    }

    /**
     * Identify required adjustments with priority.
     */
    identifyAdjustments(conditions, trimRec, sailRec) {
        const adjustments = [];

        // Urgent heel reduction
        if (trimRec._urgentHeel) {
            adjustments.push({
                type: 'depower', priority: 'critical',
                action: 'dump_mainsheet_immediately',
                reason: 'dangerous_heel_angle'
            });
        } else if (Math.abs(conditions.heeling) > 25) {
            adjustments.push({
                type: 'depower', priority: 'high',
                action: 'reduce_heel_ease_main_drop_traveler',
                reason: 'excessive_heeling'
            });
        }

        // Reefing
        if (sailRec.main && sailRec.main.includes('reef')) {
            adjustments.push({
                type: 'reef', priority: 'high',
                action: sailRec.main,
                reason: 'wind_strength'
            });
        }

        // Storm configuration
        if (sailRec.reefAdvice === 'storm_config' || sailRec.reefAdvice === 'survival') {
            adjustments.push({
                type: 'storm', priority: 'critical',
                action: sailRec.reefAdvice,
                reason: 'gale_conditions'
            });
        }

        // Headsail change
        if (conditions.windStrength === 'fresh' || conditions.windStrength === 'strong') {
            adjustments.push({
                type: 'sail_change', priority: 'medium',
                action: `change_headsail_to_${sailRec.headsail}`,
                reason: 'wind_increase'
            });
        }

        // Preventer needed
        if (trimRec.preventer === 'mandatory' && conditions.trueWindSpeed > 12) {
            adjustments.push({
                type: 'safety', priority: 'high',
                action: 'rig_preventer',
                reason: 'downwind_accidental_gybe_risk'
            });
        }

        // Spinnaker opportunity
        if (sailRec.spinnaker === 'recommended' && conditions.twa !== null && conditions.twa > 110) {
            adjustments.push({
                type: 'sail_add', priority: 'low',
                action: 'deploy_spinnaker',
                reason: 'optimize_downwind'
            });
        }

        // Gusty conditions: prepare to ease
        if (conditions.gustFactor > 1.4 && sailRec.reefAdvice === 'none') {
            adjustments.push({
                type: 'preparation', priority: 'medium',
                action: 'prepare_to_reef_gusts_expected',
                reason: 'high_gust_factor'
            });
        }

        return adjustments;
    }

    /**
     * Generate expert advice text based on conditions (no LLM needed).
     * @returns {Array<{type: string, priority: string, message: string}>}
     */
    _generateExpertAdvice(conditions, sailRec) {
        const advice = [];
        const pos = conditions.pointOfSail;
        const ws = conditions.windStrength;
        const tws = conditions.trueWindSpeed || 0;

        if (pos === 'close_hauled') {
            if (ws === 'light') {
                advice.push({ type: 'trim', priority: 'low',
                    message: this.cm.t('sail.advice.close_hauled_light') });
            } else if (ws === 'fresh' || ws === 'strong') {
                advice.push({ type: 'trim', priority: 'high',
                    message: this.cm.t('sail.advice.close_hauled_fresh') });
            }
        }

        if (pos === 'beam_reach') {
            advice.push({ type: 'trim', priority: 'low',
                message: this.cm.t('sail.advice.beam_reach_general') });
        }

        if ((pos === 'running' || pos === 'dead_run') && tws > 12) {
            advice.push({ type: 'safety', priority: 'high',
                message: this.cm.t('sail.advice.running_safety') });
        }

        if (conditions.gustFactor > 1.3) {
            advice.push({ type: 'preparation', priority: 'medium',
                message: this.cm.t('sail.advice.gust_preparation', { gustFactor: Math.round(conditions.gustFactor * 100) }) });
        }

        if (Math.abs(conditions.heeling) > 25) {
            advice.push({ type: 'safety', priority: 'critical',
                message: this.cm.t('sail.advice.excessive_heel', { heel: Math.round(Math.abs(conditions.heeling)) }) });
        }

        if (ws === 'gale' || ws === 'near_gale') {
            advice.push({ type: 'storm', priority: 'critical',
                message: this.cm.t('sail.advice.storm_config') });
        }

        return advice;
    }

    /**
     * Generate LLM analysis for sail settings.
     */
    async generateSettingsAnalysis(conditions, adjustments, vesselData, windData) {
        try {
            const response = await this.llm.getSailRecommendations(
                { ...vesselData, heeling: conditions.heeling },
                vesselData.heading,
                windData
            );
            return response;
        } catch (error) {
            this.app.debug('LLM sail settings analysis failed:', error.message);
            return this.getFallbackMessage(conditions, adjustments);
        }
    }

    calculateTWA(heading, windDirection) {
        let twa = Math.abs(windDirection - heading);
        if (twa > 180) twa = 360 - twa;
        return Math.round(twa);
    }

    calculateApparentWind(boatSpeed, heading, trueWindSpeed, trueWindDirection) {
        const headingRad = heading * Math.PI / 180;
        const windDirRad = trueWindDirection * Math.PI / 180;
        const trueWindX = trueWindSpeed * Math.sin(windDirRad);
        const trueWindY = trueWindSpeed * Math.cos(windDirRad);
        const boatX = boatSpeed * Math.sin(headingRad);
        const boatY = boatSpeed * Math.cos(headingRad);
        const appWindX = trueWindX - boatX;
        const appWindY = trueWindY - boatY;
        return {
            speed: Math.round(Math.sqrt(appWindX * appWindX + appWindY * appWindY)),
            angle: this.normalizeAngle(Math.atan2(appWindX, appWindY) * 180 / Math.PI - heading)
        };
    }

    getPointOfSail(twa) {
        return this.cm.getPointOfSail(twa);
    }

    getWindStrength(windSpeed) {
        return this.cm.getWindStrength(windSpeed);
    }

    normalizeAngle(angle) {
        angle = angle % 360;
        if (angle < 0) angle += 360;
        if (angle > 180) angle -= 360;
        return Math.round(angle);
    }

    getFallbackMessage(conditions, adjustments) {
        const messages = [];
        for (const adj of adjustments) {
            if (adj.type === 'reef') messages.push(this.cm.t('sail.advice.reef_needed'));
            else if (adj.type === 'depower') messages.push(this.cm.t('sail.advice.reduce_heel'));
            else if (adj.type === 'safety') messages.push(this.cm.t('sail.advice.preventer_rig'));
        }
        return messages.join('. ') || this.cm.t('sail.advice.settings_ok');
    }

    getFallbackAnalysis() {
        return {
            conditions: { twa: null, pointOfSail: 'unknown', windStrength: 'unknown' },
            trimRecommendations: {},
            sailRecommendations: {},
            adjustments: [],
            expertAdvice: [],
            analysis: null,
            timestamp: new Date().toISOString()
        };
    }
}

module.exports = SailSettingsAnalyzer;
