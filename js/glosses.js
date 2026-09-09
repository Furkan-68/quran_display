// Hand-written word glosses.
//
// Two layers, both keyed by language then "surah:ayah:wordPosition":
//   file  — data/gloss-overrides.json, shared and permanent (drop an export in and it is picked
//           up on every device and every browser)
//   local — localStorage, this browser's unsaved edits, which win over the file layer
//
// Nothing here touches the API data; overrides are applied on top of a loaded surah in data.js.
const STORAGE_KEY = 'quran-karaoke:glosses';
const OVERRIDES_URL = 'data/gloss-overrides.json';

let local = {};
let file = {};

const wordKey = (verseKey, pos) => verseKey + ':' + pos;

export async function loadGlosses() {
  try {
    local = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    local = {};
  }
  try {
    const res = await fetch(OVERRIDES_URL, { cache: 'no-cache' });
    if (res.ok) file = await res.json();
  } catch {
    // no shared overrides file — local edits still work
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(local));
  } catch {
    // storage full or disabled: the edit still applies to this session
  }
}

export function glossOverride(lang, verseKey, pos) {
  const key = wordKey(verseKey, pos);
  return local[lang]?.[key] ?? file[lang]?.[key] ?? null;
}

export function setGloss(lang, verseKey, pos, text) {
  const value = text.trim();
  const key = wordKey(verseKey, pos);
  if (!value) return clearGloss(lang, verseKey, pos);
  local[lang] ||= {};
  local[lang][key] = value;
  persist();
  return value;
}

// Drops this browser's edit. Any value from the shared file stays in force.
export function clearGloss(lang, verseKey, pos) {
  const key = wordKey(verseKey, pos);
  if (local[lang]) {
    delete local[lang][key];
    if (!Object.keys(local[lang]).length) delete local[lang];
  }
  persist();
  return file[lang]?.[key] ?? null;
}

export function hasLocalGloss(lang, verseKey, pos) {
  return local[lang]?.[wordKey(verseKey, pos)] !== undefined;
}

export function countGlosses(lang) {
  const keys = new Set([...Object.keys(file[lang] || {}), ...Object.keys(local[lang] || {})]);
  return { total: keys.size, local: Object.keys(local[lang] || {}).length };
}

// Everything merged, ready to be written to data/gloss-overrides.json.
export function mergedGlosses() {
  const out = {};
  for (const lang of new Set([...Object.keys(file), ...Object.keys(local)])) {
    out[lang] = { ...file[lang], ...local[lang] };
  }
  return out;
}
