/**
 * src/anchor/anchor-alarm.js
 *
 * Anchor drag alarm.
 * Subscribes to navigation.position, computes distance from the recorded
 * anchor drop point, and emits Signal K notifications when the vessel
 * drifts beyond the configured radius.
 *
 * Notification paths used:
 *   notifications.navigation.anchor.drag      — drag alarm (emergency)
 *   notifications.navigation.anchor.watch     — approaching limit (warn)
 *   notifications.navigation.anchor.modeChange — mode changed while anchored (warn)
 */

/** Earth radius in metres for Haversine */
const EARTH_RADIUS_M = 6371000;

class AnchorAlarm {
    /**
     * @param {object}      app         Signal K app object
     * @param {AnchorState} anchorState shared state machine
     * @param {string}      pluginId
     */
    constructor(app, anchorState, pluginId) {
        this.app = app;
        this.anchorState = anchorState;
        this.pluginId = pluginId;

        /** Last computed distance vessel → anchor (metres) */
        this.currentRadius = null;

        /** Whether a drag notification is currently active */
        this._dragActive = false;

        /** Whether a watch notification is currently active */
        this._watchActive = false;

        /** Unsubscribe function returned by the subscription manager */
        this._unsubscribe = null;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Start position monitoring.
     */
    start() {
        const manager = this._findSubscriptionManager();
        if (!manager) {
            this.app.warn('AnchorAlarm: no subscription manager found, running in poll-only mode');
            return;
        }

        const subscription = {
            context: 'vessels.self',
            subscribe: [{ path: 'navigation.position', period: 2000 }]
        };

        const unsubscribes = [];
        manager.subscribe(
            subscription,
            unsubscribes,
            err => { if (err) this.app.error('AnchorAlarm subscription error:', err); },
            delta => this._handlePositionDelta(delta)
        );

        if (unsubscribes.length > 0) {
            this._unsubscribe = unsubscribes[0];
        }

        this.app.debug('AnchorAlarm started');
    }

    /**
     * Stop monitoring and clear any active notifications.
     */
    stop() {
        if (this._unsubscribe) {
            try { this._unsubscribe(); } catch (e) { /* ignore */ }
            this._unsubscribe = null;
        }
        this._clearAllNotifications();
        this.app.debug('AnchorAlarm stopped');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Position processing
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Process an incoming position delta.
     * @param {object} delta
     */
    _handlePositionDelta(delta) {
        if (!delta || !Array.isArray(delta.updates)) return;
        if (!this.anchorState.isMonitoring()) return;

        for (const update of delta.updates) {
            if (!Array.isArray(update.values)) continue;
            for (const pv of update.values) {
                if (pv.path === 'navigation.position' && pv.value) {
                    this._evaluate(pv.value);
                }
            }
        }
    }

    /**
     * Evaluate current vessel position against the anchor position.
     * @param {{ latitude: number, longitude: number }} vesselPos
     */
    _evaluate(vesselPos) {
        const anchorPos = this.anchorState.position;
        if (!anchorPos) return;

        const distance = this._haversine(anchorPos, vesselPos);
        this.currentRadius = distance;

        const maxRadius = this.anchorState.maxRadius;
        const watchRadius = maxRadius * 0.8; // warn at 80 % of limit

        if (distance > maxRadius) {
            this._emitDragAlarm(distance, maxRadius);
            this._clearWatchNotification();
        } else if (distance > watchRadius) {
            this._emitWatchNotification(distance, maxRadius);
            this._clearDragAlarm();
        } else {
            this._clearDragAlarm();
            this._clearWatchNotification();
        }

        // Always publish current radius to SK data model
        this._publishCurrentRadius(distance);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Notification helpers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Emit (or refresh) the drag alarm notification.
     * state = 'emergency' → cannot be silenced per Notifications API spec.
     */
    _emitDragAlarm(distance, maxRadius) {
        const drift = Math.round(distance - maxRadius);
        this.app.handleMessage(this.pluginId, {
            updates: [{
                values: [{
                    path: 'notifications.navigation.anchor.drag',
                    value: {
                        message: `Anchor dragging! Drift ${Math.round(distance)}m (limit ${maxRadius}m, +${drift}m)`,
                        method: ['sound', 'visual'],
                        state: 'emergency'
                    }
                }]
            }]
        });
        this._dragActive = true;
        if (this.app.debug) {
            this.app.debug(`Anchor drag alarm: ${Math.round(distance)}m > ${maxRadius}m`);
        }
    }

    /**
     * Emit (or refresh) the watch notification (approaching limit).
     * state = 'warn' → can be silenced.
     */
    _emitWatchNotification(distance, maxRadius) {
        this.app.handleMessage(this.pluginId, {
            updates: [{
                values: [{
                    path: 'notifications.navigation.anchor.watch',
                    value: {
                        message: `Approaching anchor limit: ${Math.round(distance)}m of ${maxRadius}m`,
                        method: ['visual'],
                        state: 'warn'
                    }
                }]
            }]
        });
        this._watchActive = true;
    }

    /**
     * Emit a warning when the mode changes away from 'anchored' while the
     * anchor is still deployed.
     * @param {string} newMode
     */
    emitModeChangeWarning(newMode) {
        this.app.handleMessage(this.pluginId, {
            updates: [{
                values: [{
                    path: 'notifications.navigation.anchor.modeChange',
                    value: {
                        message: `Mode changed to '${newMode}' but anchor is still deployed — monitoring continues`,
                        method: ['visual'],
                        state: 'warn'
                    }
                }]
            }]
        });
        this.app.debug(`Anchor mode-change warning emitted (new mode: ${newMode})`);
    }

    /**
     * Clear the drag alarm notification (set value to null).
     */
    _clearDragAlarm() {
        if (!this._dragActive) return;
        this.app.handleMessage(this.pluginId, {
            updates: [{
                values: [{
                    path: 'notifications.navigation.anchor.drag',
                    value: null
                }]
            }]
        });
        this._dragActive = false;
    }

    /**
     * Clear the watch notification.
     */
    _clearWatchNotification() {
        if (!this._watchActive) return;
        this.app.handleMessage(this.pluginId, {
            updates: [{
                values: [{
                    path: 'notifications.navigation.anchor.watch',
                    value: null
                }]
            }]
        });
        this._watchActive = false;
    }

    /**
     * Clear all active anchor notifications (called on raise or stop).
     */
    _clearAllNotifications() {
        this._clearDragAlarm();
        this._clearWatchNotification();

        // Also clear mode-change warning
        this.app.handleMessage(this.pluginId, {
            updates: [{
                values: [{
                    path: 'notifications.navigation.anchor.modeChange',
                    value: null
                }]
            }]
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SK data model publishing
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Publish the current vessel-to-anchor distance on the SK data model.
     * @param {number} distanceMetres
     */
    _publishCurrentRadius(distanceMetres) {
        this.app.handleMessage(this.pluginId, {
            updates: [{
                values: [{
                    path: 'navigation.anchor.currentRadius',
                    value: distanceMetres
                }]
            }]
        });
    }

    /**
     * Publish the full anchor state to the SK data model.
     * Called after drop/raise/reposition operations.
     */
    publishAnchorData() {
        const values = [];
        const snap = this.anchorState.snapshot();

        if (snap.position) {
            values.push({ path: 'navigation.anchor.position', value: snap.position });
        }

        values.push({ path: 'navigation.anchor.maxRadius', value: snap.maxRadius });

        if (snap.rodeLength !== null) {
            values.push({ path: 'navigation.anchor.rodeLength', value: snap.rodeLength });
        }

        if (values.length > 0) {
            this.app.handleMessage(this.pluginId, {
                updates: [{ values }]
            });
        }
    }

    /**
     * Clear anchor SK paths when anchor is raised.
     */
    clearAnchorData() {
        this.app.handleMessage(this.pluginId, {
            updates: [{
                values: [
                    { path: 'navigation.anchor.position', value: null },
                    { path: 'navigation.anchor.maxRadius', value: null },
                    { path: 'navigation.anchor.currentRadius', value: null },
                    { path: 'navigation.anchor.rodeLength', value: null }
                ]
            }]
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Utilities
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Haversine distance between two lat/lon points (metres).
     * @param {{ latitude: number, longitude: number }} a
     * @param {{ latitude: number, longitude: number }} b
     * @returns {number}
     */
    _haversine(a, b) {
        const toRad = deg => deg * Math.PI / 180;
        const dLat = toRad(b.latitude - a.latitude);
        const dLon = toRad(b.longitude - a.longitude);
        const sinDLat = Math.sin(dLat / 2);
        const sinDLon = Math.sin(dLon / 2);
        const h = sinDLat * sinDLat +
            Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * sinDLon * sinDLon;
        return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
    }

    /**
     * Locate the subscription manager on the app object.
     * @returns {object|null}
     */
    _findSubscriptionManager() {
        if (this.app.subscriptionmanager) return this.app.subscriptionmanager;
        if (this.app.signalk?.subscriptionmanager) return this.app.signalk.subscriptionmanager;
        return null;
    }

    /**
     * Return the current computed radius (metres) or null.
     * @returns {number|null}
     */
    getCurrentRadius() {
        return this.currentRadius;
    }
}

module.exports = AnchorAlarm;
