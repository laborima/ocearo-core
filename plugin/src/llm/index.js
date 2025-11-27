/*
 * LLM integration module
 * Handles communication with Ollama for natural language processing
 */

const { i18n, textUtils } = require('../common');

class LLMModule {
    constructor(app, config) {
        this.app = app;
        this.config = config;
        this.baseUrl = config.llm?.ollamaHost || 'http://localhost:11434';
        this.model = config.llm?.model || 'phi3:mini';
        this.timeout = (config.llm?.timeoutSeconds || 30) * 1000;
        this._connected = false;
        this._lastConnectionCheck = 0;
        this._connectionCheckInterval = 60000; // Check every 60 seconds
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
     * Generate completion from prompt
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
            const response = await fetch(`${this.baseUrl}/api/generate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.model,
                    prompt,
                    stream: false,
                    options: {
                        temperature: options.temperature || 0.7,
                        top_p: options.top_p || 0.9,
                        max_tokens: options.max_tokens || 150
                    }
                }),
                signal: controller.signal
            });

            clearTimeout(timeout);

            if (!response.ok) {
                throw new Error(`Ollama error: ${response.status}`);
            }

            const data = await response.json();
            return data.response;
        } catch (error) {
            clearTimeout(timeout);
            if (!error.message.includes('LLM service not available')) {
                this.app.debug('LLM generation failed (expected when Ollama is down):', error.message);
            }
            throw error;
        }
    }

    /**
     * Build alert analysis prompt
     */
    buildAlertPrompt(alert, vesselData, context) {
        const lang = this.config.language || 'en';
        const personality = this.config.personality || 'professional';

        const status = this.summarizeVesselStatus(vesselData);

        const contextInfo = context.profile ?
            `Vessel: ${context.profile}, Destination: ${context.destination || 'Not set'}` :
            'No vessel context';

        const prompt = `You are Jarvis, a marine navigation assistant with a ${personality} personality.
Current language: ${lang === 'fr' ? 'French' : 'English'}

Alert: ${alert.message}
Severity: ${alert.severity}
Value: ${alert.value}

Vessel Status:
${status}

Context: ${contextInfo}

Analyze this alert and provide:
1. A brief explanation of what happened (1-2 sentences)
2. The potential impact on navigation or safety
3. One recommended action

Keep response concise and in ${lang === 'fr' ? 'French' : 'English'}.
Format for text-to-speech output.`;

        return prompt;
    }

    /**
     * Build weather analysis prompt
     */
    buildWeatherPrompt(weatherData, vesselData) {
        const lang = this.config.language || 'en';
        const personality = this.config.personality || 'professional';

        const prompt = `You are Jarvis, a marine weather analyst with a ${personality} personality.
Current language: ${lang === 'fr' ? 'French' : 'English'}

Current Weather:
- Wind: ${weatherData.current.windSpeed} knots from ${weatherData.current.windDirection}°
- Waves: ${weatherData.current.waveHeight}m, period ${weatherData.current.wavePeriod}s
- Swell: ${weatherData.current.swellHeight}m from ${weatherData.current.swellDirection}°

Forecast (next 6h):
- Max wind: ${weatherData.forecast.hours6.windSpeedMax} knots
- Max waves: ${weatherData.forecast.hours6.waveHeightMax}m

Vessel: ${vesselData.speed} knots, heading ${vesselData.heading}°

Provide a brief weather analysis (2-3 sentences) focusing on:
1. Current conditions suitability for sailing
2. Any concerning trends
3. One recommendation

Keep response concise and in ${lang === 'fr' ? 'French' : 'English'}.
Format for text-to-speech output.`;

        return prompt;
    }

    /**
     * Build sail optimization prompt
     */
    buildSailPrompt(vesselData, targetHeading, windData) {
        const lang = this.config.language || 'en';
        const twa = this.calculateTWA(vesselData.heading, windData.direction);

        const prompt = `You are Jarvis, a sailing coach assistant.
Current language: ${lang === 'fr' ? 'French' : 'English'}

Current Conditions:
- True Wind: ${windData.speed} knots from ${windData.direction}°
- Boat Speed: ${vesselData.speed} knots
- Heading: ${vesselData.heading}°
- TWA: ${twa}°
- Target Heading: ${targetHeading}°

Based on the true wind angle and speed, recommend:
1. Optimal sail configuration
2. Any trim adjustments needed
3. Expected boat speed potential

Keep response brief (2-3 sentences) and practical.
Format for text-to-speech output.`;

        return prompt;
    }

    /**
     * Process alert with LLM
     */
    async processAlert(alert, vesselData, context) {
        try {
            const prompt = this.buildAlertPrompt(alert, vesselData, context);
            const response = await this.generateCompletion(prompt, {
                temperature: 0.6,
                max_tokens: 150
            });

            return textUtils.formatTextForTTS(response);
        } catch (error) {
            this.app.error('Failed to process alert with LLM:', error);
            return this.getFallbackAlertMessage(alert);
        }
    }

    /**
     * Analyze weather conditions
     */
    async analyzeWeather(weatherData, vesselData, context) {
        try {
            const prompt = this.buildWeatherPrompt(weatherData, vesselData);
            const response = await this.generateCompletion(prompt, {
                temperature: 0.7,
                max_tokens: 200
            });

            return textUtils.formatTextForTTS(response);
        } catch (error) {
            this.app.error('Failed to analyze weather with LLM:', error);
            return this.getFallbackWeatherMessage(weatherData);
        }
    }

    /**
     * Get sail recommendations
     */
    async getSailRecommendations(vesselData, targetHeading, windData) {
        try {
            const prompt = this.buildSailPrompt(vesselData, targetHeading, windData);
            const response = await this.generateCompletion(prompt, {
                temperature: 0.5,
                max_tokens: 150
            });

            return textUtils.formatTextForTTS(response);
        } catch (error) {
            this.app.error('Failed to get sail recommendations:', error);
            return this.getFallbackSailMessage(vesselData, windData);
        }
    }

    /**
     * Summarize vessel status for prompts
     */
    summarizeVesselStatus(vesselData) {
        const parts = [];

        if (vesselData.speed !== undefined) {
            parts.push(`Speed: ${vesselData.speed} knots`);
        }
        if (vesselData.heading !== undefined) {
            parts.push(`Heading: ${vesselData.heading}°`);
        }
        if (vesselData.depth !== undefined) {
            parts.push(`Depth: ${vesselData.depth}m`);
        }
        if (vesselData.wind?.speed !== undefined) {
            parts.push(`Wind: ${vesselData.wind.speed} knots`);
        }

        return parts.join(', ') || 'Limited vessel data available';
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
        const lang = this.config.language || 'en';

        return textUtils.formatTextForTTS(
            i18n.localize(lang, 'alert_generic', {
                message: alert.message,
                value: alert.value
            })
        );
    }

    /**
     * Fallback weather message
     */
    getFallbackWeatherMessage(weatherData) {
        const lang = this.config.language || 'en';

        return textUtils.formatTextForTTS(
            i18n.localize(lang, 'weather_current', {
                windSpeed: weatherData.current.windSpeed,
                windDir: weatherData.current.windDirection,
                waveHeight: weatherData.current.waveHeight
            })
        );
    }

    /**
     * Fallback sail message
     */
    getFallbackSailMessage(vesselData, windData) {
        const twa = this.calculateTWA(vesselData.heading, windData.direction);

        let sailConfig = 'main and jib';
        if (twa > 120) sailConfig = 'main and spinnaker';
        if (twa < 45) sailConfig = 'main only, close hauled';

        return textUtils.formatTextForTTS(
            `Current true wind angle: ${twa} degrees. Suggested sail configuration: ${sailConfig}.`
        );
    }
}

module.exports = LLMModule;
