/**
 * src/analyses/colregs.js
 *
 * Right of way between our boat and another vessel under the COLREG /
 * RIPAM steering and sailing rules, from what AIS and our instruments say.
 * The same rules as the ocearo-ui display (app/components/utils/Colregs.js),
 * so the voice and the screen never disagree, plus what only matters for a
 * spoken watch:
 *
 *   - rule 13 overtaking, 18 hierarchy of vessels, 12 two sailing vessels,
 *     14 head-on, 15 crossing;
 *   - rule 16/17: give-way acts early and substantially; stand-on keeps
 *     course and speed (17 a-i), may act when the other does not (17 a-ii),
 *     must act when collision cannot be avoided by her alone (17 b);
 *   - rule 19: in restricted visibility nobody stands on — every vessel
 *     avoids, and a vessel forward of the beam is never avoided by turning
 *     to port.
 *
 * Simplified on purpose: no narrow channels or traffic separation schemes
 * (rules 9-10), and only the statuses AIS reports. An aid, never a decision.
 *
 * Angles in degrees true, speeds in knots, positions as {x, y} metres east
 * and north of our boat.
 */

// Rule 18: a vessel keeps out of the way of any vessel ranked above it
const CATEGORY_RANK = { power: 1, sail: 2, fishing: 3, restricted: 4 };

const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

/**
 * Category of an AIS target from its navigation status (most reliable),
 * then its ship type. Pleasure craft (37) report no propulsion: power unless
 * the status says sailing.
 * @param {{ navState?: string, shipType?: number|string }} target
 * @returns {'power'|'sail'|'fishing'|'restricted'}
 */
const targetCategory = (target) => {
    const state = String(target.navState || '').toLowerCase();
    if (/not under command|restricted|constrained|aground/.test(state)) return 'restricted';
    if (/fishing/.test(state)) return 'fishing';
    if (/sailing/.test(state)) return 'sail';
    if (/motoring|engine|under way using/.test(state)) return 'power';
    const type = Number(target.shipType);
    if (type === 36) return 'sail';
    if (type === 30) return 'fishing';
    if (type === 33) return 'restricted'; // dredging / underwater operations
    return 'power';
};

/**
 * Our own category: under power as soon as the engine turns, even with sails
 * up (a motor-sailing yacht is a power-driven vessel), sailing otherwise for a
 * sailboat.
 * @param {{ navState?: string, engineRunning?: boolean, sailboat?: boolean }} own
 */
const ownCategory = ({ navState, engineRunning, sailboat = true }) => {
    const state = String(navState || '').toLowerCase();
    if (/motoring/.test(state) || engineRunning) return 'power';
    if (/sailing/.test(state)) return 'sail';
    return sailboat ? 'sail' : 'power';
};

/** Relative bearing (-180..180) of `to` from a vessel at `from` steering `course` */
const relativeBearing = (from, to, course) =>
    wrap180(Math.atan2(to.x - from.x, to.y - from.y) * 180 / Math.PI - course);

/**
 * Who gives way between us and one target.
 *
 * @param {{ course: number, speed: number, category: string }} own
 * @param {{ x: number, y: number, course: number, speed: number, category: string }} target
 * @param {number|null} twd   true wind direction (from), degrees, for sailing vessels
 * @returns {{ ownRole: 'give-way'|'stand-on'|'both', rule: string, reason: string, situation: string }}
 */
const rightOfWay = (own, target, twd) => {
    const origin = { x: 0, y: 0 };
    const targetFromOwn = relativeBearing(origin, target, own.course);
    const ownFromTarget = relativeBearing(target, origin, target.course);

    // Rule 13: overtaking — coming up from more than 22.5° abaft the beam
    const abaft = (b) => Math.abs(b) > 112.5;
    if (abaft(targetFromOwn) && target.speed > own.speed) {
        return { ownRole: 'stand-on', rule: '13', reason: 'overtaken_by_target', situation: 'being_overtaken' };
    }
    if (abaft(ownFromTarget) && own.speed > target.speed) {
        return { ownRole: 'give-way', rule: '13', reason: 'overtaking', situation: 'overtaking' };
    }

    // Rule 18: different categories
    const ownRank = CATEGORY_RANK[own.category] ?? 1;
    const targetRank = CATEGORY_RANK[target.category] ?? 1;
    if (ownRank !== targetRank) {
        return ownRank < targetRank
            ? { ownRole: 'give-way', rule: '18', reason: `give_way_to_${target.category}`, situation: 'crossing' }
            : { ownRole: 'stand-on', rule: '18', reason: `stand_on_from_${target.category}`, situation: 'crossing' };
    }

    // Rule 12: two sailing vessels
    if (own.category === 'sail' && Number.isFinite(twd)) {
        // Wind on the port side = port tack
        const ownTack = wrap180(twd - own.course) >= 0 ? 'starboard' : 'port';
        const targetTack = wrap180(twd - target.course) >= 0 ? 'starboard' : 'port';
        if (ownTack !== targetTack) {
            return ownTack === 'port'
                ? { ownRole: 'give-way', rule: '12a-i', reason: 'port_tack', situation: 'crossing' }
                : { ownRole: 'stand-on', rule: '12a-i', reason: 'target_port_tack', situation: 'crossing' };
        }
        // Same tack: the windward boat keeps clear
        const w = twd * Math.PI / 180;
        const upwind = target.x * Math.sin(w) + target.y * Math.cos(w); // > 0: target upwind of us
        return upwind > 0
            ? { ownRole: 'stand-on', rule: '12a-ii', reason: 'target_windward', situation: 'crossing' }
            : { ownRole: 'give-way', rule: '12a-ii', reason: 'own_windward', situation: 'crossing' };
    }

    // Rule 14: head-on — reciprocal courses, each sees the other ahead
    const reciprocal = Math.abs(wrap180(target.course - own.course - 180)) < 10;
    if (reciprocal && Math.abs(targetFromOwn) < 6) {
        return { ownRole: 'both', rule: '14', reason: 'head_on', situation: 'head_on' };
    }

    // Rule 15: crossing — the vessel with the other on her starboard side gives way
    return targetFromOwn > 0
        ? { ownRole: 'give-way', rule: '15', reason: 'crossing_starboard', situation: 'crossing' }
        : { ownRole: 'stand-on', rule: '15', reason: 'crossing_port', situation: 'crossing' };
};

/**
 * What to do about one target: the rule, our role and the action to say.
 *
 * @param {object} p
 * @param {object} p.own       { course, speed, category }
 * @param {object} p.target    { x, y, course, speed, category }
 * @param {number|null} p.twd  true wind direction (from), degrees
 * @param {number} p.cpaNm     closest point of approach, NM
 * @param {number} p.tcpaMin   time to it, minutes
 * @param {number|null} p.visibilityNm  outside visibility, NM (rule 19 below 2 NM)
 * @param {number} [p.dangerCpaNm=0.25]
 * @returns {{ ownRole: string, rule: string, reason: string, situation: string, action: string }}
 *   action: give_way_starboard | give_way_astern | give_way_slow | stand_on |
 *           stand_on_ready | stand_on_act | head_on_starboard | restricted_visibility
 */
const advise = ({ own, target, twd, cpaNm, tcpaMin, visibilityNm = null, dangerCpaNm = 0.25 }) => {
    // Rule 19: in restricted visibility there is no stand-on vessel
    if (Number.isFinite(visibilityNm) && visibilityNm < 2) {
        const ahead = Math.abs(relativeBearing({ x: 0, y: 0 }, target, own.course)) < 90;
        return {
            ownRole: 'give-way', rule: '19', reason: 'restricted_visibility', situation: 'restricted_visibility',
            action: ahead ? 'restricted_visibility' : 'give_way_slow',
        };
    }

    const r = rightOfWay(own, target, twd);
    let action;
    if (r.ownRole === 'both') {
        action = 'head_on_starboard';
    } else if (r.ownRole === 'give-way') {
        // Rule 16 / 8: early and substantial. Crossing ahead of a vessel is to
        // be avoided (rule 15): pass astern of her — turn towards her stern.
        const bearing = relativeBearing({ x: 0, y: 0 }, target, own.course);
        if (r.rule === '13') action = 'give_way_starboard';
        else if (Math.abs(bearing) < 60) action = bearing > 0 ? 'give_way_starboard' : 'give_way_astern';
        else action = 'give_way_slow';
    } else {
        // Rule 17: hold on, then act when the other does not, then act anyway
        if (cpaNm < dangerCpaNm / 2 && tcpaMin < 4) action = 'stand_on_act';
        else if (cpaNm < dangerCpaNm && tcpaMin < 8) action = 'stand_on_ready';
        else action = 'stand_on';
        if (action === 'stand_on_act') r.rule = '17b';
        else if (action === 'stand_on_ready') r.rule = `${r.rule}, 17a-ii`;
    }
    return { ...r, action };
};

module.exports = { CATEGORY_RANK, targetCategory, ownCategory, rightOfWay, advise, relativeBearing, wrap180 };
