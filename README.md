# Pokémon Card Scanner

A free iPhone web app that scans Pokémon cards with the camera, looks them up, and logs card details and market prices into a Google Sheet.

- **Recognition:** reads the card name and collector number (e.g. `4/102`) on the phone with [Tesseract.js](https://github.com/naptha/tesseract.js), then finds the card in the free [TCGdex](https://tcgdex.dev) card database (no account or key needed). You tap the right match.
- **Prices:** TCGplayer market price (USD) and Cardmarket trend (EUR), from TCGdex, updated daily.
- **Storage:** your own Google Sheet, through a small Apps Script. Every scan is also kept on the phone as a backup, with CSV export.

## Setup (about 10 minutes, once)

### 1. Make the Google Sheet
1. Go to [sheets.new](https://sheets.new) and name the sheet, e.g. "Pokémon Inventory".
2. Click **Extensions → Apps Script**.
3. Delete what's there, paste everything from [`apps-script/Code.gs`](apps-script/Code.gs), and click **Save** (disk icon).
4. Click **Deploy → New deployment**. Click the gear next to "Select type" and choose **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Click **Deploy**, then **Authorize access**, pick your Google account. If you see "Google hasn't verified this app", click **Advanced → Go to (your project) (unsafe)**. It's your own script, so this is expected.
6. Copy the **Web app URL** (it ends in `/exec`).

### 2. Open the app on your iPhone
1. In Safari, open the app link (GitHub Pages address for this repo).
2. Tap **Share → Add to Home Screen**.
3. Open it from the Home Screen, go to **Settings**, paste the Web app URL, tap **Save**, then **Test Sheet connection**.
4. Optionally paste your Sheet's normal address too, so the Inventory tab gets an "Open Sheet" button.

### 3. Scan
- Hold the card inside the yellow frame, fill it as much as you can, avoid glare, and tap **Scan card**.
- Pick the right card from the matches, choose the version (holo, reverse holo…), condition and quantity, and tap **Add to inventory**.
- If a scan can't read the card, type the name and/or number in the search boxes instead.

## Prices in the Sheet
Open the Sheet and use the **Card Scanner** menu:
- **Refresh all prices now** updates every row.
- **Refresh prices every day** sets this up to run each morning automatically.

Scanning the same card, version and condition again raises the quantity instead of adding a new row.

## Files
- `index.html`, `style.css`, `app.js`: the app (no build step)
- `apps-script/Code.gs`: the Google Sheet script
- `manifest.webmanifest`, `icons/`: Home Screen app icon and name
