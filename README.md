[![GitHub Issues](https://img.shields.io/github/issues/laborima/ocearo-core.svg)](https://github.com/laborima/ocearo-core/issues)
[![Contributions welcome](https://img.shields.io/badge/contributions-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![License](https://img.shields.io/badge/License-Apache%202.0-brightgreen.svg)](https://opensource.org/licenses/Apache-2.0)
[![npm version](https://img.shields.io/npm/v/ocearo-core.svg)](https://www.npmjs.com/package/ocearo-core)

# Ocearo Core

**Your Intelligent Marine Assistant for Signal K**

Ocearo Core is the voice and brain of the Ocearo ecosystem. It's a Signal K plugin that provides intelligent navigation assistance, weather briefings, sail coaching, and contextual alerts using LLM (Large Language Model) analysis and Text-to-Speech output.

> *"Just A Rather Very Intelligent System"* — Marine Edition 🚢

---

## **Overview**

Ocearo Core transforms your Signal K server into an intelligent assistant that:

- 🗣️ **Speaks** - Provides voice feedback using Piper TTS or eSpeak
- 🧠 **Thinks** - Analyzes data with local LLM (Ollama) for contextual insights
- 📊 **Monitors** - Continuously tracks vessel data, weather, and alerts
- 📝 **Logs** - Maintains an automatic logbook with hourly entries
- ⛵ **Coaches** - Offers sail trim and course optimization advice

**Your Ocearo Ecosystem:**
- 👀 **Ocearo-UI** = The eyes (3D visual interface)
- 🗣️ **Ocearo-Core** = The voice (AI assistant)
- 🧠 **Signal K** = The nervous system (data)

---

## **Features**

### 🌅 Startup Briefing
- Weather forecast for the next hours
- Tide times and heights
- Current vessel status
- Battery and tank levels

### 📍 Navigation Points (Every 30 min)
- Current position, speed, and course
- Depth monitoring
- Weather conditions update

### 📔 Automatic Logbook
- Hourly entries with vessel state
- Integration with signalk-logbook plugin
- 24-hour contextual memory for coherent AI responses

### ⛵ Sail Coaching
- Real-time sail trim recommendations
- Course optimization based on wind and destination
- Reefing suggestions based on conditions
- VMG (Velocity Made Good) analysis

### 🚨 Smart Alerts
- Intercepts all Signal K notifications
- Provides contextual explanations
- Announces critical alerts via TTS
- Supports multiple languages (English/French)

### 🎭 Personalities & Modes
- **Personas**: Captain, Teammate, Jarvis (Tony Stark style), French Sailor
- **Modes**: Humor/Serious, Predictions on/off, Auto-briefing on/off
- **Languages**: English, French (extensible)

---

## **Installation**

### Prerequisites

- **Signal K Server** ≥ 1.x
- **Node.js** ≥ 18.0.0
- **Ollama** (optional, for LLM features) - [Install Ollama](https://ollama.ai)
- **Piper TTS** (optional, for voice) - [Install Piper](https://github.com/rhasspy/piper)

### Install via npm (Recommended)

```bash
npm install ocearo-core
```

Then restart your Signal K server and configure the plugin via the Admin UI.

### Install from Source

```bash
cd ~/.signalk/node_modules
git clone https://github.com/laborima/ocearo-core.git
cd ocearo-core/plugin
npm install
```

Restart Signal K server.

### Repository Structure

```
ocearo-core/
├── README.md              # This file
├── CONTRIBUTING.md        # Contribution guidelines
├── CHANGELOG.md           # Version history
├── LICENSE                # Apache 2.0 license
├── docs/                  # Documentation
│   ├── INSTALLATION.md    # Detailed installation guide
│   ├── CONFIGURATION.md   # Configuration reference
│   └── ARCHITECTURE.md    # Technical architecture
└── plugin/                # Signal K plugin source
    ├── index.js           # Plugin entry point
    ├── package.json       # npm package definition
    ├── schema.json        # Admin UI configuration schema
    └── src/               # Source modules
```

---

## **Configuration**

Configure Ocearo Core through the Signal K Admin UI under **Server → Plugin Config → Océaro Jarvis**.

### Basic Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `language` | Interface language (en/fr) | `en` |
| `persona` | AI personality style | `jarvis` |
| `mode` | Operating mode (sailing/anchored/motoring) | `sailing` |

### LLM Settings (Ollama)

| Setting | Description | Default |
|---------|-------------|---------|
| `ollamaHost` | Ollama server URL | `http://localhost:11434` |
| `model` | LLM model to use | `phi3:mini` |
| `timeoutSeconds` | Request timeout | `30` |

### Voice Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `enabled` | Enable TTS output | `true` |
| `backend` | TTS engine (piper/espeak/console) | `piper` |
| `piperModel` | Piper voice model | `en_US-joe-medium` |

### Weather Provider

| Setting | Description | Default |
|---------|-------------|---------|
| `provider` | Weather data source | `openmeteo` |
| `cacheMinutes` | Cache duration | `30` |

### Scheduling

| Setting | Description | Default |
|---------|-------------|---------|
| `alertCheck` | Alert check interval (seconds) | `30` |
| `weatherUpdate` | Weather update interval (seconds) | `300` |
| `navPointMinutes` | Navigation point interval | `30` |
| `hourlyLogbook` | Enable hourly logbook entries | `true` |

---

## **API Endpoints**

Ocearo Core exposes several REST endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/plugins/ocearo-core/health` | GET | Health check with component status |
| `/plugins/ocearo-core/status` | GET | Full system status |
| `/plugins/ocearo-core/analyze` | POST | Trigger manual analysis |
| `/plugins/ocearo-core/speak` | POST | Test TTS with custom text |
| `/plugins/ocearo-core/mode` | POST | Update operating mode |
| `/plugins/ocearo-core/memory` | GET | View memory statistics |
| `/plugins/ocearo-core/logbook/entries` | GET | Retrieve logbook entries |

---

## **Signal K Paths**

### Subscriptions (Input)
- `navigation.speedOverGround`
- `navigation.courseOverGroundTrue`
- `navigation.headingTrue`
- `environment.depth.belowKeel`
- `environment.wind.speedApparent`
- `environment.wind.angleApparent`
- `notifications.*`

### Publications (Output)
- `notifications.ocearoJarvis.*` - Alert notifications
- `ocearo.jarvis.brief` - Latest briefing
- `ocearo.jarvis.mode` - Current mode
- `ocearo.jarvis.sailAdvice` - Sail recommendations

---

## **Setting Up Dependencies**

### Ollama (LLM)

1. Install Ollama: https://ollama.ai
2. Pull a model:
   ```bash
   ollama pull phi3:mini
   ```
3. Ensure Ollama is running:
   ```bash
   ollama serve
   ```

### Piper TTS

1. Download Piper: https://github.com/rhasspy/piper/releases
2. Download voice models:
   ```bash
   # English
   wget https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/joe/medium/en_US-joe-medium.onnx
   
   # French
   wget https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/tom/medium/fr_FR-tom-medium.onnx
   ```
3. Configure the path in plugin settings

### eSpeak (Alternative TTS)

```bash
# Debian/Ubuntu
sudo apt-get install espeak

# macOS
brew install espeak
```

---

## **Integration with Ocearo-UI**

Ocearo Core is designed to work seamlessly with [Ocearo-UI](https://github.com/laborima/ocearo-ui):

- Voice announcements complement visual alerts
- Briefings are displayed in the UI
- Logbook entries are viewable in the documentation panel
- Sail advice appears in the performance view

---

## **Examples**

### Jarvis-Style Responses

> "Sir, oil pressure is dropping to 1.2 bar. I suggest reducing RPM immediately and checking the oil level."

> "Attention, critical depth detected. 1.8 meters below keel. My calculations indicate a grounding risk in this area."

> "Sir, weather conditions are evolving. Wind forecast at 28 knots in 2 hours. Perhaps it's time to reduce sail area?"

### Weather Briefing

> "Good morning, Captain. Current conditions: wind 12 knots from the west, waves 1.5 meters. High tide at 14:32 with 4.2 meters. Forecast shows increasing wind this afternoon, reaching 18 knots by 16:00."

---

## **Contributing**

Your contributions make Ocearo Core better! Here's how you can help:

- 🐛 **Report bugs** - Open an issue when something isn't working
- 💡 **Suggest features** - Share your ideas for improvements
- 🔧 **Submit PRs** - Fix bugs, add features, improve documentation
- 🌍 **Translate** - Help add support for more languages
- ☕ **Support** - Help fund development

[![Buy Me A Coffee](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://www.buymeacoffee.com/laborima)

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed guidelines.

---

## **Roadmap**

- [ ] Additional language support (Spanish, German, Italian)
- [ ] More weather providers (NOAA, Météo-France)
- [ ] Advanced polar performance analysis
- [ ] Voice command input (speech-to-text)
- [ ] Integration with autopilot systems
- [ ] Machine learning for personalized sailing advice

---

## **License**

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

---

## **Acknowledgments**

- [Signal K](https://signalk.org) - The open marine data standard
- [OpenPlotter](https://openplotter.readthedocs.io) - Open source sailing platform
- [Ollama](https://ollama.ai) - Local LLM runtime
- [Piper](https://github.com/rhasspy/piper) - Fast local TTS
- [Ocearo-UI](https://github.com/laborima/ocearo-ui) - 3D marine interface

---

## **Navigation Disclaimer**

⚠️ **Use with Caution – Not a Substitute for Official Navigation Systems**

Ocearo Core is designed to enhance sailing awareness and provide intelligent assistance. However, this software is **not a certified navigation or safety system** and should not be relied upon as the sole source of navigational information.

- Always cross-check data with official marine charts, GPS devices, and other navigation aids
- Maintain situational awareness and follow maritime safety regulations
- The developers are not liable for any incidents arising from using this software

By using Ocearo Core, you acknowledge and accept the inherent risks of relying on non-certified navigation tools. **Always navigate responsibly!**

---

## **Support**

- 📖 [Documentation](docs/)
- 🐛 [Issue Tracker](https://github.com/laborima/ocearo-core/issues)
- 💬 [Discussions](https://github.com/laborima/ocearo-core/discussions)
- 📧 Contact: [Open an issue](https://github.com/laborima/ocearo-core/issues/new)
