// Fetches, normalizes and caches one surah's words + word timings.
//
// Normalized bundle shape:
//   { surah, ayahCount, mode: 'gapless' | 'gapped', lang,
//     audio: { url, duration } | { byVerse: { '18:1': url, ... } },
//     verses: [{ key, number, startMs, endMs, endMarker,
//                words: [{ pos, arabic, translit, gloss, glossEn, fallback, startMs, endMs }] }] }
//
// In 'gapless' mode all times are absolute milliseconds into the surah-long mp3.
// In 'gapped' mode every verse has its own mp3, so its times are local to that file.
import { QURAN_API, QUL_API } from './catalog.js';
import { ayahCount } from './surahs.js';
import { glossOverride } from './glosses.js';

const SCHEMA_VERSION = 1;
const DB_NAME = 'quran-karaoke';
const STORE = 'bundles';
const AUDIO_BASE = 'https://verses.quran.com/';

/* ---------------------------------------------------------------- IndexedDB */

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(() => null); // private mode / disabled storage: run without a cache
  return dbPromise;
}

async function cacheGet(key) {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

async function cacheSet(key, value) {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
  } catch {
    // quota exceeded or a closed connection — the app still works without the cache
  }
}

export async function clearCache() {
  const db = await openDb();
  if (!db) return;
  await new Promise((resolve) => {
    const req = db.transaction(STORE, 'readwrite').objectStore(STORE).clear();
    req.onsuccess = req.onerror = () => resolve();
  });
}

/* -------------------------------------------------------------------- fetch */

async function getJson(url, { retries = 1, timeout = 20000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
      return await res.json();
    } catch (err) {
      if (attempt >= retries) throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function absoluteAudioUrl(url) {
  if (!url) return null;
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('http')) return url;
  return AUDIO_BASE + url.replace(/^\//, '');
}

/* -------------------------------------------------------------------- words */

async function fetchWords(surah, lang) {
  const url = (l) =>
    QURAN_API + '/verses/by_chapter/' + surah +
    '?words=true&language=' + l + '&per_page=300&word_fields=text_uthmani';
  const [primary, english] = await Promise.all([
    getJson(url(lang)),
    lang === 'en' ? Promise.resolve(null) : getJson(url('en')).catch(() => null),
  ]);

  const englishByKey = new Map();
  for (const verse of english?.verses || []) englishByKey.set(verse.verse_key, verse.words);

  const byKey = new Map();
  for (const verse of primary.verses) {
    const enWords = englishByKey.get(verse.verse_key) || [];
    const words = [];
    let endMarker = '';
    verse.words.forEach((w, i) => {
      if (w.char_type_name === 'end') {
        endMarker = w.text_uthmani || w.text || '';
        return;
      }
      const gloss = w.translation?.text?.trim() || '';
      const glossEn = enWords[i]?.translation?.text?.trim() || '';
      words.push({
        pos: w.position,
        arabic: w.text_uthmani || w.text || '',
        translit: w.transliteration?.text || '',
        gloss: gloss || glossEn,
        glossEn,
        // api.quran.com silently returns the English gloss where a language has no entry
        fallback: lang !== 'en' && !!glossEn && gloss === glossEn,
        startMs: null,
        endMs: null,
      });
    });
    byKey.set(verse.verse_key, { words, endMarker });
  }
  return byKey;
}

/* ----------------------------------------------------------------- segments */

// QUL segment tuple:       [wordPosition, startMs, endMs]
// quran.com segment tuple: [index, wordPosition, startMs, endMs]
function normalizeSegments(raw) {
  const out = [];
  for (const seg of raw || []) {
    if (!Array.isArray(seg) || seg.length < 3) continue;
    const pos = seg.length >= 4 ? seg[1] : seg[0];
    const startMs = seg[seg.length - 2];
    const endMs = seg[seg.length - 1];
    if (!Number.isFinite(pos) || !Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    out.push({ pos, startMs, endMs });
  }
  out.sort((a, b) => a.startMs - b.startMs);
  return out;
}

// Gapless: one mp3 for the whole surah, segments carry absolute offsets into it.
// The endpoint pages 10 ayahs at a time, so page 1 is fetched first to learn the page count.
async function fetchQulTimings(surah, reciter, total, onProgress) {
  const url = (page) =>
    QUL_API + '/audio/surah_segments/' + reciter.id +
    '?surah=' + surah + '&from=1&to=' + total + '&page=' + page;

  const first = await getJson(url(1));
  const pageCount = Math.max(1, Number(first.pagination?.total_pages) || 1);
  const segments = { ...(first.segments || {}) };
  onProgress?.(1, pageCount);

  if (pageCount > 1) {
    const rest = Array.from({ length: pageCount - 1 }, (_, i) => i + 2);
    let done = 1;
    const pages = await mapLimit(rest, 6, async (page) => {
      const json = await getJson(url(page));
      onProgress?.(++done, pageCount);
      return json.segments || {};
    });
    for (const chunk of pages) Object.assign(segments, chunk);
  }

  const audioUrl = absoluteAudioUrl(first.audio?.url);
  if (!audioUrl) throw new Error('QUL returned no audio file for this surah');

  const byVerse = new Map();
  for (const [key, value] of Object.entries(segments)) {
    byVerse.set(key, {
      startMs: Number(value.time_from),
      endMs: Number(value.time_to),
      segments: normalizeSegments(value.segments),
    });
  }
  return {
    mode: 'gapless',
    audio: { url: audioUrl, duration: first.audio?.duration ?? null },
    byVerse,
  };
}

// Gapped: one mp3 per ayah, so every segment time is local to its own file.
async function fetchQuranComTimings(surah, reciter) {
  const json = await getJson(
    QURAN_API + '/recitations/' + reciter.id + '/by_chapter/' + surah +
    '?fields=segments&per_page=300',
  );
  const byVerse = new Map();
  const audioByVerse = {};
  for (const file of json.audio_files || []) {
    const segments = normalizeSegments(file.segments);
    audioByVerse[file.verse_key] = absoluteAudioUrl(file.url);
    byVerse.set(file.verse_key, {
      startMs: 0,
      endMs: segments.length ? segments[segments.length - 1].endMs : null,
      segments,
    });
  }
  return { mode: 'gapped', audio: { byVerse: audioByVerse }, byVerse };
}

/* ------------------------------------------------------------------ bundles */

function buildBundle(surah, reciter, lang, wordsByKey, timings) {
  const total = ayahCount(surah);
  const verses = [];

  for (let n = 1; n <= total; n++) {
    const key = surah + ':' + n;
    const entry = wordsByKey.get(key);
    if (!entry) continue;
    const timing = timings.byVerse.get(key);
    const words = entry.words.map((w) => ({ ...w }));

    if (timing) {
      // Match on word position, never on array index: a verse can have segments missing.
      const byPos = new Map(timing.segments.map((s) => [s.pos, s]));
      for (const word of words) {
        const seg = byPos.get(word.pos);
        if (!seg) continue; // untimed word — it simply never lights up
        word.startMs = seg.startMs;
        word.endMs = seg.endMs;
      }
    }

    const timed = words.filter((w) => w.startMs !== null);
    verses.push({
      key,
      number: n,
      endMarker: entry.endMarker,
      words,
      startMs: timing?.startMs ?? (timed.length ? timed[0].startMs : null),
      endMs: timing?.endMs ?? (timed.length ? timed[timed.length - 1].endMs : null),
    });
  }

  return {
    schema: SCHEMA_VERSION,
    surah,
    ayahCount: total,
    lang,
    reciterKey: reciter.key,
    reciterLabel: reciter.label,
    mode: timings.mode,
    audio: timings.audio,
    verses,
  };
}

// Lays hand-written glosses over a bundle. Called for freshly fetched and cached bundles alike,
// and again after an edit, so the original API text is always kept for a reset.
export function applyGlossToWord(lang, verseKey, word) {
  if (word.origGloss === undefined) {
    word.origGloss = word.gloss;
    word.origFallback = word.fallback;
  }
  const override = glossOverride(lang, verseKey, word.pos);
  word.gloss = override ?? word.origGloss;
  word.fallback = override ? false : word.origFallback;
  word.edited = override != null;
  return word;
}

export function applyGlossOverrides(bundle) {
  for (const verse of bundle.verses) {
    for (const word of verse.words) applyGlossToWord(bundle.lang, verse.key, word);
  }
  return bundle;
}

export async function loadSurah(surah, reciter, lang, { onProgress } = {}) {
  const cacheKey = 'v' + SCHEMA_VERSION + ':' + surah + ':' + reciter.key + ':' + lang;
  const cached = await cacheGet(cacheKey);
  if (cached?.schema === SCHEMA_VERSION) return applyGlossOverrides(cached);

  const total = ayahCount(surah);
  const [wordsByKey, timings] = await Promise.all([
    fetchWords(surah, lang),
    reciter.source === 'qul'
      ? fetchQulTimings(surah, reciter, total, onProgress)
      : fetchQuranComTimings(surah, reciter),
  ]);

  const bundle = buildBundle(surah, reciter, lang, wordsByKey, timings);
  if (bundle.verses.length) cacheSet(cacheKey, bundle); // cache the untouched API text
  return applyGlossOverrides(bundle);
}
