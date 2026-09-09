// Endpoints and the reciter catalog.
//
// Two data sources, both public and CORS-open (`access-control-allow-origin: *`):
//
//   QUL_API    qul.tarteel.ai — Tarteel's Quranic Universal Library. Its internal JSON API serves
//              gapless (one mp3 per surah) recitations together with word-level segments.
//   QURAN_API  api.quran.com v4 — the same QUL-curated word data (Uthmani text, word-by-word
//              glosses, transliteration) plus 12 ayah-by-ayah recitations that carry segments.
export const QURAN_API = 'https://api.quran.com/api/v4';
export const QUL_API = 'https://qul.tarteel.ai/api/v1';

export const GROUP_QUL = 'QUL — gapless (one file per surah)';
export const GROUP_QDC = 'quran.com — ayah by ayah';

// `id` for source 'qul' is QUL's internal recitation id (the `data-recitation` attribute on
// qul.tarteel.ai/resources/recitation/<page id>), not the page id.
const BUILT_IN = [
  { key: 'qul-172', label: 'Hady Toure', source: 'qul', id: 172, mode: 'gapless', group: GROUP_QUL },

  { key: 'qdc-7', label: 'Mishari Rashid al-`Afasy', source: 'quran', id: 7, mode: 'gapped', group: GROUP_QDC },
  { key: 'qdc-12', label: 'Mahmoud Khalil Al-Husary (Muallim)', source: 'quran', id: 12, mode: 'gapped', group: GROUP_QDC },
  { key: 'qdc-6', label: 'Mahmoud Khalil Al-Husary', source: 'quran', id: 6, mode: 'gapped', group: GROUP_QDC },
  { key: 'qdc-2', label: 'AbdulBaset AbdulSamad (Murattal)', source: 'quran', id: 2, mode: 'gapped', group: GROUP_QDC },
  { key: 'qdc-1', label: 'AbdulBaset AbdulSamad (Mujawwad)', source: 'quran', id: 1, mode: 'gapped', group: GROUP_QDC },
  { key: 'qdc-9', label: 'Mohamed Siddiq al-Minshawi (Murattal)', source: 'quran', id: 9, mode: 'gapped', group: GROUP_QDC },
  { key: 'qdc-8', label: 'Mohamed Siddiq al-Minshawi (Mujawwad)', source: 'quran', id: 8, mode: 'gapped', group: GROUP_QDC },
  { key: 'qdc-3', label: 'Abdur-Rahman as-Sudais', source: 'quran', id: 3, mode: 'gapped', group: GROUP_QDC },
  { key: 'qdc-4', label: 'Abu Bakr al-Shatri', source: 'quran', id: 4, mode: 'gapped', group: GROUP_QDC },
  { key: 'qdc-5', label: 'Hani ar-Rifai', source: 'quran', id: 5, mode: 'gapped', group: GROUP_QDC },
  { key: 'qdc-10', label: 'Sa`ud ash-Shuraym', source: 'quran', id: 10, mode: 'gapped', group: GROUP_QDC },
  { key: 'qdc-11', label: 'Mohamed al-Tablawi', source: 'quran', id: 11, mode: 'gapped', group: GROUP_QDC },
];

export const DEFAULT_RECITER = 'qul-172';

// Word-by-word gloss languages that api.quran.com actually serves. Turkish, Bengali, Persian,
// Hindi, Tamil and Ingush have gaps: missing words silently return the English gloss, which
// data.js detects by comparing against a second English pass.
export const GLOSS_LANGUAGES = [
  { code: 'tr', label: 'Türkçe' },
  { code: 'en', label: 'English' },
  { code: 'ur', label: 'اردو' },
  { code: 'id', label: 'Indonesia' },
  { code: 'bn', label: 'বাংলা' },
  { code: 'fa', label: 'فارسی' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'ta', label: 'தமிழ்' },
  { code: 'inh', label: 'Ingush' },
];

let cache = null;

// scripts/qul-reciters.mjs can widen the catalog with more QUL gapless reciters; if that file
// has not been generated the built-in list is used as is.
export async function loadReciters() {
  if (cache) return cache;
  const list = [...BUILT_IN];
  try {
    const res = await fetch('data/qul-reciters.json', { cache: 'no-cache' });
    if (res.ok) {
      const extra = await res.json();
      const seen = new Set(list.map((r) => r.key));
      for (const r of extra) {
        const key = `qul-${r.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        list.push({ key, label: r.label, source: 'qul', id: r.id, mode: 'gapless', group: GROUP_QUL });
      }
    }
  } catch {
    // no generated catalog — fine
  }
  cache = list;
  return list;
}

export const findReciter = (list, key) => list.find((r) => r.key === key) || list[0];
