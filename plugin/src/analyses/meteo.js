/*
 * Weather analysis module
 * Analyzes weather and sea conditions with LLM enrichment
 */

const { i18n } = require('../common');

class MeteoAnalyzer {
    constructor(app, config, llm, weatherProvider, tidesProvider) {
        this.app = app;
        this.config = config;
        this.llm = llm;
        this.weatherProvider = weatherProvider;
        this.tidesProvider = tidesProvider;
        
        // Analysis thresholds
        this.thresholds = {
            strongWind: config.thresholds?.windStrong || 20,
            highWind: config.thresholds?.windHigh || 25,
            highWaves: config.thresholds?.waveHigh || 3,
            roughSea: config.thresholds?.waveRough || 2
        };
    }

    /**
     * Perform comprehensive weather analysis
     */
    async analyzeConditions(vesselData, context) {
        try {
            // Get weather data
            const weatherData = await this.weatherProvider.getWeatherData(vesselData.position);
            if (!weatherData?.current) {
                throw new Error('Weather data incomplete');
            }

            // Get tide data if configured
            let tideData = null;
            if (this.config.tidesProvider?.enabled && this.tidesProvider) {
                try {
                    tideData = await this.tidesProvider.getTideData(vesselData.position);
                } catch (error) {
                    this.app.debug('Tide data unavailable:', error.message);
                }
            }
            
            // Assess conditions
            const assessment = this.assessConditions(weatherData, tideData, vesselData);
            
            // Generate analysis with LLM
            const analysis = await this.generateAnalysis(weatherData, tideData, vesselData, context, assessment);
            
            return {
                weatherData,
                tideData,
                assessment,
                analysis,
                speech: analysis.speech,
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            this.app.error('Weather analysis failed:', error);
            return this.getFallbackAnalysis(vesselData);
        }
    }

    /**
     * Assess weather conditions
     */
    assessConditions(weatherData, tideData, vesselData) {
        const current = weatherData?.current || {};
        const assessment = {
            windStrength: this.assessWindStrength(current.windSpeed || 0),
            seaState: this.assessSeaState(current.waveHeight || 0),
            sailing: this.assessSailingConditions(current, vesselData),
            trend: this.assessTrend(weatherData?.forecast),
            alerts: []
        };
        
        // Check for concerning conditions
        if ((current.windSpeed || 0) > this.thresholds.highWind) {
            assessment.alerts.push({
                type: 'high_wind',
                message: i18n.localize(this.config.language, 'weather_high_wind', {
                    speed: current.windSpeed
                })
            });
        } else if ((current.windSpeed || 0) > this.thresholds.strongWind) {
            assessment.alerts.push({
                type: 'strong_wind',
                message: i18n.localize(this.config.language, 'weather_strong_wind', {
                    speed: current.windSpeed
                })
            });
        }
        
        if ((current.waveHeight || 0) > this.thresholds.highWaves) {
            assessment.alerts.push({
                type: 'high_waves',
                message: i18n.localize(this.config.language, 'weather_high_waves', {
                    height: current.waveHeight
                })
            });
        }
        
        // Add tide considerations
        if (tideData?.current) {
            assessment.tide = {
                height: tideData.current.height ?? null,
                tendency: tideData.current.tendency ?? 'unknown',
                nextHigh: tideData.next?.high ?? null,
                impact: this.assessTideImpact(tideData, vesselData)
            };
        }
        
        return assessment;
    }

    /**
     * Assess wind strength category
     */
    assessWindStrength(windSpeed = 0) {
        if (windSpeed < 5) return 'calm';
        if (windSpeed < 12) return 'light';
        if (windSpeed < 20) return 'moderate';
        if (windSpeed < 28) return 'fresh';
        if (windSpeed < 35) return 'strong';
        return 'gale';
    }

    /**
     * Assess sea state
     */
    assessSeaState(waveHeight = 0) {
        if (waveHeight < 0.5) return 'calm';
        if (waveHeight < 1.25) return 'smooth';
        if (waveHeight < 2.5) return 'slight';
        if (waveHeight < 4) return 'moderate';
        if (waveHeight < 6) return 'rough';
        return 'very_rough';
    }

    /**
     * Assess sailing conditions
     */
    assessSailingConditions(current, vesselData) {
        if (vesselData.heading === undefined || vesselData.speed === undefined) {
             return {
                twa: null,
                vmg: null,
                pointOfSail: 'unknown',
                efficiency: 'unknown'
            };
        }

        const twa = this.calculateTWA(vesselData.heading, current.windDirection ?? 0);
        const vmg = vesselData.speed * Math.cos((twa * Math.PI) / 180);
        
        return {
            twa,
            vmg,
            pointOfSail: this.getPointOfSail(twa),
            efficiency: this.assessSailingEfficiency(vesselData.speed, current.windSpeed ?? 0, twa)
        };
    }

    /**
     * Calculate True Wind Angle
     */
    calculateTWA(heading = 0, windDirection = 0) {
        let twa = windDirection - heading;
        if (twa < 0) twa += 360;
        if (twa > 180) twa = 360 - twa;
        return Math.round(twa);
    }

    /**
     * Get point of sail from TWA
     */
    getPointOfSail(twa) {
        if (twa <= 45) return 'close_hauled';
        if (twa <= 60) return 'close_reach';
        if (twa <= 90) return 'beam_reach';
        if (twa <= 120) return 'broad_reach';
        return 'running';
    }

    /**
     * Assess sailing efficiency
     */
    assessSailingEfficiency(boatSpeed, windSpeed, twa) {
        if (windSpeed <= 0) return 'unknown';

        const optimalSpeedRatio = {
            close_hauled: 0.4,
            close_reach: 0.6,
            beam_reach: 0.7,
            broad_reach: 0.65,
            running: 0.5
        };
        
        const pointOfSail = this.getPointOfSail(twa);
        const expectedSpeed = windSpeed * (optimalSpeedRatio[pointOfSail] || 0.5);

        if (expectedSpeed <= 0) return 'unknown';
        
        const efficiency = boatSpeed / expectedSpeed;
        
        if (efficiency > 0.9) return 'excellent';
        if (efficiency > 0.7) return 'good';
        if (efficiency > 0.5) return 'fair';
        return 'poor';
    }

    /**
     * Assess weather trend
     */
    assessTrend(forecast = {}) {
        const h6 = forecast.hours6 || {};
        const h12 = forecast.hours12 || {};

        const trends = {
            wind: 'stable',
            waves: 'stable',
            overall: 'stable'
        };
        
        if (h12.windSpeedMax > (h6.windSpeedMax || 0) * 1.2) {
            trends.wind = 'increasing';
        } else if (h12.windSpeedMax < (h6.windSpeedMax || 0) * 0.8) {
            trends.wind = 'decreasing';
        }
        
        if (h12.waveHeightMax > (h6.waveHeightMax || 0) * 1.2) {
            trends.waves = 'building';
        } else if (h12.waveHeightMax < (h6.waveHeightMax || 0) * 0.8) {
            trends.waves = 'calming';
        }
        
        if (trends.wind === 'increasing' || trends.waves === 'building') {
            trends.overall = 'deteriorating';
        } else if (trends.wind === 'decreasing' && trends.waves === 'calming') {
            trends.overall = 'improving';
        }
        
        return trends;
    }

    /**
     * Assess tide impact on navigation
     */
    assessTideImpact(tideData, vesselData) {
        const impact = {
            current: 'neutral',
            navigation: []
        };
        
        if (tideData.current?.tendency === 'falling' && 
            vesselData.depth && vesselData.depth < 5) {
            impact.current = 'concerning';
            impact.navigation.push('depth_decreasing');
        }
        
        if ((tideData.current?.rate || 0) > 0.5) {
            impact.current = 'strong';
            impact.navigation.push('strong_current');
        }
        
        return impact;
    }

    /**
     * Generate analysis with LLM
     */
    async generateAnalysis(weatherData, tideData, vesselData, context, assessment) {
        try {
            const speech = await this.llm.analyzeWeather(weatherData, vesselData, context);
            const recommendations = this.generateRecommendations(assessment);
            
            return {
                speech,
                recommendations,
                summary: this.generateSummary(weatherData, assessment, recommendations)
            };
        } catch (error) {
            this.app.debug('LLM weather analysis unavailable, using basic analysis');
            this.app.error(error);
            return this.getFallbackAnalysisText(weatherData, assessment);
        }
    }

    /**
     * Generate recommendations
     */
    generateRecommendations(assessment) {
        const lang = this.config.language || 'en';
        const recommendations = [];
        
        if (assessment.windStrength === 'gale') {
            recommendations.push({
                type: 'storm_preparation',
                priority: 'critical',
                message: i18n.localize(lang, 'recommend_storm_preparation')
            });
        } else if (assessment.windStrength === 'strong') {
            recommendations.push({
                type: 'sail_reduction',
                priority: 'high',
                message: i18n.localize(lang, 'recommend_sail_reduction')
            });
        } else if (assessment.windStrength === 'fresh') {
            recommendations.push({
                type: 'prepare_reef',
                priority: 'medium',
                message: i18n.localize(lang, 'recommend_prepare_reef')
            });
        }
        
        if (assessment.seaState === 'rough' || assessment.seaState === 'very_rough') {
            recommendations.push({
                type: 'course_change',
                priority: 'medium',
                message: i18n.localize(lang, 'recommend_course_change')
            });
        }
        
        if (assessment.sailing.efficiency === 'poor') {
            recommendations.push({
                type: 'trim_adjustment',
                priority: 'low',
                message: i18n.localize(lang, 'recommend_trim_adjustment')
            });
        }
        
        return recommendations;
    }

    /**
     * Generate summary
     */
    generateSummary(weatherData, assessment, recommendations = []) {
        const current = weatherData?.current || {};
        
        const summary = {
            conditions: `Wind ${current.windSpeed ?? '?'}kts from ${current.windDirection ?? '?'}°, ` +
                       `Waves ${current.waveHeight ?? '?'}m, ${assessment.seaState} sea state`,
            sailing: `${assessment.sailing.pointOfSail}, TWA ${assessment.sailing.twa}°, ` +
                    `Efficiency: ${assessment.sailing.efficiency}`,
            trend: assessment.trend.overall
        };

        // Add tide info if available
        if (assessment.tide) {
            const lang = this.config.language || 'en';
            const tideInfo = [];
            
            if (assessment.tide.tendency) {
                const tendencyKey = `tide_${assessment.tide.tendency.toLowerCase()}`;
                const localizedTendency = i18n.t(tendencyKey, lang);
                // If translation returns key (meaning missing), use original value
                tideInfo.push(localizedTendency === tendencyKey ? assessment.tide.tendency : localizedTendency);
            }
            
            if (assessment.tide.height !== null) {
                tideInfo.push(`${assessment.tide.height}m`);
            }
            
            if (assessment.tide.nextHigh) {
                const highLabel = i18n.t('tide_high', lang);
                tideInfo.push(`${highLabel}: ${assessment.tide.nextHigh}`);
            }
            
            if (tideInfo.length > 0) {
                summary.tide = tideInfo.join(', ');
            }
        }

        // Add recommendations advice if available
        if (recommendations.length > 0) {
            summary.advice = recommendations.map(r => r.message).join('. ');
        }

        return summary;
    }

    /**
     * Get fallback analysis text
     */
    getFallbackAnalysisText(weatherData, assessment) {
        const lang = this.config.language || 'en';
        const speech = i18n.localize(lang, 'weather_current', {
            windSpeed: weatherData?.current?.windSpeed ?? '?',
            windDir: weatherData?.current?.windDirection ?? '?',
            waveHeight: weatherData?.current?.waveHeight ?? '?'
        });
        
        const recommendations = this.generateRecommendations(assessment);

        return {
            speech,
            recommendations,
            summary: this.generateSummary(weatherData, assessment, recommendations)
        };
    }

    /**
     * Get fallback analysis (when weather data unavailable)
     */
    getFallbackAnalysis(vesselData) {
        const lang = this.config.language || 'en';
        return {
            weatherData: null,
            tideData: null,
            assessment: {
                windStrength: 'unknown',
                seaState: 'unknown',
                sailing: {
                    twa: null,
                    vmg: null,
                    pointOfSail: 'unknown',
                    efficiency: 'unknown'
                },
                trend: { overall: 'unknown' },
                alerts: []
            },
            analysis: {
                speech: i18n.localize(lang, 'weather_unavailable'),
                recommendations: [],
                summary: { conditions: 'Weather data unavailable' }
            },
            vesselData,
            timestamp: new Date().toISOString()
        };
    }
}

module.exports = MeteoAnalyzer;
