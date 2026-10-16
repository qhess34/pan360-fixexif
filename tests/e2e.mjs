/*
 * Test de bout en bout, hors ligne : `npm test`.
 *
 * Chromium (Playwright) charge l'app ; toutes les requêtes réseau sont interceptées :
 *  - app.test            → fichiers du dépôt
 *  - cdn.jsdelivr.net    → node_modules (mêmes versions que l'import map)
 *  - pano.test           → photos synthétiques de tests/fixtures (générées par tools/scene.py)
 *  - instance Panoramax  → API simulée (GET séquence, PATCH enregistrés pour vérification)
 *
 * La géométrie des photos de test est connue : tilt-4-3.jpg a été prise avec une caméra inclinée
 * de pitch 4° / roll -3°, la correction attendue est donc pitch -4 / roll 3.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NM = path.join(ROOT, 'node_modules');
const API = 'https://panoramax.openstreetmap.fr';
const CID = '11111111-2222-3333-4444-555555555555';
const pid = i => `aaaaaaaa-0000-0000-0000-00000000000${i}`;
const TILT = [4, -3];

// Photos : 0 = déjà corrigée, 1 = inclinée non corrigée, 2 = valeurs ignorées par Panoramax
// (pitch seul) et caméra montée à l'envers (view:azimuth 180° alors que la séquence va au nord).
const PICS = [
  { img: 'level.jpg', pitch: 0.01, roll: 0.01, azimuth: 0 },
  { img: 'tilt-4-3.jpg', pitch: 0, roll: 0, azimuth: 0 },
  { img: 'tilt-4-3.jpg', pitch: 2, roll: 0, azimuth: 180 },
];
const features = PICS.map((p, i) => ({
  type: 'Feature',
  id: pid(i),
  collection: CID,
  geometry: { type: 'Point', coordinates: [3.88, 43.61 + i * 0.0001] },
  properties: {
    datetime: `2026-09-12T10:0${i}:00Z`,
    'view:azimuth': p.azimuth,
    'pers:pitch': p.pitch,
    'pers:roll': p.roll,
    'pers:yaw': 0,
    'pers:interior_orientation': { field_of_view: 360 },
  },
  assets: { sd: { href: `https://pano.test/${p.img}?i=${i}` }, thumb: { href: `https://pano.test/${p.img}?t=${i}` } },
}));

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.jpg': 'image/jpeg' };
const patches = [];

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', e => { console.log('pageerror:', e.message); failures++; });

await page.route('**/*', async route => {
  const req = route.request();
  const url = new URL(req.url());
  const serve = (file, extra = {}) => route.fulfill({
    body: fs.readFileSync(file), contentType: TYPES[path.extname(file)] || 'application/octet-stream', headers: { ...CORS, ...extra },
  });
  if (url.host === 'app.test') {
    const file = path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!file.endsWith('app.js')) return serve(file);
    // Expose la visionneuse pour les vérifications géométriques.
    const body = fs.readFileSync(file, 'utf8').replace('let viewer = null;', 'let viewer = null; window.__viewer = () => viewer;');
    return route.fulfill({ body, contentType: 'text/javascript' });
  }
  if (url.host === 'cdn.jsdelivr.net') {
    const m = url.pathname.match(/^\/npm\/(@[^/]+\/[^@/]+|[^@/]+)@[^/]+\/(.+)$/);
    if (m) return serve(path.join(NM, m[1], m[2]));
  }
  if (url.host === 'pano.test') return serve(path.join(ROOT, 'tests/fixtures', path.basename(url.pathname)));
  if (url.origin === API) {
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (req.method() === 'PATCH') {
      patches.push({ id: path.basename(url.pathname), auth: req.headers().authorization, body: JSON.parse(req.postData()) });
      return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: '{}' });
    }
    return route.fulfill({ headers: CORS, contentType: 'application/geo+json', body: JSON.stringify({ features }) });
  }
  return route.abort();
});

// --- Utilitaires -------------------------------------------------------------
const values = () => page.evaluate(() => ['pitchVal', 'rollVal', 'yawVal'].map(id => Number(document.getElementById(id).textContent)));
const ready = () => page.waitForFunction(() => window.__viewer?.()?.state.ready, null, { timeout: 30000 });

/** Coordonnées texture d'un point 3D de la scène (repère de tools/scene.py) vu par la caméra inclinée. */
function sceneToTexture([px, py, pz], [tp, tr], width) {
  let x = px, y = py - 2.2, z = pz;
  const n = Math.hypot(x, y, z); x /= n; y /= n; z /= n;
  const a = -tp * Math.PI / 180, b = -tr * Math.PI / 180;
  [y, z] = [Math.cos(a) * y - Math.sin(a) * z, Math.sin(a) * y + Math.cos(a) * z];
  [x, y] = [Math.cos(b) * x - Math.sin(b) * y, Math.sin(b) * x + Math.cos(b) * y];
  return { textureX: (Math.atan2(x, z) / (2 * Math.PI) + 0.5) * width, textureY: (0.5 - Math.asin(y) / Math.PI) * width / 2 };
}

/** Centre la vue sur un point de la scène puis clique au centre de la visionneuse. */
async function clickScene(point) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const pos = await page.evaluate(async tex => {
    const v = window.__viewer();
    const sp = v.dataHelper.textureCoordsToSphericalCoords(tex);
    v.rotate(sp);
    await new Promise(r => setTimeout(r, 250));
    const r = document.getElementById('panorama').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, sceneToTexture(point, TILT, 2048));
  await page.mouse.click(pos.x, pos.y);
  await page.waitForTimeout(500); // Photo Sphere Viewer attend ~300 ms (détection du double-clic)
}

/** Hauteur apparente (pitch, en degrés) d'un point de la scène avec la correction affichée. */
const apparentPitch = point => page.evaluate(tex => {
  const v = window.__viewer();
  return v.dataHelper.textureCoordsToSphericalCoords(tex).pitch * 180 / Math.PI;
}, sceneToTexture(point, TILT, 2048));

const revert = async () => { await page.evaluate(() => document.getElementById('revertBtn').click()); await page.waitForTimeout(100); };

// --- Scénario ----------------------------------------------------------------
await page.goto('https://app.test/');
await page.evaluate(() => { localStorage.setItem('pfx.token', '"TOKEN"'); localStorage.setItem('pfx.remember', 'true'); });
await page.goto(`https://app.test/#seq=${CID}&img=2`);
await page.reload();
await ready();
await page.waitForTimeout(800);

check('séquence chargée', (await page.textContent('#total')) === '3');
const statuses = await page.evaluate(() => [...document.querySelectorAll('.thumb')].map(t => t.className.match(/st-(\w+)/)[1]));
check('statuts des miniatures', statuses.join() === 'corrected,raw,ignored', statuses.join());

// Verticales : deux poteaux dans des directions différentes.
await page.keyboard.press('KeyJ');
for (const [x, z] of [[5.5, 12], [-5.5, 12]]) {
  await clickScene([x, 4.6, z]);
  await clickScene([x, 0.4, z]);
}
let [p, r, y] = await values();
check('verticales → pitch -4 / roll 3, yaw inchangé', near(p, -4, 0.15) && near(r, 3, 0.15) && y === 0, `${p} / ${r} / ${y}`);
await page.keyboard.press('Escape');

// Points d'horizon : deux points à hauteur de caméra, éloignés de ~120°.
await revert();
await page.keyboard.press('KeyH');
await clickScene([9, 2.2, 5]);
await clickScene([-9, 2.2, -5]);
[p, r, y] = await values();
check('points d\'horizon → pitch -4 / roll 3', near(p, -4, 0.25) && near(r, 3, 0.25) && y === 0, `${p} / ${r} / ${y}`);
await page.keyboard.press('Escape');

// FIX horizon : l'horizon réel est posé sur la ligne rouge, puis A.
await revert();
await page.evaluate(async tex => {
  const v = window.__viewer();
  v.rotate(v.dataHelper.textureCoordsToSphericalCoords(tex));
  await new Promise(res => setTimeout(res, 200));
}, sceneToTexture([0, 2.2, 200], TILT, 2048));
await page.keyboard.press('KeyQ'); // A en AZERTY
await page.waitForTimeout(100);
const after = await apparentPitch([0, 2.2, 200]);
check('FIX horizon → point visé à l\'horizon', near(after, 0, 0.05), `${after.toFixed(3)}°`);

// Photo 3 : vue d'ouverture dans le sens de déplacement (caméra à l'envers → 180° dans l'image).
await page.keyboard.press('KeyC');
await page.waitForTimeout(1500);
const startYaw = await page.evaluate(() => window.__viewer().getPosition().yaw * 180 / Math.PI);
check('ouverture dans le sens de déplacement', near(startYaw, 180, 0.5), `${startYaw.toFixed(1)}°`);
check('badge « valeurs ignorées par Panoramax »', (await page.textContent('#filename')).includes('ignorées'));
await page.evaluate(() => document.querySelector('[data-axis=pitch][data-step="1"]').click());

// Synchronisation : champs sans préfixe pers:, 0 remplacé par 0,01.
await page.keyboard.press('KeyV');
await page.waitForTimeout(1500);
const byId = Object.fromEntries(patches.map(x => [x.id, x]));
check('2 photos envoyées avec le token', patches.length === 2 && patches.every(x => x.auth === 'Bearer TOKEN'), `${patches.length}`);
check('PATCH photo 2 : pitch / roll / yaw', JSON.stringify(Object.keys(byId[pid(1)]?.body || {})) === '["pitch","roll","yaw"]',
  JSON.stringify(byId[pid(1)]?.body));
check('PATCH photo 3 : roll 0 → 0,01', byId[pid(2)]?.body.pitch === 3 && byId[pid(2)]?.body.roll === 0.01, JSON.stringify(byId[pid(2)]?.body));
const finalStatuses = await page.evaluate(() => [...document.querySelectorAll('.thumb')].map(t => t.className.match(/st-(\w+)/)[1]));
check('statuts après synchronisation', finalStatuses.join() === 'corrected,synced,synced', finalStatuses.join());

await browser.close();
console.log(failures ? `\n${failures} échec(s)` : '\nTous les tests passent.');
process.exit(failures ? 1 : 0);
