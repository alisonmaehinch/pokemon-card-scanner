/* Card Scanner: scan a Pokémon card, look it up, save it to a Google Sheet. */
(() => {
  'use strict';

  const API = 'https://api.pokemontcg.io/v2/cards';
  const CARD_RATIO = 63 / 88; // width / height of a trading card
  const GUIDE_WIDTH = 0.72;   // must match .guide width in style.css

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
    setSheetUrl: $('set-sheet-url'), setSheetView: $('set-sheet-view'), setApiKey: $('set-api-key'),
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
  const settings = () => store.get('settings', { sheetUrl: '', sheetView: '', apiKey: '' });
  const inventory = () => store.get('inventory', []);
  const saveInventory = (list) => store.set('inventory', list);

  // ---------- UI helpers ----------
  let toastTimer;
  function toast(msg, kind = 'ok') {
    els.toast.textContent = msg;
    els.toast.className = `toast ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 3200);
  }
  function setStatus(msg, isErr = false) {
    if (!msg) { els.status.classList.add('hidden'); return; }
    els.status.textContent = msg;
    els.status.className = `status${isErr ? ' err' : ''}`;
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

  // Crop the area inside the on-screen guide from the live video.
  function grabGuideArea() {
    const v = els.video;
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return null;
    const box = v.getBoundingClientRect();
    // object-fit: cover scaling
    const scale = Math.max(box.width / vw, box.height / vh);
    const shownW = box.width / scale, shownH = box.height / scale;
    const offX = (vw - shownW) / 2, offY = (vh - shownH) / 2;
    const gW = shownW * GUIDE_WIDTH, gH = gW / CARD_RATIO;
    const sx = offX + (shownW - gW) / 2, sy = offY + (shownH - gH) / 2;
    const c = document.createElement('canvas');
    c.width = Math.round(gW); c.height = Math.round(gH);
    c.getContext('2d').drawImage(v, sx, sy, gW, gH, 0, 0, c.width, c.height);
    return c;
  }

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
  function region(card, x0, y0, x1, y1, targetW = 1400) {
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
    for (let i = 0; i < px.length; i += 4) {
      const g = ((px[i] - min) / range) * 255;
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
      workerPromise = Tesseract.createWorker('eng');
    }
    return workerPromise;
  }

  async function readCard(card) {
    const worker = await getWorker();
    const top = region(card, 0.04, 0.025, 0.80, 0.115);
    const bottom = region(card, 0.0, 0.88, 1.0, 0.985, 1800);
    const nameRes = await worker.recognize(top);
    const numRes = await worker.recognize(bottom);
    return { nameText: nameRes.data.text || '', numText: numRes.data.text || '' };
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
    const t = text.replace(/[Oo](?=\d)/g, '0').replace(/(\d)[Oo]/g, '$10').replace(/[Il|](?=\d)/g, '1');
    // Trainer Gallery / Galarian Gallery style: TG05/TG30, GG01/GG70
    let m = t.match(/\b([A-Z]{2}\d{1,3})\s*\/\s*([A-Z]{2}\d{1,3})\b/);
    if (m) return { number: m[1], total: null };
    m = t.match(/(\d{1,3})\s*\/\s*(\d{2,3})/);
    if (m) return { number: String(parseInt(m[1], 10)), total: parseInt(m[2], 10) };
    // Promos: SWSH123, SM45, SV045, XY12 …
    m = t.match(/\b(SWSH|SVP|SV|SM|XY|BW|HGSS|DP)\s?(\d{1,3})\b/);
    if (m) return { number: m[1] + m[2].padStart(m[1] === 'SV' || m[1] === 'SVP' ? 3 : 2, '0'), total: null, promo: true };
    return null;
  }

  // ---------- API ----------
  async function apiSearch(q) {
    const params = new URLSearchParams({
      q, pageSize: '24', orderBy: '-set.releaseDate',
      select: 'id,name,number,rarity,set,images,tcgplayer,cardmarket',
    });
    const headers = {};
    const key = settings().apiKey;
    if (key) headers['X-Api-Key'] = key;
    const res = await fetch(`${API}?${params}`, { headers });
    if (!res.ok) throw new Error(res.status === 429 ? 'Too many lookups right now. Wait a minute or add a free API key in Settings.' : `Card lookup failed (${res.status}).`);
    return (await res.json()).data || [];
  }
  const quote = (s) => `"${s.replace(/"/g, '')}"`;

  function similarity(a, b) {
    a = a.toLowerCase().replace(/[^a-z0-9]/g, ''); b = b.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!a || !b) return 0;
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return 1 - dp[a.length][b.length] / Math.max(a.length, b.length);
  }

  async function findCards({ name, num }) {
    const seen = new Map();
    const add = (cards) => cards.forEach((c) => seen.set(c.id, c));
    if (num) {
      const parts = [`number:${num.number}`];
      if (num.total) parts.push(`set.printedTotal:${num.total}`);
      add(await apiSearch(parts.join(' ')));
    }
    if (name && (seen.size === 0 || seen.size > 6)) {
      const words = name.split(/\s+/);
      let byName = await apiSearch(`name:${quote(name)}${num ? ` number:${num.number}` : ''}`);
      if (!byName.length && num) byName = await apiSearch(`name:${quote(name)}`);
      if (!byName.length && words[0].length >= 3) byName = await apiSearch(`name:${words[0].replace(/[^A-Za-z]/g, '')}*`);
      if (seen.size > 6 && byName.length) {
        // number gave too many hits; keep only those that match the name too
        const ids = new Set(byName.map((c) => c.id));
        const both = [...seen.values()].filter((c) => ids.has(c.id));
        if (both.length) { seen.clear(); add(both); } else add(byName);
      } else add(byName);
    }
    const list = [...seen.values()];
    list.forEach((c) => {
      c._score = (name ? similarity(name, c.name) : 0)
        + (num && c.number.toLowerCase() === num.number.toLowerCase() ? 1 : 0)
        + (num && num.total && c.set.printedTotal === num.total ? 0.5 : 0);
    });
    list.sort((a, b) => b._score - a._score);
    return list.slice(0, 24);
  }

  // ---------- prices ----------
  const VARIANT_LABELS = {
    normal: 'Normal', holofoil: 'Holofoil', reverseHolofoil: 'Reverse Holo',
    '1stEditionHolofoil': '1st Edition Holo', '1stEditionNormal': '1st Edition',
    unlimitedHolofoil: 'Unlimited Holo', unlimited: 'Unlimited',
  };
  function variantsOf(card) {
    const prices = card.tcgplayer?.prices || {};
    const list = Object.entries(prices).map(([key, p]) => ({
      key, label: VARIANT_LABELS[key] || key, usd: p.market ?? p.mid ?? null,
    }));
    if (!list.length) list.push({ key: 'default', label: 'Standard', usd: null });
    return list;
  }
  function eurOf(card, variantKey) {
    const p = card.cardmarket?.prices;
    if (!p) return null;
    if (variantKey === 'reverseHolofoil' && p.reverseHoloTrend) return p.reverseHoloTrend;
    return p.trendPrice ?? p.averageSellPrice ?? null;
  }
  const bestPrice = (card) => {
    const vs = variantsOf(card).filter((v) => v.usd != null);
    return vs.length ? Math.max(...vs.map((v) => v.usd)) : null;
  };

  // ---------- scan flow ----------
  let busy = false;
  async function runScan(card) {
    if (busy) return;
    busy = true; els.snap.disabled = true;
    try {
      setStatus('Reading the card…');
      const { nameText, numText } = await readCard(card);
      const name = parseName(nameText);
      const num = parseNumber(numText);
      if (!name && !num) {
        setStatus('I could not read that card. Try again with less glare, or type the name below.', true);
        return;
      }
      els.readText.textContent = `Read: ${[name, num && (num.total ? `${num.number}/${num.total}` : num.number)].filter(Boolean).join(' · ')}`;
      setStatus('Looking it up…');
      const cards = await findCards({ name, num });
      showResults(cards);
    } catch (e) {
      console.error(e);
      setStatus(e.message || 'Something went wrong.', true);
    } finally {
      busy = false; els.snap.disabled = false;
    }
  }

  els.snap.addEventListener('click', () => {
    const card = grabGuideArea();
    if (!card) { setStatus('Camera is not ready yet. Turn it on, or use a photo.', true); return; }
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
      showResults(await findCards({ name, num }));
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
        <img loading="lazy" src="${esc(c.images?.small)}" alt="">
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

  function buildRow() {
    const c = selected;
    const v = variantsOf(c).find((x) => x.key === els.cVariant.value) || variantsOf(c)[0];
    const qty = Math.max(1, parseInt(els.cQty.value, 10) || 1);
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
      condition: els.cCondition.value,
      quantity: qty,
      priceUSD: v.usd,
      priceEUR: eurOf(c, v.key),
      tcgplayerUrl: c.tcgplayer?.url || '',
      imageUrl: c.images?.small || '',
      notes: els.cNotes.value.trim(),
      synced: false,
    };
  }

  async function sendToSheet(row) {
    const url = settings().sheetUrl;
    if (!url) return false;
    const { synced, ...card } = row;
    const body = JSON.stringify({ action: 'add', card });
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

  els.save.addEventListener('click', async () => {
    if (!selected) return;
    const row = buildRow();
    const list = inventory(); list.unshift(row); saveInventory(list);
    els.save.disabled = true;
    const hasSheet = !!settings().sheetUrl;
    const ok = hasSheet && await sendToSheet(row);
    els.save.disabled = false;
    if (ok) {
      row.synced = true;
      saveInventory(inventory().map((r) => (r.localId === row.localId ? row : r)));
      toast(`Added ${row.name} to your Sheet`);
    } else if (!hasSheet) {
      toast(`Saved ${row.name} on this phone. Add your Sheet link in Settings to sync.`, 'err');
    } else {
      toast(`Saved ${row.name} on this phone. Sheet sync failed, retry from Inventory.`, 'err');
    }
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
    els.setSheetUrl.value = s.sheetUrl; els.setSheetView.value = s.sheetView; els.setApiKey.value = s.apiKey;
    els.settingsMsg.textContent = '';
  }
  els.saveSettings.addEventListener('click', () => {
    store.set('settings', {
      sheetUrl: els.setSheetUrl.value.trim(),
      sheetView: els.setSheetView.value.trim(),
      apiKey: els.setApiKey.value.trim(),
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
})();
