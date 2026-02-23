/**
 * src/anchor/anchor-plugin.js
 *
 * Implements the Signal K proposed Anchor API:
 *   POST /signalk/v2/api/vessels/self/navigation/anchor/drop
 *   POST /signalk/v2/api/vessels/self/navigation/anchor/radius   { value: number }
 *   POST /signalk/v2/api/vessels/self/navigation/anchor/reposition { rodeLength, anchorDepth }
 *   POST /signalk/v2/api/vessels/self/navigation/anchor/raise
 *
 * Additional read endpoints:
 *   GET  /signalk/v2/api/vessels/self/navigation/anchor          — full state snapshot
 *   GET  /signalk/v2/api/vessels/self/navigation/anchor/status   — lightweight status
 *
 * Registered via plugin.registerWithRouter(router).
 * The router prefix is already /signalk/v2/api/plugins/ocearo-core so we
 * register under /anchor/* and expose the canonical paths as aliases via
 * app.registerPutHandler when available.
 */

const AnchorState = require('./anchor-state');
const AnchorAlarm = require('./anchor-alarm');

class AnchorPlugin {
    /**
     * @param {object} app       Signal K app object
     * @param {string} pluginId
     * @param {object} config    plugin configuration
     */
    constructor(app, pluginId, config) {
        this.app = app;
        this.pluginId = pluginId;
        this.config = config || {};

        this.anchorState = new AnchorState(app);
        this.anchorAlarm = new AnchorAlarm(app, this.anchorState, pluginId);

        /** Callback invoked when mode should change (set by brain) */
        this._onModeChangeCb = null;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Start the anchor plugin — load persisted state and begin monitoring
     * if the anchor was already deployed when the plugin last stopped.
     */
    start() {
        this.anchorState.load();

        if (this.anchorState.isMonitoring()) {
            this.app.debug('Anchor was deployed at last shutdown — resuming monitoring');
            this.anchorAlarm.start();
            this.anchorAlarm.publishAnchorData();
        }

        this.app.debug('AnchorPlugin started');
    }

    /**
     * Stop monitoring and persist state.
     */
    stop() {
        this.anchorAlarm.stop();
        this.anchorState.save();
        this.app.debug('AnchorPlugin stopped');
    }

    /**
     * Register a callback that the brain uses to be notified of mode changes
     * triggered by anchor operations.
     * @param {function} cb  (newMode: string) => void
     */
    onModeChange(cb) {
        this._onModeChangeCb = cb;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Mode change integration
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Called by the brain when the operating mode changes.
     * If the anchor is deployed and the mode moves away from 'anchored',
     * we emit a warning but keep monitoring active.
     * @param {string} newMode
     */
    handleModeChange(newMode) {
        if (newMode === 'anchored') {
            // Switching into anchor mode — start alarm if anchor is deployed
            if (this.anchorState.isMonitoring()) {
                this.anchorAlarm.start();
                this.anchorAlarm.publishAnchorData();
            }
            return;
        }

        // Switching away from anchor mode
        if (this.anchorState.isDropped()) {
            this.anchorAlarm.emitModeChangeWarning(newMode);
            this.app.debug(`Mode changed to '${newMode}' but anchor still deployed — alarm stays active`);
            // Monitoring intentionally continues
        } else if (this.anchorState.state === AnchorState.STATES.RAISED) {
            // Anchor raised — clean stop
            this.anchorAlarm.stop();
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Router registration
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Register REST endpoints on the plugin router.
     * The router is already mounted at /signalk/v2/api/plugins/ocearo-core
     * so paths here are relative to that prefix.
     * @param {object} router  Express router
     */
    registerWithRouter(router) {
        // ── DROP ──────────────────────────────────────────────────────────────
        router.post('/navigation/anchor/drop', async (req, res) => {
            try {
                const position = await this._getCurrentPosition();
                if (!position) {
                    return res.status(422).json({
                        state: 'FAILED',
                        statusCode: 422,
                        message: 'No vessel position available — cannot record anchor drop point'
                    });
                }

                this.anchorState.drop(position);
                this.anchorAlarm.start();
                this.anchorAlarm.publishAnchorData();

                // Switch brain mode to 'anchored'
                this._triggerModeChange('anchored');

                this.app.debug(`Anchor dropped at ${position.latitude.toFixed(5)}, ${position.longitude.toFixed(5)}`);

                res.json({
                    state: 'COMPLETED',
                    statusCode: 200,
                    position,
                    anchorState: this.anchorState.snapshot()
                });
            } catch (err) {
                this.app.error('Anchor drop error:', err.message);
                res.status(500).json({ state: 'FAILED', statusCode: 500, message: err.message });
            }
        });

        // ── RADIUS ────────────────────────────────────────────────────────────
        router.post('/navigation/anchor/radius', (req, res) => {
            const { value } = req.body;

            if (value === undefined || value === null) {
                return res.status(400).json({
                    state: 'FAILED',
                    statusCode: 400,
                    message: 'Body must contain { value: number } — radius in metres'
                });
            }

            const radius = parseFloat(value);
            if (isNaN(radius) || radius <= 0) {
                return res.status(400).json({
                    state: 'FAILED',
                    statusCode: 400,
                    message: 'Radius must be a positive number (metres)'
                });
            }

            this.anchorState.setRadius(radius);
            this.anchorAlarm.publishAnchorData();

            this.app.debug(`Anchor alarm radius set to ${radius}m`);

            res.json({
                state: 'COMPLETED',
                statusCode: 200,
                maxRadius: radius
            });
        });

        // ── REPOSITION ────────────────────────────────────────────────────────
        router.post('/navigation/anchor/reposition', async (req, res) => {
            const { rodeLength, anchorDepth } = req.body;

            if (rodeLength === undefined || anchorDepth === undefined) {
                return res.status(400).json({
                    state: 'FAILED',
                    statusCode: 400,
                    message: 'Body must contain { rodeLength: number, anchorDepth: number } — both in metres'
                });
            }

            const rode = parseFloat(rodeLength);
            const depth = parseFloat(anchorDepth);

            if (isNaN(rode) || rode <= 0 || isNaN(depth) || depth <= 0) {
                return res.status(400).json({
                    state: 'FAILED',
                    statusCode: 400,
                    message: 'rodeLength and anchorDepth must be positive numbers (metres)'
                });
            }

            try {
                const vesselPos = await this._getCurrentPosition();
                const anchorPos = this._calculateAnchorPosition(vesselPos, rode, depth);

                this.anchorState.setRode(rode, depth);
                this.anchorState.reposition(anchorPos || vesselPos);
                this.anchorState.confirmDropped(anchorPos || vesselPos);
                this.anchorAlarm.publishAnchorData();

                this.app.debug(`Anchor repositioned — rode ${rode}m, depth ${depth}m`);

                res.json({
                    state: 'COMPLETED',
                    statusCode: 200,
                    anchorPosition: anchorPos || vesselPos,
                    rodeLength: rode,
                    anchorDepth: depth
                });
            } catch (err) {
                this.app.error('Anchor reposition error:', err.message);
                res.status(500).json({ state: 'FAILED', statusCode: 500, message: err.message });
            }
        });

        // ── RAISE ─────────────────────────────────────────────────────────────
        router.post('/navigation/anchor/raise', (req, res) => {
            this.anchorState.raise();
            this.anchorAlarm.stop();
            this.anchorAlarm.clearAnchorData();

            // Confirm raised immediately (no windlass feedback in this implementation)
            this.anchorState.confirmRaised();

            // Switch brain mode back to 'sailing' (or 'motoring' if engine running)
            this._triggerModeChange('sailing');

            this.app.debug('Anchor raised');

            res.json({
                state: 'COMPLETED',
                statusCode: 200,
                anchorState: this.anchorState.snapshot()
            });
        });

        // ── STATUS (GET) ──────────────────────────────────────────────────────
        router.get('/navigation/anchor/status', (req, res) => {
            res.json({
                state: this.anchorState.state,
                position: this.anchorState.position,
                maxRadius: this.anchorState.maxRadius,
                currentRadius: this.anchorAlarm.getCurrentRadius(),
                rodeLength: this.anchorState.rodeLength,
                droppedAt: this.anchorState.droppedAt,
                dragging: this.anchorAlarm.getCurrentRadius() !== null &&
                    this.anchorAlarm.getCurrentRadius() > this.anchorState.maxRadius
            });
        });

        // ── FULL SNAPSHOT (GET) ───────────────────────────────────────────────
        router.get('/navigation/anchor', (req, res) => {
            res.json({
                ...this.anchorState.snapshot(),
                currentRadius: this.anchorAlarm.getCurrentRadius()
            });
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Read the current vessel position from the SK data model.
     * @returns {Promise<{latitude: number, longitude: number}|null>}
     */
    async _getCurrentPosition() {
        try {
            const pos = this.app.getSelfPath('navigation.position');
            if (pos && pos.value) {
                return { latitude: pos.value.latitude, longitude: pos.value.longitude };
            }
            if (pos && pos.latitude !== undefined) {
                return { latitude: pos.latitude, longitude: pos.longitude };
            }
            return null;
        } catch (err) {
            this.app.warn('Could not read vessel position:', err.message);
            return null;
        }
    }

    /**
     * Estimate anchor position from vessel position, rode length and depth.
     * Uses a simple catenary approximation: horizontal scope ≈ √(rode² - depth²).
     * The bearing is taken from the current COG (vessel is pointing into the wind/current).
     *
     * @param {{ latitude, longitude }|null} vesselPos
     * @param {number} rode    metres
     * @param {number} depth   metres
     * @returns {{ latitude, longitude }|null}
     */
    _calculateAnchorPosition(vesselPos, rode, depth) {
        if (!vesselPos) return null;

        const horizontalScope = Math.sqrt(Math.max(0, rode * rode - depth * depth));
        if (horizontalScope < 1) return vesselPos;

        // Read COG to determine direction anchor was dropped
        let bearingRad = 0;
        try {
            const cog = this.app.getSelfPath('navigation.courseOverGroundTrue');
            const cogVal = cog?.value ?? cog;
            if (typeof cogVal === 'number') {
                bearingRad = cogVal; // already in radians
            }
        } catch (e) { /* use 0 as fallback */ }

        // Project vessel position forward by horizontalScope metres along bearing
        const R = 6371000;
        const lat1 = vesselPos.latitude * Math.PI / 180;
        const lon1 = vesselPos.longitude * Math.PI / 180;
        const d = horizontalScope / R;

        const lat2 = Math.asin(
            Math.sin(lat1) * Math.cos(d) +
            Math.cos(lat1) * Math.sin(d) * Math.cos(bearingRad)
        );
        const lon2 = lon1 + Math.atan2(
            Math.sin(bearingRad) * Math.sin(d) * Math.cos(lat1),
            Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
        );

        return {
            latitude: lat2 * 180 / Math.PI,
            longitude: lon2 * 180 / Math.PI
        };
    }

    /**
     * Notify the brain of a mode change triggered by anchor operations.
     * @param {string} mode
     */
    _triggerModeChange(mode) {
        if (typeof this._onModeChangeCb === 'function') {
            try {
                this._onModeChangeCb(mode);
            } catch (err) {
                this.app.warn('AnchorPlugin mode change callback error:', err.message);
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Public accessors (used by brain for status reporting)
    // ─────────────────────────────────────────────────────────────────────────

    /** @returns {string} current anchor state name */
    getState() {
        return this.anchorState.state;
    }

    /** @returns {boolean} */
    isDropped() {
        return this.anchorState.isDropped();
    }

    /** @returns {number|null} current vessel-to-anchor distance in metres */
    getCurrentRadius() {
        return this.anchorAlarm.getCurrentRadius();
    }
}

module.exports = AnchorPlugin;
