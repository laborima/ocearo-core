# Changelog

All notable changes to Ocearo Core will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — v1.1.0

### Added

#### ⚓ Anchor Management (Signal K Anchor API)
- `src/anchor/anchor-state.js` — state machine (`raised → dropping → dropped → raising → raised`) with JSON persistence across restarts
- `src/anchor/anchor-alarm.js` — haversine drift detection, subscribes to `navigation.position`, emits:
  - `notifications.navigation.anchor.drag` (`emergency`) when vessel exceeds alarm radius
  - `notifications.navigation.anchor.watch` (`warn`) at configurable threshold (default 80% of radius)
  - `notifications.navigation.anchor.modeChange` (`warn`) if mode changes while anchor is deployed
  - Publishes `navigation.anchor.position`, `navigation.anchor.currentRadius`, `navigation.anchor.maxRadius`, `navigation.anchor.rodeLength`
- `src/anchor/anchor-plugin.js` — REST endpoints implementing the proposed Signal K Anchor API:
  - `POST /navigation/anchor/drop` — records position, starts alarm monitoring, sets mode to `anchored`
  - `POST /navigation/anchor/raise` — stops monitoring, clears SK paths, sets mode to `sailing`
  - `POST /navigation/anchor/radius` — `{ value: metres }` updates alarm radius live
  - `POST /navigation/anchor/reposition` — `{ rodeLength, anchorDepth }` with catenary calculation
  - `GET  /navigation/anchor/status` — lightweight state snapshot
  - `GET  /navigation/anchor` — full state snapshot
- `schema.json` — new `anchor` section: `defaultRadius`, `watchRadiusPercent`, `positionUpdateInterval`

#### 📔 Logbook — Dual Backend with Local Fallback
- `src/logbook/logbook-store.js` — local JSON file store in `<dataDir>/ocearo-logbook/`:
  - Implements Signal K Resource Provider interface (`listResources`, `getResource`, `setResource`, `deleteResource`)
  - Separate `fuel-log.json` for fuel refill records
- `src/logbook/index.js` refactored:
  - Auto-detects `@meri-imperiumi/signalk-logbook` at startup; falls back to local store if absent
  - Registers as SK Resource Provider for `logbooks` resource type when using local backend
  - `logAnalysis()` routes to local store or signalk-logbook based on active backend
  - `getAnalysisEntries()` routes to local store or signalk-logbook based on active backend
  - `addFuelLogEntry()` / `getFuelLogEntries()` always use local store (fuel log is backend-independent)
  - Vessel context cache (5 s TTL) to avoid repeated `getSelfPath` calls per `logAnalysis` invocation
  - `backend` property exposed (`'signalk-logbook'` | `'local'`)

#### 🔒 Security & Robustness
- Built-in per-IP rate limiter (no external dependency) in `plugin/index.js`:
  - General routes: 120 req/min
  - AI operations (`/analyze`, `/logbook/entry`, `/logbook/analyze`, `/llm/test`): 10/min
  - TTS (`/speak`): 20/min
- `sanitiseString()` helper — strips control characters, enforces max length on all text inputs
- `requireJson` middleware — validates POST body is a JSON object
- 404 catch-all returns structured JSON instead of HTML
- HTTP 503 returned (instead of 500) when AI service is unavailable

#### 🛠 New API Endpoints
- `GET  /logbook/fuel` — retrieve fuel log entries
- `POST /logbook/fuel` — add fuel refill record `{ liters, cost, additive, engineHours, ... }`
- `GET  /logbook/backend` — returns active backend and connection status
- `GET  /logbook/entry` — retrieve recent AI logbook entries (`?limit=50`)
- `POST /logbook/entry` — now uses LLM (when available) to generate a real nautical entry from `currentData`

#### 🧠 Brain Integration
- `OrchestratorBrain` instantiates and owns `AnchorPlugin`
- `updateMode()` is now synchronous and delegates anchor lifecycle to `AnchorPlugin.handleModeChange()`
- `getSystemStatus()` includes `anchor.state`, `anchor.currentRadius`, `anchor.dragging`, `logbookBackend`
- `AnchorPlugin.start()` / `stop()` called in brain lifecycle

#### 📱 Ocearo-UI (`OcearoCoreUtils.js`)
- 5 new anchor API functions: `anchorDrop`, `anchorRaise`, `anchorSetRadius`, `anchorReposition`, `getAnchorStatus`
- `addFuelLogEntry` — tries `/logbook/fuel` first, falls back to `/logbook/add-entry`
- `fetchFuelLogEntries` — tries `/logbook/fuel` first, falls back to filtering general entries
- `requestAnalysis` — added `'ais'` to valid analysis types (was missing)
- Error handler updated: removed misleading "install signalk-logbook" message

### Fixed
- `logAnalysis()` was always calling `testSignalkConnection()` even when backend was `'local'`
- `getAnalysisEntries()` was throwing instead of returning `[]` when SK server unavailable
- `/logbook/entry` POST was returning a hardcoded stub instead of calling the LLM
- `/logbook/analyze` was ignoring `entries` passed in the request body
- `updateMode()` was `async` but awaited SK path writes that could fail silently
- `requestAnalysis('ais')` was missing from UI valid types, causing client-side rejection

### Changed
- `plugin/index.js` — `registerWithRouter` now applies rate limiting and JSON validation globally before any route handler
- Error responses for AI-unavailable scenarios now use HTTP 503 consistently
- `speak` endpoint sanitises text before passing to TTS engine

## [1.0.0] - 2024-XX-XX

### Added
- **Core Features**
  - Intelligent navigation assistant with LLM integration (Ollama)
  - Text-to-Speech output via Piper and eSpeak backends
  - Automatic startup briefing with weather and tide information
  - 30-minute navigation point updates
  - Hourly automatic logbook entries

- **Analysis Modules**
  - Weather analysis with Open-Meteo marine API integration
  - Tide data provider with NOAA and local JSON file support
  - Alert analysis with contextual explanations
  - Sail course optimization with VMG calculations
  - Sail settings recommendations based on conditions

- **Memory & Logging**
  - 24-hour contextual memory for coherent AI responses
  - Integration with signalk-logbook plugin
  - Persistent storage of vessel context, alerts, and navigation history

- **Voice Output**
  - Piper TTS backend with French and English voice support
  - eSpeak fallback backend
  - Console output fallback for testing
  - Speech queue management to prevent overlapping audio

- **Internationalization**
  - English language support
  - French language support
  - Extensible translation system

- **Personalities & Modes**
  - Multiple AI personas (Captain, Teammate, Jarvis, French Sailor)
  - Humor/Serious mode toggle
  - Predictions on/off mode
  - Auto-briefing configuration

- **API Endpoints**
  - Health check endpoint for monitoring
  - Status endpoint for system information
  - Manual analysis trigger endpoint
  - TTS test endpoint
  - Memory and logbook access endpoints

- **Signal K Integration**
  - Full Signal K plugin lifecycle support
  - Subscription to navigation, environment, and notification paths
  - Publication of analysis results and recommendations
  - Notification handling compliant with Signal K specification

### Technical
- Node.js 18+ requirement
- Modular architecture for extensibility
- Comprehensive error handling with graceful degradation
- Request timeout handling for external APIs
- Connection state caching for LLM service

## [0.9.0] - Development

### Added
- Initial development version
- Basic plugin structure
- Core module implementations

---

## Version History

| Version | Date | Description |
|---------|------|-------------|
| 1.0.0 | TBD | Initial public release |
| 0.9.0 | 2024 | Development version |

## Upgrade Guide

### Upgrading to 1.0.0

This is the initial release. No upgrade steps required.

For future upgrades, check this section for any breaking changes or migration steps.
