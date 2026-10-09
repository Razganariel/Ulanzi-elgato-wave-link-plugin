# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## 1.0.0 - 2026-10-09

First release.

### English

**Added**

- Seven actions for an Ulanzi D200X, bound to Elgato Wave Link channels and mixes:
  `Channel Mute`, `Channel Volume`, `Channel Volume Up`, `Channel Volume Down`,
  `Mix Volume`, `Mix Mute` and `Connect`.
- Two encoder actions. `Channel Volume` and `Mix Volume` take a rotation to set the
  level and a press to toggle the mute. The other five are keypad actions.
- **Scope**: every action is bound either to a channel, or to that channel *within* one
  mix. Wave Link keeps the two independent, so muting the Stream Mix junction of a
  channel does not mute that channel everywhere.
- Forced `mute` and forced `unmute` on the two mute keys, in addition to `toggle`.
- `step`, `minimum` and `maximum` on the four volume actions. All four apply the same
  bounds, so a channel capped on one key cannot be pushed past that cap from another.
- Twelve SVG icons, one resting face per action plus a muted face where the action can
  mute.
- Frame tracing, off by default. One line in `service/core/trace.js` turns it on.
- A README in English and French.

**Compatibility**

- Elgato Wave Link 3.x, tested on 3.3.0 (build 4529).
- Ulanzi Studio 3.0.11 or newer, which is the floor declared in the manifest.
- Ulanzi Studio 3.3.0 or newer for an **encoder's icon** to follow mute. On an earlier
  version the encoder display commands fail and are swallowed: the action still works
  and the neighbouring key keeps showing its state, but the encoder icon is missing.
- Node.js 20 or newer to build. No native dependency — everything goes through Wave
  Link's local WebSocket.
- Windows.

**Known limitations**

- A key drives a single channel or mix, and the scope belongs to the key rather than to
  the channel.
- The plugin does not subscribe to VU meters: `subscribeLevelMeter` exists in the client
  but is called by no action.
- `setInputDevice` and `setOutputDevice` are exposed by the client but unused.
- A mix's master fader is only visible by opening the mix's edit view in Wave Link.

### Français

**Ajouté**

- Sept actions pour un Ulanzi D200X, liées aux canaux et mixes d'Elgato Wave Link :
  `Channel Mute`, `Channel Volume`, `Channel Volume Up`, `Channel Volume Down`,
  `Mix Volume`, `Mix Mute` et `Connect`.
- Deux actions d'encodeur. `Channel Volume` et `Mix Volume` prennent une rotation pour
  régler le niveau et une pression pour basculer le mute. Les cinq autres sont des
  actions de touche.
- **Portée** : chaque action est liée soit à un canal, soit à ce canal *dans* un mix
  donné. Wave Link tient les deux indépendantes : muter la jonction Stream Mix d'un
  canal ne met pas ce canal en sourdine partout.
- `mute` forcé et `unmute` forcé sur les deux touches de mute, en plus de `toggle`.
- `pas`, `minimum` et `maximum` sur les quatre actions de volume. Les quatre appliquent
  les mêmes bornes : un canal plafonné sur une touche ne peut pas dépasser ce plafond
  depuis une autre.
- Douze icônes SVG, une face au repos par action plus une face muette là où l'action
  peut muter.
- Traçage des frames, éteint par défaut. Une seule ligne dans
  `service/core/trace.js` l'active.
- Un README en anglais et en français.

**Compatibilité**

- Elgato Wave Link 3.x, testé sur 3.3.0 (build 4529).
- Ulanzi Studio 3.0.11 ou plus récent, le seuil déclaré dans le manifeste.
- Ulanzi Studio 3.3.0 ou plus récent pour que **l'icône d'une molette** suive le mute.
  Sur une version antérieure, les commandes d'affichage d'encodeur échouent et sont
  absorbées : l'action fonctionne toujours et la touche voisine continue d'afficher son
  état, mais l'icône de la molette manque.
- Node.js 20 ou plus récent pour builder. Aucune dépendance native : tout passe par le
  WebSocket local de Wave Link.
- Windows.

**Limites connues**

- Une touche ne pilote qu'un seul canal ou mix, et la portée appartient à la touche
  plutôt qu'au canal.
- Le plugin ne s'abonne pas aux VU-mètres : `subscribeLevelMeter` existe dans le client
  mais n'est appelé par aucune action.
- `setInputDevice` et `setOutputDevice` sont exposés par le client mais inutilisés.
- Le fader master d'un mix n'est visible qu'en ouvrant l'édition du mix dans Wave Link.