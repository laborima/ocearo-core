/*
 * Tides data provider
 * Enhanced implementation with local JSON file support and improved tide calculations
 */

class TidesDataProvider {
    constructor(app, config) {
        this.app = app;
        this.config = config;
        this.cache = null;
        this.cacheTimestamp = null;
        this.cacheDuration = (config.tidesProvider?.cacheHours || 6) * 60 * 60 * 1000;
        this.requestTimeout = (config.tidesProvider?.timeoutSeconds || 15) * 1000;
    }

    /**
     * Start the provider
     */
    start() {
        this.app.debug('Starting tides data provider');
    }

    /**
     * Stop the provider
     */
    stop() {
        this.app.debug('Stopping tides data provider');
        this.cache = null;
        this.cacheTimestamp = null;
    }

    /**
     * Get tide data
     */
    async getTideData(position, stationId) {
        // Check cache
        if (this.cache && this.cacheTimestamp && 
            (Date.now() - this.cacheTimestamp < this.cacheDuration)) {
            this.app.debug('Returning cached tide data');
            return this.cache;
        }

        const provider = this.config.tidesProvider?.provider || 'none';
        const configuredStationId = stationId || this.config.tidesProvider?.stationId;
        
        if (provider === 'none') {
            return this.getMockTideData();
        }

        try {
            let data;
            switch (provider) {
                case 'local':
                    data = await this.fetchLocalTideData(configuredStationId);
                    break;
                case 'shom':
                    data = await this.fetchSHOMData(configuredStationId);
                    break;
                case 'noaa':
                    data = await this.fetchNOAATideData(configuredStationId);
                    break;
                default:
                    data = await this.getMockTideData();
            }

            // Update cache
            this.cache = data;
            this.cacheTimestamp = Date.now();
            
            return data;
        } catch (error) {
            this.app.error('Failed to fetch tide data:', error);
            return this.getMockTideData();
        }
    }

    /**
     * Fetch tide data from local JSON files
     */
    async fetchLocalTideData(stationId) {
        if (!stationId) {
            throw new Error('Station ID required for local tide data');
        }

        const date = new Date();
        const year = date.getFullYear();
        const month = (date.getMonth() + 1).toString().padStart(2, '0');
        const filePath = `tides/${stationId}/${month}_${year}.json`;

        this.app.debug(`Fetching local tide data from ${filePath}`);

        const response = await fetch(filePath);
        if (!response.ok) {
            throw new Error(`Failed to fetch local tide data: ${response.status}`);
        }

        const tideData = await response.json();
        return this.transformLocalTideData(tideData);
    }

    /**
     * Transform local JSON tide data to internal format
     */
    transformLocalTideData(data) {
        const now = new Date();
        const today = now.toISOString().split('T')[0];
        
        if (!data[today]) {
            throw new Error(`No tide data available for today (${today})`);
        }

        // Parse today's tide events
        const tides = data[today].map(([type, time, height, coef]) => {
            const [hours, minutes] = time.split(':').map(Number);
            const tideDate = new Date(now);
            tideDate.setHours(hours, minutes, 0, 0);
            
            return {
                time: tideDate,
                height: parseFloat(height),
                type: type === 'tide.high' ? 'high' : 'low',
                coefficient: coef || null
            };
        });

        // Sort by time
        tides.sort((a, b) => a.time - b.time);

        // Add tomorrow's tides if available
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowKey = tomorrow.toISOString().split('T')[0];
        
        if (data[tomorrowKey]) {
            const tomorrowTides = data[tomorrowKey].map(([type, time, height, coef]) => {
                const [hours, minutes] = time.split(':').map(Number);
                const tideDate = new Date(tomorrow);
                tideDate.setHours(hours, minutes, 0, 0);
                
                return {
                    time: tideDate,
                    height: parseFloat(height),
                    type: type === 'tide.high' ? 'high' : 'low',
                    coefficient: coef || null
                };
            });
            
            tides.push(...tomorrowTides);
        }

        // Find next and previous tides
        const futureTides = tides.filter(t => t.time > now);
        const pastTides = tides.filter(t => t.time <= now);
        
        const nextHigh = futureTides.find(t => t.type === 'high');
        const nextLow = futureTides.find(t => t.type === 'low');
        const prevHigh = pastTides.reverse().find(t => t.type === 'high');
        const prevLow = pastTides.reverse().find(t => t.type === 'low');

        return {
            current: this.estimateCurrentHeight(tides, now),
            next: {
                high: nextHigh,
                low: nextLow
            },
            previous: {
                high: prevHigh,
                low: prevLow
            },
            forecast: futureTides.slice(0, 8), // Next 8 tide events
            coefficient: this.getCurrentCoefficient(tides, now)
        };
    }

    /**
     * Get current tide coefficient
     */
    getCurrentCoefficient(tides, currentTime) {
        // Find the nearest high tide (which carries the coefficient)
        const highTides = tides.filter(t => t.type === 'high' && t.coefficient);
        if (highTides.length === 0) return null;

        // Find the closest high tide to current time
        let closestHighTide = highTides[0];
        let minDiff = Math.abs(currentTime - closestHighTide.time);

        for (const tide of highTides) {
            const diff = Math.abs(currentTime - tide.time);
            if (diff < minDiff) {
                minDiff = diff;
                closestHighTide = tide;
            }
        }

        return closestHighTide.coefficient;
    }

    /**
     * Fetch tide data from SHOM (stub)
     */
    async fetchSHOMData() {
        // Stub implementation - SHOM requires API key
        this.app.debug('SHOM tide provider not implemented, using mock data');
        return this.getMockTideData();
    }

    /**
     * Fetch tide data from NOAA
     */
    async fetchNOAATideData(stationId) {
        if (!stationId) {
            throw new Error('Station ID required for NOAA tide data');
        }

        const startDate = new Date();
        const endDate = new Date(startDate.getTime() + 48 * 60 * 60 * 1000); // 48 hours

        const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?` +
            `product=predictions&application=ocearo-core&` +
            `begin_date=${this.formatDate(startDate)}&` +
            `end_date=${this.formatDate(endDate)}&` +
            `datum=MLLW&station=${stationId}&` +
            `time_zone=lst_ldt&units=metric&interval=hilo&format=json`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.requestTimeout);

        try {
            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);
            
            if (!response.ok) {
                throw new Error(`NOAA API error: ${response.status}`);
            }

            const data = await response.json();
            return this.transformNOAAData(data);
        } catch (error) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                throw new Error(`NOAA API timeout after ${this.requestTimeout}ms`);
            }
            throw error;
        }
    }

    /**
     * Transform NOAA data to internal format
     */
    transformNOAAData(data) {
        if (!data.predictions || !Array.isArray(data.predictions)) {
            throw new Error('Invalid NOAA tide data format');
        }

        const now = new Date();
        const tides = data.predictions.map(pred => ({
            time: new Date(pred.t),
            height: parseFloat(pred.v),
            type: pred.type === 'H' ? 'high' : 'low'
        }));

        // Find next and previous tides
        const futureTides = tides.filter(t => t.time > now);
        const pastTides = tides.filter(t => t.time <= now);
        
        const nextHigh = futureTides.find(t => t.type === 'high');
        const nextLow = futureTides.find(t => t.type === 'low');
        const prevHigh = pastTides.reverse().find(t => t.type === 'high');
        const prevLow = pastTides.find(t => t.type === 'low');

        return {
            current: this.estimateCurrentHeight(tides, now),
            next: {
                high: nextHigh,
                low: nextLow
            },
            previous: {
                high: prevHigh,
                low: prevLow
            },
            forecast: futureTides.slice(0, 8) // Next 8 tide events
        };
    }

    /**
     * Enhanced tide height estimation using the Rule of Twelfths
     * More accurate than simple linear interpolation
     */
    estimateCurrentHeight(tides, currentTime) {
        // Find surrounding tide events
        let prevTide = null;
        let nextTide = null;

        for (let i = 0; i < tides.length - 1; i++) {
            if (tides[i].time <= currentTime && tides[i + 1].time > currentTime) {
                prevTide = tides[i];
                nextTide = tides[i + 1];
                break;
            }
        }

        if (!prevTide || !nextTide) {
            this.app.debug('Cannot estimate current height: insufficient tide data');
            return null;
        }

        const height = this.calculateTideHeightUsingTwelfths(
            prevTide.type === 'high' ? prevTide.height : nextTide.height,
            prevTide.type === 'low' ? prevTide.height : nextTide.height,
            currentTime,
            prevTide.type === 'high' ? prevTide.time : nextTide.time,
            prevTide.type === 'low' ? prevTide.time : nextTide.time
        );

        // Calculate rate of change
        const totalTime = nextTide.time - prevTide.time;
        const rate = Math.abs(nextTide.height - prevTide.height) / (totalTime / 3600000); // m/hr

        return {
            height,
            tendency: nextTide.height > prevTide.height ? 'rising' : 'falling',
            rate,
            method: 'rule_of_twelfths'
        };
    }

    /**
     * Calculate tide height using the Rule of Twelfths
     * More accurate tidal calculation method used by sailors
     */
    calculateTideHeightUsingTwelfths(highTideHeight, lowTideHeight, currentTime, highTideTime, lowTideTime) {
        /**
         * Convert time to minutes since midnight
         */
        const timeToMinutes = (time) => {
            if (time instanceof Date) {
                return time.getHours() * 60 + time.getMinutes();
            }
            const [hours, minutes] = time.split(':').map(Number);
            return hours * 60 + minutes;
        };

        // Convert all times to minutes
        const highTideMinutes = timeToMinutes(highTideTime);
        const lowTideMinutes = timeToMinutes(lowTideTime);
        const currentMinutes = timeToMinutes(currentTime);

        // Determine if tide is rising or falling
        let isRising = false;
        let startHeight, endHeight, startMinutes, endMinutes;

        // Handle the case where we need to determine the tide cycle
        if (Math.abs(currentMinutes - lowTideMinutes) < Math.abs(currentMinutes - highTideMinutes)) {
            // Closer to low tide
            if (highTideMinutes > lowTideMinutes) {
                // Low tide first, then high tide (rising)
                isRising = true;
                startHeight = lowTideHeight;
                endHeight = highTideHeight;
                startMinutes = lowTideMinutes;
                endMinutes = highTideMinutes;
            } else {
                // High tide first, then low tide (falling)
                isRising = false;
                startHeight = highTideHeight;
                endHeight = lowTideHeight;
                startMinutes = highTideMinutes;
                endMinutes = lowTideMinutes + 1440; // Add a day
            }
        } else {
            // Closer to high tide
            if (lowTideMinutes > highTideMinutes) {
                // High tide first, then low tide (falling)
                isRising = false;
                startHeight = highTideHeight;
                endHeight = lowTideHeight;
                startMinutes = highTideMinutes;
                endMinutes = lowTideMinutes;
            } else {
                // Low tide first, then high tide (rising)
                isRising = true;
                startHeight = lowTideHeight;
                endHeight = highTideHeight;
                startMinutes = lowTideMinutes;
                endMinutes = highTideMinutes + 1440; // Add a day
            }
        }

        // Calculate cycle duration and progress
        const tideCycleDuration = Math.abs(endMinutes - startMinutes);
        const tideChange = Math.abs(endHeight - startHeight);
        
        let elapsedTime = currentMinutes - startMinutes;
        if (elapsedTime < 0) elapsedTime += 1440; // Handle day wraparound

        // Ensure we're within the tide cycle
        if (elapsedTime > tideCycleDuration) {
            elapsedTime = tideCycleDuration;
        }

        // Apply Rule of Twelfths
        const twelfth = tideChange / 12;
        const cycleProgress = elapsedTime / tideCycleDuration;
        let heightChange = 0;

        // Rule of Twelfths distribution: 1,2,3,3,2,1 twelfths per hour over 6 hours
        if (cycleProgress <= 1/6) {
            // First hour: 1/12
            heightChange = twelfth * (cycleProgress * 6);
        } else if (cycleProgress <= 2/6) {
            // Second hour: 2/12 (total 3/12)
            heightChange = twelfth * (1 + (cycleProgress - 1/6) * 12);
        } else if (cycleProgress <= 3/6) {
            // Third hour: 3/12 (total 6/12)
            heightChange = twelfth * (3 + (cycleProgress - 2/6) * 18);
        } else if (cycleProgress <= 4/6) {
            // Fourth hour: 3/12 (total 9/12)
            heightChange = twelfth * (6 + (cycleProgress - 3/6) * 18);
        } else if (cycleProgress <= 5/6) {
            // Fifth hour: 2/12 (total 11/12)
            heightChange = twelfth * (9 + (cycleProgress - 4/6) * 12);
        } else {
            // Sixth hour: 1/12 (total 12/12)
            heightChange = twelfth * (11 + (cycleProgress - 5/6) * 6);
        }

        // Ensure we don't exceed the total change
        heightChange = Math.min(heightChange, tideChange);

        return isRising ? startHeight + heightChange : startHeight - heightChange;
    }

    /**
     * Format date for NOAA API
     */
    formatDate(date) {
        return date.toISOString().slice(0, 10).replace(/-/g, '');
    }

    /**
     * Get mock tide data for testing/offline mode
     */
    getMockTideData() {
        const now = new Date();
        const hours = (h) => new Date(now.getTime() + h * 60 * 60 * 1000);
        
        return {
            current: {
                height: 2.5,
                tendency: 'rising',
                rate: 0.3,
                method: 'mock'
            },
            next: {
                high: {
                    time: hours(3),
                    height: 3.8,
                    type: 'high'
                },
                low: {
                    time: hours(9),
                    height: 0.5,
                    type: 'low'
                }
            },
            previous: {
                high: {
                    time: hours(-9),
                    height: 3.7,
                    type: 'high'
                },
                low: {
                    time: hours(-3),
                    height: 0.4,
                    type: 'low'
                }
            },
            forecast: [
                { time: hours(3), height: 3.8, type: 'high' },
                { time: hours(9), height: 0.5, type: 'low' },
                { time: hours(15), height: 3.9, type: 'high' },
                { time: hours(21), height: 0.6, type: 'low' }
            ],
            coefficient: 95
        };
    }
}

module.exports = TidesDataProvider;