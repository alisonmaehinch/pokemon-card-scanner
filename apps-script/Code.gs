/**
 * Card Scanner → Google Sheet
 *
 * Paste this whole file into Extensions > Apps Script in your inventory Sheet,
 * then Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).
 * Copy the web app URL (ends in /exec) into the app's Settings.
 *
 * Same card + version + condition scanned again? The quantity goes up instead of adding a new row.
 * Use the "Card Scanner" menu in the Sheet to refresh all prices.
 */

const SHEET_NAME = 'Inventory';
const HEADERS = [
  'Date added', 'Card name', 'Set', 'Set code', 'Number', 'Rarity', 'Version', 'Condition',
  'Quantity', 'Market price (USD)', 'Total value (USD)', 'Cardmarket trend (EUR)',
  'Price updated', 'TCGplayer link', 'Image', 'Notes', 'Card ID', 'Version key', 'Scan IDs',
];
const COL = Object.fromEntries(HEADERS.map((h, i) => [h, i + 1]));

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sh.getRange(2, COL['Market price (USD)'], 1000, 2).setNumberFormat('$#,##0.00');
    sh.getRange(2, COL['Cardmarket trend (EUR)'], 1000, 1).setNumberFormat('€#,##0.00');
  }
  return sh;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'ping';
  if (action === 'ping') {
    getSheet_();
    return json_({ ok: true, sheet: SpreadsheetApp.getActiveSpreadsheet().getName() });
  }
  return json_({ ok: false, error: 'unknown action' });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.action !== 'add' || !body.card) return json_({ ok: false, error: 'bad request' });
    return json_(addCard_(body.card));
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function addCard_(c) {
  const sh = getSheet_();
  const last = sh.getLastRow();
  const qty = Math.max(1, Number(c.quantity) || 1);
  const now = new Date();

  if (last > 1) {
    const data = sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const scanIds = String(row[COL['Scan IDs'] - 1] || '');
      // Already received this exact scan (e.g. the phone retried): do nothing.
      if (c.localId && scanIds.indexOf(c.localId) !== -1) return { ok: true, duplicate: true };
      if (row[COL['Card ID'] - 1] === c.cardId &&
          row[COL['Version key'] - 1] === c.variantKey &&
          row[COL['Condition'] - 1] === c.condition) {
        const r = i + 2;
        const newQty = (Number(row[COL['Quantity'] - 1]) || 0) + qty;
        sh.getRange(r, COL['Quantity']).setValue(newQty);
        if (c.priceUSD != null) sh.getRange(r, COL['Market price (USD)']).setValue(c.priceUSD);
        if (c.priceEUR != null) sh.getRange(r, COL['Cardmarket trend (EUR)']).setValue(c.priceEUR);
        sh.getRange(r, COL['Price updated']).setValue(now);
        sh.getRange(r, COL['Scan IDs']).setValue(scanIds ? scanIds + ',' + c.localId : c.localId);
        if (c.notes) {
          const old = String(row[COL['Notes'] - 1] || '');
          sh.getRange(r, COL['Notes']).setValue(old ? old + '; ' + c.notes : c.notes);
        }
        return { ok: true, merged: true, quantity: newQty };
      }
    }
  }

  const r = last + 1;
  const values = HEADERS.map(() => '');
  values[COL['Date added'] - 1] = c.dateAdded ? new Date(c.dateAdded) : now;
  values[COL['Card name'] - 1] = c.name || '';
  values[COL['Set'] - 1] = c.set || '';
  values[COL['Set code'] - 1] = c.setCode || '';
  values[COL['Number'] - 1] = "'" + (c.number || ''); // keep "4/102" as text, not a date
  values[COL['Rarity'] - 1] = c.rarity || '';
  values[COL['Version'] - 1] = c.variant || '';
  values[COL['Condition'] - 1] = c.condition || '';
  values[COL['Quantity'] - 1] = qty;
  values[COL['Market price (USD)'] - 1] = c.priceUSD == null ? '' : c.priceUSD;
  values[COL['Cardmarket trend (EUR)'] - 1] = c.priceEUR == null ? '' : c.priceEUR;
  values[COL['Price updated'] - 1] = now;
  values[COL['TCGplayer link'] - 1] = c.tcgplayerUrl || '';
  values[COL['Notes'] - 1] = c.notes || '';
  values[COL['Card ID'] - 1] = c.cardId || '';
  values[COL['Version key'] - 1] = c.variantKey || '';
  values[COL['Scan IDs'] - 1] = c.localId || '';
  sh.getRange(r, 1, 1, HEADERS.length).setValues([values]);
  // Formulas: total value, and a picture of the card.
  const priceCell = sh.getRange(r, COL['Market price (USD)']).getA1Notation();
  const qtyCell = sh.getRange(r, COL['Quantity']).getA1Notation();
  sh.getRange(r, COL['Total value (USD)']).setFormula('=IF(' + priceCell + '="","",' + priceCell + '*' + qtyCell + ')');
  if (c.imageUrl) sh.getRange(r, COL['Image']).setFormula('=IMAGE("' + String(c.imageUrl).replace(/"/g, '') + '")');
  return { ok: true, row: r };
}

// ---------- Price refresh (menu + optional daily trigger) ----------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Card Scanner')
    .addItem('Refresh all prices now', 'refreshPrices')
    .addItem('Refresh prices every day', 'installDailyRefresh')
    .addToUi();
}

/** Optional: put your free pokemontcg.io key here for higher limits. */
const API_KEY = '';

function refreshPrices() {
  const sh = getSheet_();
  const last = sh.getLastRow();
  if (last < 2) return;
  const data = sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
  const ids = [...new Set(data.map((r) => r[COL['Card ID'] - 1]).filter(String))];
  const cards = {};
  const headers = API_KEY ? { 'X-Api-Key': API_KEY } : {};
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const q = '(' + chunk.map((id) => 'id:"' + id + '"').join(' OR ') + ')';
    const url = 'https://api.pokemontcg.io/v2/cards?pageSize=50&select=id,tcgplayer,cardmarket&q=' + encodeURIComponent(q);
    const res = UrlFetchApp.fetch(url, { headers: headers, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) continue;
    JSON.parse(res.getContentText()).data.forEach((c) => (cards[c.id] = c));
    Utilities.sleep(300);
  }
  const now = new Date();
  data.forEach((row, i) => {
    const c = cards[row[COL['Card ID'] - 1]];
    if (!c) return;
    const key = row[COL['Version key'] - 1];
    const p = c.tcgplayer && c.tcgplayer.prices && c.tcgplayer.prices[key];
    const usd = p ? (p.market != null ? p.market : p.mid) : null;
    const cm = c.cardmarket && c.cardmarket.prices;
    const eur = cm ? ((key === 'reverseHolofoil' && cm.reverseHoloTrend) || cm.trendPrice || cm.averageSellPrice || null) : null;
    const r = i + 2;
    if (usd != null) sh.getRange(r, COL['Market price (USD)']).setValue(usd);
    if (eur != null) sh.getRange(r, COL['Cardmarket trend (EUR)']).setValue(eur);
    sh.getRange(r, COL['Price updated']).setValue(now);
  });
  try { SpreadsheetApp.getActiveSpreadsheet().toast('Prices refreshed'); } catch (e) {}
}

function installDailyRefresh() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'refreshPrices')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('refreshPrices').timeBased().everyDays(1).atHour(6).create();
  try { SpreadsheetApp.getActiveSpreadsheet().toast('Prices will refresh every morning'); } catch (e) {}
}
