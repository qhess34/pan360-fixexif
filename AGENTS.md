# AGENTS.md

Consignes pour les agents (IA ou humains) qui modifient ce dépôt. La documentation complète est dans
[docs/DEVELOPPEMENT.md](docs/DEVELOPPEMENT.md) ; lisez-la avant une modification non triviale.

## Le projet en bref

Application **statique** (HTML + CSS + un module JS, aucun build) qui corrige le pitch / roll / yaw des
photos 360° Panoramax en WYSIWYG, puis envoie les valeurs par `PATCH` à l'API Panoramax.
Déployée par GitHub Pages depuis `main` (domaine dans `CNAME`).

- `index.html` : structure + import map (versions CDN figées)
- `css/style.css` : styles
- `js/app.js` : toute la logique, en sections commentées
- `tests/e2e.mjs` : test de bout en bout hors ligne

## Commandes

```bash
npm install          # dépendances de test uniquement (Playwright, Photo Sphere Viewer, three)
npm test             # doit passer avant toute livraison
docker compose up --build   # app sur http://localhost:8080
```

## Règles à respecter

1. **Fidélité au viewer Panoramax.** L'affichage doit rester identique à `@panoramax/web-viewer` :
   - `sphereCorrection = {pan: yaw, tilt: -pitch, roll: roll}` ;
   - correction appliquée seulement si pitch et roll ≠ 0 ;
   - `useXmpData: false` ;
   - vue d'ouverture `-(view:azimuth − direction de déplacement)`.

   Ne modifiez `sphereCorrection()`, `panoramaxApplies()`, `relativeHeading()` ou `startYaw()` qu'après
   avoir vérifié le code source de Panoramax.
2. **API** : le PATCH envoie `{pitch, roll, yaw}` **sans préfixe `pers:`**. Plages : pitch et roll dans
   [-90, 90], yaw dans [0, 360]. Un champ mal nommé est ignoré sans erreur par le serveur : vérifiez le
   corps envoyé, pas seulement le code HTTP.
3. **Aucun build, aucune dépendance d'exécution ajoutée** sans nécessité. Une dépendance CDN se déclare
   dans l'import map de `index.html` **et** dans `package.json`, avec une version exacte.
4. **Cache** : après modification de `js/app.js` ou `css/style.css`, incrémentez `?v=N` dans `index.html`.
5. **Langue** : interface, messages, commentaires et documentation en français.
6. **Disposition** : pas de défilement de page au-dessus de 900 px de large ; vérifier en 1280×720.
7. **Secrets** : le token Panoramax ne doit jamais être journalisé ni envoyé ailleurs qu'à l'instance
   configurée. Ne committez ni token ni capture contenant un token.
8. **Accès au stockage** : passez toujours par `store` (protégé par `try/catch`, préfixe `pfx.`).

## Vérifier une modification

- `npm test` couvre le chargement, les statuts, les trois outils de mise à niveau, la vue d'ouverture,
  la règle « pitch et roll ≠ 0 » et le contenu des PATCH.
- Pour un comportement visuel, faites une capture avec Playwright à partir du même dispositif que
  `tests/e2e.mjs` (API simulée, photos de `tests/fixtures`).
- Pour une photo de test à géométrie connue : `python3 tools/scene.py sortie.jpg PITCH ROLL [LARGEUR]` ;
  la correction attendue est `-PITCH` / `-ROLL`.
- Mettez à jour le README (fonctionnalités, raccourcis) et `docs/DEVELOPPEMENT.md` quand le comportement
  change.
