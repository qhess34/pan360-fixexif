# Pan360 FixExif

Application web 100 % JavaScript (statique, hébergeable sur GitHub Pages) pour corriger en **WYSIWYG**
l'orientation **Pitch / Roll / Yaw** de vos photos 360° publiées sur [Panoramax](https://panoramax.fr).

L'affichage utilise [Photo Sphere Viewer](https://photo-sphere-viewer.js.org/) avec exactement la même
transformation que le viewer officiel Panoramax (`sphereCorrection = {pan: yaw, tilt: -pitch, roll: roll}`) :
ce que vous voyez est ce que Panoramax affichera.

Les corrections sont visibles en direct dans la visionneuse puis envoyées à l'API Panoramax
(`PATCH /api/collections/{collection}/items/{photo}` avec `pitch`, `roll`, `yaw`),
ce qui met à jour les métadonnées `pers:pitch`, `pers:roll`, `pers:yaw`.

## Mise en ligne sur GitHub Pages

1. Dans le dépôt GitHub : **Settings → Pages**.
2. *Source* : **Deploy from a branch**, branche `main`, dossier `/ (root)`.
3. L'application est servie sur `https://<utilisateur>.github.io/pan360-fixexif/`.

Aucun build n'est nécessaire. En local, n'importe quel serveur statique convient :

```bash
python3 -m http.server 5555   # puis http://127.0.0.1:5555
```

## Utilisation

![Interface](doc/view.png)

1. Ouvrir les **paramètres ⚙** et renseigner :
   - l'**instance** Panoramax (par défaut `https://panoramax.openstreetmap.fr`) ;
   - votre **token** Panoramax (nécessaire pour enregistrer et pour « Mes séquences »).
     Cochez « Mémoriser » pour le conserver dans le `localStorage` du navigateur,
     sinon il est oublié à la fermeture de l'onglet.
2. Coller l'URL d'une séquence (page Panoramax contenant `seq=…`, URL d'API
   `…/api/collections/<id>/items`, ou simplement l'identifiant) puis **Charger** —
   ou choisir une séquence via **Mes séquences**.
3. Corriger chaque photo :
   - **Horizon** : dans n'importe quelle direction, monter/descendre la vue pour poser l'horizon réel
     sur la ligne rouge, puis **FIX horizon** (pitch et roll sont recalculés ensemble). Répéter dans
     une direction perpendiculaire (ex. 0° puis 90°) pour un résultat parfait.
   - **Yaw** : tourner la vue vers la direction de prise de vue (l'« avant ») puis **Fix heading**.
   - Les boutons ▲/▼, ↻/↺ et les curseurs permettent un réglage fin ; **RESET** remet l'axe à 0.
4. **Synchroniser vers Panoramax** envoie toutes les photos modifiées
   (ou **Enregistrer cette photo** pour la photo courante uniquement).

Les modifications non synchronisées sont conservées dans le navigateur : vous pouvez fermer
l'onglet et reprendre plus tard. L'URL (`#seq=…&img=…`) permet de revenir directement à une photo.
Le bouton « Effacer mes données locales » des paramètres supprime token, réglages et modifications en attente.

## Raccourcis clavier

Les raccourcis sont liés à la position physique des touches (libellés ci-dessous en **AZERTY** ;
l'aide intégrée affiche les touches de votre clavier quand le navigateur le permet) :

| Touche | Action |
|---|---|
| **A** ou **Z** | FIX horizon (horizon posé sur la ligne rouge) |
| **E** | Fix heading : la direction visée devient l'avant |
| **Q** / **S** / **D** / **F** | Vue à -90° / 0° / +90° / 180° |
| **W** / **C** (ou PgUp / PgDn) | Image précédente / suivante |
| **X** | Vue par défaut (selon le yaw) |
| **V** | Synchroniser vers Panoramax |
| **← →** / **↑ ↓** | Tourner la vue (5°) / l'incliner finement (0,2°) |

## Notes

- Le viewer Panoramax n'applique la correction d'une photo 360° **que si pitch et roll sont tous deux
  non nuls**. Les photos dans ce cas sont signalées (« valeurs ignorées par Panoramax ») et, à l'envoi,
  un angle nul est remplacé par 0,01° (invisible) pour que la correction soit bien prise en compte.

- Seul le propriétaire des photos (ou un administrateur) peut les modifier sur Panoramax.
- Le token est stocké en clair dans le stockage local de votre navigateur et n'est envoyé qu'à
  l'instance configurée. N'utilisez pas l'option « Mémoriser » sur un ordinateur partagé.
