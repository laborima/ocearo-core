/*
 * Sail settings analysis module
 * Provides sail trim and configuration recommendations
 */

const { i18n } = require('../common');

class SailSettingsAnalyzer {
    constructor(app, config, llm) {
        this.app = app;
        this.config = config;
        this.llm = llm;
        
        // Sail trim parameters by point of sail
        this.trimGuides = {
            close_hauled: {
                mainsheet: 'tight',
                traveler: 'centered_or_windward',
                boom_vang: 'moderate',
                cunningham: 'as_needed',
                outhaul: 'tight',
                jib_lead: 'forward',
                jib_sheet: 'tight'
            },
            close_reach: {
                mainsheet: 'eased_slightly',
                traveler: 'centered',
                boom_vang: 'moderate',
                cunningham: 'light',
                outhaul: 'moderate',
                jib_lead: 'middle',
                jib_sheet: 'eased'
            },
            beam_reach: {
                mainsheet: 'eased',
                traveler: 'down',
                boom_vang: 'firm',
                cunningham: 'off',
                outhaul: 'eased',
                jib_lead: 'aft',
                jib_sheet: 'eased'
            },
            broad_reach: {
                mainsheet: 'well_eased',
                traveler: 'all_down',
                boom_vang: 'tight',
                cunningham: 'off',
                outhaul: 'loose',
                jib_lead: 'aft',
                jib_sheet: 'eased',
                spinnaker: 'consider'
            },
            running: {
                mainsheet: 'out',
                traveler: 'centered',
                boom_vang: 'tight',
                cunningham: 'off',
                outhaul: 'loose',
                preventer: 'set',
                spinnaker: 'recommended'
            }
        };
        
        // Sail selection by wind strength
        this.sailSelection = {
            light: { // < 10 knots
                main: 'full',
                headsail: 'genoa',
                spinnaker: 'light_air'
            },
            moderate: { // 10-20 knots
                main: 'full',
                headsail: 'jib',
                spinnaker: 'standard'
            },
            fresh: { // 20-25 knots
                main: 'reef_1',
                headsail: 'working_jib',
                spinnaker: 'heavy'
            },
            strong: { // 25-30 knots
                main: 'reef_2',
                headsail: 'storm_jib',
                spinnaker: 'none'
            },
            gale: { // > 30 knots
                main: 'reef_3_or_trysail',
                headsail: 'storm_jib',
                spinnaker: 'none'
            }
        };
    }

    /**
     * Analyze sail settings and provide recommendations
     */
    async analyzeSailSettings(vesselData, windData, context) {
        try {
            // Determine current conditions
            const conditions = this.assessConditions(vesselData, windData);
            
            // Get trim recommendations
            const trimRecommendations = this.getTrimRecommendations(conditions);
            
            // Get sail selection recommendations
            const sailRecommendations = this.getSailRecommendations(conditions);
            
            // Check for required adjustments
            const adjustments = this.identifyAdjustments(
                conditions,
                trimRecommendations,
                sailRecommendations
            );
            
            // Generate LLM analysis if needed
            let analysis = null;
            if (adjustments.length > 0 && this.config.sailing?.useLLMAnalysis !== false) {
                analysis = await this.generateSettingsAnalysis(
                    conditions,
                    adjustments,
                    vesselData,
                    windData,
                    context
                );
            }
            
            return {
                conditions,
                trimRecommendations,
                sailRecommendations,
                adjustments,
                analysis,
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            this.app.error('Sail settings analysis failed:', error);
            return this.getFallbackAnalysis();
        }
    }

    /**
     * Assess current sailing conditions
     */
    assessConditions(vesselData, windData) {
        if (!vesselData || !windData || vesselData.heading === undefined || windData.direction === undefined) {
            return {
                twa: null,
                pointOfSail: 'unknown',
                windStrength: 'unknown',
                heeling: 0,
                speed: 0
            };
        }

        const twa = this.calculateTWA(vesselData.heading, windData.direction);
        const apparentWind = this.calculateApparentWind(
            vesselData.speed || 0,
            vesselData.heading,
            windData.speed || 0,
            windData.direction
        );
        
        return {
            twa,
            trueWindSpeed: windData.speed,
            apparentWindSpeed: apparentWind.speed,
            apparentWindAngle: apparentWind.angle,
            pointOfSail: this.getPointOfSail(twa),
            windStrength: this.getWindStrength(windData.speed),
            heeling: vesselData.attitude?.roll || 0,
            speed: vesselData.speed
        };
    }

    /**
     * Get trim recommendations based on conditions
     */
    getTrimRecommendations(conditions) {
        const baseSettings = this.trimGuides[conditions.pointOfSail] || {};
        const recommendations = { ...baseSettings };
        
        // Adjust for wind strength
        if (conditions.windStrength === 'strong' || conditions.windStrength === 'gale') {
            recommendations.mainsheet = 'eased_for_depower';
            recommendations.traveler = 'down_to_leeward';
            recommendations.cunningham = 'tight';
            recommendations.boom_vang = 'very_tight';
        }
        
        // Adjust for excessive heeling
        if (Math.abs(conditions.heeling) > 25) {
            recommendations.mainsheet = 'ease_to_reduce_heel';
            recommendations.traveler = 'drop_to_leeward';
        }
        
        return recommendations;
    }

    /**
     * Get sail selection recommendations
     */
    getSailRecommendations(conditions) {
        const selection = this.sailSelection[conditions.windStrength] || this.sailSelection.moderate;
        const recommendations = { ...selection };
        
        // Adjust for point of sail
        if (conditions.pointOfSail === 'running' || conditions.pointOfSail === 'broad_reach') {
            if (conditions.windStrength === 'light' || conditions.windStrength === 'moderate') {
                recommendations.spinnaker = 'recommended';
            }
        }
        
        // Safety considerations
        if (conditions.windStrength === 'fresh' && conditions.twa < 60) {
            recommendations.consider = 'early_reef_for_comfort';
        }
        
        return recommendations;
    }

    /**
     * Identify required adjustments
     */
    identifyAdjustments(conditions, trimRec, sailRec) {
        const adjustments = [];
        
        // Check if reefing is needed
        if (sailRec.main.includes('reef') && conditions.windStrength !== 'light') {
            adjustments.push({
                type: 'reef',
                priority: 'high',
                action: sailRec.main,
                reason: 'wind_strength'
            });
        }
        
        // Check heeling angle
        if (Math.abs(conditions.heeling) > 25) {
            adjustments.push({
                type: 'depower',
                priority: 'high',
                action: 'reduce_heel',
                reason: 'excessive_heeling'
            });
        }
        
        // Check if sail change needed
        if (conditions.windStrength === 'fresh' || conditions.windStrength === 'strong') {
            if (sailRec.headsail !== 'jib') {
                adjustments.push({
                    type: 'sail_change',
                    priority: 'medium',
                    action: `change_to_${sailRec.headsail}`,
                    reason: 'wind_increase'
                });
            }
        }
        
        // Check for spinnaker opportunities
        if (sailRec.spinnaker === 'recommended' && conditions.twa > 120) {
            adjustments.push({
                type: 'sail_add',
                priority: 'low',
                action: 'deploy_spinnaker',
                reason: 'optimize_downwind'
            });
        }
        
        return adjustments;
    }

    /**
     * Generate LLM analysis for sail settings
     */
    async generateSettingsAnalysis(conditions, adjustments, vesselData, windData) {
        try {
            const targetHeading = vesselData.heading; // Maintain current for settings
            const response = await this.llm.getSailRecommendations(
                vesselData,
                targetHeading,
                windData
            );
            return response;
        } catch (error) {
            this.app.error('LLM sail settings analysis failed:', error);
            return this.getFallbackMessage(conditions, adjustments);
        }
    }

    /**
     * Calculate True Wind Angle
     */
    calculateTWA(heading, windDirection) {
        let twa = Math.abs(windDirection - heading);
        if (twa > 180) twa = 360 - twa;
        return Math.round(twa);
    }

    /**
     * Calculate apparent wind
     */
    calculateApparentWind(boatSpeed, heading, trueWindSpeed, trueWindDirection) {
        // Convert to radians
        const headingRad = heading * Math.PI / 180;
        const windDirRad = trueWindDirection * Math.PI / 180;
        
        // Calculate wind components
        const trueWindX = trueWindSpeed * Math.sin(windDirRad);
        const trueWindY = trueWindSpeed * Math.cos(windDirRad);
        
        // Calculate boat velocity components
        const boatX = boatSpeed * Math.sin(headingRad);
        const boatY = boatSpeed * Math.cos(headingRad);
        
        // Calculate apparent wind
        const appWindX = trueWindX - boatX;
        const appWindY = trueWindY - boatY;
        
        const appWindSpeed = Math.sqrt(appWindX * appWindX + appWindY * appWindY);
        const appWindAngle = Math.atan2(appWindX, appWindY) * 180 / Math.PI;
        
        return {
            speed: Math.round(appWindSpeed),
            angle: this.normalizeAngle(appWindAngle - heading)
        };
    }

    /**
     * Get point of sail
     */
    getPointOfSail(twa) {
        if (twa < 45) return 'close_hauled';
        if (twa < 60) return 'close_reach';
        if (twa < 90) return 'beam_reach';
        if (twa < 120) return 'broad_reach';
        return 'running';
    }

    /**
     * Get wind strength category
     */
    getWindStrength(windSpeed) {
        if (windSpeed < 10) return 'light';
        if (windSpeed < 20) return 'moderate';
        if (windSpeed < 25) return 'fresh';
        if (windSpeed < 30) return 'strong';
        return 'gale';
    }

    /**
     * Normalize angle
     */
    normalizeAngle(angle) {
        angle = angle % 360;
        if (angle < 0) angle += 360;
        if (angle > 180) angle -= 360;
        return Math.round(angle);
    }

    /**
     * Get fallback message
     */
    getFallbackMessage(conditions, adjustments) {
        const lang = this.config.language || 'en';
        const messages = [];
        
        adjustments.forEach(adj => {
            if (adj.type === 'reef') {
                messages.push(i18n.localize(lang, 'sail_reef_needed'));
            } else if (adj.type === 'depower') {
                messages.push(i18n.localize(lang, 'sail_reduce_heel'));
            }
        });
        
        return messages.join('. ') || i18n.localize(lang, 'sail_settings_ok');
    }

    /**
     * Get fallback analysis
     */
    getFallbackAnalysis() {
        return {
            conditions: {
                twa: null,
                pointOfSail: 'unknown',
                windStrength: 'unknown'
            },
            trimRecommendations: {},
            sailRecommendations: {},
            adjustments: [],
            analysis: null,
            timestamp: new Date().toISOString()
        };
    }
}

module.exports = SailSettingsAnalyzer;
