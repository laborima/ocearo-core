/**
 * Marine Weather Data Provider
 *
 * Two-layer weather data strategy:
 * 1. Current observations from SignalK sensor paths (environment.*)
 * 2. Forecasts from SignalK Weather API v2 (/signalk/v2/api/weather)
 *    served by @signalk/open-meteo-provider or similar plugin
 *
 * All values exposed in knots / degrees / celsius / hPa for internal use.
 */

const MS_TO_KNOTS = 1.94384;
const RAD_TO_DEG = 180 / Math.PI;
const KELVIN_OFFSET = 273.15;
const PA_TO_HPA = 0.01;

class MarineWeatherDataProvider {
    constructor(app, config) {
        this.app = app;
        this.config = config;

        this.requestTimeout = (config.weatherProvider?.timeoutSeconds || 15) * 1000;
        this._serverUrl = null;
    }

    /**
     * Start the provider.
     */
    start() {
        this._serverUrl = this._detectServerUrl();
        this.app.debug(`Marine weather provider started (server: ${this._serverUrl})`);
    }

    /**
     * Stop the provider.
     */
    stop() {
        this.app.debug('Marine weather provider stopped');
    }

    /**
     * Get weather data with caching.
     * Merges live sensor readings with forecast data from the Weather API.
     * @param {Object} position Vessel position {latitude, longitude}
     * @returns {Object} Weather data in internal format
     */
    async getWeatherData(position) {
        try {
            const current = this._readSensorData();
            const forecast = await this._fetchForecast(position);

            const data = {
                current: this._mergeCurrent(current, forecast),
                forecast: this._buildForecastPeriods(forecast),
                source: current._hasSensors ? 'sensors+forecast' : 'forecast',
                timestamp: new Date().toISOString()
            };

            return data;
        } catch (error) {
            this.app.error('Failed to fetch weather data:', error.message);
            return this._fallbackData();
        }
    }

    /**
     * Read current observations from SignalK sensor paths.
     * @returns {Object} Sensor values in display units
     */
    _readSensorData() {
        const windSpeed = this._getSelfPath('environment.wind.speedTrue');
        const windDirection = this._getSelfPath('environment.wind.directionTrue');
        const windGust = this._getSelfPath('environment.wind.gust');
        const temperature = this._getSelfPath('environment.outside.temperature');
        const pressure = this._getSelfPath('environment.outside.pressure');
        const humidity = this._getSelfPath('environment.outside.relativeHumidity');

        const hasSensors = windSpeed !== null || temperature !== null || pressure !== null;

        return {
            windSpeed: windSpeed !== null ? windSpeed * MS_TO_KNOTS : null,
            windDirection: windDirection !== null ? windDirection * RAD_TO_DEG : null,
            windGust: windGust !== null ? windGust * MS_TO_KNOTS : null,
            temperature: temperature !== null ? temperature - KELVIN_OFFSET : null,
            pressure: pressure !== null ? pressure * PA_TO_HPA : null,
            humidity: humidity !== null ? humidity * 100 : null,
            _hasSensors: hasSensors
        };
    }

    /**
     * Fetch hourly forecast from SignalK Weather API v2.
     * Endpoint served by @signalk/open-meteo-provider plugin.
     * @param {Object} position Vessel position
     * @returns {Array|null} Array of hourly forecast objects
     */
    async _fetchForecast(position) {
        if (!position?.latitude || !position?.longitude) {
            this.app.debug('No position available for weather forecast');
            return null;
        }

        if (!this._serverUrl) {
            this._serverUrl = this._detectServerUrl();
        }

        const url = `${this._serverUrl}/signalk/v2/api/weather/forecasts/point` +
            `?lat=${position.latitude}&lon=${position.longitude}&count=48`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.requestTimeout);

        try {
            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);

            if (!response.ok) {
                if (response.status === 400 || response.status === 404) {
                    this.app.debug('Weather API not available on this server');
                    return null;
                }
                throw new Error(`Weather API HTTP ${response.status}`);
            }

            const raw = await response.json();
            return this._parseForecastResponse(raw);
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                this.app.debug('Weather API request timed out');
            } else {
                this.app.debug('Weather API fetch failed:', error.message);
            }
            return null;
        }
    }

    /**
     * Parse the SignalK Weather API v2 response into hourly entries.
     * Response format matches @signalk/open-meteo-provider output.
     * @param {Object} raw Raw API response
     * @returns {Array} Parsed hourly entries
     */
    _parseForecastResponse(raw) {
        const entries = [];

        for (const v of Object.values(raw)) {
            const entry = {
                date: v.date || null,
                windSpeed: null,
                windDirection: null,
                windGust: null,
                waveHeight: null,
                temperature: null,
                pressure: null,
                humidity: null,
                clouds: null,
                description: v.description || null
            };

            if (v.wind) {
                if (v.wind.speedTrue !== undefined) {
                    entry.windSpeed = v.wind.speedTrue * MS_TO_KNOTS;
                }
                if (v.wind.directionTrue !== undefined) {
                    entry.windDirection = v.wind.directionTrue * RAD_TO_DEG;
                }
                if (v.wind.gust !== undefined) {
                    entry.windGust = v.wind.gust * MS_TO_KNOTS;
                }
            }

            if (v.outside) {
                if (v.outside.temperature !== undefined) {
                    entry.temperature = v.outside.temperature - KELVIN_OFFSET;
                }
                if (v.outside.pressure !== undefined) {
                    entry.pressure = v.outside.pressure * PA_TO_HPA;
                }
                if (v.outside.relativeHumidity !== undefined) {
                    entry.humidity = v.outside.relativeHumidity * 100;
                }
                if (v.outside.cloudCover !== undefined) {
                    entry.clouds = v.outside.cloudCover;
                } else if (v.outside.clouds !== undefined) {
                    entry.clouds = v.outside.clouds;
                }
            }

            if (v.water?.waves?.significantHeight !== undefined) {
                entry.waveHeight = v.water.waves.significantHeight;
            }

            entries.push(entry);
        }

        return entries;
    }

    /**
     * Merge sensor data with first forecast entry for current conditions.
     * Sensor values take priority over forecast values.
     * @param {Object} sensors Sensor readings
     * @param {Array|null} forecast Hourly forecast entries
     * @returns {Object} Merged current conditions
     */
    _mergeCurrent(sensors, forecast) {
        const fc = (forecast && forecast.length > 0) ? forecast[0] : {};

        return {
            windSpeed: sensors.windSpeed ?? fc.windSpeed ?? null,
            windDirection: sensors.windDirection ?? fc.windDirection ?? null,
            windGust: sensors.windGust ?? fc.windGust ?? null,
            temperature: sensors.temperature ?? fc.temperature ?? null,
            pressure: sensors.pressure ?? fc.pressure ?? null,
            humidity: sensors.humidity ?? fc.humidity ?? null,
            waveHeight: fc.waveHeight ?? null,
            waveDirection: null,
            wavePeriod: null,
            swellHeight: null,
            swellDirection: null,
            swellPeriod: null,
            description: fc.description ?? null
        };
    }

    /**
     * Build forecast period summaries (6h, 12h, 24h) from hourly data.
     * @param {Array|null} forecast Hourly entries
     * @returns {Object} Forecast periods with min/max values
     */
    _buildForecastPeriods(forecast) {
        if (!forecast || forecast.length === 0) {
            return { hours6: null, hours12: null, hours24: null };
        }

        return {
            hours6: this._summarisePeriod(forecast, 0, 6),
            hours12: this._summarisePeriod(forecast, 0, 12),
            hours24: this._summarisePeriod(forecast, 0, 24)
        };
    }

    /**
     * Summarise a forecast period by extracting min/max values.
     * @param {Array} entries All hourly entries
     * @param {number} start  Start index
     * @param {number} count  Number of hours
     * @returns {Object} Period summary
     */
    _summarisePeriod(entries, start, count) {
        const slice = entries.slice(start, start + count);
        if (slice.length === 0) {
            return null;
        }

        const nums = (key) => slice.map(e => e[key]).filter(v => v !== null && v !== undefined);

        const windSpeeds = nums('windSpeed');
        const waveHeights = nums('waveHeight');
        const gusts = nums('windGust');

        return {
            windSpeedMax: windSpeeds.length > 0 ? Math.max(...windSpeeds) : null,
            windSpeedMin: windSpeeds.length > 0 ? Math.min(...windSpeeds) : null,
            windGustMax: gusts.length > 0 ? Math.max(...gusts) : null,
            waveHeightMax: waveHeights.length > 0 ? Math.max(...waveHeights) : null,
            waveHeightMin: waveHeights.length > 0 ? Math.min(...waveHeights) : null
        };
    }

    /**
     * Return minimal fallback data when no source is available.
     * @returns {Object} Empty weather structure
     */
    _fallbackData() {
        return {
            current: {
                windSpeed: null, windDirection: null, windGust: null,
                temperature: null, pressure: null, humidity: null,
                waveHeight: null, waveDirection: null, wavePeriod: null,
                swellHeight: null, swellDirection: null, swellPeriod: null,
                description: null
            },
            forecast: { hours6: null, hours12: null, hours24: null },
            source: 'none',
            timestamp: new Date().toISOString()
        };
    }

    /**
     * Read a value from a SignalK self path.
     * @param {string} skPath
     * @returns {number|null}
     */
    _getSelfPath(skPath) {
        if (!this.app.getSelfPath) {
            return null;
        }
        try {
            const result = this.app.getSelfPath(skPath);
            if (result && typeof result === 'object' && result.value !== undefined) {
                return result.value;
            }
            return result ?? null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Detect the local SignalK server URL for Weather API calls.
     * @returns {string}
     */
    _detectServerUrl() {
        if (this.app.config?.settings?.ssl) {
            const port = this.app.config.settings.sslport || 3443;
            return `https://127.0.0.1:${port}`;
        }
        if (this.app.config?.settings?.port) {
            return `http://127.0.0.1:${this.app.config.settings.port}`;
        }
        if (process.env.SIGNALK_SERVER_URL) {
            return process.env.SIGNALK_SERVER_URL;
        }
        return 'http://127.0.0.1:3000';
    }
}

module.exports = MarineWeatherDataProvider;
