/*
 * Logbook Module - AI Analysis Integration
 * Specialized module for adding AI analysis entries to signalk-logbook
 * Focuses on logAnalysis - the main purpose of Jarvis AI
 */

// Using native fetch API
const https = require('https');

// Setup agents for both node-fetch (Agent) and native fetch (Dispatcher)
// to handle self-signed certificates
let httpsAgent;
let undiciDispatcher;

try {
    // Try to load undici for native fetch support (Node 18+)
    const { Agent } = require('undici');
    undiciDispatcher = new Agent({
        connect: {
            rejectUnauthorized: false
        }
    });
} catch (e) {
    // undici not available, ignore
}

// Create standard https agent as fallback/for node-fetch
httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

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
        
        // SignalK-Logbook API settings with proper defaults
        const logbookConfig = this.config.logbook || {};
        this.signalkLogbook = {
            enabled: logbookConfig.enabled !== undefined ? logbookConfig.enabled : true,
            serverUrl: logbookConfig.serverUrl || '',
            apiPath: logbookConfig.apiPath || '/signalk/v1/api/plugins/signalk-logbook/logs',
            author: logbookConfig.author || 'ocearo-core',
            timeout: logbookConfig.timeout || 5000
        };
        
        // Analysis logging settings with proper defaults
        this.analysisLogging = {
            enabled: this.config.logbook?.logAnalysis !== false,
            includeVesselData: this.config.logbook?.includeVesselDataInAnalysis !== false,
            logRecommendations: this.config.logbook?.logRecommendations !== false
        };
        
        // State
        this.isConnected = false;
    }

    /**
     * Internal fetch wrapper to handle HTTPS agent and common options
     */
    async _fetch(url, options = {}) {
        const isHttps = url.startsWith('https');
        const fetchOptions = { ...options };
        
        if (isHttps) {
            if (undiciDispatcher) {
                fetchOptions.dispatcher = undiciDispatcher;
            } else {
                fetchOptions.agent = httpsAgent;
            }
        }
        
        return fetch(url, fetchOptions);
    }

    /**
     * Initialize logbook integration
     */
    async start() {
        try {
            const { debug, info, warn, error } = this.log;
            
            if (!this.signalkLogbook.enabled) {
                const msg = 'SignalK-Logbook integration is disabled in configuration';
                warn(msg);
                this.isConnected = false;
                return { 
                    status: 'disabled', 
                    success: true,
                    message: msg,
                    connected: false
                };
            }

            debug('Testing SignalK server connection...');
            this.isConnected = await this.testSignalkConnection();
            
            if (!this.isConnected) {
                const warning = 'Cannot connect to SignalK-Logbook server - analysis logging will be queued';
                warn(warning);
                return { 
                    status: 'warning', 
                    success: true, 
                    message: warning,
                    connected: false
                };
            }
            
            debug('Logbook manager started - ready for AI analysis logging');
            return { 
                status: 'ready', 
                success: true, 
                connected: true,
                message: 'Logbook manager started successfully',
                config: {
                    serverUrl: this.signalkLogbook.serverUrl,
                    apiPath: this.signalkLogbook.apiPath,
                    timeout: this.signalkLogbook.timeout
                }
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
     * Test SignalK server connection and logbook API availability
     */
    async testSignalkConnection() {
        const startTime = Date.now();
        
        try {
            // Validate server URL - if empty, try to get from app
            if (!this.signalkLogbook.serverUrl) {
                // Try to get server URL from SignalK app
                if (this.app.config && this.app.config.getExternalPort) {
                    const port = this.app.config.getExternalPort();
                    this.signalkLogbook.serverUrl = `http://localhost:${port}`;
                    this.app.debug(`Using SignalK server URL from config: ${this.signalkLogbook.serverUrl}`);
                } else {
                    // Fallback to checking common ports if auto-detection fails
                    const commonUrls = [
                        'https://cirrus.local:3443',
                        'http://localhost:3000',
                        'http://localhost:80', 
                        'http://localhost:443', 
                        'http://localhost:8080'
                    ];
                    let foundUrl = null;
                    
                    for (const url of commonUrls) {
                        this.app.debug(`Trying fallback URL: ${url}`);
                        try {
                            const controller = new AbortController();
                            const timeout = setTimeout(() => controller.abort(), 1000);
                            const res = await this._fetch(`${url}/signalk/v1/api/self`, { signal: controller.signal });
                            clearTimeout(timeout);
                            if (res.ok) {
                                foundUrl = url;
                                break;
                            }
                        } catch (e) {
                            // ignore
                        }
                    }
                    
                    if (foundUrl) {
                        this.signalkLogbook.serverUrl = foundUrl;
                        this.app.info(`Auto-detected SignalK server URL: ${foundUrl}`);
                    } else {
                         this.app.warn('SignalK server URL is not configured and cannot be auto-detected. Defaulting to https://cirrus.local:3443');
                         this.signalkLogbook.serverUrl = 'https://cirrus.local:3443';
                    }
                }
            }

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.signalkLogbook.timeout);
            
            // First test basic server connectivity
            const testUrl = `${this.signalkLogbook.serverUrl.replace(/\/$/, '')}/signalk/v1/api/self`;
            this.app.debug(`Testing connection to: ${testUrl}`);
            
            const response = await this._fetch(testUrl, {
                signal: controller.signal,
                headers: {
                    'Accept': 'application/json',
                    'Cache-Control': 'no-cache'
                }
            }).catch(err => {
                if (err.name === 'AbortError') {
                    throw new Error(`Connection timeout after ${this.signalkLogbook.timeout}ms`);
                }
                throw err;
            });
            
            clearTimeout(timeoutId);
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            // Test if logbook API is available - try multiple common paths
            const possiblePaths = [
                this.signalkLogbook.apiPath,
                '/signalk/v1/api/plugins/signalk-logbook/logs',
                '/signalk/v1/api/vessels/self/logbook',
                '/signalk/v2/api/logbook',
                '/signalk/v1/api/logbook'
            ];
            
            // Try to discover logbook path from API root
            try {
                const apiRootResponse = await this._fetch(`${this.signalkLogbook.serverUrl}/signalk/v1/api/`, {
                    signal: controller.signal,
                    headers: { 'Accept': 'application/json' }
                });
                if (apiRootResponse.ok) {
                    const apiRoot = await apiRootResponse.json();
                    // Check standard resource paths
                    if (apiRoot.vessels?.self?.logbook) possiblePaths.push('/signalk/v1/api/vessels/self/logbook');
                    if (apiRoot.resources?.logbook) possiblePaths.push('/signalk/v1/api/resources/logbook');
                }
            } catch (e) {
                // Ignore discovery errors
            }
            
            let logbookFound = false;
            let workingPath = null;
            
            // Remove duplicates
            const uniquePaths = [...new Set(possiblePaths)];
            
            for (const testPath of uniquePaths) {
                try {
                    const controller2 = new AbortController();
                    const timeoutId2 = setTimeout(() => controller2.abort(), this.signalkLogbook.timeout);
                    
                    const logbookUrl = `${this.signalkLogbook.serverUrl}${testPath}`;
                    this.app.debug(`Testing logbook API at: ${logbookUrl}`);
                    
                    const logbookResponse = await this._fetch(logbookUrl, {
                        signal: controller2.signal,
                        headers: {
                            'Accept': 'application/json'
                        }
                    }).catch(err => {
                        clearTimeout(timeoutId2);
                        if (err.name === 'AbortError') {
                            throw new Error('Logbook API timeout');
                        }
                        throw err;
                    });
                    
                    clearTimeout(timeoutId2);
                    
                    // Consider 200 (GET success) or 405 (method not allowed, but endpoint exists) as success
                    if (logbookResponse.status === 200 || logbookResponse.status === 405 || logbookResponse.status === 401) {
                        logbookFound = true;
                        workingPath = testPath;
                        this.signalkLogbook.apiPath = testPath; // Update to working path
                        this.app.info(`Found SignalK-Logbook API at: ${testPath}`);
                        break;
                    }
                } catch (err) {
                    this.app.debug(`Logbook API not found at ${testPath}: ${err.message}`);
                }
            }
            
            if (!logbookFound) {
                this.app.warn('SignalK-Logbook API not found at any common path - plugin may not be installed or enabled');
                this.app.warn('Tried paths: ' + possiblePaths.join(', '));
                return false;
            }
            
            const responseTime = Date.now() - startTime;
            this.app.info(`SignalK server and logbook API connection successful at ${workingPath} (${responseTime}ms)`);
            return true;
            
        } catch (error) {
            const errorMsg = `SignalK server connection failed: ${error.message}`;
            this.app.warn(errorMsg);
            if (error.response) {
                this.app.debug(`Response status: ${error.response.status} ${error.response.statusText}`);
            }
            return false;
        }
    }

    /**
     * Stop logbook
     */
    async stop() {
        this.app.debug('Logbook manager stopped');
    }

    /**
     * Log AI analysis result - Main function for Jarvis
     */
    async logAnalysis(analysisType, result) {
        if (!this.analysisLogging.enabled) {
            this.app.debug('Analysis logging is disabled');
            return;
        }

        // Ensure connection
        if (!this.isConnected) {
            this.isConnected = await this.testSignalkConnection();
            if (!this.isConnected) {
                this.app.warn('Cannot log analysis - SignalK server not available');
                return;
            }
        }

        try {
            const entry = await this.buildAnalysisEntry(analysisType, result);
            await this.sendToSignalkApi(entry);
            this.app.debug(`Analysis logged: ${analysisType}`);
        } catch (error) {
            this.app.error('Failed to log analysis:', error);
            this.isConnected = false;
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
            author: this.signalkLogbook.author,
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
     * Get vessel context data for analysis entry
     */
    async getVesselContext() {
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

            // Engine data
            const engineHours = await this.app.getSelfPath('propulsion.mainEngine.runTime');
            if (engineHours?.value !== undefined) {
                context.engine = {
                    hours: parseFloat((engineHours.value / 3600).toFixed(1)) // seconds to hours
                };
            }

            return context;
        } catch (error) {
            this.app.warn('Error collecting vessel context:', error);
            return {};
        }
    }

    /**
     * Send entry to SignalK-Logbook API
     */
    async sendToSignalkApi(entry) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.signalkLogbook.timeout);
            
            const response = await this._fetch(`${this.signalkLogbook.serverUrl}${this.signalkLogbook.apiPath}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(entry),
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);
            
            if (!response.ok) {
                if (response.status === 404) {
                    this.app.warn('SignalK-Logbook API not available (404) - logbook plugin may not be installed');
                    this.isConnected = false;
                    return; // Don't throw error for 404, just disable logbook
                }
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            this.app.debug('Analysis entry sent to SignalK-Logbook API successfully');
        } catch (error) {
            if (error.message.includes('404')) {
                this.app.warn('SignalK-Logbook API not available - analysis logging disabled');
                this.isConnected = false;
                return;
            }
            this.app.error('Failed to send analysis entry to SignalK-Logbook API:', error.message);
            throw error;
        }
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

        // Ensure connection
        if (!this.isConnected) {
            this.isConnected = await this.testSignalkConnection();
            if (!this.isConnected) return;
        }

        try {
            const entry = await this.buildAnalysisEntry(analysisType, result);
            entry.category = category;
            
            await this.sendToSignalkApi(entry);
            this.app.debug(`Analysis logged with category ${category}: ${analysisType}`);
        } catch (error) {
            this.app.error('Failed to log analysis with custom category:', error);
            this.isConnected = false;
        }
    }

    /**
     * Get SignalK-Logbook server status
     */
    async getServerStatus() {
        try {
            const connected = await this.testSignalkConnection();
            
            let serverInfo = {};
            if (connected) {
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), this.signalkLogbook.timeout);
                    
                    const response = await this._fetch(`${this.signalkLogbook.serverUrl}/signalk/v1/api/self`, {
                        signal: controller.signal
                    });
                    
                    clearTimeout(timeoutId);
                    
                    if (response.ok) {
                        const data = await response.json();
                        serverInfo = {
                            name: data.name,
                            uuid: data.uuid
                        };
                    }
                } catch (error) {
                    // Server info not available
                }
            }

            return {
                enabled: this.signalkLogbook.enabled,
                connected,
                serverUrl: this.signalkLogbook.serverUrl,
                serverInfo,
                analysisLogging: this.analysisLogging
            };

        } catch (error) {
            return {
                enabled: this.signalkLogbook.enabled,
                connected: false,
                error: error.message,
                analysisLogging: this.analysisLogging
            };
        }
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
        if (config.signalkLogbook) {
            Object.assign(this.signalkLogbook, config.signalkLogbook);
        }
        
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
            signalkLogbook: { ...this.signalkLogbook },
            analysisLogging: { ...this.analysisLogging },
            isConnected: this.isConnected
        };
    }

    /**
     * Get all logbook entries from SignalK-Logbook (proxy function)
     * SignalK-Logbook API structure: GET /logs returns dates, GET /logs/{date} returns entries for that date
     */
    async getAllLogbookEntries(startDate, endDate) {
        // Attempt to connect if not already connected
        if (!this.isConnected) {
            this.app.debug('Not connected to SignalK-Logbook, attempting to connect...');
            this.isConnected = await this.testSignalkConnection();
            if (!this.isConnected) {
                this.app.warn('Cannot fetch logbook entries - SignalK-Logbook server not available');
                return []; // Return empty array instead of throwing
            }
        }

        try {
            // First, get list of dates with log entries
            const controller1 = new AbortController();
            const timeoutId1 = setTimeout(() => controller1.abort(), this.signalkLogbook.timeout);
            
            const datesUrl = `${this.signalkLogbook.serverUrl}${this.signalkLogbook.apiPath}`;
            const datesResponse = await this._fetch(datesUrl, {
                signal: controller1.signal,
                headers: {
                    'Accept': 'application/json',
                    'Cache-Control': 'no-cache'
                }
            });
            
            clearTimeout(timeoutId1);
            
            if (!datesResponse.ok) {
                throw new Error(`HTTP ${datesResponse.status}: ${datesResponse.statusText}`);
            }
            
            const dates = await datesResponse.json();
            
            // Filter dates based on startDate/endDate if provided
            let filteredDates = dates;
            if (startDate || endDate) {
                filteredDates = dates.filter(date => {
                    if (startDate && date < startDate) return false;
                    if (endDate && date > endDate) return false;
                    return true;
                });
            }

            // Fetch entries for each date
            const allEntries = [];
            for (const date of filteredDates) {
                const controller2 = new AbortController();
                const timeoutId2 = setTimeout(() => controller2.abort(), this.signalkLogbook.timeout);
                
                const entriesUrl = `${this.signalkLogbook.serverUrl}${this.signalkLogbook.apiPath}/${date}`;
                const entriesResponse = await this._fetch(entriesUrl, {
                    signal: controller2.signal,
                    headers: {
                        'Accept': 'application/json'
                    }
                });
                
                clearTimeout(timeoutId2);
                
                if (entriesResponse.ok) {
                    const entries = await entriesResponse.json();
                    allEntries.push(...entries);
                }
            }
            
            // Transform entries to match expected format
            return allEntries.map(entry => ({
                ...entry,
                date: new Date(entry.datetime),
                point: entry.position ? {
                    latitude: entry.position.latitude,
                    longitude: entry.position.longitude,
                    toString: () => `${entry.position.latitude.toFixed(6)}, ${entry.position.longitude.toFixed(6)}`
                } : null
            }));
        } catch (error) {
            this.app.error('Failed to fetch all logbook entries from SignalK API:', error);
            this.isConnected = false; // Mark as disconnected on error
            return []; // Return empty array as fallback
        }
    }

    /**
     * Add a new logbook entry to SignalK-Logbook (proxy function)
     * Accepts entry in ocearo format and converts to SignalK-Logbook format
     */
    async addLogbookEntry(entry) {
        // Attempt to connect if not already connected
        if (!this.isConnected) {
            this.app.debug('Not connected to SignalK-Logbook, attempting to connect...');
            this.isConnected = await this.testSignalkConnection();
            if (!this.isConnected) {
                this.app.warn('Cannot add logbook entry - SignalK-Logbook server not available');
                return { success: false, error: 'Logbook server not available' };
            }
        }

        try {
            // Convert ocearo entry format to SignalK-Logbook format
            const logbookEntry = {
                text: entry.text || entry.remarks || 'Manual entry',
                ago: entry.ago || 0, // Minutes ago (0-15)
                category: entry.category || 'navigation',
            };

            // Add optional observations if present
            if (entry.observations) {
                logbookEntry.observations = entry.observations;
            }

            // Add optional position if present
            if (entry.position) {
                logbookEntry.position = {
                    latitude: entry.position.latitude,
                    longitude: entry.position.longitude
                };
            }

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.signalkLogbook.timeout);
            
            const response = await this._fetch(`${this.signalkLogbook.serverUrl}${this.signalkLogbook.apiPath}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(logbookEntry),
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);
            
            if (response.status === 404) {
                this.app.warn('SignalK-Logbook API not available (404) - plugin may not be installed');
                this.isConnected = false;
                return { success: false, error: 'Logbook plugin not installed' };
            }
            
            if (!response.ok) {
                const errorText = await response.text().catch(() => response.statusText);
                throw new Error(`HTTP ${response.status}: ${errorText}`);
            }
            
            // SignalK-Logbook returns 201 Created with no body
            return { success: true, data: { message: 'Entry created successfully' } };
        } catch (error) {
            this.app.error('Failed to add logbook entry to SignalK API:', error);
            this.isConnected = false;
            return { success: false, error: error.message };
        }
    }

    /**
     * Get analysis entries from SignalK-Logbook (filtered)
     */
    async getAnalysisEntries(startDate, endDate) {
        // Attempt to connect if not already connected
        if (!this.isConnected) {
            this.app.debug('Not connected to SignalK-Logbook, attempting to connect...');
            this.isConnected = await this.testSignalkConnection();
            if (!this.isConnected) {
                throw new Error('Not connected to SignalK-Logbook server');
            }
        }

        try {
            const params = new URLSearchParams({ startDate, endDate });
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.signalkLogbook.timeout);
            
            const response = await this._fetch(`${this.signalkLogbook.serverUrl}${this.signalkLogbook.apiPath}?${params}`, {
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            const data = await response.json();
            
            // Filter entries created by Jarvis with analysis data
            return data.filter(entry => 
                entry.author === this.signalkLogbook.author && entry.analysis
            );
        } catch (error) {
            this.app.error('Failed to fetch analysis entries from SignalK API:', error);
            throw error;
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