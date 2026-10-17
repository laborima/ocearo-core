#!/usr/bin/env python3
"""
Ocearo Piper TTS server.

Loads the Piper voice ONCE and keeps it resident, then reads one JSON request
per stdin line:
    {"text": "...", "length_scale": 1.0}
Each request is synthesized sentence by sentence and streamed to aplay, so the
first sentence plays while the next ones are computed. A marker line is
written to stdout when the utterance has been played (or failed), so the
caller knows it finished.

Run it with the Python of the Piper install (piper-tts >= 1.3), e.g.
    /opt/piper/venv/bin/python3 ocearo-piper-server.py --model /opt/piper/fr_FR-tom-medium.onnx

Running `piper` once per announcement reloads the ~60 MB model every time:
about 4.5 s on a Raspberry Pi 5 before a word is heard, and alerts piling up
behind each other when several come at once.
"""
import argparse
import json
import subprocess
import sys

# Same sentinel as ocearo-tts.py (Kokoro); logs go to stderr
MARKER = "__OCEARO_TTS__"


def _log(*a):
    print(*a, file=sys.stderr, flush=True)


def _mark(state):
    print(f"{MARKER}:{state}", flush=True)


def main():
    parser = argparse.ArgumentParser(description="Ocearo Piper TTS server")
    parser.add_argument("--model", required=True, help="path to the .onnx voice")
    parser.add_argument("--device", default="default", help="ALSA output device for aplay")
    args = parser.parse_args()

    from piper import PiperVoice
    from piper.config import SynthesisConfig

    voice = PiperVoice.load(args.model)
    rate = str(voice.config.sample_rate)
    _log(f"piper server: {args.model} loaded ({rate} Hz)")
    _mark("ready")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            text = str(request.get("text", "")).strip()
            if not text:
                _mark("done")
                continue
            config = SynthesisConfig(length_scale=float(request.get("length_scale") or 1.0))
            cmd = ["aplay", "-q", "-r", rate, "-f", "S16_LE", "-t", "raw", "-c", "1"]
            if args.device and args.device != "default":
                cmd += ["-D", args.device]
            player = subprocess.Popen(cmd, stdin=subprocess.PIPE)
            try:
                for chunk in voice.synthesize(text, config):
                    player.stdin.write(chunk.audio_int16_bytes)
                    player.stdin.flush()
            finally:
                player.stdin.close()
                player.wait()
            _mark("done")
        except Exception as error:  # keep serving: one bad request must not kill the voice
            _log(f"piper server error: {error}")
            _mark("error")


if __name__ == "__main__":
    main()
