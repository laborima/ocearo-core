# Architecture Overview

Technical architecture and design documentation for Ocearo Core.

## Table of Contents

- [System Overview](#system-overview)
- [Module Architecture](#module-architecture)
- [Data Flow](#data-flow)
- [Signal K Integration](#signal-k-integration)
- [External Integrations](#external-integrations)
- [Memory & Persistence](#memory--persistence)
- [Extension Points](#extension-points)

---

## System Overview

Ocearo Core is designed as a modular Signal K plugin that acts as an intelligent marine assistant. It follows a layered architecture with clear separation of concerns.

```
┌──────────────────────────────────────────────────────────────────┐
│                   Signal K Server (Node.js)                       │
│  (subscriptions, delta/out, resources, plugin lifecycle)          │
└───▲───────────────────────▲───────────────────────────▲───────────┘
    │                       │                           │
    │                       │                           │
┌───┴─────────┐   ┌─────────┴──────────┐     ┌──────────┴─────────┐
│ Data        │   │ Knowledge & Memory │     │ Output & UX        │
│ Providers   │   │  (24h context)     │     │  (TTS/Notifications)│
└─────────────┘   └────────────────────┘     └────────────────────┘
    │                       │                           ▲
    │                       │                           │
    └───────────────────────┼───────────────────────────┘
                            │
┌───────────────────────────┴──────────────────────────────────────┐
│                    Orchestrator Brain                             │
│  - Schedulers (startup, 30min nav, hourly log)                   │
│  - Analysis coordination                                          │
│  - Decision making                                                │
└───────────────────────────▲──────────────────────────────────────┘
                            │
┌───────────────────────────┴──────────────────────────────────────┐
│                    LLM Adapter (Ollama)                           │
│  - Local models (phi-3, llama-3)                                 │
│  - Persona-based prompts                                          │
│  - Context injection                                              │
└──────────────────────────────────────────────────────────────────┘
```

---

## Module Architecture

### Directory Structure

```
plugin/
├── index.js                 # Plugin entry point (start/stop/schema)
├── schema.json              # Configuration schema for Admin UI
├── src/
│   ├── brain/
│   │   └── index.js         # OrchestratorBrain - central coordinator
│   ├── analyses/
│   │   ├── alert.js         # AlertAnalyzer - notification processing
│   │   ├── meteo.js         # MeteoAnalyzer - weather analysis
│   │   ├── sailcourse.js    # SailCourseAnalyzer - course optimization
│   │   └── sailsettings.js  # SailSettingsAnalyzer - sail trim advice
│   ├── dataprovider/
│   │   ├── signalk.js       # SignalKDataProvider - vessel data
│   │   ├── marineweather.js # MarineWeatherDataProvider - weather API
│   │   └── tides.js         # TidesDataProvider - tide data
│   ├── llm/
│   │   └── index.js         # LLMModule - Ollama integration
│   ├── voice/
│   │   └── index.js         # VoiceModule - TTS output
│   ├── memory/
│   │   └── index.js         # MemoryManager - contextual memory
│   ├── logbook/
│   │   └── index.js         # LogbookManager - logbook integration
│   └── common/
│       └── index.js         # Utilities, i18n, constants
└── docs/
    ├── INSTALLATION.md
    ├── CONFIGURATION.md
    └── ARCHITECTURE.md
```

### Module Dependencies

```
common (utilities, i18n, constants)
│
├── dataprovider/signalk ──────────────┐
├── dataprovider/marineweather ────────┤
├── dataprovider/tides ────────────────┤
│                                      │
├── memory ────────────────────────────┤
├── logbook ───────────────────────────┤
│                                      │
├── llm ───────────────────────────────┤
├── voice ─────────────────────────────┤
│                                      │
├── analyses/alert ────────────────────┤
├── analyses/meteo ────────────────────┤
├── analyses/sailcourse ───────────────┤
├── analyses/sailsettings ─────────────┤
│                                      │
└── brain ─────────────────────────────┘
         (orchestrates all modules)
```

---

## Data Flow

### Startup Sequence

```
1. Plugin Start
   └── Initialize components
       ├── SignalKDataProvider.start()
       ├── MarineWeatherDataProvider.start()
       ├── TidesDataProvider.start()
       ├── MemoryManager.loadData()
       ├── LogbookManager.testConnection()
       ├── LLMModule.testConnection()
       └── VoiceModule.testBackend()

2. OrchestratorBrain.start()
   ├── Initialize schedulers
   ├── Perform startup analysis
   │   ├── Fetch weather forecast
   │   ├── Fetch tide data
   │   ├── Get vessel status
   │   └── Generate briefing
   └── Speak welcome message
```

### Analysis Flow

```
Trigger (schedule/event)
    │
    ▼
┌─────────────────────┐
│ Fetch Vessel Data   │ ◄── SignalKDataProvider
└─────────────────────┘
    │
    ▼
┌─────────────────────┐
│ Fetch External Data │ ◄── Weather/Tides Providers
└─────────────────────┘
    │
    ▼
┌─────────────────────┐
│ Get Memory Context  │ ◄── MemoryManager
└─────────────────────┘
    │
    ▼
┌─────────────────────┐
│ Run Analysis        │ ◄── Analysis Modules
└─────────────────────┘
    │
    ▼
┌─────────────────────┐
│ Enrich with LLM     │ ◄── LLMModule (optional)
└─────────────────────┘
    │
    ├──► Update Memory
    ├──► Log to Logbook
    ├──► Publish to Signal K
    └──► Speak via TTS
```

### Alert Processing Flow

```
Signal K Notification
    │
    ▼
┌─────────────────────┐
│ AlertAnalyzer       │
│ - Categorize        │
│ - Check duplicates  │
│ - Determine severity│
└─────────────────────┘
    │
    ▼
┌─────────────────────┐
│ LLM Enrichment      │
│ - Contextual explain│
│ - Recommendations   │
└─────────────────────┘
    │
    ├──► Add to alert history
    ├──► Publish enriched notification
    └──► Speak if important
```

---

## Signal K Integration

### Subscribed Paths (Input)

| Path | Description |
|------|-------------|
| `navigation.position` | GPS position |
| `navigation.courseOverGroundTrue` | Course over ground |
| `navigation.speedOverGround` | Speed over ground |
| `navigation.headingTrue` | True heading |
| `environment.depth.belowKeel` | Depth below keel |
| `environment.wind.speedApparent` | Apparent wind speed |
| `environment.wind.angleApparent` | Apparent wind angle |
| `environment.wind.speedTrue` | True wind speed |
| `environment.wind.angleTrueWater` | True wind angle |
| `environment.water.temperature` | Water temperature |
| `notifications.*` | All notifications |
| `electrical.batteries.*` | Battery status |
| `propulsion.*` | Engine data |

### Published Paths (Output)

| Path | Description |
|------|-------------|
| `notifications.ocearoJarvis.*` | Enriched notifications |
| `ocearo.jarvis.brief` | Latest briefing |
| `ocearo.jarvis.mode` | Current operating mode |
| `ocearo.jarvis.persona` | Active persona |
| `ocearo.jarvis.sailAdvice` | Sail recommendations |
| `ocearo.jarvis.logbook.lastEntry` | Last logbook entry |

### Notification Format

Notifications follow Signal K specification:

```javascript
{
  path: 'notifications.ocearoJarvis.weather',
  value: {
    state: 'alert',  // normal, alert, alarm, emergency
    method: ['visual', 'sound'],
    message: 'Strong wind warning: 25 knots expected',
    timestamp: '2024-01-15T10:30:00Z'
  }
}
```

---

## External Integrations

### Ollama (LLM)

- **Protocol**: HTTP REST API
- **Default URL**: `http://localhost:11434`
- **Endpoints used**:
  - `GET /api/tags` - List models, test connection
  - `POST /api/generate` - Generate completions

### Piper TTS

- **Protocol**: Subprocess (stdin/stdout)
- **Input**: Text via stdin
- **Output**: WAV audio via stdout or file

### Open-Meteo Marine API

- **Protocol**: HTTPS REST
- **URL**: `https://marine-api.open-meteo.com/v1/marine`
- **Data**: Wave height, wind, swell, forecasts

### NOAA Tides API

- **Protocol**: HTTPS REST
- **URL**: `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter`
- **Data**: Tide predictions, water levels

### signalk-logbook Plugin

- **Protocol**: HTTP REST (local)
- **Endpoints**:
  - `POST /signalk/v1/api/resources/logbook` - Create entry
  - `GET /signalk/v1/api/resources/logbook` - List entries

---

## Memory & Persistence

### Memory Manager

Maintains contextual memory for coherent AI responses:

```javascript
{
  vesselContext: {
    name: "Cirrus",
    type: "sailboat",
    // ... vessel details
  },
  alertHistory: [
    { timestamp, type, message, severity }
  ],
  navigationHistory: [
    { timestamp, position, speed, course }
  ]
}
```

**Storage**: `~/.signalk/plugin-config-data/ocearo-core-memory.json`

### Logbook Integration

Entries are sent to signalk-logbook plugin:

```javascript
{
  datetime: "2024-01-15T10:00:00Z",
  title: "Weather Analysis",
  author: "ocearo-core",
  body: "Analysis content...",
  position: { latitude, longitude }
}
```

---

## Extension Points

### Adding a New Analysis Module

1. Create class in `src/analyses/`:

```javascript
class MyAnalyzer {
    constructor(app, config, llm) {
        this.app = app;
        this.config = config;
        this.llm = llm;
    }

    async analyze(vesselData, context) {
        // Perform analysis
        // Optionally enrich with LLM
        return {
            summary: "...",
            recommendations: [],
            confidence: 0.9
        };
    }
}

module.exports = MyAnalyzer;
```

2. Register in `OrchestratorBrain`
3. Add scheduling if needed

### Adding a New Data Provider

1. Create class in `src/dataprovider/`:

```javascript
class MyDataProvider {
    constructor(app, config) {
        this.app = app;
        this.config = config;
        this.cache = null;
    }

    start() { /* Initialize */ }
    stop() { /* Cleanup */ }
    
    async getData(params) {
        // Fetch and return data
    }
}

module.exports = MyDataProvider;
```

2. Register in main `index.js`

### Adding a New TTS Backend

1. Add backend method in `VoiceModule`:

```javascript
async speakWithMyBackend(text, options) {
    // Implementation
}
```

2. Add to backend switch in `processQueue()`
3. Add configuration options

### Adding Translations

Add entries to `src/common/index.js`:

```javascript
const i18n = {
    translations: {
        en: {
            my_key: 'English text {variable}',
        },
        fr: {
            my_key: 'Texte français {variable}',
        }
    }
};
```

---

## Performance Considerations

### Caching Strategy

- Weather data: 30 minutes
- Tide data: 6 hours
- LLM connection state: 60 seconds

### Resource Usage

- Memory: ~50-100MB (without LLM)
- CPU: Minimal (event-driven)
- Network: Periodic API calls

### Timeouts

- LLM requests: 30 seconds (configurable)
- Weather API: 15 seconds
- Tides API: 15 seconds

---

## Error Handling

### Graceful Degradation

- LLM unavailable → Use fallback messages
- Weather API fails → Use cached/mock data
- TTS fails → Log to console
- Logbook unavailable → Skip logging

### Error Recovery

- Automatic reconnection attempts
- Cached data fallback
- Silent failure for non-critical features
