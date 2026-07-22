/**
 * Racing Analysis Module
 *
 * Provides strategic tactical advice toward the next race waypoint.
 * Exploits the SignalK Course Provider, weather data, vessel polars and
 * all available navigation data to generate actionable sailing advice.
 *
 * Features:
 * - Next waypoint resolution via Course Provider (with route fallback)
 * - VMG and layline calculation toward the mark
 * - Weather and pressure trend integration
 * - LLM-powered strategic advice (FR/EN)
 */

const { textUtils } = require('../common');

/** Nautical miles conversion constant */
const NM = 1852;

class RacingAnalyzer {
    /**
     * @param {object} app              SignalK app object
     * @param {object} config           Plugin configuration
     * @param {object} llm              LLM module
     * @param {object} cm               ConfigManager
     * @param {object} weatherProvider  Weather data provider
     */
    constructor(app, config, llm, cm, weatherProvider) {
        this.app = app;
        this.config = config;
        this.llm = llm;
        this.cm = cm;
        this.weatherProvider = weatherProvider;

        // Manoeuvre penalties from boat config or defaults
        const boatPenalties = cm.boatValue('maneuverPenalties', {});
        this.tackPenalty = boatPenalties.tack || config.sailing?.tackPenalty || 45;  // seconds
        this.gybePenalty = boatPenalties.gybe || config.sailing?.gybePenalty || 30;  // seconds
    }

    /**
     * Perform a full racing tactical analysis.
     * @param {object} vesselData  Vessel data from SignalKProvider
     * @param {object} courseData  Course Provider data (nextPoint, bearing, distanceNM, etc.)
     * @returns {object} Racing analysis result
     */
    async analyze(vesselData, courseData) {
        try {
            const isFrench = this.cm.language === 'fr';

            const nextWaypoint = courseData?.nextPoint;
            if (!nextWaypoint) {
                return this._noWaypointResult(isFrench);
            }

            const nav = vesselData.navigation || {};
            const env = vesselData.environment || {};

            const sogMs = nav.speedOverGround || 0;
            const sogKts = sogMs * 1.94384;
            const cogRad = nav.courseOverGroundTrue || nav.headingTrue || 0;
            const cogDeg = cogRad * 180 / Math.PI;
            const headingDeg = (nav.headingTrue || cogRad) * 180 / Math.PI;

            const windSpeedMs = env.wind?.speedTrue || env.wind?.speedApparent || 0;
            const windSpeedKts = windSpeedMs * 1.94384;
            const windAngleRad = env.wind?.angleTrueWater || env.wind?.angleApparent || 0;
            const windAngleDeg = windAngleRad * 180 / Math.PI;
            const windDirDeg = this._normalizeAngle(headingDeg + windAngleDeg);

            const bearingDeg = courseData.bearing ?? 0;
            const distanceNM = courseData.distanceNM ?? 0;

            // True Wind Angle toward the mark
            const twaMark = this._calculateTWA(bearingDeg, windDirDeg);

            // Current VMG toward the mark
            const vmgMark = this._calculateVMGtoTarget(sogKts, cogDeg, bearingDeg);

            // Optimal VMG options from polar
            const windRange = this.cm.getWindRange(windSpeedKts);
            const optimalTWA = this.cm.getOptimalTWA(windRange);
            const polarSpeed = this.cm.polar(windSpeedKts, twaMark);
            const efficiency = polarSpeed > 0 ? Math.min(sogKts / polarSpeed, 1.5) : 0;

            // Laylines toward the mark
            const laylines = this._calculateLaylines(windDirDeg, bearingDeg, windRange);

            // Course options
            const courseOptions = this._evaluateCourseOptions(
                bearingDeg, windDirDeg, windSpeedKts, sogKts, windRange, optimalTWA
            );
            const bestOption = courseOptions[0];

            // Weather context
            let weatherSummary = null;
            try {
                const weatherData = await this.weatherProvider.getWeatherData();
                weatherSummary = this._extractWeatherSummary(weatherData, env);
            } catch (_) {
                weatherSummary = this._extractWeatherSummary(null, env);
            }

            // Expert tactical advice (rule-based)
            const expertAdvice = this._generateTacticalAdvice(
                { twaMark, vmgMark, sogKts, cogDeg, efficiency, pointOfSail: this.cm.getPointOfSail(twaMark) },
                bestOption, laylines, windSpeedKts, windDirDeg, distanceNM
            );

            // LLM strategic advice
            let llmAdvice = null;
            if (this.config.sailing?.useLLMAnalysis !== false && this.llm && this.llm.isConnected()) {
                llmAdvice = await this._generateLLMAdvice(
                    { sogKts, cogDeg, headingDeg, windSpeedKts, windAngleDeg, efficiency },
                    bearingDeg, distanceNM, twaMark, bestOption, weatherSummary, expertAdvice, isFrench
                );
            }

            const speechText = llmAdvice?.speech
                || (expertAdvice.length > 0 ? expertAdvice[0].message : null)
                || (isFrench ? `Cap recommandé ${Math.round(bestOption?.heading ?? bearingDeg)}°` : `Recommended heading ${Math.round(bestOption?.heading ?? bearingDeg)}°`);

            return {
                waypoint: nextWaypoint,
                bearing: Math.round(bearingDeg),
                distanceNM: Math.round(distanceNM * 10) / 10,
                twaMark: Math.round(twaMark),
                vmgMark: Math.round(vmgMark * 10) / 10,
                efficiency: Math.round(efficiency * 100) / 100,
                pointOfSail: this.cm.getPointOfSail(twaMark),
                laylines,
                courseOptions,
                bestOption,
                expertAdvice,
                analysis: llmAdvice,
                speechText,
                weatherSummary,
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            this.app.error('Racing analysis failed:', error);
            return this._fallbackResult();
        }
    }

    // ─── WAYPOINT RESOLUTION ──────────────────────────────────────────────────

    /**
     * Resolve the next race waypoint from Course Provider data.
     * Tries courseGreatCircle.nextPoint first, then currentRoute fallback.
     * @param {object} signalkProvider
     * @returns {{ position, name, bearing, distanceNM } | null}
     */
    resolveNextWaypoint(signalkProvider) {
        try {
            const courseData = signalkProvider.getCourseData();
            return courseData;
        } catch (_) {
            return null;
        }
    }

    // ─── LAYLINES ─────────────────────────────────────────────────────────────

    _calculateLaylines(windDir, markBearing, windRange) {
        const opt = this.cm.getOptimalTWA(windRange);
        const twaMark = this._calculateTWA(markBearing, windDir);
        const isUpwind = twaMark < opt.upwind;
        const isDownwind = twaMark > opt.downwind;

        return {
            isUpwind,
            isDownwind,
            portUpwind: this._normalizeAngle(windDir + opt.upwind),
            stbdUpwind: this._normalizeAngle(windDir - opt.upwind),
            portDownwind: this._normalizeAngle(windDir + opt.downwind),
            stbdDownwind: this._normalizeAngle(windDir - opt.downwind),
            optimalUpwindTWA: opt.upwind,
            optimalDownwindTWA: opt.downwind
        };
    }

    // ─── COURSE OPTIONS ───────────────────────────────────────────────────────

    _evaluateCourseOptions(markBearing, windDir, windSpeedKts, currentSpeedKts, windRange, optimalTWA) {
        const options = [];

        const buildOption = (type, heading, tacks, gybes) => {
            const twa = this._calculateTWA(heading, windDir);
            const polar = this.cm.polar(windSpeedKts, twa);
            const headingDiff = this._angleDiff(heading, markBearing);
            const vmgToMark = polar * Math.cos(Math.abs(headingDiff) * Math.PI / 180);
            const penaltySec = tacks * this.tackPenalty + gybes * this.gybePenalty;
            const distPenalty = (penaltySec / 3600) * (currentSpeedKts || 3);
            const score = vmgToMark - distPenalty;

            options.push({
                type,
                heading: this._normalizeAngle(heading),
                twa: Math.round(twa),
                tacks,
                gybes,
                polarSpeed: Math.round(polar * 10) / 10,
                vmgToMark: Math.round(vmgToMark * 10) / 10,
                penaltySec,
                score: Math.round(score * 100) / 100,
                pointOfSail: this.cm.getPointOfSail(twa)
            });
        };

        const directTWA = this._calculateTWA(markBearing, windDir);

        buildOption('direct', markBearing, 0, 0);

        if (directTWA < optimalTWA.upwind) {
            buildOption('port_tack', this._normalizeAngle(windDir + optimalTWA.upwind), 1, 0);
            buildOption('starboard_tack', this._normalizeAngle(windDir - optimalTWA.upwind), 1, 0);
        }

        if (directTWA > optimalTWA.downwind) {
            buildOption('port_gybe', this._normalizeAngle(windDir + optimalTWA.downwind), 0, 1);
            buildOption('starboard_gybe', this._normalizeAngle(windDir - optimalTWA.downwind), 0, 1);
        }

        return options.sort((a, b) => b.score - a.score);
    }

    // ─── TACTICAL ADVICE ─────────────────────────────────────────────────────

    _generateTacticalAdvice(current, bestOption, laylines, windSpeedKts, windDir, distanceNM) {
        const advice = [];

        if (laylines.isUpwind) {
            if (current.efficiency < 0.65 && current.efficiency > 0) {
                advice.push({
                    type: 'performance', priority: 'high',
                    message: this.cm.t('racing.advice.low_efficiency', { eff: Math.round(current.efficiency * 100) })
                        || `Performance polaire faible (${Math.round(current.efficiency * 100)}%). Vérifier les réglages de voiles.`
                });
            }
            if (current.twaMark < 38) {
                advice.push({
                    type: 'tactical', priority: 'high',
                    message: this.cm.t('racing.advice.pinching') || 'Angle de près trop serré. Abattez pour accélérer.'
                });
            }
        }

        if (laylines.isDownwind && current.twaMark > 165) {
            advice.push({
                type: 'tactical', priority: 'medium',
                message: this.cm.t('racing.advice.dead_run', { angle: laylines.optimalDownwindTWA })
                    || `Vent arrière sec. VMG optimal à ${laylines.optimalDownwindTWA}° de vent.`
            });
        }

        if (bestOption && (bestOption.type.includes('tack') || bestOption.type.includes('gybe'))) {
            const action = bestOption.type.includes('tack') ? 'virement' : 'empannage';
            advice.push({
                type: 'manoeuvre', priority: 'high',
                message: this.cm.t('racing.advice.manoeuvre', { action, heading: bestOption.heading })
                    || `${action.charAt(0).toUpperCase() + action.slice(1)} recommandé. Cap cible : ${bestOption.heading}°.`
            });
        }

        if (windSpeedKts > 20) {
            advice.push({
                type: 'safety', priority: 'medium',
                message: this.cm.t('racing.advice.strong_wind', { speed: Math.round(windSpeedKts) })
                    || `Vent fort ${Math.round(windSpeedKts)} nds. Vérifier les ris et la stabilité.`
            });
        }

        if (distanceNM < 0.5) {
            advice.push({
                type: 'tactical', priority: 'high',
                message: this.cm.t('racing.advice.approaching_mark') || 'Approche de la marque. Préparer le virement/empannage et anticiper la prise de marque.'
            });
        }

        return advice;
    }

    // ─── WEATHER SUMMARY ─────────────────────────────────────────────────────

    _extractWeatherSummary(weatherData, env) {
        const pressureHpa = env.outside?.pressure ? env.outside.pressure / 100 : null;
        const trend = weatherData?.assessment?.pressure?.trend || null;
        const forecast = weatherData?.forecast?.shortTerm || null;

        return {
            pressureHpa: pressureHpa ? Math.round(pressureHpa) : null,
            trend,
            forecast,
            beaufort: weatherData?.assessment?.beaufort?.force ?? null,
            windStrength: weatherData?.assessment?.windStrength ?? null,
            squallRisk: weatherData?.assessment?.squallRisk ?? null
        };
    }

    // ─── LLM ADVICE ──────────────────────────────────────────────────────────

    async _generateLLMAdvice(vessel, bearing, distanceNM, twaMark, bestOption, weather, expertAdvice, isFrench) {
        try {
            const windLabel = `${Math.round(vessel.windSpeedKts)} ${isFrench ? 'nds' : 'kts'}`;
            const sogLabel = `${Math.round(vessel.sogKts * 10) / 10} ${isFrench ? 'nds' : 'kts'}`;
            const effLabel = `${Math.round(vessel.efficiency * 100)}%`;
            const bestLabel = bestOption ? `${bestOption.type} → ${bestOption.heading}°` : 'direct';
            const adviceSummary = expertAdvice.length > 0
                ? expertAdvice.map(a => a.message).join('; ')
                : (isFrench ? 'Aucun conseil spécifique' : 'No specific advice');
            const weatherLabel = weather
                ? (isFrench
                    ? `Pression ${weather.pressureHpa ?? '?'} hPa${weather.trend ? ', tendance ' + weather.trend : ''}${weather.squallRisk === 'high' ? ', risque grains' : ''}`
                    : `Pressure ${weather.pressureHpa ?? '?'} hPa${weather.trend ? ', trend ' + weather.trend : ''}${weather.squallRisk === 'high' ? ', squall risk' : ''}`)
                : '';

            const prompt = isFrench
                ? `Tu es un tacticien de régate expert. Donne un conseil stratégique TRÈS concis (max 80 mots) pour atteindre la prochaine marque.\n` +
                  `Marque : ${distanceNM.toFixed(1)} NM, cap ${Math.round(bearing)}°. TWA ${Math.round(twaMark)}°.\n` +
                  `Navire : SOG ${sogLabel}, efficacité polaire ${effLabel}.\n` +
                  `Vent : ${windLabel}. ${weatherLabel}.\n` +
                  `Meilleure option calculée : ${bestLabel}.\n` +
                  `Conseils tactiques : ${adviceSummary}.\n` +
                  `Réponds uniquement en français. Sois direct et actionnable.`
                : `You are an expert race tactician. Give a VERY concise strategic advice (max 80 words) to reach the next mark.\n` +
                  `Mark: ${distanceNM.toFixed(1)} NM, bearing ${Math.round(bearing)}°. TWA ${Math.round(twaMark)}°.\n` +
                  `Vessel: SOG ${sogLabel}, polar efficiency ${effLabel}.\n` +
                  `Wind: ${windLabel}. ${weatherLabel}.\n` +
                  `Best calculated option: ${bestLabel}.\n` +
                  `Tactical notes: ${adviceSummary}.\n` +
                  `Be direct and actionable.`;

            const result = await this.llm.generateDualOutput(prompt, { temperature: 0.35, maxTokens: 150 });
            return result;
        } catch (error) {
            this.app.debug('Racing LLM advice failed:', error.message);
            return null;
        }
    }

    // ─── MATH HELPERS ────────────────────────────────────────────────────────

    _calculateTWA(heading, windDir) {
        let twa = Math.abs(windDir - heading);
        if (twa > 180) twa = 360 - twa;
        return Math.round(twa);
    }

    _calculateVMGtoTarget(speedKts, cogDeg, targetBearing) {
        const diff = this._angleDiff(cogDeg, targetBearing);
        return speedKts * Math.cos(Math.abs(diff) * Math.PI / 180);
    }

    _normalizeAngle(angle) {
        angle = angle % 360;
        if (angle < 0) angle += 360;
        return Math.round(angle);
    }

    _angleDiff(a, b) {
        let diff = a - b;
        while (diff > 180) diff -= 360;
        while (diff < -180) diff += 360;
        return diff;
    }

    // ─── FALLBACKS ───────────────────────────────────────────────────────────

    _noWaypointResult(isFrench) {
        return {
            waypoint: null,
            status: 'no_waypoint',
            message: isFrench
                ? 'Aucun waypoint actif. Activez une route ou définissez une destination dans le Course Provider.'
                : 'No active waypoint. Activate a route or set a destination in the Course Provider.',
            expertAdvice: [],
            analysis: null,
            speechText: isFrench
                ? 'Mode régate actif. Aucun waypoint de course défini.'
                : 'Racing mode active. No race waypoint defined.',
            timestamp: new Date().toISOString()
        };
    }

    _fallbackResult() {
        return {
            waypoint: null,
            status: 'error',
            expertAdvice: [],
            analysis: null,
            speechText: this.cm.t('general.analysis_failed') || 'Racing analysis unavailable.',
            timestamp: new Date().toISOString()
        };
    }
}

module.exports = RacingAnalyzer;
