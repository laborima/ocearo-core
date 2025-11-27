# Changelog

All notable changes to Ocearo Core will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial public release preparation
- Comprehensive English documentation

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
