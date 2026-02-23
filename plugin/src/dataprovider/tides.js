/**
 * Tide Data Provider
 *
 * Reads tide information exclusively from the SignalK data model.
 * The signalk-tides plugin populates the environment.tide.* paths.
 *
 * Provides:
 * - Current tide height, tendency and coefficient
 * - Next high/low tide times and heights
 * - Rule of Twelfths estimation when current height is unavailable
 */

class TidesDataProvider {
    constructor(app, config) {
        this.app = app;
        this.config = config;
        this.enabled = config.tidesProvider?.enabled !== false;

        this.tidePaths = {
            heightNow:  'environment.tide.heightNow',
            heightHigh: 'environment.tide.heightHigh',
            heightLow:  'environment.tide.heightLow',
            timeHigh:   'environment.tide.timeHigh',
            timeLow:    'environment.tide.timeLow',
            coeffNow:   'environment.tide.coeffNow',
            coeffNext:  'environment.tide.coeffNext'
        };
    }

    /**
     * Start the tide data provider.
     */
    async start() {
        if (!this.enabled) {
            this.app.debug('Tides provider disabled');
            return;
        }
        this.app.debug('Tides provider started (source: signalk)');
    }

    /**
     * Stop the tide data provider.
     */
    async stop() {
        this.app.debug('Tides provider stopped');
    }

    /**
     * Get current tide data from SignalK paths.
     * @returns {Object|null} Tide data in internal format
     */
    async getTideData() {
        if (!this.enabled) {
            return null;
        }

        try {
            const raw = this._readSignalKTideData();
            if (!raw) {
                this.app.debug('No tide data available from SignalK');
                return null;
            }

            return this._transform(raw);
        } catch (error) {
            this.app.error('Failed to fetch tide data:', error);
            return null;
        }
    }

    /**
     * Read all tide paths from the SignalK data model.
     * @returns {Object|null} Raw tide values keyed by short name
     */
    _readSignalKTideData() {
        const data = {};
        for (const [key, skPath] of Object.entries(this.tidePaths)) {
            const value = this._getSelfPath(skPath);
            if (value !== undefined && value !== null) {
                data[key] = value;
            }
        }
        return Object.keys(data).length > 0 ? data : null;
    }

    /**
     * Transform raw SignalK tide values into the internal format
     * consumed by the brain and analysis modules.
     * @param {Object} data Raw tide values
     * @returns {Object} Normalised tide data
     */
    _transform(data) {
        const now = new Date();
        const result = {
            current: {
                height: data.heightNow ?? null,
                tendency: null,
                rate: null,
                coefficient: data.coeffNow ?? null,
                coefficientNext: data.coeffNext ?? null
            },
            next: { high: null, low: null },
            extremes: [],
            source: 'signalk',
            timestamp: now.toISOString()
        };

        if (data.heightHigh !== undefined && data.timeHigh) {
            const highTime = this._parseTime(data.timeHigh);
            if (highTime) {
                const entry = { type: 'High', time: highTime, height: data.heightHigh };
                result.next.high = entry;
                result.extremes.push(entry);
            }
        }

        if (data.heightLow !== undefined && data.timeLow) {
            const lowTime = this._parseTime(data.timeLow);
            if (lowTime) {
                const entry = { type: 'Low', time: lowTime, height: data.heightLow };
                result.next.low = entry;
                result.extremes.push(entry);
            }
        }

        result.extremes.sort((a, b) => a.time - b.time);

        if (result.next.high && result.next.low) {
            result.current.tendency = result.next.high.time < result.next.low.time ? 'rising' : 'falling';
        }

        if (result.current.height === null && result.extremes.length >= 2) {
            result.current.height = this._estimateHeight(result.extremes, now);
        }

        return result;
    }

    /**
     * Estimate current tide height using the Rule of Twelfths.
     * Provides a reasonable approximation for semi-diurnal tides.
     * @param {Array} extremes Sorted tide extremes
     * @param {Date}  now      Current time
     * @returns {number|null} Estimated height in metres
     */
    _estimateHeight(extremes, now) {
        let prev = null;
        let next = null;

        for (let i = 0; i < extremes.length - 1; i++) {
            if (extremes[i].time <= now && extremes[i + 1].time > now) {
                prev = extremes[i];
                next = extremes[i + 1];
                break;
            }
        }

        if (!prev || !next) {
            return null;
        }

        const totalDuration = next.time - prev.time;
        if (totalDuration <= 0) {
            return null;
        }

        const fraction = (now - prev.time) / totalDuration;
        const range = next.height - prev.height;

        // Rule of Twelfths cumulative fractions per sixth
        const cumulative = [1, 3, 6, 9, 11, 12];
        const sixth = Math.min(Math.floor(fraction * 6), 5);
        const subFraction = (fraction * 6) - sixth;

        const prevCum = sixth > 0 ? cumulative[sixth - 1] : 0;
        const curCum = cumulative[sixth];
        const heightFraction = (prevCum + subFraction * (curCum - prevCum)) / 12;

        return prev.height + heightFraction * range;
    }

    /**
     * Parse a time value from SignalK (ISO string, timestamp, or Date).
     * @param {*} timeValue
     * @returns {Date|null}
     */
    _parseTime(timeValue) {
        if (!timeValue) {
            return null;
        }
        if (timeValue instanceof Date) {
            return timeValue;
        }
        if (typeof timeValue === 'number') {
            return new Date(timeValue > 1e10 ? timeValue : timeValue * 1000);
        }
        if (typeof timeValue === 'string') {
            const parsed = new Date(timeValue);
            return isNaN(parsed.getTime()) ? null : parsed;
        }
        return null;
    }

    /**
     * Read a value from the SignalK self path.
     * @param {string} skPath SignalK path
     * @returns {*} Value or undefined
     */
    _getSelfPath(skPath) {
        if (this.app.getSelfPath) {
            const result = this.app.getSelfPath(skPath);
            if (result && typeof result === 'object' && result.value !== undefined) {
                return result.value;
            }
            return result;
        }
        return undefined;
    }
}

module.exports = TidesDataProvider;