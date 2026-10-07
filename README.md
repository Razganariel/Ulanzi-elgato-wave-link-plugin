# Elgato Wave Link Control — plugin Ulanzi D200X

Pilote les canaux audio et les mixes d'**Elgato Wave Link** depuis un Stream Deck
Ulanzi **D200X**. Chaque touche est liée à un canal ou à un mix choisi dans son
inspecteur de propriétés.

Testé sur Wave Link **3.3.0 (build 4529)** et Ulanzi Studio 3.x, sous Windows.

---

## 1. Actions

| Action | Contrôle | Rotation | Pression |
|---|---|---|---|
| **Channel Mute** | Touche | — | Bascule le mute du canal |
| **Channel Volume** | Encodeur | Volume du canal (ou du canal **dans** le mix sélectionné) | Bascule le mute du canal |
| **Channel Volume Up** | Touche | — | +1 pas |
| **Channel Volume Down** | Touche | — | −1 pas |
| **Mix Volume** | Encodeur | Fader master du mix | Bascule le mute du mix |
| **Mix Mute** | Touche | — | Bascule le mute du mix |
| **Connect** | Touche | — | (re)connecte et rafraîchit la liste |

Les actions *mute* proposent trois comportements : `toggle`, `mute` forcé,
`unmute` forcé.

### Qui écrit le titre d'une touche

**L'hôte, et rien d'autre.**

Le plugin n'écrit aucun texte : pas de `setTitle`, pas de champ `title` dans les
inspecteurs, et surtout pas de texte dynamique. Un encodeur reçoit uniquement son
icône, via le layout `setFeedback` :

```js
$UD.setFeedback(context, { icon: { value: 'images/action-channel-volume.svg' } });
```

C'était une autre conception, et elle avait deux défauts. Le plugin composait le nom
du canal ou du mix, l'envoyait en `title`, ce qui **écrasait** la saisie du champ
Titre d'Ulanzi Studio ; et comme Wave Link notifie à chaque variation de niveau,
chaque cran de molette repeignait la touche et le titre ressautait. Le texte qu'on
avait lui-même écrit revenait par-dessus celui qu'on venait de taper.

Le titre est donc la responsabilité de l'hôte, et l'icône la nôtre :

| Élément | Source |
|---|---|
| Titre sous la touche | le champ **Titre** d'Ulanzi Studio |
| Titre de la molette | le même champ, affiché par l'hôte |
| Icône | le plugin : l'état mute/unmute de la portée liée |
| Niveau | nulle part |

Aucune de nos listes déroulantes n'affiche un pourcentage. Un encodeur n'a pas à
dire son niveau : c'est ce que montre sa course.

Les noms de canal et de mix n'apparaissent que dans le payload envoyé aux
inspecteurs, où ils servent à remplir les listes déroulantes.

### Deux notions de volume à ne pas confondre

- **Channel Volume** règle le niveau d'un canal. Si un mix est sélectionné dans
  l'inspecteur, il règle le niveau de **ce canal dans ce mix** uniquement
  (`channel.mixes[].level`), pas le niveau global du canal.
- **Mix Volume** règle le fader master d'un mix. Dans Wave Link, ce fader
  n'apparaît qu'en ouvrant l'édition du mix — il n'est pas sur la vue principale.
  C'est le comportement attendu, pas un raté du plugin.

---

## 2. Prérequis

- Elgato Wave Link 3.x ouvert (le plugin se connecte au processus déjà lancé)
- Ulanzi Studio 3.0.11 ou plus récent
- Node.js 20 ou plus récent pour builder le plugin

Aucune dépendance native : tout passe par le WebSocket local de Wave Link.

---

## 3. Connexion

Wave Link expose un serveur JSON-RPC 2.0 sur une boucle locale. Le port est
découvert au démarrage, dans cet ordre :

1. `%LOCALAPPDATA%\Packages\Elgato.WaveLink_g54w8ztgkx496\LocalState\ws-info.json`
   (version Microsoft Store)
2. `%APPDATA%\Elgato\WaveLink\ws-info.json`
3. `%LOCALAPPDATA%\Elgato\WaveLink\ws-info.json`
4. sonde des ports 1884 à 1893

Le plugin se connecte tout seul dès qu'Ulanzi Studio démarre ; l'action
**Connect** sert à forcer une reconnexion et à rafraîchir les listes.

### Surface API utilisée

| Méthode | Usage |
|---|---|
| `getChannels` / `getMixes` | découvrir canaux et mixes |
| `setChannel` | niveau global, mute, et niveau dans un mix (`mixes: [{id, level}]`) |
| `setMix` | fader master du mix, mute du mix |
| `getInputDevices` / `getOutputDevices` | état des périphériques |
| `setSubscription` | abonnement aux Focused App Changes |

Notifications consommées : `channelsChanged`, `channelChanged`, `mixesChanged`,
`mixChanged`, `inputDevicesChanged`, `outputDevicesChanged`, `focusedAppChanged`,
`levelMeterChanged`.

---

## 4. Build

```bash
npm install          # ws, pour les tests
npm run sdk          # télécharge le SDK Ulanzi (une fois)
npm run build        # -> release/com.ulanzi.ulanzistudio.wavelink.ulanziPlugin
npm test
```

Le dossier `release/` est le paquet installable. Copiez son contenu dans :

```
%APPDATA%\Ulanzi\UlanziDeck\Plugins\com.ulanzi.ulanzistudio.wavelink.ulanziPlugin\
```

puis redémarrez Ulanzi Studio.

`npm run release` enchaîne l'installation du SDK et le build.

---

## 5. Arborescence

```
plugin/
  manifest.json          7 actions, UUID com.ulanzi.ulanzistudio.wavelink
  package.json
  images/                10 SVG (une action = une icône lisible)
  property-inspector/    un dossier par action + shared.js / shared.css
  service/
    app.js               point d'entrée : routage des événements hôte
    actions/             les 7 actions
    core/
      constants.js       UUID, limites, pas de volume autorisés
      context.js         bookkeeping des instances d'action
      dial.js            rotation -> nombre de pas
      params.js          lecture des réglages (clampFloat, dialStep)
      registry.js        façade vers Wave Link pour les actions
      trace.js           trace brute des frames, à côté du log hôte
      ui.js              setStateIcon / setEncoderIcon
      wavelink.js        client WebSocket JSON-RPC
scripts/
  build.mjs              assemble le paquet, valide le manifest et le SDK
  install-sdk.mjs        télécharge le SDK Ulanzi
  install-deps.mjs       installe ws sans npm
tests/                   runner natif node:test
```

---

## 6. Tests

```bash
npm test        # node --test tests/*.test.js
```

| Fichier | Couverture |
|---|---|
| `params.test.js` | `clampFloat`, `dialStep` : pas flottants, bornes, valeurs vides |
| `context.test.js` | contextes d'action : ajout, déplacement, suppression, reprise |
| `render.test.js` | contrat du manifest : états, contrôleurs, icônes d'encodeur |
| `registry.test.js` | forme exacte des appels `setChannel` / `setMix` |
| `wavelink.test.js` | framing JSON-RPC, corrélation, fusion des notifications |
| `deps.test.js` | résolveur de dépendances de `install-deps.mjs` |

---

## 7. Débogage

- Log hôte : `%APPDATA%\Ulanzi\UlanziDeck\logs\com.ulanzi.ulanzistudio.wavelink\`
- Trace brute : `com.ulanzi.ulanzistudio.wavelink.trace.log`, dans le même dossier
  (rotation 8 Mo, 2 générations). Contient chaque frame dans les deux sens, ce
  qui est le seul moyen fiable de distinguer « l'hôte n'a rien envoyé » de
  « tout a fonctionné ».
- Inspecteur Node : `--inspect=127.0.0.1:9213` (voir `plugin/manifest.json`).
- Logs client : préfixés `[WaveLink]`.

Si une icône ne change pas après un build, videz le cache d'Ulanzi Studio ou
retirez l'action du deck puis remettez-la.

### Le WebView met les scripts en cache

Les property inspectors tournent dans un WebView qui **met en cache
`property-inspector/shared.js`** alors même qu'il relit le HTML. Conséquence
observée : un correctif de `shared.js` ne prend effet qu'après un nettoyage
manuel du cache, alors que le nouveau champ du formulaire est bien visible.

La parade est un paramètre de version sur la balise `<script>`, à incrémenter
**chaque fois que `shared.js` change** :

```html
<script src="../shared.js?v=2"></script>
```

C'est aussi le premier réflexe si un réglage saisi dans l'inspecteur n'atteint
jamais le service alors que le champ est là.

### Le panneau de propriétés répond, et répond une seule fois

Deux règles se contredisent si on ne les tient pas ensemble, et chacune a coûté un
bug visible.

**Un panneau naît vide.** Il vit dans un WebView que l'hôte recrée à chaque
ouverture. Il se signale par `get-registry`, et c'est ce signal qui force l'envoi :
sans lui, tout payload déjà envoyé est considéré comme connu et le panneau affiche
un statut périmé avec des listes vides.

**Un panneau ne veut que des identifiants et des noms.** Le payload ne doit donc
porter ni `level`, ni `isMuted`, ni icône base64. Un `level` change à chaque cran
de molette, donc le payload différait en permanence et le panneau se reconstruisait
en boucle : c'était le rafraîchissement visible à chaque rotation. Une fois le
payload stable, il peut être comparé avant d'envoi, et une rotation ne produit
plus rien.

Corollaire : **ne répondre qu'au panneau qui demande.** L'hôte livre le message au
panneau ouvert, quel que soit le contexte visé, donc rafraîchir toutes les instances
de la même action empilait trois réponses sur un seul panneau et la dernière
gagnait — trois molettes liées à trois canaux différents affichaient le même.

---

## 8. Limites connues

- Une touche ne peut piloter qu'un seul canal ou mix à la fois
  (`SupportedInMultiActions: false`).
- Le plugin ne subscribe pas aux VU-mètres : `subscribeLevelMeter` existe dans le
  client mais n'est appelé par aucune action.
- `setInputDevice` et `setOutputDevice` sont exposés par le client mais aucune
  action ne s'en sert.
- Le fader master d'un mix n'est visible qu'en ouvrant l'édition du mix dans
  Wave Link.