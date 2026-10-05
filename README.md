[![GitHub Issues](https://img.shields.io/github/issues/laborima/ocearo-core.svg)](https://github.com/laborima/ocearo-core/issues)
[![Contributions welcome](https://img.shields.io/badge/contributions-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![License](https://img.shields.io/badge/License-Apache%202.0-brightgreen.svg)](https://opensource.org/licenses/Apache-2.0)
[![npm version](https://img.shields.io/npm/v/ocearo-core.svg)](https://www.npmjs.com/package/ocearo-core)

[Français 🇫🇷](README.fr.md)

# Ocearo Core

**The First AI Co-pilot for Signal K**

Ocearo Core is the voice and brain of the Ocearo ecosystem — an advanced Signal K plugin transforming your vessel into a smart ship. As a true AI Co-pilot, it provides global vessel monitoring, failure prediction, sail trim optimization based on your boat's polar data, and intelligent route planning. All powered by a local LLM (Ollama) and Text-to-Speech output, ensuring privacy and offline capability.

> *"Just A Rather Very Intelligent System"* — Marine Edition 🚢

---

## **Overview**

Ocearo Core goes beyond simple dashboards. It's an intelligent AI Co-pilot that:

- 👁️ **Monitors** — Global surveillance of all vessel data, weather, and AIS in real time
- 🔮 **Predicts** — Proactive failure prediction and maintenance alerts before things break
- ⛵ **Optimizes** — Sail trim and course optimization matched against your vessel's polar performance
- 🗺️ **Plans** — Intelligent route planning and navigation assistance
- 🗣️ **Speaks** — Contextual voice feedback and alerts via Piper TTS or eSpeak
- 🧠 **Thinks** — Deep contextual analysis with a local LLM (Ollama)
- ⚓ **Anchors** — Full anchor management with drag alarms (Signal K Anchor API)
- 📝 **Logs** — Automatic logbook with local fallback store + fuel log

**Ocearo Ecosystem:**
- 👀 **Ocearo-UI** — The eyes (3D visual interface)
- 🗣️ **Ocearo-Core** — The voice (AI assistant, this plugin)
- 🧠 **Signal K** — The nervous system (data bus)

---

## **Features**

### ⚓ Anchor Management (Signal K Anchor API)
- Drop, raise, reposition anchor via REST endpoints
- Configurable alarm radius with drag detection (haversine)
- Signal K notifications: `notifications.navigation.anchor.drag` (`emergency`) and `notifications.navigation.anchor.watch` (`warn`)
- Persisted anchor state — survives plugin restarts
- Swing track: the positions the drag alarm evaluates are kept in a bounded ring buffer (decimated to 1.5 m / 20 s, capped at 720 points) and served to clients, so the path the boat describes around the anchor can be drawn instead of only the alarm circle
- Mode-change safety: warns if mode changes while anchor is deployed

### 🌊 SHOM Bathymetry (offline)
- High-resolution seabed for the Océaro 3D view from the SHOM digital elevation models (MNT topo-bathymétriques HOMONIM / TANDEM, 5 – 20 m on the French coast, 100 m façades), open data under the Licence Ouverte
- When the server is online, the coastal models within `bathymetry.radiusNm` of the boat are downloaded from data.shom.fr, converted once to a compact grid in `<dataDir>/bathymetry/` and kept; at sea every display gets them from the boat's server
- Served as Web Mercator elevation tiles in the Terrarium encoding, referenced to chart datum (like the tide heights), transparent where no model covers so clients fall back to a global source
- Archives can also be dropped by hand in `<dataDir>/bathymetry/import/` (a `.7z` from data.shom.fr, or the `.asc` inside) and imported with `POST /bathymetry/import`
- Needs the `7z` command to extract the archives (`apt install p7zip-full`); no npm dependency

### � Logbook — Dual Backend
- **Primary**: proxies to `@meri-imperiumi/signalk-logbook` if installed
- **Fallback**: registers as a Signal K Resource Provider (`logbooks`) with local JSON store in `<dataDir>/ocearo-logbook/`
- Fuel log always stored locally (`fuel-log.json`) regardless of backend
- AI-enhanced entries via LLM when Ollama is available

### 🌅 Startup Briefing
- Weather forecast, tide times, tank and battery levels
- Spoken summary on plugin start

### 📍 Navigation Points (every 30 min)
- Position, speed, course, depth, weather update

### ⛵ Sail Coaching
- Real-time sail trim recommendations
- Course optimisation with VMG analysis
- Reefing suggestions based on conditions

### ⚓ Collision Watch (COLREG / RIPAM)
- CPA / TCPA for every AIS target, every 15 s
- Who gives way under the steering and sailing rules, the same rules as the ocearo-ui display: overtaking (13), vessel hierarchy (18: sailing, fishing, restricted, from the AIS status or ship type; motor-sailing is power), two sailing vessels (12: tacks from the true wind, windward boat), head-on (14), crossing (15)
- What to do, spoken: give way early and pass astern (16), hold course and speed, be ready, then act when the other does not (17), no stand-on vessel in restricted visibility (19)
- Repeated at once when the required action becomes more urgent; one logbook entry per target and situation
- An aid to the watch, never a decision: no narrow channels or traffic separation schemes (rules 9–10)

### 🚨 Smart Alerts
- Intercepts all Signal K notifications
- Contextual LLM explanations
- Critical alerts announced via TTS
- Engine alarm monitoring (`notifications.propulsion.*`)

### 🎭 Personalities & Modes
- **Personas**: Captain, Teammate, Jarvis, French Sailor
- **Modes**: `sailing`, `anchored`, `motoring`, `moored`, `racing`
- **Languages**: English, French (extensible)

---

## **Architecture**

```
plugin/
├── index.js                  # Entry point, Express router, security middleware
├── schema.json               # Admin UI config schema
└── src/
    ├── anchor/
    │   ├── anchor-state.js   # State machine (raised/dropping/dropped/raising)
    │   ├── anchor-alarm.js   # Drag detection + SK notifications
    │   └── anchor-plugin.js  # REST endpoints + registerWithRouter
    ├── analyses/
    │   ├── alert.js          # Alert analysis
    │   ├── ais.js            # AIS collision detection
    │   ├── colregs.js        # Right of way (COLREG / RIPAM rules 12-19)
    │   ├── meteo.js          # Weather analysis
    │   ├── sailcourse.js     # Course optimisation
    │   └── sailsettings.js   # Sail trim recommendations
    ├── brain/
    │   └── index.js          # OrchestratorBrain — schedules, mode, status
    ├── config/
    │   └── index.js          # ConfigManager + i18n
    ├── dataprovider/
    │   ├── signalk.js        # SignalKDataProvider
    │   ├── marineweather.js  # Weather provider
    │   └── tides.js          # Tides provider
    ├── llm/
    │   └── index.js          # LLMClient (Ollama)
    ├── logbook/
    │   ├── index.js          # LogbookManager (dual backend)
    │   └── logbook-store.js  # Local JSON store + Resource Provider
    ├── memory/
    │   └── index.js          # MemoryManager
    └── voice/
        └── index.js          # VoiceModule (Piper / eSpeak / console)
```

### Data Flow

```
Signal K data bus
      │
      ▼
SignalKDataProvider ──► OrchestratorBrain ──► LLMClient (Ollama)
      │                       │                     │
      │                  Analyzers              VoiceModule
      │                       │                (Piper TTS)
      │                  LogbookManager
      │                 (SK logbook / local store)
      │
      ▼
AnchorPlugin ──► AnchorAlarm ──► SK notifications
             └─► AnchorState (persisted)
```

---

## **Installation**

### Prerequisites

- **Signal K Server** ≥ 1.x
- **Node.js** ≥ 20
- **Ollama** (optional, for LLM) — [Install Ollama](https://ollama.ai)
- **Piper TTS** (optional, for voice) — [Install Piper](https://github.com/rhasspy/piper)

#### Companion Signal K plugins

None of these are bundled; without them the corresponding feature is simply inert, so it is worth checking they are installed **and enabled** (an installed-but-unconfigured plugin looks identical to a working one in the Admin UI):

| Plugin | Why | Without it |
|--------|-----|------------|
| [`@meri-imperiumi/signalk-autostate`](https://www.npmjs.com/package/@meri-imperiumi/signalk-autostate) | Publishes `navigation.state` | Alerts are never prioritised by navigation state and LLM analyses never pause at the dock — the vessel is assumed under way |
| [`signalk-derived-data`](https://www.npmjs.com/package/signalk-derived-data) | Computes true wind and true heading from apparent wind + STW | `environment.wind.speedTrue`, `angleTrueWater`, `directionTrue` and `navigation.headingTrue` are absent; sail coaching and polar analysis have nothing to work with. Enable the `heading`, `angleTrueWater` and `directionTrue` calculations |
| [`@signalk/set-system-time`](https://www.npmjs.com/package/@signalk/set-system-time) | Disciplines the system clock from `navigation.datetime` (GPS) | On a machine with no battery-backed RTC — a Raspberry Pi 5 out of the box — the clock is wrong after every power cut without internet, and tides, day/night and log ordering follow it |
| [`@signalk/signalk-autopilot`](https://www.npmjs.com/package/@signalk/signalk-autopilot) | Provides the v2 autopilot API | The autopilot view has no device to talk to. A pilot on the NMEA2000 bus still publishes `steering.autopilot.state`, which makes the absence look like an idle pilot rather than a missing provider |

### Install via npm

```bash
npm install ocearo-core
```

Restart Signal K and configure via **Admin UI → Server → Plugin Config → Océaro Core**.

### Install from Source

```bash
cd ~/.signalk/node_modules
git clone https://github.com/laborima/ocearo-core.git
cd ocearo-core/plugin
npm install
```

---

## **Configuration**

### Basic

| Setting | Description | Default |
|---------|-------------|---------|
| `language` | Interface language (`en`/`fr`) | `en` |
| `persona` | AI personality | `jarvis` |
| `mode` | Operating mode | `sailing` |

### Anchor

| Setting | Description | Default |
|---------|-------------|---------|
| `anchor.defaultRadius` | Alarm radius in metres | `30` |
| `anchor.watchRadiusPercent` | Watch threshold (% of radius) | `80` |
| `anchor.positionUpdateInterval` | Position check interval (ms) | `2000` |

### Bathymetry

| Setting | Description | Default |
|---------|-------------|---------|
| `bathymetry.enabled` | Serve SHOM bathymetry tiles | `true` |
| `bathymetry.autoDownload` | Download the coastal models around the boat when online (100 – 150 MB each, once) | `true` |
| `bathymetry.radiusNm` | Area around the boat, nautical miles | `30` |

### LLM (Ollama)

| Setting | Description | Default |
|---------|-------------|---------|
| `ollamaHost` | Ollama server URL | `http://localhost:11434` |
| `model` | Model name | `llama3.2:3b` |
| `timeoutSeconds` | Request timeout | `30` |

### Voice

| Setting | Description | Default |
|---------|-------------|---------|
| `voice.enabled` | Enable TTS | `true` |
| `voice.backend` | Engine (`piper`/`espeak`/`console`) | `piper` |
| `voice.piperModel` | Piper voice model | `en_US-joe-medium` |

### Scheduling

| Setting | Description | Default |
|---------|-------------|---------|
| `schedules.alertCheck` | Alert check (seconds) | `30` |
| `schedules.weatherUpdate` | Weather update (seconds) | `300` |
| `schedules.navPointMinutes` | Navigation point (minutes) | `30` |

---

## **API Endpoints**

All endpoints are under `/plugins/ocearo-core/`. Rate limits apply (120 req/min general, 10/min for AI operations).

### System

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Component health check |
| `/status` | GET | Full system status (mode, weather, anchor, logbook backend) |
| `/analyze` | POST | Trigger an analysis (`weather`, `sail`, `alerts`, `ais`, `status`, `logbook`, `route`, `racing`, `briefing`); works without an LLM, which only adds the synthesis |
| `/speak` | POST | Speak text via TTS (`{ text, priority }`) |
| `/mode` | POST | Change operating mode (`{ mode }`) |

### Memory

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/memory` | GET | Memory context and statistics |
| `/memory/stats` | GET | Statistics only |
| `/memory/context` | POST | Update vessel info / destination |

### Logbook

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/logbook/all-entries` | GET | All entries (proxied or local) |
| `/logbook/entries` | GET | Analysis entries only |
| `/logbook/add-entry` | POST | Add manual logbook entry |
| `/logbook/entry` | POST | Generate AI-enhanced entry from vessel data |
| `/logbook/entry` | GET | Retrieve recent AI entries (`?limit=50`) |
| `/logbook/analyze` | POST | Full AI logbook analysis |
| `/logbook/stats` | GET | Analysis statistics |
| `/logbook/fuel` | GET | Fuel log entries |
| `/logbook/fuel` | POST | Add fuel refill record |
| `/logbook/backend` | GET | Active backend (`signalk-logbook` or `local`) |

### Anchor (Signal K Anchor API)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/navigation/anchor/drop` | POST | Drop anchor at current position |
| `/navigation/anchor/raise` | POST | Raise anchor |
| `/navigation/anchor/radius` | POST | Set alarm radius `{ value: metres }` |
| `/navigation/anchor/reposition` | POST | Reposition `{ rodeLength, anchorDepth }` |
| `/navigation/anchor/status` | GET | Lightweight status |
| `/navigation/anchor/track` | GET | Recorded swing track, `?limit=N` for the last N points |
| `/navigation/anchor` | GET | Full anchor state snapshot (track included) |

### Bathymetry (SHOM)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/bathymetry/tiles/:z/:x/:y.png` | GET | Terrarium elevation tile (zoom 8 – 16), chart datum; 404 where no model covers |
| `/bathymetry/status` | GET | Models on board, downloads in progress, models available around the boat |
| `/bathymetry/download` | POST | `{ id }` one model, or `{ lat?, lon?, radiusNm? }` the coastal models around a position |
| `/bathymetry/import` | POST | Convert the archives dropped in `<dataDir>/bathymetry/import/` |
| `/bathymetry/regions/:id` | DELETE | Remove a model |

### LLM

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/llm/test` | POST | Test LLM with custom prompt |

---

## **Signal K Paths**

### Subscriptions (Input)
- `navigation.position`, `navigation.speedOverGround`, `navigation.courseOverGroundTrue`
- `navigation.headingTrue`, `environment.depth.belowKeel`
- `environment.wind.speedApparent`, `environment.wind.angleApparent`
- `notifications.*`

### Publications (Output)
- `notifications.navigation.anchor.drag` — drag alarm (`emergency`)
- `notifications.navigation.anchor.watch` — approaching limit (`warn`)
- `notifications.navigation.anchor.modeChange` — mode changed while anchored
- `navigation.anchor.position` — anchor drop position
- `navigation.anchor.currentRadius` — active alarm radius
- `navigation.anchor.maxRadius` — configured max radius
- `navigation.anchor.rodeLength` — rode length

---

## **Setting Up Dependencies**

### Ollama (LLM)

```bash
# Install Ollama
curl -fsSL https://ollama.ai/install.sh | sh

# Pull a model
ollama pull llama3.2:3b

# Start server
ollama serve
```

### Piper TTS

```bash
# Download binary from https://github.com/rhasspy/piper/releases

# English voice
wget https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/joe/medium/en_US-joe-medium.onnx

# French voice
wget https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/tom/medium/fr_FR-tom-medium.onnx
```

### eSpeak (fallback TTS)

```bash
# Debian/Ubuntu
sudo apt-get install espeak

# macOS
brew install espeak
```

---

## **Integration with Ocearo-UI**

Ocearo Core is designed to work seamlessly with [Ocearo-UI](https://github.com/laborima/ocearo-ui):

- Anchor controls call `/navigation/anchor/*` endpoints
- Fuel log uses `/logbook/fuel` with fallback to `/logbook/add-entry`
- AI analysis triggered via `/analyze` with types `weather`, `sail`, `alerts`, `ais`, `status`, `logbook`, `route`
- Engine alarms read from `notifications.propulsion.*` Signal K paths
- Mode changes propagated via `/mode` endpoint

---

## **Security**

- **Rate limiting** — built-in per-IP limiter (no external dependency):
  - General: 120 req/min
  - AI operations (`/analyze`, `/logbook/entry`, `/llm/test`): 10/min
  - TTS (`/speak`): 20/min
- **Input sanitisation** — control characters stripped, lengths enforced
- **JSON validation** — all POST bodies validated before processing
- **404 catch-all** — unknown routes return structured JSON errors

---

## **Contributing**

- 🐛 **Report bugs** — Open an issue
- 💡 **Suggest features** — Share ideas
- 🔧 **Submit PRs** — Fix bugs, add features, improve docs
- 🌍 **Translate** — Add language support

[![Buy Me A Coffee](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://www.buymeacoffee.com/laborima)

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## **Roadmap**

- [ ] Additional languages (Spanish, German, Italian)
- [ ] More weather providers (NOAA, Météo-France)
- [ ] Advanced polar performance analysis
- [ ] Voice command input (speech-to-text)
- [ ] Autopilot integration
- [ ] Machine learning for personalised sailing advice

---

## **License**

Apache License 2.0 — see [LICENSE](LICENSE).

---

## **Acknowledgments**

- [Signal K](https://signalk.org) — Open marine data standard
- [Ollama](https://ollama.ai) — Local LLM runtime
- [Piper](https://github.com/rhasspy/piper) — Fast local TTS
- [Ocearo-UI](https://github.com/laborima/ocearo-ui) — 3D marine interface
- [OpenPlotter](https://openplotter.readthedocs.io) — Open source sailing platform

---

## Navigation Disclaimer

⚠ Use with Caution – Not a Substitute for Official Navigation Systems

Ocearo Core is designed to enhance sailing awareness and provide intelligent assistance. However, this software is not a certified navigation or safety system and should not be relied upon as the sole source of navigational information.

- Always cross-check data with official marine charts, GPS devices, and other navigation aids.
- Maintain situational awareness and follow maritime safety regulations.
- The developers of Ocearo Core are not liable for any incidents, accidents, or navigation errors that may arise from using this software.

By using Ocearo Core, you acknowledge and accept the inherent risks of relying on non-certified navigation tools. Always navigate responsibly!

---

## **Support**

- 📖 [Documentation](docs/)
- 🐛 [Issue Tracker](https://github.com/laborima/ocearo-core/issues)
- 💬 [Discussions](https://github.com/laborima/ocearo-core/discussions)
