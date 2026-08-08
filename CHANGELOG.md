# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Fixed
- **`getSelfPath()` returned the Signal K node, not its value** (closes #1). Every consumer expected a plain number or object, and a node object passes a `!== null && !== undefined` guard, so `node * 1.94384` yielded `NaN`. One defect produced five symptoms: hourly logbook entries entirely `NaN`, all-`undefined` flattened data for the analysers, own SOG/COG permanently `null` (so collision logic always reasoned as if stopped), notifications never read, and `JSON.stringify` failures when persisting memory. `_getSelfPath()` now unwraps the leaf node; branch paths without a `value` key are returned untouched.
- **The vessel reported itself as an AIS target.** `app.getPath('vessels')` includes our own vessel and nothing filtered it out, so with no AIS receiver at all the analyser still returned exactly one target — us — at range 0, CPA 0, TCPA 0. Sorted by ascending CPA it came first, was handed to the LLM as "the nearest target, CPA 0 NM in 0 minutes", and was announced at every startup as an imminent collision. Own vessel is now excluded, the briefing only names a target whose CPA/TCPA are actually computable, and traffic is no longer mentioned on `totalInRange` alone.
- **Depth never reached the logbook client.** `_toClientEntry()` hoisted every classic column from `vesselContext` except `depth`, so a value collected and stored on every entry was dropped on the way out of the API. Also falls back to `analysis.metrics.depth` so existing hourly entries surface too.
- **Failure warnings repeated every 60 seconds** for as long as the condition held — a battery sitting just under threshold at the dock re-announced itself every minute. Now debounced on the message, like sail advice already was.

### Changed
- **Alerts are prioritised by navigation state.** Alongside or at anchor, only safety-category alerts are spoken; alarms and warnings still always pass. In `smart` mode every `navigation`-category notification used to be announced, which meant each depth and tide notification in a harbour or a buoyed approach channel. Requires `navigation.state`, published by the autostate plugin; when it is absent the vessel is assumed under way so nothing is ever silenced by a missing plugin.


### Added
- **Do-Not-Disturb Mode**: `/dnd` API with three levels (off / safety-only / all) filtering voice announcements and pausing scheduled analyses; used by the UI bottom-bar toggle and the cinema-mode watcher.
- **Racing Tactical Analysis**: dedicated racing module with tactical recommendations.
- **Holistic Copilot Briefing**: unified situation briefing, parameter-aware weather/sail prompts, natural tone, vessel data normalization and VMG-to-target fix.
- **Voice/TTS Improvements**: units spelled out (nautical miles, knots, degrees), persistent Kokoro daemon, Piper sample-rate fix.
- **Route Planning Analysis**: Intelligent route planning and navigation assistance considering weather forecasts, vessel polar performance, and destination.
- **Failure Prediction Analysis**: Proactive monitoring of vessel systems (engine, electrical) to predict potential failures before they occur, with LLM-powered anomaly detection.
- **Full Stack Installation Guide**: Updated README with comprehensive instructions for building and deploying the Ocearo ecosystem using Docker.

### Fixed
- Serialized dual LLM generations to avoid parallel timeouts on CPU-capped Ollama.
- RPi5 resilience: atomic file writes, weather/tide caching with retry and 429 backoff.
- Memory module was excluded from the package by an over-broad gitignore rule.

### Changed
- **LLM Prompts**: Updated system prompts in English and French to reflect the AI's role as a true Copilot with global surveillance and failure prediction capabilities.
- **Package Description**: Updated `package.json` description to highlight new Copilot capabilities.
