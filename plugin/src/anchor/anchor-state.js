/**
 * src/anchor/anchor-state.js
 *
 * Anchor state machine.
 * Manages the lifecycle: raised → dropping → dropped → raising → raised
 * Persists state to disk so it survives plugin restarts.
 */

const fs = require('fs');
const path = require('path');

const STATES = {
    RAISED: 'raised',
    DROPPING: 'dropping',
    DROPPED: 'dropped',
    RAISING: 'raising'
};

class AnchorState {
    /**
     * @param {object} app  Signal K app object
     */
    constructor(app) {
        this.app = app;
        this._stateFilePath = path.join(app.getDataDirPath(), 'ocearo-anchor-state.json');
        this._state = {
            state: STATES.RAISED,
            position: null,       // { latitude, longitude } — anchor drop position
            maxRadius: 30,        // metres — alarm radius
            rodeLength: null,     // metres — chain/rope paid out
            anchorDepth: null,    // metres — water depth at drop point
            droppedAt: null,      // ISO timestamp
            raisedAt: null        // ISO timestamp
        };
    }

    /**
     * Load persisted state from disk.
     */
    load() {
        try {
            if (fs.existsSync(this._stateFilePath)) {
                const raw = fs.readFileSync(this._stateFilePath, 'utf8');
                const saved = JSON.parse(raw);
                Object.assign(this._state, saved);
                this.app.debug(`Anchor state loaded: ${this._state.state}`);
            }
        } catch (err) {
            this.app.warn(`Could not load anchor state: ${err.message}`);
        }
    }

    /**
     * Persist current state to disk.
     */
    save() {
        try {
            fs.writeFileSync(this._stateFilePath, JSON.stringify(this._state, null, 2), 'utf8');
        } catch (err) {
            this.app.warn(`Could not save anchor state: ${err.message}`);
        }
    }

    /** @returns {string} current state name */
    get state() {
        return this._state.state;
    }

    /** @returns {object|null} anchor drop position */
    get position() {
        return this._state.position;
    }

    /** @returns {number} alarm radius in metres */
    get maxRadius() {
        return this._state.maxRadius;
    }

    /** @returns {number|null} rode length in metres */
    get rodeLength() {
        return this._state.rodeLength;
    }

    /** @returns {number|null} anchor depth in metres */
    get anchorDepth() {
        return this._state.anchorDepth;
    }

    /** @returns {string|null} ISO timestamp when anchor was dropped */
    get droppedAt() {
        return this._state.droppedAt;
    }

    /** @returns {boolean} true when anchor is on the bottom */
    isDropped() {
        return this._state.state === STATES.DROPPED;
    }

    /** @returns {boolean} true when anchor monitoring should be active */
    isMonitoring() {
        return this._state.state === STATES.DROPPED || this._state.state === STATES.DROPPING;
    }

    /**
     * Transition to DROPPING — anchor is being lowered.
     * Records the vessel position at the moment of drop.
     * @param {object} position  { latitude, longitude }
     */
    drop(position) {
        this._state.state = STATES.DROPPING;
        this._state.position = position ? { ...position } : null;
        this._state.droppedAt = new Date().toISOString();
        this._state.raisedAt = null;
        this.save();
        this.app.debug('Anchor state → DROPPING');
    }

    /**
     * Confirm anchor is set on the bottom (called after drop completes).
     * @param {object} [position]  refined anchor position if known
     */
    confirmDropped(position) {
        this._state.state = STATES.DROPPED;
        if (position) {
            this._state.position = { ...position };
        }
        this.save();
        this.app.debug('Anchor state → DROPPED');
    }

    /**
     * Transition to RAISING — anchor is being retrieved.
     */
    raise() {
        this._state.state = STATES.RAISING;
        this.save();
        this.app.debug('Anchor state → RAISING');
    }

    /**
     * Confirm anchor is fully raised.
     */
    confirmRaised() {
        this._state.state = STATES.RAISED;
        this._state.raisedAt = new Date().toISOString();
        this._state.position = null;
        this._state.rodeLength = null;
        this._state.anchorDepth = null;
        this.save();
        this.app.debug('Anchor state → RAISED');
    }

    /**
     * Update the alarm radius.
     * @param {number} radiusMetres
     */
    setRadius(radiusMetres) {
        this._state.maxRadius = radiusMetres;
        this.save();
    }

    /**
     * Update rode length and anchor depth (used for position calculation).
     * @param {number} rodeLength  metres
     * @param {number} anchorDepth metres
     */
    setRode(rodeLength, anchorDepth) {
        this._state.rodeLength = rodeLength;
        this._state.anchorDepth = anchorDepth;
        this.save();
    }

    /**
     * Reposition the recorded anchor position.
     * @param {object} position  { latitude, longitude }
     */
    reposition(position) {
        this._state.position = { ...position };
        this.save();
        this.app.debug('Anchor position updated');
    }

    /**
     * Return a plain snapshot of the full state.
     * @returns {object}
     */
    snapshot() {
        return { ...this._state };
    }
}

AnchorState.STATES = STATES;

module.exports = AnchorState;
