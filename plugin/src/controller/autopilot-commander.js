/**
 * src/controller/autopilot-commander.js
 *
 * Turns controller actions into autopilot commands.
 *
 * Commands go out through app.putSelfPath(), the in-process Signal K PUT
 * mechanism. That deliberately avoids an HTTP round-trip to our own server,
 * which would otherwise have to deal with the self-signed certificate and with
 * whatever security strategy is configured.
 *
 * The paths below are the ones @signalk/signalk-autopilot registers PUT handlers
 * for, so a boat running that plugin (type raymarineN2K on cirrus) is driven
 * without any further glue. When no autopilot plugin is loaded the server answers
 * 405 "PUT not supported"; we record that so the UI can say so plainly instead of
 * silently swallowing every button press.
 */

const STATE_PATH = 'steering.autopilot.state';
const ADJUST_HEADING_PATH = 'steering.autopilot.actions.adjustHeading';
const TARGET_HEADING_PATH = 'steering.autopilot.target.headingMagnetic';

const ENGAGED_STATE = 'auto';
const STANDBY_STATE = 'standby';

/** Steps @signalk/signalk-autopilot accepts on the adjustHeading action, in degrees. */
const ADJUST_STEPS = [1, -1, 10, -10];

/** Command channel states reported to the UI. */
const CHANNEL = {
    UNKNOWN: 'unknown',
    OK: 'ok',
    UNAVAILABLE: 'unavailable'
};

const DEG_TO_RAD = Math.PI / 180;
const TWO_PI = Math.PI * 2;

class AutopilotCommander {
    /**
     * @param {object} app  Signal K app object
     */
    constructor(app) {
        this.app = app;

        this._channel = CHANNEL.UNKNOWN;
        this._lastError = null;
        this._lastCommand = null;
        this._lastCommandAt = null;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // State inspection
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Current autopilot state as reported on the bus.
     * @returns {string|null} 'standby' | 'auto' | 'wind' | 'route' | null
     */
    get state() {
        const value = this.app.getSelfPath(`${STATE_PATH}.value`);
        return typeof value === 'string' ? value : null;
    }

    /** @returns {boolean} true when the pilot is actually steering. */
    get engaged() {
        const state = this.state;
        return state === 'auto' || state === 'wind' || state === 'route';
    }

    /**
     * Snapshot for the UI / diagnostics.
     * @returns {object}
     */
    status() {
        return {
            // An autopilot reporting its state on the bus — independent of whether
            // we are able to command it
            detected: this.state !== null,
            state: this.state,
            engaged: this.engaged,
            commandChannel: this._channel,
            lastCommand: this._lastCommand,
            lastCommandAt: this._lastCommandAt,
            lastError: this._lastError
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Commands
    // ─────────────────────────────────────────────────────────────────────────

    /** Engage the pilot in compass mode. */
    async engage() {
        return this._put(STATE_PATH, ENGAGED_STATE, 'engage');
    }

    /** Drop the pilot back to standby. */
    async disengage() {
        return this._put(STATE_PATH, STANDBY_STATE, 'disengage');
    }

    /**
     * Nudge the target heading.
     *
     * Uses the adjustHeading action when the autopilot plugin exposes it, since
     * that is a relative command the pilot applies to its own target. Falls back
     * to writing an absolute target heading, which needs the current target to be
     * known and is therefore less reliable.
     *
     * @param {number} degrees  one of ±1, ±10
     */
    async adjustHeading(degrees) {
        if (!ADJUST_STEPS.includes(degrees)) {
            throw new Error(`adjustHeading only accepts ${ADJUST_STEPS.join(', ')} degrees`);
        }

        try {
            return await this._put(ADJUST_HEADING_PATH, degrees, `adjustHeading ${degrees}`);
        } catch (err) {
            // 405 means no handler for the action path — try the absolute target
            if (!/405|not supported/i.test(err.message)) throw err;
            return this._putAbsoluteHeading(degrees);
        }
    }

    /**
     * Fallback for pilots that only accept an absolute target heading.
     * @param {number} degrees  delta to apply to the current target
     */
    async _putAbsoluteHeading(degrees) {
        const current = this.app.getSelfPath(`${TARGET_HEADING_PATH}.value`);
        if (typeof current !== 'number') {
            throw new Error('No autopilot target heading on the bus — cannot adjust it');
        }

        // Normalise into [0, 2π) so we never hand the pilot a negative heading
        const next = ((current + degrees * DEG_TO_RAD) % TWO_PI + TWO_PI) % TWO_PI;
        return this._put(TARGET_HEADING_PATH, next, `targetHeading ${degrees}`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PUT plumbing
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Issue an in-process Signal K PUT and normalise the outcome.
     * @param {string} path
     * @param {*} value
     * @param {string} label  human-readable command name, for diagnostics
     */
    async _put(path, value, label) {
        this._lastCommand = label;
        this._lastCommandAt = new Date().toISOString();

        if (typeof this.app.putSelfPath !== 'function') {
            this._channel = CHANNEL.UNAVAILABLE;
            this._lastError = 'This Signal K server does not expose putSelfPath';
            throw new Error(this._lastError);
        }

        let reply;
        try {
            // The callback is only used for asynchronous progress updates; the
            // returned promise carries the final outcome
            reply = await this.app.putSelfPath(path, value, () => {});
        } catch (err) {
            this._lastError = err.message;
            throw err;
        }

        const statusCode = reply && reply.statusCode !== undefined ? reply.statusCode : 200;

        if (statusCode >= 400) {
            const message = (reply && reply.message) || `PUT ${path} rejected (${statusCode})`;
            // 405 is the server saying nothing handles this path at all, i.e. no
            // autopilot plugin is loaded — a configuration problem. Any other
            // rejection means a handler did answer and simply refused this
            // command (typically "not in auto mode"), so the channel itself works.
            this._channel = statusCode === 405 ? CHANNEL.UNAVAILABLE : CHANNEL.OK;
            this._lastError = message;
            throw new Error(message);
        }

        this._channel = CHANNEL.OK;
        this._lastError = null;
        return reply;
    }
}

module.exports = AutopilotCommander;
module.exports.CHANNEL = CHANNEL;
module.exports.PATHS = { STATE_PATH, ADJUST_HEADING_PATH, TARGET_HEADING_PATH };
