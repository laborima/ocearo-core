# Configuration Guide

Complete reference for all Ocearo Core configuration options.

## Table of Contents

- [Accessing Configuration](#accessing-configuration)
- [General Settings](#general-settings)
- [LLM Settings](#llm-settings)
- [Voice Settings](#voice-settings)
- [Weather Provider](#weather-provider)
- [Tides Provider](#tides-provider)
- [Scheduling](#scheduling)
- [Logbook Settings](#logbook-settings)
- [Alert Settings](#alert-settings)
- [Advanced Settings](#advanced-settings)
- [Example Configurations](#example-configurations)

---

## Accessing Configuration

### Via Signal K Admin UI

1. Open Signal K Admin UI (usually `http://localhost:3000`)
2. Navigate to **Server → Plugin Config**
3. Find **Ocearo Core** in the list
4. Click to expand and configure

### Via Configuration File

Configuration is stored in `~/.signalk/plugin-config-data/ocearo-core.json`

---

## General Settings

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `language` | string | `"en"` | Interface language (`en`, `fr`) |
| `persona` | string | `"jarvis"` | AI personality style |
| `mode` | string | `"sailing"` | Operating mode |

### Language Options

- `en` - English
- `fr` - French (Français)

### Persona Options

| Persona | Style | Description |
|---------|-------|-------------|
| `jarvis` | Formal, efficient | Tony Stark's AI assistant style |
| `captain` | Professional, reassuring | Experienced captain |
| `teammate` | Casual, modern | Tech-savvy crew member |
| `marin` | Authentic, colorful | Traditional French sailor |

### Mode Options

- `sailing` - Active sailing mode with full analysis
- `anchored` - Reduced monitoring, anchor watch
- `motoring` - Motor-focused monitoring

---

## LLM Settings

Configure the Ollama LLM integration.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `llm.ollamaHost` | string | `"http://localhost:11434"` | Ollama server URL |
| `llm.model` | string | `"qwen2.5:3b"` | LLM model to use |
| `llm.timeoutSeconds` | number | `30` | Request timeout |

### Recommended Models

| Model | Size | Speed | Quality | RAM Required |
|-------|------|-------|---------|--------------|
| `qwen2.5:3b` | 2.0GB | Fast | Good | 4GB |
| `phi4-mini` | 2.5GB | Fast | Good | 4GB |
| `llama3` | 4.7GB | Medium | Better | 8GB |
| `mistral` | 4.1GB | Medium | Better | 8GB |

### Disabling LLM

Set `llm.ollamaHost` to empty string to disable LLM features. The plugin will use basic fallback messages.

---

## Voice Settings

Configure text-to-speech output.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `voice.enabled` | boolean | `true` | Enable/disable TTS |
| `voice.backend` | string | `"piper"` | TTS engine |
| `voice.piper.command` | string | `"piper"` | Piper executable path |
| `voice.piper.model` | string | `""` | Piper voice model path |
| `voice.espeak.voice` | string | `"en"` | eSpeak voice |
| `voice.espeak.speed` | number | `150` | Speech rate (words/min) |

### Backend Options

| Backend | Quality | Speed | Resource Usage |
|---------|---------|-------|----------------|
| `piper` | High | Fast | Medium |
| `espeak` | Medium | Fast | Low |
| `console` | N/A | N/A | None (text only) |

### Piper Voice Models

**English:**
- `en_US-joe-medium` - Male, American
- `en_GB-alan-medium` - Male, British

**French:**
- `fr_FR-tom-medium` - Male, French
- `fr_FR-siwis-medium` - Female, French

---

## Weather Provider

Configure marine weather data source.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `weatherProvider.provider` | string | `"openmeteo"` | Weather data source |
| `weatherProvider.cacheMinutes` | number | `30` | Cache duration |
| `weatherProvider.timeoutSeconds` | number | `15` | Request timeout |

### Provider Options

| Provider | API Key | Coverage | Features |
|----------|---------|----------|----------|
| `openmeteo` | No | Global | Waves, wind, swell |
| `noaa` | No | US waters | Detailed forecasts |
| `none` | N/A | N/A | Mock data (testing) |

---

## Tides Provider

Configure tide data source.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `tidesProvider.enabled` | boolean | `true` | Enable tide data |
| `tidesProvider.provider` | string | `"none"` | Tide data source |
| `tidesProvider.stationId` | string | `""` | Tide station ID |
| `tidesProvider.cacheHours` | number | `6` | Cache duration |

### Provider Options

| Provider | Description | Configuration |
|----------|-------------|---------------|
| `local` | Local JSON files | Requires `stationId` |
| `noaa` | NOAA CO-OPS API | Requires US `stationId` |
| `none` | Mock data | No configuration |

### Local Tide Data Format

Place JSON files in `tides/{stationId}/{MM}_{YYYY}.json`:

```json
{
  "2025-01-15": [
    ["tide.high", "05:21", "5.95m", "80"],
    ["tide.low", "11:38", "1.45m", "---"],
    ["tide.high", "17:44", "5.70m", "81"],
    ["tide.low", "23:56", "1.56m", "---"]
  ]
}
```

---

## Scheduling

Configure automatic task intervals.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `schedules.alertCheck` | number | `30` | Alert check interval (seconds) |
| `schedules.weatherUpdate` | number | `300` | Weather update interval (seconds) |
| `schedules.sailAnalysis` | number | `120` | Sail analysis interval (seconds) |
| `schedules.memoryPersist` | number | `600` | Memory save interval (seconds) |
| `schedules.navPointMinutes` | number | `30` | Navigation point interval (minutes) |
| `schedules.hourlyLogbook` | boolean | `true` | Enable hourly logbook entries |
| `schedules.speakNavPoint` | boolean | `true` | Announce navigation points |
| `schedules.speakHourlyLog` | boolean | `false` | Announce hourly log entries |

---

## Logbook Settings

Configure logbook integration.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `logbook.enabled` | boolean | `true` | Enable logbook integration |
| `logbook.serverUrl` | string | `""` | Signal K server URL (auto-detected) |
| `logbook.author` | string | `"ocearo-core"` | Author name for entries |
| `logbook.logAnalysis` | boolean | `true` | Log AI analysis results |
| `logbook.includeVesselDataInAnalysis` | boolean | `true` | Include vessel data |
| `logbook.logRecommendations` | boolean | `true` | Log recommendations |

---

## Alert Settings

Configure alert handling.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `alertMode` | string | `"smart"` | Alert processing mode |
| `alerts.suppressDuplicateMinutes` | number | `30` | Duplicate suppression window |

### Alert Mode Options

| Mode | Description |
|------|-------------|
| `smart` | Speak important alerts, analyze with LLM |
| `verbose` | Speak all alerts |
| `basic` | Simple messages, no LLM |
| `silent` | No voice output |

---

## Advanced Settings

### Thresholds

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `thresholds.windStrong` | number | `20` | Strong wind threshold (knots) |
| `thresholds.windHigh` | number | `25` | High wind threshold (knots) |
| `thresholds.waveHigh` | number | `3` | High wave threshold (meters) |
| `thresholds.waveRough` | number | `2` | Rough sea threshold (meters) |

### Startup Analysis

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `startupAnalysis.weather` | boolean | `true` | Weather analysis on startup |
| `startupAnalysis.tides` | boolean | `true` | Tide info on startup |
| `startupAnalysis.sailRecommendations` | boolean | `true` | Sail advice on startup |
| `startupAnalysis.tankLevels` | boolean | `true` | Tank levels on startup |
| `startupAnalysis.batteryLevels` | boolean | `true` | Battery status on startup |

---

## Example Configurations

### Minimal Configuration

```json
{
  "language": "en",
  "persona": "jarvis",
  "mode": "sailing"
}
```

### Full-Featured Setup

```json
{
  "language": "en",
  "persona": "jarvis",
  "mode": "sailing",
  "llm": {
    "ollamaHost": "http://localhost:11434",
    "model": "qwen2.5:3b",
    "timeoutSeconds": 30
  },
  "voice": {
    "enabled": true,
    "backend": "piper"
  },
  "weatherProvider": {
    "cacheMinutes": 30
  },
  "tidesProvider": {
    "enabled": true
  },
  "schedules": {
    "alertCheck": 30,
    "weatherUpdate": 300,
    "navPointMinutes": 30,
    "hourlyLogbook": true
  },
  "logbook": {
    "enabled": true,
    "author": "Jarvis"
  }
}
```

### French Sailor Setup

```json
{
  "language": "fr",
  "persona": "marin",
  "mode": "sailing",
  "voice": {
    "enabled": true,
    "backend": "piper",
    "piper": {
      "model": "/home/pi/piper/fr_FR-tom-medium.onnx"
    }
  }
}
```

### Low-Resource Setup (Raspberry Pi)

```json
{
  "language": "en",
  "persona": "jarvis",
  "llm": {
    "ollamaHost": "http://localhost:11434",
    "model": "qwen2.5:3b",
    "timeoutSeconds": 60
  },
  "voice": {
    "enabled": true,
    "backend": "espeak"
  },
  "schedules": {
    "weatherUpdate": 600,
    "sailAnalysis": 300
  }
}
```

### Silent Mode (No Voice)

```json
{
  "language": "en",
  "persona": "jarvis",
  "voice": {
    "enabled": false
  },
  "alertMode": "silent"
}
```

---

## Environment Variables

Some settings can be overridden via environment variables:

| Variable | Description |
|----------|-------------|
| `OLLAMA_HOST` | Override Ollama server URL |
| `OCEARO_LANGUAGE` | Override language setting |

---

## Troubleshooting Configuration

### Configuration Not Saving

1. Check file permissions on `~/.signalk/plugin-config-data/`
2. Restart Signal K server after changes
3. Check Signal K logs for errors

### Settings Not Taking Effect

1. Disable and re-enable the plugin
2. Restart Signal K server
3. Clear browser cache for Admin UI

### Resetting to Defaults

Delete the configuration file:
```bash
rm ~/.signalk/plugin-config-data/ocearo-core.json
```

Then restart Signal K server.
