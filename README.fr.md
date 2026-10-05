[![Licence](https://img.shields.io/badge/Licence-Apache%202.0-blue.svg)](LICENSE)
[![Signal K](https://img.shields.io/badge/Signal%20K-plugin-0a7ea4.svg)](https://signalk.org)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A5%2020-339933.svg)](https://nodejs.org)
[![GitHub Issues](https://img.shields.io/github/issues/laborima/ocearo-core.svg)](https://github.com/laborima/ocearo-core/issues)
[![Contributions bienvenues](https://img.shields.io/badge/contributions-bienvenues-brightgreen.svg)](CONTRIBUTING.md)

[English 🇬🇧](README.md)

# Ocearo Core

**La voix du bord, pour Signal K.** Ocearo Core est un plugin du serveur Signal K qui veille avec vous : il suit le trafic AIS et vous dit qui doit s'écarter selon le RIPAM, surveille le mouillage, la météo, le moteur et les batteries, conseille le réglage des voiles d'après vos polaires, tient le journal de bord — et le dit à voix haute, en français ou en anglais. Tout tourne à bord, un Raspberry Pi suffit, et il continue de fonctionner sans internet et sans aucun modèle d'IA.

C'est la moitié serveur d'**[Ocearo UI](https://github.com/laborima/ocearo-ui)**, l'affichage de navigation en 3D, et il fonctionne seul avec n'importe quelle installation Signal K.

▶ **En mer (2:33) :** [visite en vidéo en français](https://youtu.be/GkLjk23Sz8k) · [in English](https://youtu.be/YGQM3UipcvU)

| | |
|---|---|
| ![Nous devons nous écarter d'un navire de pêche](https://raw.githubusercontent.com/laborima/ocearo-ui/main/docs/screenshots/colregs.jpg) | ![Veille au mouillage avec la trace d'évitage](https://raw.githubusercontent.com/laborima/ocearo-ui/main/docs/screenshots/anchor.jpg) |
| **Veille anti-collision**, telle qu'annoncée : *« Danger collision : LE PERTUIS à 0,5 milles, CPA 0,1 milles dans 6 minutes. Navire en pêche, à nous de nous écarter, règle 18. Passez derrière lui, en abattant ou en ralentissant. »* | **Veille au mouillage.** Alarme de dérapage, trace d'évitage autour de l'ancre, et un état qui survit à un redémarrage. |

<sub>Captures d'Ocearo UI, qui dessine ce qu'Ocearo Core calcule.</sub>

---

## Sommaire

- [Ce qu'il fait](#ce-quil-fait)
- [Installation](#installation)
- [Voix et IA (facultatives)](#voix-et-ia-facultatives)
- [Configuration](#configuration)
- [API HTTP](#api-http)
- [Données Signal K](#données-signal-k)
- [Développement](#développement)
- [Contribuer](#contribuer) · [Licence](#licence) · [Avertissement](#avertissement-de-navigation)

---

## Ce qu'il fait

### Veille anti-collision — RIPAM / COLREG

Toutes les 15 secondes, pour chaque cible AIS à portée : point de rapprochement maximal (CPA) et délai pour l'atteindre (TCPA), puis qui doit s'écarter selon les règles de barre et de route — les mêmes règles que l'affichage d'Ocearo UI, pour que la voix et l'écran soient toujours d'accord.

- **Qui s'écarte :** rattrapage (règle 13), hiérarchie des navires (règle 18 : voilier, pêche, capacité de manœuvre restreinte — d'après le statut AIS, puis le type de navire ; un voilier au moteur est un navire à propulsion mécanique), deux voiliers (règle 12 : amures d'après le vent réel, navire au vent), routes opposées (règle 14) et routes qui se croisent (règle 15).
- **Que faire, à voix haute :** s'écarter tôt et passer sur l'arrière (règle 16) ; maintenir cap et vitesse, se tenir prêt, puis manœuvrer si l'autre ne le fait pas (règle 17) ; par visibilité réduite, personne n'est privilégié (règle 19).
- Annoncé de nouveau aussitôt que l'action devient plus urgente ; une entrée de journal par cible et par situation.
- Une aide à la veille, jamais une décision : chenaux étroits et dispositifs de séparation du trafic (règles 9–10) ne sont pas modélisés.

### Veille au mouillage — Signal K Anchor API

Mouiller, relever, régler le rayon ou repositionner l'ancre depuis n'importe quel client. Alarme de dérapage et cercle de pré-alerte en notifications Signal K, état conservé entre les redémarrages, et la **trace d'évitage** — les positions que le bateau décrit réellement autour de l'ancre, gardées dans une mémoire bornée et servies aux écrans : un changement de vent ou une ancre qui chasse se voit dans sa forme bien avant l'alarme.

### Bathymétrie SHOM, hors-ligne

Sur les côtes françaises, le plugin télécharge les MNT du [SHOM](https://data.shom.fr) autour du bateau (levés HOMONIM / TANDEM, résolution 5 à 20 m, données ouvertes) dès que le serveur a internet, les convertit une fois, et les sert à tous les écrans du bord en tuiles d'altitude rapportées au zéro hydrographique. En mer, Ocearo UI dessine les fonds en 3D à la marée du moment, sans aucune connexion.

### Météo, moteur et énergie

- **Météo :** vent, rafales et facteur de rafale, état de la mer selon l'échelle OMM, tendance barométrique sur 3 heures, vent contre courant, allure.
- **Pannes :** tension de batterie basse et autonomie restante, surchauffe moteur, pression d'huile basse, entretien dû d'après les heures moteur — avec le conseil qui va avec. Les alarmes moteur de `notifications.propulsion.*` sont annoncées.
- **Briefing de démarrage :** météo, marées, réservoirs, batteries et conseils de voilure, annoncés quelques secondes après le démarrage du plugin.

### Navigation et régate

Conseils de réglage et de prise de ris d'après le vent apparent et la gîte, optimisation du cap et VMG d'après les polaires du bateau, annonces de virement et d'empannage en mode régate, et un point de navigation toutes les 30 minutes (position, vitesse, cap, profondeur, météo).

### Journal de bord

Passe par [`@meri-imperiumi/signalk-logbook`](https://www.npmjs.com/package/@meri-imperiumi/signalk-logbook) s'il est installé ; sinon enregistre son propre fournisseur de ressources Signal K `logbooks` avec un stockage local. Entrées automatiques pour les alertes, les rencontres AIS et les analyses, entrées manuelles, et un journal de carburant.

### À bord

- **Télécommande de pilote :** une manette PlayStation Bluetooth (DualSense ou DualShock) lue par le serveur pilote l'autopilote via `@signalk/signalk-autopilot` — l'embrayage demande un appui d'une seconde, le débrayage est immédiat, et la perte de la manette ne lâche jamais la barre.
- **Ne pas déranger :** couper tout sauf la sécurité, ou tout, pour un moment.
- **Métriques système :** processeur, température, mémoire et stockage du Raspberry Pi qui fait tourner l'ensemble.
- **Modes :** voile, moteur, mouillage, amarré, régate — réglés par Ocearo UI ou l'API, pour que le plugin parle de ce qui compte maintenant.

---

## Installation

### Prérequis

- **Serveur Signal K** 2.x (testé avec la 2.33) sur **Node.js ≥ 20**.
- Facultatif : [Ollama](https://ollama.com) pour les messages rédigés par IA, un moteur de synthèse vocale (voir plus bas), `p7zip-full` pour les archives SHOM (`sudo apt install p7zip-full`).

### Installation depuis les sources

Ocearo Core n'est pas encore dans l'Appstore Signal K. Installez-le dans le serveur depuis un clone :

```bash
git clone https://github.com/laborima/ocearo-core.git ~/ocearo-core
cd ~/.signalk
npm install ~/ocearo-core/plugin
sudo systemctl restart signalk
```

Activez-le ensuite dans **Admin UI → Server → Plugin Config → Océaro Core**. Mise à jour : `git -C ~/ocearo-core pull` puis redémarrage du serveur.

### Plugins Signal K compagnons

Aucun n'est inclus ; sans eux, la fonction correspondante reste simplement muette. Vérifiez qu'ils sont installés **et activés** — un plugin installé mais désactivé ressemble à s'y méprendre à un plugin qui fonctionne dans l'Admin UI.

| Plugin | Fournit | Sans lui |
|--------|---------|----------|
| [`signalk-derived-data`](https://www.npmjs.com/package/signalk-derived-data) | Vent réel et cap vrai (activer `heading`, `angleTrueWater`, `directionTrue`) | Conseils de voilure, polaires et règles entre voiliers sans vent réel |
| [`@meri-imperiumi/signalk-autostate`](https://www.npmjs.com/package/@meri-imperiumi/signalk-autostate) | `navigation.state` | Alertes non priorisées selon l'état ; le bateau est supposé en route |
| [`signalk-tides`](https://www.npmjs.com/package/signalk-tides) | `environment.tide.*` | Pas de marées dans le briefing |
| [`@signalk/set-system-time`](https://www.npmjs.com/package/@signalk/set-system-time) | Horloge système d'après le GPS | Un Raspberry Pi sans pile d'horloge est à l'heure fausse après chaque coupure : marées, jour/nuit et journal la suivent |
| [`@signalk/signalk-autopilot`](https://www.npmjs.com/package/@signalk/signalk-autopilot) | API pilote automatique Signal K v2 | Pas de télécommande de pilote |
| [`@meri-imperiumi/signalk-logbook`](https://www.npmjs.com/package/@meri-imperiumi/signalk-logbook) | Journal de bord partagé | Le journal local est utilisé à la place |

---

## Voix et IA (facultatives)

Tout fonctionne sans elles : alertes et analyses retombent sur des messages types, affichés dans Ocearo UI et consignés au journal.

### Voix

| Moteur | Qualité | Installation |
|--------|---------|--------------|
| `kokoro` (par défaut) | Naturelle, français et anglais, à l'aise sur un Raspberry Pi 5 | Environnement Python dans `/opt/kokoro`, voir ci-dessous |
| `piper` | Bonne, rapide | Binaire [Piper](https://github.com/rhasspy/piper) et un modèle de voix |
| `espeak` | Robotique, minuscule | `sudo apt install espeak` |
| `console` | Texte dans le journal du serveur | — |

Kokoro, avec le script fourni dans ce dépôt :

```bash
sudo mkdir -p /opt/kokoro && sudo chown "$USER" /opt/kokoro
python3 -m venv /opt/kokoro/venv
/opt/kokoro/venv/bin/pip install kokoro-onnx soundfile
cp ~/ocearo-core/scripts/ocearo-tts.py /opt/kokoro/
cd /opt/kokoro
wget https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.int8.onnx
wget https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
echo "Bonjour, ici Ocearo" | /opt/kokoro/venv/bin/python3 /opt/kokoro/ocearo-tts.py --lang fr-fr --voice ff_siwis   # nécessite aplay (alsa-utils)
```

Le modèle reste chargé entre deux phrases : les annonces partent sans délai.

### Messages IA (Ollama)

Avec [Ollama](https://ollama.com) sur le serveur du bord ou une autre machine à bord, alertes, briefings et entrées de journal sont rédigés par un petit modèle local, dans la personnalité choisie (*professional*, *jarvis*, *friend*, *sea dog*). Rien ne quitte le bateau.

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull gemma3n:e2b        # par défaut ; gemma3:1b ou qwen3:1.7b sur un Raspberry Pi 4
```

Les faits — la règle, qui s'écarte, les chiffres — sont toujours établis par le plugin ; le modèle ne fait que les formuler.

---

## Configuration

Dans **Admin UI → Plugin Config → Océaro Core**. Les réglages principaux :

| Réglage | Défaut | Description |
|---------|--------|-------------|
| `language` | `fr` | `en` ou `fr` |
| `personality` | `jarvis` | `professional`, `jarvis`, `friend`, `sea dog` |
| `boat` | `dufour310gl` | Profil du bateau (polaires, tirant d'eau) dans `plugin/config/boats/` |
| `mode` | `sailing` | Mode au démarrage |
| `llm.enabled` · `llm.ollamaHost` · `llm.model` | `true` · `http://localhost:11434` · `gemma3n:e2b` | Messages IA |
| `voice.enabled` · `voice.backend` | `true` · `kokoro` | Voix ; `voice.kokoroVoiceEn` / `kokoroVoiceFr`, `voice.piper.*` |
| `ais.enabled` | `true` | Veille anti-collision |
| `ais.dangerCPA` · `cautionCPA` · `watchCPA` | `0.25` · `0.5` · `1.0` NM | Seuils de CPA |
| `ais.maxRange` · `ais.maxTCPA` | `5` NM · `30` min | Cibles prises en compte |
| `ais.announceCooldownMinutes` | `5` | Avant de réannoncer une cible au même niveau d'urgence |
| `anchor.defaultRadius` · `watchRadiusPercent` | `30` m · `80` % | Alarme de dérapage et pré-alerte |
| `bathymetry.enabled` · `autoDownload` · `radiusNm` | `true` · `true` · `30` | MNT SHOM autour du bateau (100 à 150 Mo chacun, téléchargés une fois) |
| `startupAnalysis.enabled` | `true` | Briefing vocal au démarrage |
| `schedules.alertCheck` · `sailAnalysis` · `aisCheck` · `weatherUpdate` | `30` · `120` · `15` · `300` s | Fréquence de chaque analyse |
| `controller.enabled` · `engageHoldMs` | `true` · `1000` | Télécommande de pilote |

La liste complète, avec les descriptions, est dans l'Admin UI et dans [`plugin/schema.json`](plugin/schema.json).

---

## API HTTP

Sous `/plugins/ocearo-core/`. Débit limité par client : 120 requêtes/min, 10/min pour les analyses, 20/min pour la parole.

| Point d'accès | Méthode | |
|---------------|---------|---|
| `/health` · `/status` | GET | État des composants ; mode, météo, mouillage, journal utilisé |
| `/analyze` | POST | `{ type }` : `weather`, `sail`, `alerts`, `ais`, `status`, `logbook`, `route`, `racing`, `briefing` |
| `/speak` | POST | `{ text, priority }` |
| `/mode` | POST | `{ mode }` |
| `/dnd` | GET / POST | Ne pas déranger : `{ mode: 'off' \| 'safety' \| 'all', durationMinutes }` |
| `/system/metrics` | GET | Processeur, température, mémoire, stockage de l'hôte |
| `/navigation/anchor/drop` · `raise` · `radius` · `reposition` | POST | Signal K Anchor API |
| `/navigation/anchor` · `/status` · `/track` | GET | État, statut, trace d'évitage (`?limit=N`) |
| `/bathymetry/tiles/:z/:x/:y.png` | GET | Tuile d'altitude Terrarium, zéro hydrographique (404 hors levé) |
| `/bathymetry/status` · `download` · `import` · `regions/:id` | GET · POST · POST · DELETE | MNT SHOM à bord |
| `/logbook/all-entries` · `entries` · `stats` · `backend` | GET | Journal de bord |
| `/logbook/add-entry` · `entry` · `analyze` | POST | Entrée manuelle, entrée IA, analyse |
| `/logbook/fuel` | GET / POST | Journal de carburant |
| `/memory` · `/memory/stats` · `/memory/context` | GET · GET · POST | Mémoire du voyage, destination |
| `/api/controller/config` · `state` | GET / PUT · GET | Télécommande de pilote |
| `/llm/test` | POST | Essayer le modèle d'IA |

---

## Données Signal K

**Lit** les chemins standard : `navigation.*` (position, SOG/COG, cap, vitesse surface, assiette, état, loch, route et prochain waypoint), `environment.*` (vent dont rafales, profondeur, courant, pression, température et humidité extérieures, marée), `electrical.batteries.*`, `propulsion.*`, `tanks.*`, les cibles AIS de `vessels.*` (position, route, vitesse, statut de navigation, type et dimensions) et toutes les `notifications.*`.

**Publie** `navigation.anchor.*` (position, rayon, longueur de mouillage) et les notifications `notifications.navigation.anchor.drag` (urgence), `…anchor.watch` (avertissement), `…anchor.modeChange`, ainsi que ses propres `notifications.ocearo.*`.

---

## Développement

```bash
git clone https://github.com/laborima/ocearo-core.git
cd ocearo-core/plugin
npm install
npm test           # node --test
npm run lint       # ESLint 10
```

Aucune dépendance à l'exécution : uniquement les modules intégrés de Node.js et l'API du serveur Signal K. Organisation du code :

```
plugin/
├── index.js              point d'entrée, routes HTTP, limitation de débit
├── schema.json           réglages de l'Admin UI
├── config/               profils de bateaux, traductions (en, fr)
├── src/
│   ├── analyses/         ais, colregs, meteo, failure, sailsettings, sailcourse, racing, route, alert
│   ├── anchor/           Anchor API, alarme de dérapage, état persistant
│   ├── bathymetry/       catalogue SHOM, grilles, tuiles, encodeur PNG
│   ├── brain/            orchestrateur : planification, modes, briefing, ne pas déranger
│   ├── controller/       manette PlayStation → pilote automatique
│   ├── dataprovider/     Signal K, météo, marées
│   ├── llm/ voice/       client Ollama, moteurs de synthèse vocale
│   ├── logbook/ memory/  journal (relais ou stockage local), mémoire du voyage
│   └── system/           métriques de l'hôte
└── test/                 suites node:test
```

Plus de détails dans [docs/](docs/) : [architecture](docs/ARCHITECTURE.md), [configuration](docs/CONFIGURATION.md), [installation](docs/docs/INSTALLATION.md).

---

## Contribuer

Rapports de bugs, idées, traductions et pull requests sont les bienvenus — lisez [CONTRIBUTING.md](CONTRIBUTING.md) et ouvrez une [issue](https://github.com/laborima/ocearo-core/issues). Bonnes premières contributions : une nouvelle langue dans `plugin/config/locales/`, un profil de bateau avec ses polaires dans `plugin/config/boats/`, ou un test pour une analyse. Les changements sont listés dans le [CHANGELOG](CHANGELOG.md).

[![Buy Me A Coffee](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://www.buymeacoffee.com/laborima)

## Licence

[Apache 2.0](LICENSE). Données SHOM sous Licence Ouverte Etalab 2.0.

## Avertissement de navigation

Ocearo Core aide à la veille ; ce **n'est pas un système de navigation ou de sécurité certifié** et il ne doit pas être la seule source d'information de navigation. L'AIS ne montre pas tous les navires, et ses conseils sur les règles de barre sont une aide, pas une décision. Maintenez une veille attentive, recoupez avec les cartes officielles et les instruments, et respectez la réglementation. Les auteurs déclinent toute responsabilité pour les incidents liés à son utilisation.
