/**
 * ConfigManager — Central configuration and i18n system.
 *
 * Loads:
 * - Boat config  (config/boats/{boatId}.json)   → polars, sails, keel, dimensions, limits
 * - Locale files (config/locales/{lang}.json)    → all human-readable strings
 * - Actions      (config/actions.json)           → trim guides, reef rules, safety triggers
 *
 * Provides:
 * - t(key, params)        → translated string with variable interpolation
 * - boat()                → boat configuration object
 * - actions()             → actions configuration object
 * - polar(tws, twa)       → interpolated boat speed from polar table
 * - getWindStrength(kts)  → wind strength category
 * - getPointOfSail(twa)   → point of sail name
 * - getTrim(pointOfSail)  → trim guide for given point of sail
 * - getSailSelection(ws)  → headsail/main selection for wind strength
 */

const path = require('path');
const fs = require('fs');

const CONFIG_DIR = path.resolve(__dirname, '../../config');

class ConfigManager {
    /**
     * @param {object} app    SignalK app object (for debug logging)
     * @param {object} opts   { language: 'fr', boat: 'dufour310gl', personality: 'jarvis' }
     */
    constructor(app, opts = {}) {
        this.app = app;
        this.language = opts.language || 'fr';
        this.boatId = opts.boat || 'dufour310gl';
        this.personality = opts.personality || 'jarvis';

        this._locales = {};
        this._boat = {};
        this._actions = {};

        this._load();
    }

    /**
     * Load all JSON config files.
     */
    _load() {
        this._locales = this._loadJson(`locales/${this.language}.json`, {});
        this._boat = this._loadJson(`boats/${this.boatId}.json`, {});
        this._actions = this._loadJson('actions.json', {});

        // Also preload fallback locale (en) if current is not en
        if (this.language !== 'en') {
            this._fallbackLocale = this._loadJson('locales/en.json', {});
        } else {
            this._fallbackLocale = this._locales;
        }

        this._debug(`ConfigManager loaded: boat=${this.boatId}, lang=${this.language}, personality=${this.personality}`);
    }

    /**
     * Load a JSON file from the config directory.
     * @param {string} relativePath  Path relative to config/
     * @param {*} fallback           Fallback value if file not found
     * @returns {object}
     */
    _loadJson(relativePath, fallback) {
        const fullPath = path.join(CONFIG_DIR, relativePath);
        try {
            const raw = fs.readFileSync(fullPath, 'utf8');
            return JSON.parse(raw);
        } catch (error) {
            this._debug(`Config file not found or invalid: ${relativePath} — ${error.message}`);
            return fallback;
        }
    }

    // ─────────── I18N ───────────

    /**
     * Translate a dotted key with optional variable interpolation.
     *
     * @param {string} key     Dotted key, e.g. 'weather.beaufort.5' or 'sail.advice.reef_needed'
     * @param {object} params  Variables to interpolate, e.g. { speed: 25 }
     * @returns {string}       Translated string, or key itself if not found
     *
     * @example
     *   t('weather.alerts.high_wind', { speed: 30 })
     *   // → "Alerte : vent fort à 30 nœuds"
     */
    t(key, params) {
        let value = this._resolve(this._locales, key);
        if (value === undefined || value === null) {
            value = this._resolve(this._fallbackLocale, key);
        }
        if (value === undefined || value === null) {
            return key;
        }
        if (typeof value !== 'string') {
            return String(value);
        }
        if (params) {
            return this._interpolate(value, params);
        }
        return value;
    }

    /**
     * Resolve a dotted path in a nested object.
     * @param {object} obj  Root object
     * @param {string} path Dotted path
     * @returns {*}
     */
    _resolve(obj, dotPath) {
        if (!obj || !dotPath) return undefined;
        const parts = dotPath.split('.');
        let current = obj;
        for (const part of parts) {
            if (current === undefined || current === null) return undefined;
            current = current[part];
        }
        return current;
    }

    /**
     * Interpolate {variable} placeholders in a string.
     * @param {string} template
     * @param {object} params
     * @returns {string}
     */
    _interpolate(template, params) {
        return template.replace(/\{(\w+)\}/g, (match, key) => {
            return params[key] !== undefined ? String(params[key]) : match;
        });
    }

    // ─────────── BOAT CONFIG ───────────

    /**
     * Get the full boat configuration object.
     * @returns {object}
     */
    boat() {
        return this._boat;
    }

    /**
     * Get a specific boat config value by dotted path.
     * @param {string} key  e.g. 'keel.draftDown' or 'limits.reef1Trigger'
     * @param {*} fallback
     * @returns {*}
     */
    boatValue(key, fallback) {
        const value = this._resolve(this._boat, key);
        return value !== undefined ? value : fallback;
    }

    // ─────────── ACTIONS CONFIG ───────────

    /**
     * Get the full actions configuration.
     * @returns {object}
     */
    actions() {
        return this._actions;
    }

    /**
     * Get trim guide for a given point of sail.
     * @param {string} pointOfSail e.g. 'close_hauled'
     * @returns {object} Trim settings object
     */
    getTrim(pointOfSail) {
        return this._actions.trim?.[pointOfSail] || this._actions.trim?.beam_reach || {};
    }

    /**
     * Get headsail selection for a given wind strength.
     * @param {string} windStrength e.g. 'fresh'
     * @returns {object|null}
     */
    getSailSelection(windStrength) {
        const rules = this._actions.headsailSelection?.rules || [];
        return rules.find(r => r.windStrength === windStrength) || null;
    }

    /**
     * Get all applicable reef rules for current conditions.
     * @param {object} conditions { trueWindSpeed, gustFactor, windStrength, twa }
     * @returns {Array}
     */
    getApplicableReefRules(conditions) {
        const rules = this._actions.reefing?.rules || [];
        const boatLimits = this._boat.limits || {};
        const applicable = [];

        for (const rule of rules) {
            if (rule.id === 'reef1_wind' && conditions.trueWindSpeed >= (boatLimits.reef1Trigger || 18)) {
                applicable.push(rule);
            } else if (rule.id === 'reef2_wind' && conditions.trueWindSpeed >= (boatLimits.reef2Trigger || 25)) {
                applicable.push(rule);
            } else if (rule.id === 'storm_sails' && conditions.trueWindSpeed >= (boatLimits.stormSailsTrigger || 35)) {
                applicable.push(rule);
            } else if (rule.id === 'reef1_gust' && conditions.gustFactor > 1.3 &&
                       conditions.windStrength === 'moderate' && conditions.twa < 60) {
                applicable.push(rule);
            }
        }
        return applicable;
    }

    /**
     * Get keel management rules applicable to current conditions.
     * @param {object} conditions { depth, keelDown, beaufort, mode }
     * @returns {Array}
     */
    getKeelActions(conditions) {
        const rules = this._actions.keelManagement?.rules || [];
        const keel = this._boat.keel || {};
        const applicable = [];

        for (const rule of rules) {
            if (rule.id === 'raise_shallow' &&
                conditions.depth < (keel.raiseThresholdDepth || 2.5) && conditions.keelDown) {
                applicable.push(rule);
            } else if (rule.id === 'lower_offshore' &&
                       conditions.depth > (keel.lowerThresholdDepth || 4.0) &&
                       !conditions.keelDown && conditions.mode === 'sailing') {
                applicable.push(rule);
            } else if (rule.id === 'lower_heavy_weather' &&
                       conditions.beaufort >= 6 && !conditions.keelDown) {
                applicable.push(rule);
            } else if (rule.id === 'raise_anchoring_shallow' &&
                       conditions.mode === 'anchored' && conditions.depth < 3.0) {
                applicable.push(rule);
            }
        }
        return applicable;
    }

    // ─────────── POLARS ───────────

    /**
     * Interpolate boat speed from the boat's polar table.
     * @param {number} tws True wind speed in knots
     * @param {number} twa True wind angle in degrees
     * @returns {number} Expected boat speed in knots
     */
    polar(tws, twa) {
        const polars = this._boat.polars;
        if (!polars || !polars.tws || !polars.twa || !polars.speeds) {
            return tws * 0.5;
        }

        const twsArr = polars.tws;
        const twaArr = polars.twa;
        const speeds = polars.speeds;

        // Clamp TWA to 0-180
        twa = Math.max(0, Math.min(180, Math.abs(twa)));

        // Find TWS bracket
        let twsLow = 0;
        let twsHigh = twsArr.length - 1;
        for (let i = 0; i < twsArr.length - 1; i++) {
            if (tws >= twsArr[i] && tws <= twsArr[i + 1]) {
                twsLow = i;
                twsHigh = i + 1;
                break;
            }
        }
        if (tws <= twsArr[0]) { twsLow = 0; twsHigh = 0; }
        if (tws >= twsArr[twsArr.length - 1]) { twsLow = twsArr.length - 1; twsHigh = twsArr.length - 1; }

        // Find TWA bracket
        let twaLow = 0;
        let twaHigh = twaArr.length - 1;
        for (let i = 0; i < twaArr.length - 1; i++) {
            if (twa >= twaArr[i] && twa <= twaArr[i + 1]) {
                twaLow = i;
                twaHigh = i + 1;
                break;
            }
        }
        if (twa <= twaArr[0]) { twaLow = 0; twaHigh = 0; }
        if (twa >= twaArr[twaArr.length - 1]) { twaLow = twaArr.length - 1; twaHigh = twaArr.length - 1; }

        // Bilinear interpolation
        const twsFrac = twsHigh === twsLow ? 0 :
            (tws - twsArr[twsLow]) / (twsArr[twsHigh] - twsArr[twsLow]);
        const twaFrac = twaHigh === twaLow ? 0 :
            (twa - twaArr[twaLow]) / (twaArr[twaHigh] - twaArr[twaLow]);

        const s00 = speeds[twsLow]?.[twaLow] || 0;
        const s01 = speeds[twsLow]?.[twaHigh] || 0;
        const s10 = speeds[twsHigh]?.[twaLow] || 0;
        const s11 = speeds[twsHigh]?.[twaHigh] || 0;

        const sLow = s00 + (s01 - s00) * twaFrac;
        const sHigh = s10 + (s11 - s10) * twaFrac;
        return Math.round((sLow + (sHigh - sLow) * twsFrac) * 10) / 10;
    }

    // ─────────── WIND / POINT OF SAIL CLASSIFICATION ───────────

    /**
     * Classify wind strength from knots using actions config thresholds.
     * @param {number} windSpeed Wind speed in knots
     * @returns {string}
     */
    getWindStrength(windSpeed) {
        const thresholds = this._actions.windStrengthThresholds || {};
        for (const [category, range] of Object.entries(thresholds)) {
            if (windSpeed >= range.min && windSpeed < range.max) {
                return category;
            }
        }
        return 'moderate';
    }

    /**
     * Get point of sail from TWA using actions config ranges.
     * @param {number} twa True wind angle in degrees (0-180)
     * @returns {string}
     */
    getPointOfSail(twa) {
        const ranges = this._actions.pointOfSailRanges || {};
        for (const [name, range] of Object.entries(ranges)) {
            if (twa >= range.min && twa < range.max) {
                return name;
            }
        }
        if (twa >= 170) return 'dead_run';
        return 'beam_reach';
    }

    /**
     * Get optimal TWA for upwind/downwind from boat config.
     * @param {string} windRange  e.g. 'light', 'moderate', 'fresh', 'heavy'
     * @returns {object} { upwind, downwind }
     */
    getOptimalTWA(windRange) {
        const optTWA = this._boat.optimalTWA || {};
        return optTWA[windRange] || optTWA.moderate || { upwind: 44, downwind: 150 };
    }

    /**
     * Map wind speed to wind range key (for polars and optimal TWA).
     * @param {number} windSpeed
     * @returns {string}
     */
    getWindRange(windSpeed) {
        if (windSpeed < 10) return 'light';
        if (windSpeed < 20) return 'moderate';
        if (windSpeed < 30) return 'fresh';
        return 'heavy';
    }

    // ─────────── HELPERS ───────────

    /**
     * Get startup message based on personality.
     * @returns {string}
     */
    getStartupMessage() {
        return this.t(`startup.${this.personality}`) || this.t('startup.default');
    }

    /**
     * Get shutdown message based on personality.
     * @returns {string}
     */
    getShutdownMessage() {
        return this.t(`shutdown.${this.personality}`) || this.t('shutdown.default');
    }

    /**
     * Get translated trim description for a given trim key/value pair.
     * @param {string} control  e.g. 'mainsheet'
     * @param {string} value    e.g. 'tight'
     * @returns {string}        e.g. 'Écoute de GV : Bordé'
     */
    describeTrim(control, value) {
        const label = this.t(`sail.trim_labels.${control}`) || control;
        const desc = this.t(`sail.trim_values.${value}`) || value;
        return `${label} : ${desc}`;
    }

    /**
     * Reload configuration (e.g. after language or boat change).
     * @param {object} opts  { language, boat, personality }
     */
    reload(opts = {}) {
        if (opts.language) this.language = opts.language;
        if (opts.boat) this.boatId = opts.boat;
        if (opts.personality) this.personality = opts.personality;
        this._load();
    }

    _debug(msg) {
        if (this.app && this.app.debug) {
            this.app.debug(msg);
        }
    }
}

module.exports = ConfigManager;
