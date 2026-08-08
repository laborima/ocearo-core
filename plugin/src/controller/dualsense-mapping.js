/**
 * src/controller/dualsense-mapping.js
 *
 * Translates the button labels shown by the ocearo-ui autopilot settings screen
 * into Linux joydev indices.
 *
 * joydev numbers buttons by ascending input keycode and axes by ascending ABS
 * code. For a DualSense driven by the in-tree hid-playstation driver that yields
 * the table below — verified on cirrus (DualSense hw 0x617 / fw 0x0110002a) by
 * reading the declared capabilities of /dev/input/js* and cross-checking against
 * real button presses.
 *
 * Note the D-Pad is exposed as two axes (not buttons) and L2/R2 appear both as
 * digital buttons (6/7) and as analog axes (2/5). We deliberately use only the
 * digital buttons for the triggers: the analog axes rest at -32767 and drift,
 * which would otherwise read as permanent full deflection.
 */

/** Full-scale value of a joydev axis. */
const AXIS_MAX = 32767;

/** Button label → joydev button index. */
const BUTTONS = {
    'X': 0,
    'Circle': 1,
    'Triangle': 2,
    'Square': 3,
    'L1': 4,
    'R1': 5,
    'L2': 6,
    'R2': 7,
    'Share': 8,
    'Options': 9,
    'PS': 10,
    'L3': 11,
    'R3': 12
};

/**
 * Axis label → { axis, sign }. `sign` is the direction of travel that triggers
 * the action, so each physical axis yields two independently mappable halves.
 */
const AXES = {
    'Left Stick Left': { axis: 0, sign: -1 },
    'Left Stick Right': { axis: 0, sign: 1 },
    'Left Stick Up': { axis: 1, sign: -1 },
    'Left Stick Down': { axis: 1, sign: 1 },
    'Right Stick Left': { axis: 3, sign: -1 },
    'Right Stick Right': { axis: 3, sign: 1 },
    'Right Stick Up': { axis: 4, sign: -1 },
    'Right Stick Down': { axis: 4, sign: 1 },
    'D-Pad Left': { axis: 6, sign: -1 },
    'D-Pad Right': { axis: 6, sign: 1 },
    'D-Pad Up': { axis: 7, sign: -1 },
    'D-Pad Down': { axis: 7, sign: 1 }
};

/**
 * Resolve a UI button label to an input source descriptor.
 * @param {string} label  e.g. 'X', 'L1', 'D-Pad Left'
 * @returns {{kind: 'button', index: number}|{kind: 'axis', index: number, sign: number}|null}
 */
function resolveSource(label) {
    if (typeof label !== 'string') return null;

    const button = BUTTONS[label];
    if (button !== undefined) return { kind: 'button', index: button };

    const axis = AXES[label];
    if (axis) return { kind: 'axis', index: axis.axis, sign: axis.sign };

    return null;
}

/** @returns {string[]} every label accepted by resolveSource(), for validation. */
function knownLabels() {
    return [...Object.keys(BUTTONS), ...Object.keys(AXES)];
}

module.exports = { AXIS_MAX, BUTTONS, AXES, resolveSource, knownLabels };
