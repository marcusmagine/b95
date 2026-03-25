# bondegatan95-archive

Lokal arkivkopia av en bostadsannons på erikolsson.se.
Använder Playwright (headless Chromium) för att rendera sidan, trigga lazy loading,
fånga nätverkssvar och ladda ner alla bilder och dokument.

---

## Krav

- Node.js 18 eller senare
- npm

---

## Installation

```bash
cd bondegatan95
npm install
npx playwright install chromium
```

---

## Kör scrapern

```bash
npm run scrape
```

Alternativt med en annan URL:

```bash
node scraper.js https://www.erikolsson.se/homes/...
```

Resultatet sparas i mappen `archive/`.

---

## Titta på arkivet lokalt

```bash
npm run serve
```

Öppna sedan `http://localhost:3000` i webbläsaren.

Eller öppna `archive/index.html` direkt i webbläsaren (fungerar utan server).

---

## Mappstruktur

```
archive/
  index.html              ← statisk gallerisida
  raw.html                ← original HTML-källkod
  assets/
    images/               ← alla nedladdade objektsbilder
    docs/                 ← PDF:er, prospekt, planritningar
    json/
      metadata.json       ← titel, fakta, fillistor
      next_data.json      ← Next.js datablob (om tillgänglig)
      jsonld_1.json       ← JSON-LD strukturerad data
      api_response_*.json ← fångade API-svar
```

---

## Hur det fungerar

1. Öppnar sidan med headless Chromium och svensk locale.
2. Accepterar eventuellt cookie-consent.
3. Scrollar hela sidan steg för steg för att trigga lazy loading.
4. Klickar igenom bildgalleriet för att avslöja alla bilder.
5. Fångar JSON-svar från API-anrop (nätverksnivå).
6. Extraherar bild-URL:er från DOM, srcset, inline-stilar, JSON-LD och Next.js `__NEXT_DATA__`.
7. Filtrerar bort logotyper, ikoner och tracking-pixlar.
8. Normaliserar Cloudinary-URL:er till originalstorlek.
9. Laddar ner bilder och dokument med Node fetch.
10. Genererar `index.html` med bildgalleri och dokumentlänkar.

---

## Felsökning

**Inga bilder hittades**
Kör med `DEBUG=1` för mer output och titta i `archive/assets/json/` —
om `next_data.json` eller `api_response_*.json` finns, leta efter bild-URL:er manuellt:

```bash
cat archive/assets/json/next_data.json | grep -o '"https://[^"]*\.jpg[^"]*"' | sort -u
```

**Cookie-popup blockerar**
Scraparens selector-lista täcker de vanligaste mönstren. Lägg till rätt selector
i arrayen `gallerySelectors` i `scraper.js` om det behövs.

**Annons har tagits bort**
Håll `archive/raw.html` — den innehåller hela den renderade DOM:en inklusive
inline-data som annars är svår att återskapa.
