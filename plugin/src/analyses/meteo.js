/**
 * Weather/Meteo Analysis Module
 *
 * Expert-level weather assessment for marine navigation.
 *
 * Features:
 * - Beaufort scale classification with sea-state descriptions
 * - Barometric pressure trend analysis (3h rolling window)
 * - Gust factor and squall risk detection
 * - Wind-against-tide danger assessment
 * - Detailed weather window evaluation for passage planning
 * - Expert sailor recommendations per condition combination
 */

const { conversions, textUtils } = require('../common');

/** Beaufort scale lookup — wind speed in knots */
const BEAUFORT = [
    { force: 0,  max: 1,   label: 'Calm',              sea: 'glassy',         sailAdvice: 'motor_or_drift' },
    { force: 1,  max: 3,   label: 'Light air',          sea: 'rippled',        sailAdvice: 'light_genoa' },
    { force: 2,  max: 6,   label: 'Light breeze',       sea: 'small_wavelets', sailAdvice: 'full_sail' },
    { force: 3,  max: 10,  label: 'Gentle breeze',      sea: 'large_wavelets', sailAdvice: 'full_sail' },
    { force: 4,  max: 16,  label: 'Moderate breeze',    sea: 'small_waves',    sailAdvice: 'full_sail_ideal' },
    { force: 5,  max: 21,  label: 'Fresh breeze',       sea: 'moderate_waves', sailAdvice: 'reef_genoa' },
    { force: 6,  max: 27,  label: 'Strong breeze',      sea: 'large_waves',    sailAdvice: 'reef_1' },
    { force: 7,  max: 33,  label: 'Near gale',          sea: 'heaping_sea',    sailAdvice: 'reef_2' },
    { force: 8,  max: 40,  label: 'Gale',               sea: 'high_waves',     sailAdvice: 'reef_3_storm_jib' },
    { force: 9,  max: 47,  label: 'Strong gale',        sea: 'very_high',      sailAdvice: 'storm_sails' },
    { force: 10, max: 55,  label: 'Storm',              sea: 'phenomenal',     sailAdvice: 'bare_poles' },
    { force: 11, max: 63,  label: 'Violent storm',      sea: 'phenomenal',     sailAdvice: 'survival' },
    { force: 12, max: 999, label: 'Hurricane',          sea: 'phenomenal',     sailAdvice: 'survival' }
];

class MeteoAnalyzer {
    /**
     * @param {object} app             SignalK app object
     * @param {object} config          Plugin configuration
     * @param {object} llm             LLM module
     * @param {object} weatherProvider Weather data provider
     * @param {object} tidesProvider   Tides data provider
     */
    constructor(app, config, llm, weatherProvider, tidesProvider, cm) {
        this.app = app;
        this.config = config;
        this.llm = llm;
        this.weatherProvider = weatherProvider;
        this.tidesProvider = tidesProvider;
        this.cm = cm;

        this.thresholds = {
            strongWind:  config.thresholds?.windStrong  || 20,
            highWind:    config.thresholds?.windHigh    || 25,
            highWaves:   config.thresholds?.waveHigh    || 3,
            roughSea:    config.thresholds?.waveRough   || 2,
            gustFactor:  config.thresholds?.gustFactor  || 1.4,
            pressureDrop: config.thresholds?.pressureDrop || 3
        };

        this._pressureHistory = [];
        this._maxPressureHistory = 36;
    }

    /**
     * Perform comprehensive weather analysis.
     * @param {object} vesselData Current vessel data from SignalK
     * @param {object} context    Navigation context
     * @returns {object}          Full analysis result
     */
    async analyzeConditions(vesselData, context) {
        try {
            const weatherData = await this.weatherProvider.getWeatherData(vesselData.position);
            if (!weatherData?.current) {
                throw new Error('Weather data incomplete');
            }

            let tideData = null;
            if (this.config.tidesProvider?.enabled && this.tidesProvider) {
                try {
                    tideData = await this.tidesProvider.getTideData();
                } catch (error) {
                    this.app.debug('Tide data unavailable:', error.message);
                }
            }

            this._recordPressure(weatherData.current.pressure);

            const assessment = this.assessConditions(weatherData, tideData, vesselData);
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
     * Full condition assessment including Beaufort, pressure, gusts, tides.
     */
    assessConditions(weatherData, tideData, vesselData) {
        const current = weatherData?.current || {};
        const windSpeed = current.windSpeed || 0;
        const gustSpeed = current.gustSpeed || 0;

        const beaufort = this.getBeaufort(windSpeed);
        const gustFactor = windSpeed > 0 ? gustSpeed / windSpeed : 1;
        const pressureTrend = this.analyzePressureTrend();

        const assessment = {
            beaufort,
            windStrength: this._beaufortToCategory(beaufort.force),
            gustFactor: Math.round(gustFactor * 100) / 100,
            gustRisk: gustFactor > this.thresholds.gustFactor ? 'high' : gustFactor > 1.2 ? 'moderate' : 'low',
            squallRisk: this._assessSquallRisk(gustFactor, pressureTrend, current),
            seaState: this.assessSeaState(current.waveHeight || 0),
            pressure: {
                current: current.pressure ?? null,
                trend: pressureTrend.trend,
                change3h: pressureTrend.change3h,
                interpretation: pressureTrend.interpretation
            },
            sailing: this.assessSailingConditions(current, vesselData),
            trend: this.assessTrend(weatherData?.forecast),
            weatherWindow: this._assessWeatherWindow(weatherData?.forecast, beaufort),
            windAgainstTide: null,
            alerts: [],
            expertAdvice: []
        };

        if ((current.windSpeed || 0) > this.thresholds.highWind) {
            assessment.alerts.push({
                type: 'high_wind',
                priority: 'high',
                message: this.cm.t('weather.alerts.high_wind', { speed: Math.round(current.windSpeed) })
            });
        } else if ((current.windSpeed || 0) > this.thresholds.strongWind) {
            assessment.alerts.push({
                type: 'strong_wind',
                priority: 'medium',
                message: this.cm.t('weather.alerts.strong_wind', { speed: Math.round(current.windSpeed) })
            });
        }

        if ((current.waveHeight || 0) > this.thresholds.highWaves) {
            assessment.alerts.push({
                type: 'high_waves',
                priority: 'high',
                message: this.cm.t('weather.alerts.high_waves', { height: current.waveHeight?.toFixed(1) })
            });
        }

        if (pressureTrend.trend === 'falling_fast') {
            assessment.alerts.push({
                type: 'pressure_drop',
                priority: 'high',
                message: this.cm.t('weather.alerts.pressure_falling_fast', { rate: Math.abs(pressureTrend.change3h) })
            });
        }

        if (assessment.gustRisk === 'high') {
            assessment.alerts.push({
                type: 'gust_warning',
                priority: 'medium',
                message: this.cm.t('weather.alerts.squall_risk', { gustFactor: Math.round(gustSpeed / windSpeed * 100) })
            });
        }

        if (tideData?.current) {
            const tideAssessment = this.assessTideImpact(tideData, vesselData, current);
            assessment.tide = tideAssessment;
            if (tideAssessment.windAgainstTide) {
                assessment.windAgainstTide = tideAssessment.windAgainstTide;
                if (tideAssessment.windAgainstTide.danger) {
                    assessment.alerts.push({
                        type: 'wind_against_tide',
                        priority: 'high',
                        message: this.cm.t('weather.alerts.wind_against_tide')
                    });
                }
            }
        }

        assessment.expertAdvice = this._generateExpertAdvice(assessment, current);

        return assessment;
    }

    // ────────── BEAUFORT SCALE ──────────

    /**
     * Get Beaufort force and metadata for a wind speed in knots.
     * @param {number} windSpeedKts Wind speed in knots
     * @returns {object} Beaufort entry
     */
    getBeaufort(windSpeedKts) {
        for (const entry of BEAUFORT) {
            if (windSpeedKts <= entry.max) {
                return { ...entry };
            }
        }
        return { ...BEAUFORT[BEAUFORT.length - 1] };
    }

    _beaufortToCategory(force) {
        if (force <= 1) return 'calm';
        if (force <= 3) return 'light';
        if (force <= 4) return 'moderate';
        if (force <= 5) return 'fresh';
        if (force <= 6) return 'strong';
        if (force <= 7) return 'near_gale';
        return 'gale';
    }

    // ────────── BAROMETRIC PRESSURE ──────────

    /**
     * Record a pressure reading for trend analysis.
     * @param {number|null} pressureHpa Pressure in hPa
     */
    _recordPressure(pressureHpa) {
        if (typeof pressureHpa !== 'number' || isNaN(pressureHpa)) return;
        this._pressureHistory.push({ value: pressureHpa, time: Date.now() });
        while (this._pressureHistory.length > this._maxPressureHistory) {
            this._pressureHistory.shift();
        }
    }

    /**
     * Analyze barometric pressure trend over the last 3 hours.
     * A drop of >3 hPa/3h is a strong frontal signal.
     * @returns {object} trend, change3h, interpretation
     */
    analyzePressureTrend() {
        if (this._pressureHistory.length < 2) {
            return { trend: 'unknown', change3h: null, interpretation: 'insufficient_data' };
        }

        const now = Date.now();
        const threeHoursAgo = now - 3 * 60 * 60 * 1000;
        const oldest = this._pressureHistory.find(p => p.time >= threeHoursAgo) || this._pressureHistory[0];
        const latest = this._pressureHistory[this._pressureHistory.length - 1];

        const hourSpan = (latest.time - oldest.time) / (60 * 60 * 1000);
        if (hourSpan < 0.25) {
            return { trend: 'unknown', change3h: null, interpretation: 'insufficient_data' };
        }

        const rate = (latest.value - oldest.value) / hourSpan;
        const change3h = Math.round(rate * 3 * 10) / 10;

        let trend = 'steady';
        let interpretation = 'stable_conditions';

        if (change3h < -this.thresholds.pressureDrop) {
            trend = 'falling_fast';
            interpretation = 'front_approaching_rapidly';
        } else if (change3h < -1.5) {
            trend = 'falling';
            interpretation = 'deteriorating_conditions';
        } else if (change3h < -0.5) {
            trend = 'falling_slowly';
            interpretation = 'slow_deterioration';
        } else if (change3h > this.thresholds.pressureDrop) {
            trend = 'rising_fast';
            interpretation = 'clearing_rapidly';
        } else if (change3h > 1.5) {
            trend = 'rising';
            interpretation = 'improving_conditions';
        } else if (change3h > 0.5) {
            trend = 'rising_slowly';
            interpretation = 'slow_improvement';
        }

        return { trend, change3h, interpretation };
    }

    // ────────── SQUALL RISK ──────────

    _assessSquallRisk(gustFactor, pressureTrend, current) {
        let risk = 0;
        if (gustFactor > 1.5) risk += 3;
        else if (gustFactor > 1.3) risk += 2;
        else if (gustFactor > 1.2) risk += 1;

        if (pressureTrend.trend === 'falling_fast') risk += 3;
        else if (pressureTrend.trend === 'falling') risk += 2;

        if ((current.humidity ?? 0) > 85) risk += 1;

        if (risk >= 5) return 'high';
        if (risk >= 3) return 'moderate';
        return 'low';
    }

    // ────────── WEATHER WINDOW ──────────

    _assessWeatherWindow(forecast, beaufort) {
        if (!forecast) return { available: false };

        const h6 = forecast.hours6 || {};
        const h12 = forecast.hours12 || {};
        const h24 = forecast.hours24 || {};

        const windows = [];
        if ((h6.windSpeedMax || 0) <= 20 && (h6.waveHeightMax || 0) <= 2) {
            windows.push({ period: '6h', quality: 'good' });
        } else if ((h6.windSpeedMax || 0) <= 25) {
            windows.push({ period: '6h', quality: 'fair' });
        }

        if ((h12.windSpeedMax || 0) <= 20 && (h12.waveHeightMax || 0) <= 2) {
            windows.push({ period: '12h', quality: 'good' });
        }

        const deteriorating = (h12.windSpeedMax || 0) > (h6.windSpeedMax || 0) * 1.3;
        const improving = (h24.windSpeedMax || 0) < (h12.windSpeedMax || 0) * 0.7;

        return {
            available: windows.length > 0,
            windows,
            deteriorating,
            improving,
            bestWindow: windows.length > 0 ? windows[0] : null
        };
    }

    // ────────── SEA STATE ──────────

    /**
     * Assess sea state using Douglas scale.
     * @param {number} waveHeight Wave height in metres
     * @returns {string} Sea state category
     */
    assessSeaState(waveHeight = 0) {
        if (waveHeight < 0.1) return 'glassy';
        if (waveHeight < 0.5) return 'calm';
        if (waveHeight < 1.25) return 'smooth';
        if (waveHeight < 2.5) return 'slight';
        if (waveHeight < 4) return 'moderate';
        if (waveHeight < 6) return 'rough';
        if (waveHeight < 9) return 'very_rough';
        return 'phenomenal';
    }

    // ────────── SAILING CONDITIONS ──────────

    /**
     * Assess sailing conditions: point of sail, VMG, efficiency.
     */
    assessSailingConditions(current, vesselData) {
        if (vesselData.heading === undefined || vesselData.speed === undefined) {
            return { twa: null, vmg: null, pointOfSail: 'unknown', efficiency: 'unknown' };
        }

        const twa = this.calculateTWA(vesselData.heading, current.windDirection ?? 0);
        const vmg = vesselData.speed * Math.cos((twa * Math.PI) / 180);

        return {
            twa,
            vmg: Math.round(vmg * 10) / 10,
            pointOfSail: this.getPointOfSail(twa),
            efficiency: this.assessSailingEfficiency(vesselData.speed, current.windSpeed ?? 0, twa)
        };
    }

    calculateTWA(heading = 0, windDirection = 0) {
        let twa = windDirection - heading;
        if (twa < 0) twa += 360;
        if (twa > 180) twa = 360 - twa;
        return Math.round(twa);
    }

    getPointOfSail(twa) {
        if (twa <= 35) return 'in_irons';
        if (twa <= 50) return 'close_hauled';
        if (twa <= 60) return 'close_reach';
        if (twa <= 90) return 'beam_reach';
        if (twa <= 120) return 'broad_reach';
        if (twa <= 170) return 'running';
        return 'dead_run';
    }

    assessSailingEfficiency(boatSpeed, windSpeed, twa) {
        if (windSpeed <= 0) return 'unknown';
        const optimalRatio = {
            in_irons: 0, close_hauled: 0.4, close_reach: 0.6,
            beam_reach: 0.7, broad_reach: 0.65, running: 0.55, dead_run: 0.45
        };
        const pos = this.getPointOfSail(twa);
        const expected = windSpeed * (optimalRatio[pos] || 0.5);
        if (expected <= 0) return 'unknown';
        const eff = boatSpeed / expected;
        if (eff > 0.9) return 'excellent';
        if (eff > 0.7) return 'good';
        if (eff > 0.5) return 'fair';
        return 'poor';
    }

    // ────────── FORECAST TRENDS ──────────

    assessTrend(forecast = {}) {
        const h6 = forecast.hours6 || {};
        const h12 = forecast.hours12 || {};
        const h24 = forecast.hours24 || {};

        const trends = {
            wind: 'stable', waves: 'stable', pressure: 'stable', overall: 'stable',
            windChange: null, waveChange: null
        };

        if (h6.windSpeedMax && h12.windSpeedMax) {
            const ratio = h12.windSpeedMax / h6.windSpeedMax;
            trends.windChange = Math.round((ratio - 1) * 100);
            if (ratio > 1.3) trends.wind = 'increasing_rapidly';
            else if (ratio > 1.15) trends.wind = 'increasing';
            else if (ratio < 0.7) trends.wind = 'decreasing_rapidly';
            else if (ratio < 0.85) trends.wind = 'decreasing';
        }

        if (h6.waveHeightMax && h12.waveHeightMax) {
            const ratio = h12.waveHeightMax / h6.waveHeightMax;
            trends.waveChange = Math.round((ratio - 1) * 100);
            if (ratio > 1.3) trends.waves = 'building_rapidly';
            else if (ratio > 1.15) trends.waves = 'building';
            else if (ratio < 0.7) trends.waves = 'calming_rapidly';
            else if (ratio < 0.85) trends.waves = 'calming';
        }

        const deteriorating = trends.wind.includes('increasing') || trends.waves.includes('building');
        const improving = trends.wind.includes('decreasing') && trends.waves.includes('calming');

        if (deteriorating) trends.overall = 'deteriorating';
        else if (improving) trends.overall = 'improving';

        return trends;
    }

    // ────────── TIDE IMPACT ──────────

    /**
     * Assess tide impact including wind-against-tide danger.
     */
    assessTideImpact(tideData, vesselData, currentWeather) {
        const result = {
            height: tideData.current?.height ?? null,
            tendency: tideData.current?.tendency ?? 'unknown',
            coefficient: tideData.current?.coefficient ?? null,
            nextHigh: tideData.next?.high ?? null,
            nextLow: tideData.next?.low ?? null,
            impact: { current: 'neutral', navigation: [] },
            windAgainstTide: null
        };

        if (tideData.current?.tendency === 'falling' && vesselData.depth && vesselData.depth < 5) {
            result.impact.current = 'concerning';
            result.impact.navigation.push('depth_decreasing');
        }

        if ((tideData.current?.rate || 0) > 0.5) {
            result.impact.current = 'strong';
            result.impact.navigation.push('strong_current');
        }

        if (result.coefficient && result.coefficient > 90) {
            result.impact.navigation.push('spring_tide');
        }

        if (currentWeather?.windDirection !== undefined && tideData.current?.tendency) {
            result.windAgainstTide = this._assessWindAgainstTide(
                currentWeather.windSpeed || 0,
                currentWeather.windDirection,
                tideData.current.tendency,
                tideData.current.rate || 0
            );
        }

        return result;
    }

    /**
     * Wind blowing against tidal current creates steep, dangerous seas.
     */
    _assessWindAgainstTide(windSpeed, windDir, tideTendency, tideRate) {
        const danger = windSpeed > 15 && tideRate > 0.3;
        let severity = 'none';
        if (danger && windSpeed > 25) severity = 'high';
        else if (danger) severity = 'moderate';

        return {
            danger,
            severity,
            windSpeed,
            tideRate,
            description: danger
                ? this.cm.t('weather.alerts.wind_against_tide')
                : this.cm.t('weather.advice.light_general')
        };
    }

    // ────────── EXPERT ADVICE ──────────

    /**
     * Generate contextual expert sailor advice based on combined conditions.
     * @returns {Array<{type: string, priority: string, message: string}>}
     */
    _generateExpertAdvice(assessment, current) {
        const advice = [];
        const bf = assessment.beaufort?.force ?? 0;
        const sailAdvice = assessment.beaufort?.sailAdvice;

        if (sailAdvice === 'reef_1' || sailAdvice === 'reef_genoa') {
            advice.push({ type: 'sail_plan', priority: 'high',
                message: this.cm.t('weather.advice.fresh_warning') });
        } else if (sailAdvice === 'reef_2') {
            advice.push({ type: 'sail_plan', priority: 'high',
                message: this.cm.t('weather.advice.strong_warning') });
        } else if (sailAdvice === 'reef_3_storm_jib' || sailAdvice === 'storm_sails') {
            advice.push({ type: 'storm', priority: 'critical',
                message: this.cm.t('weather.advice.near_gale_warning') });
        } else if (bf <= 3 && bf > 0) {
            advice.push({ type: 'light_air', priority: 'low',
                message: this.cm.t('weather.advice.light_general') });
        }

        if (assessment.squallRisk === 'high') {
            advice.push({ type: 'squall', priority: 'high',
                message: this.cm.t('weather.advice.squall_preparation') });
        }

        if (assessment.pressure?.trend === 'falling_fast') {
            advice.push({ type: 'pressure', priority: 'high',
                message: this.cm.t('weather.advice.pressure_dropping') });
        }

        if (assessment.sailing.pointOfSail === 'dead_run' && bf >= 5) {
            advice.push({ type: 'safety', priority: 'high',
                message: this.cm.t('sail.advice.running_safety') });
        }

        if (assessment.sailing.efficiency === 'poor' && assessment.sailing.twa !== null) {
            const pos = assessment.sailing.pointOfSail;
            if (pos === 'close_hauled' || pos === 'close_reach') {
                advice.push({ type: 'trim', priority: 'medium',
                    message: this.cm.t('sail.advice.close_hauled_fresh') });
            } else {
                advice.push({ type: 'trim', priority: 'low',
                    message: this.cm.t('sail.advice.beam_reach_general') });
            }
        }

        if (assessment.windAgainstTide?.danger) {
            advice.push({ type: 'tide_danger', priority: 'high',
                message: this.cm.t('weather.alerts.wind_against_tide') });
        }

        if (assessment.weatherWindow?.available) {
            const bestHours = assessment.weatherWindow.bestWindow?.period || '6h';
            advice.push({ type: 'window', priority: 'low',
                message: this.cm.t('weather.advice.weather_window', { hours: bestHours.replace('h', '') }) });
        } else if (assessment.weatherWindow?.deteriorating) {
            advice.push({ type: 'passage', priority: 'medium',
                message: this.cm.t('weather.advice.strong_warning') });
        }

        return advice;
    }


    /**
     * Generate analysis with LLM enrichment.
     */
    async generateAnalysis(weatherData, tideData, vesselData, context, assessment) {
        try {
            const llmResult = await this.llm.analyzeWeather(weatherData, vesselData, context);
            const recommendations = this.generateRecommendations(assessment);

            const speech = llmResult?.speech || llmResult || '';
            const text = llmResult?.text || speech;

            return {
                speech,
                text,
                recommendations,
                expertAdvice: assessment.expertAdvice,
                summary: this.generateSummary(weatherData, assessment, recommendations)
            };
        } catch (error) {
            this.app.debug('LLM weather analysis unavailable, using expert analysis');
            return this.getFallbackAnalysisText(weatherData, assessment);
        }
    }

    /**
     * Generate structured recommendations based on assessed conditions.
     */
    generateRecommendations(assessment) {
        const recommendations = [];

        if (assessment.beaufort?.force >= 8) {
            recommendations.push({ type: 'storm_preparation', priority: 'critical',
                message: this.cm.t('weather.advice.near_gale_warning') });
        } else if (assessment.beaufort?.force >= 6) {
            recommendations.push({ type: 'sail_reduction', priority: 'high',
                message: this.cm.t('weather.advice.strong_warning') });
        } else if (assessment.beaufort?.force >= 5) {
            recommendations.push({ type: 'prepare_reef', priority: 'medium',
                message: this.cm.t('weather.advice.fresh_warning') });
        }

        if (assessment.seaState === 'rough' || assessment.seaState === 'very_rough') {
            recommendations.push({ type: 'course_change', priority: 'medium',
                message: this.cm.t('weather.advice.strong_warning') });
        }

        if (assessment.sailing?.efficiency === 'poor') {
            recommendations.push({ type: 'trim_adjustment', priority: 'low',
                message: this.cm.t('sail.advice.beam_reach_general') });
        }

        if (assessment.pressure?.trend === 'falling_fast') {
            recommendations.push({ type: 'weather_watch', priority: 'high',
                message: this.cm.t('weather.advice.pressure_dropping') });
        }

        return recommendations;
    }

    /**
     * Generate human-readable summary including Beaufort and pressure data.
     */
    generateSummary(weatherData, assessment, recommendations = []) {
        const current = weatherData?.current || {};
        const bf = assessment.beaufort;
        const cardinal = textUtils.bearingToCardinal(current.windDirection ?? 0);

        const summary = {
            conditions: `F${bf?.force ?? '?'} ${bf?.label ?? ''} - ` +
                `Wind ${current.windSpeed ?? '?'}kts from ${cardinal}, ` +
                `Waves ${current.waveHeight ?? '?'}m, ${assessment.seaState} sea`,
            sailing: `${assessment.sailing?.pointOfSail ?? 'unknown'}, TWA ${assessment.sailing?.twa ?? '?'}°, ` +
                `efficiency ${assessment.sailing?.efficiency ?? 'unknown'}`,
            trend: assessment.trend?.overall ?? 'unknown'
        };

        if (assessment.pressure?.current) {
            summary.pressure = `${assessment.pressure.current} hPa, ${assessment.pressure.trend}`;
        }

        if (assessment.tide) {
            const parts = [];
            if (assessment.tide.tendency) parts.push(assessment.tide.tendency);
            if (assessment.tide.height !== null) parts.push(`${assessment.tide.height}m`);
            if (assessment.tide.coefficient) parts.push(`coeff ${assessment.tide.coefficient}`);
            if (parts.length > 0) summary.tide = parts.join(', ');
        }

        if (assessment.expertAdvice?.length > 0) {
            summary.advice = assessment.expertAdvice.map(a => a.message).join(' ');
        } else if (recommendations.length > 0) {
            summary.advice = recommendations.map(r => r.message).join('. ');
        }

        return summary;
    }

    /**
     * Fallback analysis text when LLM is unavailable.
     */
    getFallbackAnalysisText(weatherData, assessment) {
        const current = weatherData?.current || {};
        const bf = assessment.beaufort;
        const cardinal = textUtils.bearingToCardinal(current.windDirection ?? 0);
        const bfLabel = this.cm.t(`weather.beaufort.${bf?.force ?? 0}`);

        let speech = this.cm.t('weather.current', {
            windSpeed: Math.round(current.windSpeed ?? 0),
            windDir: cardinal,
            waveHeight: (current.waveHeight ?? 0).toFixed(1)
        });
        speech = `F${bf?.force ?? '?'} ${bfLabel}. ${speech}`;

        if (assessment.expertAdvice?.length > 0) {
            speech += ' ' + assessment.expertAdvice[0].message;
        }

        const recommendations = this.generateRecommendations(assessment);
        const lang = this.config.language || this.cm?.language || 'en';
        const cleanedSpeech = textUtils.cleanForTTS(speech, lang);
        return {
            speech: cleanedSpeech,
            text: cleanedSpeech,
            recommendations,
            expertAdvice: assessment.expertAdvice,
            summary: this.generateSummary(weatherData, assessment, recommendations)
        };
    }

    /**
     * Fallback when no weather data is available at all.
     */
    getFallbackAnalysis(vesselData) {
        return {
            weatherData: null,
            tideData: null,
            assessment: {
                beaufort: null,
                windStrength: 'unknown',
                seaState: 'unknown',
                sailing: { twa: null, vmg: null, pointOfSail: 'unknown', efficiency: 'unknown' },
                trend: { overall: 'unknown' },
                pressure: { trend: 'unknown' },
                alerts: [],
                expertAdvice: []
            },
            analysis: {
                speech: this.cm.t('weather.unavailable'),
                text: this.cm.t('weather.unavailable'),
                recommendations: [],
                expertAdvice: [],
                summary: { conditions: this.cm.t('weather.unavailable') }
            },
            vesselData,
            timestamp: new Date().toISOString()
        };
    }
}

module.exports = MeteoAnalyzer;
