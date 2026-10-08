/*
 * Pan360 FixExif — correction WYSIWYG du pitch / roll / yaw des photos 360° Panoramax.
 *
 * Application 100 % statique : les photos sont lues directement depuis l'API Panoramax et
 * affichées avec Photo Sphere Viewer, en appliquant exactement la même correction que le
 * viewer officiel Panoramax (sphereCorrection = {pan: yaw, tilt: -pitch, roll: roll}).
 * Les nouvelles valeurs sont envoyées par PATCH sur /api/collections/{cid}/items/{id}.
 * Le paramétrage (instance, token) et les modifications en attente sont gardés dans le
 * stockage local du navigateur.
 */
import { Viewer } from '@photo-sphere-viewer/core';
import { Euler, MathUtils, Quaternion, Vector3 } from 'three';

(() => {
  'use strict';

  const DEFAULT_INSTANCE = 'https://panoramax.openstreetmap.fr';
  const PAGE_LIMIT = 100;
  const SYNC_DELAY_MS = 300;
  const DEFAULT_ZOOM = 0;           // 0 = champ le plus large (maxFov)
  const MIN_FOV = 30;
  const MAX_FOV = 90;
  const NUDGE = 0.01;              // voir panoramaxPayload()
  const { degToRad, radToDeg } = MathUtils;
  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  // ---------------------------------------------------------------------------
  // Stockage local (toujours protégé : navigation privée, stockage bloqué…)
  // ---------------------------------------------------------------------------
  const store = {
    get(key, fallback, area = localStorage) {
      try {
        const raw = area.getItem('pfx.' + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    set(key, value, area = localStorage) {
      try { area.setItem('pfx.' + key, JSON.stringify(value)); } catch (e) { /* ignoré */ }
    },
    del(key, area = localStorage) {
      try { area.removeItem('pfx.' + key); } catch (e) { /* ignoré */ }
    },
    clearAll() {
      for (const area of [localStorage, sessionStorage]) {
        try {
          Object.keys(area).filter(k => k.startsWith('pfx.')).forEach(k => area.removeItem(k));
        } catch (e) { /* ignoré */ }
      }
    },
  };

  const settings = {
    instance: store.get('instance', DEFAULT_INSTANCE),
    remember: store.get('remember', false),
    quality: store.get('quality', 'sd'),
    token: store.get('token', '') || store.get('token', '', sessionStorage),
  };

  function saveSettings() {
    store.set('instance', settings.instance);
    store.set('remember', settings.remember);
    store.set('quality', settings.quality);
    if (settings.remember) {
      store.set('token', settings.token);
      store.del('token', sessionStorage);
    } else {
      store.del('token');
      store.set('token', settings.token, sessionStorage);
    }
  }

  // ---------------------------------------------------------------------------
  // État
  // ---------------------------------------------------------------------------
  const state = {
    instance: settings.instance,
    collectionId: null,
    items: [],      // {id, collection, sd, hd, datetime, original: {pitch, roll, yaw}}
    index: 0,
    edits: {},      // id -> {pitch, roll, yaw} (modifications non synchronisées)
    busy: false,
  };

  let viewer = null;

  // ---------------------------------------------------------------------------
  // Utilitaires
  // ---------------------------------------------------------------------------
  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const round2 = v => Math.round(v * 100) / 100;
  const same = (a, b) => Math.abs(a - b) < 1e-4;

  /** Ramène un angle dans [0, 360). */
  const norm360 = a => ((a % 360) + 360) % 360;
  /** Ramène un angle dans [-180, 180). */
  const norm180 = a => norm360(a + 180) - 180;

  function firstNumber(...values) {
    for (const v of values) {
      if (v !== undefined && v !== null && v !== '' && !isNaN(Number(v))) return Number(v);
    }
    return 0;
  }

  function apiBase(instance = state.instance) {
    return instance.replace(/\/+$/, '').replace(/\/api$/, '') + '/api';
  }

  function toast(message, kind = '', duration = 4000) {
    const el = $('toast');
    el.textContent = message;
    el.className = 'toast ' + kind;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, duration);
  }

  function showLoader(text) {
    $('loaderText').textContent = text;
    $('loader').hidden = false;
  }
  function hideLoader() { $('loader').hidden = true; }

  async function apiFetch(url, options = {}, { auth = true } = {}) {
    const headers = Object.assign({ Accept: 'application/geo+json, application/json' }, options.headers || {});
    if (auth && settings.token) headers.Authorization = 'Bearer ' + settings.token;
    const res = await fetch(url, Object.assign({}, options, { headers }));
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body.message || body.detail || JSON.stringify(body);
      } catch (e) { /* corps non JSON */ }
      const err = new Error(`HTTP ${res.status}${detail ? ' — ' + detail : ''}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  /** GET public : essaie avec le token (photos masquées), puis sans si le navigateur refuse. */
  async function apiGet(url) {
    if (!settings.token) return apiFetch(url, {}, { auth: false });
    try {
      return await apiFetch(url);
    } catch (e) {
      if (e.status === 401 || e.status === 403 || e instanceof TypeError) {
        return apiFetch(url, {}, { auth: false });
      }
      throw e;
    }
  }

  // ---------------------------------------------------------------------------
  // Lecture d'une séquence
  // ---------------------------------------------------------------------------

  /**
   * Accepte : une URL d'API (…/api/collections/<id>/items), une URL du site Panoramax
   * (…#…&seq=<id> ou …/sequence/<id>), ou un identifiant seul.
   */
  function parseSequenceInput(raw) {
    const input = raw.trim();
    if (!input) return null;
    let instance = state.instance;
    let collectionId = null;

    try {
      const url = new URL(input);
      instance = url.origin;
      const params = new URLSearchParams(url.hash.replace(/^#/, '') + '&' + url.search.replace(/^\?/, ''));
      const seq = params.get('seq') || params.get('sequence');
      const fromPath = url.pathname.match(new RegExp('(?:collections|sequence|sequences)/(' + UUID_RE.source + ')', 'i'));
      collectionId = (seq && UUID_RE.test(seq) && seq.match(UUID_RE)[0]) || (fromPath && fromPath[1]) || null;
    } catch (e) {
      const m = input.match(UUID_RE);
      collectionId = m ? m[0] : null;
    }
    return collectionId ? { instance, collectionId: collectionId.toLowerCase() } : null;
  }

  function featureToItem(feature) {
    const p = feature.properties || {};
    const exif = p.exif || {};
    const assets = feature.assets || {};
    const sd = (assets.sd && assets.sd.href) || (assets.hd && assets.hd.href);
    return {
      id: feature.id,
      collection: feature.collection,
      sd,
      hd: (assets.hd && assets.hd.href) || sd,
      datetime: p.datetime || '',
      is360: (p['pers:interior_orientation'] || {}).field_of_view === 360,
      original: {
        pitch: firstNumber(p['pers:pitch'], exif['Xmp.GPano.PosePitchDegrees']),
        roll: firstNumber(p['pers:roll'], exif['Xmp.GPano.PoseRollDegrees']),
        yaw: firstNumber(p['pers:yaw'], exif['Xmp.GPano.PoseHeadingDegrees']),
      },
    };
  }

  async function loadSequence(instance, collectionId, startIndex = 0) {
    if (state.busy) return;
    state.busy = true;
    showLoader('Chargement de la séquence…');
    try {
      const items = [];
      let url = `${apiBase(instance)}/collections/${collectionId}/items?limit=${PAGE_LIMIT}`;
      const seen = new Set();
      while (url && !seen.has(url)) {
        seen.add(url);
        const page = await apiGet(url);
        for (const f of page.features || []) {
          const item = featureToItem(f);
          if (item.sd) items.push(item);
        }
        $('loaderText').textContent = `Chargement de la séquence… ${items.length} photos`;
        const next = (page.links || []).find(l => l.rel === 'next');
        url = next ? next.href : null;
      }
      if (!items.length) throw new Error('Aucune photo trouvée dans cette séquence.');

      state.instance = instance;
      state.collectionId = collectionId;
      state.items = items;
      state.edits = store.get('edits.' + collectionId, {});
      // On ne garde que les modifications qui concernent encore des photos de la séquence.
      const ids = new Set(items.map(i => i.id));
      Object.keys(state.edits).forEach(id => { if (!ids.has(id)) delete state.edits[id]; });

      store.set('lastSequence', { instance, collectionId });
      $('seqInput').value = collectionId;
      $('empty').hidden = true;
      $('controls').classList.remove('disabled');
      $('total').textContent = items.length;
      $('indexInput').max = items.length;
      showImage(Math.min(Math.max(0, startIndex), items.length - 1));

      const pending = Object.keys(state.edits).length;
      toast(`${items.length} photos chargées` + (pending ? ` — ${pending} modification(s) locale(s) restaurée(s)` : ''), 'ok');
    } catch (e) {
      console.error(e);
      toast('Impossible de charger la séquence : ' + describeError(e), 'err', 8000);
    } finally {
      hideLoader();
      state.busy = false;
    }
  }

  function describeError(e) {
    if (e instanceof TypeError) return 'erreur réseau ou CORS (' + e.message + ')';
    if (e.status === 401) return 'token absent, invalide ou expiré (401)';
    if (e.status === 403) return 'accès refusé — ces photos vous appartiennent-elles ? (403)';
    return e.message;
  }

  // ---------------------------------------------------------------------------
  // Valeurs courantes / modifications
  // ---------------------------------------------------------------------------
  const currentItem = () => state.items[state.index];

  function values(item = currentItem()) {
    return Object.assign({}, item.original, state.edits[item.id] || {});
  }

  function isDirty(item) {
    const e = state.edits[item.id];
    return !!e && ['pitch', 'roll', 'yaw'].some(k => !same(e[k], item.original[k]));
  }

  function persistEdits() {
    if (state.collectionId) store.set('edits.' + state.collectionId, state.edits);
  }

  function setValues(patch) {
    const item = currentItem();
    if (!item) return;
    const v = Object.assign(values(item), patch);
    v.pitch = round2(Math.max(-90, Math.min(90, v.pitch)));
    v.roll = round2(Math.max(-90, Math.min(90, v.roll)));
    v.yaw = round2(norm360(v.yaw));
    state.edits[item.id] = v;
    if (!isDirty(item)) delete state.edits[item.id];
    persistEdits();
    applyPose();
    refreshUi();
  }

  // ---------------------------------------------------------------------------
  // Correspondance avec le viewer Panoramax
  // ---------------------------------------------------------------------------

  /**
   * Le viewer Panoramax n'applique la correction d'une photo 360° que si pitch ET roll sont
   * non nuls (et, pour une photo non 360°, si l'un des deux est non nul).
   * Copie de getSphereCorrection() de @panoramax/web-viewer.
   */
  function panoramaxApplies(v, is360) {
    return (!is360 && (v.pitch !== 0 || v.roll !== 0)) || (v.pitch !== 0 && v.roll !== 0);
  }

  /** Correction effectivement affichée par Panoramax pour ces valeurs. */
  function sphereCorrection(v, is360 = true) {
    if (!panoramaxApplies(v, is360)) return { pan: 0, tilt: 0, roll: 0 };
    return { pan: degToRad(v.yaw), tilt: degToRad(-v.pitch), roll: degToRad(v.roll) };
  }

  /**
   * Valeurs envoyées à l'API : si une correction est voulue mais qu'un des deux angles vaut 0,
   * Panoramax l'ignorerait ; on remplace ce 0 par 0,01° (invisible) pour qu'elle s'applique.
   */
  function panoramaxPayload(v, is360) {
    const out = { pitch: v.pitch, roll: v.roll, yaw: v.yaw };
    const wanted = out.pitch !== 0 || out.roll !== 0 || out.yaw !== 0;
    if (wanted && !panoramaxApplies(out, is360)) {
      if (out.pitch === 0) out.pitch = NUDGE;
      if (out.roll === 0) out.roll = NUDGE;
    }
    return out;
  }

  /**
   * Correction à afficher : tant qu'une photo n'est pas modifiée, on montre exactement ce que
   * Panoramax affiche ; dès qu'elle est modifiée, ce qui sera affiché après synchronisation.
   */
  function displayedCorrection(item = currentItem()) {
    const v = values(item);
    return sphereCorrection(isDirty(item) ? panoramaxPayload(v, item.is360) : v, item.is360);
  }

  /** Applique la correction à la vue en direct (sans recharger l'image). */
  function applyPose() {
    if (!viewer || !currentItem()) return;
    viewer.setOption('sphereCorrection', displayedCorrection());
  }

  // ---------------------------------------------------------------------------
  // Visionneuse
  // ---------------------------------------------------------------------------
  const isAbort = e => !!e && (e.name === 'AbortError' || /abort/i.test(e.message || ''));

  function pictureUrl(item) {
    return settings.quality === 'hd' ? item.hd : item.sd;
  }

  function createViewer(item) {
    viewer = new Viewer({
      container: 'panorama',
      panorama: pictureUrl(item),
      sphereCorrection: displayedCorrection(item),
      defaultYaw: 0,
      defaultPitch: 0,
      defaultZoomLvl: DEFAULT_ZOOM,
      minFov: MIN_FOV,
      maxFov: MAX_FOV,
      navbar: false,
      keyboard: false,             // les raccourcis sont gérés par l'application
      mousewheelCtrlKey: false,
      loadingTxt: 'Chargement…',
    });
    viewer.addEventListener('panorama-error', e => {
      if (!isAbort(e.error)) toast('Erreur d\'affichage : ' + (e.error && e.error.message || e.error), 'err', 8000);
    });
  }

  function showImage(index) {
    const item = state.items[index];
    if (!item) return;
    state.index = index;
    if (!viewer) {
      createViewer(item);
    } else {
      viewer.setPanorama(pictureUrl(item), {
        sphereCorrection: displayedCorrection(item),
        position: { yaw: 0, pitch: 0 },
        transition: false,
        showLoader: true,
      }).then(() => applyPose()).catch(e => {
        if (!isAbort(e)) toast('Erreur d\'affichage : ' + e.message, 'err', 8000);
      });
    }

    preload(index + 1);
    preload(index - 1);
    refreshUi();
    updateHash();
  }

  function preload(index) {
    const item = state.items[index];
    if (!item) return;
    fetch(pictureUrl(item), { mode: 'cors' }).catch(() => { /* simple préchargement */ });
  }

  function go(delta) {
    if (!state.items.length) return;
    const n = state.items.length;
    showImage(((state.index + delta) % n + n) % n);
  }

  /** Oriente la vue (angle relatif à l'avant de la photo, comme dans Panoramax). */
  function lookAt(yawDeg) {
    if (!viewer) return;
    viewer.rotate({ yaw: degToRad(yawDeg), pitch: 0 });
  }

  function resetView() {
    if (!viewer) return;
    viewer.rotate({ yaw: 0, pitch: 0 });
    viewer.zoom(DEFAULT_ZOOM);
  }

  // ---------------------------------------------------------------------------
  // Corrections
  // ---------------------------------------------------------------------------

  /** Rotation de la sphère actuellement affichée (identique au renderer Photo Sphere Viewer). */
  function currentRotation() {
    const c = displayedCorrection();
    return new Quaternion().setFromEuler(new Euler(c.tilt, c.pan, c.roll, 'YXZ'));
  }

  /** Applique une rotation monde supplémentaire et en déduit les nouveaux pitch / roll / yaw. */
  function composeRotation(extra) {
    const e = new Euler().setFromQuaternion(extra.multiply(currentRotation()), 'YXZ');
    setValues({ pitch: -radToDeg(e.x), yaw: radToDeg(e.y), roll: radToDeg(e.z) });
  }

  /**
   * L'utilisateur a posé l'horizon réel sur la ligne rouge (centre de l'écran), dans n'importe
   * quelle direction : on fait basculer la sphère autour de l'axe horizontal perpendiculaire
   * à la vue pour ramener ce point à l'horizon (pitch 0).
   */
  function fixHorizon() {
    if (!viewer) return;
    const pos = viewer.getPosition();
    if (Math.abs(pos.pitch) < 1e-5) return;
    const dh = viewer.dataHelper;
    const from = dh.sphericalCoordsToVector3(pos).normalize();
    const to = dh.sphericalCoordsToVector3({ yaw: pos.yaw, pitch: 0 }).normalize();
    composeRotation(new Quaternion().setFromUnitVectors(from, to));
    viewer.rotate({ yaw: pos.yaw, pitch: 0 });
  }

  /** La direction visée devient l'avant de la photo (yaw 0 dans Panoramax). */
  function fixYaw() {
    if (!viewer) return;
    const pos = viewer.getPosition();
    const dh = viewer.dataHelper;
    const from = dh.sphericalCoordsToVector3({ yaw: pos.yaw, pitch: 0 }).normalize();
    const to = dh.sphericalCoordsToVector3({ yaw: 0, pitch: 0 }).normalize();
    const up = new Vector3(0, 1, 0);
    const angle = Math.atan2(new Vector3().crossVectors(from, to).dot(up), from.dot(to));
    composeRotation(new Quaternion().setFromAxisAngle(up, angle));
    viewer.rotate({ yaw: 0, pitch: pos.pitch });
  }

  function step(axis, delta) {
    setValues({ [axis]: values()[axis] + delta });
  }

  function resetAxis(axis) {
    setValues({ [axis]: 0 });
  }

  function revertCurrent() {
    const item = currentItem();
    if (!item || !state.edits[item.id]) return;
    delete state.edits[item.id];
    persistEdits();
    applyPose();
    refreshUi();
  }

  // ---------------------------------------------------------------------------
  // Synchronisation vers Panoramax
  // ---------------------------------------------------------------------------
  async function patchItem(item) {
    const v = values(item);
    const url = `${apiBase()}/collections/${item.collection || state.collectionId}/items/${item.id}`;
    const res = await apiFetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(panoramaxPayload(v, item.is360)),
    });
    // On repart des valeurs renvoyées par l'API si elles sont présentes.
    const updated = res && res.properties ? featureToItem(Object.assign({ assets: {} }, res)).original : null;
    item.original = updated && res.properties['pers:pitch'] !== undefined ? updated : panoramaxPayload(v, item.is360);
    delete state.edits[item.id];
  }

  async function sync(items) {
    if (state.busy) return;
    if (!settings.token) {
      toast('Renseignez d\'abord votre token Panoramax dans les paramètres.', 'err');
      openSettings();
      return;
    }
    const todo = items.filter(isDirty);
    if (!todo.length) { toast('Aucune modification à envoyer.'); return; }

    state.busy = true;
    let ok = 0;
    const errors = [];
    try {
      for (const [i, item] of todo.entries()) {
        showLoader(`Synchronisation vers Panoramax… ${i + 1} / ${todo.length}`);
        try {
          await patchItem(item);
          ok++;
        } catch (e) {
          console.error(item.id, e);
          errors.push(describeError(e));
          if (e.status === 401) break; // inutile d'insister avec un token invalide
        }
        persistEdits();
        if (i < todo.length - 1) await sleep(SYNC_DELAY_MS);
      }
    } finally {
      hideLoader();
      state.busy = false;
      refreshUi();
    }
    if (errors.length) {
      toast(`${ok} photo(s) mise(s) à jour, ${errors.length} échec(s) : ${errors[0]}`, 'err', 10000);
    } else {
      toast(`Synchronisation terminée : ${ok} photo(s) mise(s) à jour.`, 'ok');
    }
  }

  // ---------------------------------------------------------------------------
  // Mes séquences
  // ---------------------------------------------------------------------------
  async function listMySequences() {
    if (!settings.token) {
      toast('Un token est nécessaire pour lister vos séquences.', 'err');
      openSettings();
      return;
    }
    showLoader('Recherche de vos séquences…');
    try {
      const data = await apiFetch(`${apiBase(settings.instance)}/users/me/collection?limit=1000`);
      const children = (data.links || []).filter(l => l.rel === 'child');
      const list = $('mySeqList');
      list.innerHTML = '';
      if (!children.length) {
        list.innerHTML = '<li>Aucune séquence trouvée.</li>';
      }
      children
        .sort((a, b) => String(b['stats:datetime'] || b.updated || '').localeCompare(String(a['stats:datetime'] || a.updated || '')))
        .forEach(link => {
          const m = (link.href || link.id || '').match(UUID_RE);
          if (!m) return;
          const li = document.createElement('li');
          const title = document.createElement('span');
          title.textContent = link.title || m[0];
          const meta = document.createElement('small');
          const count = link['stats:items'] && link['stats:items'].count;
          const ext = link.extent && link.extent.temporal && link.extent.temporal.interval && link.extent.temporal.interval[0];
          meta.textContent = [count ? `${count} photos` : '', ext && ext[0] ? new Date(ext[0]).toLocaleString() : '', m[0]]
            .filter(Boolean).join(' · ');
          li.append(title, meta);
          li.onclick = () => {
            $('mySeqPanel').hidden = true;
            loadSequence(settings.instance, m[0].toLowerCase());
          };
          list.appendChild(li);
        });
      $('mySeqPanel').hidden = false;
    } catch (e) {
      console.error(e);
      toast('Impossible de lister vos séquences : ' + describeError(e), 'err', 8000);
    } finally {
      hideLoader();
    }
  }

  // ---------------------------------------------------------------------------
  // Interface
  // ---------------------------------------------------------------------------
  function fmt(v) { return (Math.round(v * 100) / 100).toString(); }

  function refreshUi() {
    const item = currentItem();
    const dirtyCount = state.items.filter(isDirty).length;
    $('dirtyCount').textContent = dirtyCount;
    $('syncBtn').disabled = !dirtyCount;
    if (!item) return;

    const v = values(item);
    const dirty = isDirty(item);
    for (const axis of ['pitch', 'roll', 'yaw']) {
      $(axis + 'Val').textContent = fmt(v[axis]);
      $(axis + 'Orig').textContent = same(v[axis], item.original[axis]) ? '' : `(Panoramax : ${fmt(item.original[axis])})`;
    }
    document.querySelectorAll('[data-slider]').forEach(s => { s.value = v[s.dataset.slider]; });

    $('indexInput').value = state.index + 1;
    $('saveOneBtn').disabled = !dirty;
    $('revertBtn').disabled = !dirty;

    const label = $('filename');
    label.textContent = '';
    const link = document.createElement('a');
    link.href = `${state.instance.replace(/\/+$/, '')}/#focus=pic&pic=${item.id}&seq=${item.collection || state.collectionId}`;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = `${state.index + 1}/${state.items.length} · ${item.datetime ? new Date(item.datetime).toLocaleString() : item.id}`;
    label.appendChild(link);
    if (dirty) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'modifiée';
      label.appendChild(badge);
    } else if ((v.pitch || v.roll || v.yaw) && !panoramaxApplies(v, item.is360)) {
      const badge = document.createElement('span');
      badge.className = 'badge warn';
      badge.textContent = 'valeurs ignorées par Panoramax';
      badge.title = 'Panoramax n\'applique la correction que si pitch et roll sont tous deux non nuls. '
        + 'Toute modification enregistrée ici sera envoyée de façon à être appliquée.';
      label.appendChild(badge);
    }

    const status = $('status');
    status.className = 'status' + (dirtyCount ? '' : ' ok');
    status.textContent = dirtyCount ? `${dirtyCount} photo(s) en attente d'envoi` : 'Tout est synchronisé';
  }

  function updateHud() {
    if (viewer) {
      try {
        const pos = viewer.getPosition();
        $('hudYaw').textContent = norm180(radToDeg(pos.yaw)).toFixed(1);
        $('hudPitch').textContent = radToDeg(pos.pitch).toFixed(1);
        $('hudFov').textContent = viewer.state.hFov.toFixed(0);
      } catch (e) { /* visionneuse en cours de chargement */ }
    }
    requestAnimationFrame(updateHud);
  }

  function updateHash() {
    if (!state.collectionId) return;
    const params = new URLSearchParams({ seq: state.collectionId, img: state.index + 1 });
    if (state.instance !== DEFAULT_INSTANCE) params.set('instance', state.instance);
    history.replaceState(null, '', '#' + params.toString());
  }

  // --- Paramètres ---
  function openSettings() {
    $('setInstance').value = settings.instance;
    $('setToken').value = settings.token;
    $('setRemember').checked = settings.remember;
    $('setQuality').value = settings.quality;
    $('settingsDialog').showModal();
  }

  $('settingsDialog').addEventListener('close', () => {
    if ($('settingsDialog').returnValue !== 'ok') return;
    const qualityChanged = settings.quality !== $('setQuality').value;
    settings.instance = ($('setInstance').value.trim() || DEFAULT_INSTANCE).replace(/\/+$/, '').replace(/\/api$/, '');
    settings.token = $('setToken').value.trim();
    settings.remember = $('setRemember').checked;
    settings.quality = $('setQuality').value;
    saveSettings();
    if (!state.collectionId) state.instance = settings.instance;
    if (qualityChanged && state.items.length) showImage(state.index);
    toast('Paramètres enregistrés.', 'ok');
  });

  $('toggleToken').onclick = () => {
    const input = $('setToken');
    input.type = input.type === 'password' ? 'text' : 'password';
  };

  $('clearDataBtn').onclick = () => {
    if (!confirm('Effacer le token, les paramètres et toutes les modifications non synchronisées de ce navigateur ?')) return;
    store.clearAll();
    settings.instance = DEFAULT_INSTANCE;
    settings.token = '';
    settings.remember = false;
    settings.quality = 'sd';
    state.edits = {};
    $('settingsDialog').close();
    if (state.items.length) { applyPose(); refreshUi(); }
    toast('Données locales effacées.', 'ok');
  };

  // --- Boutons ---
  $('settingsBtn').onclick = openSettings;
  $('mySeqBtn').onclick = listMySequences;
  $('mySeqClose').onclick = () => { $('mySeqPanel').hidden = true; };

  $('seqForm').onsubmit = e => {
    e.preventDefault();
    const parsed = parseSequenceInput($('seqInput').value);
    if (!parsed) {
      toast('URL ou identifiant de séquence non reconnu.', 'err');
      return;
    }
    // Un identifiant seul utilise l'instance des paramètres.
    if (!/^https?:/i.test($('seqInput').value.trim())) parsed.instance = settings.instance;
    loadSequence(parsed.instance, parsed.collectionId);
  };

  $('prevBtn').onclick = () => go(-1);
  $('nextBtn').onclick = () => go(1);
  $('indexInput').onchange = e => {
    const n = parseInt(e.target.value, 10);
    if (n >= 1 && n <= state.items.length) showImage(n - 1);
    else refreshUi();
  };
  $('Turn90m').onclick = () => lookAt(-90);
  $('Turn0').onclick = () => lookAt(0);
  $('Turn90').onclick = () => lookAt(90);
  $('Turn180').onclick = () => lookAt(180);
  $('resetView').onclick = resetView;

  $('horizon_fix').onclick = fixHorizon;
  $('yaw_fix').onclick = fixYaw;
  $('fullscreenBtn').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else $('viewer-container').requestFullscreen().catch(() => { /* refusé */ });
  };
  document.addEventListener('fullscreenchange', () => { if (viewer) viewer.autoSize(); });
  document.querySelectorAll('[data-axis]').forEach(b => {
    b.onclick = () => step(b.dataset.axis, Number(b.dataset.step));
  });
  document.querySelectorAll('[data-reset]').forEach(b => {
    b.onclick = () => resetAxis(b.dataset.reset);
  });
  document.querySelectorAll('[data-slider]').forEach(s => {
    s.oninput = () => setValues({ [s.dataset.slider]: Number(s.value) });
  });

  $('revertBtn').onclick = revertCurrent;
  $('saveOneBtn').onclick = () => sync([currentItem()].filter(Boolean));
  $('syncBtn').onclick = () => sync(state.items);

  // --- Raccourcis clavier (positions physiques, comme la version PHP) ---
  const SHORTCUTS = [
    { code: 'KeyQ', azerty: 'A', label: 'FIX horizon (horizon sur la ligne rouge)', run: fixHorizon },
    { code: 'KeyW', azerty: 'Z', label: 'FIX horizon (idem)', run: fixHorizon },
    { code: 'KeyE', azerty: 'E', label: 'Fix heading (la direction visée devient l\'avant)', run: fixYaw },
    { code: 'KeyA', azerty: 'Q', label: 'Rotation -90°', run: () => lookAt(-90) },
    { code: 'KeyS', azerty: 'S', label: 'Rotation 0°', run: () => lookAt(0) },
    { code: 'KeyD', azerty: 'D', label: 'Rotation +90°', run: () => lookAt(90) },
    { code: 'KeyF', azerty: 'F', label: 'Rotation 180°', run: () => lookAt(180) },
    { code: 'KeyZ', azerty: 'W', label: 'Image précédente', run: () => go(-1) },
    { code: 'KeyX', azerty: 'X', label: 'Vue par défaut', run: resetView },
    { code: 'KeyC', azerty: 'C', label: 'Image suivante', run: () => go(1) },
    { code: 'KeyV', azerty: 'V', label: 'Synchroniser vers Panoramax', run: () => sync(state.items) },
    { code: 'PageUp', azerty: 'PgUp', label: 'Image précédente', run: () => go(-1) },
    { code: 'PageDown', azerty: 'PgDn', label: 'Image suivante', run: () => go(1) },
    { code: 'ArrowLeft', azerty: '←', label: 'Tourner la vue à gauche', run: () => nudgeView(-5, 0) },
    { code: 'ArrowRight', azerty: '→', label: 'Tourner la vue à droite', run: () => nudgeView(5, 0) },
    { code: 'ArrowUp', azerty: '↑', label: 'Regarder plus haut (0,2°)', run: () => nudgeView(0, 0.2) },
    { code: 'ArrowDown', azerty: '↓', label: 'Regarder plus bas (0,2°)', run: () => nudgeView(0, -0.2) },
  ];
  function nudgeView(dYaw, dPitch) {
    if (!viewer) return;
    const pos = viewer.getPosition();
    viewer.rotate({ yaw: pos.yaw + degToRad(dYaw), pitch: pos.pitch + degToRad(dPitch) });
  }

  const shortcutByCode = Object.fromEntries(SHORTCUTS.map(s => [s.code, s]));

  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!state.items.length || state.busy) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if ($('settingsDialog').open) return;
    const sc = shortcutByCode[e.code];
    if (!sc) return;
    e.preventDefault();
    sc.run();
  });

  async function renderShortcuts() {
    // Affiche la touche réelle selon la disposition du clavier quand le navigateur le permet.
    let layout = null;
    try {
      if (navigator.keyboard && navigator.keyboard.getLayoutMap) layout = await navigator.keyboard.getLayoutMap();
    } catch (e) { /* non supporté */ }
    const list = $('shortcutList');
    list.innerHTML = '';
    for (const s of SHORTCUTS) {
      const li = document.createElement('li');
      const kbd = document.createElement('kbd');
      const key = layout && layout.get(s.code);
      kbd.textContent = key ? key.toUpperCase() : s.azerty;
      li.append(kbd, ' ' + s.label);
      list.appendChild(li);
    }
  }

  window.addEventListener('beforeunload', e => {
    // Les modifications sont conservées localement, mais on prévient quand même.
    if (state.items.some(isDirty)) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------------------------------------------------------------------------
  // Démarrage
  // ---------------------------------------------------------------------------
  function init() {
    $('controls').classList.add('disabled');
    renderShortcuts();
    refreshUi();
    requestAnimationFrame(updateHud);

    const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
    const seq = hash.get('seq');
    if (seq && UUID_RE.test(seq)) {
      const instance = hash.get('instance') || settings.instance;
      loadSequence(instance, seq.match(UUID_RE)[0].toLowerCase(), (parseInt(hash.get('img'), 10) || 1) - 1);
      return;
    }
    const last = store.get('lastSequence', null);
    if (last && last.collectionId) $('seqInput').value = last.collectionId;
    if (!settings.token) toast('Astuce : ajoutez votre token Panoramax via ⚙ pour pouvoir enregistrer.', '', 6000);
  }

  init();
})();
