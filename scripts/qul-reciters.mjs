// One-off catalog builder: lists every QUL recitation that is gapless (one file per surah) AND
// carries word segments, then resolves each one's internal recitation id — the id the segments
// API wants, which only appears on the detail page as `data-recitation="…"`.
//
//   node scripts/qul-reciters.mjs
//
// Writes data/qul-reciters.json, which js/catalog.js picks up automatically if present.
import { mkdir, writeFile } from 'node:fs/promises';

const ORIGIN = 'https://qul.tarteel.ai';
const INDEX = ORIGIN + '/resources/recitation';
const CONCURRENCY = 4;

async function text(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'quran-karaoke-catalog/1.0' } });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  return res.text();
}

async function mapLimit(items, limit, fn) {
  const out = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        try {
          out.push(await fn(items[i]));
        } catch (error) {
          console.warn('  skipped', items[i], '-', error.message);
        }
      }
    }),
  );
  return out.filter(Boolean);
}

// Each card on the index page carries a `data-search` blob of its tags, followed by the link to
// its detail page.
function findGaplessWithSegments(html) {
  const pages = new Set();
  const cardRe = /data-search="([^"]*)"/g;
  let match;
  while ((match = cardRe.exec(html))) {
    const tags = match[1].toLowerCase();
    if (!tags.includes('surah by surah') || !tags.includes('with segments')) continue;
    const rest = html.slice(match.index, match.index + 4000);
    const link = rest.match(/href="\/resources\/recitation\/(\d+)"/);
    if (link) pages.add(Number(link[1]));
  }
  return [...pages];
}

const index = await text(INDEX);
const pageIds = findGaplessWithSegments(index);
console.log('gapless recitations with segments:', pageIds.length);

const entries = await mapLimit(pageIds, CONCURRENCY, async (pageId) => {
  const html = await text(ORIGIN + '/resources/recitation/' + pageId);
  const id = html.match(/data-recitation="(\d+)"/);
  if (!id) return null;
  const title = html.match(/<title>([^<]*)<\/title>/);
  const label = (title?.[1] || 'Recitation ' + pageId)
    .replace(/\s*-\s*recitation\([^)]*\)\s*$/i, '')
    .trim();
  console.log('  ', label, '→ recitation id', id[1], '(page', pageId + ')');
  return { id: Number(id[1]), pageId, label };
});

entries.sort((a, b) => a.label.localeCompare(b.label));
await mkdir('data', { recursive: true });
await writeFile('data/qul-reciters.json', JSON.stringify(entries, null, 2) + '\n');
console.log('wrote data/qul-reciters.json with', entries.length, 'reciters');
