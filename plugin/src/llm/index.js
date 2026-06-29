/**
 * LLM Integration Module
 *
 * Communicates with Ollama for natural language processing.
 * Uses the chat API for structured system/user message flows.
 * Default model: llama3.2:3b (optimised for RPi5 4-8GB RAM).
 */

const { textUtils } = require('../common');

class LLMModule {
    constructor(app, config, cm) {
        this.app = app;
        this.config = config;
        this.cm = cm;
        this.baseUrl = config.llm?.ollamaHost || 'http://localhost:11434';
        this.model = config.llm?.model || 'gemma3n:e2b';
        this.timeout = (config.llm?.timeoutSeconds || 30) * 1000;
        this._connected = false;
        this._lastConnectionCheck = 0;
        this._connectionCheckInterval = 60000;

        // Circuit breaker — stop hammering Ollama if it is hanging/failing on the RPi5.
        this._consecutiveFailures = 0;
        this._circuitOpenUntil = 0;
        this._maxConsecutiveFailures = config.llm?.maxConsecutiveFailures || 3;
        this._circuitCooldownMs = (config.llm?.circuitCooldownSeconds || 120) * 1000;
    }

    /**
     * True while the circuit breaker is open (LLM temporarily disabled after repeated failures).
     */
    _circuitOpen() {
        return Date.now() < this._circuitOpenUntil;
    }

    /**
     * Record an LLM call outcome and trip/reset the circuit breaker accordingly.
     * @param {boolean} ok
     */
    _recordOutcome(ok) {
        if (ok) {
            this._consecutiveFailures = 0;
            this._circuitOpenUntil = 0;
            return;
        }
        this._consecutiveFailures++;
        if (this._consecutiveFailures >= this._maxConsecutiveFailures) {
            this._circuitOpenUntil = Date.now() + this._circuitCooldownMs;
            this.app.error(
                `LLM circuit breaker OPEN after ${this._consecutiveFailures} failures; ` +
                `pausing LLM calls for ${Math.round(this._circuitCooldownMs / 1000)}s`
            );
        }
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
            ? `${basePrompt}\n\nRéponds comme à l'oral, d'une voix de skipper posée: une à deux phrases courtes et naturelles (max 25 mots), en français. Va droit au conseil concret. Unités en toutes lettres (nœuds, mètres, milles nautiques, degrés). Pas de chiffres décimaux, pas de symboles, pas de liste.`
            : `${basePrompt}\n\nRespond as if speaking aloud, in a calm skipper's voice: one or two short, natural sentences (max 25 words), in English. Get straight to the concrete advice. Spell out units (knots, meters, nautical miles, degrees). No decimals, no symbols, no list.`;

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

        if (this._circuitOpen()) {
            throw new Error('LLM service not available');
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
            this._recordOutcome(true);
            return data.message?.content || data.response || '';
        } catch (error) {
            clearTimeout(timeout);
            this._recordOutcome(false);
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
                `Tu es le Copilote IA de bord. Expertise: météo marine, marées et courants, réglage de voiles selon les polaires, COLREG, sécurité, navigation côtière et hauturière. ` +
                `Mode actuel: ${mode}. ` +
                `MÉTHODE: avant de conseiller, tu CROISES systématiquement toutes les données disponibles — vent (force et direction), état de la mer, marée (sens, coefficient, prochaine étale), profondeur sous quille, trafic AIS (CPA/TCPA), cap, vitesse, position et destination, mode de navigation et polaires du bateau. ` +
                `Un bon conseil relie les paramètres entre eux (ex: vent contre courant qui se lève, haut-fond à marée descendante, cible AIS qui se rapproche au près). ` +
                `RÉPONSE: précise (chiffres et manœuvre nommée), actionnable (quoi faire MAINTENANT), priorisée (le plus important d'abord). Anticipe le risque avant qu'il n'arrive. ` +
                `Si une donnée manque, ne l'invente pas, raisonne avec ce qui est disponible. ` +
                `TON: naturel et parlé, comme un skipper à la barre. Vocabulaire marin juste (ris, hale-bas, étai, génois, tourmentin, lofer, abattre, empannage, virement). ` +
                `Réponds TOUJOURS en français. Pas de markdown, pas de listes, pas de symboles; unités en toutes lettres (nœuds, mètres, milles nautiques, degrés, hectopascals).`;
        }

        return `${persona} ` +
            `You are the ship's AI Co-pilot. Expertise: marine weather, tides and currents, polar-based sail trim, COLREGs, safety, coastal and offshore navigation. ` +
            `Current mode: ${mode}. ` +
            `METHOD: before advising, you always CROSS-REFERENCE every available parameter — wind (strength and direction), sea state, tide (set, coefficient, next slack), depth under keel, AIS traffic (CPA/TCPA), heading, speed, position and destination, sailing mode and the boat's polars. ` +
            `Good advice connects the parameters (e.g. wind-against-tide building, a shoal at falling tide, an AIS target closing while beating). ` +
            `ANSWER: precise (figures and the named manoeuvre), actionable (what to do NOW), prioritised (most important first). Anticipate risk before it happens. ` +
            `If data is missing, do not invent it, reason from what is available. ` +
            `TONE: natural and spoken, like a skipper at the helm. Correct nautical vocabulary (reef, vang, forestay, genoa, storm jib, luff, bear away, gybe, tack). ` +
            `Always respond in English. No markdown, no bullet points, no symbols; spell out units (knots, meters, nautical miles, degrees, hectopascals).`;
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
    buildWeatherPrompt(weatherData, vesselData, context = {}, extra = {}) {
        const current = weatherData.current || {};
        const forecast = weatherData.forecast?.hours6;
        const cardinal = this._bearingToCardinal(current.windDirection ?? 0);
        const lang = this._lang;
        const assessment = extra.assessment || {};
        const tide = extra.tideData || null;
        const fr = lang === 'fr';

        // Build a compact, structured situational brief so the model can cross-reference
        // every available parameter, not just raw wind.
        const L = [];

        // ── Wind, sea, pressure ──
        let wind = fr
            ? `Vent ${current.windSpeed ?? '?'} nœuds du ${cardinal} (${current.windDirection ?? '?'} degrés)`
            : `Wind ${current.windSpeed ?? '?'} knots from ${cardinal} (${current.windDirection ?? '?'} degrees)`;
        if (current.gustSpeed) wind += fr ? `, rafales ${current.gustSpeed} nœuds` : `, gusts ${current.gustSpeed} knots`;
        if (assessment.beaufort?.force != null) wind += fr ? `, force ${assessment.beaufort.force}` : `, force ${assessment.beaufort.force}`;
        L.push(wind);

        if (current.waveHeight != null) {
            L.push(fr ? `Mer ${current.waveHeight} mètres${assessment.seaState ? ` (${assessment.seaState})` : ''}`
                      : `Sea ${current.waveHeight} meters${assessment.seaState ? ` (${assessment.seaState})` : ''}`);
        }
        if (current.pressure != null) {
            const trend = assessment.pressure?.trend;
            const trendTxt = trend ? (fr ? `, tendance ${trend}` : `, trend ${trend}`) : '';
            L.push(fr ? `Baromètre ${current.pressure} hectopascals${trendTxt}` : `Barometer ${current.pressure} hectopascals${trendTxt}`);
        }
        if (assessment.squallRisk && assessment.squallRisk !== 'low') {
            L.push(fr ? `Risque de grain: ${assessment.squallRisk}` : `Squall risk: ${assessment.squallRisk}`);
        }
        if (assessment.windAgainstTide?.danger) {
            L.push(fr ? `ATTENTION vent contre courant (mer creuse)` : `WARNING wind against tide (steep sea)`);
        }

        // ── Forecast ──
        if (forecast) {
            let f = fr ? `Prévision 6 heures: vent max ${forecast.windSpeedMax ?? '?'} nœuds` : `6-hour forecast: max wind ${forecast.windSpeedMax ?? '?'} knots`;
            if (forecast.waveHeightMax) f += fr ? `, mer max ${forecast.waveHeightMax} mètres` : `, max sea ${forecast.waveHeightMax} meters`;
            L.push(f);
        }

        // ── Tide ──
        if (tide?.current) {
            const t = tide.current;
            let td = fr ? `Marée` : `Tide`;
            if (t.height != null) td += fr ? ` ${t.height} mètres` : ` ${t.height} meters`;
            if (t.tendency) td += fr ? ` (${t.tendency === 'rising' ? 'montante' : 'descendante'})` : ` (${t.tendency})`;
            if (t.coefficient != null) td += fr ? `, coefficient ${t.coefficient}` : `, coefficient ${t.coefficient}`;
            const next = tide.next?.high && tide.next?.low
                ? (new Date(tide.next.high.time) < new Date(tide.next.low.time) ? tide.next.high : tide.next.low)
                : (tide.next?.high || tide.next?.low);
            if (next?.time) td += fr ? `; prochaine étale à ${this._hhmm(next.time)}` : `; next slack at ${this._hhmm(next.time)}`;
            L.push(td);
        }

        // ── Vessel + nav ──
        let v = fr ? `Navire: ${vesselData.speed ?? '?'} nœuds, cap ${vesselData.heading ?? '?'} degrés` : `Vessel: ${vesselData.speed ?? '?'} knots, heading ${vesselData.heading ?? '?'} degrees`;
        if (vesselData.depth != null) v += fr ? `, fond ${vesselData.depth} mètres sous quille` : `, depth ${vesselData.depth} meters under keel`;
        L.push(v);
        if (context.mode) L.push(fr ? `Mode: ${context.mode}` : `Mode: ${context.mode}`);
        if (context.destination?.waypoint?.name || context.destination?.name) {
            L.push(fr ? `Destination: ${context.destination.waypoint?.name || context.destination.name}` : `Destination: ${context.destination.waypoint?.name || context.destination.name}`);
        }

        // ── AIS traffic ──
        const ais = context.ais;
        if (ais && (ais.dangerCount || ais.cautionCount || ais.totalInRange)) {
            L.push(fr
                ? `Trafic AIS: ${ais.totalInRange ?? 0} cibles en portée, ${ais.dangerCount ?? 0} dangereuses, ${ais.cautionCount ?? 0} à surveiller`
                : `AIS traffic: ${ais.totalInRange ?? 0} targets in range, ${ais.dangerCount ?? 0} dangerous, ${ais.cautionCount ?? 0} to watch`);
        }

        const brief = L.join('. ');
        const ask = fr
            ? `\n\nEn croisant TOUS ces éléments (vent, mer, marée, profondeur, trafic, cap, mode), donne le conseil le plus important MAINTENANT, précis et concret, puis une phrase d'anticipation pour les prochaines heures.`
            : `\n\nCross-referencing ALL of the above (wind, sea, tide, depth, traffic, heading, mode), give the single most important advice NOW, precise and concrete, then one sentence anticipating the next few hours.`;

        return brief + ask;
    }

    /**
     * Format an ISO timestamp as HH:MM, tolerant of bad input.
     * @param {string} iso
     * @returns {string}
     */
    _hhmm(iso) {
        try {
            const d = new Date(iso);
            return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        } catch {
            return '?';
        }
    }

    /**
     * Build sail optimization prompt with trim details.
     * @param {Object} vesselData Vessel data
     * @param {number} targetHeading Target heading in degrees
     * @param {Object} windData Wind data {speed, direction}
     * @returns {string} Prompt text
     */
    buildSailPrompt(vesselData, targetHeading, windData, extra = {}) {
        const twa = this.calculateTWA(vesselData.heading, windData.direction);
        const cardinal = this._bearingToCardinal(windData.direction);
        const fr = this._lang === 'fr';
        const L = [];

        // Wind + boat state
        L.push(fr
            ? `Vent ${windData.speed} nœuds du ${cardinal}`
            : `Wind ${windData.speed} knots from ${cardinal}`);
        L.push(fr
            ? `Navire ${vesselData.speed} nœuds, cap ${vesselData.heading} degrés, angle de vent réel ${twa} degrés, cap visé ${targetHeading} degrés`
            : `Boat ${vesselData.speed} knots, heading ${vesselData.heading} degrees, true wind angle ${twa} degrees, target heading ${targetHeading} degrees`);
        if (vesselData.heeling) L.push(fr ? `Gîte ${Math.round(vesselData.heeling)} degrés` : `Heel ${Math.round(vesselData.heeling)} degrees`);

        // Polar performance (so advice is grounded in the boat's actual potential)
        if (extra.pointOfSail) L.push(fr ? `Allure: ${extra.pointOfSail}` : `Point of sail: ${extra.pointOfSail}`);
        if (extra.polarSpeed != null && extra.efficiency != null) {
            L.push(fr
                ? `Vitesse cible polaire ${extra.polarSpeed} nœuds, efficacité actuelle ${Math.round(extra.efficiency * 100)} pour cent`
                : `Polar target speed ${extra.polarSpeed} knots, current efficiency ${Math.round(extra.efficiency * 100)} percent`);
        }
        if (extra.recommendation) L.push(fr ? `Piste envisagée: ${extra.recommendation}` : `Option being considered: ${extra.recommendation}`);

        // Environmental cross-references
        if (vesselData.depth != null) L.push(fr ? `Fond ${vesselData.depth} mètres sous quille` : `Depth ${vesselData.depth} meters under keel`);
        if (extra.tide?.tendency) {
            L.push(fr ? `Marée ${extra.tide.tendency === 'rising' ? 'montante' : 'descendante'}${extra.tide.coefficient ? `, coefficient ${extra.tide.coefficient}` : ''}`
                      : `Tide ${extra.tide.tendency}${extra.tide.coefficient ? `, coefficient ${extra.tide.coefficient}` : ''}`);
        }
        if (extra.mode) L.push(fr ? `Mode: ${extra.mode}` : `Mode: ${extra.mode}`);
        if (extra.ais && (extra.ais.dangerCount || extra.ais.cautionCount)) {
            L.push(fr ? `Trafic AIS: ${extra.ais.dangerCount || 0} dangereuses, ${extra.ais.cautionCount || 0} à surveiller`
                      : `AIS traffic: ${extra.ais.dangerCount || 0} dangerous, ${extra.ais.cautionCount || 0} to watch`);
        }

        const ask = fr
            ? `. En tenant compte des polaires, de la marée, du fond et du trafic, recommande le plan de voilure et les réglages de trim concrets, puis une précaution de sécurité si nécessaire.`
            : `. Considering the polars, tide, depth and traffic, recommend the sail plan and concrete trim adjustments, then one safety precaution if needed.`;

        return L.join('. ') + ask;
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
    async analyzeWeather(weatherData, vesselData, context = {}, extra = {}) {
        try {
            const prompt = this.buildWeatherPrompt(weatherData, vesselData, context, extra);
            const result = await this.generateDualOutput(prompt, { temperature: 0.6 });
            return result;
        } catch (error) {
            this.app.error('Failed to analyze weather with LLM:', error);
            const fallback = this.getFallbackWeatherMessage(weatherData);
            return { speech: fallback, text: fallback };
        }
    }

    /**
     * Build a holistic situation-briefing prompt from a unified situation object.
     * Used for the startup briefing and on-demand "where do we stand" requests.
     * @param {object} situation  see OrchestratorBrain.buildSituation()
     * @returns {string}
     */
    buildBriefingPrompt(situation = {}) {
        const fr = this._lang === 'fr';
        const s = situation;
        const L = [];

        if (s.mode) L.push(`Mode: ${s.mode}`);

        if (s.vessel) {
            const v = s.vessel;
            let line = fr ? `Bateau ${v.speed ?? '?'} nœuds, cap ${v.heading ?? '?'} degrés`
                          : `Boat ${v.speed ?? '?'} knots, heading ${v.heading ?? '?'} degrees`;
            if (v.depth != null) line += fr ? `, fond ${v.depth} mètres sous quille` : `, depth ${v.depth} meters under keel`;
            L.push(line);
        }

        if (s.wind?.speed != null) {
            let w = fr ? `Vent ${s.wind.speed} nœuds` : `Wind ${s.wind.speed} knots`;
            if (s.wind.cardinal) w += fr ? ` du ${s.wind.cardinal}` : ` from ${s.wind.cardinal}`;
            if (s.wind.gust) w += fr ? `, rafales ${s.wind.gust} nœuds` : `, gusts ${s.wind.gust} knots`;
            L.push(w);
        }

        if (s.weather) {
            const wx = s.weather;
            if (wx.beaufortForce != null) L.push(fr ? `Force ${wx.beaufortForce}` : `Force ${wx.beaufortForce}`);
            if (wx.waveHeight != null) L.push(fr ? `Mer ${wx.waveHeight} mètres${wx.seaState ? ` (${wx.seaState})` : ''}` : `Sea ${wx.waveHeight} meters${wx.seaState ? ` (${wx.seaState})` : ''}`);
            if (wx.pressure != null) L.push(fr ? `Baromètre ${wx.pressure} hectopascals${wx.pressureTrend ? `, ${wx.pressureTrend}` : ''}` : `Barometer ${wx.pressure} hectopascals${wx.pressureTrend ? `, ${wx.pressureTrend}` : ''}`);
            if (wx.squallRisk && wx.squallRisk !== 'low') L.push(fr ? `Risque de grain ${wx.squallRisk}` : `Squall risk ${wx.squallRisk}`);
            if (wx.windAgainstTide) L.push(fr ? `Vent contre courant` : `Wind against tide`);
            if (wx.forecast6h?.windMax != null) L.push(fr ? `Prévision 6 heures: vent max ${wx.forecast6h.windMax} nœuds` : `6-hour forecast: max wind ${wx.forecast6h.windMax} knots`);
        }

        if (s.tide) {
            let t = fr ? `Marée` : `Tide`;
            if (s.tide.height != null) t += fr ? ` ${s.tide.height} mètres` : ` ${s.tide.height} meters`;
            if (s.tide.tendency) t += fr ? ` ${s.tide.tendency === 'rising' ? 'montante' : 'descendante'}` : ` ${s.tide.tendency}`;
            if (s.tide.coefficient != null) t += fr ? `, coefficient ${s.tide.coefficient}` : `, coefficient ${s.tide.coefficient}`;
            L.push(t);
        }

        if (s.destination?.name) {
            let d = fr ? `Destination ${s.destination.name}` : `Destination ${s.destination.name}`;
            if (s.destination.distanceNM != null) d += fr ? ` à ${s.destination.distanceNM} milles nautiques` : ` at ${s.destination.distanceNM} nautical miles`;
            if (s.destination.bearing != null) d += fr ? `, cap ${s.destination.bearing} degrés` : `, bearing ${s.destination.bearing} degrees`;
            if (s.destination.etaHours != null) d += fr ? `, ETA ${s.destination.etaHours} heures` : `, ETA ${s.destination.etaHours} hours`;
            L.push(d);
        }

        if (s.ais && (s.ais.dangerCount || s.ais.cautionCount || s.ais.totalInRange)) {
            let a = fr ? `Trafic AIS ${s.ais.totalInRange ?? 0} cibles, ${s.ais.dangerCount ?? 0} dangereuses`
                       : `AIS ${s.ais.totalInRange ?? 0} targets, ${s.ais.dangerCount ?? 0} dangerous`;
            if (s.ais.nearest?.name) {
                a += fr ? `; la plus proche ${s.ais.nearest.name} CPA ${s.ais.nearest.cpa} milles nautiques dans ${s.ais.nearest.tcpa} minutes`
                        : `; nearest ${s.ais.nearest.name} CPA ${s.ais.nearest.cpa} nautical miles in ${s.ais.nearest.tcpa} minutes`;
            }
            L.push(a);
        }

        const brief = L.length ? L.join('. ') : (fr ? 'Données limitées disponibles.' : 'Limited data available.');
        const ask = fr
            ? `\n\nFais un point de situation de skipper: synthétise l'état actuel, le risque principal à surveiller dans les prochaines heures, et le conseil prioritaire. Croise les paramètres entre eux. Reste concret et naturel.`
            : `\n\nGive a skipper's situation report: synthesise the current state, the main risk to watch over the next few hours, and the priority advice. Connect the parameters. Keep it concrete and natural.`;

        return brief + ask;
    }

    /**
     * Generate a holistic situation briefing (dual voice/text output).
     * @param {object} situation
     * @returns {{speech:string, text:string}}
     */
    async generateBriefing(situation) {
        try {
            const prompt = this.buildBriefingPrompt(situation);
            return await this.generateDualOutput(prompt, { temperature: 0.6 });
        } catch (error) {
            this.app.debug('LLM briefing failed:', error.message);
            return null;
        }
    }

    /**
     * Get sail recommendations
     */
    async getSailRecommendations(vesselData, targetHeading, windData, extra = {}) {
        try {
            const prompt = this.buildSailPrompt(vesselData, targetHeading, windData, extra);
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
