const { test } = require('node:test');
const assert = require('node:assert');
const MeteoAnalyzer = require('../src/analyses/meteo');
const WeatherProvider = require('../src/dataprovider/marineweather');

const cm = { t: (key) => key };
const appWith = (self = {}) => ({
    debug: () => {}, error: () => {},
    getSelfPath: (p) => p.split('.').reduce((o, k) => o?.[k], self),
});
const meteo = (self) => new MeteoAnalyzer(appWith(self), {}, null, null, null, cm);
const KN = 1 / 1.94384;

test('gusts from the weather provider (windGust) count in the gust factor', () => {
    const a = meteo().assessConditions({ current: { windSpeed: 15, windGust: 27, windDirection: 270 } }, null, {});
    assert.ok(a.gustFactor > 1.7);
    assert.strictEqual(a.gustRisk, 'high');
});

test('sea state follows the WMO / Douglas scale', () => {
    const m = meteo();
    assert.strictEqual(m.assessSeaState(0.3), 'smooth');
    assert.strictEqual(m.assessSeaState(1.0), 'slight');
    assert.strictEqual(m.assessSeaState(1.5), 'moderate');
    assert.strictEqual(m.assessSeaState(3), 'rough');
    assert.strictEqual(m.assessSeaState(7), 'high');
});

test('wind against tide only when they really oppose each other', () => {
    // Wind from the west (blowing east), 20 kn
    const weather = { current: { windSpeed: 20, windDirection: 270 } };
    const ebbWest = { environment: { current: { value: { setTrue: 270 * Math.PI / 180, drift: 2 * KN } } } };
    const floodEast = { environment: { current: { value: { setTrue: 90 * Math.PI / 180, drift: 2 * KN } } } };
    assert.strictEqual(meteo(ebbWest).assessConditions(weather, null, {}).windAgainstTide.danger, true);
    assert.strictEqual(meteo(floodEast).assessConditions(weather, null, {}).windAgainstTide.danger, false);
    // No current published: no claim either way
    assert.strictEqual(meteo().assessConditions(weather, null, {}).windAgainstTide, null);
});

test('no point of sail without a wind direction', () => {
    const a = meteo().assessConditions({ current: { windSpeed: 12 } }, null, { heading: 90, speed: 5 });
    assert.strictEqual(a.sailing.pointOfSail, 'unknown');
});

test('forecast: chronological from the current hour; longitude 0 is a position', async () => {
    const provider = new WeatherProvider(appWith(), {});
    const now = Date.now();
    const hour = (h) => new Date(now + h * 3600e3).toISOString();
    const raw = { b: { date: hour(1), wind: { speedTrue: 6 } }, a: { date: hour(-3), wind: { speedTrue: 1 } }, c: { date: hour(0), wind: { speedTrue: 5 } } };
    const parsed = provider._parseForecastResponse(raw);
    assert.deepStrictEqual(parsed.map(e => Math.round(e.windSpeed)), [10, 12]);

    let called = null;
    const realFetch = global.fetch;
    global.fetch = async (url) => { called = url; return { ok: true, status: 200, json: async () => raw, headers: { get: () => null } }; };
    try {
        provider._serverUrl = 'http://127.0.0.1:3000';
        const data = await provider._fetchForecast({ latitude: 49.5, longitude: 0 });
        assert.ok(called && called.includes('lon=0'));
        assert.strictEqual(data.length, 2);
    } finally {
        global.fetch = realFetch;
    }
});
