/*
 * Sail course analysis module
 * Optimizes sailing course and provides navigation recommendations
 */



class SailCourseAnalyzer {
    constructor(app, config, llm) {
        this.app = app;
        this.config = config;
        this.llm = llm;
        
        // Sailing performance parameters
        this.polarData = {
            // Simplified polar data - boat speed ratio vs TWA
            0: 0,      // Head to wind
            30: 0.3,   // No go zone
            45: 0.5,   // Close hauled
            60: 0.65,  // Close reach
            90: 0.75,  // Beam reach
            120: 0.7,  // Broad reach
            150: 0.6,  // Running
            180: 0.5   // Dead run
        };
        
        // Tacking angles
        this.tackingAngle = config.sailing?.tackingAngle || 90; // Total angle between tacks
    }

    /**
     * Analyze course options
     */
    async analyzeCourse(vesselData, targetBearing, windData, context) {
        try {
            // Calculate current sailing parameters
            const current = this.calculateSailingParameters(vesselData, windData);
            
            // Calculate optimal course options
            const options = this.calculateCourseOptions(
                vesselData.heading,
                targetBearing,
                windData.direction,
                windData.speed
            );
            
            // Evaluate each option
            const evaluations = options.map(option => 
                this.evaluateCourseOption(option, windData.speed, vesselData.speed)
            );
            
            // Select best course
            const recommended = this.selectBestCourse(evaluations, current);
            
            // Generate LLM analysis if enabled
            let analysis = null;
            if (this.config.sailing?.useLLMAnalysis !== false) {
                analysis = await this.generateCourseAnalysis(
                    recommended,
                    vesselData,
                    windData,
                    context
                );
            }
            
            return {
                current,
                targetBearing,
                options: evaluations,
                recommended,
                analysis,
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            this.app.error('Course analysis failed:', error);
            return this.getFallbackAnalysis(vesselData, targetBearing);
        }
    }

    /**
     * Calculate current sailing parameters
     */
    calculateSailingParameters(vesselData, windData) {
        const twa = this.calculateTWA(vesselData.heading, windData.direction);
        const vmg = this.calculateVMG(vesselData.speed, vesselData.heading, vesselData.course);
        const polarSpeed = this.getPolarSpeed(windData.speed, twa);
        const efficiency = vesselData.speed / polarSpeed;
        
        return {
            heading: vesselData.heading,
            speed: vesselData.speed,
            twa,
            vmg,
            polarSpeed,
            efficiency,
            pointOfSail: this.getPointOfSail(twa)
        };
    }

    /**
     * Calculate course options
     */
    calculateCourseOptions(currentHeading, targetBearing, windDirection) {
        const options = [];
        
        // Direct course
        const directTWA = this.calculateTWA(targetBearing, windDirection);
        options.push({
            type: 'direct',
            heading: targetBearing,
            twa: directTWA,
            tacks: 0
        });
        
        // Check if direct course is in no-go zone
        if (directTWA < 45) {
            // Add tacking options
            const portTack = windDirection + 45;
            const starboardTack = windDirection - 45;
            
            options.push({
                type: 'port_tack',
                heading: this.normalizeAngle(portTack),
                twa: 45,
                tacks: 1
            });
            
            options.push({
                type: 'starboard_tack',
                heading: this.normalizeAngle(starboardTack),
                twa: 45,
                tacks: 1
            });
        }
        
        // Check if running downwind might benefit from gybing
        if (directTWA > 150) {
            const portGybe = windDirection - 150;
            const starboardGybe = windDirection + 150;
            
            options.push({
                type: 'port_gybe',
                heading: this.normalizeAngle(portGybe),
                twa: 150,
                gybes: 1
            });
            
            options.push({
                type: 'starboard_gybe',
                heading: this.normalizeAngle(starboardGybe),
                twa: 150,
                gybes: 1
            });
        }
        
        return options;
    }

    /**
     * Evaluate course option
     */
    evaluateCourseOption(option, windSpeed, currentSpeed) {
        const polarSpeed = this.getPolarSpeed(windSpeed, option.twa);
        const vmgTarget = polarSpeed * Math.cos((option.heading - option.targetBearing) * Math.PI / 180);
        
        // Calculate time penalty for tacks/gybes
        const maneuverPenalty = (option.tacks || 0) * 60 + (option.gybes || 0) * 45; // seconds
        
        // Score based on VMG and maneuvers
        const score = vmgTarget - (maneuverPenalty / 3600) * currentSpeed;
        
        return {
            ...option,
            polarSpeed,
            vmgTarget,
            maneuverPenalty,
            score,
            pointOfSail: this.getPointOfSail(option.twa),
            estimatedSpeed: polarSpeed
        };
    }

    /**
     * Select best course from options
     */
    selectBestCourse(evaluations, current) {
        // Sort by score
        const sorted = evaluations.sort((a, b) => b.score - a.score);
        const best = sorted[0];
        
        // Check if course change is worthwhile
        const improvement = best.score - current.vmg;
        const changeWorthwhile = improvement > 0.5; // 0.5 knot improvement threshold
        
        return {
            ...best,
            improvement,
            changeWorthwhile,
            recommendation: this.generateRecommendation(best, current, changeWorthwhile)
        };
    }

    /**
     * Generate course recommendation
     */
    generateRecommendation(best, current, changeWorthwhile) {
        if (!changeWorthwhile) {
            return {
                action: 'maintain',
                message: 'Current course is optimal'
            };
        }
        
        if (best.type === 'direct') {
            return {
                action: 'alter_course',
                heading: best.heading,
                message: `Alter course to ${best.heading}°`
            };
        }
        
        if (best.type.includes('tack')) {
            return {
                action: 'tack',
                heading: best.heading,
                message: `Tack to ${best.type.replace('_', ' ')} on ${best.heading}°`
            };
        }
        
        if (best.type.includes('gybe')) {
            return {
                action: 'gybe',
                heading: best.heading,
                message: `Gybe to ${best.type.replace('_', ' ')} on ${best.heading}°`
            };
        }
        
        return {
            action: 'maintain',
            message: 'No significant improvement available'
        };
    }

    /**
     * Generate LLM course analysis
     */
    async generateCourseAnalysis(recommended, vesselData, windData) {
        try {
            const response = await this.llm.getSailRecommendations(
                vesselData,
                recommended.heading,
                windData
            );
            return response;
        } catch (error) {
            this.app.error('LLM course analysis failed:', error);
            return null;
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
     * Calculate VMG (Velocity Made Good)
     */
    calculateVMG(speed, heading, course) {
        if (speed === undefined || heading === undefined || course === undefined) return 0;
        let angle = Math.abs(heading - course);
        // Normalize angle to 0-180
        if (angle > 180) angle = 360 - angle;
        return speed * Math.cos(angle * Math.PI / 180);
    }

    /**
     * Get polar speed for given wind speed and TWA
     */
    getPolarSpeed(windSpeed, twa) {
        // Find surrounding polar points
        const angles = Object.keys(this.polarData).map(Number).sort((a, b) => a - b);
        
        let lowerAngle = 0;
        let upperAngle = 180;
        
        for (let i = 0; i < angles.length - 1; i++) {
            if (twa >= angles[i] && twa <= angles[i + 1]) {
                lowerAngle = angles[i];
                upperAngle = angles[i + 1];
                break;
            }
        }
        
        // Interpolate
        const lowerRatio = this.polarData[lowerAngle];
        const upperRatio = this.polarData[upperAngle];
        const factor = (twa - lowerAngle) / (upperAngle - lowerAngle);
        const ratio = lowerRatio + (upperRatio - lowerRatio) * factor;
        
        return windSpeed * ratio;
    }

    /**
     * Get point of sail from TWA
     */
    getPointOfSail(twa) {
        if (twa < 45) return 'close_hauled';
        if (twa < 60) return 'close_reach';
        if (twa < 90) return 'beam_reach';
        if (twa < 120) return 'broad_reach';
        return 'running';
    }

    /**
     * Normalize angle to 0-360 range
     */
    normalizeAngle(angle) {
        angle = angle % 360;
        if (angle < 0) angle += 360;
        return Math.round(angle);
    }

    /**
     * Get fallback analysis
     */
    getFallbackAnalysis(vesselData, targetBearing) {
        return {
            current: {
                heading: vesselData.heading,
                speed: vesselData.speed,
                twa: null,
                vmg: null,
                efficiency: null,
                pointOfSail: 'unknown'
            },
            targetBearing,
            options: [],
            recommended: {
                type: 'maintain',
                heading: vesselData.heading,
                recommendation: {
                    action: 'maintain',
                    message: 'Unable to analyze course options'
                }
            },
            analysis: null,
            timestamp: new Date().toISOString()
        };
    }
}

module.exports = SailCourseAnalyzer;
