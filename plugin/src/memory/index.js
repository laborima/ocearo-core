/*
 * Memory and context management
 * Manages vessel context, navigation history, and alert history
 */

const fs = require('fs').promises;
const path = require('path');

class MemoryManager {
    constructor(app, config) {
        this.app = app;
        this.config = config;
        
        // Handle different SignalK app object versions
        let dataPath;
        if (typeof app.getDataPath === 'function') {
            dataPath = app.getDataPath();
        } else if (app.config && app.config.configPath) {
            // Fallback: use SignalK config directory
            dataPath = path.dirname(app.config.configPath);
        } else {
            // Last resort: use a default path
            dataPath = '/home/node/.signalk/data';
        }
        
        this.dataDir = path.join(dataPath, 'ocearo-core');
        
        // In-memory stores
        this.vesselContext = {
            profile: null,
            destination: null,
            route: null,
            lastUpdate: null
        };
        
        this.alertHistory = [];
        this.navigationHistory = [];
        this.maxHistorySize = config.memory?.maxHistorySize || 1000;
        this.persistInterval = null;
    }

    /**
     * Start memory manager
     */
    async start() {
        this.app.debug('Starting memory manager');
        
        // Ensure data directory exists
        await this.ensureDataDirectory();
        
        // Load persisted data
        await this.loadPersistedData();
        
        // Start periodic persistence
        const persistMinutes = this.config.memory?.persistIntervalMinutes || 10;
        this.persistInterval = setInterval(() => {
            this.persistData().catch(err => {
                this.app.error('Failed to persist memory data:', err);
            });
        }, persistMinutes * 60 * 1000);
    }

    /**
     * Stop memory manager
     */
    async stop() {
        this.app.debug('Stopping memory manager');
        
        // Clear interval
        if (this.persistInterval) {
            clearInterval(this.persistInterval);
            this.persistInterval = null;
        }
        
        // Final persist
        await this.persistData();
    }

    /**
     * Ensure data directory exists
     */
    async ensureDataDirectory() {
        try {
            await fs.access(this.dataDir);
            this.app.debug(`Data directory exists: ${this.dataDir}`);
        } catch (error) {
            this.app.debug(`Creating data directory: ${this.dataDir}`);
            try {
                await fs.mkdir(this.dataDir, { recursive: true });
                this.app.debug(`Data directory created successfully: ${this.dataDir}`);
            } catch (mkdirError) {
                this.app.error(`Failed to create data directory: ${this.dataDir}`, mkdirError);
                throw mkdirError;
            }
        }
    }

    /**
     * Load persisted data
     */
    async loadPersistedData() {
        try {
            // Load vessel context
            const contextPath = path.join(this.dataDir, 'context.json');
            try {
                const contextData = await fs.readFile(contextPath, 'utf8');
                this.vesselContext = JSON.parse(contextData);
            } catch (err) {
                this.app.debug('No persisted context found');
            }
            
            // Load alert history
            const alertPath = path.join(this.dataDir, 'alerts.json');
            try {
                const alertData = await fs.readFile(alertPath, 'utf8');
                this.alertHistory = JSON.parse(alertData);
            } catch (err) {
                this.app.debug('No persisted alert history found');
            }
            
            // Load navigation history
            const navPath = path.join(this.dataDir, 'navigation.json');
            try {
                const navData = await fs.readFile(navPath, 'utf8');
                this.navigationHistory = JSON.parse(navData);
            } catch (err) {
                this.app.debug('No persisted navigation history found');
            }
        } catch (error) {
            this.app.error('Error loading persisted data:', error);
        }
    }

    /**
     * Persist data to disk
     */
    async persistData() {
        try {
            // Save vessel context
            await this._atomicWrite(
                path.join(this.dataDir, 'context.json'),
                JSON.stringify(this.vesselContext, null, 2)
            );

            // Save alert history (keep only recent)
            const recentAlerts = this.alertHistory.slice(-this.maxHistorySize);
            await this._atomicWrite(
                path.join(this.dataDir, 'alerts.json'),
                JSON.stringify(recentAlerts, null, 2)
            );

            // Save navigation history (keep only recent)
            const recentNav = this.navigationHistory.slice(-this.maxHistorySize);
            await this._atomicWrite(
                path.join(this.dataDir, 'navigation.json'),
                JSON.stringify(recentNav, null, 2)
            );

            this.app.debug('Memory data persisted successfully');
        } catch (error) {
            this.app.error('Error persisting data:', error);
        }
    }

    /**
     * Atomic, non-blocking write: temp file + rename. A crash mid-write keeps the
     * previous file intact rather than leaving a truncated, unparseable JSON.
     * @param {string} filePath
     * @param {string} data
     */
    async _atomicWrite(filePath, data) {
        const tmp = `${filePath}.${process.pid}.tmp`;
        await fs.writeFile(tmp, data);
        await fs.rename(tmp, filePath);
    }

    /**
     * Update vessel context
     */
    updateContext(updates) {
        this.vesselContext = {
            ...this.vesselContext,
            ...updates,
            lastUpdate: new Date().toISOString()
        };
        
        this.app.debug('Vessel context updated:', updates);
    }

    /**
     * Get vessel context
     */
    getContext() {
        return { ...this.vesselContext };
    }

    /**
     * Set vessel profile
     */
    setProfile(profile) {
        this.updateContext({ profile });
    }

    /**
     * Set destination
     */
    setDestination(destination) {
        this.updateContext({ destination });
        
        // Add to navigation history
        this.addNavigationEntry({
            type: 'destination_set',
            destination,
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Set route
     */
    setRoute(route) {
        this.updateContext({ route });
        
        // Add to navigation history
        this.addNavigationEntry({
            type: 'route_set',
            route,
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Add alert to history
     */
    addAlert(alert) {
        const alertEntry = {
            ...alert,
            timestamp: new Date().toISOString(),
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
        };
        
        this.alertHistory.push(alertEntry);
        
        // Maintain max size
        if (this.alertHistory.length > this.maxHistorySize) {
            this.alertHistory = this.alertHistory.slice(-this.maxHistorySize);
        }
        
        return alertEntry;
    }

    /**
     * Add navigation entry to history
     */
    addNavigationEntry(entry) {
        const navEntry = {
            ...entry,
            timestamp: entry.timestamp || new Date().toISOString()
        };
        
        this.navigationHistory.push(navEntry);
        
        // Maintain max size
        if (this.navigationHistory.length > this.maxHistorySize) {
            this.navigationHistory = this.navigationHistory.slice(-this.maxHistorySize);
        }
        
        return navEntry;
    }

    /**
     * Get recent alerts
     */
    getRecentAlerts(minutes = 60) {
        const cutoff = new Date(Date.now() - minutes * 60 * 1000);
        return this.alertHistory.filter(alert => 
            new Date(alert.timestamp) > cutoff
        );
    }

    /**
     * Check if similar alert was recently sent
     */
    wasRecentlySent(alertType, key, minutes = 30) {
        const recent = this.getRecentAlerts(minutes);
        return recent.some(alert => 
            alert.type === alertType && alert.key === key
        );
    }

    /**
     * Get navigation summary
     */
    getNavigationSummary(hours = 24) {
        const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
        const relevantHistory = this.navigationHistory.filter(entry =>
            new Date(entry.timestamp) > cutoff
        );
        
        // Calculate statistics
        const waypoints = relevantHistory.filter(e => e.type === 'waypoint_reached');
        const courseChanges = relevantHistory.filter(e => e.type === 'course_change');
        const destinations = relevantHistory.filter(e => e.type === 'destination_set');
        
        return {
            waypointsReached: waypoints.length,
            courseChanges: courseChanges.length,
            destinationsSet: destinations.length,
            entries: relevantHistory
        };
    }

    /**
     * Clear old history entries
     */
    async cleanupHistory(daysToKeep = 7) {
        const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);
        
        // Clean alerts
        this.alertHistory = this.alertHistory.filter(alert =>
            new Date(alert.timestamp) > cutoff
        );
        
        // Clean navigation
        this.navigationHistory = this.navigationHistory.filter(entry =>
            new Date(entry.timestamp) > cutoff
        );
        
        // Persist cleaned data
        await this.persistData();
        
        this.app.debug(`Cleaned up history older than ${daysToKeep} days`);
    }

    /**
     * Get memory statistics
     */
    getStatistics() {
        return {
            alertCount: this.alertHistory.length,
            navigationCount: this.navigationHistory.length,
            hasContext: !!this.vesselContext.profile,
            lastContextUpdate: this.vesselContext.lastUpdate,
            memoryUsage: {
                alerts: JSON.stringify(this.alertHistory).length,
                navigation: JSON.stringify(this.navigationHistory).length,
                context: JSON.stringify(this.vesselContext).length
            }
        };
    }
}

module.exports = MemoryManager;
