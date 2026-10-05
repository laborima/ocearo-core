[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Signal K](https://img.shields.io/badge/Signal%20K-plugin-0a7ea4.svg)](https://signalk.org)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A5%2020-339933.svg)](https://nodejs.org)
[![GitHub Issues](https://img.shields.io/github/issues/laborima/ocearo-core.svg)](https://github.com/laborima/ocearo-core/issues)
[![Contributions welcome](https://img.shields.io/badge/contributions-welcome-brightgreen.svg)](CONTRIBUTING.md)

[Français 🇫🇷](README.fr.md)

# Ocearo Core

**The voice of the boat, for Signal K.** Ocearo Core is a Signal K server plugin that keeps watch with you: it follows the AIS traffic and tells you who gives way under the rules of the road, watches the anchor, the weather, the engine and the batteries, coaches the sail trim against your polars, keeps the logbook — and says it out loud, in English or French. Everything runs on the boat, a Raspberry Pi is enough, and it keeps working with no internet and no AI model at all.

It is the server half of **[Ocearo UI](https://github.com/laborima/ocearo-ui)**, the 3D sailing display, and works on its own with any Signal K setup.

▶ **See it at sea (2:33):** [video tour in English](https://youtu.be/ZDUoifu3cdI) · [en français](https://youtu.be/gu08pE906Ms)

| | |
|---|---|
| ![We must give way to a fishing vessel](https://raw.githubusercontent.com/laborima/ocearo-ui/main/docs/screenshots/colregs.jpg) | ![Anchor watch with the swing track](https://raw.githubusercontent.com/laborima/ocearo-ui/main/docs/screenshots/anchor.jpg) |
| **Collision watch**, as spoken: *“Collision danger: LE PERTUIS at 0.5 miles, CPA 0.1 miles in 6 minutes. Vessel engaged in fishing, we keep clear, rule 18. Pass astern of her, bearing away or slowing down.”* | **Anchor watch.** Drag alarm, the swing track around the anchor, and a state that survives a restart. |

<sub>Screenshots from Ocearo UI, which draws what Ocearo Core computes.</sub>

---

## Contents

- [What it does](#what-it-does)
- [Installation](#installation)
- [Voice and AI (optional)](#voice-and-ai-optional)
- [Configuration](#configuration)
- [HTTP API](#http-api)
- [Signal K data](#signal-k-data)
- [Development](#development)
- [Contributing](#contributing) · [Licence](#licence) · [Disclaimer](#navigation-disclaimer)

---

## What it does

### Collision watch — COLREG / RIPAM

Every 15 seconds, for every AIS target in range: closest point of approach (CPA) and time to it (TCPA), then who gives way under the steering and sailing rules — the same rules as the Ocearo UI display, so the voice and the screen always agree.

- **Who gives way:** overtaking (rule 13), the hierarchy of vessels (rule 18: sailing, fishing, restricted in her ability to manoeuvre — from the AIS status, then the ship type; a yacht motor-sailing is power-driven), two sailing vessels (rule 12: tacks from the true wind, windward boat), head-on (rule 14) and crossing (rule 15).
- **What to do, spoken:** give way early and pass astern (rule 16); hold course and speed, be ready, then act when the other vessel does not (rule 17); in restricted visibility nobody stands on (rule 19).
- Announced again at once when the required action becomes more urgent; one logbook entry per target and situation.
- An aid to the watch, never a decision: narrow channels and traffic separation schemes (rules 9–10) are not modelled.

### Anchor watch — Signal K Anchor API

Drop, raise, set the radius or reposition the anchor from any client. Drag alarm and early-warning ring as Signal K notifications, the state persisted across restarts, and the **swing track** — the positions the boat actually describes around the anchor, kept in a bounded buffer and served to the displays, so a veer or a dragging anchor shows in its shape long before the alarm.

### SHOM bathymetry, offline

For the French coast, the plugin downloads the [SHOM](https://data.shom.fr) digital elevation models around the boat (HOMONIM / TANDEM surveys, 5–20 m resolution, open data) whenever the server is online, converts them once, and serves them to every screen on board as elevation tiles referenced to chart datum. At sea, Ocearo UI draws the seabed in 3D at the current tide with no connection at all.

### Weather, engine and energy

- **Weather:** wind, gusts and gust factor, sea state on the WMO scale, pressure trend (3-hour tendency), wind against tide from the current, point of sail.
- **Failures:** low battery voltage and time to empty, engine overheating, low oil pressure, service due from the engine hours — with the advice that goes with them. Engine alarms on `notifications.propulsion.*` are announced.
- **Startup briefing:** weather, tides, tanks, batteries and sail advice, spoken a few seconds after the plugin starts.

### Sailing and racing

Sail trim and reefing advice from the apparent wind and heel, course optimisation and VMG against the boat's polars, tack and gybe calls in racing mode, and a navigation point every 30 minutes (position, speed, course, depth, weather).

### Logbook

Proxies to [`@meri-imperiumi/signalk-logbook`](https://www.npmjs.com/package/@meri-imperiumi/signalk-logbook) when it is installed; otherwise registers its own Signal K `logbooks` resource provider with a local store. Automatic entries for alerts, AIS encounters and analyses, manual entries, and a fuel log.

### On board

- **Autopilot remote:** a Bluetooth PlayStation controller (DualSense or DualShock) read on the server drives the autopilot through `@signalk/signalk-autopilot` — engaging needs a one-second hold, disengaging is immediate, and losing the controller never drops the steering.
- **Do not disturb:** silence everything but safety alerts, or everything, for a while.
- **System metrics:** CPU, temperature, memory and storage of the Raspberry Pi running the stack.
- **Modes:** sailing, motoring, anchored, moored, racing — set by Ocearo UI or the API, so the plugin speaks about what matters now.

---

## Installation

### Prerequisites

- **Signal K Server** 2.x (tested with 2.33) on **Node.js ≥ 20**.
- Optional: [Ollama](https://ollama.com) for AI-written messages, a TTS engine for the voice (see below), `p7zip-full` for the SHOM archives (`sudo apt install p7zip-full`).

### Install from source

Ocearo Core is not yet in the Signal K Appstore. Install it into the server from a clone:

```bash
git clone https://github.com/laborima/ocearo-core.git ~/ocearo-core
cd ~/.signalk
npm install ~/ocearo-core/plugin
sudo systemctl restart signalk
```

Then enable it in **Admin UI → Server → Plugin Config → Océaro Core**. To update: `git -C ~/ocearo-core pull` and restart the server.

### Companion Signal K plugins

None is bundled; without them the matching feature is simply quiet. Check that they are installed **and enabled** — an installed-but-disabled plugin looks just like a working one in the Admin UI.

| Plugin | Provides | Without it |
|--------|----------|------------|
| [`signalk-derived-data`](https://www.npmjs.com/package/signalk-derived-data) | True wind and true heading (enable `heading`, `angleTrueWater`, `directionTrue`) | Sail coaching, polars and the sailing rules have no true wind |
| [`@meri-imperiumi/signalk-autostate`](https://www.npmjs.com/package/@meri-imperiumi/signalk-autostate) | `navigation.state` | Alerts are not prioritised by state; the boat is assumed under way |
| [`signalk-tides`](https://www.npmjs.com/package/signalk-tides) | `environment.tide.*` | No tides in the briefing |
| [`@signalk/set-system-time`](https://www.npmjs.com/package/@signalk/set-system-time) | System clock from GPS | A Raspberry Pi without a clock battery is wrong after every power cut: tides, day/night and the logbook follow it |
| [`@signalk/signalk-autopilot`](https://www.npmjs.com/package/@signalk/signalk-autopilot) | Signal K v2 autopilot API | No autopilot remote |
| [`@meri-imperiumi/signalk-logbook`](https://www.npmjs.com/package/@meri-imperiumi/signalk-logbook) | Shared logbook | The local logbook store is used instead |

---

## Voice and AI (optional)

Everything works without them: alerts and analyses fall back to written templates, shown in Ocearo UI and logged.

### Voice

| Backend | Quality | Setup |
|---------|---------|-------|
| `kokoro` (default) | Natural, English and French, runs well on a Raspberry Pi 5 | Python venv in `/opt/kokoro`, see below |
| `piper` | Good, fast | [Piper](https://github.com/rhasspy/piper) binary and a voice model |
| `espeak` | Robotic, tiny | `sudo apt install espeak` |
| `console` | Text in the server log | — |

Kokoro, with the helper script shipped in this repository:

```bash
sudo mkdir -p /opt/kokoro && sudo chown "$USER" /opt/kokoro
python3 -m venv /opt/kokoro/venv
/opt/kokoro/venv/bin/pip install kokoro-onnx soundfile
cp ~/ocearo-core/scripts/ocearo-tts.py /opt/kokoro/
cd /opt/kokoro
wget https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx
wget https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
echo "Hello from Ocearo" | /opt/kokoro/venv/bin/python3 /opt/kokoro/ocearo-tts.py   # needs aplay (alsa-utils)
```

The model stays loaded between sentences, so announcements start without delay.

### AI messages (Ollama)

With [Ollama](https://ollama.com) on the boat's server or another machine on board, alerts, briefings and logbook entries are written by a small local model, in the chosen personality (*professional*, *jarvis*, *friend*, *sea dog*). Nothing leaves the boat.

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull gemma3n:e2b        # default; gemma3:1b or qwen3:1.7b for a Raspberry Pi 4
```

The facts — the rule, who gives way, the numbers — are always worked out by the plugin; the model only phrases them.

---

## Configuration

In **Admin UI → Plugin Config → Océaro Core**. The main settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `language` | `fr` | `en` or `fr` |
| `personality` | `jarvis` | `professional`, `jarvis`, `friend`, `sea dog` |
| `boat` | `dufour310gl` | Boat profile (polars, draft) in `plugin/config/boats/` |
| `mode` | `sailing` | Starting mode |
| `llm.enabled` · `llm.ollamaHost` · `llm.model` | `true` · `http://localhost:11434` · `gemma3n:e2b` | AI messages |
| `voice.enabled` · `voice.backend` | `true` · `kokoro` | Voice; `voice.kokoroVoiceEn` / `kokoroVoiceFr`, `voice.piper.*` |
| `ais.enabled` | `true` | Collision watch |
| `ais.dangerCPA` · `cautionCPA` · `watchCPA` | `0.25` · `0.5` · `1.0` NM | CPA thresholds |
| `ais.maxRange` · `ais.maxTCPA` | `5` NM · `30` min | Targets considered |
| `ais.announceCooldownMinutes` | `5` | Before a target is announced again at the same urgency |
| `anchor.defaultRadius` · `watchRadiusPercent` | `30` m · `80` % | Drag alarm and early warning |
| `bathymetry.enabled` · `autoDownload` · `radiusNm` | `true` · `true` · `30` | SHOM models around the boat (100–150 MB each, downloaded once) |
| `startupAnalysis.enabled` | `true` | Spoken briefing at start |
| `schedules.alertCheck` · `sailAnalysis` · `aisCheck` · `weatherUpdate` | `30` · `120` · `15` · `300` s | How often each analysis runs |
| `controller.enabled` · `engageHoldMs` | `true` · `1000` | Autopilot remote |

The full list, with descriptions, is in the Admin UI and in [`plugin/schema.json`](plugin/schema.json).

---

## HTTP API

Under `/plugins/ocearo-core/`. Rate-limited per client: 120 requests/min, 10/min for analyses, 20/min for speech.

| Endpoint | Method | |
|----------|--------|---|
| `/health` · `/status` | GET | Component health; mode, weather, anchor, logbook backend |
| `/analyze` | POST | `{ type }`: `weather`, `sail`, `alerts`, `ais`, `status`, `logbook`, `route`, `racing`, `briefing` |
| `/speak` | POST | `{ text, priority }` |
| `/mode` | POST | `{ mode }` |
| `/dnd` | GET / POST | Do not disturb: `{ mode: 'off' \| 'safety' \| 'all', durationMinutes }` |
| `/system/metrics` | GET | Host CPU, temperature, memory, storage |
| `/navigation/anchor/drop` · `raise` · `radius` · `reposition` | POST | Signal K Anchor API |
| `/navigation/anchor` · `/status` · `/track` | GET | State, status, swing track (`?limit=N`) |
| `/bathymetry/tiles/:z/:x/:y.png` | GET | Terrarium elevation tile, chart datum (404 where no survey) |
| `/bathymetry/status` · `download` · `import` · `regions/:id` | GET · POST · POST · DELETE | SHOM models on board |
| `/logbook/all-entries` · `entries` · `stats` · `backend` | GET | Logbook |
| `/logbook/add-entry` · `entry` · `analyze` | POST | Manual entry, AI entry, analysis |
| `/logbook/fuel` | GET / POST | Fuel log |
| `/memory` · `/memory/stats` · `/memory/context` | GET · GET · POST | Voyage memory, destination |
| `/api/controller/config` · `state` | GET / PUT · GET | Autopilot remote |
| `/llm/test` | POST | Try the AI model |

---

## Signal K data

**Reads** standard paths: `navigation.*` (position, SOG/COG, heading, speed through water, attitude, state, log, route and next waypoint), `environment.*` (wind including gusts, depth, current, outside pressure, temperature and humidity, tide), `electrical.batteries.*`, `propulsion.*`, `tanks.*`, the AIS targets in `vessels.*` (position, course, speed, navigation status, ship type, size) and all `notifications.*`.

**Publishes** `navigation.anchor.*` (position, radius, rode) and the notifications `notifications.navigation.anchor.drag` (emergency), `…anchor.watch` (warn), `…anchor.modeChange`, plus its own `notifications.ocearo.*`.

---

## Development

```bash
git clone https://github.com/laborima/ocearo-core.git
cd ocearo-core/plugin
npm install
npm test           # node --test
npm run lint       # ESLint 10
```

No runtime dependency: only Node.js built-ins and the Signal K server API. Code layout:

```
plugin/
├── index.js              plugin entry, HTTP routes, rate limiting
├── schema.json           Admin UI settings
├── config/               boat profiles, locales (en, fr)
├── src/
│   ├── analyses/         ais, colregs, meteo, failure, sailsettings, sailcourse, racing, route, alert
│   ├── anchor/           Anchor API, drag alarm, persisted state
│   ├── bathymetry/       SHOM catalogue, grids, tiles, PNG encoder
│   ├── brain/            orchestrator: schedules, modes, briefing, do not disturb
│   ├── controller/       PlayStation controller → autopilot
│   ├── dataprovider/     Signal K, weather, tides
│   ├── llm/ voice/       Ollama client, TTS backends
│   ├── logbook/ memory/  logbook (proxy or local store), voyage memory
│   └── system/           host metrics
└── test/                 node:test suites
```

More in [docs/](docs/): [architecture](docs/ARCHITECTURE.md), [configuration](docs/CONFIGURATION.md), [installation](docs/docs/INSTALLATION.md).

---

## Contributing

Bug reports, ideas, translations and pull requests are welcome — read [CONTRIBUTING.md](CONTRIBUTING.md) and open an [issue](https://github.com/laborima/ocearo-core/issues). Good first contributions: a new language in `plugin/config/locales/`, a boat profile with its polars in `plugin/config/boats/`, or a test for an analysis. Changes are listed in the [CHANGELOG](CHANGELOG.md).

[![Buy Me A Coffee](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://www.buymeacoffee.com/laborima)

## Licence

[Apache 2.0](LICENSE). SHOM data under the Licence Ouverte Etalab 2.0.

## Navigation disclaimer

Ocearo Core helps you keep watch; it is **not a certified navigation or safety system** and must not be the only source of navigational information. AIS does not show every vessel, and its advice on the rules of the road is an aid, not a decision. Keep a proper lookout, cross-check with official charts and instruments and follow the regulations. The authors accept no liability for incidents arising from its use.
