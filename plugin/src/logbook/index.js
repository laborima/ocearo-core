/**
 * Logbook Module - AI Analysis Integration
 *
 * Strategy: always use the local LogbookStore and expose it as a Signal K
 * Resource Provider for the custom 'logbooks' resource type.
 */

const LogbookStore = require('./logbook-store');

class LogbookManager {
    constructor(app, config = {}) {
        // Ensure config and its nested properties exist
        this.config = config || {};
        
        // Initialize app with proper defaults and ensure all methods exist
        this.app = app || {};
        
        // Ensure all logging methods exist on app
        if (!this.app.debug) {
            this.app.debug = console.debug ? console.debug.bind(console) : console.log.bind(console, '[debug]');
        }
        if (!this.app.info) {
            this.app.info = console.info ? console.info.bind(console) : console.log.bind(console, '[info]');
        }
        if (!this.app.warn) {
            this.app.warn = console.warn ? console.warn.bind(console) : console.log.bind(console, '[warn]');
        }
        if (!this.app.error) {
            this.app.error = console.error ? console.error.bind(console) : console.log.bind(console, '[error]');
        }
        
        // Initialize logging methods safely - use app methods as they're now guaranteed to exist
        this.log = {
            debug: this.app.debug,
            info: this.app.info,
            warn: this.app.warn,
            error: this.app.error
        };
        
        const logbookConfig = this.config.logbook || {};
        this.logbookAuthor = logbookConfig.author || 'ocearo-core';

        // Analysis logging settings with proper defaults
        this.analysisLogging = {
            enabled: this.config.logbook?.logAnalysis !== false,
            includeVesselData: this.config.logbook?.includeVesselDataInAnalysis !== false,
            logRecommendations: this.config.logbook?.logRecommendations !== false
        };
        
        /** Backend is always local */
        this.backend = 'local';

        /** Connection flag kept for API compatibility (always true for local backend) */
        this.isConnected = true;

        /** Local store — always initialised, used for fuel log and local backend */
        this.store = new LogbookStore(this.app);

        /** Vessel context cache — refreshed at most every 5 seconds */
        this._vesselContextCache = null;
        this._vesselContextCachedAt = 0;
        this._vesselContextTtlMs = 5000;
    }

    /**
     * Initialize logbook integration.
     * Always uses the local storage and registers as a SK Resource Provider.
     */
    async start() {
        try {
            const { debug, info, warn, error } = this.log;

            // Always initialise local store (needed for fuel log)
            this.store.init();
            this._registerAsResourceProvider();
            this.backend = 'local';
            return {
                status: 'local',
                success: true,
                message: 'Using local logbook store',
                connected: true,
                backend: 'local'
            };

        } catch (error) {
            const errorMsg = `Failed to initialize Logbook Manager: ${error.message}`;
            this.app.error(errorMsg, error.stack);
            throw { 
                message: errorMsg,
                originalError: error,
                failedComponent: 'LogbookManager',
                stack: error.stack
            };
        }
    }


    /**
     * Register ocearo-core as a Signal K Resource Provider for 'logbooks'.
     * @private
     */
    _registerAsResourceProvider() {
        if (!this.app.registerResourceProvider) {
            this.app.warn('app.registerResourceProvider not available — local logbook will not be exposed via Resources API');
            return;
        }

        try {
            this.app.registerResourceProvider({
                type: 'logbooks',
                methods: {
                    listResources: (params) => this.store.listResources(params),
                    getResource: (id, property) => this.store.getResource(id, property),
                    setResource: (id, value) => this.store.setResource(id, value),
                    deleteResource: (id) => this.store.deleteResource(id)
                }
            });
            this.app.debug('Registered as Resource Provider for logbooks');
        } catch (err) {
            this.app.warn(`Could not register logbook Resource Provider: ${err.message}`);
        }
    }

    /**
     * Emit a SK delta notification after a resource change so connected
     * clients (e.g. ocearo-ui via WebSocket) are updated in real time.
     * @param {string} id     entry UUID
     * @param {object|null} value  null to signal deletion
     * @private
     */
    _emitResourceDelta(id, value) {
        try {
            this.app.handleMessage('ocearo-core', {
                updates: [{
                    values: [{
                        path: `resources.logbooks.${id}`,
                        value
                    }]
                }]
            }, 2);
        } catch (err) {
            this.app.warn(`Could not emit logbook delta: ${err.message}`);
        }
    }

    /**
     * Stop logbook
     */
    async stop() {
        this.app.debug('Logbook manager stopped');
    }

    /**
     * Log AI analysis result - Main function for Jarvis.
     * Routes to local store or signalk-logbook depending on active backend.
     */
    async logAnalysis(analysisType, result) {
        if (!this.analysisLogging.enabled) {
            this.app.debug('Analysis logging is disabled');
            return;
        }

        try {
            const entry = await this.buildAnalysisEntry(analysisType, result);
            await this.store.addEntry({
                ...entry,
                entryType: analysisType,
                systemEvent: result.systemEvent || false
            });
            this.app.debug(`Analysis logged to local store: ${analysisType}`);
        } catch (error) {
            this.app.error('Failed to log analysis:', error);
        }
    }

    /**
     * Build analysis entry in SignalK format
     */
    async buildAnalysisEntry(analysisType, result) {
        // Create base entry
        const entry = {
            datetime: new Date().toISOString(),
            category: 'navigation',
            author: this.logbookAuthor,
            text: this.formatAnalysisText(analysisType, result)
        };

        // Process summary to ensure it is a string
        let summary = result.summary || result.speech || result.analysis;
        if (typeof summary === 'object' && summary !== null) {
            // Convert object summary to string
            summary = Object.entries(summary)
                .map(([key, value]) => `${key.charAt(0).toUpperCase() + key.slice(1)}: ${value}`)
                .join('. ');
        } else if (typeof summary !== 'string') {
            summary = String(summary || '');
        }

        // Add analysis-specific data
        const analysisData = {
            type: analysisType,
            summary: summary,
            confidence: result.confidence,
            timestamp: result.timestamp || new Date().toISOString()
        };

        // Add recommendations if available and enabled
        if (this.analysisLogging.logRecommendations && result.recommendations) {
            analysisData.recommendations = Array.isArray(result.recommendations) 
                ? result.recommendations 
                : [result.recommendations];
        }

        // Add data sources used in analysis
        if (result.dataSources) {
            analysisData.dataSources = result.dataSources;
        }

        // Add analysis metrics if available
        if (result.metrics) {
            analysisData.metrics = result.metrics;
        }

        entry.analysis = analysisData;

        // Add current vessel data for context if enabled
        if (this.analysisLogging.includeVesselData) {
            try {
                const vesselContext = await this.getVesselContext();
                if (Object.keys(vesselContext).length > 0) {
                    entry.vesselContext = vesselContext;
                }
            } catch (error) {
                this.app.warn('Could not add vessel context to analysis entry:', error);
            }
        }

        return entry;
    }

    /**
     * Format analysis text for logbook readability
     */
    formatAnalysisText(analysisType, result) {
        let summary = result.summary || result.speech || result.analysis || 'Analysis completed';
        
        if (typeof summary === 'object' && summary !== null) {
            // Convert object summary to string
            summary = Object.entries(summary)
                .map(([key, value]) => `${key.charAt(0).toUpperCase() + key.slice(1)}: ${value}`)
                .join('. ');
        }

        // Create readable text based on analysis type
        const typeLabels = {
            'weather': 'Weather Analysis',
            'navigation': 'Navigation Analysis', 
            'performance': 'Performance Analysis',
            'safety': 'Safety Analysis',
            'route': 'Route Analysis',
            'arrival': 'Arrival Analysis',
            'fuel': 'Fuel Analysis',
            'maintenance': 'Maintenance Analysis',
            'anchor': 'Anchor Analysis',
            'collision': 'Collision Analysis'
        };

        const label = typeLabels[analysisType] || `${analysisType} Analysis`;
        
        // Truncate summary if too long for logbook text
        const truncatedSummary = summary.length > 200 
            ? summary.substring(0, 197) + '...' 
            : summary;

        return `${label}: ${truncatedSummary}`;
    }

    /**
     * Get vessel context data for analysis entry.
     * Results are cached for up to 5 seconds to avoid hammering getSelfPath
     * when multiple analyses are logged in quick succession.
     */
    async getVesselContext() {
        const now = Date.now();
        if (this._vesselContextCache && now - this._vesselContextCachedAt < this._vesselContextTtlMs) {
            return this._vesselContextCache;
        }

        try {
            const context = {};

            // Position
            const position = await this.app.getSelfPath('navigation.position');
            if (position) {
                context.position = {
                    longitude: position.longitude,
                    latitude: position.latitude
                };
            }

            // Navigation data
            const [sog, stw, cog, heading] = await Promise.all([
                this.app.getSelfPath('navigation.speedOverGround'),
                this.app.getSelfPath('navigation.speedThroughWater'),
                this.app.getSelfPath('navigation.courseOverGroundTrue'),
                this.app.getSelfPath('navigation.headingTrue')
            ]);

            if (sog?.value !== undefined || stw?.value !== undefined) {
                context.speed = {};
                if (sog?.value !== undefined) {
                    context.speed.sog = parseFloat((sog.value * 1.94384).toFixed(1)); // m/s to knots
                }
                if (stw?.value !== undefined) {
                    context.speed.stw = parseFloat((stw.value * 1.94384).toFixed(1)); // m/s to knots
                }
            }

            if (cog?.value !== undefined) {
                context.course = Math.round(cog.value * 180 / Math.PI);
            }

            if (heading?.value !== undefined) {
                context.heading = Math.round(heading.value * 180 / Math.PI);
            }

            // Wind data
            const [windSpeedTrue, windDirTrue] = await Promise.all([
                this.app.getSelfPath('environment.wind.speedTrue'),
                this.app.getSelfPath('environment.wind.directionTrue')
            ]);

            if (windSpeedTrue?.value !== undefined || windDirTrue?.value !== undefined) {
                context.wind = {};
                if (windSpeedTrue?.value !== undefined) {
                    context.wind.speed = parseFloat((windSpeedTrue.value * 1.94384).toFixed(1)); // m/s to knots
                }
                if (windDirTrue?.value !== undefined) {
                    context.wind.direction = Math.round(windDirTrue.value * 180 / Math.PI);
                }
            }

            // Engine data — try multiple common SignalK paths
            const engineRunTime = await this._getEngineRunTime();
            if (engineRunTime !== null) {
                context.engine = {
                    hours: parseFloat((engineRunTime / 3600).toFixed(1)) // seconds to hours
                };
            }

            this._vesselContextCache = context;
            this._vesselContextCachedAt = Date.now();
            return context;
        } catch (error) {
            this.app.warn('Error collecting vessel context:', error);
            return {};
        }
    }

    /**
     * Retrieve engine run time (in seconds) by trying multiple common SignalK paths.
     * Returns null if no value is found on any known path.
     * @returns {Promise<number|null>}
     */
    async _getEngineRunTime() {
        const candidatePaths = [
            'propulsion.mainEngine.runTime',
            'propulsion.0.runTime',
            'propulsion.port.runTime',
            'propulsion.main.runTime',
            'propulsion.1.runTime',
            'propulsion.starboard.runTime'
        ];

        for (const skPath of candidatePaths) {
            try {
                const data = await this.app.getSelfPath(skPath);
                if (data?.value !== undefined && data.value !== null && !isNaN(data.value)) {
                    this.app.debug(`Engine runTime found at ${skPath}: ${data.value}s`);
                    return data.value;
                }
            } catch (err) {
                this.app.debug(`Engine runTime not available at ${skPath}: ${err.message}`);
            }
        }

        this.app.debug('Engine runTime not found on any known SignalK path');
        return null;
    }

    /**
     * Log multiple analysis results (batch)
     */
    async logMultipleAnalyses(analyses) {
        if (!this.analysisLogging.enabled) {
            this.app.debug('Analysis logging is disabled');
            return;
        }

        const results = [];
        for (const analysis of analyses) {
            try {
                await this.logAnalysis(analysis.type, analysis.result);
                results.push({ type: analysis.type, success: true });
            } catch (error) {
                results.push({ type: analysis.type, success: false, error: error.message });
            }
        }
        return results;
    }

    /**
     * Log analysis with custom category
     */
    async logAnalysisWithCategory(analysisType, result, category = 'navigation') {
        if (!this.analysisLogging.enabled) return;

        try {
            const entry = await this.buildAnalysisEntry(analysisType, result);
            entry.category = category;
            
            await this.store.addEntry({
                ...entry,
                entryType: analysisType,
                systemEvent: result.systemEvent || false
            });
            this.app.debug(`Analysis logged with category ${category}: ${analysisType}`);
        } catch (error) {
            this.app.error('Failed to log analysis with custom category:', error);
        }
    }

    /**
     * Get logbook status
     */
    async getServerStatus() {
        return {
            enabled: true,
            connected: true,
            serverUrl: 'local',
            serverInfo: {},
            analysisLogging: this.analysisLogging
        };
    }

    /**
     * Test analysis logging (for debugging)
     */
    async testAnalysisLogging() {
        const testAnalysis = {
            summary: 'Test analysis from Ocearo Jarvis AI',
            confidence: 0.95,
            recommendations: ['This is a test entry'],
            metrics: {
                processingTime: '0.5s',
                dataPoints: 42
            }
        };

        try {
            await this.logAnalysis('test', testAnalysis);
            return { success: true, message: 'Test analysis logged successfully' };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Update configuration
     */
    updateConfig(config) {
        if (config.analysisLogging) {
            Object.assign(this.analysisLogging, config.analysisLogging);
        }
        
        this.app.debug('LogbookManager configuration updated');
    }

    /**
     * Get current configuration
     */
    getConfig() {
        return {
            analysisLogging: { ...this.analysisLogging },
            isConnected: true,
            backend: this.backend
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fuel log (always local)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Add a fuel refill entry to the local store.
     * @param {object} record  { liters, cost, additive, engineHours, position, ... }
     * @returns {Promise<{success: boolean, id: string}>}
     */
    async addFuelLogEntry(record) {
        try {
            const id = await this.store.addFuelEntry(record);
            this.app.debug(`Fuel log entry added: ${id}`);
            return { success: true, id };
        } catch (err) {
            this.app.error('Failed to add fuel log entry:', err.message);
            return { success: false, error: err.message };
        }
    }

    /**
     * Return all fuel log entries.
     * @returns {Promise<Array>}
     */
    async getFuelLogEntries() {
        try {
            return await this.store.getFuelEntries();
        } catch (err) {
            this.app.error('Failed to get fuel log entries:', err.message);
            return [];
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Logbook entries — route to active backend
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Get all logbook entries from the active backend.
     * SignalK-Logbook API structure: GET /logs returns dates, GET /logs/{date} returns entries for that date
     */
    async getAllLogbookEntries(startDate, endDate) {
        return this.store.getAllEntries({ startDate, endDate });
    }

    /**
     * Add a new logbook entry to the active backend.
     * Accepts entry in ocearo format and converts to SignalK-Logbook format
     */
    async addLogbookEntry(entry) {
        try {
            const id = await this.store.addEntry({
                ...entry,
                datetime: entry.datetime || new Date().toISOString(),
                category: entry.category || 'navigation',
                text: entry.text || entry.remarks || 'Manual entry'
            });
            this._emitResourceDelta(id, await this.store.getResource(id));
            return { success: true, id };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    /**
     * Add an entry to the local store (used as fallback when signalk-logbook fails).
     * @private
     */
    async _addEntryToLocalStore(entry) {
        try {
            const id = await this.store.addEntry({
                ...entry,
                datetime: entry.datetime || new Date().toISOString(),
                category: entry.category || 'navigation',
                text: entry.text || entry.remarks || 'Manual entry'
            });
            this._emitResourceDelta(id, await this.store.getResource(id));
            this.app.debug(`Entry saved to local store as fallback: ${id}`);
            return { success: true, id, backend: 'local-fallback' };
        } catch (err) {
            this.app.error('Failed to save entry to local store fallback:', err.message);
            return { success: false, error: err.message };
        }
    }

    /**
     * Get analysis entries filtered by author/analysis presence.
     * Routes to local store or signalk-logbook depending on active backend.
     */
    async getAnalysisEntries(startDate, endDate) {
        try {
            const all = await this.store.getAllEntries({ startDate, endDate });
            return all.filter(entry => entry.analysis || entry.entryType);
        } catch (err) {
            this.app.error('Failed to fetch analysis entries from local store:', err.message);
            return [];
        }
    }

    /**
     * Get analysis statistics
     */
    async getAnalysisStatistics(startDate, endDate) {
        try {
            const entries = await this.getAnalysisEntries(startDate, endDate);
            
            const stats = {
                totalAnalyses: entries.length,
                analysesByType: {},
                analysesByDay: {},
                averageConfidence: 0
            };

            let totalConfidence = 0;
            let confidenceCount = 0;

            for (const entry of entries) {
                const type = entry.analysis?.type || 'unknown';
                const day = entry.datetime.split('T')[0];
                
                // Count by type
                stats.analysesByType[type] = (stats.analysesByType[type] || 0) + 1;
                
                // Count by day
                stats.analysesByDay[day] = (stats.analysesByDay[day] || 0) + 1;

                // Calculate confidence
                if (entry.analysis?.confidence !== undefined) {
                    totalConfidence += entry.analysis.confidence;
                    confidenceCount++;
                }
            }

            stats.averageConfidence = confidenceCount > 0 
                ? parseFloat((totalConfidence / confidenceCount).toFixed(2)) 
                : 0;

            return stats;
        } catch (error) {
            this.app.error('Failed to get analysis statistics:', error);
            throw error;
        }
    }
}

module.exports = LogbookManager;