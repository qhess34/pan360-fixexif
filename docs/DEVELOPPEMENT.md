# Documentation développeur

Pan360 FixExif est une **application statique** : un `index.html`, une feuille de style et un module
JavaScript, sans framework ni étape de build. Les dépendances d'exécution sont chargées depuis un CDN
avec des versions figées ; les dépendances npm ne servent qu'aux tests.

## Arborescence

```
index.html            Structure de la page, import map (versions des dépendances CDN)
css/style.css         Styles (thème sombre, disposition plein écran en grille)
js/app.js             Toute la logique (module ES, une seule IIFE découpée en sections)
doc/                  Captures d'écran du README
docs/                 Cette documentation
tests/e2e.mjs         Test de bout en bout hors ligne (Playwright)
tests/fixtures/       Photos 360° synthétiques de géométrie connue
tools/scene.py        Générateur de ces photos (numpy + Pillow)
Dockerfile            Image nginx servant l'app
docker-compose.yml    Lancement local (fichiers montés en lecture seule)
docker/nginx.conf     Configuration nginx (no-cache, fichiers cachés refusés)
CNAME, .nojekyll      GitHub Pages
```

## Lancer, tester

```bash
docker compose up --build        # http://localhost:8080 (ou : python3 -m http.server 5555)
npm install                      # dépendances de test uniquement
npm test                         # test de bout en bout, sans accès réseau
```

`npm test` lance Chromium via Playwright (si besoin : `npx playwright install chromium`). Toutes les
requêtes sont interceptées :

| Hôte | Servi depuis |
|---|---|
| `app.test` | fichiers du dépôt (`window.__viewer()` est injecté pour les vérifications) |
| `cdn.jsdelivr.net` | `node_modules` (mêmes versions que l'import map) |
| `pano.test` | `tests/fixtures/*.jpg` (360° de niveau, 360° incliné, photo à plat 70° inclinée) |
| `panoramax.openstreetmap.fr` | API simulée ; les PATCH sont enregistrés et vérifiés |

Les photos de test sont générées par `tools/scene.py` (`python3 tools/scene.py sortie.jpg PITCH ROLL [LARGEUR] [CHAMP]`,
`CHAMP` produisant une photo à plat en perspective) :
une rue avec poteaux et façades à positions connues, prise par une caméra inclinée de `PITCH`/`ROLL`.
La correction attendue est exactement `pitch = -PITCH`, `roll = -ROLL`, ce qui permet de vérifier les
calculs au centième de degré.

## Dépendances

| Paquet | Version | Rôle |
|---|---|---|
| `@photo-sphere-viewer/core` | 5.15.1 | Visionneuse 360° — **même version que `@panoramax/web-viewer`** |
| `three` | 0.185.1 | Dépendance de Photo Sphere Viewer, utilisée aussi pour les calculs (quaternions) |

Les deux sont déclarées dans l'import map de `index.html` **et** dans `package.json` (tests). Une mise à
jour doit changer les deux endroits.

**Cache navigateur** : `index.html` référence `css/style.css?v=N` et `js/app.js?v=N`. Incrémentez `N`
à chaque modification de ces fichiers pour que les utilisateurs de GitHub Pages reçoivent la nouvelle version.

## Fidélité au viewer Panoramax (WYSIWYG)

C'est la contrainte centrale du projet : l'app doit afficher une photo **exactement** comme le viewer
officiel (`@panoramax/web-viewer`, fichiers `utils/picture.js`, `utils/utils.js`, `components/ui/Photo.js`).
Les fonctions suivantes en sont des copies ; ne les modifiez pas sans vérifier le code de Panoramax.

| Comportement Panoramax | Dans `app.js` |
|---|---|
| Correction de sphère `{pan: yaw, tilt: -pitch, roll: roll}` (radians) | `sphereCorrection()` |
| Correction appliquée seulement si pitch **et** roll ≠ 0 (photo 360°), pitch **ou** roll ≠ 0 (photo à plat) | `panoramaxApplies()` |
| XMP GPano de l'image ignoré (`useXmpData: false`) | options de `new Viewer()` |
| Vue d'ouverture : `yaw = -(view:azimuth − direction de déplacement)` pour une 360°, centre de l'image sinon | `getAzimuth()`, `relativeHeading()`, `startYaw()` |
| Photo à plat / panorama recadré projetés sur une portion de sphère (`getCroppedPanoData()`, `getFlatCrop()`) | `croppedPanoData()`, `projectionInfo()`, `panoDataFor()` |
| Champ maximal `min(champ horizontal × 3/4, 90°)` | `maxFovFor()` |

Photo Sphere Viewer applique la correction au conteneur du maillage avec
`rotation.set(tilt, pan, roll, 'YXZ')` : c'est la rotation reconstruite par `currentRotation()`.

### Photos non 360°

`projectionInfo()` classe chaque photo à partir de `pers:interior_orientation` :

- `sphere` : `field_of_view` = 360, sans recadrage. C'est le cas général.
- `cropped` : panorama recadré. Le recadrage vient de `visible_area` + `sensor_array_dimensions`, ou des
  tags EXIF `Xmp.GPano.CroppedArea…`. Il est mis à l'échelle de l'image réellement chargée (SD ou HD).
- `flat` : photo à plat. Le champ horizontal vaut `field_of_view`, ou à défaut 70° (35° en portrait).
  L'image est centrée dans un panorama virtuel de `largeur × 360 / champ` sur `hauteur × 180 / champ vertical`.

Photo Sphere Viewer reçoit ce découpage par `panoData` sous forme de fonction, appelée avec l'image chargée.
`maxFov` change d'une photo à l'autre. Photo Sphere Viewer conserve alors le champ courant : `showImage()`
force donc un recalcul du zoom après chaque chargement.

Sur une photo à plat, les angles sont répartis linéairement sur l'image. Ce n'est pas une vraie perspective,
mais c'est ce que fait Panoramax. Une photo inclinée de 4° est ainsi redressée avec un pitch d'environ 3,5°
(champ de 70°), et elle apparaît bien droite dans Panoramax. Les commandes sans objet (-90° / +90° / 180°,
vue 4 directions, Fix heading) sont désactivées par `refreshUi()`.

### Valeurs affichées et valeurs envoyées

- Photo **non modifiée** : on affiche ce que Panoramax affiche (`displayedCorrection()` applique la règle
  « pitch et roll ≠ 0 »). Le badge « valeurs ignorées par Panoramax » le signale.
- Photo **modifiée** : on affiche ce qui sera affiché après envoi, c'est-à-dire `panoramaxPayload()`.
  Ce dernier remplace un pitch ou roll nul par `NUDGE` (0,01°) pour que la correction soit appliquée.

## API Panoramax

| Appel | Usage |
|---|---|
| `GET /api/collections/{cid}/items?limit=100` | Photos de la séquence ; pagination via le lien `rel=next` |
| `GET /api/users/me/collection` | « Mes séquences » (liens `rel=child`) |
| `PATCH /api/collections/{cid}/items/{id}` | Enregistrement, corps JSON `{pitch, roll, yaw}` |

- Le serveur (`geovisio`, `PatchItemParameter`) attend `pitch` et `roll` dans [-90, 90] et `yaw` dans [0, 360],
  **sans préfixe `pers:`**. Un champ inconnu est ignoré silencieusement (réponse 200 sans effet).
- En lecture, ces valeurs sont exposées sous `pers:pitch`, `pers:roll`, `pers:yaw`, avec repli sur les tags
  EXIF `Xmp.GPano.Pose*Degrees` (`featureToItem()`).
- Authentification : en-tête `Authorization: Bearer <token>`. Les GET tentent d'abord avec le token
  (photos masquées), puis sans en cas de 401/403 ou d'erreur CORS (`apiGet()`).

## Organisation de `js/app.js`

Le fichier est découpé en sections commentées, dans cet ordre :

1. **Stockage local** — `store` (préfixe `pfx.`, accès toujours protégé par `try/catch`), `settings`.
2. **État** — `state` : instance, `collectionId`, `items`, `index`, `edits` (modifications non envoyées,
   par id de photo), `synced` (photos envoyées pendant la session).
3. **Lecture d'une séquence** — `parseSequenceInput()`, `featureToItem()`, `loadSequence()`.
4. **Valeurs courantes** — `values(item)` = valeurs Panoramax + modifications ; `setValues()` borne,
   arrondit au centième, normalise le yaw dans [0, 360) et persiste.
5. **Correspondance Panoramax** — voir ci-dessus.
6. **Visionneuse** — `createViewer()`, `showImage()`, `lookAt()` (angles relatifs au sens de déplacement).
7. **Corrections** — `composeRotation(extra, {keepYaw})` compose une rotation « monde » avec la
   correction affichée et la redécompose en pitch / yaw / roll ; `fixHorizon()`, `fixYaw()`.
8. **Repères cliqués** — modes points d'horizon / verticales, `solveLevel()`, tracé SVG `drawMarks()`.
9. **Vue 4 directions** — quatre `Viewer` sans interaction, créés à l'activation et détruits ensuite.
10. **Miniatures** — `itemStatus()`, `buildStrip()`, `updateStrip()`, navigation N / M.
11. **Courbe** — SVG dessiné à la main (`drawChart()`), redessiné au plus une fois par frame.
12. **Synchronisation**, **Mes séquences**, **Interface** (`refreshUi()`, HUD, paramètres, boutons,
    raccourcis), **Démarrage** (`init()`).

`refreshUi()` est le point unique de mise à jour de l'interface après un changement d'état. Elle
rafraîchit aussi la bande de miniatures et planifie le redessin de la courbe.

### Mise à niveau par repères (`solveLevel()`)

Chaque repère est stocké dans le **repère de l'image** (`toLocal()`), puis reconverti avec la
correction courante au moment du calcul (`toWorld()`). La verticale réelle `u` doit vérifier :

- `u · p = 0` pour un point `p` de l'horizon réel ;
- `u · (a × b) = 0` pour une verticale passant par `a` et `b` : le plan du grand cercle contient `u`.

`u` est obtenu par projections successives sur ces plans (moindres carrés, 200 itérations). La sphère est
ensuite tournée de la plus petite rotation qui amène `u` sur la verticale de l'écran. Le yaw est conservé
(`keepYaw`) : une rotation autour de la verticale ne change pas la mise à niveau.

## Stockage local

| Clé | Contenu |
|---|---|
| `pfx.instance` | URL de l'instance Panoramax |
| `pfx.token` | Token (dans `localStorage` si « Mémoriser », sinon `sessionStorage`) |
| `pfx.remember` | Choix « Mémoriser » |
| `pfx.quality` | `sd` ou `hd` |
| `pfx.quad` | Vue 4 directions activée |
| `pfx.lastSequence` | Dernière séquence chargée |
| `pfx.edits.<collectionId>` | Modifications non envoyées `{idPhoto: {pitch, roll, yaw}}` |

L'URL de la page porte `#seq=<id>&img=<n>[&instance=<url>]`.

## Conventions

- Interface, messages et commentaires **en français**.
- JavaScript moderne sans transpilation (module ES, `const`/`let`, fonctions fléchées), pas de dépendance
  ajoutée sans nécessité.
- Raccourcis clavier définis par **code physique** (`KeyQ`…) dans `SHORTCUTS`, avec le libellé AZERTY ;
  ils sont ignorés dans les champs de saisie, mais pas sur les curseurs ni les boutons.
- Disposition : aucune barre de défilement de page au-dessus de 900 px de large ; vérifier en
  1280×720 et 1920×1080 après toute modification de l'interface.
- Avant de livrer : `npm test`, puis incrémenter `?v=N` dans `index.html` si `app.js` ou `style.css` a changé.
