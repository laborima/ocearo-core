/*
 * Orchestrator Brain Module
 * Manages scheduling, analysis, decision making, and AI logbook integration
 */
const { i18n } = require('../common');
const AlertAnalyzer = require('../analyses/alert');
const MeteoAnalyzer = require('../analyses/meteo');
const SailCourseAnalyzer = require('../analyses/sailcourse');
const SailSettingsAnalyzer = require('../analyses/sailsettings');
const LogbookManager = require('../logbook');

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
        
        // Logbook integration
        this.logbookManager = components.logbookManager;
        
        // Analysis modules
        this.alertAnalyzer = new AlertAnalyzer(app, config, this.llm, this.memoryManager);
        this.meteoAnalyzer = new MeteoAnalyzer(app, config, this.llm, 
            this.weatherProvider, this.tidesProvider);
        this.sailCourseAnalyzer = new SailCourseAnalyzer(app, config, this.llm);
        this.sailSettingsAnalyzer = new SailSettingsAnalyzer(app, config, this.llm);
        
        // Scheduling intervals (ms)
        this.schedules = {
            alertCheck: (config.schedules?.alertCheck || 30) * 1000,
            weatherUpdate: (config.schedules?.weatherUpdate || 300) * 1000,
            sailAnalysis: (config.schedules?.sailAnalysis || 120) * 1000,
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
            alertsActive: 0,
            started: false
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
      
        // Initialize components
        this.initializeSchedules();
        
        
        // Perform initial analyses
        await this.performInitialChecks();
        
        // Log startup to logbook
        await this.logSystemEvent('startup', {
            summary: 'Ocearo Jarvis AI system started successfully',
            mode: this.state.mode,
            confidence: 1.0
        });
        
        // Announce startup
        const language = this.config.language || 'en';
        const personality = this.config.personality || 'default';
        const translations = i18n.translations[language] || i18n.translations.en;
        const greeting = translations.startup?.[personality] || translations.startup.default;
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
        
        // Persist memory
        await this.memoryManager.persistData();
        
        // Log shutdown to logbook
        await this.logSystemEvent('shutdown', {
            summary: 'Ocearo Jarvis AI system shutdown gracefully',
            confidence: 1.0
        });
        
        // Announce shutdown
        const language = this.config.language || 'en';
        const personality = this.config.personality || 'default';
        const translations = i18n.translations[language] || i18n.translations.en;
        const farewell = translations.shutdown?.[personality] || translations.shutdown.default || 'Shutting down.';
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
                    analysisResults.tides = await this.tidesProvider.getTideData(vesselData.position);
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
        } catch (error) {
            this.app.debug('Initial vessel data fetch failed, skipping initial checks:', error.message);
        }
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
                this.voice.speak(analysis.speech);
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
            const language = this.config.language || 'en';
            
            // Extract navigation data
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
            
            // Build navigation point message
            let message;
            if (speed !== null && course !== null && depth !== null) {
                message = i18n.localize(language, 'nav_point_update', {
                    speed,
                    course,
                    depth
                });
            } else {
                message = i18n.t('nav_point_no_data', language);
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
            const summary = i18n.localize(language, 'hourly_log_summary', {
                position: positionStr,
                speed,
                course
            });
            
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
                this.voice.speak(i18n.t('hourly_log_entry', language), { priority: 'low' });
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
                    const message = courseAnalysis.analysis || 
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
                const settingsMessage = settingsAnalysis.analysis || 
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
                    this.voice.speak(weatherAnalysis.speech, { priority: 'high' });
                    
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
                    
                    // Log manual sail analysis
                    if (this.state.lastSailAnalysis) {
                        await this.logAnalysisToLogbook('navigation', {
                            ...this.state.lastSailAnalysis,
                            manual: true,
                            requestType: 'manual_sail_analysis'
                        });
                    }
                    
                    return this.state.lastSailAnalysis;
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
            // Handle LLM-related errors more gracefully
            if (error.message.includes('LLM service not available')) {
                this.app.debug(`Manual analysis ${type} skipped - LLM service not available`);
                this.voice.speak('Analysis requires AI assistance which is currently unavailable. Please check Ollama service.', { priority: 'high' });
                throw new Error('AI service unavailable');
            } else {
                this.app.debug(`Manual analysis ${type} failed:`, error.message);
                const language = this.config.language || 'en';
                this.voice.speak(i18n.localize(language, 'analysis_failed'));
                throw error;
            }
        }
    }

    /**
     * Update operating mode
     */
    async updateMode(mode) {
        const language = this.config.language || 'en';
        const validModes = ['sailing', 'anchored', 'motoring', 'moored', 'racing'];
        const localizedValidModes = validModes.map(m => i18n.t(`vessel_mode.${m}`, language));

        if (!validModes.includes(mode)) {
            throw new Error(`Invalid mode: ${mode}. Valid modes are: ${validModes.join(', ')}`);
        }
        
        const previousMode = this.state.mode;
        this.state.mode = mode;
        
        // Handle anchor position based on mode changes
        try {
            if (mode === 'anchored' && previousMode !== 'anchored') {
                // Set anchor position when entering anchored mode
                const vesselData = await this.signalkProvider.getVesselData();
                if (vesselData.navigation && vesselData.navigation.position) {
                    const anchorPosition = {
                        latitude: vesselData.navigation.position.latitude,
                        longitude: vesselData.navigation.position.longitude,
                        timestamp: new Date().toISOString()
                    };
                    
                    const success = this.signalkProvider.writePath('navigation.anchor.position', anchorPosition);
                    if (success) {
                        this.app.debug(`Anchor position set: ${anchorPosition.latitude}, ${anchorPosition.longitude}`);
                    } else {
                        this.app.debug('Failed to set anchor position');
                    }
                }
            } else if (previousMode === 'anchored' && mode !== 'anchored') {
                // Reset anchor position when leaving anchored mode
                const success = this.signalkProvider.writePath('navigation.anchor.position', null);
                if (success) {
                    this.app.debug('Anchor position reset (anchor hoisted)');
                } else {
                    this.app.debug('Failed to reset anchor position');
                }
            }
        } catch (error) {
            this.app.debug('Error handling anchor position during mode change:', error.message);
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
            summary: `Operating mode changed from ${previousMode} to ${mode}`,
            previousMode,
            newMode: mode,
            confidence: 1.0
        });
        
        // Get translated mode name using nested key support
        const localizedMode = i18n.t(`vessel_mode.${mode}`, language);
        const message = i18n.localize(language, 'mode_changed', { mode: localizedMode });
        this.voice.speak(message);
    }

    /**
     * Log analysis results to SignalK-Logbook
     */
    async logAnalysisToLogbook(analysisType, result) {
        try {
            // Prepare analysis data for logbook
            const analysisData = {
                summary: result.speech || result.analysis || result.summary || 'Analysis completed',
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
     * Check if weather should be announced
     */
    shouldAnnounceWeather(analysis) {
        // Always announce on first analysis
        if (!this.state.lastWeatherAnalysis) return true;
        
        const prev = this.state.lastWeatherAnalysis;
        
        // Check for significant changes
        if (analysis.assessment.windStrength !== prev.assessment.windStrength) return true;
        if (analysis.assessment.seaState !== prev.assessment.seaState) return true;
        if (analysis.assessment.alerts.length > prev.assessment.alerts.length) return true;
        if (analysis.assessment.trend.overall !== prev.assessment.trend.overall) return true;
        
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
     * Get system status
     */
    getSystemStatus() {
        return {
            mode: this.state.mode,
            started: this.state.started,
            alertsActive: this.state.alertsActive,
            lastWeatherUpdate: this.state.lastWeatherAnalysis?.timestamp,
            lastSailAnalysis: this.state.lastSailAnalysis?.timestamp,
            llmConnected: this.llm.isConnected(),
            voiceEnabled: this.voice.enabled,
            memorySize: this.memoryManager.getStatistics(),
            logbookConnected: this.logbookManager.isConnected
        };
    }

    /**
     * Format status message for speech
     */
    formatStatusMessage(status) {
        const language = this.config.language || 'en';
        const parts = [];
        
        const statusLabel = i18n.t('status_system', language);
        const activeLabel = status.started ? i18n.t('status_active', language) : i18n.t('status_inactive', language);
        parts.push(`${statusLabel}: ${activeLabel}`);
        
        const modeLabel = i18n.t('status_mode', language);
        parts.push(`${modeLabel}: ${status.mode}`);
        
        if (status.alertsActive > 0) {
            parts.push(i18n.localize(language, 'status_alerts_count', { count: status.alertsActive }));
        }
        
        if (!status.llmConnected) {
            parts.push(i18n.t('status_ai_offline', language));
        }
        
        if (!status.logbookConnected) {
            parts.push(i18n.t('status_logbook_offline', language));
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
        const language = this.config.language || 'en';
        const parts = [];
        const summary = [];
        
        // Weather report
        if (analysisResults.weather && config.includeWeatherForecast !== false) {
            const weather = analysisResults.weather;
            if (weather.speech) {
                parts.push(weather.speech);
                summary.push(`${i18n.t('report_weather', language)}: ${weather.assessment?.windStrength || 'analyzed'}`);
            }
        }
        
        // Tide information
        if (analysisResults.tides && config.includeTides !== false) {
            const tides = analysisResults.tides;
            if (tides.next?.high || tides.next?.low) {
                const nextTide = tides.next.high && tides.next.low ? 
                    (tides.next.high.time < tides.next.low.time ? tides.next.high : tides.next.low) :
                    (tides.next.high || tides.next.low);
                
                const timeStr = nextTide.time.toLocaleTimeString(language === 'fr' ? 'fr-FR' : 'en-US', { 
                    hour: '2-digit', minute: '2-digit' 
                });
                const heightStr = `${nextTide.height.toFixed(1)}m`;
                
                // Translate tide type (High/Low)
                const typeKey = `tide_${nextTide.type.toLowerCase()}`;
                const typeStr = i18n.t(typeKey, language);

                parts.push(i18n.localize(language, 'report_tide_next', { type: typeStr, time: `${timeStr}, ${heightStr}` }));
                summary.push(`${i18n.t('report_tides', language)}: ${typeStr} ${timeStr}`);
            }
        }
        
        // Sail recommendations
        if (analysisResults.sailRecommendations && config.includeSailRecommendations !== false) {
            const sail = analysisResults.sailRecommendations;
            if (sail.adjustments && sail.adjustments.length > 0) {
                const highPriorityAdjustments = sail.adjustments.filter(adj => adj.priority === 'high');
                if (highPriorityAdjustments.length > 0) {
                    // Note: adj.action is internal key, ideally should be localized too but might be English string from analyzer
                    // Assuming analyzer returns localized string or key? SailSettingsAnalyzer returns hardcoded strings currently.
                    // But let's focus on the wrapper text first.
                    parts.push(`${i18n.t('report_sail', language)}: ${highPriorityAdjustments.map(adj => adj.action).join(', ')}`);
                    const countMsg = i18n.localize(language, 'report_recommendations_count', { count: highPriorityAdjustments.length });
                    summary.push(`${i18n.t('report_sail', language)}: ${countMsg}`);
                }
            }
        }
        
        // Tank levels
        if (analysisResults.tankLevels && config.includeTankLevels !== false) {
            const tanks = analysisResults.tankLevels;
            const lowTanks = Object.entries(tanks).filter(([_, tank]) => tank.status === 'low');
            const criticalTanks = Object.entries(tanks).filter(([_, tank]) => tank.level < 10);
            
            if (criticalTanks.length > 0) {
                parts.push(`Critical tank levels: ${criticalTanks.map(([id, tank]) => `${tank.type} ${tank.level}%`).join(', ')}`);
                summary.push(`${i18n.t('report_tanks', language)}: ${i18n.localize(language, 'report_tanks_critical', { count: criticalTanks.length })}`);
            } else if (lowTanks.length > 0) {
                parts.push(`Low tank levels: ${lowTanks.map(([id, tank]) => `${tank.type} ${tank.level}%`).join(', ')}`);
                summary.push(`${i18n.t('report_tanks', language)}: ${i18n.localize(language, 'report_tanks_low', { count: lowTanks.length })}`);
            } else if (Object.keys(tanks).length > 0) {
                summary.push(`${i18n.t('report_tanks', language)}: ${i18n.t('report_tanks_good', language)}`);
            }
        }
        
        // Battery levels
        if (analysisResults.batteryLevels && config.includeBatteryLevels !== false) {
            const batteries = analysisResults.batteryLevels;
            const lowBatteries = Object.entries(batteries).filter(([_, battery]) => 
                battery.status === 'low' || battery.status === 'critical'
            );
            
            if (lowBatteries.length > 0) {
                const batteryInfo = lowBatteries.map(([id, battery]) => {
                    const info = [];
                    if (battery.capacity !== null) info.push(`${battery.capacity}%`);
                    if (battery.voltage !== null) info.push(`${battery.voltage}V`);
                    return `${id} ${info.join(' ')}`;
                }).join(', ');
                
                parts.push(`${i18n.t('report_batteries', language)}: ${batteryInfo}`);
                summary.push(`${i18n.t('report_batteries', language)}: ${i18n.localize(language, 'report_batteries_attention', { count: lowBatteries.length })}`);
            } else if (Object.keys(batteries).length > 0) {
                summary.push(`${i18n.t('report_batteries', language)}: ${i18n.t('report_batteries_good', language)}`);
            }
        }
        
        // Calculate confidence based on available data
        let confidence = 0.5;
        if (analysisResults.weather) confidence += 0.2;
        if (analysisResults.tides) confidence += 0.1;
        if (analysisResults.sailRecommendations) confidence += 0.1;
        if (Object.keys(analysisResults.tankLevels || {}).length > 0) confidence += 0.05;
        if (Object.keys(analysisResults.batteryLevels || {}).length > 0) confidence += 0.05;
        
        const baseMessage = i18n.localize(language, 'startup_analysis_complete');
        
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
        const language = this.config.language || 'en';
        try {
            if (!entries || entries.length === 0) {
                return {
                    speech: i18n.t('logbook_no_entries', language),
                    summary: i18n.t('logbook_no_entries', language),
                    confidence: 1.0,
                    insights: [],
                    recommendations: []
                };
            }

            // Calculate statistics from entries
            const stats = this.calculateLogbookStatistics(entries);
            
            // Prepare analysis prompt for LLM if available
            let aiAnalysis = null;
            if (await this.llm.checkConnectionAsync()) {
                const prompt = this.buildLogbookAnalysisPrompt(entries, stats, vesselData, context);
                try {
                    aiAnalysis = await this.llm.generateCompletion(prompt, {
                        maxTokens: 500,
                        temperature: 0.7
                    });
                } catch (error) {
                    this.app.debug('LLM analysis for logbook failed, using basic analysis:', error.message);
                }
            }

            // Build comprehensive analysis result
            const insights = [];
            const recommendations = [];

            // Distance covered
            if (stats.totalDistance > 0) {
                insights.push(`${i18n.t('logbook_distance', language)}: ${stats.totalDistance.toFixed(1)} ${language === 'fr' ? 'milles nautiques' : 'nautical miles'}`);
            }

            // Average speed
            if (stats.averageSpeed > 0) {
                insights.push(`${i18n.t('logbook_avg_speed', language)}: ${stats.averageSpeed.toFixed(1)} ${language === 'fr' ? 'nœuds' : 'knots'}`);
            }

            // Weather trends
            if (stats.weatherTrends) {
                if (stats.weatherTrends.windIncreasing) {
                    insights.push(i18n.t('logbook_wind_increasing', language));
                    recommendations.push(i18n.t('logbook_monitor_weather', language));
                }
            }

            // Engine hours
            if (stats.engineHours > 0) {
                insights.push(`${i18n.t('logbook_engine_hours', language)}: ${stats.engineHours.toFixed(1)} ${language === 'fr' ? 'heures' : 'hours'}`);
                if (stats.engineHours > 50) {
                    recommendations.push(i18n.t('logbook_engine_maintenance', language));
                }
            }

            // Entry frequency
            if (stats.entryFrequency < 4) {
                recommendations.push(i18n.t('logbook_entry_frequency', language));
            }

            // Generate speech summary
            const speechParts = [];
            speechParts.push(i18n.localize(language, 'logbook_analysis_count', { count: entries.length }));
            
            if (stats.totalDistance > 0) {
                if (language === 'fr') {
                    speechParts.push(`Vous avez parcouru ${stats.totalDistance.toFixed(1)} milles nautiques.`);
                } else {
                    speechParts.push(`You have covered ${stats.totalDistance.toFixed(1)} nautical miles.`);
                }
            }
            
            if (insights.length > 0) {
                speechParts.push(insights.slice(0, 2).join('. '));
            }

            return {
                speech: speechParts.join(' '),
                summary: i18n.localize(language, 'logbook_analysis_count', { count: entries.length }),
                confidence: aiAnalysis ? 0.9 : 0.7,
                insights: insights,
                recommendations: recommendations,
                statistics: stats,
                aiAnalysis: aiAnalysis || (language === 'fr' ? 'Analyse IA non disponible' : 'AI analysis not available'),
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

        return `Analyze the following logbook entries for a sailing vessel:

Statistics:
- Total entries: ${entries.length}
- Total distance: ${stats.totalDistance.toFixed(1)} NM
- Average speed: ${stats.averageSpeed.toFixed(1)} knots
- Engine hours: ${stats.engineHours.toFixed(1)} hours

Recent entries:
${JSON.stringify(recentEntries, null, 2)}

Current vessel status:
- Speed: ${vesselData.speed?.toFixed(1) || 'N/A'} knots
- Position: ${vesselData.position?.latitude?.toFixed(4)}, ${vesselData.position?.longitude?.toFixed(4)}

Provide a brief analysis (2-3 sentences) of the voyage progress, patterns, and any recommendations.`;
    }
}

module.exports = OrchestratorBrain;