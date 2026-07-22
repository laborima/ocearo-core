# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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
