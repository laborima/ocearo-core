/**
 * LLM Integration Module
 *
 * Communicates with Ollama for natural language processing.
 * Uses the chat API for structured system/user message flows.
 * Default model: qwen2.5:3b (optimised for RPi5 4-8GB RAM).
 */

const { textUtils } = require('../common');

class LLMModule {
    constructor(app, config, cm) {
        this.app = app;
        this.config = config;
        this.cm = cm;
        this.baseUrl = config.llm?.ollamaHost || 'http://localhost:11434';
        this.model = config.llm?.model || 'qwen2.5:3b';
        this.timeout = (config.llm?.timeoutSeconds || 30) * 1000;
        this._connected = false;
        this._lastConnectionCheck = 0;
        this._connectionCheckInterval = 60000;
    }

    /**
     * Current language from config — single source of truth.
     * Falls back to ConfigManager language if available, then 'en'.
     */
    get _lang() {
        return this.config.language || this.cm?.language || 'en';
    }

    /**
     * Test LLM connection
     */
    async testConnection() {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        try {
            const response = await fetch(`${this.baseUrl}/api/tags`, {
                method: 'GET',
                signal: controller.signal
            });

            clearTimeout(timeout);

            if (!response.ok) {
                this._connected = false;
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();
            const hasModel = data.models?.some(m => m.name === this.model);
            
            this._connected = true;
            this._lastConnectionCheck = Date.now();

            return {
                connected: true,
                model: this.model,
                available: hasModel,
                models: data.models?.map(m => m.name) || []
            };
        } catch (error) {
            clearTimeout(timeout);
            this._connected = false;
            this._lastConnectionCheck = Date.now();
            return {
                connected: false,
                error: error.message
            };
        }
    }

    /**
     * Check if LLM is connected (synchronous, uses cached state)
     * Use checkConnectionAsync() for a fresh check
     */
    isConnected() {
        return this._connected;
    }

    /**
     * Async connection check with caching
     */
    async checkConnectionAsync() {
        const now = Date.now();
        if (now - this._lastConnectionCheck < this._connectionCheckInterval) {
            return this._connected;
        }
        
        try {
            const result = await this.testConnection();
            return result.connected;
        } catch {
            this._connected = false;
            return false;
        }
    }

    /**
     * Generate two completions from a prompt: one for voice TTS, one for UI/logbook.
     * The voice version is short and uses full unit words.
     * The UI version is richer and may use compact notation.
     * @param {string} basePrompt Base prompt (data context)
     * @param {Object} options temperature, top_p
     * @returns {{speech: string, text: string}}
     */
    async generateDualOutput(basePrompt, options = {}) {
        const lang = this._lang;

        const voicePrompt = lang === 'fr'
            ? `${basePrompt}\n\nRéponds en UNE SEULE phrase courte (max 20 mots), en français, adaptée à la synthèse vocale. Utilise les unités en toutes lettres (nœuds, mètres, degrés, hectopascals). Pas de chiffres décimaux, pas de symboles.`
            : `${basePrompt}\n\nRespond in ONE short sentence (max 20 words), suitable for text-to-speech. Spell out units (knots, meters, degrees). No decimals, no symbols.`;

        const textPrompt = lang === 'fr'
            ? `${basePrompt}\n\nRéponds en 3-4 phrases en français. Donne une analyse complète avec les données chiffrées, les risques identifiés et une recommandation concrète. Tu peux utiliser des abréviations (kts, hPa, m).`
            : `${basePrompt}\n\nRespond in 3-4 sentences in English. Give a complete analysis with figures, identified risks and one concrete recommendation. You may use abbreviations (kts, hPa, m).`;

        const [speechRaw, textRaw] = await Promise.all([
            this.generateCompletion(voicePrompt, { ...options, max_tokens: 80 }),
            this.generateCompletion(textPrompt, { ...options, max_tokens: 250 })
        ]);

        return {
            speech: textUtils.cleanForTTS(speechRaw, lang),
            text: textRaw.trim()
        };
    }

    /**
     * Generate completion from a prompt string.
     * @param {string} prompt User prompt text
     * @param {Object} options temperature, top_p, max_tokens
     * @returns {string} Generated text
     */
    async generateCompletion(prompt, options = {}) {
        if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
            throw new Error('Invalid prompt: Prompt must be a non-empty string');
        }

        if (!await this.checkConnectionAsync()) {
            throw new Error('LLM service not available');
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeout);

        try {
            const response = await fetch(`${this.baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.model,
                    messages: [
                        { role: 'system', content: this._buildSystemMessage() },
                        { role: 'user', content: prompt }
                    ],
                    stream: false,
                    options: {
                        temperature: options.temperature || 0.7,
                        top_p: options.top_p || 0.9,
                        num_predict: options.max_tokens || 150
                    }
                }),
                signal: controller.signal
            });

            clearTimeout(timeout);

            if (!response.ok) {
                throw new Error(`Ollama error: ${response.status}`);
            }

            const data = await response.json();
            return data.message?.content || data.response || '';
        } catch (error) {
            clearTimeout(timeout);
            if (!error.message.includes('LLM service not available')) {
                this.app.debug('LLM generation failed:', error.message);
            }
            throw error;
        }
    }

    /**
     * Build the system message for all LLM interactions.
     * @returns {string} System prompt
     */
    _buildSystemMessage() {
        const lang = this._lang;
        const personality = this.config.personality || 'professional';
        const mode = this.config.mode || 'sailing';

        const personalities = {
            jarvis: lang === 'fr'
                ? 'Tu es Jarvis, assistant de navigation expérimenté et fiable, style officier de marine.'
                : 'You are Jarvis, an experienced and reliable navigation assistant, styled as a naval officer.',
            friend: lang === 'fr'
                ? 'Tu es un skipper ami, détendu mais compétent, qui donne des conseils pratiques.'
                : 'You are a friendly skipper buddy, relaxed but competent, giving practical advice.',
            professional: lang === 'fr'
                ? 'Tu es un conseiller maritime professionnel, précis et factuel.'
                : 'You are a professional maritime advisor, precise and factual.',
            'sea dog': lang === 'fr'
                ? 'Tu es un vieux loup de mer bourru mais bienveillant, avec 40 ans de navigation.'
                : 'You are a gruff but caring old sea dog with 40 years of sailing experience.'
        };

        const persona = personalities[personality] || personalities.professional;

        if (lang === 'fr') {
            return `${persona} ` +
                `Tu as une expertise approfondie en: météo marine, réglage de voiles, manoeuvres, ` +
                `COLREG, marées et courants, sécurité en mer, et navigation côtière/hauturière. ` +
                `Mode actuel: ${mode}. Tu réponds TOUJOURS en français, sans exception. ` +
                `Utilise le vocabulaire marin approprié ` +
                `(ris, hale-bas, étai, génois, tourmentin, lofer, abattre, empannage, virement). ` +
                `Pas de markdown, pas de listes, pas de caractères spéciaux. ` +
                `Donne des conseils actionables et pratiques, comme un vrai skipper.`;
        }

        return `${persona} ` +
            `You have deep expertise in: marine weather, sail trim, seamanship, ` +
            `COLREGs, tides and currents, safety at sea, and coastal/offshore navigation. ` +
            `Current mode: ${mode}. Always respond in English. ` +
            `Use proper nautical terminology (reef, vang, forestay, genoa, storm jib, luff, bear away, gybe, tack). ` +
            `No markdown, no bullet points, no special characters. ` +
            `Give actionable, practical advice like a real skipper would.`;
    }

    /**
     * Build alert analysis prompt with full vessel context.
     * @param {Object} alert Alert data
     * @param {Object} vesselData Current vessel data
     * @param {Object} context Navigation context
     * @returns {string} Prompt text
     */
    buildAlertPrompt(alert, vesselData, context) {
        const status = this.summarizeVesselStatus(vesselData);
        const lang = this._lang;
        const contextInfo = lang === 'fr'
            ? (context.profile ? `Navire: ${context.profile}, Destination: ${context.destination || 'non définie'}` : 'Contexte navire non disponible')
            : (context.profile ? `Vessel: ${context.profile}, Destination: ${context.destination || 'Not set'}` : 'No vessel context');

        if (lang === 'fr') {
            return `Alerte: ${alert.message} (Sévérité: ${alert.severity}, Catégorie: ${alert.category || 'général'}, Valeur: ${alert.value}).\n` +
                `Navire: ${status}.\n` +
                `Contexte: ${contextInfo}.\n` +
                `Explique le risque pour la sécurité de l'équipage, ce qu'il faut vérifier en premier, et une action immédiate à prendre.`;
        }

        return `Alert: ${alert.message} (Severity: ${alert.severity}, Category: ${alert.category || 'general'}, Value: ${alert.value}).\n` +
            `Vessel: ${status}.\n` +
            `Context: ${contextInfo}.\n` +
            `Explain the risk to crew safety, what to check first, and one immediate action to take.`;
    }

    /**
     * Build weather analysis prompt with Beaufort, pressure, gusts, tides.
     * @param {Object} weatherData Weather data
     * @param {Object} vesselData Vessel data
     * @returns {string} Prompt text
     */
    buildWeatherPrompt(weatherData, vesselData) {
        const current = weatherData.current || {};
        const forecast = weatherData.forecast?.hours6;
        const cardinal = this._bearingToCardinal(current.windDirection ?? 0);
        const lang = this._lang;

        if (lang === 'fr') {
            let prompt = `Vent: ${current.windSpeed ?? '?'} nœuds du ${cardinal} (${current.windDirection ?? '?'}°)`;
            if (current.gustSpeed) prompt += `, rafales ${current.gustSpeed} nœuds`;
            if (current.waveHeight) prompt += `. Houle: ${current.waveHeight}m`;
            if (current.pressure) prompt += `. Baromètre: ${current.pressure} hPa`;
            if (forecast) {
                prompt += `.\nPrévisions 6h: vent max ${forecast.windSpeedMax ?? '?'} nœuds`;
                if (forecast.waveHeightMax) prompt += `, houle max ${forecast.waveHeightMax}m`;
            }
            prompt += `.\nNavire: ${vesselData.speed ?? '?'} nœuds, cap ${vesselData.heading ?? '?'}°`;
            if (vesselData.depth) prompt += `, fond ${vesselData.depth}m`;
            prompt += `.\nÉvalue les conditions, identifie les risques, donne une recommandation pratique de skipper expérimenté.`;
            return prompt;
        }

        let prompt = `Wind: ${current.windSpeed ?? '?'} knots from ${cardinal} (${current.windDirection ?? '?'}°)`;
        if (current.gustSpeed) prompt += `, gusts ${current.gustSpeed} knots`;
        if (current.waveHeight) prompt += `. Waves: ${current.waveHeight}m`;
        if (current.pressure) prompt += `. Barometer: ${current.pressure} hPa`;
        if (forecast) {
            prompt += `.\nForecast 6h: max wind ${forecast.windSpeedMax ?? '?'} knots`;
            if (forecast.waveHeightMax) prompt += `, max waves ${forecast.waveHeightMax}m`;
        }
        prompt += `.\nVessel: ${vesselData.speed ?? '?'} knots, heading ${vesselData.heading ?? '?'}°`;
        if (vesselData.depth) prompt += `, depth ${vesselData.depth}m`;
        prompt += `.\nAssess conditions, identify risks, give one practical recommendation as an experienced skipper.`;
        return prompt;
    }

    /**
     * Build sail optimization prompt with trim details.
     * @param {Object} vesselData Vessel data
     * @param {number} targetHeading Target heading in degrees
     * @param {Object} windData Wind data {speed, direction}
     * @returns {string} Prompt text
     */
    buildSailPrompt(vesselData, targetHeading, windData) {
        const twa = this.calculateTWA(vesselData.heading, windData.direction);
        const cardinal = this._bearingToCardinal(windData.direction);
        const lang = this._lang;

        if (lang === 'fr') {
            let prompt = `Vent: ${windData.speed} nœuds du ${cardinal}, ` +
                `Navire: ${vesselData.speed} nœuds, cap ${vesselData.heading}°, ` +
                `Angle vent réel: ${twa}°, Cap cible: ${targetHeading}°`;
            if (vesselData.heeling) prompt += `, Gîte: ${vesselData.heeling}°`;
            prompt += `. Recommande le plan de voilure, les réglages de trim, et les précautions de sécurité pour ces conditions.`;
            return prompt;
        }

        let prompt = `Wind: ${windData.speed} knots from ${cardinal}, ` +
            `Boat: ${vesselData.speed} knots heading ${vesselData.heading}°, ` +
            `TWA: ${twa}°, Target heading: ${targetHeading}°`;
        if (vesselData.heeling) prompt += `, Heel: ${vesselData.heeling}°`;
        prompt += `. Recommend sail plan, trim adjustments, and any safety precautions for these conditions.`;
        return prompt;
    }

    /**
     * Build AIS collision analysis prompt.
     * @param {Array} dangerousTargets AIS targets with collision risk
     * @param {Object} vesselData Own vessel data
     * @returns {string} Prompt text
     */
    buildAISPrompt(dangerousTargets, vesselData) {
        const lang = this._lang;

        if (lang === 'fr') {
            const targets = dangerousTargets.slice(0, 3).map(t =>
                `${t.name} relèvement ${t.bearing}° à ${t.range} milles, CPA ${t.cpa} milles dans ${t.tcpa} minutes, ${t.colregs}`
            ).join('; ');
            return `Risque de collision détecté. Navire propre: ${vesselData.speed ?? '?'} nœuds, cap ${vesselData.heading ?? '?'}°. ` +
                `Cibles: ${targets}. ` +
                `Indique quelles cibles sont les plus dangereuses, l'obligation COLREG applicable, et une manœuvre d'évitement claire.`;
        }

        const targets = dangerousTargets.slice(0, 3).map(t =>
            `${t.name} bearing ${t.bearing}° at ${t.range}NM, CPA ${t.cpa}NM in ${t.tcpa}min, ${t.colregs}`
        ).join('; ');
        return `Collision risk detected. Own vessel: ${vesselData.speed ?? '?'} knots heading ${vesselData.heading ?? '?'}°. ` +
            `Targets: ${targets}. ` +
            `State which targets are most dangerous, the COLREGs obligation, and one clear evasive action.`;
    }

    /**
     * Analyze AIS collision risks with LLM.
     * @param {Array} dangerousTargets Targets with risk
     * @param {Object} vesselData Own vessel data
     * @returns {string} Analysis text for TTS
     */
    async analyzeCollisionRisk(dangerousTargets, vesselData) {
        try {
            const prompt = this.buildAISPrompt(dangerousTargets, vesselData);
            const result = await this.generateDualOutput(prompt, { temperature: 0.4 });
            return result;
        } catch (error) {
            this.app.debug('LLM AIS analysis failed:', error.message);
            return null;
        }
    }

    /**
     * Process alert with LLM
     */
    async processAlert(alert, vesselData, context) {
        try {
            const prompt = this.buildAlertPrompt(alert, vesselData, context);
            const result = await this.generateDualOutput(prompt, { temperature: 0.6 });
            return result;
        } catch (error) {
            this.app.error('Failed to process alert with LLM:', error);
            const fallback = this.getFallbackAlertMessage(alert);
            return { speech: fallback, text: fallback };
        }
    }

    /**
     * Analyze weather conditions
     */
    async analyzeWeather(weatherData, vesselData, context) {
        try {
            const prompt = this.buildWeatherPrompt(weatherData, vesselData);
            const result = await this.generateDualOutput(prompt, { temperature: 0.7 });
            return result;
        } catch (error) {
            this.app.error('Failed to analyze weather with LLM:', error);
            const fallback = this.getFallbackWeatherMessage(weatherData);
            return { speech: fallback, text: fallback };
        }
    }

    /**
     * Get sail recommendations
     */
    async getSailRecommendations(vesselData, targetHeading, windData) {
        try {
            const prompt = this.buildSailPrompt(vesselData, targetHeading, windData);
            const result = await this.generateDualOutput(prompt, { temperature: 0.5 });
            return result;
        } catch (error) {
            this.app.error('Failed to get sail recommendations:', error);
            const fallback = this.getFallbackSailMessage(vesselData, windData);
            return { speech: fallback, text: fallback };
        }
    }

    /**
     * Summarize vessel status for prompts
     */
    summarizeVesselStatus(vesselData) {
        const lang = this._lang;
        const parts = [];

        if (lang === 'fr') {
            if (vesselData.speed !== undefined) parts.push(`Vitesse: ${vesselData.speed} nœuds`);
            if (vesselData.heading !== undefined) parts.push(`Cap: ${vesselData.heading}°`);
            if (vesselData.depth !== undefined) parts.push(`Fond: ${vesselData.depth}m`);
            if (vesselData.wind?.speed !== undefined) parts.push(`Vent: ${vesselData.wind.speed} nœuds`);
            return parts.join(', ') || 'Données navire limitées';
        }

        if (vesselData.speed !== undefined) parts.push(`Speed: ${vesselData.speed} knots`);
        if (vesselData.heading !== undefined) parts.push(`Heading: ${vesselData.heading}°`);
        if (vesselData.depth !== undefined) parts.push(`Depth: ${vesselData.depth}m`);
        if (vesselData.wind?.speed !== undefined) parts.push(`Wind: ${vesselData.wind.speed} knots`);
        return parts.join(', ') || 'Limited vessel data available';
    }

    /**
     * Return cardinal direction label in the current language.
     * @param {number} bearing
     * @returns {string}
     */
    _bearingToCardinal(bearing) {
        const index = Math.round(bearing / 22.5) % 16;
        if (this._lang === 'fr') {
            const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                          'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
            return dirs[index];
        }
        const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                      'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
        return dirs[index];
    }

    /**
     * Calculate True Wind Angle
     */
    calculateTWA(heading, windDirection) {
        let twa = windDirection - heading;
        if (twa < 0) twa += 360;
        if (twa > 180) twa = 360 - twa;
        return Math.round(twa);
    }

    /**
     * Fallback alert message
     */
    getFallbackAlertMessage(alert) {
        return textUtils.formatTextForTTS(
            this.cm.t('alerts.generic', {
                message: alert.message,
                value: alert.value
            }),
            this._lang
        );
    }

    /**
     * Fallback weather message
     */
    getFallbackWeatherMessage(weatherData) {
        return textUtils.formatTextForTTS(
            this.cm.t('weather.current', {
                windSpeed: Math.round(weatherData.current.windSpeed ?? 0),
                windDir: this._bearingToCardinal(weatherData.current.windDirection ?? 0),
                waveHeight: (weatherData.current.waveHeight ?? 0).toFixed(1)
            }),
            this._lang
        );
    }

    /**
     * Fallback sail message
     */
    getFallbackSailMessage(vesselData, windData) {
        const lang = this._lang;
        const twa = this.calculateTWA(vesselData.heading, windData.direction);

        if (lang === 'fr') {
            let sailConfig = 'grand-voile et foc';
            if (twa > 120) sailConfig = 'grand-voile et spinnaker';
            if (twa < 45) sailConfig = 'grand-voile seule, au près serré';
            return textUtils.cleanForTTS(
                `Angle vent réel: ${twa} degrés. Configuration voiles suggérée: ${sailConfig}.`, 'fr'
            );
        }

        let sailConfig = 'main and jib';
        if (twa > 120) sailConfig = 'main and spinnaker';
        if (twa < 45) sailConfig = 'main only, close hauled';
        return textUtils.cleanForTTS(
            `Current true wind angle: ${twa} degrees. Suggested sail configuration: ${sailConfig}.`, 'en'
        );
    }
}

module.exports = LLMModule;
