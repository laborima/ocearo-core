/**
 * src/controller/gamepad-device.js
 *
 * Reads a Bluetooth game controller straight from the Linux joystick API
 * (/dev/input/jsN) with no external dependency.
 *
 * The device node number is not stable — it depends on the order in which input
 * devices were bound, and it changes every time the controller reconnects. So we
 * locate it by name in /proc/bus/input/devices rather than hardcoding a path,
 * and we keep re-scanning while disconnected: a DualSense powers itself down
 * after a few minutes idle and comes back on a different jsN.
 *
 * Emits:
 *   'connected'    (device)              device = { name, jsPath, uniq }
 *   'disconnected' (reason)
 *   'button'       (index, pressed)
 *   'axis'         (index, value)        value in [-32767, 32767]
 */

const fs = require('fs');
const { EventEmitter } = require('events');

/** sizeof(struct js_event): __u32 time, __s16 value, __u8 type, __u8 number */
const JS_EVENT_SIZE = 8;
const JS_EVENT_BUTTON = 0x01;
const JS_EVENT_AXIS = 0x02;
/** Synthetic events joydev replays on open to report the initial state. */
const JS_EVENT_INIT = 0x80;

const PROC_INPUT_DEVICES = '/proc/bus/input/devices';
const DEFAULT_RESCAN_MS = 3000;

/**
 * The kernel exposes the motion sensors and the touchpad as extra input devices
 * sharing the controller's name, and the motion sensor one even gets its own jsN.
 * Neither must ever be picked as the gamepad.
 */
const EXCLUDE_PATTERN = /motion sensors|touchpad/i;

class GamepadDevice extends EventEmitter {
    /**
     * @param {object} app                 Signal K app object (for debug/error)
     * @param {object} [options]
     * @param {RegExp} [options.namePattern]       which controller to bind to
     * @param {number} [options.rescanIntervalMs]  how often to look for the device
     */
    constructor(app, options = {}) {
        super();
        this.app = app;
        this.namePattern = options.namePattern || /dualsense|dualshock|wireless controller/i;
        this._rescanMs = options.rescanIntervalMs || DEFAULT_RESCAN_MS;

        /** @type {boolean} */
        this.connected = false;
        /** @type {{name: string, jsPath: string, uniq: string|null}|null} */
        this.device = null;

        this._stream = null;
        this._pending = Buffer.alloc(0);
        this._rescanTimer = null;
        this._stopped = true;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    /** Begin watching for the controller and reading its events. */
    start() {
        if (!this._stopped) return;
        this._stopped = false;

        this._open();
        this._rescanTimer = setInterval(() => {
            if (!this.connected) this._open();
        }, this._rescanMs);
        // Never hold the event loop open just to poll for a gamepad
        if (this._rescanTimer.unref) this._rescanTimer.unref();
    }

    /** Stop reading and release the device node. */
    stop() {
        this._stopped = true;

        if (this._rescanTimer) {
            clearInterval(this._rescanTimer);
            this._rescanTimer = null;
        }
        this._closeStream();

        if (this.connected) {
            this.connected = false;
            this.emit('disconnected', 'stopped');
        }
        this.device = null;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Discovery
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Find the controller's joystick node by parsing /proc/bus/input/devices.
     * @param {RegExp} namePattern
     * @returns {{name: string, jsPath: string, uniq: string|null}|null}
     */
    static discover(namePattern) {
        let raw;
        try {
            raw = fs.readFileSync(PROC_INPUT_DEVICES, 'utf8');
        } catch {
            return null;
        }

        // Blocks are separated by a blank line
        for (const block of raw.split(/\n\s*\n/)) {
            const nameMatch = block.match(/^N: Name="(.*)"$/m);
            if (!nameMatch) continue;

            const name = nameMatch[1];
            if (!namePattern.test(name) || EXCLUDE_PATTERN.test(name)) continue;

            const handlersMatch = block.match(/^H: Handlers=(.*)$/m);
            if (!handlersMatch) continue;

            const js = handlersMatch[1].trim().split(/\s+/).find(h => /^js\d+$/.test(h));
            if (!js) continue;

            const uniqMatch = block.match(/^U: Uniq=(.*)$/m);
            return {
                name,
                jsPath: `/dev/input/${js}`,
                uniq: uniqMatch ? uniqMatch[1].trim() || null : null
            };
        }

        return null;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Device I/O
    // ─────────────────────────────────────────────────────────────────────────

    /** Try to bind to the controller; silently gives up until the next re-scan. */
    _open() {
        if (this._stopped || this._stream) return;

        const found = GamepadDevice.discover(this.namePattern);
        if (!found) return;

        let stream;
        try {
            stream = fs.createReadStream(found.jsPath);
        } catch (err) {
            this.app.debug(`Controller: cannot open ${found.jsPath}: ${err.message}`);
            return;
        }

        this._stream = stream;
        this._pending = Buffer.alloc(0);

        stream.on('data', chunk => this._onData(chunk));

        // A powered-down controller makes the read fail with ENODEV; treat any
        // error or EOF as a disconnect and let the re-scan pick it up again.
        stream.on('error', err => this._onLost(err.message));
        stream.on('close', () => this._onLost('device closed'));

        stream.once('readable', () => {
            if (this._stream !== stream || this.connected) return;
            this.connected = true;
            this.device = found;
            this.app.debug(`Controller connected: ${found.name} on ${found.jsPath}`);
            this.emit('connected', found);
        });
    }

    /**
     * Parse whatever joydev handed us. Reads are not guaranteed to land on an
     * 8-byte boundary, so an incomplete tail is carried over to the next chunk.
     * @param {Buffer} chunk
     */
    _onData(chunk) {
        const buf = this._pending.length ? Buffer.concat([this._pending, chunk]) : chunk;

        let offset = 0;
        while (buf.length - offset >= JS_EVENT_SIZE) {
            const value = buf.readInt16LE(offset + 4);
            const type = buf.readUInt8(offset + 6);
            const number = buf.readUInt8(offset + 7);
            offset += JS_EVENT_SIZE;

            // Skip the initial-state replay, otherwise every reconnect would
            // look like a burst of real button presses
            if (type & JS_EVENT_INIT) continue;

            if (type & JS_EVENT_BUTTON) {
                this.emit('button', number, value === 1);
            } else if (type & JS_EVENT_AXIS) {
                this.emit('axis', number, value);
            }
        }

        this._pending = offset < buf.length ? buf.subarray(offset) : Buffer.alloc(0);
    }

    /**
     * Handle the controller going away.
     * @param {string} reason
     */
    _onLost(reason) {
        const wasConnected = this.connected;
        this._closeStream();
        this.connected = false;

        if (wasConnected) {
            this.app.debug(`Controller disconnected: ${reason}`);
            this.emit('disconnected', reason);
        }
    }

    /** Tear down the read stream without emitting anything. */
    _closeStream() {
        if (!this._stream) return;

        const stream = this._stream;
        this._stream = null;
        stream.removeAllListeners();
        try {
            stream.destroy();
        } catch {
            /* already gone */
        }
        this._pending = Buffer.alloc(0);
    }
}

module.exports = GamepadDevice;
