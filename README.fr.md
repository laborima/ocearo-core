[![GitHub Issues](https://img.shields.io/github/issues/laborima/ocearo-core.svg)](https://github.com/laborima/ocearo-core/issues)
[![Contributions welcome](https://img.shields.io/badge/contributions-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![License](https://img.shields.io/badge/License-Apache%202.0-brightgreen.svg)](https://opensource.org/licenses/Apache-2.0)
[![npm version](https://img.shields.io/npm/v/ocearo-core.svg)](https://www.npmjs.com/package/ocearo-core)

[English 🇺🇸](README.md)

# Ocearo Core

**Le Premier Copilote IA de bord pour Signal K**

Ocearo Core est la voix et le cerveau de l'écosystème Ocearo — un plugin Signal K avancé transformant votre navire en un bateau intelligent. En tant que véritable Copilote IA, il offre une surveillance globale, la prédiction de pannes, l'optimisation du réglage des voiles selon les polaires de votre bateau, et une planification de route intelligente. Le tout propulsé par un LLM local (Ollama) et une synthèse vocale, garantissant la confidentialité et un fonctionnement hors ligne.

> *"Just A Rather Very Intelligent System"* — Édition Marine 🚢

---

## **Vue d'ensemble**

Ocearo Core va au-delà des simples tableaux de bord. C'est un Copilote IA intelligent qui :

- 👁️ **Surveille** — Surveillance globale de toutes les données du navire, météo et AIS en temps réel
- 🔮 **Prédit** — Prédiction proactive des pannes et alertes de maintenance avant la casse
- ⛵ **Optimise** — Optimisation du réglage des voiles et de la route par rapport aux performances polaires de votre navire
- 🗺️ **Planifie** — Planification de route intelligente et assistance à la navigation
- 🗣️ **Parle** — Retours vocaux contextuels et alertes via Piper TTS ou eSpeak
- 🧠 **Réfléchit** — Analyse contextuelle approfondie avec un LLM local (Ollama)
- ⚓ **Mouille** — Gestion complète du mouillage avec alarmes de dérapage (Signal K Anchor API)
- 📝 **Journalise** — Journal de bord automatique avec stockage local de secours + journal carburant

**L'écosystème Ocearo :**
- 👀 **Ocearo-UI** — Les yeux (interface visuelle 3D)
- 🗣️ **Ocearo-Core** — La voix (assistant IA, ce plugin)
- 🧠 **Signal K** — Le système nerveux (bus de données)

---

## **Fonctionnalités**

### ⚓ Gestion du Mouillage (Signal K Anchor API)
- Mouiller, relever, repositionner l'ancre via des endpoints REST
- Rayon d'alarme configurable avec détection de dérapage (haversine)
- Notifications Signal K : `notifications.navigation.anchor.drag` (`emergency`) et `notifications.navigation.anchor.watch` (`warn`)
- État de l'ancre persisté — survit aux redémarrages du plugin
- Trace de swing : les positions évaluées par l'alarme de dérapage sont conservées dans un tampon circulaire borné (décimation 1,5 m / 20 s, plafond 720 points) et servies aux clients, pour dessiner le chemin parcouru autour de l'ancre au lieu du seul cercle d'alarme
- Sécurité au changement de mode : avertit si le mode change pendant que l'ancre est mouillée

### 📔 Journal de Bord — Double Backend
- **Principal** : proxy vers `@meri-imperiumi/signalk-logbook` si installé
- **Secours** : s'enregistre comme Resource Provider Signal K (`logbooks`) avec stockage JSON local dans `<dataDir>/ocearo-logbook/`
- Journal carburant toujours stocké localement (`fuel-log.json`) quel que soit le backend
- Entrées enrichies par IA via LLM quand Ollama est disponible

### 🌅 Briefing de Démarrage
- Prévisions météo, horaires des marées, niveaux des réservoirs et batteries
- Résumé vocal au démarrage du plugin

### 📍 Points de Navigation (toutes les 30 min)
- Position, vitesse, cap, profondeur, mise à jour météo

### ⛵ Coaching à la Voile
- Recommandations de réglage des voiles en temps réel
- Optimisation de route avec analyse VMG
- Suggestions de prise de ris selon les conditions

### ⚓ Veille anti-collision (RIPAM / COLREG)
- CPA / TCPA de chaque cible AIS, toutes les 15 s
- Qui doit manœuvrer selon les règles de barre et de route, les mêmes que l'affichage ocearo-ui : rattrapage (13), hiérarchie des navires (18 : voilier, pêche, capacité de manœuvre restreinte, d'après le statut AIS ou le type ; un voilier au moteur est un navire à propulsion mécanique), deux voiliers (12 : amures d'après le vent réel, navire au vent), routes opposées (14), routes croisées (15)
- Ce qu'il faut faire, annoncé à la voix : manœuvrer tôt et passer derrière (16), maintenir cap et vitesse, se tenir prêt, puis manœuvrer si l'autre ne le fait pas (17), aucun navire privilégié par visibilité réduite (19)
- Répété aussitôt que l'action devient plus urgente ; une entrée de journal par cible et par situation
- Une aide à la veille, jamais une décision : ni chenaux étroits ni dispositifs de séparation du trafic (règles 9–10)

### 🚨 Alertes Intelligentes
- Intercepte toutes les notifications Signal K
- Explications contextuelles par LLM
- Alertes critiques annoncées par synthèse vocale
- Surveillance des alarmes moteur (`notifications.propulsion.*`)

### 🎭 Personnalités et Modes
- **Personas** : Capitaine, Équipier, Jarvis, Marin Français
- **Modes** : `sailing`, `anchored`, `motoring`, `moored`, `racing`
- **Langues** : Anglais, Français (extensible)

---

## **Architecture**

```
plugin/
├── index.js                  # Point d'entrée, routeur Express, middleware de sécurité
├── schema.json               # Schéma de configuration Admin UI
└── src/
    ├── anchor/
    │   ├── anchor-state.js   # Machine à états (raised/dropping/dropped/raising)
    │   ├── anchor-alarm.js   # Détection de dérapage + notifications SK
    │   └── anchor-plugin.js  # Endpoints REST + registerWithRouter
    ├── analyses/
    │   ├── alert.js          # Analyse des alertes
    │   ├── ais.js            # Détection de collision AIS
    │   ├── meteo.js          # Analyse météo
    │   ├── sailcourse.js     # Optimisation de route
    │   └── sailsettings.js   # Recommandations de réglage voiles
    ├── brain/
    │   └── index.js          # OrchestratorBrain — planification, mode, statut
    ├── config/
    │   └── index.js          # ConfigManager + i18n
    ├── dataprovider/
    │   ├── signalk.js        # SignalKDataProvider
    │   ├── marineweather.js  # Fournisseur météo
    │   └── tides.js          # Fournisseur marées
    ├── llm/
    │   └── index.js          # LLMClient (Ollama)
    ├── logbook/
    │   ├── index.js          # LogbookManager (double backend)
    │   └── logbook-store.js  # Stockage JSON local + Resource Provider
    ├── memory/
    │   └── index.js          # MemoryManager
    └── voice/
        └── index.js          # VoiceModule (Piper / eSpeak / console)
```

### Flux de Données

```
Bus de données Signal K
      │
      ▼
SignalKDataProvider ──► OrchestratorBrain ──► LLMClient (Ollama)
      │                       │                     │
      │                  Analyseurs            VoiceModule
      │                       │                (Piper TTS)
      │                  LogbookManager
      │                 (SK logbook / stockage local)
      │
      ▼
AnchorPlugin ──► AnchorAlarm ──► Notifications SK
             └─► AnchorState (persisté)
```

---

## **Installation**

### Prérequis

- **Signal K Server** ≥ 1.x
- **Node.js** ≥ 20
- **Ollama** (optionnel, pour le LLM) — [Installer Ollama](https://ollama.ai)
- **Piper TTS** (optionnel, pour la voix) — [Installer Piper](https://github.com/rhasspy/piper)

#### Plugins Signal K compagnons

Aucun n'est embarqué ; sans eux la fonction correspondante est simplement inerte. Il vaut donc la peine de vérifier qu'ils sont installés **et activés** — un plugin installé mais jamais configuré est indiscernable d'un plugin qui marche dans l'Admin UI :

| Plugin | Rôle | Sans lui |
|--------|------|----------|
| [`@meri-imperiumi/signalk-autostate`](https://www.npmjs.com/package/@meri-imperiumi/signalk-autostate) | Publie `navigation.state` | Les alertes ne sont jamais hiérarchisées selon l'état de navigation et les analyses LLM ne se mettent jamais en pause à quai — le bateau est supposé en route |
| [`signalk-derived-data`](https://www.npmjs.com/package/signalk-derived-data) | Calcule le vent vrai et le cap vrai à partir du vent apparent et de la vitesse surface | `environment.wind.speedTrue`, `angleTrueWater`, `directionTrue` et `navigation.headingTrue` sont absents ; le coaching de voiles et l'analyse polaire n'ont rien à exploiter. Activer les calculs `heading`, `angleTrueWater` et `directionTrue` |
| [`@signalk/set-system-time`](https://www.npmjs.com/package/@signalk/set-system-time) | Recale l'horloge système sur `navigation.datetime` (GPS) | Sur une machine sans RTC sauvegardée par pile — un Raspberry Pi 5 sorti de sa boîte — l'heure est fausse après chaque coupure sans internet, et marées, jour/nuit et tri du journal suivent |
| [`@signalk/signalk-autopilot`](https://www.npmjs.com/package/@signalk/signalk-autopilot) | Fournit l'API pilote automatique v2 | La vue pilote n'a aucun appareil à qui parler. Un pilote présent sur le bus NMEA2000 publie tout de même `steering.autopilot.state`, ce qui fait passer l'absence pour un pilote au repos plutôt que pour un fournisseur manquant |

### Installation via npm

```bash
npm install ocearo-core
```

Redémarrez Signal K et configurez via **Admin UI → Server → Plugin Config → Océaro Core**.

### Installation depuis les sources

```bash
cd ~/.signalk/node_modules
git clone https://github.com/laborima/ocearo-core.git
cd ocearo-core/plugin
npm install
```

---

## **Configuration**

### Général

| Paramètre | Description | Défaut |
|-----------|-------------|--------|
| `language` | Langue de l'interface (`en`/`fr`) | `en` |
| `persona` | Personnalité de l'IA | `jarvis` |
| `mode` | Mode de navigation | `sailing` |

### Mouillage

| Paramètre | Description | Défaut |
|-----------|-------------|--------|
| `anchor.defaultRadius` | Rayon d'alarme en mètres | `30` |
| `anchor.watchRadiusPercent` | Seuil de surveillance (% du rayon) | `80` |
| `anchor.positionUpdateInterval` | Intervalle de vérification (ms) | `2000` |

### LLM (Ollama)

| Paramètre | Description | Défaut |
|-----------|-------------|--------|
| `ollamaHost` | URL du serveur Ollama | `http://localhost:11434` |
| `model` | Nom du modèle | `llama3.2:3b` |
| `timeoutSeconds` | Délai d'attente | `30` |

### Voix

| Paramètre | Description | Défaut |
|-----------|-------------|--------|
| `voice.enabled` | Activer la synthèse vocale | `true` |
| `voice.backend` | Moteur (`piper`/`espeak`/`console`) | `piper` |
| `voice.piperModel` | Modèle de voix Piper | `fr_FR-tom-medium` |

### Planification

| Paramètre | Description | Défaut |
|-----------|-------------|--------|
| `schedules.alertCheck` | Vérification alertes (secondes) | `30` |
| `schedules.weatherUpdate` | Mise à jour météo (secondes) | `300` |
| `schedules.navPointMinutes` | Point de navigation (minutes) | `30` |

---

## **Endpoints API**

Tous les endpoints sont sous `/plugins/ocearo-core/`. Des limites de débit s'appliquent (120 req/min général, 10/min pour les opérations IA).

### Système

| Endpoint | Méthode | Description |
|----------|---------|-------------|
| `/health` | GET | Vérification de l'état des composants |
| `/status` | GET | Statut système complet (mode, météo, ancre, backend journal) |
| `/analyze` | POST | Déclencher une analyse IA (`weather`, `sail`, `alerts`, `ais`, `status`, `logbook`, `route`) |
| `/speak` | POST | Synthèse vocale avec texte personnalisé (`{ text, priority }`) |
| `/mode` | POST | Changer le mode de navigation (`{ mode }`) |

### Mémoire

| Endpoint | Méthode | Description |
|----------|---------|-------------|
| `/memory` | GET | Contexte et statistiques mémoire |
| `/memory/stats` | GET | Statistiques uniquement |
| `/memory/context` | POST | Mettre à jour les infos navire / destination |

### Journal de Bord

| Endpoint | Méthode | Description |
|----------|---------|-------------|
| `/logbook/all-entries` | GET | Toutes les entrées (proxy ou local) |
| `/logbook/entries` | GET | Entrées d'analyse uniquement |
| `/logbook/add-entry` | POST | Ajouter une entrée manuelle |
| `/logbook/entry` | POST | Générer une entrée enrichie par IA depuis les données navire |
| `/logbook/entry` | GET | Récupérer les entrées IA récentes (`?limit=50`) |
| `/logbook/analyze` | POST | Analyse IA complète du journal |
| `/logbook/stats` | GET | Statistiques d'analyse |
| `/logbook/fuel` | GET | Entrées du journal carburant |
| `/logbook/fuel` | POST | Ajouter un enregistrement de plein |
| `/logbook/backend` | GET | Backend actif (`signalk-logbook` ou `local`) |

### Mouillage (Signal K Anchor API)

| Endpoint | Méthode | Description |
|----------|---------|-------------|
| `/navigation/anchor/drop` | POST | Mouiller l'ancre à la position actuelle |
| `/navigation/anchor/raise` | POST | Relever l'ancre |
| `/navigation/anchor/radius` | POST | Définir le rayon d'alarme `{ value: mètres }` |
| `/navigation/anchor/reposition` | POST | Repositionner `{ rodeLength, anchorDepth }` |
| `/navigation/anchor/status` | GET | Statut simplifié |
| `/navigation/anchor/track` | GET | Trace de swing enregistrée, `?limit=N` pour les N derniers points |
| `/navigation/anchor` | GET | Snapshot complet de l'état de l'ancre (trace incluse) |

### LLM

| Endpoint | Méthode | Description |
|----------|---------|-------------|
| `/llm/test` | POST | Tester le LLM avec une invite personnalisée |

---

## **Chemins Signal K**

### Souscriptions (Entrée)
- `navigation.position`, `navigation.speedOverGround`, `navigation.courseOverGroundTrue`
- `navigation.headingTrue`, `environment.depth.belowKeel`
- `environment.wind.speedApparent`, `environment.wind.angleApparent`
- `notifications.*`

### Publications (Sortie)
- `notifications.navigation.anchor.drag` — alarme de dérapage (`emergency`)
- `notifications.navigation.anchor.watch` — approche de la limite (`warn`)
- `notifications.navigation.anchor.modeChange` — mode changé pendant le mouillage
- `navigation.anchor.position` — position de mouillage
- `navigation.anchor.currentRadius` — rayon d'alarme actif
- `navigation.anchor.maxRadius` — rayon maximum configuré
- `navigation.anchor.rodeLength` — longueur de chaîne

---

## **Configuration des Dépendances**

### Ollama (LLM)

```bash
# Installer Ollama
curl -fsSL https://ollama.ai/install.sh | sh

# Télécharger un modèle
ollama pull llama3.2:3b

# Démarrer le serveur
ollama serve
```

### Piper TTS

```bash
# Télécharger le binaire depuis https://github.com/rhasspy/piper/releases

# Voix française
wget https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/tom/medium/fr_FR-tom-medium.onnx

# Voix anglaise
wget https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/joe/medium/en_US-joe-medium.onnx
```

### eSpeak (TTS de secours)

```bash
# Debian/Ubuntu
sudo apt-get install espeak

# macOS
brew install espeak
```

---

## **Intégration avec Ocearo-UI**

Ocearo Core est conçu pour fonctionner de manière transparente avec [Ocearo-UI](https://github.com/laborima/ocearo-ui) :

- Les contrôles du mouillage appellent les endpoints `/navigation/anchor/*`
- Le journal carburant utilise `/logbook/fuel` avec repli sur `/logbook/add-entry`
- Les analyses IA sont déclenchées via `/analyze` avec les types `weather`, `sail`, `alerts`, `ais`, `status`, `logbook`, `route`
- Les alarmes moteur sont lues depuis les chemins Signal K `notifications.propulsion.*`
- Les changements de mode sont propagés via l'endpoint `/mode`

---

## **Sécurité**

- **Limitation de débit** — limiteur par IP intégré (sans dépendance externe) :
  - Général : 120 req/min
  - Opérations IA (`/analyze`, `/logbook/entry`, `/llm/test`) : 10/min
  - Synthèse vocale (`/speak`) : 20/min
- **Sanitisation des entrées** — caractères de contrôle supprimés, longueurs limitées
- **Validation JSON** — tous les corps POST validés avant traitement
- **Catch-all 404** — routes inconnues retournent des erreurs JSON structurées

---

## **Contribuer**

- 🐛 **Signaler des bugs** — Ouvrir une issue
- 💡 **Suggérer des fonctionnalités** — Partager vos idées
- 🔧 **Soumettre des PRs** — Corriger des bugs, ajouter des fonctionnalités
- 🌍 **Traduire** — Ajouter le support de nouvelles langues

[![Buy Me A Coffee](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://www.buymeacoffee.com/laborima)

Voir [CONTRIBUTING.md](CONTRIBUTING.md) pour les directives.

---

## **Feuille de Route**

- [ ] Langues supplémentaires (Espagnol, Allemand, Italien)
- [ ] Fournisseurs météo supplémentaires (NOAA, Météo-France)
- [ ] Analyse polaire avancée
- [ ] Commandes vocales (reconnaissance vocale)
- [ ] Intégration autopilote
- [ ] Apprentissage automatique pour des conseils de navigation personnalisés

---

## **Licence**

Apache License 2.0 — voir [LICENSE](LICENSE).

---

## **Remerciements**

- [Signal K](https://signalk.org) — Standard ouvert de données marines
- [Ollama](https://ollama.ai) — Runtime LLM local
- [Piper](https://github.com/rhasspy/piper) — Synthèse vocale locale rapide
- [Ocearo-UI](https://github.com/laborima/ocearo-ui) — Interface marine 3D
- [OpenPlotter](https://openplotter.readthedocs.io) — Plateforme de navigation open source

---

## Avertissement de Navigation

⚠ Utiliser avec précaution – Ne remplace pas les systèmes de navigation officiels.

Ocearo Core est conçu pour améliorer la conscience situationnelle et fournir une assistance intelligente. Cependant, ce logiciel n'est pas un système de navigation ou de sécurité certifié et ne doit pas être utilisé comme seule source d'information de navigation.

- Vérifiez toujours les données avec les cartes marines officielles, les appareils GPS et autres aides à la navigation.
- Gardez une conscience situationnelle et suivez les règles de sécurité maritime.
- Les développeurs d'Ocearo Core ne sont pas responsables des incidents, accidents ou erreurs de navigation liés à l'utilisation de ce logiciel.

En utilisant Ocearo Core, vous acceptez les risques inhérents à l'utilisation d'outils de navigation non certifiés. Naviguez de manière responsable !

---

## **Support**

- 📖 [Documentation](docs/)
- 🐛 [Suivi des issues](https://github.com/laborima/ocearo-core/issues)
- 💬 [Discussions](https://github.com/laborima/ocearo-core/discussions)
