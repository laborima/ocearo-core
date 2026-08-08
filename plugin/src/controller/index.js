/**
 * src/controller/index.js
 *
 * PlayStation controller support for the autopilot.
 *
 * Binds a Bluetooth DualSense (or DualShock) read straight from /dev/input to
 * autopilot commands, and backs the controller screen of ocearo-ui:
 *   GET  /api/controller/config   configuration + live connection state
 *   PUT  /api/controller/config   update button mappings / sensitivity
 *   GET  /api/controller/state    raw input snapshot, for troubleshooting
 *
 * Reading the controller server-side rather than in the browser means it keeps
 * working with the screens off and with no ocearo-ui window focused — the point
 * being a pilot remote you can keep in the cockpit.
 *
 * Safety notes:
 *  - Engaging requires the button to be *held* (engageHoldMs, 1 s by default) so
 *    a controller knocked about in the cockpit cannot hand the boat to the pilot.
 *  - Disengaging is immediate, always, with no hold and no confirmation.
 *  - Losing the controller stops sending commands but deliberately does NOT
 *    disengage the pilot: a flat battery mid-passage must not drop the steering.
 */

const fs = require('fs');
const path = require('path');

const GamepadDevice = require('./gamepad-device');
const AutopilotCommander = require('./autopilot-commander');
const { AXIS_MAX, resolveSource, knownLabels } = require('./dualsense-mapping');

/** Actions driven as plain buttons. */
const STEP_ACTIONS = [
    'engage', 'disengage',
    'headingMinus1', 'headingPlus1',
    'headingMinus10', 'headingPlus10'
];

/** Actions driven proportionally by how far a stick is pushed. */
const RUDDER_ACTIONS = ['rudderLeft', 'rudderRight'];

/** Heading step, in degrees, applied by each step action. */
const STEP_DEGREES = {
    headingMinus1: -1,
    headingPlus1: 1,
    headingMinus10: -10,
    headingPlus10: 10
};

/** An axis mapped to a button-like action counts as pressed past this fraction. */
const DIGITAL_THRESHOLD = 0.5;

/** Key-repeat while a heading step action is held down. */
const REPEAT_DELAY_MS = 500;
const REPEAT_INTERVAL_MS = 250;

/** Proportional steering: tick rate and the slew rate at full stick. */
const RUDDER_TICK_MS = 100;
const MAX_RUDDER_RATE_DEG_PER_S = 6;

const DEFAULT_CONFIG = {
    enabled: true,
    // Defaults mirror the ones ocearo-ui falls back to, so a fresh install shows
    // the same mappings in the UI as the ones actually in force
    mappings: {
        engage: 'X',
        disengage: 'Circle',
        headingMinus1: 'D-Pad Left',
        headingPlus1: 'D-Pad Right',
        headingMinus10: 'L1',
        headingPlus10: 'R1',
        rudderLeft: 'Left Stick Left',
        rudderRight: 'Left Stick Right'
    },
    sensitivity: {
        rudder: 50,      // percent of MAX_RUDDER_RATE_DEG_PER_S
        deadZone: 10     // percent of full stick travel ignored
    },
    engageHoldMs: 1000
};

class ControllerManager {
    /**
     * @param {object} app       Signal K app object
     * @param {object} [options] plugin options (options.controller is honoured)
     */
    constructor(app, options = {}) {
        this.app = app;

        this._configPath = path.join(app.getDataDirPath(), 'ocearo-controller-config.json');
        this.config = this._mergeConfig(DEFAULT_CONFIG, options.controller);

        this.commander = new AutopilotCommander(app);
        this.device = new GamepadDevice(app);

        /** Raw input state, indexed by joydev button/axis number. */
        this._buttons = [];
        this._axes = [];

        /** action name → currently engaged. */
        this._active = {};
        /** action name → repeat timer handle. */
        this._timers = {};

        this._rudderTimer = null;
        this._rudderAccumulator = 0;
        /** Guards against piling up PUTs when the pilot answers slowly. */
        this._commandInFlight = false;

        this._sources = {};
        this._byButton = new Map();
        this._byAxis = new Map();

        this._lastAction = null;
        this._lastActionAt = null;
        this._lastError = null;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    /** Load persisted configuration and start watching for the controller. */
    start() {
        this._load();
        this._indexMappings();

        this.device.on('connected', dev => {
            this.app.debug(`Controller ready for autopilot: ${dev.name}`);
            this._resetInputState();
        });

        this.device.on('disconnected', reason => {
            // Drop every pending repeat so a controller lost mid-command cannot
            // leave the boat turning
            this._resetInputState();
            this.app.debug(`Controller gone (${reason}) — autopilot commands stopped`);
        });

        this.device.on('button', (index, pressed) => {
            this._buttons[index] = pressed;
            this._refreshActions(this._byButton.get(index));
        });

        this.device.on('axis', (index, value) => {
            this._axes[index] = value;
            this._refreshActions(this._byAxis.get(index));
        });

        if (this.config.enabled) {
            this.device.start();
        }

        this.app.debug('ControllerManager started');
    }

    /** Stop reading the controller and release everything. */
    stop() {
        this._resetInputState();
        this.device.removeAllListeners();
        this.device.stop();
        this.app.debug('ControllerManager stopped');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Configuration
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Deep-merge a partial configuration over a base one, one level into
     * mappings/sensitivity. Unknown keys are dropped.
     * @param {object} base
     * @param {object} [overrides]
     */
    _mergeConfig(base, overrides) {
        const merged = {
            enabled: base.enabled,
            mappings: { ...base.mappings },
            sensitivity: { ...base.sensitivity },
            engageHoldMs: base.engageHoldMs
        };
        if (!overrides || typeof overrides !== 'object') return merged;

        if (typeof overrides.enabled === 'boolean') merged.enabled = overrides.enabled;

        if (overrides.mappings && typeof overrides.mappings === 'object') {
            const valid = knownLabels();
            for (const [action, label] of Object.entries(overrides.mappings)) {
                if (!(action in merged.mappings)) continue;   // unknown action
                if (!valid.includes(label)) continue;         // unknown button
                merged.mappings[action] = label;
            }
        }

        if (overrides.sensitivity && typeof overrides.sensitivity === 'object') {
            const { rudder, deadZone } = overrides.sensitivity;
            if (Number.isFinite(rudder)) {
                merged.sensitivity.rudder = Math.min(100, Math.max(10, Math.round(rudder)));
            }
            if (Number.isFinite(deadZone)) {
                merged.sensitivity.deadZone = Math.min(30, Math.max(0, Math.round(deadZone)));
            }
        }

        if (Number.isFinite(overrides.engageHoldMs)) {
            merged.engageHoldMs = Math.min(5000, Math.max(0, Math.round(overrides.engageHoldMs)));
        }

        return merged;
    }

    /** Load persisted configuration, keeping defaults for anything missing. */
    _load() {
        try {
            if (!fs.existsSync(this._configPath)) return;
            const saved = JSON.parse(fs.readFileSync(this._configPath, 'utf8'));
            this.config = this._mergeConfig(this.config, saved);
            this.app.debug('Controller configuration loaded');
        } catch (err) {
            this.app.debug(`Could not load controller configuration: ${err.message}`);
        }
    }

    /**
     * Persist configuration atomically (temp file + rename) so a power cut
     * mid-write cannot leave a truncated JSON behind.
     */
    _save() {
        const tmp = `${this._configPath}.tmp`;
        try {
            fs.writeFileSync(tmp, JSON.stringify(this.config, null, 2), 'utf8');
            fs.renameSync(tmp, this._configPath);
        } catch (err) {
            this.app.error(`Could not save controller configuration: ${err.message}`);
            try { fs.unlinkSync(tmp); } catch { /* ignore cleanup failure */ }
        }
    }

    /**
     * Apply a configuration update coming from the UI.
     * @param {object} update
     * @returns {object} the configuration actually in force afterwards
     */
    updateConfig(update) {
        const wasEnabled = this.config.enabled;

        this.config = this._mergeConfig(this.config, update);
        this._indexMappings();
        this._save();

        // Enabling/disabling takes effect immediately
        if (this.config.enabled && !wasEnabled) {
            this.device.start();
        } else if (!this.config.enabled && wasEnabled) {
            this._resetInputState();
            this.device.stop();
        }

        return this.config;
    }

    /**
     * Rebuild the action → input source lookup, plus the reverse indices used to
     * find the affected actions from a single input event.
     */
    _indexMappings() {
        this._sources = {};
        this._byButton = new Map();
        this._byAxis = new Map();

        for (const [action, label] of Object.entries(this.config.mappings)) {
            const source = resolveSource(label);
            if (!source) {
                this.app.debug(`Controller: ignoring unknown button "${label}" for ${action}`);
                continue;
            }

            this._sources[action] = source;

            const index = source.kind === 'button' ? this._byButton : this._byAxis;
            if (!index.has(source.index)) index.set(source.index, []);
            index.get(source.index).push(action);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Input → action
    // ─────────────────────────────────────────────────────────────────────────

    /** Forget all input and cancel every pending repeat. */
    _resetInputState() {
        this._buttons = [];
        this._axes = [];
        this._active = {};
        this._rudderAccumulator = 0;

        for (const handle of Object.values(this._timers)) clearTimeout(handle);
        this._timers = {};

        this._stopRudder();
    }

    /**
     * Recompute the engaged state of the given actions and fire the edges.
     * @param {string[]|undefined} actions
     */
    _refreshActions(actions) {
        if (!actions || !actions.length) return;

        for (const action of actions) {
            if (RUDDER_ACTIONS.includes(action)) {
                // Proportional actions are re-evaluated on every tick, so all the
                // event has to do is start or stop the ticker
                this._syncRudder();
                continue;
            }

            const engaged = this._isEngaged(action);
            if (engaged === !!this._active[action]) continue;

            this._active[action] = engaged;
            if (engaged) this._onActionDown(action);
            else this._onActionUp(action);
        }
    }

    /**
     * Is the input mapped to this action currently pressed?
     * @param {string} action
     * @returns {boolean}
     */
    _isEngaged(action) {
        const source = this._sources[action];
        if (!source) return false;

        if (source.kind === 'button') return !!this._buttons[source.index];

        const value = this._axes[source.index] || 0;
        return Math.sign(value) === source.sign
            && Math.abs(value) >= DIGITAL_THRESHOLD * AXIS_MAX;
    }

    /**
     * Handle a mapped input going down.
     * @param {string} action
     */
    _onActionDown(action) {
        if (action === 'disengage') {
            // Never delayed, never repeated
            this._dispatch(action);
            return;
        }

        if (action === 'engage') {
            const hold = this.config.engageHoldMs;
            if (hold <= 0) {
                this._dispatch(action);
                return;
            }
            this.app.debug(`Controller: hold ${hold} ms to engage the autopilot`);
            this._timers[action] = setTimeout(() => {
                delete this._timers[action];
                if (this._active[action]) this._dispatch(action);
            }, hold);
            return;
        }

        // Heading steps: fire at once, then key-repeat while held
        this._dispatch(action);
        this._timers[action] = setTimeout(() => {
            this._timers[action] = setInterval(() => {
                if (this._active[action]) this._dispatch(action);
            }, REPEAT_INTERVAL_MS);
        }, REPEAT_DELAY_MS);
    }

    /**
     * Handle a mapped input going up — cancels any hold or repeat.
     * @param {string} action
     */
    _onActionUp(action) {
        const handle = this._timers[action];
        if (!handle) return;

        // The handle is a timeout before the repeat starts and an interval after;
        // clearing both covers either case
        clearTimeout(handle);
        clearInterval(handle);
        delete this._timers[action];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Proportional steering
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Normalised deflection of an action's axis, 0 at the edge of the dead zone
     * and 1 at full travel.
     * @param {string} action
     * @returns {number} 0..1
     */
    _deflection(action) {
        const source = this._sources[action];
        if (!source) return 0;

        if (source.kind === 'button') {
            // A rudder action mapped to a button steers at full rate while held
            return this._buttons[source.index] ? 1 : 0;
        }

        const value = this._axes[source.index] || 0;
        if (Math.sign(value) !== source.sign) return 0;

        const deadZone = (this.config.sensitivity.deadZone / 100) * AXIS_MAX;
        const travel = Math.abs(value) - deadZone;
        if (travel <= 0) return 0;

        return Math.min(1, travel / (AXIS_MAX - deadZone));
    }

    /** Start, stop or keep the proportional steering ticker running. */
    _syncRudder() {
        const active = RUDDER_ACTIONS.some(action => this._deflection(action) > 0);

        if (active && !this._rudderTimer) {
            this._rudderAccumulator = 0;
            this._rudderTimer = setInterval(() => this._rudderTick(), RUDDER_TICK_MS);
        } else if (!active && this._rudderTimer) {
            this._stopRudder();
        }
    }

    /** Stop proportional steering. */
    _stopRudder() {
        if (!this._rudderTimer) return;
        clearInterval(this._rudderTimer);
        this._rudderTimer = null;
        this._rudderAccumulator = 0;
    }

    /**
     * One steering tick: integrate the requested turn rate and send a 1° nudge
     * each time a whole degree has built up. Integrating rather than sending one
     * command per tick keeps a gentle stick input to a trickle of commands
     * instead of flooding the bus.
     */
    _rudderTick() {
        const left = this._deflection('rudderLeft');
        const right = this._deflection('rudderRight');
        const net = right - left;

        if (net === 0) {
            this._stopRudder();
            return;
        }

        const rate = MAX_RUDDER_RATE_DEG_PER_S * (this.config.sensitivity.rudder / 100) * net;
        this._rudderAccumulator += rate * (RUDDER_TICK_MS / 1000);

        while (Math.abs(this._rudderAccumulator) >= 1) {
            const step = this._rudderAccumulator > 0 ? 1 : -1;
            this._rudderAccumulator -= step;
            this._send(step > 0 ? 'rudderRight' : 'rudderLeft', () =>
                this.commander.adjustHeading(step));
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Command dispatch
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Run the autopilot command bound to an action.
     * @param {string} action
     */
    _dispatch(action) {
        if (action === 'engage') return this._send(action, () => this.commander.engage());
        if (action === 'disengage') return this._send(action, () => this.commander.disengage());

        const degrees = STEP_DEGREES[action];
        if (degrees === undefined) return undefined;

        return this._send(action, () => this.commander.adjustHeading(degrees));
    }

    /**
     * Fire a command, dropping it if one is still outstanding. Dropping rather
     * than queueing matters for held buttons and stick input: a slow pilot must
     * not build a backlog that keeps turning the boat after the stick is centred.
     * @param {string} action
     * @param {function(): Promise} run
     */
    _send(action, run) {
        if (this._commandInFlight) {
            this.app.debug(`Controller: ${action} dropped, previous command still running`);
            return undefined;
        }

        this._commandInFlight = true;
        this._lastAction = action;
        this._lastActionAt = new Date().toISOString();

        return run()
            .then(() => {
                this._lastError = null;
                this.app.debug(`Controller: ${action} accepted by the autopilot`);
            })
            .catch(err => {
                this._lastError = err.message;
                this.app.debug(`Controller: ${action} failed — ${err.message}`);
            })
            .finally(() => {
                this._commandInFlight = false;
            });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Reporting
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Payload for GET /api/controller/config — configuration plus everything the
     * UI needs to tell the user why nothing is happening.
     * @returns {object}
     */
    snapshot() {
        return {
            ...this.config,
            connected: this.device.connected,
            device: this.device.device
                ? {
                    name: this.device.device.name,
                    path: this.device.device.jsPath,
                    address: this.device.device.uniq
                }
                : null,
            autopilot: this.commander.status(),
            lastAction: this._lastAction,
            lastActionAt: this._lastActionAt,
            lastError: this._lastError
        };
    }

    /**
     * Payload for GET /api/controller/state — raw input, for troubleshooting a
     * mapping without needing shell access to the Pi.
     * @returns {object}
     */
    inputState() {
        const deflections = {};
        for (const action of RUDDER_ACTIONS) {
            deflections[action] = Number(this._deflection(action).toFixed(3));
        }

        return {
            connected: this.device.connected,
            device: this.device.device,
            buttons: Array.from(this._buttons, Boolean),
            axes: Array.from(this._axes, v => v || 0),
            activeActions: Object.keys(this._active).filter(a => this._active[a]),
            deflections,
            steering: this._rudderTimer !== null,
            autopilot: this.commander.status()
        };
    }

}

module.exports = ControllerManager;
module.exports.DEFAULT_CONFIG = DEFAULT_CONFIG;
module.exports.STEP_ACTIONS = STEP_ACTIONS;
module.exports.RUDDER_ACTIONS = RUDDER_ACTIONS;
