# ManiView

> **Système de guidage visuel et auditif du cycle ventilatoire sous ventilation mécanique assistée non invasive (MANIV) en radiothérapie externe**

Développé dans le cadre d'un Travail de Fin d'Études de Technologue en Imagerie Médicale — Cliniques universitaires Saint-Luc, Bruxelles.

<img width="1448" height="677" alt="image" src="https://github.com/user-attachments/assets/53257d00-88bc-4aa0-aa6c-fea84a2a14a9" />

---

## Table des matières

- [Contexte clinique](#contexte-clinique)
- [Fonctionnement](#fonctionnement)
- [Démo en ligne](#démo-en-ligne)
- [Structure du projet](#structure-du-projet)
- [Utilisation](#utilisation)
- [Architecture technique](#architecture-technique)
- [Diagrammes UML](#diagrammes-uml)
- [Auteur](#auteur)

---

## Contexte clinique

En radiothérapie externe, la gestion du mouvement respiratoire est un enjeu majeur pour la précision des traitements des tumeurs mobiles. La technique de ventilation mécanique assistée non invasive **(MANIV)**, développée aux Cliniques universitaires Saint-Luc, permet d'obtenir des apnées de 20–30 secondes avec une excellente reproductibilité des mouvements thoraco-abdominaux.

Cependant, des patients traités sous MANIV rapportaient :
- Des difficultés à appréhender la **durée des apnées**
- Des difficultés à **anticiper les phases** du cycle ventilatoire
- Une **hétérogénéité des consignes** délivrées selon les manipulateurs

**ManiView** répond à ces besoins en fournissant une information visuelle et auditive synthétique, standardisée et synchronisée au respirateur.

---

## Fonctionnement

ManiView affiche en temps réel une **barre de progression** représentant le cycle ventilatoire complet, composé de deux phases :

| Phase | Description |
|---|---|
| **Apnée** | Durée configurable (défaut : 30 s). Barre qui progresse de 0% à 70%. Compte à rebours sonore (3-2-1) dans les 3 dernières secondes. |
| **Expiration/Inspiration** | Durée configurable (défaut : 4 500 ms). Barre qui progresse de 70% à 100% avant de recommencer. |

Des **images pictographiques** positionnées au-dessus de la barre indiquent au patient l'action attendue à chaque étape clé du cycle :

- **Inspiration** — en début de cycle
- **Blocage** — pendant l'apnée
- **Expiration** — à la fin de l'apnée

Un **guidage sonore** complète l'information visuelle :
- Son de type "tingle" (bruit blanc filtré) au démarrage de chaque cycle
- Bips progressifs (3–2–1) dans les 3 dernières secondes d'apnée

---

## Démo en ligne

🔗 **[Accéder à ManiView](https://cc-sss.github.io/ManiView/)**

> La démo fonctionne directement dans le navigateur, sans installation. Fonctionne sur tablette et PC.

---

## Structure du projet

```
maniview/
├── index.html                          # Interface principale
├── style.css                           # Styles et mise en page
├── script.js                           # Logique applicative (JavaScript)
├── ImageInspi.png                      # Pictogramme inspiration
├── ImageHold.png                       # Pictogramme apnée (blocage)
├── ImageExpi.png                       # Pictogramme expiration
└── uml/
    ├── class_diagram.puml              # Diagramme de classes
    ├── sequence_diagram_start.puml     # Diagramme de séquence — démarrage
    └── sequence_diagram_operations.puml # Diagramme de séquence — opérations
```

---

## Utilisation

### Paramètres configurables

| Paramètre | Description | Valeur par défaut |
|---|---|---|
| **Durée de l'apnée (s)** | Durée de la phase d'apnée en secondes | 30 s |
| **Temps d'expiration (ms)** | Durée de la phase expiratoire en millisecondes | 4 500 ms |
| **Nudge (ms)** | Incrément de décalage pour la synchronisation | 250 ms |
| **Son activé** | Active/désactive le guidage sonore | Activé |

### Boutons de contrôle

| Bouton | Action |
|---|---|
| **Start** | Lance le cycle ventilatoire avec un démarrage frais |
| **Stop** | Met en pause à la position actuelle |
| **Réinitialiser** | Remet la barre à zéro |
| **Saut → Sortie** | Positionne directement à la phase d'expiration (70%) |
| **- Nudge / + Nudge** | Décale la synchronisation sans redémarrer le cycle |
| **≡** (coin supérieur droit) | Masque/affiche les contrôles (mode patient compact) |

### Lancement local

Aucune installation requise. Il suffit d'ouvrir `index.html` dans un navigateur moderne (Chrome, Firefox, Edge).

> Le son nécessite une première interaction utilisateur (clic sur Start) pour se conformer aux politiques des navigateurs concernant l'API Web Audio.

---

## Architecture technique

ManiView est une **application web pure** (HTML/CSS/JavaScript vanilla), sans dépendance externe ni framework. Elle fonctionne entièrement côté client.

### Composants principaux

L'application est structurée en cinq classes distinctes, orchestrées par un point d'entrée central (`App`) :

| Classe | Rôle |
|---|---|
| `AppConfig` | Constantes de configuration globales (frozen object) |
| `Helpers` | Fonctions utilitaires pures (clamp, format, modulo) |
| `CycleEngine` | Logique du cycle : timing des phases, rollover, nudge temporel |
| `AudioService` | Service audio Web Audio API avec scheduler lookahead |
| `BarRenderer` | Rendu visuel de la barre de progression et des labels |
| `CountdownController` | Overlay du compte à rebours (3-2-1) |
| `UIController` | Gestion du DOM, boutons, inputs et états de l'interface |
| `App` | Orchestrateur principal — gère le cycle de vie complet |

### Synchronisation audio/visuel

La synchronisation entre le rendu visuel (boucle `requestAnimationFrame`) et le guidage sonore (Web Audio API) repose sur deux horloges distinctes :

- **`performance.now()`** — horloge haute résolution pour le rendu visuel
- **`AudioContext.currentTime`** — horloge audio, utilisée pour le scheduling précis des sons

Un mécanisme de **scheduler lookahead** (horizon de 150 ms, tick toutes les 25 ms) permet de planifier les sons en avance, garantissant une synchronisation robuste indépendante des variations de la boucle d'animation.

Le **nudge** permet de décaler les deux horloges simultanément sans interruption du cycle.

---

## Diagrammes UML

Les diagrammes sont disponibles dans le dossier [`uml/`](./uml/) au format PlantUML (`.puml`).

### Diagramme de classes

Représente la structure statique de l'application et les relations entre les composants.

→ [`uml/class_diagram.puml`](./uml/class_diagram.puml)

### Diagramme de séquence — Démarrage

Représente le flux d'initialisation lors du clic sur "Start" : lecture des paramètres, initialisation audio, démarrage du cycle et boucle d'animation.

→ [`uml/sequence_diagram_start.puml`](./uml/sequence_diagram_start.puml)

### Diagramme de séquence — Opérations

Représente les scénarios principaux : Stop, Reset, Saut → Sortie, Nudge, et modification de paramètres en cours de cycle.

→ [`uml/sequence_diagram_operations.puml`](./uml/sequence_diagram_operations.puml)

> Pour visualiser les fichiers `.puml`, vous pouvez utiliser [PlantUML Online](https://www.plantuml.com/plantuml/uml/) ou l'extension [PlantUML pour VS Code](https://marketplace.visualstudio.com/items?itemName=jebbs.plantuml).

---

## Auteur

**Auteur** : Cristina Suriano 3BIM
**Institution** : Haute École Léoanard de Vinci  
**Site clinique** : Cliniques universitaires Saint-Luc, Bruxelles  
**Année académique** : 2025–2026

---

*ManiView — Développé pour améliorer le confort patient et standardiser les pratiques sous ventilation mécanique assistée non invasive en radiothérapie externe.*
