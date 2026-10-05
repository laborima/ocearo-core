# Changelog

All notable changes to this project will be documented in this file.

## [1.2.1] - 2026-10-05

Fixes reported on GitHub. The memory files move to the plugin's data directory by themselves on the first start.

### Fixed

- **Reasoning models returned empty answers** (qwen3, gpt-oss; [#2](https://github.com/laborima/ocearo-core/issues/2)): the 80 and 250-token budgets ran out while the model was still thinking. They are now 600 and 1500 by default, set in *AI → Token limit*, and an answer cut off before it starts is reported in the log instead of failing silently.
- **Every "normal" Signal K notification cost an AI call, and real alarms were never spoken** ([#3](https://github.com/laborima/ocearo-core/issues/3)): notifications were read in the wrong shape, so every one came out as "normal" with the message "Alert". The real state and message are read, and only alert, warn, alarm and emergency go on to the AI, the memory and the voice, an alarm being recorded once; a boat at its mooring with an engine bus no longer sends ~150 requests an hour.
- **Weather logbook entries were the short spoken text** ([#4](https://github.com/laborima/ocearo-core/issues/4)): with an empty written answer (see #2) the entry fell back to the voice version. The weather result carries its written text, used first.
- **"Error persisting data" every twenty minutes, and the memory written to the home directory** ([#5](https://github.com/laborima/ocearo-core/issues/5)): two timers saved at once through the same temporary file. One save runs at a time with its own temporary file, and the memory moves to the plugin's data directory (`plugin-config-data/ocearo-core/memory`); files from the old location are moved on start.

## [1.2.0] - 2026-10-05

### Added

- **COLREG / RIPAM rules in the collision watch.** Encounters were classified from the relative bearing alone. The watch now works out who gives way with the same rules as the ocearo-ui display — 13 overtaking, 18 vessel hierarchy (sailing, fishing, restricted from the AIS status or ship type; a motor-sailing yacht is power-driven), 12 two sailing vessels (tacks from the true wind, windward boat), 14 head-on, 15 crossing — plus 17 (hold on, be ready, act when collision cannot be avoided by the give-way vessel alone) and 19 (no stand-on vessel in restricted visibility). Spoken alerts name our role, the rule and the action, and are repeated as soon as the action becomes more urgent. The LLM is given the established rules instead of being asked to work them out.
- **Briefing without an LLM**: the situation report speaks the facts (wind, sea, barometer, tide, traffic and our role towards the closest vessel) when no model is available.

- **SHOM bathymetry, offline.** When the server is online, the SHOM digital elevation models (MNT topo-bathymétriques, 5 – 20 m on the French coast, 100 m façades; open data, Licence Ouverte) within `bathymetry.radiusNm` of the boat are downloaded from data.shom.fr, converted once to a compact grid in `<dataDir>/bathymetry/` and served as Terrarium elevation tiles referenced to chart datum (`GET /bathymetry/tiles/:z/:x/:y.png`, transparent where no survey covers). ocearo-ui 2 draws them as the seabed of its bathymetry mode. Archives can also be dropped by hand in the import folder. Extraction uses the `7z` command (`apt install p7zip-full`); no new npm dependency. Status, download, import and removal endpoints under `/bathymetry/`.

### Fixed

- **No battery or engine failure was ever detected**: the branches were read as Signal K nodes and compared as objects. Failure advice is now spoken in volts, °C, bar and hours — it used to be the raw locale key.
- **Weather**: gusts were never counted (wrong field name), wind against tide ignored the directions of wind and stream, the sea state was one Douglas step too low, a missing wind direction became a northerly, a position at longitude 0 had no forecast, and the pressure alert gave a 3-hour change as hPa/h.
- **Sail and course analyses** received no heel and an invented wind direction when it was unknown; **racing** read the next waypoint as a node and spoke 'NaN°'.
- **A briefing or an AIS request silenced the collision watch** about the targets it mentioned for five minutes; the briefing reused the first weather analysis of the session (Force 0) forever.
- AIS logbook entries shared one cooldown for all targets; 'Navire inconnu' and the racing manoeuvre words were hard-coded in French; racing and route messages were missing from the locales.
- **A critical "low oil pressure" risk with the engine stopped** (0 bar is normal then), written to the logbook every minute as "System Failure Risk Detected": oil pressure is checked with the engine running only, and a failure risk is logged once per situation, with the advice as its text.
- AIS alerts were written to the logbook in their spoken form ("0 point 38 miles").
- `npm run lint` failed (ESLint 9+ no longer reads `.eslintrc.json`): flat config, lint clean.
- **The anchor API answered 404 on current Signal K servers.** Signal K calls `registerWithRouter` while the asynchronous `plugin.start()` is still running, before the AnchorPlugin exists, so drop / raise / radius / reposition / status / track were never registered. They are now registered up front and resolve the current AnchorPlugin on each request (503 until it is ready).

## [1.1.0] - 2026-08-10

### Added

- **Swing track around the anchor.** The drag alarm now records the positions it evaluates into a bounded ring buffer and exposes them on `GET /navigation/anchor/track` (and in the `/navigation/anchor` snapshot), so a client can draw where the boat has actually been rather than only the alarm circle. Samples are decimated in space and time (1.5 m or 20 s) and capped at 720 points — roughly four hours of swing — so the buffer stays flat in memory on the Pi. Cleared when the anchor is dropped or raised, so a previous anchorage is never drawn around the new one.

## [1.0.0] - 2026-08-10

### Added

- **PlayStation controller support for the autopilot.** A Bluetooth DualSense/DualShock is read server-side straight from `/dev/input`, so it keeps working with the screens off and with no ocearo-ui window focused — the point being a pilot remote you can keep in the cockpit. New endpoints `GET`/`PUT /api/controller/config` (mappings and sensitivity, edited from the autopilot screen of ocearo-ui) and `GET /api/controller/state` (raw input snapshot, so a mapping can be checked without shell access to the Pi). Commands go out through the in-process `app.putSelfPath`, which avoids a round-trip through our own self-signed certificate and security strategy. Default mapping: hold Cross to engage, Circle to disengage, D-Pad for ±1°, L1/R1 for ±10°, left stick to steer.
  - Engaging requires the button to be **held** (`engageHoldMs`, 1 s by default) so a controller knocked about in the cockpit cannot hand over the helm. Disengaging is immediate, always.
  - Losing the controller freezes any turn in progress onto the current heading but deliberately does **not** disengage the pilot: a flat battery mid-passage must not drop the steering.
  - The device is located by name in `/proc/bus/input/devices` rather than by a fixed `/dev/input/jsN`: the node number changes on every reconnect, and the controller's motion sensors are exposed as a second device sharing its name.
- **Host metrics endpoint** `GET /system/metrics` — temperature, CPU, memory, disk, firmware throttling flags and the heaviest processes of the machine running the stack. Registered independently of plugin state so it survives plugin restarts.

- **Do-Not-Disturb Mode**: `/dnd` API with three levels (off / safety-only / all) filtering voice announcements and pausing scheduled analyses; used by the UI bottom-bar toggle and the cinema-mode watcher.
- **Racing Tactical Analysis**: dedicated racing module with tactical recommendations.
- **Holistic Copilot Briefing**: unified situation briefing, parameter-aware weather/sail prompts, natural tone, vessel data normalization and VMG-to-target fix.
- **Voice/TTS Improvements**: units spelled out (nautical miles, knots, degrees), persistent Kokoro daemon, Piper sample-rate fix.
- **Route Planning Analysis**: Intelligent route planning and navigation assistance considering weather forecasts, vessel polar performance, and destination.
- **Failure Prediction Analysis**: Proactive monitoring of vessel systems (engine, electrical) to predict potential failures before they occur, with LLM-powered anomaly detection.
- **Full Stack Installation Guide**: Updated README with comprehensive instructions for building and deploying the Ocearo ecosystem using Docker.

### Changed

- **Alerts are prioritised by navigation state.** Alongside or at anchor, only safety-category alerts are spoken; alarms and warnings still always pass. In `smart` mode every `navigation`-category notification used to be announced, which meant each depth and tide notification in a harbour or a buoyed approach channel. Requires `navigation.state`, published by the autostate plugin; when it is absent the vessel is assumed under way so nothing is ever silenced by a missing plugin.
- **LLM analyses are skipped while moored.** The startup briefing, the five-minute weather commentary and sail-trim advice are the heaviest recurring jobs on the Pi — 60-80 s each on `llama3.2:1b`, several per start, some timing out — and none of them is safety-critical at the dock. The forecast is still fetched and displayed; only the LLM commentary stops. An unknown `navigation.state` counts as under way, so a missing autostate plugin can never silently disable an analysis.
- **Ollama is woken on demand.** When `ollama-power.service` has stopped it after a long idle, the first question now starts it and polls until it answers, instead of failing. Only on the failure path, and only for a local host with passwordless `systemctl`.
- **LLM Prompts**: Updated system prompts in English and French to reflect the AI's role as a true Copilot with global surveillance and failure prediction capabilities.
- **Package Description**: Updated `package.json` description to highlight new Copilot capabilities.

### Fixed

- **`getSelfPath()` returned the Signal K node, not its value** (closes #1). Every consumer expected a plain number or object, and a node object passes a `!== null && !== undefined` guard, so `node * 1.94384` yielded `NaN`. One defect produced five symptoms: hourly logbook entries entirely `NaN`, all-`undefined` flattened data for the analysers, own SOG/COG permanently `null` (so collision logic always reasoned as if stopped), notifications never read, and `JSON.stringify` failures when persisting memory. `_getSelfPath()` now unwraps the leaf node; branch paths without a `value` key are returned untouched.
- **The vessel reported itself as an AIS target.** `app.getPath('vessels')` includes our own vessel and nothing filtered it out, so with no AIS receiver at all the analyser still returned exactly one target — us — at range 0, CPA 0, TCPA 0. Sorted by ascending CPA it came first, was handed to the LLM as "the nearest target, CPA 0 NM in 0 minutes", and was announced at every startup as an imminent collision. Own vessel is now excluded, the briefing only names a target whose CPA/TCPA are actually computable, and traffic is no longer mentioned on `totalInRange` alone.
- **Depth never reached the logbook client.** `_toClientEntry()` hoisted every classic column from `vesselContext` except `depth`, so a value collected and stored on every entry was dropped on the way out of the API. Also falls back to `analysis.metrics.depth` so existing hourly entries surface too.
- **Failure warnings repeated every 60 seconds** for as long as the condition held — a battery sitting just under threshold at the dock re-announced itself every minute. Now debounced on the message, like sail advice already was.
- Serialized dual LLM generations to avoid parallel timeouts on CPU-capped Ollama.
- RPi5 resilience: atomic file writes, weather/tide caching with retry and 429 backoff.
- Memory module was excluded from the package by an over-broad gitignore rule.

### Notes

- The controller commands the pilot through the v1 PUT paths that **`@signalk/signalk-autopilot`** registers (`steering.autopilot.state`, `.actions.adjustHeading`, `.target.headingMagnetic`). Without an autopilot provider plugin the server answers `405 PUT not supported`, which is reported as `commandChannel: "unavailable"` rather than swallowed. On a Raymarine over NMEA2000 the provider must be configured with an explicit `deviceid` when the course computer publishes no `hardwareVersion`, as its EV-1 auto-discovery will not find it.
- **There is no direct rudder command.** The pilot only accepts a state, a target heading/wind angle and ±1°/±10° adjustments — no power steer, no dodge, no rudder angle; and in `standby` the course computer declutches, so nothing in software can move the helm at all. The steering stick therefore acts on the *target*, and freezes onto the current heading when released. A lasting heading change is made with the buttons: the stick gives back, on release, whatever part of the turn the boat has not yet made.
