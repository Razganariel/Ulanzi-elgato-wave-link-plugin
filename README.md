# Elgato Wave Link Control — plugin Ulanzi D200X

Pilote les canaux audio et les mixes d'**Elgato Wave Link** depuis un **Ulanzi D200X**.
Chaque touche est liée à un canal, ou à un canal dans un mix, choisi dans son
inspecteur de propriétés.

Testé sur Wave Link **3.3.0 (build 4529)** et Ulanzi Studio 3.x, sous Windows.

---

## 1. Actions

| Action | Contrôle | Rotation | Pression |
|---|---|---|---|
| **Channel Mute** | Touche | — | Bascule le mute du canal, ou du canal **dans** le mix sélectionné |
| **Channel Volume** | Encodeur | Volume du canal, ou du canal dans le mix sélectionné | Bascule le même mute |
| **Channel Volume Up** | Touche | — | +1 pas |
| **Channel Volume Down** | Touche | — | −1 pas |
| **Mix Volume** | Encodeur | Fader master du mix | Bascule le mute du mix |
| **Mix Mute** | Touche | — | Bascule le mute du mix |
| **Connect** | Touche | — | (re)connecte et rafraîchit la liste |

Chaque action est liée **à un seul** canal ou mix à la fois
(`SupportedInMultiActions: false`).

Les quatre actions *mute* — les deux touches et les deux molettes, la pression d'une
molette en étant une — proposent `toggle` sur une touche dedicated. Les deux touches
`Channel Mute` et `Mix Mute` offrent en plus `mute` forcé et `unmute` forcé.

Les quatre actions de volume proposent les mêmes trois réglages : **pas**, **minimum** et
**maximum**. Les quatre appliquent les mêmes bornes, volontairement : sinon un canal
plafonné à 80 % sur une touche pourrait être poussé à 100 % depuis une autre.

### La portée : un canal, ou un canal dans un mix

Une liaison porte une seule chose : un canal, ou l'un de ses **jonctions** — le canal au
seint d'un mix. Wave Link tient les deux indépendantes, et c'est ce qui rend la jonction
utile :

```
canal seul          ->  le canal lui-même
canal + un mix      ->  seulement ce canal dans ce mix
```

Muter la jonction Stream Mix de « Discord » ne met donc pas « Discord » en sourdine
partout. Les réglages sont stockés **par touche** : la plage et le pas se saisissent sur
chaque touche, comme le canal lui-même.

Cette notion est définie une seule fois, dans `service/core/scope.js`
(`scopeLevel`, `scopeMuted`, `scopeEntry`). Elle avait été réécrite dans quatre modules
qui avaient dérivé — d'où une molette affichant le mute du canal alors que sa pression
ne touchait que la jonction.

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
chaque cran de molette repeignait la touche et le titre ressautait.

| Élément | Source |
|---|---|
| Titre sous la touche | le champ **Titre** d'Ulanzi Studio |
| Titre de la molette | le même champ, affiché par l'hôte |
| Icône | le plugin : l'état mute/unmute de la portée liée |
| Niveau | nulle part |

Aucune de nos listes déroulantes n'affiche un pourcentage. Un encodeur n'a pas à dire
son niveau : c'est ce que montre sa course.

Les noms de canal et de mix n'apparaissent que dans le payload envoyé aux inspecteurs,
où ils servent à remplir les listes déroulantes.

### Deux notions de volume à ne pas confondre

- **Channel Volume** règle le niveau d'un canal. Si un mix est sélectionné dans
  l'inspecteur, il règle le niveau de **ce canal dans ce mix** uniquement
  (`channel.mixes[].level`), pas le niveau global du canal.
- **Mix Volume** règle le fader master d'un mix. Dans Wave Link, ce fader n'apparaît
  qu'en ouvrant l'édition du mix — il n'est pas sur la vue principale. C'est le
  comportement attendu, pas un raté du plugin.

---

## 2. Prérequis

- Elgato Wave Link 3.x ouvert (le plugin se connecte au processus déjà lancé)
- Ulanzi Studio **3.0.11** ou plus récent — le seuil du manifeste
- Ulanzi Studio **3.3.0** ou plus récent pour que **l'icône d'une molette** suive le
  mute. Sur une version antérieure, les commandes d'affichage d'encodeur échouent, sont
  absorbées, et ce qui manque est l'icône de la molette — l'action elle-même fonctionne,
  et la touche voisine continue d'afficher son état
- Node.js 20 ou plus récent pour builder le plugin

Aucune dépendance native : tout passe par le WebSocket local de Wave Link.

---

## 3. Connexion

Wave Link expose un serveur JSON-RPC 2.0 sur une boucle locale. Le port est découvert
au démarrage, dans cet ordre :

1. `%LOCALAPPDATA%\Packages\Elgato.WaveLink_g54w8ztgkx496\LocalState\ws-info.json`
   (version Microsoft Store)
2. `%APPDATA%\Elgato\WaveLink\ws-info.json`
3. `%LOCALAPPDATA%\Elgato\WaveLink\ws-info.json`
4. sonde des ports 1884 à 1893

`ws-info.json` est relu à chaque tentative : Wave Link choisit un port neuf à chaque
démarrage, et lire le fichier une seule fois laisse le plugin déconnecté s'il lit le
port d'une instance déjà arrêtée.

Une fois connecté, le plugin **ne renonce plus** : le délai de reprise monte jusqu'à
30 s puis s'y tient, indéfiniment, jusqu'à l'arrêt de l'hôte. Un programme simplement
pas encore lancé n'est pas une perte définitive.

### Surface API utilisée

| Méthode | Usage |
|---|---|
| `getChannels` / `getMixes` | découvrir canaux et mixes |
| `setChannel` | niveau global, mute, et niveau ou mute dans un mix (`mixes: [{id, level}]`) |
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
  images/                12 SVG (chaque action a une face au repos et, si elle peut
                         muter, une face muette)
  property-inspector/    un dossier par action + shared.js / shared.css
  service/
    app.js               point d'entrée : routage des événements hôte
    actions/             les 7 actions, une par fichier
    core/
      constants.js       UUID, indices d'état, limites, pas autorisés
      context.js         bookkeeping des instances d'action
      dial.js            rotation -> nombre de pas
      params.js          lecture des réglages (clampFloat, dialStep, volumeBounds)
      registry.js        façade vers Wave Link pour les actions
      scope.js           niveau et mute d'une portée : canal, ou canal dans un mix
      trace.js           trace brute des frames, à côté du log hôte
      ui.js              setStateIcon / setEncoderIcon
      wavelink.js        client WebSocket JSON-RPC
scripts/
  build.mjs              assemble le paquet, valide le manifest et le SDK
  install-sdk.mjs        télécharge le SDK Ulanzi
  install-deps.mjs       installe ws sans npm
tests/                   runner natif node:test
  helpers.js             chemins partagés, et le nettoyage de commentaires
```

### Une convention à ne pas casser : l'état 0

`STATE.UNMUTED` vaut **0**, `STATE.MUTED` vaut 1, et pour les sept actions
`manifest.Icon` est l'image de l'état 0.

L'hôte dessine l'état 0 pour une touche que le plugin n'a pas encore peinte. Cet état
doit donc être celui d'une touche au repos : une touche non pressée n'est pas en
sourdine. La même règle vaut pour l'icône affichée dans le sélecteur d'actions — sinon
une touche jamais peinte et le sélecteur ne montreraient pas la même chose.

---

## 6. Tests

```bash
npm test        # node --test tests/*.test.js
```

| Fichier | Couverture |
|---|---|
| `params.test.js` | `clampFloat`, `dialStep`, `volumeBounds` : pas flottants, bornes, valeurs vides, plage inversée |
| `context.test.js` | contextes d'action : ajout, déplacement, suppression, reprise |
| `render.test.js` | contrat du manifeste : états, contrôleurs, icônes d'encodeur, cache de dessin, ordre d'indexation |
| `registry.test.js` | forme exacte des appels `setChannel` / `setMix`, portées, écritures optimistes, reconnexion, désabonnement |
| `wavelink.test.js` | framing JSON-RPC, corrélation, fusion des notifications, backoff de reconnexion |
| `inspectors.test.js` | panneaux exécutés en sandbox : listes, libellés, hydration, cache-buster, absence de HTML injecté |
| `deps.test.js` | résolveur de dépendances de `install-deps.mjs` |

Deux façons de vérifier, ici, et elles ne se valent pas :

- **comportemental** — le module ou le panneau est exécuté. C'est la preuve.
- **par lecture de source** — pour ce qui ne peut pas être chargé, typiquement
  `app.js`, qui se connecte à l'hôte dès l'import. Utile, mais fragile : ça répond
  « la ligne est-elle toujours là », pas « le comportement est-il juste ». Ces lectures
  passent par `stripComments()`, sinon un commentaire expliquant pourquoi un appel
  n'est pas fait fait échouer le test qui le cherche.

Quand un correctif est non trivial, le test est **muté** : on réintroduit le défaut et on
vérifie que le test échoue. Une mutation qui ne change rien ne teste rien — cela est
arrivé deux fois ici, une fois pour une mauvaise fin de ligne et une fois parce que la
substitution ne s'appliquait à aucun fichier.

---

## 7. Débogage

- Log hôte : `%APPDATA%\Ulanzi\UlanziDeck\logs\com.ulanzi.ulanzistudio.wavelink\`
- Inspecteur Node : `--inspect=127.0.0.1:9213` (voir `plugin/manifest.json`).
- Logs client : préfixés `[WaveLink]`.

Si une icône ne change pas après un build, videz le cache d'Ulanzi Studio ou retirez
l'action du deck puis remettez-la.

### Le traçage des frames : présent, éteint

Ulanzi Studio ne conserve que les appels `logMessage` de niveau *erreur*. Un trace de
niveau *info* est donc invisible : rien ne distingue « l'hôte n'a rien envoyé » de «
tout a fonctionné ». `service/core/trace.js` écrit chaque frame WebSocket dans les deux
sens, plus les lignes de service, dans un fichier à côté du log hôte.

**Il est éteint par défaut**, sur une seule ligne :

```js
// plugin/service/core/trace.js
export const TRACING = false;
```

Passée à `true`, il n'y a rien d'autre à changer : `trace()` redevient le point de
passage unique et les douze appelants restent en place. Le service annonce son état au
démarrage, dans le log hôte :

```
tracing off (set TRACING to true in service/core/trace.js)
tracing on -> .../logs/com.ulanzi.ulanzistudio.wavelink.trace.log
```

**Pourquoi éteint.** L'hôte repousse des échos d'état plusieurs fois par seconde : une
session de huit heures remplissait trois générations de 8 Mo, et la rotation coûte un
`stat` et un `rename` par écriture — du travail synchrone sur la boucle d'événements,
sur le chemin de chaque frame. Le fichier tourne à 8 Mo avec deux générations conservées.

**Pourquoi conservé.** C'est l'outil qui a permis de diagnostiquer chaque problème de
connexion rencontré ici : un port faux, une notification manquée, un payload qui n'arrive
pas. Le garder éteint plutôt que supprimé, c'est garder l'instrument sans le bruit.

C'est un interrupteur et non un appel commenté, pour une raison simple : le traçage est
réparti sur douze appelants, dont deux sur le chemin de chaque frame — un sur la
réception, un sur l'envoi. Commenter l'un laisserait les autres écrire : un fichier à
moitié rempli, qui existe, qui tourne, et qui n'est pas toute la vérité. Le pire des
deux mondes.

> Une réserve honnête : même éteint, `trace()` est appelé sur chaque frame et s'en
> retourne. Le coût résiduel est un test de booléen, négligeable — mais c'est bien un
> appel qui subsiste, et non zéro travail.


### Le WebView met les scripts en cache

Les property inspectors tournent dans un WebView qui **met en cache
`property-inspector/shared.js`** alors même qu'il relit le HTML. Conséquence
observée : un correctif de `shared.js` ne prend effet qu'après un nettoyage manuel du
cache, alors que le nouveau champ du formulaire est bien visible.

La parade est un paramètre de version sur la balise `<script`, à incrémenter **chaque
fois que `shared.js` change** :

```html
<script src="../shared.js?v=7"></script>
```

`PI_VERSION`, en tête de `shared.js`, doit porter la même valeur qu'un `?v=` de chaque
inspecteur — un test le vérifie sur les sept, parce qu'un seul `?v=` oublié donne un
panneau qui ne fait rien, sans la moindre erreur.

C'est aussi le premier réflexe si un réglage saisi dans l'inspecteur n'atteint jamais
le service alors que le champ est là.

### Le panneau de propriétés répond, et répond une seule fois

Trois règles se contredisent si on ne les tient pas ensemble, et chacune a coûté un bug
visible.

**Un panneau naît vide.** Il vit dans un WebView que l'hôte recrée à chaque ouverture.
Il se signale par `get-registry`, et c'est ce signal qui force l'envoi : sans lui, tout
payload déjà envoyé est considéré comme connu et le panneau affiche un statut périmé
avec des listes vides.

**Un panneau ne veut que des identifiants et des noms.** Le payload ne doit donc porter
ni `level`, ni `isMuted`, ni icône base64. Un `level` change à chaque cran de molette,
donc le payload différait en permanence et le panneau se reconstruisait en boucle :
c'était le rafraîchissement visible à chaque rotation. Une fois le payload stable, il
peut être comparé avant l'envoi, et une rotation ne produit plus rien.

**Ne répondre qu'au panneau qui demande.** L'hôte livre le message au panneau ouvert,
quel que soit le contexte visé, donc rafraîchir toutes les instances de la même action
empilait trois réponses sur un seul panneau et la dernière gagnait — trois molettes
liées à trois canaux différents affichaient le même.

### Un rejeu de réglages ne doit rien réécrire

L'hôte rejoue ses réglages à chaque ouverture de touche. Deux règles en découlent, et
elles se contredisent si on oublie l'une :

- le champ **sous la main** de l'utilisateur n'est pas écrasé, et le hook `onSettings`
  ne reçoit que les champs réellement appliqués — lui passer le jeu complet lui
  remettrait la valeur sous son curseur ;
- le rejeu **ne force pas** de rapport vers le service. Le panneau ne signale que ce qui
  a réellement changé, sinon chaque clic sur le deck produirait un envoi décrivant un
  formulaire immobile.

### Une bascule s'écrit avant de partir, puis se retire si elle échoue

Une bascule mute lit l'état en cache pour décider de la valeur opposée. La notification
de Wave Link n'est pas encore revenue quand la deuxième pression arrive : sans plus
fort, les deux lisent le même état et la seconde est absorbée en silence. Le plugin
écrit donc la valeur voulue dans le cache **avant** d'envoyer la requête.

Si la requête est refusée, l'écriture est retirée : une bascule refusée ne doit jamais
rester affichée comme faite.

Une portée que l'hôte n'a jamais rapportée n'est **pas inventée** pour l'occasion. La
fusion des notifications ne réécrit que les jonctions qu'elles listent, donc une
entrée fabriquée et jamais confirmée resterait dans le cache pour toute la session, à
afficher un mute qui n'a pas eu lieu.

---

## 8. Limites connues

- Une touche ne peut piloter qu'un seul canal ou mix à la fois
  (`SupportedInMultiActions: false`), et la portée appartient à la touche, pas au canal
- Le plugin ne subscribe pas aux VU-mètres : `subscribeLevelMeter` existe dans le client
  mais n'est appelé par aucune action
- `setInputDevice` et `setOutputDevice` sont exposés par le client mais aucune action
  ne s'en sert
- Le fader master d'un mix n'est visible qu'en ouvrant l'édition du mix dans Wave Link
- L'icône d'une molette suit le mute depuis Ulanzi Studio 3.3.0 ; en dessous, la molette
  n'affiche rien de propre (voir § 2)
