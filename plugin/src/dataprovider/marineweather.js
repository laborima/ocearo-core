/*
 * Marine weather data provider
 * Stub implementation for weather API integration
 */



class MarineWeatherDataProvider {
    constructor(app, config) {
        this.app = app;
        this.config = config;
        this.cache = null;
        this.cacheTimestamp = null;
        this.cacheDuration = (config.weatherProvider?.cacheMinutes || 30) * 60 * 1000;
        this.requestTimeout = (config.weatherProvider?.timeoutSeconds || 15) * 1000;
    }

    /**
     * Start the provider
     */
    start() {
        this.app.debug('Starting marine weather data provider');
    }

    /**
     * Stop the provider
     */
    stop() {
        this.app.debug('Stopping marine weather data provider');
        this.cache = null;
        this.cacheTimestamp = null;
    }

    /**
     * Get weather data
     */
    async getWeatherData(position) {
        // Check cache
        if (this.cache && this.cacheTimestamp && 
            (Date.now() - this.cacheTimestamp < this.cacheDuration)) {
            this.app.debug('Returning cached weather data');
            return this.cache;
        }

        const provider = this.config.weatherProvider?.provider || 'openmeteo';
        
        if (provider === 'none') {
            return this.getMockWeatherData();
        }

        try {
            let data;
            switch (provider) {
                case 'openmeteo':
                    data = await this.fetchOpenMeteoData(position);
                    break;
                case 'noaa':
                    data = await this.fetchNOAAData(position);
                    break;
                default:
                    data = await this.getMockWeatherData();
            }

            // Update cache
            this.cache = data;
            this.cacheTimestamp = Date.now();
            
            return data;
        } catch (error) {
            this.app.error('Failed to fetch weather data:', error);
            return this.getMockWeatherData();
        }
    }

    /**
     * Fetch weather data from Open-Meteo API
     */
    async fetchOpenMeteoData(position) {
        if (!position || !position.latitude || !position.longitude) {
            this.app.debug('No vessel position available, using mock weather data');
            return this.getMockWeatherData();
        }

        const url = `https://marine-api.open-meteo.com/v1/marine?` +
            `latitude=${position.latitude}&longitude=${position.longitude}&` +
            `hourly=wave_height,wave_direction,wave_period,wind_wave_height,swell_wave_height,` +
            `swell_wave_direction,swell_wave_period,wind_speed_10m,wind_direction_10m&` +
            `forecast_days=2&timezone=auto`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.requestTimeout);

        try {
            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);
            
            if (!response.ok) {
                throw new Error(`Weather API error: ${response.status}`);
            }

            const data = await response.json();
            return this.transformOpenMeteoData(data);
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                throw new Error(`Weather API timeout after ${this.requestTimeout}ms`);
            }
            throw error;
        }
    }

    /**
     * Transform Open-Meteo data to internal format
     */
    transformOpenMeteoData(data) {
        const currentHour = new Date().getHours();
        const hourly = data.hourly;
        
        return {
            current: {
                waveHeight: hourly.wave_height[currentHour],
                waveDirection: hourly.wave_direction[currentHour],
                wavePeriod: hourly.wave_period[currentHour],
                swellHeight: hourly.swell_wave_height[currentHour],
                swellDirection: hourly.swell_wave_direction[currentHour],
                swellPeriod: hourly.swell_wave_period[currentHour],
                windSpeed: hourly.wind_speed_10m[currentHour],
                windDirection: hourly.wind_direction_10m[currentHour]
            },
            forecast: {
                hours6: this.extractForecastPeriod(hourly, currentHour, 6),
                hours12: this.extractForecastPeriod(hourly, currentHour, 12),
                hours24: this.extractForecastPeriod(hourly, currentHour, 24)
            }
        };
    }

    /**
     * Extract forecast for specific period
     */
    extractForecastPeriod(hourly, startHour, hours) {
        const endHour = Math.min(startHour + hours, hourly.wave_height.length);
        const slice = (arr) => arr.slice(startHour, endHour);
        
        return {
            waveHeightMax: Math.max(...slice(hourly.wave_height)),
            waveHeightMin: Math.min(...slice(hourly.wave_height)),
            windSpeedMax: Math.max(...slice(hourly.wind_speed_10m)),
            windSpeedMin: Math.min(...slice(hourly.wind_speed_10m)),
            swellHeightMax: Math.max(...slice(hourly.swell_wave_height))
        };
    }

    /**
     * Fetch weather data from NOAA (stub)
     */
    async fetchNOAAData() {
        // Stub implementation - would need NOAA API credentials
        this.app.debug('NOAA weather provider not implemented, using mock data');
        return this.getMockWeatherData();
    }

    /**
     * Get mock weather data for testing/offline mode
     */
    getMockWeatherData() {
        return {
            current: {
                waveHeight: 1.5,
                waveDirection: 270,
                wavePeriod: 8,
                swellHeight: 1.2,
                swellDirection: 280,
                swellPeriod: 10,
                windSpeed: 12,
                windDirection: 260
            },
            forecast: {
                hours6: {
                    waveHeightMax: 2.0,
                    waveHeightMin: 1.2,
                    windSpeedMax: 15,
                    windSpeedMin: 10,
                    swellHeightMax: 1.5
                },
                hours12: {
                    waveHeightMax: 2.5,
                    waveHeightMin: 1.0,
                    windSpeedMax: 18,
                    windSpeedMin: 8,
                    swellHeightMax: 2.0
                },
                hours24: {
                    waveHeightMax: 3.0,
                    waveHeightMin: 0.8,
                    windSpeedMax: 20,
                    windSpeedMin: 5,
                    swellHeightMax: 2.5
                }
            }
        };
    }
}

module.exports = MarineWeatherDataProvider;
