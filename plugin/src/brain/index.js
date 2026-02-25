/**
 * Orchestrator Brain Module
 *
 * Central coordinator for scheduled analyses, alert processing,
 * AIS collision monitoring, barometric pressure watch, navigation
 * mode management, failure prediction, and AI-powered logbook integration.
 * Acts as the core of the AI Copilot.
 */
const AlertAnalyzer = require('../analyses/alert');
const MeteoAnalyzer = require('../analyses/meteo');
const SailCourseAnalyzer = require('../analyses/sailcourse');
const SailSettingsAnalyzer = require('../analyses/sailsettings');
const AISAnalyzer = require('../analyses/ais');
const FailurePredictor = require('../analyses/failure');
const RoutePlanner = require('../analyses/route');
const LogbookManager = require('../logbook');
const AnchorPlugin = require('../anchor/anchor-plugin');

class OrchestratorBrain {
    constructor(app, config, components) {
        this.app = app;
        this.config = config;
        
        // Core components
        this.signalkProvider = components.signalkProvider;
        this.weatherProvider = components.weatherProvider;
        this.tidesProvider = components.tidesProvider;
        this.memoryManager = components.memoryManager;
        this.llm = components.llm;
        this.voice = components.voice;
        this.cm = components.configManager;
        
        // Logbook integration
        this.logbookManager = components.logbookManager;

        // Anchor plugin
        this.anchorPlugin = new AnchorPlugin(app, 'ocearo-core', config);
        this.anchorPlugin.onModeChange(mode => this.updateMode(mode));
        
        // Analysis modules — pass ConfigManager to all analyzers
        this.alertAnalyzer = new AlertAnalyzer(app, config, this.llm, this.memoryManager, this.cm);
        this.meteoAnalyzer = new MeteoAnalyzer(app, config, this.llm, 
            this.weatherProvider, this.tidesProvider, this.cm);
        this.sailCourseAnalyzer = new SailCourseAnalyzer(app, config, this.llm, this.cm);
        this.sailSettingsAnalyzer = new SailSettingsAnalyzer(app, config, this.llm, this.cm);
        this.aisAnalyzer = new AISAnalyzer(app, config, this.voice, this.cm);
        this.failurePredictor = new FailurePredictor(app, config, this.llm, this.cm);
        this.routePlanner = new RoutePlanner(app, config, this.llm, this.cm);
        
        // Scheduling intervals (ms)
        this.schedules = {
            alertCheck: (config.schedules?.alertCheck || 30) * 1000,
            weatherUpdate: (config.schedules?.weatherUpdate || 300) * 1000,
            sailAnalysis: (config.schedules?.sailAnalysis || 120) * 1000,
            aisCheck: (config.schedules?.aisCheck || 15) * 1000,
            failureCheck: (config.schedules?.failureCheck || 60) * 1000,
            memoryPersist: (config.schedules?.memoryPersist || 600) * 1000,
            navPoint: (config.schedules?.navPointMinutes || 30) * 60 * 1000,
            hourlyLogbook: 60 * 60 * 1000 // Fixed at 1 hour
        };
        
        // Timers
        this.timers = {};
        
        // State
        this.state = {
            mode: config.mode || 'sailing',
            lastWeatherAnalysis: null,
            lastSailAnalysis: null,
            lastAISCheck: null,
            lastFailureCheck: null,
            lastPressureTrend: null,
            alertsActive: 0,
            aisTargetsInRange: 0,
            started: false
        };

        // Logbook memory — persistent context loaded from logbook on startup
        this.logbookMemory = {
            lastWeatherBaseline: null,
            performanceBaseline: null,
            recentAlertsSummary: null,
            keelPosition: null,
            loadedAt: null
        };
    }

    /**
     * Start orchestrator
     */
    async start() {
        if (this.state.started) {
            this.app.debug('Orchestrator already started');
            return;
        }
        
        this.app.debug('Starting Orchestrator Brain');
        this.state.started = true;
      
        // Load persistent context from logbook
        await this._loadLogbookMemory();

        // Start anchor plugin (loads persisted state, resumes monitoring if needed)
        this.anchorPlugin.start();

        // Initialize components
        this.initializeSchedules();
        
        // Perform initial analyses
        await this.performInitialChecks();
        
        // Log startup to logbook
        await this.logSystemEvent('startup', {
            summary: 'System started',
            mode: this.state.mode,
            boat: this.cm?.boatValue('name', 'unknown'),
            confidence: 1.0
        });
        
        // Announce startup via ConfigManager
        const greeting = this.cm ? this.cm.getStartupMessage() : 'System ready.';
        this.voice.speak(greeting);
        
        // Schedule startup analysis if enabled
        if (this.config.startupAnalysis?.enabled !== false) {
            const delayMs = (this.config.startupAnalysis?.delaySeconds || 20) * 1000;
            this.timers.startupAnalysis = setTimeout(() => {
                this.performStartupAnalysis().catch(error => {
                    this.app.debug('Startup analysis failed:', error.message);
                });
            }, delayMs);
        }
    }

    /**
     * Stop orchestrator
     */
    async stop() {
        this.app.debug('Stopping Orchestrator Brain');
        this.state.started = false;
        
        // Clear all timers
        Object.values(this.timers).forEach(timer => clearInterval(timer));
        this.timers = {};
        
        // Stop anchor plugin
        this.anchorPlugin.stop();

        // Persist memory
        await this.memoryManager.persistData();
        
        // Save brain state to logbook before shutdown
        await this._storeLogbookMemory();

        // Log shutdown to logbook
        await this.logSystemEvent('shutdown', {
            summary: 'System shutdown',
            confidence: 1.0
        });
        
        // Announce shutdown via ConfigManager
        const farewell = this.cm ? this.cm.getShutdownMessage() : 'Shutting down.';
        this.voice.speak(farewell);
    }

    /**
     * Initialize scheduled tasks
     */
    initializeSchedules() {
        // Alert monitoring
        this.timers.alertCheck = setInterval(() => {
            this.checkAlerts();
        }, this.schedules.alertCheck);
        
        // Weather updates
        this.timers.weatherUpdate = setInterval(() => {
            this.updateWeather();
        }, this.schedules.weatherUpdate);
        
        // Sail analysis - create timer for any mode except anchored
        if (this.config.mode !== 'anchored') {
            this.timers.sailAnalysis = setInterval(() => {
                this.analyzeSailing();
            }, this.schedules.sailAnalysis);
        }
        
        // Memory persistence
        this.timers.memoryPersist = setInterval(() => {
            this.memoryManager.persistData();
        }, this.schedules.memoryPersist);
        
        // AIS collision monitoring (every 15 seconds by default)
        if (this.config.ais?.enabled !== false) {
            this.timers.aisCheck = setInterval(() => {
                this.checkAIS();
            }, this.schedules.aisCheck);
        }

        // Failure prediction monitoring
        if (this.config.failurePrediction?.enabled !== false) {
            this.timers.failureCheck = setInterval(() => {
                this.checkFailures();
            }, this.schedules.failureCheck);
        }
        
        // Navigation point updates (every 30 minutes by default)
        this.timers.navPoint = setInterval(() => {
            this.performNavigationPoint();
        }, this.schedules.navPoint);
        
        // Hourly logbook entries
        if (this.config.schedules?.hourlyLogbook !== false) {
            this.timers.hourlyLogbook = setInterval(() => {
                this.createHourlyLogbookEntry();
            }, this.schedules.hourlyLogbook);
        }
    }


    /**
     * Perform comprehensive startup analysis
     */
    async performStartupAnalysis() {
        if (!this.state.started) return;
        
        this.app.debug('Starting comprehensive startup analysis');
        
        try {
            const vesselData = await this.signalkProvider.getVesselData();
            const context = this.memoryManager.getContext();
            const startupConfig = this.config.startupAnalysis || {};
            
            const analysisResults = {
                weather: null,
                tides: null,
                sailRecommendations: null,
                tankLevels: null,
                batteryLevels: null
            };
            
            // Weather forecast analysis
            if (startupConfig.includeWeatherForecast !== false) {
                try {
                    analysisResults.weather = await this.meteoAnalyzer.analyzeConditions(vesselData, context);
                    this.app.debug('Startup weather analysis completed');
                } catch (error) {
                    this.app.debug('Startup weather analysis failed:', error.message);
                }
            }
            
            // Tide information
            if (startupConfig.includeTides !== false && this.tidesProvider) {
                try {
                    analysisResults.tides = await this.tidesProvider.getTideData();
                    this.app.debug('Startup tide analysis completed');
                } catch (error) {
                    this.app.debug('Startup tide analysis failed:', error.message);
                }
            }
            
            // Sail recommendations
            if (startupConfig.includeSailRecommendations !== false && vesselData.speed > 0.5) {
                try {
                    const windData = {
                        speed: vesselData.wind?.speed || 0,
                        direction: vesselData.wind?.direction || 0
                    };
                    analysisResults.sailRecommendations = await this.sailSettingsAnalyzer.analyzeSailSettings(
                        vesselData, windData, context
                    );
                    this.app.debug('Startup sail analysis completed');
                } catch (error) {
                    this.app.debug('Startup sail analysis failed:', error.message);
                }
            }
            
            // Tank levels
            if (startupConfig.includeTankLevels !== false) {
                try {
                    analysisResults.tankLevels = await this.getTankLevels();
                    this.app.debug('Startup tank analysis completed');
                } catch (error) {
                    this.app.debug('Startup tank analysis failed:', error.message);
                }
            }
            
            // Battery levels
            if (startupConfig.includeBatteryLevels !== false) {
                try {
                    analysisResults.batteryLevels = await this.getBatteryLevels();
                    this.app.debug('Startup battery analysis completed');
                } catch (error) {
                    this.app.debug('Startup battery analysis failed:', error.message);
                }
            }
            
            // Generate comprehensive startup report
            const startupReport = this.generateStartupReport(analysisResults, startupConfig);
            
            // Speak the analysis if enabled
            if (startupConfig.speakAnalysis !== false && startupReport.speech) {
                this.voice.speak(startupReport.speech, { priority: 'normal' });
            }
            
            // Log startup analysis to logbook
            await this.logAnalysisToLogbook('startup_analysis', {
                summary: startupReport.summary,
                confidence: startupReport.confidence,
                analysisResults,
                timestamp: new Date().toISOString(),
                manual: false,
                requestType: 'automatic_startup_analysis'
            });
            
            this.app.debug('Comprehensive startup analysis completed');
            
        } catch (error) {
            this.app.error('Startup analysis encountered error:', error);
        }
    }

    /**
     * Perform initial system checks
     */
    async performInitialChecks() {
        try {
            // Get initial vessel data
            const vesselData = await this.signalkProvider.getVesselData();

            // Initial weather check (non-blocking)
            this.updateWeather().catch(error => {
                this.app.debug('Initial weather check failed, continuing:', error.message);
            });

            // Check for any existing alerts (non-blocking)
            this.checkAlerts().catch(error => {
                this.app.debug('Initial alert check failed, continuing:', error.message);
            });

            // Initial sail analysis if underway (non-blocking)
            if (vesselData.speed > 1) {
                this.analyzeSailing().catch(error => {
                    this.app.debug('Initial sail analysis failed, continuing:', error.message);
                });
            }

            // Initial AIS scan (non-blocking)
            if (this.config.ais?.enabled !== false) {
                this.checkAIS().catch(error => {
                    this.app.debug('Initial AIS scan failed, continuing:', error.message);
                });
            }

            // Initial failure prediction check (non-blocking)
            if (this.config.failurePrediction?.enabled !== false) {
                this.checkFailures().catch(error => {
                    this.app.debug('Initial failure check failed, continuing:', error.message);
                });
            }
        } catch (error) {
            this.app.debug('Initial vessel data fetch failed, skipping initial checks:', error.message);
        }
    }

    /**
     * Check for potential system failures
     */
    async checkFailures() {
        if (!this.state.started) return;

        try {
            const vesselData = await this.signalkProvider.getVesselData();
            const result = await this.failurePredictor.analyzeSystems(vesselData);

            this.state.lastFailureCheck = result;

            if (result.status === 'at_risk') {
                // Speak expert advice
                if (result.expertAdvice && result.expertAdvice.length > 0) {
                    const criticalAdvice = result.expertAdvice.filter(a => a.priority === 'critical');
                    const adviceToSpeak = criticalAdvice.length > 0 ? criticalAdvice : [result.expertAdvice[0]];
                    
                    for (const advice of adviceToSpeak) {
                        this.voice.speak(advice.message, { priority: advice.priority });
                    }
                }

                // Try LLM-enriched analysis
                if (result.analysis && result.analysis.speech) {
                    this.voice.speak(result.analysis.speech, { priority: 'high' });
                }

                // Log failure risks to logbook
                await this.logAnalysisToLogbook('maintenance', {
                    summary: 'System Failure Risk Detected',
                    confidence: 0.9,
                    issues: result.issues,
                    warnings: result.warnings
                });

                // Store in memory
                this.memoryManager.addAlert({
                    type: 'system_failure_risk',
                    category: 'maintenance',
                    issues: result.issues,
                    warnings: result.warnings,
                    timestamp: new Date().toISOString()
                });
            }
        } catch (error) {
            this.app.debug('Failure check error:', error.message);
        }
    }

    /**
     * Check AIS targets for collision risks.
     * Runs frequently (every 15s) to detect developing situations early.
     */
    async checkAIS() {
        if (!this.state.started) return;

        try {
            const vesselData = this.signalkProvider.getVesselData();
            const result = this.aisAnalyzer.checkCollisionRisks(vesselData);

            this.state.aisTargetsInRange = result.totalInRange;
            this.state.lastAISCheck = {
                dangerCount: result.dangerCount,
                cautionCount: result.cautionCount,
                totalInRange: result.totalInRange,
                timestamp: new Date().toISOString()
            };

            if (result.alerts.length > 0) {
                // Voice announcement for collision risks
                if (result.speech) {
                    this.voice.speak(result.speech, { priority: 'critical' });
                }

                // Try LLM-enriched analysis for danger-level targets
                const dangerTargets = result.targets.filter(t => t.risk === 'danger');
                if (dangerTargets.length > 0) {
                    try {
                        const llmAnalysis = await this.llm.analyzeCollisionRisk(dangerTargets, {
                            speed: this._extractSOG(vesselData),
                            heading: this._extractCOG(vesselData)
                        });
                        if (llmAnalysis) {
                            this.voice.speak(llmAnalysis, { priority: 'critical' });
                        }
                    } catch (error) {
                        this.app.debug('LLM AIS analysis skipped:', error.message);
                    }
                }

                // Log collision risks to logbook
                for (const alert of result.alerts) {
                    if (alert.severity === 'alarm') {
                        await this.logAnalysisToLogbook('safety', {
                            summary: alert.message,
                            confidence: 0.95,
                            aisTarget: alert.target,
                            cpa: alert.cpa,
                            tcpa: alert.tcpa,
                            colregs: alert.colregs
                        });
                    }
                }

                // Store in memory
                this.memoryManager.addAlert({
                    type: 'ais_collision_risk',
                    category: 'safety',
                    targets: result.alerts.map(a => a.target),
                    dangerCount: result.dangerCount,
                    timestamp: new Date().toISOString()
                });
            }

            // Periodic cleanup of AIS announcement cooldowns
            this.aisAnalyzer.cleanup();

        } catch (error) {
            this.app.debug('AIS check error:', error.message);
        }
    }

    /**
     * Extract SOG in knots from raw vessel data.
     */
    _extractSOG(vesselData) {
        const sog = vesselData?.navigation?.speedOverGround;
        return typeof sog === 'number' ? sog * 1.94384 : null;
    }

    /**
     * Extract COG in degrees from raw vessel data.
     */
    _extractCOG(vesselData) {
        const cog = vesselData?.navigation?.courseOverGroundTrue;
        return typeof cog === 'number' ? cog * (180 / Math.PI) : null;
    }

    /**
     * Check for and process alerts
     */
    async checkAlerts() {
        if (!this.state.started) return;

        try {
            const notifications = this.signalkProvider.getNotifications();
            const vesselData = await this.signalkProvider.getVesselData();
            const context = this.memoryManager.getContext();

            // Process each notification
            for (const notification of notifications) {
                try {
                    const result = await this.alertAnalyzer.processAlert(
                        notification,
                        vesselData,
                        context
                    );

                    if (result && result.shouldSpeak) {
                        this.voice.announce(result.speech, result.priority);
                    }

                    // Update memory if important
                    if (result && (result.severity === 'alarm' || result.severity === 'emergency')) {
                        this.memoryManager.addAlert({
                            ...result,
                            timestamp: new Date().toISOString()
                        });

                        // Log critical alerts to logbook
                        await this.logAnalysisToLogbook('alert', result);
                    }
                } catch (error) {
                    this.app.debug('Failed to process individual alert, continuing:', error.message);
                }
            }

            // Update alert count
            this.state.alertsActive = notifications.filter(n =>
                n.state === 'alarm' || n.state === 'emergency'
            ).length;

        } catch (error) {
            this.app.debug('Alert check encountered error, will retry later:', error.message);
        }
    }

    /**
     * Update weather analysis
     */
    async updateWeather() {
        if (!this.state.started) return;

        try {
            const vesselData = await this.signalkProvider.getVesselData();
            const context = this.memoryManager.getContext();

            // Perform weather analysis
            const analysis = await this.meteoAnalyzer.analyzeConditions(
                vesselData,
                context
            );

            this.state.lastWeatherAnalysis = analysis;

            // Check for significant changes
            if (this.shouldAnnounceWeather(analysis)) {
                this.voice.speak(analysis.analysis?.speech || analysis.speech);
            }

            // Store significant weather events
            if (analysis.assessment.alerts.length > 0) {
                this.memoryManager.addNavigationEntry({
                    type: 'weather_change',
                    data: analysis.assessment,
                    timestamp: new Date().toISOString()
                });
            }

            // Log significant weather analysis to logbook
            if (this.shouldLogWeatherAnalysis(analysis)) {
                await this.logAnalysisToLogbook('weather', analysis);
            }

        } catch (error) {
            // Handle LLM-related errors more gracefully
            if (error.message.includes('LLM service not available')) {
                this.app.debug('Weather analysis completed with basic functionality (LLM unavailable)');
            } else {
                this.app.debug('Weather update completed with fallback:', error.message);
            }
        }
    }

    /**
     * Perform navigation point update (every 30 minutes)
     * Reports current position, speed, course, depth, and weather summary
     */
    async performNavigationPoint() {
        if (!this.state.started) return;
        
        try {
            const vesselData = await this.signalkProvider.getVesselData();
            
            const nav = vesselData.navigation || {};
            const env = vesselData.environment || {};
            
            const speed = nav.speedOverGround !== undefined 
                ? (nav.speedOverGround * 1.94384).toFixed(1) 
                : null;
            const course = nav.courseOverGroundTrue !== undefined 
                ? Math.round(nav.courseOverGroundTrue * 180 / Math.PI) 
                : null;
            const depth = env.depth?.belowKeel !== undefined 
                ? env.depth.belowKeel.toFixed(1) 
                : null;
            
            let message;
            if (speed !== null && course !== null && depth !== null) {
                const ktsLabel = this.cm.t('units.knots_abbr');
                message = `SOG ${speed} ${ktsLabel}, COG ${course}°, ${depth}m`;
            } else {
                message = this.cm.t('general.no_data');
            }
            
            // Speak the navigation point if configured
            if (this.config.schedules?.speakNavPoint !== false) {
                this.voice.speak(message, { priority: 'low' });
            }
            
            // Add to navigation history
            this.memoryManager.addNavigationEntry({
                type: 'nav_point',
                data: {
                    speed: speed ? parseFloat(speed) : null,
                    course,
                    depth: depth ? parseFloat(depth) : null,
                    position: nav.position
                },
                timestamp: new Date().toISOString()
            });
            
            this.app.debug('Navigation point recorded');
            
        } catch (error) {
            this.app.debug('Navigation point failed:', error.message);
        }
    }

    /**
     * Create hourly logbook entry
     * Automatically records vessel state to the logbook every hour
     */
    async createHourlyLogbookEntry() {
        if (!this.state.started) return;
        
        try {
            const vesselData = await this.signalkProvider.getVesselData();
            const language = this.config.language || 'en';
            
            // Extract data for logbook entry
            const nav = vesselData.navigation || {};
            const env = vesselData.environment || {};
            
            const position = nav.position;
            const speed = nav.speedOverGround !== undefined 
                ? (nav.speedOverGround * 1.94384).toFixed(1) 
                : 'N/A';
            const course = nav.courseOverGroundTrue !== undefined 
                ? Math.round(nav.courseOverGroundTrue * 180 / Math.PI) 
                : 'N/A';
            const heading = nav.headingTrue !== undefined 
                ? Math.round(nav.headingTrue * 180 / Math.PI) 
                : null;
            const depth = env.depth?.belowKeel !== undefined 
                ? env.depth.belowKeel.toFixed(1) 
                : null;
            const windSpeed = env.wind?.speedApparent !== undefined 
                ? (env.wind.speedApparent * 1.94384).toFixed(1) 
                : null;
            const windAngle = env.wind?.angleApparent !== undefined 
                ? Math.round(env.wind.angleApparent * 180 / Math.PI) 
                : null;
            
            // Format position for display
            const positionStr = position 
                ? `${position.latitude?.toFixed(4)}°, ${position.longitude?.toFixed(4)}°`
                : 'Unknown';
            
            // Build summary
            const summary = `${positionStr}, SOG ${speed}, COG ${course}°`;
            
            // Create logbook entry
            const logEntry = {
                summary,
                confidence: 1.0,
                metrics: {
                    speed: speed !== 'N/A' ? parseFloat(speed) : null,
                    course: course !== 'N/A' ? course : null,
                    heading,
                    depth: depth ? parseFloat(depth) : null,
                    windSpeed: windSpeed ? parseFloat(windSpeed) : null,
                    windAngle
                },
                position,
                automatic: true,
                entryType: 'hourly'
            };
            
            // Log to logbook
            await this.logbookManager.logAnalysis('hourly_entry', logEntry);
            
            // Optionally speak confirmation
            if (this.config.schedules?.speakHourlyLog) {
                this.voice.speak(this.cm.t('logbook.memory_note', { note: 'hourly' }), { priority: 'low' });
            }
            
            this.app.debug('Hourly logbook entry created');
            
        } catch (error) {
            this.app.debug('Hourly logbook entry failed:', error.message);
        }
    }

    /**
     * Analyze sailing performance and course
     */
    async analyzeSailing() {
        if (!this.state.started || this.config.mode === 'anchored') return;
        
        try {
            const vesselData = await this.signalkProvider.getVesselData();
            const context = this.memoryManager.getContext();
            let courseAnalysis = null;
            
            // Get wind data
            const windData = {
                speed: vesselData.wind?.speed || 0,
                direction: vesselData.wind?.direction || 0
            };
            
            // Course analysis if destination set
            if (context.destination?.waypoint) {
                const targetBearing = this.calculateBearing(
                    vesselData.position,
                    context.destination.waypoint
                );
                
                courseAnalysis = await this.sailCourseAnalyzer.analyzeCourse(
                    vesselData,
                    targetBearing,
                    windData,
                    context
                );
                
                // Announce course changes if recommended
                if (courseAnalysis.recommended.changeWorthwhile) {
                    const message = courseAnalysis.analysis?.speech || courseAnalysis.analysis || 
                        courseAnalysis.recommended.recommendation.message;
                    this.voice.speak(message);
                }

                // Log significant course recommendations
                if (courseAnalysis.recommended.changeWorthwhile) {
                    await this.logAnalysisToLogbook('navigation', courseAnalysis);
                }
            }
            
            // Sail settings analysis
            const settingsAnalysis = await this.sailSettingsAnalyzer.analyzeSailSettings(
                vesselData,
                windData,
                context
            );
            
            // Announce critical adjustments
            const criticalAdjustments = settingsAnalysis.adjustments.filter(
                adj => adj.priority === 'high'
            );
            
            if (criticalAdjustments.length > 0) {
                const settingsMessage = settingsAnalysis.analysis?.speech || settingsAnalysis.analysis || 
                    criticalAdjustments.map(adj => adj.action).join('. ');
                this.voice.speak(settingsMessage);

                // Log sail setting recommendations
                await this.logAnalysisToLogbook('performance', settingsAnalysis);
            }
            
            this.state.lastSailAnalysis = {
                course: courseAnalysis,
                settings: settingsAnalysis,
                timestamp: new Date().toISOString()
            };
            
        } catch (error) {
            this.app.error('Sail analysis failed:', error);
        }
    }

    /**
     * Handle manual analysis request
     */
    async requestAnalysis(type) {
        try {
            const vesselData = await this.signalkProvider.getVesselData();
            const context = this.memoryManager.getContext();

            switch (type) {
                case 'weather': {
                    const weatherAnalysis = await this.meteoAnalyzer.analyzeConditions(
                        vesselData,
                        context
                    );
                    this.voice.speak(weatherAnalysis.analysis?.speech || weatherAnalysis.speech, { priority: 'high' });
                    
                    // Always log manual weather requests
                    await this.logAnalysisToLogbook('weather', {
                        ...weatherAnalysis,
                        manual: true,
                        requestType: 'manual_weather_analysis'
                    });
                    
                    return weatherAnalysis;
                }
                case 'sail': {
                    await this.analyzeSailing();
                    
                    const sailResult = this.state.lastSailAnalysis;

                    // Log manual sail analysis
                    if (sailResult) {
                        await this.logAnalysisToLogbook('navigation', {
                            ...sailResult,
                            manual: true,
                            requestType: 'manual_sail_analysis'
                        });
                    }

                    if (!sailResult) {
                        const fallback = {
                            analysis: this.cm.t('general.analysis_failed') || 'Sail analysis could not be completed. Check wind data and vessel mode.',
                            speech: this.cm.t('general.analysis_failed') || 'Sail analysis could not be completed.',
                            timestamp: new Date().toISOString(),
                            settings: { adjustments: [] },
                            course: null
                        };
                        this.voice.speak(fallback.speech, { priority: 'normal' });
                        return fallback;
                    }

                    // Speak the sail analysis result
                    const sailSpeech = sailResult.settings?.analysis?.speech || sailResult.course?.analysis?.speech;
                    if (sailSpeech) {
                        this.voice.speak(sailSpeech, { priority: 'high' });
                    }

                    return sailResult;
                }
                case 'alerts': {
                    const alerts = this.memoryManager.getRecentAlerts(1);
                    const summary = this.alertAnalyzer.getAlertSummary(alerts);
                    this.voice.speak(summary, { priority: 'high' });
                    
                    // Log alert summary request
                    await this.logAnalysisToLogbook('safety', {
                        summary: summary,
                        alertCount: alerts.length,
                        manual: true,
                        requestType: 'manual_alert_summary'
                    });
                    
                    return { alerts, summary };
                }
                case 'route': {
                    const weatherData = this.state.lastWeatherAnalysis?.data || await this.weatherProvider.getWeatherData();
                    const routeAnalysis = await this.routePlanner.planRoute(vesselData, weatherData, context);
                    
                    if (routeAnalysis.status === 'planned') {
                        const message = routeAnalysis.analysis?.speech || `Route to destination planned. Distance: ${routeAnalysis.distanceNM} nautical miles, Bearing: ${routeAnalysis.bearing} degrees, ETA: ${routeAnalysis.etaHours} hours.`;
                        this.voice.speak(message, { priority: 'high' });
                        
                        await this.logAnalysisToLogbook('navigation', {
                            summary: 'Route planned',
                            distanceNM: routeAnalysis.distanceNM,
                            etaHours: routeAnalysis.etaHours,
                            manual: true,
                            requestType: 'manual_route_analysis'
                        });
                    } else {
                        this.voice.speak(routeAnalysis.message, { priority: 'normal' });
                    }
                    
                    return routeAnalysis;
                }
                case 'ais': {
                    const vesselDataAIS = this.signalkProvider.getVesselData();
                    const aisResult = this.aisAnalyzer.checkCollisionRisks(vesselDataAIS);
                    let aisSpeech;
                    if (aisResult.totalInRange === 0) {
                        aisSpeech = this.cm.t('ais.no_targets');
                    } else {
                        aisSpeech = this.cm.t('ais.summary', {
                            total: aisResult.totalInRange,
                            danger: aisResult.dangerCount,
                            caution: aisResult.cautionCount
                        });
                        if (aisResult.speech) {
                            aisSpeech += ' ' + aisResult.speech;
                        }
                    }
                    this.voice.speak(aisSpeech, { priority: 'high' });
                    return { ...aisResult, speech: aisSpeech };
                }
                case 'status': {
                    const status = this.getSystemStatus();
                    const statusMessage = this.formatStatusMessage(status);
                    this.voice.speak(statusMessage, { priority: 'high' });
                    
                    // Log system status request
                    await this.logAnalysisToLogbook('maintenance', {
                        summary: statusMessage,
                        systemStatus: status,
                        manual: true,
                        requestType: 'manual_status_check'
                    });
                    
                    return status;
                }
                case 'logbook': {
                    // Get recent logbook entries for analysis
                    const entries = await this.logbookManager.getAnalysisEntries();
                    
                    // Perform comprehensive logbook analysis
                    const logbookAnalysis = await this.analyzeLogbookEntries(entries, vesselData, context);
                    
                    // Speak the summary
                    if (logbookAnalysis.speech) {
                        this.voice.speak(logbookAnalysis.speech, { priority: 'high' });
                    }
                    
                    // Log the logbook analysis
                    await this.logAnalysisToLogbook('logbook_review', {
                        ...logbookAnalysis,
                        manual: true,
                        requestType: 'manual_logbook_analysis',
                        entriesAnalyzed: entries.length
                    });
                    
                    return logbookAnalysis;
                }
                default:
                    throw new Error(`Unknown analysis type: ${type}`);
            }
        } catch (error) {
            if (error.message.includes('LLM service not available')) {
                this.app.debug(`Manual analysis ${type} skipped - LLM service not available`);
                this.voice.speak(this.cm.t('general.ai_unavailable'), { priority: 'high' });
                throw new Error('AI service unavailable');
            } else {
                this.app.debug(`Manual analysis ${type} failed:`, error.message);
                this.voice.speak(this.cm.t('general.analysis_failed'));
                throw error;
            }
        }
    }

    /**
     * Update operating mode.
     * Notifies the anchor plugin so it can manage alarm lifecycle and
     * emit mode-change warnings if the anchor is still deployed.
     */
    updateMode(mode) {
        const validModes = ['sailing', 'anchored', 'motoring', 'moored', 'racing'];

        if (!validModes.includes(mode)) {
            throw new Error(`Invalid mode: ${mode}. Valid modes are: ${validModes.join(', ')}`);
        }
        
        const previousMode = this.state.mode;
        this.state.mode = mode;

        // Delegate anchor lifecycle to AnchorPlugin
        try {
            this.anchorPlugin.handleModeChange(mode);
        } catch (error) {
            this.app.debug('Error in anchor mode change handler:', error.message);
        }
        
        // Adjust schedules based on mode
        if (mode === 'anchored' || mode === 'moored') {
            // Stop sail analysis
            if (this.timers.sailAnalysis) {
                clearInterval(this.timers.sailAnalysis);
                delete this.timers.sailAnalysis;
            }
        } else if (!this.timers.sailAnalysis) {
            // Restart sail analysis
            this.timers.sailAnalysis = setInterval(() => {
                this.analyzeSailing();
            }, this.schedules.sailAnalysis);
        }
        
        // Log mode change
        this.logSystemEvent('mode_change', {
            summary: `Mode: ${previousMode} -> ${mode}`,
            previousMode,
            newMode: mode,
            confidence: 1.0
        });
        
        const localizedMode = this.cm.t(`mode.${mode}`);
        this.voice.speak(this.cm.t('mode.changed', { mode: localizedMode }));
    }

    /**
     * Log analysis results to SignalK-Logbook
     */
    async logAnalysisToLogbook(analysisType, result) {
        try {
            // Prepare analysis data for logbook
            const analysisData = {
                summary: result.analysis?.text || result.text || result.analysis?.speech || result.speech || result.summary || 'Analysis completed',
                confidence: result.confidence || this.calculateConfidence(result),
                recommendations: this.extractRecommendations(result),
                metrics: this.extractMetrics(result),
                timestamp: new Date().toISOString()
            };

            // Add analysis-specific metadata
            if (result.assessment) {
                analysisData.assessment = result.assessment;
            }
            if (result.recommended) {
                analysisData.recommended = result.recommended;
            }
            if (result.adjustments) {
                analysisData.adjustments = result.adjustments;
            }
            if (result.manual) {
                analysisData.manual = true;
                analysisData.requestType = result.requestType;
            }

            await this.logbookManager.logAnalysis(analysisType, analysisData);
            this.app.debug(`Analysis logged to logbook: ${analysisType}`);
            
        } catch (error) {
            this.app.debug('Failed to log analysis to logbook:', error.message);
        }
    }

    /**
     * Log system events to logbook
     */
    async logSystemEvent(eventType, data) {
        try {
            await this.logbookManager.logAnalysis(eventType, {
                summary: data.summary,
                confidence: data.confidence || 1.0,
                systemEvent: true,
                ...data
            });
        } catch (error) {
            this.app.debug('Failed to log system event to logbook:', error.message);
        }
    }

    /**
     * Extract recommendations from analysis result
     */
    extractRecommendations(result) {
        const recommendations = [];
        
        if (result.recommended?.recommendation?.message) {
            recommendations.push(result.recommended.recommendation.message);
        }
        
        if (result.adjustments) {
            recommendations.push(...result.adjustments
                .filter(adj => adj.priority === 'high')
                .map(adj => adj.action)
            );
        }
        
        if (result.assessment?.alerts) {
            recommendations.push(...result.assessment.alerts
                .map(alert => alert.recommendation)
                .filter(Boolean)
            );
        }
        
        return recommendations.length > 0 ? recommendations : undefined;
    }

    /**
     * Extract metrics from analysis result
     */
    extractMetrics(result) {
        const metrics = {};
        
        if (result.assessment) {
            if (result.assessment.windStrength) {
                metrics.windStrength = result.assessment.windStrength;
            }
            if (result.assessment.seaState) {
                metrics.seaState = result.assessment.seaState;
            }
            if (result.assessment.visibility) {
                metrics.visibility = result.assessment.visibility;
            }
        }
        
        if (result.recommended?.efficiency) {
            metrics.efficiency = result.recommended.efficiency;
        }
        
        if (result.performance) {
            Object.assign(metrics, result.performance);
        }
        
        return Object.keys(metrics).length > 0 ? metrics : undefined;
    }

    /**
     * Calculate confidence score for analysis
     */
    calculateConfidence(result) {
        let confidence = 0.5; // Base confidence
        
        // Higher confidence for analyses with multiple data points
        if (result.assessment) confidence += 0.2;
        if (result.recommended) confidence += 0.2;
        if (result.adjustments && result.adjustments.length > 0) confidence += 0.1;
        
        // Lower confidence if LLM service issues
        if (!this.llm.isConnected()) confidence -= 0.3;
        
        return Math.max(0.1, Math.min(1.0, confidence));
    }

    /**
     * Check if weather analysis should be logged
     */
    shouldLogWeatherAnalysis(analysis) {
        // Log if there are alerts
        if (analysis.assessment.alerts && analysis.assessment.alerts.length > 0) return true;
        
        // Log if significant trend changes
        if (analysis.assessment.trend?.overall === 'deteriorating') return true;
        if (analysis.assessment.trend?.overall === 'improving' && 
            this.state.lastWeatherAnalysis?.assessment.trend?.overall === 'deteriorating') return true;
        
        // Log if wind strength changed significantly
        if (this.state.lastWeatherAnalysis && 
            analysis.assessment.windStrength !== this.state.lastWeatherAnalysis.assessment.windStrength) return true;
        
        return false;
    }


    /**
     * Check if weather should be announced.
     * Enhanced with Beaufort force changes and pressure trend awareness.
     */
    shouldAnnounceWeather(analysis) {
        // Always announce on first analysis
        if (!this.state.lastWeatherAnalysis) return true;
        
        const prev = this.state.lastWeatherAnalysis;
        const prevAssessment = prev.assessment || {};
        const currAssessment = analysis.assessment || {};
        
        // Beaufort force changed
        if (currAssessment.beaufort?.force !== prevAssessment.beaufort?.force) return true;
        
        // Wind strength category changed
        if (currAssessment.windStrength !== prevAssessment.windStrength) return true;
        
        // Sea state changed
        if (currAssessment.seaState !== prevAssessment.seaState) return true;
        
        // New alerts appeared
        if ((currAssessment.alerts?.length || 0) > (prevAssessment.alerts?.length || 0)) return true;
        
        // Overall trend changed
        if (currAssessment.trend?.overall !== prevAssessment.trend?.overall) return true;
        
        // Pressure trend changed significantly
        if (currAssessment.pressure?.trend !== prevAssessment.pressure?.trend) {
            const significantChanges = ['falling_fast', 'rising_fast', 'falling'];
            if (significantChanges.includes(currAssessment.pressure?.trend)) return true;
        }
        
        // Squall risk escalated
        if (currAssessment.squallRisk === 'high' && prevAssessment.squallRisk !== 'high') return true;
        
        // Wind-against-tide danger appeared
        if (currAssessment.windAgainstTide?.danger && !prevAssessment.windAgainstTide?.danger) return true;
        
        // Expert advice appeared where there was none
        if ((currAssessment.expertAdvice?.length || 0) > 0 && 
            (prevAssessment.expertAdvice?.length || 0) === 0) return true;
        
        return false;
    }

    /**
     * Calculate bearing between two positions
     */
    calculateBearing(from, to) {
        const dLon = (to.longitude - from.longitude) * Math.PI / 180;
        const lat1 = from.latitude * Math.PI / 180;
        const lat2 = to.latitude * Math.PI / 180;
        
        const y = Math.sin(dLon) * Math.cos(lat2);
        const x = Math.cos(lat1) * Math.sin(lat2) -
                 Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
        
        const bearing = Math.atan2(y, x) * 180 / Math.PI;
        return (bearing + 360) % 360;
    }

    /**
     * Get system status including AIS, pressure and anchor data.
     */
    getSystemStatus() {
        const weatherAssessment = this.state.lastWeatherAnalysis?.assessment;
        return {
            mode: this.state.mode,
            started: this.state.started,
            alertsActive: this.state.alertsActive,
            lastWeatherUpdate: this.state.lastWeatherAnalysis?.timestamp,
            lastSailAnalysis: this.state.lastSailAnalysis?.timestamp,
            llmConnected: this.llm.isConnected(),
            voiceEnabled: this.voice.enabled,
            memorySize: this.memoryManager.getStatistics(),
            logbookConnected: this.logbookManager.isConnected,
            logbookBackend: this.logbookManager.backend,
            ais: this.state.lastAISCheck || { totalInRange: 0 },
            anchor: {
                state: this.anchorPlugin.getState(),
                currentRadius: this.anchorPlugin.getCurrentRadius(),
                dragging: this.anchorPlugin.isDropped() &&
                    this.anchorPlugin.getCurrentRadius() !== null &&
                    this.anchorPlugin.getCurrentRadius() > 0
            },
            weather: weatherAssessment ? {
                beaufort: weatherAssessment.beaufort?.force,
                windStrength: weatherAssessment.windStrength,
                seaState: weatherAssessment.seaState,
                pressure: weatherAssessment.pressure,
                squallRisk: weatherAssessment.squallRisk,
                trend: weatherAssessment.trend?.overall
            } : null
        };
    }

    /**
     * Format status message for speech, including AIS and weather.
     */
    formatStatusMessage(status) {
        const parts = [];
        
        const activeLabel = status.started ? this.cm.t('status.active') : this.cm.t('status.inactive');
        parts.push(`${this.cm.t('status.system')}: ${activeLabel}`);
        parts.push(`${this.cm.t('status.mode_label')}: ${this.cm.t(`mode.${status.mode}`)}`);
        
        if (status.alertsActive > 0) {
            parts.push(this.cm.t('status.alerts_count', { count: status.alertsActive }));
        }
        
        if (status.weather) {
            const bf = status.weather.beaufort;
            const trend = status.weather.trend;
            if (bf !== undefined) {
                const seaState = this.cm.t(`weather.sea_state.${status.weather.seaState}`) || status.weather.seaState;
                const trendStr = this.cm.t(`weather.trend.${trend}`) || trend || 'stable';
                parts.push(this.cm.t('status.weather_summary', { beaufort: bf, seaState, trend: trendStr }));
            }
            if (status.weather.squallRisk === 'high') {
                parts.push(this.cm.t('status.squall_risk_high'));
            }
        }
        
        if (status.ais && status.ais.totalInRange > 0) {
            parts.push(this.cm.t('status.ais_summary', {
                total: status.ais.totalInRange,
                danger: status.ais.dangerCount || 0
            }));
        }
        
        if (!status.llmConnected) {
            parts.push(this.cm.t('status.ai_offline'));
        }
        if (!status.logbookConnected) {
            parts.push(this.cm.t('status.logbook_offline'));
        }
        
        return parts.join('. ');
    }

    /**
     * Get tank levels from SignalK
     */
    async getTankLevels() {
        try {
            const tanks = {};
            
            // Common tank types to check
            const tankTypes = ['fuel', 'freshWater', 'wasteWater', 'blackWater', 'liveWell', 'ballast'];
            
            for (const tankType of tankTypes) {
                try {
                    const tankData = this.signalkProvider._getSelfPath(`tanks.${tankType}`);
                    if (tankData && typeof tankData === 'object') {
                        for (const [tankId, data] of Object.entries(tankData)) {
                            if (data && data.currentLevel !== undefined) {
                                const level = Math.round(data.currentLevel * 100);
                                const capacity = data.capacity || null;
                                tanks[`${tankType}_${tankId}`] = {
                                    type: tankType,
                                    level: level,
                                    capacity: capacity,
                                    status: level < 20 ? 'low' : level < 50 ? 'medium' : 'good'
                                };
                            }
                        }
                    }
                } catch (error) {
                    // Tank type not available, continue
                }
            }
            
            return tanks;
        } catch (error) {
            this.app.debug('Failed to get tank levels:', error.message);
            return {};
        }
    }

    /**
     * Get battery levels from SignalK
     */
    async getBatteryLevels() {
        try {
            const batteries = {};
            
            // Get electrical data using the vessel data method
            const vesselData = await this.signalkProvider.getVesselData();
            const electrical = vesselData.electrical;
            
            if (electrical && electrical.batteries) {
                for (const [batteryId, batteryData] of Object.entries(electrical.batteries)) {
                    if (batteryData) {
                        const voltage = batteryData.voltage?.value;
                        const current = batteryData.current?.value;
                        const capacity = batteryData.capacity?.stateOfCharge?.value;
                        
                        if (voltage !== undefined || capacity !== undefined) {
                            batteries[batteryId] = {
                                voltage: voltage ? Math.round(voltage * 10) / 10 : null,
                                current: current ? Math.round(current * 10) / 10 : null,
                                capacity: capacity ? Math.round(capacity * 100) : null,
                                status: this.getBatteryStatus(voltage, capacity)
                            };
                        }
                    }
                }
            }
            
            return batteries;
        } catch (error) {
            this.app.debug('Failed to get battery levels:', error.message);
            return {};
        }
    }

    /**
     * Determine battery status based on voltage and capacity
     */
    getBatteryStatus(voltage, capacity) {
        if (capacity !== undefined) {
            if (capacity < 0.2) return 'critical';
            if (capacity < 0.5) return 'low';
            if (capacity < 0.8) return 'medium';
            return 'good';
        }
        
        if (voltage !== undefined) {
            // Rough estimation for 12V system
            if (voltage < 11.8) return 'critical';
            if (voltage < 12.2) return 'low';
            if (voltage < 12.6) return 'medium';
            return 'good';
        }
        
        return 'unknown';
    }

    /**
     * Generate comprehensive startup report
     */
    generateStartupReport(analysisResults, config) {
        const parts = [];
        const summary = [];
        
        if (analysisResults.weather && config.includeWeatherForecast !== false) {
            const weather = analysisResults.weather;
            if (weather.speech) {
                parts.push(weather.speech);
                summary.push(`${this.cm.t('reports.weather')}: ${weather.assessment?.windStrength || 'ok'}`);
            }
        }
        
        if (analysisResults.tides && config.includeTides !== false) {
            const tides = analysisResults.tides;
            if (tides.next?.high || tides.next?.low) {
                const nextTide = tides.next.high && tides.next.low ? 
                    (tides.next.high.time < tides.next.low.time ? tides.next.high : tides.next.low) :
                    (tides.next.high || tides.next.low);
                
                const dateLocale = this.cm.t('meta.dateLocale') || 'en-US';
                const timeStr = nextTide.time.toLocaleTimeString(dateLocale, { hour: '2-digit', minute: '2-digit' });
                const heightStr = `${nextTide.height.toFixed(1)}m`;
                const typeStr = this.cm.t(`tides.${nextTide.type.toLowerCase()}`);

                parts.push(this.cm.t('tides.next', { type: typeStr, time: `${timeStr}, ${heightStr}` }));
                summary.push(`${this.cm.t('reports.tides')}: ${typeStr} ${timeStr}`);
            }
        }
        
        if (analysisResults.sailRecommendations && config.includeSailRecommendations !== false) {
            const sail = analysisResults.sailRecommendations;
            if (sail.adjustments && sail.adjustments.length > 0) {
                const highPri = sail.adjustments.filter(adj => adj.priority === 'high');
                if (highPri.length > 0) {
                    parts.push(`${this.cm.t('reports.sail')}: ${highPri.map(adj => adj.action).join(', ')}`);
                    summary.push(`${this.cm.t('reports.sail')}: ${this.cm.t('reports.recommendations_count', { count: highPri.length })}`);
                }
            }
        }
        
        if (analysisResults.tankLevels && config.includeTankLevels !== false) {
            const tanks = analysisResults.tankLevels;
            const criticalTanks = Object.entries(tanks).filter(([_, tank]) => tank.level < 10);
            const lowTanks = Object.entries(tanks).filter(([_, tank]) => tank.status === 'low');
            
            if (criticalTanks.length > 0) {
                parts.push(`${this.cm.t('reports.tanks')}: ${criticalTanks.map(([id, tank]) => `${tank.type} ${tank.level}%`).join(', ')}`);
                summary.push(`${this.cm.t('reports.tanks')}: ${this.cm.t('reports.tanks_critical', { count: criticalTanks.length })}`);
            } else if (lowTanks.length > 0) {
                summary.push(`${this.cm.t('reports.tanks')}: ${this.cm.t('reports.tanks_low', { count: lowTanks.length })}`);
            } else if (Object.keys(tanks).length > 0) {
                summary.push(`${this.cm.t('reports.tanks')}: ${this.cm.t('reports.tanks_good')}`);
            }
        }
        
        if (analysisResults.batteryLevels && config.includeBatteryLevels !== false) {
            const batteries = analysisResults.batteryLevels;
            const lowBatteries = Object.entries(batteries).filter(([_, b]) => 
                b.status === 'low' || b.status === 'critical'
            );
            
            if (lowBatteries.length > 0) {
                const info = lowBatteries.map(([id, b]) => {
                    const vals = [];
                    if (b.capacity !== null) vals.push(`${b.capacity}%`);
                    if (b.voltage !== null) vals.push(`${b.voltage}V`);
                    return `${id} ${vals.join(' ')}`;
                }).join(', ');
                parts.push(`${this.cm.t('reports.batteries')}: ${info}`);
                summary.push(`${this.cm.t('reports.batteries')}: ${this.cm.t('reports.batteries_attention', { count: lowBatteries.length })}`);
            } else if (Object.keys(batteries).length > 0) {
                summary.push(`${this.cm.t('reports.batteries')}: ${this.cm.t('reports.batteries_good')}`);
            }
        }
        
        let confidence = 0.5;
        if (analysisResults.weather) confidence += 0.2;
        if (analysisResults.tides) confidence += 0.1;
        if (analysisResults.sailRecommendations) confidence += 0.1;
        if (Object.keys(analysisResults.tankLevels || {}).length > 0) confidence += 0.05;
        if (Object.keys(analysisResults.batteryLevels || {}).length > 0) confidence += 0.05;
        
        const baseMessage = this.cm.t('general.startup_complete');
        
        return {
            speech: parts.length > 0 ? `${baseMessage}. ${parts.join('. ')}` : baseMessage,
            summary: summary.length > 0 ? summary.join('; ') : baseMessage,
            confidence: Math.min(1.0, confidence)
        };
    }

    /**
     * Analyze logbook entries to provide insights and recommendations
     */
    async analyzeLogbookEntries(entries, vesselData, context) {
        try {
            if (!entries || entries.length === 0) {
                return {
                    speech: this.cm.t('logbook.no_entries'),
                    summary: this.cm.t('logbook.no_entries'),
                    confidence: 1.0,
                    insights: [],
                    recommendations: []
                };
            }

            const stats = this.calculateLogbookStatistics(entries);
            
            let aiAnalysis = null;
            if (await this.llm.checkConnectionAsync()) {
                const prompt = this.buildLogbookAnalysisPrompt(entries, stats, vesselData, context);
                try {
                    aiAnalysis = await this.llm.generateCompletion(prompt, {
                        maxTokens: 500,
                        temperature: 0.7
                    });
                } catch (error) {
                    this.app.debug('LLM logbook analysis failed:', error.message);
                }
            }

            const insights = [];
            const recommendations = [];
            const nmLabel = this.cm.t('units.nm_abbr');
            const ktsLabel = this.cm.t('units.knots');
            const hrsLabel = this.cm.t('units.hours');

            if (stats.totalDistance > 0) {
                insights.push(`${this.cm.t('logbook.distance')}: ${stats.totalDistance.toFixed(1)} ${nmLabel}`);
            }
            if (stats.averageSpeed > 0) {
                insights.push(`${this.cm.t('logbook.avg_speed')}: ${stats.averageSpeed.toFixed(1)} ${ktsLabel}`);
            }
            if (stats.weatherTrends?.windIncreasing) {
                insights.push(this.cm.t('logbook.wind_increasing'));
                recommendations.push(this.cm.t('logbook.monitor_weather'));
            }
            if (stats.engineHours > 0) {
                insights.push(`${this.cm.t('logbook.engine_hours')}: ${stats.engineHours.toFixed(1)} ${hrsLabel}`);
                if (stats.engineHours > 50) {
                    recommendations.push(this.cm.t('logbook.engine_maintenance'));
                }
            }
            if (stats.entryFrequency < 4) {
                recommendations.push(this.cm.t('logbook.entry_frequency'));
            }

            const speechParts = [];
            speechParts.push(this.cm.t('logbook.analysis_count', { count: entries.length }));
            if (stats.totalDistance > 0) {
                speechParts.push(`${stats.totalDistance.toFixed(1)} ${nmLabel}`);
            }
            if (insights.length > 0) {
                speechParts.push(insights.slice(0, 2).join('. '));
            }

            // Store logbook stats as brain memory for next analysis
            this.logbookMemory.performanceBaseline = {
                avgSpeed: stats.averageSpeed,
                totalDistance: stats.totalDistance,
                engineHours: stats.engineHours,
                windTrend: stats.weatherTrends?.windIncreasing ? 'increasing' : 'stable',
                updatedAt: new Date().toISOString()
            };

            return {
                speech: speechParts.join('. '),
                summary: this.cm.t('logbook.analysis_count', { count: entries.length }),
                confidence: aiAnalysis ? 0.9 : 0.7,
                insights,
                recommendations,
                statistics: stats,
                aiAnalysis: aiAnalysis || this.cm.t('general.ai_unavailable'),
                entriesAnalyzed: entries.length
            };

        } catch (error) {
            this.app.error('Error analyzing logbook entries:', error);
            throw error;
        }
    }

    /**
     * Calculate statistics from logbook entries
     */
    calculateLogbookStatistics(entries) {
        const stats = {
            totalDistance: 0,
            averageSpeed: 0,
            engineHours: 0,
            entryFrequency: 0,
            weatherTrends: {
                windIncreasing: false,
                averageWindSpeed: 0
            }
        };

        if (!entries || entries.length === 0) {
            return stats;
        }

        let totalSpeed = 0;
        let speedCount = 0;
        let totalWind = 0;
        let windCount = 0;
        let firstEngineHours = null;
        let lastEngineHours = null;

        for (const entry of entries) {
            // Distance (log)
            if (entry.log && typeof entry.log === 'number') {
                if (entry.log > stats.totalDistance) {
                    stats.totalDistance = entry.log;
                }
            }

            // Speed
            if (entry.speed?.sog && typeof entry.speed.sog === 'number') {
                totalSpeed += entry.speed.sog;
                speedCount++;
            }

            // Wind
            if (entry.wind?.speed && typeof entry.wind.speed === 'number') {
                totalWind += entry.wind.speed;
                windCount++;
            }

            // Engine hours
            if (entry.engine?.hours && typeof entry.engine.hours === 'number') {
                if (firstEngineHours === null) {
                    firstEngineHours = entry.engine.hours;
                }
                lastEngineHours = entry.engine.hours;
            }
        }

        // Calculate averages
        if (speedCount > 0) {
            stats.averageSpeed = totalSpeed / speedCount;
        }

        if (windCount > 0) {
            stats.weatherTrends.averageWindSpeed = totalWind / windCount;
            // Check if wind is increasing (last 3 entries vs first 3 entries)
            if (entries.length >= 6) {
                const firstThreeWind = entries.slice(0, 3)
                    .filter(e => e.wind?.speed)
                    .reduce((sum, e) => sum + e.wind.speed, 0) / 3;
                const lastThreeWind = entries.slice(-3)
                    .filter(e => e.wind?.speed)
                    .reduce((sum, e) => sum + e.wind.speed, 0) / 3;
                stats.weatherTrends.windIncreasing = lastThreeWind > firstThreeWind * 1.2;
            }
        }

        // Engine hours delta
        if (firstEngineHours !== null && lastEngineHours !== null) {
            stats.engineHours = lastEngineHours - firstEngineHours;
        }

        // Entry frequency (entries per day)
        if (entries.length >= 2) {
            const firstDate = new Date(entries[0].datetime || entries[0].date);
            const lastDate = new Date(entries[entries.length - 1].datetime || entries[entries.length - 1].date);
            const daysDiff = (lastDate - firstDate) / (1000 * 60 * 60 * 24);
            if (daysDiff > 0) {
                stats.entryFrequency = entries.length / daysDiff;
            }
        }

        return stats;
    }

    /**
     * Build a prompt for LLM to analyze logbook entries
     */
    buildLogbookAnalysisPrompt(entries, stats, vesselData, context) {
        const recentEntries = entries.slice(-5).map(entry => ({
            datetime: entry.datetime || entry.date,
            position: entry.position,
            speed: entry.speed?.sog,
            wind: entry.wind,
            text: entry.text,
            author: entry.author
        }));

        return `Logbook: ${entries.length} entries, ` +
            `${stats.totalDistance.toFixed(1)} NM covered, ` +
            `avg ${stats.averageSpeed.toFixed(1)} kts, ` +
            `engine ${stats.engineHours.toFixed(1)}h. ` +
            `Recent: ${JSON.stringify(recentEntries)}. ` +
            `Vessel: ${vesselData.speed?.toFixed(1) || '?'} kts at ` +
            `${vesselData.position?.latitude?.toFixed(4)}, ${vesselData.position?.longitude?.toFixed(4)}. ` +
            `Analyse voyage progress, patterns, and recommendations.`;
    }
    // ────────── LOGBOOK AS PERSISTENT MEMORY ──────────

    /**
     * Load persistent context from logbook on startup.
     * Reads the most recent brain_memory entry to restore state.
     */
    async _loadLogbookMemory() {
        try {
            if (!this.logbookManager) return;

            const entries = await this.logbookManager.getAnalysisEntries();
            if (!entries || entries.length === 0) {
                this.app.debug('No logbook entries to load memory from');
                return;
            }

            // Find the most recent brain_memory entry
            const memoryEntries = entries.filter(e =>
                e.entryType === 'brain_memory' || e.systemEvent === true
            );

            if (memoryEntries.length > 0) {
                const latest = memoryEntries[memoryEntries.length - 1];
                if (latest.brainState) {
                    this.logbookMemory = { ...this.logbookMemory, ...latest.brainState };
                    this.app.debug('Brain memory restored from logbook');
                }
            }

            // Extract performance baseline from recent entries
            const stats = this.calculateLogbookStatistics(entries.slice(-20));
            this.logbookMemory.performanceBaseline = {
                avgSpeed: stats.averageSpeed,
                totalDistance: stats.totalDistance,
                engineHours: stats.engineHours,
                windTrend: stats.weatherTrends?.windIncreasing ? 'increasing' : 'stable',
                updatedAt: new Date().toISOString()
            };

            // Extract recent alerts summary
            const alertEntries = entries.filter(e =>
                e.entryType === 'alert' || e.entryType === 'safety'
            ).slice(-5);
            if (alertEntries.length > 0) {
                this.logbookMemory.recentAlertsSummary = alertEntries.map(e => ({
                    type: e.entryType,
                    summary: e.summary,
                    timestamp: e.timestamp || e.datetime
                }));
            }

            this.logbookMemory.loadedAt = new Date().toISOString();
            this.app.debug(`Logbook memory loaded: ${entries.length} entries analyzed`);

        } catch (error) {
            this.app.debug('Failed to load logbook memory, starting fresh:', error.message);
        }
    }

    /**
     * Store brain state to logbook for persistence across restarts.
     */
    async _storeLogbookMemory() {
        try {
            if (!this.logbookManager) return;

            const brainState = {
                lastWeatherBaseline: this.state.lastWeatherAnalysis?.assessment ? {
                    beaufort: this.state.lastWeatherAnalysis.assessment.beaufort?.force,
                    windStrength: this.state.lastWeatherAnalysis.assessment.windStrength,
                    pressure: this.state.lastWeatherAnalysis.assessment.pressure,
                    trend: this.state.lastWeatherAnalysis.assessment.trend?.overall
                } : null,
                performanceBaseline: this.logbookMemory.performanceBaseline,
                keelPosition: this.logbookMemory.keelPosition,
                mode: this.state.mode,
                aisTargetsInRange: this.state.aisTargetsInRange,
                savedAt: new Date().toISOString()
            };

            await this.logbookManager.logAnalysis('brain_memory', {
                summary: 'Brain state checkpoint',
                confidence: 1.0,
                systemEvent: true,
                entryType: 'brain_memory',
                brainState
            });

            this.app.debug('Brain memory stored to logbook');

        } catch (error) {
            this.app.debug('Failed to store brain memory:', error.message);
        }
    }

    /**
     * Get logbook memory context for analysis enrichment.
     * @returns {object} Compact context from persistent logbook memory
     */
    getLogbookContext() {
        return {
            performanceBaseline: this.logbookMemory.performanceBaseline,
            recentAlerts: this.logbookMemory.recentAlertsSummary,
            lastWeatherBaseline: this.logbookMemory.lastWeatherBaseline,
            keelPosition: this.logbookMemory.keelPosition
        };
    }
}

module.exports = OrchestratorBrain;