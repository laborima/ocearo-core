#!/opt/kokoro/venv/bin/python3
"""
Ocearo Kokoro TTS helper.

Two modes:
  * one-shot (default)  — read text from stdin, synthesize once, play, exit.
                          Kept for backward compatibility and quick tests.
  * server (--server)   — load the Kokoro model ONCE and keep it resident,
                          then read one JSON request per stdin line:
                              {"text": "...", "voice": "ff_siwis",
                               "speed": 1.0, "lang": "fr-fr"}
                          After each utterance is played, a marker line is
                          written to stdout so the caller knows it finished.

The server mode avoids reloading the ~hundreds-of-MB ONNX model on every
sentence, which is the single biggest TTS latency cost on a Raspberry Pi 5.
"""
import sys
import argparse
import subprocess
import tempfile
import os
import json

# Sentinel the Node side scans for on stdout (model/library logs go to stderr).
MARKER = "__OCEARO_TTS__"


def _log(*a):
    print(*a, file=sys.stderr, flush=True)


def main():
    parser = argparse.ArgumentParser(description="Ocearo Kokoro TTS")
    parser.add_argument("--lang", default="en-us")
    parser.add_argument("--voice", default="af_heart")
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument(
        "--server",
        action="store_true",
        help="Persistent mode: keep the model loaded, one JSON request per stdin line.",
    )
    args = parser.parse_args()

    import soundfile as sf
    from kokoro_onnx import Kokoro

    model_dir = os.path.dirname(os.path.abspath(__file__))
    model = os.path.join(model_dir, "kokoro-v1.0.int8.onnx")
    voices = os.path.join(model_dir, "voices-v1.0.bin")

    kokoro = Kokoro(model, voices)

    def speak(text, voice, speed, lang):
        text = (text or "").strip()
        if not text:
            return
        samples, sr = kokoro.create(text, voice=voice, speed=speed, lang=lang)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            tmp = f.name
        try:
            sf.write(tmp, samples, sr)
            subprocess.run(["aplay", "-q", tmp], check=True)
        finally:
            os.unlink(tmp)

    if not args.server:
        # One-shot mode (backward compatible).
        speak(sys.stdin.read(), args.voice, args.speed, args.lang)
        return

    # Server mode — model stays resident.
    print(f"{MARKER}:ready", flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            speak(
                req.get("text", ""),
                req.get("voice", args.voice),
                float(req.get("speed", args.speed)),
                req.get("lang", args.lang),
            )
            print(f"{MARKER}:done", flush=True)
        except Exception as e:  # never let one bad utterance kill the daemon
            _log(f"TTS error: {e}")
            print(f"{MARKER}:error", flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
