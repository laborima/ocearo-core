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
        
        // The plugin's own data directory, like the logbook and anchor stores.
        // Up to 1.2.0 the memory went to <configPath>/../ocearo-core, which
        // with the usual ~/.signalk config is the user's home: those files are
        // moved on start (see _migrateLegacyDir).
        if (typeof app.getDataDirPath === 'function') {
            this.dataDir = path.join(app.getDataDirPath(), 'memory');
        } else if (app.config && app.config.configPath) {
            this.dataDir = path.join(app.config.configPath, 'plugin-config-data', 'ocearo-core', 'memory');
        } else {
            this.dataDir = '/home/node/.signalk/plugin-config-data/ocearo-core/memory';
        }
        this.legacyDir = app.config?.configPath
            ? path.join(path.dirname(app.config.configPath), 'ocearo-core')
            : null;
        this._persisting = null;
        this._tmpSeq = 0;
        
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
        await this._migrateLegacyDir();
        
        // Load persisted data
        await this.loadPersistedData();
        
        // Start periodic persistence
        const persistMinutes = this.config.memory?.persistIntervalMinutes || 10;
        this.persistInterval = setInterval(() => {
            this.persistData().catch(err => {
                this.app.error(`Failed to persist memory data: ${err.message}`);
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
     * Move the memory files written by 1.2.0 and earlier outside the plugin's
     * data directory, so the history is kept. Files already present in the new
     * directory win.
     */
    async _migrateLegacyDir() {
        if (!this.legacyDir || path.resolve(this.legacyDir) === path.resolve(this.dataDir)) return;
        for (const name of ['context.json', 'alerts.json', 'navigation.json']) {
            const from = path.join(this.legacyDir, name);
            const to = path.join(this.dataDir, name);
            try {
                await fs.access(from);
            } catch {
                continue; // nothing to migrate
            }
            try {
                await fs.access(to);
                continue; // keep the newer file
            } catch {
                // not there yet: move it
            }
            try {
                await fs.copyFile(from, to);
                await fs.unlink(from);
                this.app.debug(`Memory file moved from ${from} to ${to}`);
            } catch (error) {
                this.app.debug(`Could not move ${from}: ${error.message}`);
            }
        }
        try {
            await fs.rmdir(this.legacyDir); // only succeeds once empty
        } catch {
            // other files left there: leave the directory alone
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
        // One write at a time: a call made while one is running waits for it
        if (this._persisting) return this._persisting;
        this._persisting = this._persistNow().finally(() => {
            this._persisting = null;
        });
        return this._persisting;
    }

    async _persistNow() {
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
            // The server's logger prints only its first argument
            this.app.error(`Error persisting data: ${error.message}`);
        }
    }

    /**
     * Atomic, non-blocking write: temp file + rename. A crash mid-write keeps the
     * previous file intact rather than leaving a truncated, unparseable JSON.
     * @param {string} filePath
     * @param {string} data
     */
    async _atomicWrite(filePath, data) {
        const tmp = `${filePath}.${process.pid}.${++this._tmpSeq}.tmp`;
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
