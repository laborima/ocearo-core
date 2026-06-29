Tu es un expert Node.js et Python. Je veux que tu modifies le plugin ocearo-core 
(Signal K) pour remplacer Piper TTS par Kokoro-ONNX et changer le modèle LLM.

Le dépôt est : https://github.com/laborima/ocearo-core
Les fichiers à modifier sont dans plugin/src/voice/index.js, plugin/schema.json, 
et la config Ollama.

## TÂCHE 1 — Créer /opt/kokoro/ocearo-tts.py

Crée ce fichier Python sur le système :
```python
#!/opt/kokoro/venv/bin/python3
import sys, argparse, subprocess, tempfile, os
import soundfile as sf
from kokoro_onnx import Kokoro

MODEL_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL  = os.path.join(MODEL_DIR, "kokoro-v1.0.int8.onnx")
VOICES = os.path.join(MODEL_DIR, "voices-v1.0.bin")

parser = argparse.ArgumentParser()
parser.add_argument("--lang",  default="en-us")
parser.add_argument("--voice", default="af_heart")
parser.add_argument("--speed", type=float, default=1.0)
args = parser.parse_args()

text = sys.stdin.read().strip()
if not text:
    sys.exit(0)

kokoro = Kokoro(MODEL, VOICES)
samples, sr = kokoro.create(text, voice=args.voice, speed=args.speed, lang=args.lang)

with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
    tmp = f.name
try:
    sf.write(tmp, samples, sr)
    subprocess.run(["aplay", "-q", tmp], check=True)
finally:
    os.unlink(tmp)
```

## TÂCHE 2 — Modifier plugin/src/voice/index.js

Lis le fichier existant. Trouve le code qui gère le backend TTS 
(là où "piper" et "espeak" sont traités). Ajoute un nouveau backend "kokoro" 
qui fait exactement la même chose que piper (spawn d'un subprocess) mais appelle :

  spawn('/opt/kokoro/venv/bin/python3', [
    '/opt/kokoro/ocearo-tts.py',
    '--lang',  <'fr-fr' si config.language==='fr' sinon 'en-us'>,
    '--voice', <config.voice.kokoroVoiceFr || 'ff_siwis' si FR, sinon config.voice.kokoroVoiceEn || 'af_heart'>,
    '--speed', String(config.voice.kokoroSpeed || 1.0)
  ])

Passe le texte sur stdin du process. Garde la même gestion d'erreurs que piper.

## TÂCHE 3 — Modifier plugin/schema.json

Dans la section de configuration "voice", ajoute ces propriétés :
- kokoroVoiceEn : string, default "af_heart"  
- kokoroVoiceFr : string, default "ff_siwis"
- kokoroSpeed   : number, default 1.0

Et dans l'enum du champ "backend", ajoute "kokoro" en première position 
et change le default à "kokoro".

## TÂCHE 4 — Modifier la valeur par défaut du modèle LLM

Dans plugin/schema.json, trouve le champ "model" (Ollama model name) 
et change son default de "llama3.2:3b" à "qwen3:1.7b".

## CONTRAINTES
- Ne casse rien d'existant. Piper et espeak doivent continuer à fonctionner.
- Fais un backup de chaque fichier modifié avant de le changer (.bak).
- Montre-moi chaque diff avant d'appliquer.


--- 

Lis d'abord ces fichiers avant de faire quoi que ce soit :
- plugin/src/voice/index.js
- plugin/schema.json

Ensuite effectue ces 4 modifications :

---

**1. Nouveau fichier : /opt/kokoro/ocearo-tts.py**
Crée ce fichier Python (il sera déposé sur le RPi, pas dans le repo) :

#!/opt/kokoro/venv/bin/python3
import sys, argparse, subprocess, tempfile, os
import soundfile as sf
from kokoro_onnx import Kokoro

MODEL_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL  = os.path.join(MODEL_DIR, "kokoro-v1.0.int8.onnx")
VOICES = os.path.join(MODEL_DIR, "voices-v1.0.bin")

parser = argparse.ArgumentParser()
parser.add_argument("--lang",  default="en-us")
parser.add_argument("--voice", default="af_heart")
parser.add_argument("--speed", type=float, default=1.0)
args = parser.parse_args()

text = sys.stdin.read().strip()
if not text: sys.exit(0)

kokoro = Kokoro(MODEL, VOICES)
samples, sr = kokoro.create(text, voice=args.voice, speed=args.speed, lang=args.lang)

with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
    tmp = f.name
try:
    sf.write(tmp, samples, sr)
    subprocess.run(["aplay", "-q", tmp], check=True)
finally:
    os.unlink(tmp)

Sauvegarde ce fichier dans le repo sous scripts/ocearo-tts.py pour qu'il
soit versionné et déployable.

---

**2. plugin/src/voice/index.js**
Trouve le bloc qui gère les backends piper et espeak. Calque-toi exactement
sur la logique piper (spawn + stdin) pour ajouter un case "kokoro" :

- Commande : spawn('/opt/kokoro/venv/bin/python3', ['/opt/kokoro/ocearo-tts.py', ...args])
- --lang  : 'fr-fr' si config.language === 'fr', sinon 'en-us'
- --voice : config.voice?.kokoroVoiceFr ?? 'ff_siwis'  (si FR)
            config.voice?.kokoroVoiceEn ?? 'af_heart'  (si EN)
- --speed : String(config.voice?.kokoroSpeed ?? 1.0)
- Passe le texte sur proc.stdin puis ferme avec .end()
- Même gestion d'erreurs que piper (stderr → debug log, error event → resolve sans crash)
- Ne touche pas aux cases piper et espeak existants.

---

**3. plugin/schema.json — section voice**
Dans la propriété "backend" : ajoute "kokoro" dans l'enum et mets-le en default.
Ajoute ces 3 nouvelles propriétés dans la section voice :

"kokoroVoiceEn": { "type": "string", "default": "af_heart",
  "title": "Kokoro voice (EN)", 
  "enum": ["af_heart","af_bella","am_adam","am_michael","bf_emma","bm_george"] },
"kokoroVoiceFr": { "type": "string", "default": "ff_siwis",
  "title": "Kokoro voice (FR)" },
"kokoroSpeed":   { "type": "number", "default": 1.0,
  "title": "Speech speed (0.8–1.3)" }

---

**4. plugin/schema.json — modèle LLM**
Trouve le champ "model" (Ollama model name) et change uniquement son "default"
de "llama3.2:3b" en "qwen3:1.7b". Ne touche à rien d'autre.

---

Montre-moi les diffs complets avant d'appliquer. Ne modifie aucun autre fichier.