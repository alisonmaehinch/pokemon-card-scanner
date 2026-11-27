/* Card Scanner: scan a Pokémon card, look it up, save it to a Google Sheet. */
(() => {
  'use strict';

  const API = 'https://api.tcgdex.net/v2/en';
  const CARD_RATIO = 63 / 88; // width / height of a trading card

  const $ = (id) => document.getElementById(id);
  const els = {
    video: $('video'), canvas: $('canvas'), snap: $('snap'), fileInput: $('file-input'),
    cameraOff: $('camera-off'), startCamera: $('start-camera'),
    status: $('status'), cameraStep: $('camera-step'), resultsStep: $('results-step'),
    confirmStep: $('confirm-step'), results: $('results'), readText: $('read-text'),
    searchForm: $('search-form'), searchName: $('search-name'), searchNumber: $('search-number'),
    cImg: $('c-img'), cName: $('c-name'), cSet: $('c-set'), cRarity: $('c-rarity'),
    cVariant: $('c-variant'), cPrice: $('c-price'), cPriceEu: $('c-price-eu'),
    cCondition: $('c-condition'), cQty: $('c-qty'), cNotes: $('c-notes'),
    save: $('save'), cancelConfirm: $('cancel-confirm'), backToCamera: $('back-to-camera'),
    invList: $('inv-list'), invSummary: $('inv-summary'), exportCsv: $('export-csv'),
    openSheet: $('open-sheet'), retrySync: $('retry-sync'),
    setSheetUrl: $('set-sheet-url'), setSheetView: $('set-sheet-view'), setAutoAdd: $('set-auto-add'), setCondition: $('set-condition'),
    saveSettings: $('save-settings'), testSheet: $('test-sheet'), settingsMsg: $('settings-msg'),
    toast: $('toast'),
  };

  // ---------- storage helpers ----------
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
      catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
    },
  };
  const settings = () => ({ sheetUrl: '', sheetView: '', autoAdd: true, defaultCondition: 'Near Mint', ...store.get('settings', {}) });
  const inventory = () => store.get('inventory', []);
  const saveInventory = (list) => store.set('inventory', list);

  // ---------- UI helpers ----------
  let toastTimer;
  function toast(msg, kind = 'ok', action = null) {
    els.toast.textContent = msg;
    if (action) {
      const b = document.createElement('button');
      b.className = 'toast-action';
      b.textContent = action.label;
      b.addEventListener('click', () => { els.toast.classList.add('hidden'); action.onClick(); });
      els.toast.appendChild(b);
    }
    els.toast.className = `toast ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.add('hidden'), action ? 7000 : 3200);
  }
  let statusTimer;
  function setStatus(msg, isErr = false, hideAfterMs = 0) {
    clearTimeout(statusTimer);
    if (!msg) { els.status.classList.add('hidden'); return; }
    els.status.textContent = msg;
    els.status.className = `status${isErr ? ' err' : ''}`;
    if (hideAfterMs) statusTimer = setTimeout(() => els.status.classList.add('hidden'), hideAfterMs);
  }
  function showStep(step) {
    els.cameraStep.classList.toggle('hidden', step !== 'camera');
    els.resultsStep.classList.toggle('hidden', step !== 'results');
    els.confirmStep.classList.toggle('hidden', step !== 'confirm');
    if (step === 'camera') startCamera(); else stopCamera();
    window.scrollTo({ top: 0 });
  }
  const money = (n, cur = 'USD') =>
    n == null || isNaN(n) ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(n);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- tabs ----------
  document.querySelectorAll('.tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${btn.dataset.tab}`));
      if (btn.dataset.tab === 'scan' && !els.cameraStep.classList.contains('hidden')) startCamera();
      else stopCamera();
      if (btn.dataset.tab === 'inventory') renderInventory();
      if (btn.dataset.tab === 'settings') loadSettingsForm();
    });
  });

  // ---------- camera ----------
  let stream = null;
  async function startCamera() {
    if (stream || !navigator.mediaDevices?.getUserMedia) {
      if (!navigator.mediaDevices?.getUserMedia) els.cameraOff.classList.remove('hidden');
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
        audio: false,
      });
      els.video.srcObject = stream;
      await els.video.play().catch(() => {});
      els.cameraOff.classList.add('hidden');
      setupZoom();
      placeGuide();
    } catch (e) {
      console.warn('camera', e);
      els.cameraOff.classList.remove('hidden');
    }
  }
  function stopCamera() {
    if (!stream) return;
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
    els.video.srcObject = null;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopCamera();
    else if (document.querySelector('#tab-scan.active') && !els.cameraStep.classList.contains('hidden')) startCamera();
  });
  els.startCamera.addEventListener('click', startCamera);

  // ---------- movable frame + zoom ----------
  const wrap = document.querySelector('.camera-wrap');
  const guide = $('guide');
  const sizeSlider = $('guide-size');
  const zoomSlider = $('zoom');
  const DEFAULT_GUIDE = { x: 0.5, y: 0.5, w: 0.72 };
  let g = { ...DEFAULT_GUIDE, ...store.get('guide', {}) };
  let zoom = 1, hwZoom = null; // hwZoom = camera's own zoom range, when it has one

  function placeGuide() {
    const W = wrap.clientWidth, H = wrap.clientHeight;
    if (!W || !H) return;
    // Keep the frame inside the camera view.
    const maxW = Math.min(0.98, (H * 0.98 * CARD_RATIO) / W);
    g.w = Math.max(0.3, Math.min(g.w, maxW));
    const halfW = g.w / 2, halfH = (g.w * W / CARD_RATIO) / H / 2;
    g.x = Math.max(halfW, Math.min(1 - halfW, g.x));
    g.y = Math.max(halfH, Math.min(1 - halfH, g.y));
    guide.style.left = `${g.x * 100}%`;
    guide.style.top = `${g.y * 100}%`;
    guide.style.width = `${g.w * 100}%`;
    sizeSlider.max = Math.round(maxW * 100);
    sizeSlider.value = Math.round(g.w * 100);
  }
  const saveGuide = () => store.set('guide', g);
  window.addEventListener('resize', placeGuide);
  sizeSlider.addEventListener('input', () => { g.w = sizeSlider.value / 100; placeGuide(); saveGuide(); });

  // One finger drags the frame; two fingers pinch to resize it.
  const pointers = new Map();
  let start = null;
  wrap.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    wrap.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    start = { g: { ...g }, pts: new Map([...pointers].map(([k, v]) => [k, { ...v }])) };
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId) || !start) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const W = wrap.clientWidth, H = wrap.clientHeight;
    const ids = [...pointers.keys()];
    if (ids.length === 1) {
      const p0 = start.pts.get(ids[0]); if (!p0) return;
      const p = pointers.get(ids[0]);
      g.x = start.g.x + (p.x - p0.x) / W;
      g.y = start.g.y + (p.y - p0.y) / H;
    } else if (ids.length >= 2) {
      const [a, b] = ids.slice(0, 2);
      const a0 = start.pts.get(a), b0 = start.pts.get(b); if (!a0 || !b0) return;
      const d0 = Math.hypot(a0.x - b0.x, a0.y - b0.y), d1 = Math.hypot(pointers.get(a).x - pointers.get(b).x, pointers.get(a).y - pointers.get(b).y);
      if (d0 > 10) g.w = start.g.w * (d1 / d0);
    }
    placeGuide();
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    start = pointers.size ? { g: { ...g }, pts: new Map([...pointers].map(([k, v]) => [k, { ...v }])) } : null;
    saveGuide();
  };
  wrap.addEventListener('pointerup', endPointer);
  wrap.addEventListener('pointercancel', endPointer);
  // iOS Safari: stop the page itself from zooming on pinch.
  wrap.addEventListener('gesturestart', (e) => e.preventDefault());

  function setupZoom() {
    const track = stream?.getVideoTracks()[0];
    const caps = track?.getCapabilities ? track.getCapabilities() : {};
    if (caps.zoom && caps.zoom.max > caps.zoom.min) {
      hwZoom = { min: caps.zoom.min, max: Math.min(caps.zoom.max, caps.zoom.min * 5) };
      zoomSlider.min = hwZoom.min; zoomSlider.max = hwZoom.max;
    } else {
      hwZoom = null; zoomSlider.min = 1; zoomSlider.max = 3;
    }
    zoom = Math.max(+zoomSlider.min, Math.min(+zoomSlider.max, store.get('zoom', 1)));
    zoomSlider.value = zoom;
    applyZoom();
  }
  async function applyZoom() {
    const track = stream?.getVideoTracks()[0];
    if (hwZoom && track) {
      els.video.style.transform = '';
      try { await track.applyConstraints({ advanced: [{ zoom }] }); } catch { /* ignore */ }
    } else {
      els.video.style.transform = zoom > 1 ? `scale(${zoom})` : '';
    }
  }
  zoomSlider.addEventListener('input', () => { zoom = +zoomSlider.value; store.set('zoom', zoom); applyZoom(); });
  $('guide-reset').addEventListener('click', () => {
    g = { ...DEFAULT_GUIDE }; placeGuide(); saveGuide();
    zoom = +zoomSlider.min; zoomSlider.value = zoom; store.set('zoom', zoom); applyZoom();
  });
  placeGuide();

  // Crop the area inside the on-screen frame from the live video.
  function grabGuideArea() {
    const v = els.video;
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return null;
    const box = v.getBoundingClientRect();     // includes the digital-zoom scale
    const gr = guide.getBoundingClientRect();
    const scale = Math.max(box.width / vw, box.height / vh); // object-fit: cover
    const offX = (vw - box.width / scale) / 2, offY = (vh - box.height / scale) / 2;
    const border = 3;
    const sx = offX + (gr.left + border - box.left) / scale;
    const sy = offY + (gr.top + border - box.top) / scale;
    const sw = (gr.width - 2 * border) / scale, sh = (gr.height - 2 * border) / scale;
    const c = document.createElement('canvas');
    const k = Math.max(1, 900 / sw); // small crops get upscaled a bit for the text reader
    c.width = Math.round(sw * k); c.height = Math.round(sh * k);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(v, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c;
  }

  window.__cardScanner = { grabGuideArea, readCard: (c) => readCard(c), parseName: (t) => parseName(t), parseNumber: (t) => parseNumber(t), findCards: (q) => findCards(q), matchNames: (t) => matchNames(t) }; // for testing

  // From a photo: center-crop to card shape.
  function cropImageToCard(img) {
    const iw = img.naturalWidth, ih = img.naturalHeight;
    let w = iw, h = iw / CARD_RATIO;
    if (h > ih) { h = ih; w = ih * CARD_RATIO; }
    const c = document.createElement('canvas');
    c.width = Math.round(w); c.height = Math.round(h);
    c.getContext('2d').drawImage(img, (iw - w) / 2, (ih - h) / 2, w, h, 0, 0, c.width, c.height);
    return c;
  }

  // Cut a region (fractions of the card) and prep it for OCR.
  // mode: 'gray' (default), 'bin' (black and white), 'inv' (gray, flipped for light text on dark)
  function region(card, x0, y0, x1, y1, targetW = 1400, mode = 'gray') {
    const binarize = mode === 'bin' || mode === true;
    const sx = card.width * x0, sy = card.height * y0;
    const sw = card.width * (x1 - x0), sh = card.height * (y1 - y0);
    const k = Math.max(1, targetW / sw);
    const c = document.createElement('canvas');
    c.width = Math.round(sw * k); c.height = Math.round(sh * k);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(card, sx, sy, sw, sh, 0, 0, c.width, c.height);
    // grayscale + contrast stretch
    const d = ctx.getImageData(0, 0, c.width, c.height);
    const px = d.data;
    let min = 255, max = 0;
    for (let i = 0; i < px.length; i += 4) {
      const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      px[i] = g;
      if (g < min) min = g;
      if (g > max) max = g;
    }
    const range = Math.max(1, max - min);
    const hist = new Array(256).fill(0);
    for (let i = 0; i < px.length; i += 4) {
      const g = ((px[i] - min) / range) * 255;
      px[i] = g; hist[g | 0]++;
    }
    let t = 128, dark = 0;
    if (binarize) {
      // Otsu threshold: the split that best separates text from background.
      const total = px.length / 4;
      let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
      let sumB = 0, wB = 0, best = -1;
      for (let i = 0; i < 256; i++) {
        wB += hist[i]; if (!wB) continue;
        const wF = total - wB; if (!wF) break;
        sumB += i * hist[i];
        const mB = sumB / wB, mF = (sum - sumB) / wF;
        const between = wB * wF * (mB - mF) ** 2;
        if (between > best) { best = between; t = i; }
      }
      for (let i = 0; i < 256; i++) if (i < t) dark += hist[i];
    }
    // Text reads best dark-on-light; flip when most of the strip is dark.
    const invert = mode === 'inv' || (binarize && dark > px.length / 8);
    for (let i = 0; i < px.length; i += 4) {
      let g = binarize ? (px[i] < t ? 0 : 255) : px[i];
      if (invert) g = 255 - g;
      px[i] = px[i + 1] = px[i + 2] = g;
    }
    ctx.putImageData(d, 0, 0);
    return c;
  }

  // ---------- OCR ----------
  let workerPromise = null;
  function getWorker() {
    if (!workerPromise) {
      if (!window.Tesseract) return Promise.reject(new Error('Text reader did not load. Check your internet connection.'));
      workerPromise = Tesseract.createWorker('eng', 1, {
        logger: (m) => {
          if (busy && m.status && /loading|initializ/i.test(m.status)) setStatus('Getting the text reader ready (first scan only, about 10 seconds)…');
        },
      });
      workerPromise.catch(() => { workerPromise = null; });
    }
    return workerPromise;
  }

  // Read the name (top line) and the collector number (bottom corners).
  // Tries a few crops and settings and stops at the first one that makes sense.
  async function readCard(card) {
    const worker = await getWorker();
    const set = (p) => worker.setParameters(p).catch(() => {});

    let nameText = '';
    await set({ tessedit_char_whitelist: '', tessedit_pageseg_mode: '7' }); // one line of text
    for (const [x0, y0, x1, y1, bin] of [
      [0.04, 0.025, 0.78, 0.115, false],
      [0.04, 0.025, 0.78, 0.115, true],
      [0.12, 0.03, 0.72, 0.105, true],   // newer cards: name sits right of the stage badge
    ]) {
      const t = (await worker.recognize(region(card, x0, y0, x1, y1, 1400, bin))).data.text || '';
      if (parseName(t).replace(/[^A-Za-z]/g, '').length >= 3) { nameText = t; break; }
      if (!nameText) nameText = t;
    }

    let numText = '';
    await set({ tessedit_char_whitelist: '0123456789/ABCDEFGHIJKLMNOPQRSTUVWXYZ', tessedit_pageseg_mode: '11' }); // scattered text
    for (const [x0, y0, x1, y1, mode] of [
      [0.0, 0.90, 0.35, 0.97, 'gray'],   // bottom-left (most cards since 2011)
      [0.0, 0.93, 0.30, 0.98, 'gray'],
      [0.0, 0.90, 0.35, 0.97, 'inv'],    // white numbers on full-art cards
      [0.65, 0.88, 1.0, 0.97, 'gray'],   // bottom-right (older cards)
      [0.65, 0.88, 1.0, 0.97, 'inv'],
      [0.0, 0.86, 1.0, 0.985, 'bin'],    // whole bottom strip
    ]) {
      const t = (await worker.recognize(region(card, x0, y0, x1, y1, 1600, mode))).data.text || '';
      if (parseNumber(t)) { numText = t; break; }
      numText += '\n' + t;
    }
    await set({ tessedit_char_whitelist: '', tessedit_pageseg_mode: '3' });
    return { nameText, numText };
  }

  const STOP_WORDS = new Set(['basic', 'stage', 'stagel', 'stage1', 'stage2', 'hp', 'evolves', 'from', 'put', 'on', 'the', 'pokemon', 'pokémon', 'trainer', 'item', 'supporter', 'energy', 'tool']);
  function parseName(text) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    let best = '';
    for (const line of lines) {
      const words = line
        .replace(/[|_~=+*#@$%^&(){}\[\]<>\\]/g, ' ')
        .split(/\s+/)
        .map((w) => w.replace(/^[^A-Za-zÀ-ÿ]+|[^A-Za-zÀ-ÿ.'’-]+$/g, ''))
        .filter((w) => w.length >= 2 && /[A-Za-z]/.test(w) && !STOP_WORDS.has(w.toLowerCase()) && !/\d/.test(w));
      const cand = words.slice(0, 3).join(' ');
      if (cand.replace(/[^A-Za-z]/g, '').length > best.replace(/[^A-Za-z]/g, '').length) best = cand;
    }
    return best;
  }

  function parseNumber(text) {
    const t = text.toUpperCase().replace(/O(?=\d)/g, '0').replace(/(\d)O/g, '$10').replace(/[IL|](?=\d)/g, '1');
    // Trainer Gallery / Galarian Gallery: TG05/TG30, GG01/GG70 (T is often read as 7, I or 1)
    let m = t.match(/([T7I1F]?G|GG)\s?(\d{1,2})[ \t]*\/[ \t]*[T7I1]?G\s?(\d{2})/);
    if (m) {
      const prefix = m[1] === 'GG' ? 'GG' : 'TG';
      return { number: prefix + m[2].padStart(2, '0'), total: null };
    }
    m = t.match(/([A-Z]{2}\d{1,3})[ \t]*\/[ \t]*([A-Z]{2}\d{1,3})/);
    if (m) return { number: m[1], total: null };
    // Normal numbers: 4/102, 054/091 (same line only, so stray digits don't pair up)
    m = t.match(/(\d{1,3})[ \t]*\/[ \t]*(\d{2,3})/);
    if (m) {
      let n = m[1];
      // A stray mark before the number is often read as a digit ("514/181" for "14/181").
      if (n.length === 3 && parseInt(n, 10) > parseInt(m[2], 10) + 120) n = n.slice(1);
      return { number: String(parseInt(n, 10)), total: parseInt(m[2], 10) };
    }
    // Promos: SWSH123, SM45, SV045, XY12 …
    m = t.match(/\b(SWSH|SVP|SV|SM|XY|BW|HGSS|DP)\s?(\d{1,3})\b/);
    if (m) return { number: m[1] + m[2].padStart(m[1] === 'SV' || m[1] === 'SVP' ? 3 : 2, '0'), total: null, promo: true };
    return null;
  }

  // ---------- API (TCGdex: free, no key) ----------
  async function getJSON(path) {
    let res;
    try { res = await fetch(`${API}/${path}`); }
    catch { throw new Error('Could not reach the card database. Check your internet connection and try again.'); }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`The card database had a problem (${res.status}). Try again in a minute.`);
    return res.json();
  }

  // Turn a TCGdex card into the shape the rest of the app uses.
  function normalize(d) {
    const tp = d.pricing?.tcgplayer || {};
    const prices = {};
    Object.entries(tp).forEach(([k, v]) => {
      if (v && typeof v === 'object') prices[k] = { market: v.marketPrice ?? v.midPrice ?? null, productId: v.productId };
    });
    const productId = Object.values(prices).find((p) => p.productId)?.productId;
    const cm = d.pricing?.cardmarket;
    return {
      id: d.id,
      name: d.name,
      number: d.localId,
      rarity: d.rarity || '',
      set: { id: d.set?.id || '', name: d.set?.name || '', printedTotal: d.set?.cardCount?.official ?? '' },
      images: d.image ? { small: `${d.image}/low.webp`, large: `${d.image}/high.webp` } : {},
      tcgplayer: { url: productId ? `https://www.tcgplayer.com/product/${productId}` : '', prices },
      cardmarket: cm ? { prices: { trendPrice: cm.trend ?? cm.avg ?? null, reverseHoloTrend: cm['trend-holo'] || null } } : null,
    };
  }

  let setsPromise = null;
  async function allSets() {
    if (!setsPromise) setsPromise = getJSON('sets').catch((e) => { setsPromise = null; throw e; });
    return (await setsPromise) || [];
  }
  // TCGdex lists sets oldest first; a higher number means a newer set.
  async function setOrder() {
    const sets = await allSets().catch(() => []);
    return new Map(sets.map((x, i) => [x.id, i]));
  }
  async function setsWithTotal(total) {
    const sets = await allSets();
    return new Set(sets.filter((x) => x.cardCount?.official === total).map((x) => x.id));
  }

  function similarity(a, b) {
    a = a.toLowerCase().replace(/[^a-z0-9]/g, ''); b = b.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!a || !b) return 0;
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return 1 - dp[a.length][b.length] / Math.max(a.length, b.length);
  }
  const sameNumber = (localId, n) => {
    const a = String(localId).toUpperCase(), b = String(n).toUpperCase();
    if (a === b) return true;
    return /^\d+$/.test(a) && /^\d+$/.test(b) && parseInt(a, 10) === parseInt(b, 10);
  };

  // ---------- name matching against every real card name ----------
  // The text reader often garbles a letter or two ("Fcharizard", "Chaiizaidva").
  // Comparing what it read with the list of all card names fixes most of that.
  const NAMES_KEY = 'cardNames-v1';
  let namesPromise = null;
  function getAllNames() {
    if (!namesPromise) {
      namesPromise = (async () => {
        const cached = store.get(NAMES_KEY, null);
        if (cached && cached.names?.length && Date.now() - cached.at < 7 * 864e5) return cached.names;
        const all = (await getJSON('cards')) || [];
        const names = [...new Set(all.map((c) => c.name).filter(Boolean))];
        if (names.length) store.set(NAMES_KEY, { at: Date.now(), names });
        return names.length ? names : (cached?.names || []);
      })().catch((e) => { namesPromise = null; const c = store.get(NAMES_KEY, null); if (c?.names) return c.names; throw e; });
    }
    return namesPromise;
  }
  const norm = (t) => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
  function lev(a, b) {
    const m = a.length, n = b.length;
    let prev = Array.from({ length: n + 1 }, (_, j) => j), cur = new Array(n + 1);
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      [prev, cur] = [cur, prev];
    }
    return prev[n];
  }
  const readLines = (text) => text.split('\n').map(norm).filter((l) => l.length >= 3);
  // How well a (normalized) card name appears somewhere in the read lines, 0..1.
  function nameFit(n, lines) {
    if (n.length < 3) return 0;
    let best = 0;
    for (const l of lines) {
      if (l.includes(n)) return 1;
      if (n.length > l.length + 2) continue;
      for (let len = Math.max(3, n.length - 1); len <= n.length + 1; len++) {
        for (let i = 0; i + len <= l.length; i++) {
          const sc = 1 - lev(n, l.slice(i, i + len)) / Math.max(n.length, len);
          if (sc > best) best = sc;
        }
      }
    }
    return best;
  }
  // Best matching card names for some read text, best first: [{ name, score 0..1 }].
  // Names that look the same once symbols are dropped (e.g. "Charizard δ") are kept together.
  async function matchNames(text) {
    const lines = readLines(text);
    if (!lines.length) return [];
    const groups = new Map();
    for (const name of await getAllNames()) {
      const n = norm(name);
      if (!groups.has(n)) groups.set(n, []);
      groups.get(n).push(name);
    }
    const out = [];
    for (const [n, list] of groups) {
      const score = nameFit(n, lines);
      if (score >= 0.7) out.push({ names: list, name: list[0], score, len: n.length });
    }
    out.sort((x, y) => (y.score - x.score) || (y.len - x.len));
    return out.slice(0, 3).map((o) => ({ ...o, lines }));
  }

  // names: [{name, score}] from matchNames. typed: a name typed in the search box (partial is fine).
  async function findCards({ names = [], typed = '', num = null }) {
    const sets = await allSets().catch(() => []);
    const setTotal = new Map(sets.map((x) => [x.id, x.cardCount?.official]));
    const order = new Map(sets.map((x, i) => [x.id, i]));
    const setOf = (c) => c.id.slice(0, c.id.lastIndexOf('-'));
    const lines = names[0]?.lines || [];
    const lists = [];
    for (const g of names.slice(0, 3)) for (const nm of g.names || [g.name]) lists.push(getJSON(`cards?name=eq:${encodeURIComponent(nm)}`));
    if (typed) lists.push(getJSON(`cards?name=${encodeURIComponent(typed)}`));
    if (num) {
      const n = /^\d+$/.test(num.number) ? String(parseInt(num.number, 10)) : num.number;
      lists.push(getJSON(`cards?localId=${encodeURIComponent(n)}`).then((l) => (l || []).filter((c) => sameNumber(c.localId, num.number))));
    }
    const seen = new Map();
    (await Promise.all(lists)).forEach((l) => (l || []).forEach((c) => seen.set(c.id, c)));
    let brief = [...seen.values()];
    if (!brief.length) return [];
    // Score each card: how well the name fits, whether the number fits, whether the set size fits.
    brief.forEach((c) => {
      const ns = lines.length ? nameFit(norm(c.name), lines) : (typed ? similarity(typed, c.name) : 0);
      const numOk = num && sameNumber(c.localId, num.number);
      const totOk = num?.total && setTotal.get(setOf(c)) === num.total;
      c._score = 3 * ns + (numOk ? 1 : 0) + (totOk ? 0.5 : 0) + (order.get(setOf(c)) ?? 0) / 100000;
      c._name = ns; c._num = !!numOk;
    });
    brief.sort((a, b) => b._score - a._score);
    const top = brief.slice(0, 16);
    const details = await Promise.all(top.map((c) => getJSON(`cards/${encodeURIComponent(c.id)}`).catch(() => null)));
    return details.map((d, i) => d && Object.assign(normalize(d), { _score: top[i]._score, _name: top[i]._name, _num: top[i]._num })).filter(Boolean);
  }

  // ---------- prices ----------
  const VARIANT_LABELS = {
    normal: 'Normal', holofoil: 'Holofoil', reverseHolofoil: 'Reverse Holo', 'reverse-holofoil': 'Reverse Holo',
    '1stEditionHolofoil': '1st Edition Holo', '1st-edition-holofoil': '1st Edition Holo',
    '1stEditionNormal': '1st Edition', '1st-edition-normal': '1st Edition',
    unlimitedHolofoil: 'Unlimited Holo', 'unlimited-holofoil': 'Unlimited Holo',
  };
  const prettify = (k) => k.replace(/[-_]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
  function variantsOf(card) {
    const prices = card.tcgplayer?.prices || {};
    const list = Object.entries(prices).map(([key, p]) => ({ key, label: VARIANT_LABELS[key] || prettify(key), usd: p.market ?? null }));
    if (!list.length) list.push({ key: 'default', label: 'Standard', usd: null });
    return list;
  }
  function eurOf(card, variantKey) {
    const p = card.cardmarket?.prices;
    if (!p) return null;
    if (/reverse/i.test(variantKey || '') && p.reverseHoloTrend) return p.reverseHoloTrend;
    return p.trendPrice ?? null;
  }
  const bestPrice = (card) => {
    const vs = variantsOf(card).filter((v) => v.usd != null);
    return vs.length ? Math.max(...vs.map((v) => v.usd)) : null;
  };

  // ---------- scan flow ----------
  let busy = false;
  async function runScan(card) {
    if (busy) return;
    busy = true; els.snap.disabled = true; els.snap.textContent = 'Reading…';
    try {
      setStatus('Reading the card…');
      const { nameText, numText } = await readCard(card);
      const num = parseNumber(numText);
      setStatus('Matching the name…');
      const names = await matchNames(nameText);
      const name = names[0]?.name || '';
      if (!name && !num) {
        setStatus('I could not read that card. Try again with less glare, or type the name below.', true, 6000);
        return;
      }
      els.readText.textContent = `Read: ${[name, num && (num.total ? `${num.number}/${num.total}` : num.number)].filter(Boolean).join(' · ')}`;
      setStatus('Looking it up…');
      const cards = await findCards({ names, num });
      const sure = confidentMatch(cards);
      if (sure && settings().autoAdd) await autoAdd(sure);
      else showResults(cards);
    } catch (e) {
      console.error(e);
      setStatus(e.message || 'Something went wrong.', true);
    } finally {
      busy = false; els.snap.disabled = false; els.snap.textContent = 'Scan card';
    }
  }

  // A scan is "sure" when only one card fits, or the best one clearly beats the rest
  // and its number matched what was printed on the card.
  function confidentMatch(cards) {
    if (!cards.length) return null;
    const [a, b] = cards;
    // Sure = the name was read well AND the number matched, and nothing else comes close.
    if (!a._num || a._name < 0.85) return null;
    if (b && b._score > a._score - 0.4) return null;
    return a;
  }

  function defaultVariant(card) {
    const vs = variantsOf(card);
    return vs.find((v) => v.key === 'normal' && v.usd != null) || vs.find((v) => v.key === 'holofoil' && v.usd != null)
      || vs.find((v) => v.usd != null) || vs[0];
  }

  async function autoAdd(card) {
    selected = card;
    const v = defaultVariant(card);
    const row = buildRow({ variantKey: v.key, condition: settings().defaultCondition, quantity: 1, notes: '' });
    setStatus(`Adding ${card.name}…`);
    const msg = await saveRow(row);
    selected = null;
    setStatus(`Added ${row.name} · ${row.set} ${row.number} · ${row.variant} · ${money(row.priceUSD)}`, false, 5000);
    toast(msg.text, msg.kind, { label: 'Undo', onClick: () => undoRow(row) });
  }

  els.snap.addEventListener('click', async () => {
    if (!stream) {
      await startCamera();
      if (!stream) {
        setStatus('The camera is blocked. On iPhone: Settings > Safari > Camera > Allow, then reopen the app. Or tap "Use a photo".', true);
        return;
      }
      setStatus('Camera is on. Line up the card and tap Scan card again.');
      return;
    }
    const card = grabGuideArea();
    if (!card) { setStatus('Camera is still starting. Try again in a second.', true); return; }
    runScan(card);
  });

  els.fileInput.addEventListener('change', () => {
    const f = els.fileInput.files?.[0];
    if (!f) return;
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(img.src); runScan(cropImageToCard(img)); };
    img.onerror = () => setStatus('Could not open that photo.', true);
    img.src = URL.createObjectURL(f);
    els.fileInput.value = '';
  });

  els.searchForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = els.searchName.value.trim();
    const numRaw = els.searchNumber.value.trim();
    const num = numRaw ? (parseNumber(numRaw.toUpperCase()) || { number: numRaw.replace(/^0+(?=\d)/, ''), total: null }) : null;
    if (!name && !num) return;
    els.searchName.blur(); els.searchNumber.blur();
    try {
      setStatus('Looking it up…');
      els.readText.textContent = `Search: ${[name, numRaw].filter(Boolean).join(' · ')}`;
      const names = name ? await matchNames(name) : [];
      showResults(await findCards({ names, typed: name, num }));
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  let currentResults = [];
  function showResults(cards) {
    currentResults = cards;
    if (!cards.length) {
      setStatus('No matching cards found. Try again, or type the name below.', true);
      return;
    }
    setStatus('');
    els.results.innerHTML = cards.map((c, i) => `
      <button class="card-opt" data-i="${i}">
        <img loading="lazy" src="${esc(c.images?.small)}" alt="" onerror="this.style.visibility='hidden'">
        <span class="t">${esc(c.name)}</span>
        <span class="s">${esc(c.set.name)} · ${esc(c.number)}/${esc(c.set.printedTotal)}</span>
        <span class="p">${money(bestPrice(c))}</span>
      </button>`).join('');
    showStep('results');
  }
  els.results.addEventListener('click', (e) => {
    const btn = e.target.closest('.card-opt');
    if (btn) showConfirm(currentResults[+btn.dataset.i]);
  });
  els.backToCamera.addEventListener('click', () => { setStatus(''); showStep('camera'); });

  // ---------- confirm & save ----------
  let selected = null;
  function showConfirm(card) {
    selected = card;
    els.cImg.src = card.images?.large || card.images?.small || '';
    els.cName.textContent = card.name;
    els.cSet.textContent = `${card.set.name} · ${card.number}/${card.set.printedTotal}`;
    els.cRarity.textContent = card.rarity || '';
    const vs = variantsOf(card);
    els.cVariant.innerHTML = vs.map((v) => `<option value="${esc(v.key)}">${esc(v.label)}${v.usd != null ? ` · ${money(v.usd)}` : ''}</option>`).join('');
    els.cQty.value = 1; els.cNotes.value = '';
    updatePrice();
    showStep('confirm');
  }
  function updatePrice() {
    const v = variantsOf(selected).find((x) => x.key === els.cVariant.value);
    els.cPrice.textContent = v?.usd != null ? `${money(v.usd)} market` : 'No TCGplayer price';
    const eur = eurOf(selected, v?.key);
    els.cPriceEu.textContent = eur != null ? `Cardmarket trend: ${money(eur, 'EUR')}` : '';
  }
  els.cVariant.addEventListener('change', updatePrice);
  els.cancelConfirm.addEventListener('click', () => showStep('results'));

  function buildRow(o = null) {
    const c = selected;
    const vKey = o ? o.variantKey : els.cVariant.value;
    const v = variantsOf(c).find((x) => x.key === vKey) || variantsOf(c)[0];
    const qty = Math.max(1, parseInt(o ? o.quantity : els.cQty.value, 10) || 1);
    return {
      localId: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)),
      dateAdded: new Date().toISOString(),
      cardId: c.id,
      name: c.name,
      set: c.set.name,
      setCode: c.set.ptcgoCode || c.set.id,
      number: `${c.number}/${c.set.printedTotal}`,
      rarity: c.rarity || '',
      variant: v.label,
      variantKey: v.key,
      condition: o ? o.condition : els.cCondition.value,
      quantity: qty,
      priceUSD: v.usd,
      priceEUR: eurOf(c, v.key),
      tcgplayerUrl: c.tcgplayer?.url || '',
      imageUrl: c.images?.small || '',
      notes: o ? o.notes : els.cNotes.value.trim(),
      synced: false,
    };
  }

  function sendToSheet(row) {
    const { synced, ...card } = row;
    return postToSheet({ action: 'add', card });
  }
  async function postToSheet(payload) {
    const url = settings().sheetUrl;
    if (!url) return false;
    const body = JSON.stringify(payload);
    try {
      // text/plain keeps this a "simple" request so Google accepts it from a web page.
      const res = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
      const data = await res.json();
      return !!data.ok;
    } catch (e) {
      // Fallback: send without reading the reply. The sheet ignores repeats of the same scan.
      try { await fetch(url, { method: 'POST', body, mode: 'no-cors' }); return true; }
      catch { return false; }
    }
  }

  // Save on the phone, then send to the Sheet. Returns a message for the toast.
  async function saveRow(row) {
    const list = inventory(); list.unshift(row); saveInventory(list);
    const hasSheet = !!settings().sheetUrl;
    const ok = hasSheet && await sendToSheet(row);
    if (ok) {
      row.synced = true;
      saveInventory(inventory().map((r) => (r.localId === row.localId ? row : r)));
      return { text: `Added ${row.name} to your Sheet`, kind: 'ok' };
    }
    if (!hasSheet) return { text: `Saved ${row.name} on this phone. Add your Sheet link in Settings to sync.`, kind: 'err' };
    return { text: `Saved ${row.name} on this phone. Sheet sync failed, retry from Inventory.`, kind: 'err' };
  }

  async function undoRow(row) {
    saveInventory(inventory().filter((r) => r.localId !== row.localId));
    let ok = true;
    if (row.synced) ok = await postToSheet({ action: 'undo', localId: row.localId });
    setStatus('');
    toast(ok ? `Removed ${row.name}` : `Removed ${row.name} from this phone, but could not reach your Sheet. Delete it there by hand.`, ok ? 'ok' : 'err');
    if (document.querySelector('#tab-inventory.active')) renderInventory();
  }

  els.save.addEventListener('click', async () => {
    if (!selected) return;
    els.save.disabled = true;
    const row = buildRow();
    const msg = await saveRow(row);
    els.save.disabled = false;
    toast(msg.text, msg.kind, { label: 'Undo', onClick: () => undoRow(row) });
    selected = null;
    showStep('camera');
  });

  // ---------- inventory ----------
  function renderInventory() {
    const list = inventory();
    const total = list.reduce((s, r) => s + (r.priceUSD || 0) * r.quantity, 0);
    const count = list.reduce((s, r) => s + r.quantity, 0);
    els.invSummary.textContent = `${count} card${count === 1 ? '' : 's'} · about ${money(total)}`;
    const unsynced = list.filter((r) => !r.synced).length;
    els.retrySync.classList.toggle('hidden', !unsynced || !settings().sheetUrl);
    els.retrySync.textContent = `Retry unsynced (${unsynced})`;
    els.openSheet.classList.toggle('hidden', !settings().sheetView);
    els.invList.innerHTML = list.length ? list.map((r) => `
      <li>
        <img src="${esc(r.imageUrl)}" alt="">
        <div class="meta">
          <div class="t">${esc(r.name)}${r.quantity > 1 ? ` ×${r.quantity}` : ''}</div>
          <div class="s">${esc(r.set)} · ${esc(r.number)} · ${esc(r.variant)} · ${esc(r.condition)}</div>
          <span class="badge ${r.synced ? 'ok' : 'warn'}">${r.synced ? 'in Sheet' : 'not synced'}</span>
        </div>
        <div class="val">${money(r.priceUSD)}</div>
        <button class="del" data-id="${esc(r.localId)}" aria-label="Remove from phone">×</button>
      </li>`).join('') : '<li class="muted">No cards yet. Scan one!</li>';
  }
  els.invList.addEventListener('click', (e) => {
    const btn = e.target.closest('.del');
    if (!btn) return;
    if (!window.confirm('Remove this card from the list on this phone? (Your Google Sheet is not changed.)')) return;
    saveInventory(inventory().filter((r) => r.localId !== btn.dataset.id));
    renderInventory();
  });
  els.retrySync.addEventListener('click', async () => {
    els.retrySync.disabled = true;
    let n = 0;
    for (const r of inventory().filter((x) => !x.synced).reverse()) {
      if (await sendToSheet(r)) {
        n++;
        saveInventory(inventory().map((x) => (x.localId === r.localId ? { ...x, synced: true } : x)));
      }
    }
    els.retrySync.disabled = false;
    toast(n ? `Sent ${n} card${n === 1 ? '' : 's'} to your Sheet` : 'Could not reach your Sheet', n ? 'ok' : 'err');
    renderInventory();
  });
  els.openSheet.addEventListener('click', () => { const u = settings().sheetView; if (u) window.open(u, '_blank'); });
  els.exportCsv.addEventListener('click', () => {
    const cols = ['dateAdded', 'name', 'set', 'setCode', 'number', 'rarity', 'variant', 'condition', 'quantity', 'priceUSD', 'priceEUR', 'tcgplayerUrl', 'cardId', 'notes'];
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [cols.join(','), ...inventory().map((r) => cols.map((c) => q(r[c])).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `pokemon-inventory-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  // ---------- settings ----------
  function loadSettingsForm() {
    const s = settings();
    els.setSheetUrl.value = s.sheetUrl || '';
    els.setAutoAdd.checked = s.autoAdd !== false;
    els.setCondition.value = s.defaultCondition || 'Near Mint'; els.setSheetView.value = s.sheetView || '';
    els.settingsMsg.textContent = '';
  }
  els.saveSettings.addEventListener('click', () => {
    store.set('settings', {
      sheetUrl: els.setSheetUrl.value.trim(),
      sheetView: els.setSheetView.value.trim(),
      autoAdd: els.setAutoAdd.checked,
      defaultCondition: els.setCondition.value,
    });
    els.settingsMsg.textContent = 'Saved.';
  });
  els.testSheet.addEventListener('click', async () => {
    const url = els.setSheetUrl.value.trim();
    if (!url) { els.settingsMsg.textContent = 'Paste your Sheet link first.'; return; }
    els.settingsMsg.textContent = 'Testing…';
    try {
      const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}action=ping`);
      const data = await res.json();
      els.settingsMsg.textContent = data.ok ? `Connected to "${data.sheet}". You're all set.` : 'The link answered, but not as expected.';
    } catch {
      els.settingsMsg.textContent = 'Could not reach that link. Check it ends in /exec and that access is set to "Anyone".';
    }
  });

  // ---------- start ----------
  if (!settings().sheetUrl) {
    setTimeout(() => toast('Tip: add your Google Sheet link in Settings', 'ok'), 800);
  }
  startCamera();
  // Warm up the text reader in the background so the first scan is quicker.
  setTimeout(() => getWorker().catch(() => {}), 1500);
  setTimeout(() => getAllNames().catch(() => {}), 2500);
})();
