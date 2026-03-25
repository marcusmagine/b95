/**
 * download.js  —  Fast downloader using data already extracted from raw.html
 *
 * Run AFTER scraper.js has saved archive/raw.html.
 * Usage: node download.js
 */

import fs from 'fs/promises';
import path from 'path';
import { existsSync } from 'fs';

// ─── Config ──────────────────────────────────────────────────────────────────

const OUT_DIR      = path.resolve('archive');
const IMAGES_DIR   = path.join(OUT_DIR, 'assets', 'images');
const DOCS_DIR     = path.join(OUT_DIR, 'assets', 'docs');
const JSON_DIR     = path.join(OUT_DIR, 'assets', 'json');
const RAW_HTML     = path.join(OUT_DIR, 'raw.html');

// Cloudflare Images account hash (extracted from OG image URL in raw.html)
const CF_ACCOUNT   = 'kqO10avqav-88lAz_wnMzQ';
const CF_BASE      = `https://imagedelivery.net/${CF_ACCOUNT}`;
const CF_VARIANT   = 'public';   // Try "public" first; fallback below

// Vitec document base URL
const VITEC_DOC_BASE = 'https://connect.maklare.vitec.net:443/File/GetFile?customerId=M19157&fileId=';

const LISTING_URL  = 'https://www.erikolsson.se/homes/Lagenhet-4rum-Bondegatan-95-Stockholm-Stockholm-kommun-5985163';

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Referer: LISTING_URL,
  Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function mkdirs() {
  for (const d of [OUT_DIR, IMAGES_DIR, DOCS_DIR, JSON_DIR]) {
    await fs.mkdir(d, { recursive: true });
  }
}

async function downloadFile(url, destPath, label) {
  for (const attempt of [1, 2]) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) {
        console.warn(`  [${res.status}] ${label}`);
        return false;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 500) {
        console.warn(`  [tiny?] ${label} (${buf.length} B)`);
        // Still save it — might be a small doc
      }
      await fs.writeFile(destPath, buf);
      console.log(`  [ok] ${label}  (${(buf.length / 1024).toFixed(1)} KB)`);
      return true;
    } catch (err) {
      if (attempt === 2) console.warn(`  [err] ${label}: ${err.message}`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return false;
}

// ─── Extract data from raw.html ────────────────────────────────────────────────

async function parseRawHtml() {
  const html = await fs.readFile(RAW_HTML, 'utf8');

  // ── Image UUIDs ────────────────────────────────────────────────────────────
  // Pattern: cloudflare_image_id":"<uuid>"
  const uuidRe = /cloudflare_image_id.{1,5}([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/g;
  const imageIds = [];
  let m;
  while ((m = uuidRe.exec(html)) !== null) {
    if (!imageIds.includes(m[1])) imageIds.push(m[1]);
  }

  // ── Documents ─────────────────────────────────────────────────────────────
  // The JSON in raw.html is double-escaped: \\"name\\" → match both forms
  // Pattern handles both single and double escaped quotes
  const docRe = /\\"name\\":\\"([^"\\]+)\\",\\"id\\":\\"(DOK[A-Z0-9]+)\\",\\"extension\\":\\"([^"\\]+)\\",\\"url\\":\\"([^"\\]+)\\"/g;
  const docRe2 = /"name":"([^"]+)","id":"(DOK[A-Z0-9]+)","extension":"([^"]+)","url":"([^"\\]+)"/g;
  const docs = [];
  const seenDocs = new Set();

  function addDoc(name, id, ext, rawUrl) {
    if (seenDocs.has(id)) return;
    seenDocs.add(id);
    const url = rawUrl.replace(/\\u0026/g, '&').replace(/\\\\u0026/g, '&');
    docs.push({ name, id, extension: ext, url });
  }

  while ((m = docRe.exec(html)) !== null) addDoc(m[1], m[2], m[3], m[4]);
  while ((m = docRe2.exec(html)) !== null) addDoc(m[1], m[2], m[3], m[4]);

  // Fallback: direct fileId scan if nothing found above
  if (docs.length === 0) {
    const fileIdRe = /fileId=(DOK[A-Z0-9]+)/g;
    const nameRe = /\\"name\\":\\"([^"\\]+)\\".{0,60}fileId=DOK[A-Z0-9]+/g;
    const fileIds = [...new Set([...html.matchAll(/fileId=(DOK[A-Z0-9]+)/g)].map(x => x[1]))];
    fileIds.forEach((fid, i) => {
      const url = `https://connect.maklare.vitec.net:443/File/GetFile?customerId=M19157&fileId=${fid}`;
      docs.push({ name: `Dokument_${i + 1}`, id: fid, extension: '.pdf', url });
    });
  }

  // ── Metadata ───────────────────────────────────────────────────────────────
  const meta = {};

  const title = html.match(/<title>([^<]+)<\/title>/);
  if (title) meta.title = title[1].replace(' | Erik Olsson Fastighetsförmedling', '').trim();

  const descTag = html.match(/<meta name="description" content="([\s\S]+?)"/);
  if (descTag) {
    // The description in meta tag may be truncated; grab first paragraph
    meta.description = descTag[1].split('\n').slice(0, 8).join('\n').trim();
  }

  // Provider ID
  const pid = html.match(/provider_id.*?content="([^"]+)"/);
  if (pid) meta.providerId = pid[1];

  // OG image (for map / hero)
  const ogImg = html.match(/og:image.*?content="([^"]+)"/);
  if (ogImg) meta.ogImage = ogImg[1];

  // Map image
  const mapId = html.match(/cloudflare_map_image_id[^a-f0-9]*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
  if (mapId) meta.mapImageId = mapId[1];

  // Coordinates
  const lat = html.match(/cloudflare_map_latitude[^0-9-]*(-?[\d.]+)/);
  const lon = html.match(/cloudflare_map_longitude[^0-9-]*(-?[\d.]+)/);
  if (lat) meta.lat = parseFloat(lat[1]);
  if (lon) meta.lon = parseFloat(lon[1]);

  return { imageIds, docs, meta };
}

// ─── Download images ──────────────────────────────────────────────────────────

async function downloadImages(imageIds) {
  const results = [];
  console.log(`\nDownloading ${imageIds.length} images...`);

  for (let i = 0; i < imageIds.length; i++) {
    const uuid = imageIds[i];
    const filename = `photo_${String(i + 1).padStart(2, '0')}_${uuid.slice(0, 8)}.jpg`;
    const destPath = path.join(IMAGES_DIR, filename);

    if (existsSync(destPath)) {
      console.log(`  [skip] ${filename} (already exists)`);
      results.push({ uuid, filename, localPath: `assets/images/${filename}`, cached: true });
      continue;
    }

    // Try several Cloudflare variant names
    const variants = [CF_VARIANT, 'w=1920,fit=scale-down,quality=90,format=jpeg', 'w=1920,quality=90,format=jpeg', 'w=1200,quality=90,format=jpeg'];
    let ok = false;
    for (const variant of variants) {
      const url = `${CF_BASE}/${uuid}/${variant}`;
      ok = await downloadFile(url, destPath, filename);
      if (ok) break;
    }

    if (ok) {
      results.push({ uuid, filename, localPath: `assets/images/${filename}` });
    }

    // Small throttle
    await new Promise(r => setTimeout(r, 120));
  }

  return results;
}

// ─── Download documents ───────────────────────────────────────────────────────

async function downloadDocs(docs) {
  const results = [];
  console.log(`\nDownloading ${docs.length} documents...`);

  for (const doc of docs) {
    const safeName = doc.name
      .replace(/[^a-zA-Z0-9åäöÅÄÖ ._-]/g, '_')
      .replace(/\s+/g, '_')
      + doc.extension;
    const destPath = path.join(DOCS_DIR, safeName);

    if (existsSync(destPath)) {
      console.log(`  [skip] ${safeName} (already exists)`);
      results.push({ ...doc, filename: safeName, localPath: `assets/docs/${safeName}` });
      continue;
    }

    const ok = await downloadFile(doc.url, destPath, safeName);
    if (ok) {
      results.push({ ...doc, filename: safeName, localPath: `assets/docs/${safeName}` });
    }
  }

  return results;
}

// ─── HTML generator ───────────────────────────────────────────────────────────

function generateHtml({ meta, images, docs, archivedAt }) {
  const title = meta.title || 'Bondegatan 95, Stockholm';
  const description = meta.description || '';

  const galleryItems = images.map((img, i) =>
    `<figure>
      <a href="${esc(img.localPath)}" target="_blank">
        <img src="${esc(img.localPath)}" alt="Bild ${i + 1}" loading="lazy">
      </a>
    </figure>`
  ).join('\n');

  const docItems = docs.length
    ? docs.map(d =>
        `<li><a href="${esc(d.localPath)}" target="_blank">${esc(d.name || d.filename)}</a></li>`
      ).join('\n')
    : '<li><em>Inga dokument tillgängliga</em></li>';

  const mapHtml = meta.mapImageId
    ? `<section>
        <h2>Karta</h2>
        <img src="assets/images/map.jpg" alt="Karta" style="max-width:600px;border-radius:8px;">
        ${meta.lat ? `<p style="font-size:.85rem;color:#666">Koordinater: ${meta.lat}, ${meta.lon}</p>` : ''}
      </section>`
    : '';

  return `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)} — Arkiv</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
           margin: 0; background: #f7f6f2; color: #1a1a1a; }
    header { background: #111; color: #fff; padding: 2.5rem 2rem 2rem; }
    header h1 { margin: 0 0 .5rem; font-size: 2rem; font-weight: 700; }
    header p  { margin: 0; opacity: .55; font-size: .9rem; }
    .notice { background: #fffae6; border-left: 4px solid #e6b800; padding: .75rem 1.5rem;
              font-size: .85rem; }
    .notice a { color: #7a5c00; }
    main { max-width: 1280px; margin: 0 auto; padding: 2.5rem 1.5rem; }
    section { margin-bottom: 3.5rem; }
    h2 { font-size: 1.3rem; font-weight: 600; border-bottom: 2px solid #e0ddd5;
         padding-bottom: .5rem; margin-bottom: 1.2rem; }
    .description { background: #fff; border: 1px solid #e0ddd5; border-radius: 10px;
                   padding: 1.5rem; line-height: 1.8; white-space: pre-wrap;
                   font-size: .95rem; }
    .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 6px; }
    .gallery figure { margin: 0; border-radius: 6px; overflow: hidden;
                      background: #000; aspect-ratio: 4/3; }
    .gallery a { display: block; width: 100%; height: 100%; }
    .gallery img { width: 100%; height: 100%; object-fit: cover;
                   transition: transform .2s, opacity .2s; display: block; }
    .gallery img:hover { transform: scale(1.02); opacity: .9; }
    ul.docs { list-style: none; padding: 0; }
    ul.docs li { margin: .5rem 0; }
    ul.docs a { display: inline-flex; align-items: center; gap: .5rem;
                color: #1a4fa0; text-decoration: none; font-size: .95rem; }
    ul.docs a::before { content: "📄"; font-size: 1.1em; }
    ul.docs a:hover { text-decoration: underline; }
    footer { text-align: center; padding: 2rem; font-size: .8rem; color: #999; }
  </style>
</head>
<body>
<header>
  <h1>${esc(title)}</h1>
  <p>Arkiverad ${new Date(archivedAt).toLocaleString('sv-SE')}</p>
</header>
<div class="notice">
  Lokalt arkiv &mdash; Originalkälla:
  <a href="${esc(LISTING_URL)}" target="_blank">${esc(LISTING_URL)}</a>
</div>
<main>
  ${description ? `<section>
    <h2>Beskrivning</h2>
    <div class="description">${esc(description)}</div>
  </section>` : ''}

  <section>
    <h2>Bilder (${images.length})</h2>
    <div class="gallery">
      ${galleryItems || '<p>Inga bilder nedladdade.</p>'}
    </div>
  </section>

  <section>
    <h2>Dokument (${docs.length})</h2>
    <ul class="docs">${docItems}</ul>
  </section>

  ${mapHtml}

  <section>
    <h2>Rådata</h2>
    <ul>
      <li><a href="assets/json/metadata.json">metadata.json</a> — extraherad metadata</li>
      <li><a href="raw.html">raw.html</a> — original renderad HTML</li>
    </ul>
  </section>
</main>
<footer>Arkivkopia &mdash; bondegatan95-archive</footer>
</body>
</html>`;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  await mkdirs();

  if (!existsSync(RAW_HTML)) {
    console.error('archive/raw.html not found — run scraper.js first!');
    process.exit(1);
  }

  console.log('Parsing raw.html...');
  const { imageIds, docs, meta } = await parseRawHtml();

  console.log(`  Images found   : ${imageIds.length}`);
  console.log(`  Documents found: ${docs.length}`);
  console.log(`  Title          : ${meta.title}`);

  // Download map image if separate map UUID exists
  if (meta.mapImageId && !imageIds.includes(meta.mapImageId)) {
    console.log(`\nDownloading map image...`);
    const mapPath = path.join(IMAGES_DIR, 'map.jpg');
    const mapUrl = `${CF_BASE}/${meta.mapImageId}/public`;
    await downloadFile(mapUrl, mapPath, 'map.jpg');
  }

  const downloadedImages = await downloadImages(imageIds);
  const downloadedDocs   = await downloadDocs(docs);

  const archivedAt = new Date().toISOString();

  // Save metadata
  const metadata = { archivedAt, sourceUrl: LISTING_URL, meta, images: downloadedImages, documents: downloadedDocs };
  await fs.writeFile(path.join(JSON_DIR, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');

  // Generate index.html
  console.log('\nGenerating index.html...');
  const html = generateHtml({ meta, images: downloadedImages, docs: downloadedDocs, archivedAt });
  await fs.writeFile(path.join(OUT_DIR, 'index.html'), html, 'utf8');

  console.log('\n─────────────────────────────────────');
  console.log(`  Images downloaded : ${downloadedImages.length}`);
  console.log(`  Docs downloaded   : ${downloadedDocs.length}`);
  console.log(`  Archive           : ${OUT_DIR}/index.html`);
  console.log('─────────────────────────────────────\n');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
