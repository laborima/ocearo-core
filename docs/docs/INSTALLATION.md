# Installation Guide

This guide covers the complete installation of Ocearo Core and its dependencies.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Installing Dependencies](#installing-dependencies)
  - [Ollama (LLM)](#ollama-llm)
  - [Piper TTS](#piper-tts)
  - [eSpeak (Alternative TTS)](#espeak-alternative-tts)
- [Verification](#verification)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Required

- **Signal K Server** 2.x (tested with 2.33)
- **Node.js** 20 or higher

### Optional (for full functionality)

- **Ollama** — AI-written messages
- **Kokoro**, **Piper** or **eSpeak** — text-to-speech (Kokoro is the default, see the [README](../../README.md#voice-and-ai-optional))
- **Audio output device** — to hear the announcements
- **p7zip-full** — to extract the SHOM bathymetry archives

---

## Installation

Ocearo Core is not yet published on npm or in the Signal K Appstore: install it from a clone.

```bash
git clone https://github.com/laborima/ocearo-core.git ~/ocearo-core
cd ~/.signalk
npm install ~/ocearo-core/plugin
```

### Restart Signal K

```bash
# If using systemd
sudo systemctl restart signalk

# Or manually
signalk-server
```

Then enable the plugin in **Admin UI → Server → Plugin Config → Océaro Core**.

---

## Installing Dependencies

### Ollama (LLM)

Ollama provides local LLM capabilities for intelligent analysis and responses.

#### Linux

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

#### macOS

```bash
brew install ollama
```

#### Windows

Download from [ollama.ai](https://ollama.ai/download)

#### Pull a Model

```bash
# Default: gemma3n:e2b; on a Raspberry Pi 4, gemma3:1b or qwen3:1.7b
ollama pull gemma3n:e2b
```

#### Start Ollama Service

```bash
# Start the service
ollama serve

# Verify it's running
curl http://localhost:11434/api/tags
```

#### Configure in Ocearo Core

In Signal K Admin UI → Plugin Config → Ocearo Core:

- **Ollama Host**: `http://localhost:11434`
- **Model**: `gemma3n:e2b`

---

### Piper TTS

Piper provides high-quality, fast text-to-speech.

#### Download Piper

```bash
# Create directory
mkdir -p ~/piper
cd ~/piper

# Download Piper (adjust URL for your platform)
# Linux x86_64
wget https://github.com/rhasspy/piper/releases/download/v1.2.0/piper_amd64.tar.gz
tar -xzf piper_amd64.tar.gz

# Raspberry Pi (ARM64)
wget https://github.com/rhasspy/piper/releases/download/v1.2.0/piper_arm64.tar.gz
tar -xzf piper_arm64.tar.gz
```

#### Download Voice Models

```bash
cd ~/piper

# English voice
wget https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/joe/medium/en_US-joe-medium.onnx
wget https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/joe/medium/en_US-joe-medium.onnx.json

# French voice
wget https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/tom/medium/fr_FR-tom-medium.onnx
wget https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/tom/medium/fr_FR-tom-medium.onnx.json
```

#### Test Piper

```bash
echo "Hello, this is a test." | ~/piper/piper --model ~/piper/en_US-joe-medium.onnx --output_file test.wav
aplay test.wav
```

#### Configure in Ocearo Core

- **Backend**: `piper`
- **Piper Command**: `/home/YOUR_USER/piper/piper`
- **Piper Model**: `/home/YOUR_USER/piper/en_US-joe-medium.onnx`

---

### eSpeak (Alternative TTS)

eSpeak is a simpler, lighter TTS option.

#### Linux (Debian/Ubuntu)

```bash
sudo apt-get update
sudo apt-get install espeak
```

#### Linux (Fedora/RHEL)

```bash
sudo dnf install espeak
```

#### macOS

```bash
brew install espeak
```

#### Raspberry Pi OS

```bash
sudo apt-get install espeak
```

#### Test eSpeak

```bash
espeak "Hello, this is a test."
```

#### Configure in Ocearo Core

- **Backend**: `espeak`
- **Voice**: `en` (or `fr` for French)

---

## Verification

### Check Plugin Status

1. Open Signal K Admin UI
2. Navigate to **Server → Plugin Config**
3. Find "Ocearo Core" and ensure it's enabled
4. Check the status indicator

### Test API Endpoints

```bash
# Health check
curl http://localhost:3000/plugins/ocearo-core/health

# System status
curl http://localhost:3000/plugins/ocearo-core/status
```

### Test TTS

```bash
# Via API
curl -X POST http://localhost:3000/plugins/ocearo-core/speak \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello Captain, systems are online."}'
```

### Check Logs

```bash
# Signal K logs
journalctl -u signalk -f

# Or in the terminal where Signal K is running
```

---

## Troubleshooting

### Plugin Not Appearing

1. Verify installation location: `ls ~/.signalk/node_modules/ocearo-core`
2. Check for errors: `npm install` in the plugin directory
3. Restart Signal K server

### Ollama Connection Failed

```bash
# Check if Ollama is running
curl http://localhost:11434/api/tags

# Start Ollama if not running
ollama serve
```

### No Audio Output

1. Check audio device: `aplay -l`
2. Test audio: `speaker-test -t wav -c 2`
3. Verify Piper/eSpeak installation
4. Check plugin voice settings

### LLM Responses Slow

- Use a smaller model: `gemma3:1b` or `qwen3:1.7b`
- Increase timeout in settings
- Check system resources (RAM, CPU)

### Permission Errors

```bash
# Fix plugin permissions
chmod -R 755 ~/ocearo-core/plugin
```

---

## Platform-Specific Notes

### Raspberry Pi

- Kokoro runs well on a Raspberry Pi 5; on a Pi 4 prefer Piper (ARM64 binaries) or eSpeak
- Use `gemma3:1b` or `qwen3:1.7b` for Ollama on a Pi 4 (lower memory)

### OpenPlotter

Ocearo Core integrates well with OpenPlotter:

1. Install from a clone (see [Installation](#installation))
2. Configure audio output in OpenPlotter settings
3. Set up autostart for Ollama service

### Docker

If running Signal K in Docker, ensure:

1. Ollama is accessible from the container
2. Audio devices are passed through (for TTS)
3. Network configuration allows localhost access

---

## Next Steps

After installation:

1. [Configure the plugin](CONFIGURATION.md)
2. [Understand the architecture](ARCHITECTURE.md)
3. [Test the features](../README.md#examples)
