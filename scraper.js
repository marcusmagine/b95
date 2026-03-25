/**
 * Erik Olsson listing archiver
 * Scrapes a single property listing and saves everything locally.
 * Usage: node scraper.js [URL]
 */

import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { existsSync } from 'fs';

// ─── Config ──────────────────────────────────────────────────────────────────

const TARGET_URL =
  process.argv[2] ||
  'https://www.erikolsson.se/homes/Lagenhet-4rum-Bondegatan-95-Stockholm-Stockholm-kommun-5985163';

const OUT_DIR = path.resolve('archive');
const IMAGES_DIR = path.join(OUT_DIR, 'assets', 'images');
const DOCS_DIR = path.join(OUT_DIR, 'assets', 'docs');
const JSON_DIR = path.join(OUT_DIR, 'assets', 'json');

// Patterns that indicate a real listing image (not logo/icon/tracking)
const IMAGE_ALLOWLIST = [
  /objektbilder/i,
  /listing/i,
  /property/i,
  /bilder/i,
  /photo/i,
  /image/i,
  /img/i,
  /media/i,
  /cdn/i,
  /upload/i,
  /content/i,
  /fastighet/i,
  /bostad/i,
];

// Patterns to SKIP (logos, icons, tracking, generic UI)
const IMAGE_BLOCKLIST = [
  /logo/i,
  /favicon/i,
  /icon/i,
  /avatar/i,
  /badge/i,
  /sprite/i,
  /pixel/i,
  /track/i,
  /analytics/i,
  /gtm/i,
  /facebook/i,
  /twitter/i,
  /google-tag/i,
  /\/svg\//i,
];

const DOC_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx'];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sanitizeFilename(name) {
  return name
    .replace(/[?#].*$/, '')            // strip query/fragment
    .replace(/[^a-zA-Z0-9._\-åäöÅÄÖ]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 120);
}

function resolveUrl(base, href) {
  if (!href) return null;
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

function isListingImage(url) {
  if (!url) return false;
  if (IMAGE_BLOCKLIST.some(re => re.test(url))) return false;

  // Accept anything with a common image extension from a CDN / media path
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  const isImageExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'].includes(ext);
  if (!isImageExt) return false;

  // Must match at least one allowlist pattern OR look like a CDN URL
  const hasAllowPattern = IMAGE_ALLOWLIST.some(re => re.test(url));
  const looksLikeCdn = /\.(s3|cloudfront|imgix|cloudinary|akamai|fastly|cdn)\./i.test(url);
  return hasAllowPattern || looksLikeCdn;
}

function isDoc(url) {
  if (!url) return false;
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  return DOC_EXTENSIONS.includes(ext);
}

async function downloadFile(url, destPath, label = '') {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Referer: TARGET_URL,
      },
    });
    if (!res.ok) {
      console.warn(`  [skip] ${res.status} ${url}`);
      return false;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(destPath, buf);
    console.log(`  [ok]   ${label || path.basename(destPath)}  (${(buf.length / 1024).toFixed(1)} KB)`);
    return true;
  } catch (err) {
    console.warn(`  [err]  ${url}: ${err.message}`);
    return false;
  }
}

function dedupeByUrl(items) {
  const seen = new Set();
  return items.filter(item => {
    const k = item.url || item;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function mkdirs() {
  for (const dir of [OUT_DIR, IMAGES_DIR, DOCS_DIR, JSON_DIR]) {
    await fs.mkdir(dir, { recursive: true });
  }
}

// ─── Extraction helpers (run inside page.evaluate) ────────────────────────────

function extractFromDOM() {
  /* This function runs in the browser context */

  const meta = {};

  // Title / address
  const titleEl =
    document.querySelector('h1') ||
    document.querySelector('[class*="title"]') ||
    document.querySelector('[class*="address"]');
  if (titleEl) meta.title = titleEl.innerText.trim();

  // Collect all visible text blocks that look like property facts
  const factEls = document.querySelectorAll(
    '[class*="fact"], [class*="detail"], [class*="info"], [class*="spec"], ' +
    '[class*="attribute"], [class*="room"], [class*="pris"], [class*="price"], ' +
    '[class*="area"], [class*="size"], [class*="floor"]'
  );
  const facts = [];
  factEls.forEach(el => {
    const text = el.innerText.trim();
    if (text && text.length < 300) facts.push(text);
  });
  meta.facts = [...new Set(facts)];

  // Description
  const descEl =
    document.querySelector('[class*="description"]') ||
    document.querySelector('[class*="beskrivning"]') ||
    document.querySelector('[class*="text"] p');
  if (descEl) meta.description = descEl.innerText.trim();

  // All <img> srcs
  const imgs = Array.from(document.querySelectorAll('img'))
    .map(img => img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src'))
    .filter(Boolean);

  // All <source srcset> (picture elements)
  const srcsets = Array.from(document.querySelectorAll('source[srcset]'))
    .map(s => s.srcset.split(',').map(p => p.trim().split(' ')[0]))
    .flat()
    .filter(Boolean);

  // All anchor hrefs that look like documents or images
  const anchors = Array.from(document.querySelectorAll('a[href]'))
    .map(a => a.href)
    .filter(Boolean);

  // Background images from inline styles
  const bgImgs = Array.from(document.querySelectorAll('[style*="background"]'))
    .map(el => {
      const m = el.style.backgroundImage.match(/url\(["']?([^"')]+)["']?\)/);
      return m ? m[1] : null;
    })
    .filter(Boolean);

  // JSON-LD
  const jsonLds = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
    .map(s => s.textContent);

  // Next.js / React data blobs in __NEXT_DATA__ or window.__* globals
  const nextDataEl = document.querySelector('#__NEXT_DATA__');
  const nextData = nextDataEl ? nextDataEl.textContent : null;

  // Any script tags containing JSON-looking blobs with image arrays
  const inlineScripts = Array.from(document.querySelectorAll('script:not([src])'))
    .map(s => s.textContent)
    .filter(t => t && (t.includes('"images"') || t.includes('"photos"') || t.includes('"media"')));

  return { meta, imgs, srcsets, anchors, bgImgs, jsonLds, nextData, inlineScripts };
}

// ─── Image URL normalisation ──────────────────────────────────────────────────

/**
 * Erik Olsson / Vitec uses Cloudinary-style URLs with transformations.
 * Strip any resize/crop params to get the original quality image.
 * e.g. https://...cloudinary.com/.../c_fill,w_800/v1/.../photo.jpg
 *   -> https://...cloudinary.com/.../v1/.../photo.jpg
 */
function normalizeImageUrl(url) {
  try {
    const u = new URL(url);
    // Cloudinary: remove transformation segments (contain commas like "c_fill,w_800")
    u.pathname = u.pathname.replace(/\/[a-z_]+,[a-z0-9_,]+\//gi, '/');
    // Remove common resize query params
    ['w', 'h', 'width', 'height', 'q', 'quality', 'format', 'fit', 'crop'].forEach(p =>
      u.searchParams.delete(p)
    );
    return u.href;
  } catch {
    return url;
  }
}

// ─── Parse JSON blobs for image arrays ───────────────────────────────────────

function extractImageUrlsFromJson(jsonText) {
  const urls = [];
  if (!jsonText) return urls;

  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    // Try to extract URL strings with a regex fallback
    const re = /https?:\/\/[^"'\s]+\.(?:jpg|jpeg|png|webp|gif|avif)[^"'\s]*/gi;
    const matches = jsonText.match(re) || [];
    return matches;
  }

  // Recursively walk the JSON tree looking for image-like string values
  function walk(node) {
    if (!node) return;
    if (typeof node === 'string') {
      if (/https?:\/\/.+\.(?:jpg|jpeg|png|webp|gif|avif)/i.test(node)) {
        urls.push(node);
      }
    } else if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (typeof node === 'object') {
      Object.values(node).forEach(walk);
    }
  }
  walk(data);
  return urls;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  await mkdirs();
  console.log(`\nTarget: ${TARGET_URL}`);
  console.log(`Output: ${OUT_DIR}\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'sv-SE',
  });

  // Intercept network responses to catch API calls returning image metadata
  const interceptedJson = [];
  const interceptedImageUrls = new Set();

  context.on('response', async response => {
    const url = response.url();
    const ct = response.headers()['content-type'] || '';
    if (ct.includes('application/json') && (
      url.includes('api') || url.includes('object') || url.includes('listing') ||
      url.includes('home') || url.includes('property') || url.includes('photo') ||
      url.includes('media') || url.includes('image')
    )) {
      try {
        const json = await response.json().catch(() => null);
        if (json) {
          interceptedJson.push({ url, data: json });
          extractImageUrlsFromJson(JSON.stringify(json)).forEach(u =>
            interceptedImageUrls.add(u)
          );
        }
      } catch { /* ignore */ }
    }
  });

  const page = await context.newPage();

  console.log('Opening page...');
  await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 60_000 });

  // Accept cookie consent if present
  for (const selector of [
    'button:has-text("Godkänn")',
    'button:has-text("Acceptera")',
    'button:has-text("Accept")',
    'button:has-text("OK")',
    '[id*="accept"]',
    '[class*="accept"]',
    '[class*="cookie"] button',
  ]) {
    try {
      const btn = page.locator(selector).first();
      if (await btn.isVisible({ timeout: 1500 })) {
        await btn.click();
        await page.waitForTimeout(800);
        break;
      }
    } catch { /* not found */ }
  }

  // Scroll slowly to trigger lazy loading
  console.log('Scrolling to trigger lazy loading...');
  const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
  let pos = 0;
  const step = 600;
  while (pos < scrollHeight) {
    pos = Math.min(pos + step, scrollHeight);
    await page.evaluate(y => window.scrollTo(0, y), pos);
    await page.waitForTimeout(300);
  }
  // Scroll back to top and wait for any remaining network
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

  // Attempt to click through image gallery (next/arrow buttons)
  console.log('Cycling through image gallery...');
  const gallerySelectors = [
    '[class*="gallery"] button[class*="next"]',
    '[class*="slider"] button[class*="next"]',
    '[aria-label*="next" i]',
    '[aria-label*="nästa" i]',
    'button[class*="arrow-right"]',
    'button[class*="chevron-right"]',
    'button.next',
  ];
  for (const sel of gallerySelectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
      // Click up to 40 times to reveal all gallery images
      for (let i = 0; i < 40; i++) {
        try {
          await btn.click({ timeout: 800 });
          await page.waitForTimeout(300);
        } catch { break; }
      }
      break;
    }
  }
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

  // ── Extract DOM data ────────────────────────────────────────────────────────
  console.log('Extracting page data...');
  const domData = await page.evaluate(extractFromDOM);

  // Save raw HTML
  const rawHtml = await page.content();
  await fs.writeFile(path.join(OUT_DIR, 'raw.html'), rawHtml, 'utf8');

  // ── Build image URL list ───────────────────────────────────────────────────
  let imageUrls = [
    ...domData.imgs,
    ...domData.srcsets,
    ...domData.bgImgs,
    ...[...interceptedImageUrls],
    ...domData.jsonLds.flatMap(extractImageUrlsFromJson),
    ...(domData.nextData ? extractImageUrlsFromJson(domData.nextData) : []),
    ...domData.inlineScripts.flatMap(extractImageUrlsFromJson),
  ]
    .map(u => resolveUrl(TARGET_URL, u))
    .filter(Boolean)
    .map(normalizeImageUrl)
    .filter(isListingImage);

  imageUrls = dedupeByUrl(imageUrls);

  // ── Build doc URL list ─────────────────────────────────────────────────────
  let docUrls = domData.anchors
    .map(u => resolveUrl(TARGET_URL, u))
    .filter(Boolean)
    .filter(isDoc);
  docUrls = dedupeByUrl(docUrls);

  // ── Save intercepted JSON blobs ────────────────────────────────────────────
  for (let i = 0; i < interceptedJson.length; i++) {
    const fname = `api_response_${i + 1}.json`;
    await fs.writeFile(
      path.join(JSON_DIR, fname),
      JSON.stringify(interceptedJson[i], null, 2),
      'utf8'
    );
  }

  // Save JSON-LD
  for (let i = 0; i < domData.jsonLds.length; i++) {
    await fs.writeFile(path.join(JSON_DIR, `jsonld_${i + 1}.json`), domData.jsonLds[i], 'utf8');
  }

  // Save Next.js data blob
  if (domData.nextData) {
    await fs.writeFile(path.join(JSON_DIR, 'next_data.json'), domData.nextData, 'utf8');
  }

  // ── Download images ────────────────────────────────────────────────────────
  console.log(`\nFound ${imageUrls.length} listing images. Downloading...`);
  const downloadedImages = [];

  for (const url of imageUrls) {
    let filename;
    try {
      const u = new URL(url);
      filename = sanitizeFilename(path.basename(u.pathname)) || `image_${Date.now()}`;
      if (!path.extname(filename)) filename += '.jpg';
    } catch {
      filename = `image_${Date.now()}.jpg`;
    }

    // Avoid duplicate filenames
    let destPath = path.join(IMAGES_DIR, filename);
    let counter = 1;
    while (existsSync(destPath)) {
      const ext = path.extname(filename);
      const base = path.basename(filename, ext);
      destPath = path.join(IMAGES_DIR, `${base}_${counter}${ext}`);
      counter++;
    }

    const ok = await downloadFile(url, destPath, filename);
    if (ok) {
      downloadedImages.push({
        url,
        localPath: path.relative(OUT_DIR, destPath),
        filename: path.basename(destPath),
      });
    }
  }

  // ── Download documents ─────────────────────────────────────────────────────
  console.log(`\nFound ${docUrls.length} documents. Downloading...`);
  const downloadedDocs = [];

  for (const url of docUrls) {
    let filename;
    try {
      filename = sanitizeFilename(path.basename(new URL(url).pathname));
      if (!filename) filename = `document_${Date.now()}.pdf`;
    } catch {
      filename = `document_${Date.now()}.pdf`;
    }

    const destPath = path.join(DOCS_DIR, filename);
    const ok = await downloadFile(url, destPath, filename);
    if (ok) {
      downloadedDocs.push({
        url,
        localPath: path.relative(OUT_DIR, destPath),
        filename,
      });
    }
  }

  await browser.close();

  // ── Save metadata ──────────────────────────────────────────────────────────
  const metadata = {
    archivedAt: new Date().toISOString(),
    sourceUrl: TARGET_URL,
    meta: domData.meta,
    images: downloadedImages,
    documents: downloadedDocs,
  };
  await fs.writeFile(
    path.join(JSON_DIR, 'metadata.json'),
    JSON.stringify(metadata, null, 2),
    'utf8'
  );

  // ── Generate index.html ────────────────────────────────────────────────────
  console.log('\nGenerating index.html...');
  const html = generateHtml(metadata);
  await fs.writeFile(path.join(OUT_DIR, 'index.html'), html, 'utf8');

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n─────────────────────────────────────');
  console.log(`  Images downloaded : ${downloadedImages.length}`);
  console.log(`  Docs downloaded   : ${downloadedDocs.length}`);
  console.log(`  JSON blobs saved  : ${interceptedJson.length + domData.jsonLds.length + (domData.nextData ? 1 : 0)}`);
  console.log(`  Archive at        : ${OUT_DIR}/index.html`);
  console.log('─────────────────────────────────────\n');
}

// ─── HTML generator ───────────────────────────────────────────────────────────

function generateHtml(metadata) {
  const { sourceUrl, archivedAt, meta, images, documents } = metadata;

  const title = meta.title || 'Bondegatan 95, Stockholm';
  const description = meta.description || '';
  const facts = (meta.facts || []).slice(0, 30);

  const factsHtml = facts.length
    ? `<ul class="facts">${facts.map(f => `<li>${escHtml(f)}</li>`).join('\n')}</ul>`
    : '';

  const galleryHtml = images.length
    ? images
        .map(
          img => `
      <figure>
        <a href="${escAttr(img.localPath)}" target="_blank">
          <img src="${escAttr(img.localPath)}" alt="${escAttr(img.filename)}" loading="lazy">
        </a>
      </figure>`
        )
        .join('\n')
    : '<p>Inga bilder hittades.</p>';

  const docsHtml = documents.length
    ? `<ul>${documents
        .map(
          d =>
            `<li><a href="${escAttr(d.localPath)}" target="_blank">${escHtml(d.filename)}</a></li>`
        )
        .join('\n')}</ul>`
    : '<p>Inga dokument hittades.</p>';

  return `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(title)} — Arkiv</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      margin: 0; padding: 0;
      background: #f5f4f0;
      color: #222;
    }
    header {
      background: #1a1a1a;
      color: #fff;
      padding: 2rem;
    }
    header h1 { margin: 0 0 .4rem; font-size: 1.8rem; }
    header p  { margin: 0; opacity: .65; font-size: .9rem; }
    .archive-notice {
      background: #fffbe6;
      border-left: 4px solid #f0c040;
      padding: .8rem 1.2rem;
      font-size: .85rem;
    }
    .archive-notice a { color: inherit; }
    main { max-width: 1200px; margin: 0 auto; padding: 2rem 1rem; }
    section { margin-bottom: 3rem; }
    h2 { border-bottom: 2px solid #ddd; padding-bottom: .4rem; }
    .facts { list-style: none; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: .5rem; }
    .facts li { background: #fff; border: 1px solid #e0e0e0; border-radius: 6px; padding: .6rem 1rem; font-size: .9rem; }
    .description { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 1.2rem; line-height: 1.7; white-space: pre-wrap; }
    .gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 8px; }
    .gallery figure { margin: 0; background: #000; border-radius: 4px; overflow: hidden; aspect-ratio: 4/3; }
    .gallery figure a { display: block; width: 100%; height: 100%; }
    .gallery img { width: 100%; height: 100%; object-fit: cover; transition: opacity .2s; }
    .gallery img:hover { opacity: .85; }
    ul { padding-left: 1.4rem; }
    li { margin: .3rem 0; }
    footer { text-align: center; padding: 2rem; font-size: .8rem; color: #888; }
  </style>
</head>
<body>
<header>
  <h1>${escHtml(title)}</h1>
  <p>Arkiverad ${new Date(archivedAt).toLocaleString('sv-SE')}</p>
</header>

<div class="archive-notice">
  Lokalt arkiv. Originalkälla: <a href="${escAttr(sourceUrl)}" target="_blank">${escHtml(sourceUrl)}</a>
</div>

<main>
  ${facts.length ? `<section>
    <h2>Fakta</h2>
    ${factsHtml}
  </section>` : ''}

  ${description ? `<section>
    <h2>Beskrivning</h2>
    <div class="description">${escHtml(description)}</div>
  </section>` : ''}

  <section>
    <h2>Bilder (${images.length})</h2>
    <div class="gallery">
      ${galleryHtml}
    </div>
  </section>

  <section>
    <h2>Dokument (${documents.length})</h2>
    ${docsHtml}
  </section>

  <section>
    <h2>Rådata</h2>
    <ul>
      <li><a href="assets/json/metadata.json">metadata.json</a></li>
      <li><a href="raw.html">raw.html</a> — original HTML-källa</li>
    </ul>
  </section>
</main>

<footer>Arkivkopia skapad med bondegatan95-archive</footer>
</body>
</html>`;
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function escAttr(str) {
  return String(str ?? '').replace(/"/g, '%22');
}

// ─── Run ──────────────────────────────────────────────────────────────────────
main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
