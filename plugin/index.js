/**
 * ocearo-core Signal K Plugin
 *
 * Main entry point for the Ocearo intelligent marine assistant.
 * Coordinates data providers, AI analysis, voice synthesis, and logbook integration.
 */

const path = require('path');
const fs = require('fs');

// ─── Security helpers ─────────────────────────────────────────────────────────

/**
 * Lightweight in-process rate limiter (no external dependency).
 * Tracks request counts per IP in a rolling time window.
 */
class RateLimiter {
    constructor(windowMs, maxRequests) {
        this._windowMs = windowMs;
        this._max = maxRequests;
        this._store = new Map();
        // Cleanup stale entries every window
        setInterval(() => this._cleanup(), windowMs).unref();
    }

    _cleanup() {
        const now = Date.now();
        for (const [key, entry] of this._store) {
            if (now - entry.start > this._windowMs) this._store.delete(key);
        }
    }

    /**
     * Returns true if the request should be allowed, false if rate-limited.
     * @param {string} key  typically the client IP
     */
    allow(key) {
        const now = Date.now();
        const entry = this._store.get(key);
        if (!entry || now - entry.start > this._windowMs) {
            this._store.set(key, { start: now, count: 1 });
            return true;
        }
        if (entry.count >= this._max) return false;
        entry.count++;
        return true;
    }
}

// Rate limiters: generous for reads, stricter for heavy AI operations
const generalLimiter = new RateLimiter(60_000, 120);   // 120 req/min
const analysisLimiter = new RateLimiter(60_000, 10);    // 10 AI calls/min
const speakLimiter = new RateLimiter(60_000, 20);       // 20 TTS calls/min

/**
 * Express middleware: attach a short request ID and enforce rate limit.
 * @param {RateLimiter} limiter
 */
function rateLimit(limiter) {
    return (req, res, next) => {
        const ip = req.ip || req.connection?.remoteAddress || 'unknown';
        if (!limiter.allow(ip)) {
            return res.status(429).json({
                error: 'Too many requests',
                retryAfterMs: 60_000
            });
        }
        next();
    };
}

/**
 * Sanitise a string: strip control characters, limit length.
 * @param {string} value
 * @param {number} maxLen
 * @returns {string}
 */
function sanitiseString(value, maxLen = 2000) {
    if (typeof value !== 'string') return '';
    return value
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        .substring(0, maxLen)
        .trim();
}

/**
 * Middleware: require JSON body and reject oversized payloads.
 * Signal K plugin router already parses JSON, so this just validates.
 */
function requireJson(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'DELETE') {
        if (!req.body || typeof req.body !== 'object') {
            return res.status(400).json({ error: 'JSON body required' });
        }
    }
    next();
}

/**
 * Guard: return 503 if brain is not initialised.
 */
function requireBrain(brain) {
    return (req, res, next) => {
        if (!brain) return res.status(503).json({ error: 'Service not initialized' });
        next();
    };
}

/**
 * Guard: return 503 if a component is not initialised.
 */
function requireComponent(getComponent, name) {
    return (req, res, next) => {
        if (!getComponent()) return res.status(503).json({ error: `${name} not initialized` });
        next();
    };
}

// Import components
const SignalKProvider = require('./src/dataprovider/signalk');
const WeatherProvider = require('./src/dataprovider/marineweather');
const TidesProvider = require('./src/dataprovider/tides');
const MemoryManager = require('./src/memory');
const LLMClient = require('./src/llm');
const VoiceModule = require('./src/voice');
const OrchestratorBrain = require('./src/brain');
const LogbookManager = require('./src/logbook');
const ConfigManager = require('./src/config');

module.exports = function(app) {
    const plugin = {};
    let brain = null;
    let components = {};
    
    plugin.id = 'ocearo-core';
    plugin.name = 'Océaro Core';
    plugin.description = 'Assistant marin intelligent : briefings météo/marées, coaching voile, analyse AIS, alertes vocales via Ollama LLM et Piper TTS';
    
    // Load schema
    plugin.schema = JSON.parse(
        fs.readFileSync(path.join(__dirname, 'schema.json'), 'utf8')
    );

    plugin.start = async function(options) {
        app.debug('Starting ocearo-core plugin');
        
        // Provide default configuration if none provided
        if (!options || Object.keys(options).length === 0) {
            app.debug('No configuration provided, using defaults');
            options = {
                debug: true,
                memory: {
                    maxHistorySize: 1000,
                    persistIntervalMinutes: 10
                }
            };
        }
        
        try {
            // Initialize components with individual error handling
            
            try {
                app.debug('Initializing SignalK Provider...');
                components.signalkProvider = new SignalKProvider(app, plugin.id);
                components.signalkProvider.start();
                
                app.debug('Initializing Weather Provider...');
                components.weatherProvider = new WeatherProvider(app, options);
                components.weatherProvider.start();
                
                app.debug('Initializing Tides Provider...');
                components.tidesProvider = new TidesProvider(app, options);
                await components.tidesProvider.start();
                
                app.debug('Initializing Memory Manager...');
                components.memoryManager = new MemoryManager(app, options);
                await components.memoryManager.start();

                app.debug('Initializing Logbook Manager...');
                components.logbookManager = new LogbookManager(app, options);
                await components.logbookManager.start();
    
                
                app.debug('Initializing ConfigManager...');
                components.configManager = new ConfigManager(app, {
                    language: options.language || 'fr',
                    boat: options.boat || 'dufour310gl',
                    personality: options.personality || 'jarvis'
                });

                app.debug('Initializing LLM Client...');
                components.llm = new LLMClient(app, options || {}, components.configManager);
                
                app.debug('Initializing Voice Module...');
                components.voice = new VoiceModule(app, options || {});
                components.voice.start();

                app.debug('Creating Orchestrator Brain...');
                brain = new OrchestratorBrain(app, options, components);
                await brain.start();
                
            } catch (error) {
                error.failedComponent = error.failedComponent || 'Unknown';
                app.error(`Failed to initialize component: ${error.failedComponent}`, error);
                throw error; // Re-throw to be caught by the outer try-catch
            }
         
            
            // Components initialization and starting is now handled in the try-catch block above
            
            app.debug('Set running status...');
            app.setPluginStatus('Running');
            app.debug('ocearo-core plugin started successfully');
            
        } catch (error) {
            app.error('Failed to start ocearo-core:');
            app.error('Startup failure details:', {
                error: error.message,
                stack: error.stack,
                failedComponent: error.failedComponent // Add this to component errors
            });
            
            // Cleanup any started components
            try {
                if (components.voice) components.voice.stop();
                if (components.signalkProvider) components.signalkProvider.stop();
                if (components.memoryManager) await components.memoryManager.stop();
                if (components.logbookManager) await components.logbookManager.stop();
            } catch (cleanupError) {
                app.error('Error during cleanup:', cleanupError);
            }
            
            app.setPluginError(error.message);
        }
    };

    plugin.stop = async function() {
        app.debug('Stopping ocearo-core plugin');
        
        try {
            // Stop orchestrator
            if (brain) {
                await brain.stop();
                brain = null;
            }
            
            // Stop components
            if (components.voice) components.voice.stop();
            if (components.weatherProvider) components.weatherProvider.stop();
            if (components.tidesProvider) await components.tidesProvider.stop();
            if (components.signalkProvider) components.signalkProvider.stop();
            if (components.memoryManager) await components.memoryManager.stop();
            if (components.logbookManager) await components.logbookManager.stop();
            
            // Clear components
            components = {};
            
            app.setPluginStatus('Stopped');
            
        } catch (error) {
            app.error('Error stopping ocearo-core:', error);
        }
    };
    
    plugin.registerWithRouter = function(router) {
        // Apply general rate limit and JSON validation to all routes
        router.use(rateLimit(generalLimiter));
        router.use(requireJson);

        // Delegate anchor API endpoints to AnchorPlugin
        if (brain && brain.anchorPlugin) {
            brain.anchorPlugin.registerWithRouter(router);
        }

        // Health check endpoint - lightweight check for monitoring
        router.get('/health', async (req, res) => {
            const health = {
                status: 'ok',
                timestamp: new Date().toISOString(),
                plugin: plugin.id,
                components: {
                    brain: !!brain && brain.state?.started,
                    signalk: !!components.signalkProvider,
                    memory: !!components.memoryManager,
                    logbook: components.logbookManager?.isConnected || false,
                    logbookBackend: components.logbookManager?.backend || 'unknown',
                    anchor: brain?.anchorPlugin?.getState() || 'unknown',
                    voice: components.voice?.enabled || false,
                    llm: components.llm?.isConnected() || false
                }
            };
            
            // Determine overall health
            const criticalComponents = ['brain', 'signalk', 'memory'];
            const allCriticalHealthy = criticalComponents.every(c => health.components[c]);
            
            if (!allCriticalHealthy) {
                health.status = 'degraded';
            }
            
            if (!brain) {
                health.status = 'unhealthy';
                return res.status(503).json(health);
            }
            
            res.json(health);
        });
        
        // Status endpoint
        router.get('/status', (req, res) => {
            if (!brain) {
                return res.status(503).json({ error: 'Service not initialized' });
            }
            
            res.json(brain.getSystemStatus());
        });
        
        // Manual analysis — heavy AI operation, stricter rate limit
        router.post('/analyze', rateLimit(analysisLimiter), async (req, res) => {
            if (!brain) {
                return res.status(503).json({ error: 'Service not initialized' });
            }

            const { type } = req.body;

            const validTypes = ['weather', 'sail', 'alerts', 'ais', 'status', 'logbook', 'route'];
            if (!type) {
                return res.status(400).json({ error: 'Analysis type is required' });
            }
            if (!validTypes.includes(sanitiseString(type, 20))) {
                return res.status(400).json({
                    error: 'Invalid analysis type',
                    validTypes
                });
            }

            try {
                const result = await brain.requestAnalysis(type);
                res.json(result);
            } catch (error) {
                const status = error.message.includes('AI service unavailable') ? 503 : 500;
                res.status(status).json({
                    error: 'Analysis failed',
                    message: error.message
                });
            }
        });
        
        // Mode change
        router.post('/mode', (req, res) => {
            if (!brain) {
                return res.status(503).json({ error: 'Service not initialized' });
            }

            const { mode } = req.body;

            // Validate mode parameter
            const validModes = ['sailing', 'anchored', 'motoring', 'moored', 'racing'];
            if (!mode) {
                return res.status(400).json({ error: 'Mode is required' });
            }
            if (typeof mode !== 'string') {
                return res.status(400).json({ error: 'Mode must be a string' });
            }
            if (!validModes.includes(mode)) {
                return res.status(400).json({
                    error: 'Invalid mode',
                    validModes: validModes
                });
            }

            try {
                brain.updateMode(mode);
                res.json({ success: true, mode });
            } catch (error) {
                res.status(400).json({
                    error: 'Invalid mode',
                    message: error.message
                });
            }
        });
        
        // TTS — rate-limited separately
        router.post('/speak', rateLimit(speakLimiter), (req, res) => {
            if (!components.voice) {
                return res.status(503).json({ error: 'Voice not initialized' });
            }

            const rawText = req.body.text;
            const priority = req.body.priority;

            if (!rawText) return res.status(400).json({ error: 'Text is required' });
            if (typeof rawText !== 'string') return res.status(400).json({ error: 'Text must be a string' });

            const text = sanitiseString(rawText, 1000);
            if (text.length === 0) return res.status(400).json({ error: 'Text cannot be empty' });

            const validPriorities = ['low', 'normal', 'high'];
            if (priority && !validPriorities.includes(priority)) {
                return res.status(400).json({ error: 'Invalid priority', validPriorities });
            }

            components.voice.speak(text, { priority: priority || 'normal' });
            res.json({ success: true });
        });
        
        // Memory operations
        router.get('/memory', (req, res) => {
            if (!components.memoryManager) {
                return res.status(503).json({ error: 'Memory manager not initialized' });
            }
            
            res.json({
                context: components.memoryManager.getContext(),
                statistics: components.memoryManager.getStatistics(),
                status: 'active'
            });
        });
        
        router.get('/memory/stats', (req, res) => {
            if (!components.memoryManager) {
                return res.status(503).json({ error: 'Memory manager not initialized' });
            }
            
            res.json(components.memoryManager.getStatistics());
        });

        router.post('/memory/context', (req, res) => {
            if (!components.memoryManager) {
                return res.status(503).json({ error: 'Memory manager not initialized' });
            }
            
            const { vesselInfo, destination } = req.body;
            
            if (vesselInfo) {
                components.memoryManager.setProfile(vesselInfo);
            }
            
            if (destination) {
                components.memoryManager.setDestination(destination.waypoint);
                if (destination.route) {
                    components.memoryManager.setRoute(destination.route);
                }
            }
            
            res.json({ 
                success: true,
                context: components.memoryManager.getContext()
            });
        });
     
        
        // Logbook operations
        router.get('/logbook/entries', async (req, res) => {
            if (!components.logbookManager) {
                return res.status(503).json({ error: 'Logbook manager not initialized' });
            }

            try {
                const { startDate, endDate } = req.query;
                const entries = await components.logbookManager.getAnalysisEntries(startDate, endDate);
                res.json(entries);
            } catch (error) {
                res.status(500).json({
                    error: 'Failed to fetch logbook entries',
                    message: error.message
                });
            }
        });

        // Logbook proxy - get all entries (not just analysis entries)
        router.get('/logbook/all-entries', async (req, res) => {
            if (!components.logbookManager) {
                return res.status(503).json({ error: 'Logbook manager not initialized' });
            }

            try {
                const { startDate, endDate } = req.query;
                const entries = await components.logbookManager.getAllLogbookEntries(startDate, endDate);
                res.json(entries);
            } catch (error) {
                res.status(500).json({
                    error: 'Failed to fetch all logbook entries',
                    message: error.message
                });
            }
        });

        // Logbook proxy - add entry
        router.post('/logbook/add-entry', async (req, res) => {
            if (!components.logbookManager) {
                return res.status(503).json({ error: 'Logbook manager not initialized' });
            }

            try {
                const entry = req.body;
                const result = await components.logbookManager.addLogbookEntry(entry);
                
                // Check if the operation was successful
                if (result.success === false) {
                    return res.status(503).json({
                        error: 'Logbook write failed',
                        message: result.error || 'Could not write logbook entry',
                        backend: components.logbookManager.backend
                    });
                }
                
                res.json(result);
            } catch (error) {
                res.status(500).json({
                    error: 'Failed to add logbook entry',
                    message: error.message
                });
            }
        });

        // Logbook backend info
        router.get('/logbook/backend', (req, res) => {
            if (!components.logbookManager) {
                return res.status(503).json({ error: 'Logbook manager not initialized' });
            }
            res.json({
                backend: components.logbookManager.backend,
                connected: components.logbookManager.isConnected
            });
        });

        router.get('/logbook/stats', async (req, res) => {
            if (!components.logbookManager) {
                return res.status(503).json({ error: 'Logbook manager not initialized' });
            }

            try {
                const { startDate, endDate } = req.query;
                const stats = await components.logbookManager.getAnalysisStatistics(startDate, endDate);
                res.json(stats);
            } catch (error) {
                res.status(500).json({
                    error: 'Failed to get logbook statistics',
                    message: error.message
                });
            }
        });

        // ── Fuel log endpoints ────────────────────────────────────────────────
        router.post('/logbook/fuel', async (req, res) => {
            if (!components.logbookManager) {
                return res.status(503).json({ error: 'Logbook manager not initialized' });
            }

            try {
                const record = req.body;

                if (!record.liters || parseFloat(record.liters) <= 0) {
                    return res.status(400).json({ error: 'liters must be a positive number' });
                }

                const result = await components.logbookManager.addFuelLogEntry({
                    ...record,
                    datetime: new Date().toISOString()
                });
                res.json(result);
            } catch (error) {
                res.status(500).json({ error: 'Failed to add fuel log entry', message: error.message });
            }
        });

        router.get('/logbook/fuel', async (req, res) => {
            if (!components.logbookManager) {
                return res.status(503).json({ error: 'Logbook manager not initialized' });
            }

            try {
                const entries = await components.logbookManager.getFuelLogEntries();
                res.json(entries);
            } catch (error) {
                res.status(500).json({ error: 'Failed to get fuel log entries', message: error.message });
            }
        });

        // Logbook AI analysis — accepts optional pre-fetched entries in body
        router.post('/logbook/analyze', rateLimit(analysisLimiter), async (req, res) => {
            if (!brain) {
                return res.status(503).json({ error: 'Service not initialized' });
            }

            try {
                const result = await brain.requestAnalysis('logbook');
                res.json(result);
            } catch (error) {
                const status = error.message.includes('AI service unavailable') ? 503 : 500;
                res.status(status).json({
                    error: 'Logbook analysis failed',
                    message: error.message
                });
            }
        });

        // AI-enhanced logbook entry generation — uses LLM with currentData context
        router.post('/logbook/entry', rateLimit(analysisLimiter), async (req, res) => {
            if (!brain) {
                return res.status(503).json({ error: 'Service not initialized' });
            }
            if (!components.logbookManager) {
                return res.status(503).json({ error: 'Logbook manager not initialized' });
            }

            const { currentData } = req.body;

            try {
                const language = components.configManager ? components.configManager.language : 'fr';
                const isFrench = language === 'fr';

                // Build a rich context prompt from the vessel data provided by the UI
                const vesselSummary = currentData ? [
                    currentData.speed !== undefined ? `SOG ${(currentData.speed * 1.94384).toFixed(1)} kts` : null,
                    currentData.course !== undefined ? `COG ${Math.round(currentData.course * 180 / Math.PI)}°` : null,
                    currentData.wind?.speed !== undefined ? `Vent ${(currentData.wind.speed * 1.94384).toFixed(1)} nds` : null,
                    currentData.weather?.pressure !== undefined ? `${(currentData.weather.pressure / 100).toFixed(0)} hPa` : null,
                    currentData.engine?.hours !== undefined ? `Moteur ${(currentData.engine.hours / 3600).toFixed(1)}h` : null
                ].filter(Boolean).join(', ') : (isFrench ? 'Aucune donnée bateau' : 'No vessel data');

                let aiText = isFrench
                    ? `Entrée automatique : ${vesselSummary}`
                    : `Auto entry: ${vesselSummary}`;
                let confidence = 0.7;

                // Enrich with LLM if available
                if (components.llm && components.llm.isConnected()) {
                    try {
                        const prompt = isFrench
                            ? `Rédige une entrée de journal de bord nautique concise (80 mots max) pour ces conditions : ${vesselSummary}. Sois factuel et professionnel. Réponds uniquement en français.`
                            : `Write a concise nautical logbook entry (max 80 words) for these conditions: ${vesselSummary}. Be factual and professional.`;
                        const llmText = await components.llm.generateCompletion(prompt, { maxTokens: 120 });
                        if (llmText && llmText.trim().length > 0) {
                            aiText = llmText.trim();
                            confidence = 0.92;
                        }
                    } catch (llmErr) {
                        app.debug('LLM enrichment skipped for logbook entry:', llmErr.message);
                    }
                }

                // Add as a real logbook entry so it appears in /all-entries
                const entry = {
                    datetime: new Date().toISOString(),
                    author: components.logbookManager?.signalkLogbook?.author || 'ocearo-core',
                    text: aiText,
                    category: 'navigation'
                };
                await components.logbookManager.addLogbookEntry(entry);

                const analysisResult = {
                    summary: aiText,
                    confidence,
                    recommendations: [],
                    metrics: { dataPoints: Object.keys(currentData || {}).length }
                };

                res.json({
                    success: true,
                    message: isFrench ? 'Entrée IA créée' : 'AI logbook entry created',
                    analysis: analysisResult
                });
            } catch (error) {
                res.status(500).json({
                    error: 'Failed to create AI logbook entry',
                    message: error.message
                });
            }
        });

        // Retrieve recent AI logbook entries (analysis type)
        router.get('/logbook/entry', async (req, res) => {
            if (!components.logbookManager) {
                return res.status(503).json({ error: 'Logbook manager not initialized' });
            }
            try {
                const { startDate, endDate, limit } = req.query;
                const entries = await components.logbookManager.getAnalysisEntries(startDate, endDate);
                const maxEntries = Math.min(parseInt(limit, 10) || 50, 200);
                res.json(entries.slice(-maxEntries));
            } catch (error) {
                res.status(500).json({ error: 'Failed to fetch logbook entries', message: error.message });
            }
        });


        // LLM test — rate-limited as AI operation
        router.post('/llm/test', rateLimit(analysisLimiter), async (req, res) => {
            if (!components.llm) {
                return res.status(503).json({ error: 'LLM not initialized' });
            }

            const rawPrompt = req.body.prompt;
            if (!rawPrompt) return res.status(400).json({ error: 'Prompt is required' });
            if (typeof rawPrompt !== 'string') return res.status(400).json({ error: 'Prompt must be a string' });

            const prompt = sanitiseString(rawPrompt, 2000);
            if (prompt.length === 0) return res.status(400).json({ error: 'Prompt cannot be empty' });

            try {
                const response = await components.llm.generateCompletion(prompt, {});
                res.json({ response });
            } catch (error) {
                const isUnavailable = error.message.includes('LLM service not available');
                res.status(isUnavailable ? 503 : 500).json({
                    error: isUnavailable ? 'LLM service not available' : 'LLM request failed',
                    message: error.message
                });
            }
        });

        // Catch-all for unknown plugin routes
        router.use((req, res) => {
            res.status(404).json({ error: 'Endpoint not found', path: req.path });
        });
    };
    
    return plugin;
};
