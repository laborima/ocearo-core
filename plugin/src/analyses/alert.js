/*
 * Alert analysis module
 * Processes and enriches alerts with LLM analysis
 */

const { i18n } = require('../common');

class AlertAnalyzer {
    constructor(app, config, llm, memory) {
        this.app = app;
        this.config = config;
        this.llm = llm;
        this.memory = memory;
        
        // Alert severity mappings
        this.severityLevels = {
            alarm: 3,
            warn: 2,
            alert: 1,
            normal: 0
        };
        
        // Alert type to category mapping
        this.alertCategories = {
            depth: 'navigation',
            wind: 'weather',
            battery: 'electrical',
            engine: 'propulsion',
            temperature: 'engine',
            weather: 'weather',
            tide: 'navigation',
            collision: 'safety',
            mob: 'safety',
            fire: 'safety'
        };
    }

    /**
     * Process incoming alert
     */
    async processAlert(notification, vesselData) {
        try {
            // Extract alert details
            const alert = this.parseNotification(notification);
            
            // Check if similar alert was recently sent
            if (this.shouldSuppress(alert)) {
                this.app.debug(`Suppressing duplicate alert: ${alert.key}`);
                return null;
            }
            
            // Get context for enrichment
            const context = this.memory.getContext();
            
            // Enrich alert with LLM analysis
            const analysis = await this.analyzeAlert(alert, vesselData, context);
            
            // Record alert in memory
            const alertEntry = this.memory.addAlert({
                ...alert,
                analysis,
                vesselData: this.extractRelevantData(vesselData, alert.category)
            });
            
            return {
                ...alert,
                ...alertEntry,
                speech: analysis,
                shouldSpeak: this.shouldSpeak(alert)
            };
        } catch (error) {
            this.app.error('Error processing alert:', error);
            return null;
        }
    }

    /**
     * Parse Signal K notification
     */
    parseNotification(notification) {
        const pathParts = notification.path.split('.');
        const category = this.determineCategory(notification);
        
        return {
            key: notification.path,
            type: pathParts[pathParts.length - 1],
            category,
            message: notification.value?.message || 'Alert',
            severity: notification.value?.state || 'normal',
            value: notification.value?.value,
            timestamp: notification.timestamp || new Date().toISOString()
        };
    }

    /**
     * Determine alert category
     */
    determineCategory(notification) {
        const path = notification.path.toLowerCase();
        
        for (const [key, category] of Object.entries(this.alertCategories)) {
            if (path.includes(key)) {
                return category;
            }
        }
        
        return 'general';
    }

    /**
     * Check if alert should be suppressed
     */
    shouldSuppress(alert) {
        // Check memory for recent similar alerts
        const suppressMinutes = this.config.alerts?.suppressDuplicateMinutes || 30;
        if (!this.memory || !alert.key) return false;
        return this.memory.wasRecentlySent(alert.type, alert.key, suppressMinutes);
    }

    /**
     * Analyze alert with LLM
     */
    async analyzeAlert(alert, vesselData, context) {
        const mode = this.config.alertMode || 'smart';
        
        if (mode === 'basic') {
            return this.getBasicAlertMessage(alert);
        }
        
        if (mode === 'smart' || mode === 'verbose') {
            try {
                return await this.llm.processAlert(alert, vesselData, context);
            } catch (error) {
                this.app.error('LLM analysis failed, using basic message:', error);
                return this.getBasicAlertMessage(alert);
            }
        }
        
        return alert.message;
    }

    /**
     * Get basic alert message
     */
    getBasicAlertMessage(alert) {
        const lang = this.config.language || 'en';
        
        // Try to get localized message for alert type
        const messageKey = `alert_${alert.type}`;
        const localizedMessage = i18n.localize(lang, messageKey, {
            value: alert.value,
            message: alert.message
        });
        
        // If no specific localization, use generic
        if (localizedMessage === messageKey) {
            return i18n.localize(lang, 'alert_generic', {
                message: alert.message,
                value: alert.value
            });
        }
        
        return localizedMessage;
    }

    /**
     * Determine if alert should be spoken
     */
    shouldSpeak(alert) {
        const mode = this.config.alertMode || 'smart';
        
        if (mode === 'silent') {
            return false;
        }
        
        // Always speak high severity alerts
        if (this.severityLevels[alert.severity] >= 2) {
            return true;
        }
        
        // In verbose mode, speak all alerts
        if (mode === 'verbose') {
            return true;
        }
        
        // In smart mode, speak based on category importance
        const importantCategories = ['safety', 'navigation', 'weather'];
        return importantCategories.includes(alert.category);
    }

    /**
     * Extract relevant vessel data for alert context
     */
    extractRelevantData(vesselData, category) {
        const relevant = {};
        
        switch (category) {
            case 'navigation':
                relevant.depth = vesselData.depth;
                relevant.speed = vesselData.speed;
                relevant.heading = vesselData.heading;
                break;
            case 'weather':
                relevant.wind = vesselData.wind;
                relevant.speed = vesselData.speed;
                break;
            case 'electrical':
                relevant.battery = vesselData.battery;
                break;
            case 'propulsion':
                relevant.engine = vesselData.engine;
                relevant.speed = vesselData.speed;
                break;
            default:
                // Include basic data for all alerts
                relevant.speed = vesselData.speed;
                relevant.position = vesselData.position;
        }
        
        return relevant;
    }

    /**
     * Get alert summary for speech
     */
    getAlertSummary(alerts = []) {
        const lang = this.config.language || 'en';
        
        if (!alerts || alerts.length === 0) {
            return i18n.localize(lang, 'no_alerts', { default: 'No active alerts' });
        }
        
        const count = alerts.length;
        const summary = i18n.localize(lang, 'active_alerts_count', { count });
        
        // Add details for up to 3 most recent alerts
        const details = alerts.slice(0, 3).map(alert => {
            return this.getBasicAlertMessage(alert);
        });
        
        return `${summary}. ${details.join('. ')}`;
    }

    /**
     * Get alert statistics
     */
    getStatistics(hours = 24) {
        const recent = this.memory.getRecentAlerts(hours * 60);
        const byCategory = {};
        const bySeverity = {};
        
        recent.forEach(alert => {
            // Count by category
            byCategory[alert.category] = (byCategory[alert.category] || 0) + 1;
            
            // Count by severity
            bySeverity[alert.severity] = (bySeverity[alert.severity] || 0) + 1;
        });
        
        return {
            total: recent.length,
            byCategory,
            bySeverity,
            recentAlerts: recent.slice(-10) // Last 10 alerts
        };
    }
}

module.exports = AlertAnalyzer;
