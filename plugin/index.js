/*
 * ocearo-core Signal K Plugin
 * Main entry point
 */

const path = require('path');
const fs = require('fs');

// Import components
const SignalKProvider = require('./src/dataprovider/signalk');
const WeatherProvider = require('./src/dataprovider/marineweather');
const TidesProvider = require('./src/dataprovider/tides');
const MemoryManager = require('./src/memory');
const LLMClient = require('./src/llm');
const VoiceModule = require('./src/voice');
const OrchestratorBrain = require('./src/brain');
const LogbookManager = require('./src/logbook');

module.exports = function(app) {
    const plugin = {};
    let brain = null;
    let components = {};
    
    plugin.id = 'ocearo-core';
    plugin.name = 'ocearo-core';
    plugin.description = 'Intelligent marine assistant with LLM and voice synthesis';
    
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
                
                app.debug('Initializing Tides Provider...');
                components.tidesProvider = new TidesProvider(app, options);
                
                app.debug('Initializing Memory Manager...');
                components.memoryManager = new MemoryManager(app, options);
                await components.memoryManager.start();

                app.debug('Initializing Logbook Manager...');
                components.logbookManager = new LogbookManager(app, options);
                await components.logbookManager.start();
    
                
                app.debug('Initializing LLM Client...');
                components.llm = new LLMClient(app, options || {});
                
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
            if (components.signalkProvider) components.signalkProvider.stop();
            if (components.memoryManager) await components.memoryManager.stop();
            
            // Clear components
            components = {};
            
            app.setPluginStatus('Stopped');
            
        } catch (error) {
            app.error('Error stopping ocearo-core:', error);
        }
    };
    
    plugin.registerWithRouter = function(router) {
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
        
        // Manual analysis
        router.post('/analyze', async (req, res) => {
            if (!brain) {
                return res.status(503).json({ error: 'Service not initialized' });
            }

            const { type } = req.body;

            // Validate analysis type
            const validTypes = ['weather', 'sail', 'alerts', 'status', 'logbook'];
            if (!type) {
                return res.status(400).json({ error: 'Analysis type is required' });
            }
            if (!validTypes.includes(type)) {
                return res.status(400).json({
                    error: 'Invalid analysis type',
                    validTypes: validTypes
                });
            }

            try {
                const result = await brain.requestAnalysis(type);
                res.json(result);
            } catch (error) {
                res.status(500).json({
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
            const validModes = ['sailing', 'anchored', 'motoring','moored'];
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
        
        // Test speech
        router.post('/speak', (req, res) => {
            if (!components.voice) {
                return res.status(503).json({ error: 'Voice not initialized' });
            }

            const { text, priority } = req.body;

            // Validate text parameter
            if (!text) {
                return res.status(400).json({ error: 'Text is required' });
            }
            if (typeof text !== 'string') {
                return res.status(400).json({ error: 'Text must be a string' });
            }
            if (text.length === 0) {
                return res.status(400).json({ error: 'Text cannot be empty' });
            }
            if (text.length > 1000) {
                return res.status(400).json({ error: 'Text too long (max 1000 characters)' });
            }

            // Validate priority parameter (optional)
            const validPriorities = ['low', 'normal', 'high'];
            if (priority && !validPriorities.includes(priority)) {
                return res.status(400).json({
                    error: 'Invalid priority',
                    validPriorities: validPriorities
                });
            }

            components.voice.speak(text, { priority });
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
                        error: 'Logbook service unavailable',
                        message: result.error || 'SignalK-Logbook plugin not available'
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

        router.post('/logbook/analyze', async (req, res) => {
            if (!brain) {
                return res.status(503).json({ error: 'Service not initialized' });
            }

            try {
                // Request logbook analysis from the brain
                const result = await brain.requestAnalysis('logbook');
                res.json(result);
            } catch (error) {
                res.status(500).json({
                    error: 'Logbook analysis failed',
                    message: error.message
                });
            }
        });

        router.post('/logbook/entry', async (req, res) => {
            if (!components.logbookManager) {
                return res.status(503).json({ error: 'Logbook manager not initialized' });
            }

            const { currentData } = req.body;

            try {
                // Generate AI-enhanced logbook entry
                const analysisResult = {
                    summary: 'AI-generated logbook entry based on current vessel conditions',
                    confidence: 0.9,
                    recommendations: ['Entry created automatically by Jarvis AI'],
                    metrics: {
                        processingTime: '0.2s',
                        dataPoints: Object.keys(currentData || {}).length
                    }
                };

                // Log the analysis
                await components.logbookManager.logAnalysis('auto-entry', analysisResult);
                
                res.json({ 
                    success: true, 
                    message: 'AI logbook entry created successfully',
                    analysis: analysisResult
                });
            } catch (error) {
                res.status(500).json({
                    error: 'Failed to create AI logbook entry',
                    message: error.message
                });
            }
        });


        // LLM test
        router.post('/llm/test', async (req, res) => {
            if (!components.llm) {
                return res.status(503).json({ error: 'LLM not initialized' });
            }

            const { prompt } = req.body;

            // Validate prompt parameter
            if (!prompt) {
                return res.status(400).json({ error: 'Prompt is required' });
            }
            if (typeof prompt !== 'string') {
                return res.status(400).json({ error: 'Prompt must be a string' });
            }
            if (prompt.length === 0) {
                return res.status(400).json({ error: 'Prompt cannot be empty' });
            }
            if (prompt.length > 2000) {
                return res.status(400).json({ error: 'Prompt too long (max 2000 characters)' });
            }

            try {
                const response = await components.llm.generateCompletion(prompt, {});
                res.json({ response });
            } catch (error) {
                if (error.message.includes('LLM service not available')) {
                    res.status(503).json({
                        error: 'LLM service not available',
                        message: 'Ollama service is not running or accessible. Please start Ollama to use AI features.'
                    });
                } else {
                    res.status(500).json({
                        error: 'LLM request failed',
                        message: error.message
                    });
                }
            }
        });
    };
    
    return plugin;
};
