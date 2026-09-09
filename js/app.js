import { SURAHS, ayahCount } from './surahs.js';
import { DEFAULT_RECITER, GLOSS_LANGUAGES, findReciter, loadReciters } from './catalog.js';
import { loadSurah } from './data.js';
import { countGlosses, loadGlosses, mergedGlosses } from './glosses.js';
import { GlossEditor } from './editor.js';
import { Player } from './player.js';
import { Renderer } from './render.js';

const SETTINGS_KEY = 'quran-karaoke:settings';

const $ = (id) => document.getElementById(id);
const el = {
  surahSelect: $('surah-select'),
  ayahSelect: $('ayah-select'),
  reciterSelect: $('reciter-select'),
  langSelect: $('lang-select'),
  settingsToggle: $('settings-toggle'),
  settingsRow: $('settings-row'),
  zenToggle: $('zen-toggle'),
  zenExit: $('zen-exit'),
  rate: $('rate'),
  rateOut: $('rate-out'),
  offset: $('offset'),
  offsetOut: $('offset-out'),
  fontSize: $('font-size'),
  fontOut: $('font-out'),
  repeat: $('repeat'),
  rangeOn: $('range-on'),
  rangeFrom: $('range-from'),
  rangeTo: $('range-to'),
  toggleSingle: $('toggle-single'),
  toggleMushaf: $('toggle-mushaf'),
  toggleTranslit: $('toggle-translit'),
  toggleGloss: $('toggle-gloss'),
  toggleScroll: $('toggle-scroll'),
  toggleTheme: $('toggle-theme'),
  toggleEdit: $('toggle-edit'),
  exportGlosses: $('export-glosses'),
  glossCount: $('gloss-count'),
  banner: $('banner'),
  status: $('status'),
  surah: $('surah'),
  play: $('play'),
  prev: $('prev'),
  next: $('next'),
  seek: $('seek'),
  time: $('time'),
  duration: $('duration'),
  modeBadge: $('mode-badge'),
};

const defaults = {
  surah: 1,
  verse: 1,
  reciter: DEFAULT_RECITER,
  lang: 'tr',
  rate: 1,
  offset: 0,
  fontSize: 100,
  repeat: '0',
  zen: false,
  edit: false,
  single: true,
  mushaf: false,
  translit: true,
  gloss: true,
  autoScroll: true,
  theme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
};

const settings = { ...defaults, ...readSettings() };
let reciters = [];
let bundle = null;
let seeking = false;
let lastProgressPaint = 0;
let loadToken = 0;

function readSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // storage disabled — settings just won't survive a reload
  }
}

function formatTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return minutes + ':' + seconds;
}

function showBanner(message) {
  el.banner.textContent = message;
  el.banner.hidden = !message;
}

function showStatus(message) {
  el.status.textContent = message || '';
  el.status.hidden = !message;
}

/* ------------------------------------------------------------------ player */

const player = new Player({
  onActiveChange: (verseIndex, wordIndex, verseChanged) => {
    renderer.setActive(verseIndex, wordIndex, verseChanged);
    if (verseChanged) {
      const verse = bundle?.verses[verseIndex];
      if (verse) {
        settings.verse = verse.number;
        if (el.ayahSelect.value !== String(verse.number)) el.ayahSelect.value = String(verse.number);
        saveSettings();
      }
    }
  },
  onStatusChange: (status) => {
    el.play.textContent = status === 'playing' ? '❚❚' : '▶';
    el.play.setAttribute('aria-label', status === 'playing' ? 'Pause' : 'Play');
  },
  onProgress: (timeMs, durationMs) => {
    const now = performance.now();
    if (now - lastProgressPaint < 100) return;
    lastProgressPaint = now;
    if (!seeking && durationMs > 0) el.seek.value = String(Math.round((timeMs / durationMs) * 1000));
    el.time.textContent = formatTime(timeMs);
    el.duration.textContent = formatTime(durationMs);
  },
  onError: (message) => showBanner(message),
});

const renderer = new Renderer({
  container: el.surah,
  focus: {
    key: $('focus-key'),
    arabic: $('focus-ar'),
    translit: $('focus-tl'),
    gloss: $('focus-gl'),
    secondary: $('focus-en'),
  },
  onWordClick: (verseIndex, wordIndex) => {
    player.goToWord(verseIndex, wordIndex);
    if (!player.isPlaying()) player.play();
  },
  onWordEdit: (verseIndex, wordIndex, anchor) => {
    player.pause(); // editing and reciting at the same time helps nobody
    editor.open(verseIndex, wordIndex, anchor);
  },
});

const editor = new GlossEditor({
  getBundle: () => bundle,
  onSaved: (verseIndex, wordIndex, word) => {
    renderer.updateWord(verseIndex, wordIndex, word);
    updateGlossCount();
  },
  onGoToWord: (verseIndex, wordIndex) => {
    // In one-ayah mode only the player's verse is on screen, so move it before anchoring.
    if (verseIndex !== player.verseIndex) player.goToVerse(verseIndex);
    editor.open(verseIndex, wordIndex, renderer.wordElement(verseIndex, wordIndex));
  },
});

function updateGlossCount() {
  const { total, local } = countGlosses(settings.lang);
  el.glossCount.textContent = total
    ? total + ' hand-edited (' + local + ' in this browser)'
    : '';
}

/* ------------------------------------------------------------------- setup */

function fillSurahSelect() {
  el.surahSelect.innerHTML = SURAHS.map(
    (s, i) => '<option value="' + (i + 1) + '">' + (i + 1) + '. ' + s[0] + ' — ' + s[1] + '</option>',
  ).join('');
  el.surahSelect.value = String(settings.surah);
}

function fillAyahSelect(total) {
  let html = '';
  for (let n = 1; n <= total; n++) html += '<option value="' + n + '">' + n + '</option>';
  el.ayahSelect.innerHTML = html;
  el.ayahSelect.value = String(Math.min(settings.verse, total));
  el.rangeFrom.max = String(total);
  el.rangeTo.max = String(total);
  if (Number(el.rangeTo.value) < 1 || Number(el.rangeTo.value) > total) el.rangeTo.value = String(total);
}

function fillReciterSelect() {
  const groups = new Map();
  for (const reciter of reciters) {
    if (!groups.has(reciter.group)) groups.set(reciter.group, []);
    groups.get(reciter.group).push(reciter);
  }
  el.reciterSelect.innerHTML = [...groups.entries()]
    .map(
      ([group, list]) =>
        '<optgroup label="' + group + '">' +
        list.map((r) => '<option value="' + r.key + '">' + r.label + '</option>').join('') +
        '</optgroup>',
    )
    .join('');
  el.reciterSelect.value = settings.reciter;
  if (!el.reciterSelect.value) el.reciterSelect.value = reciters[0].key;
}

function fillLangSelect() {
  el.langSelect.innerHTML = GLOSS_LANGUAGES.map(
    (l) => '<option value="' + l.code + '">' + l.label + '</option>',
  ).join('');
  el.langSelect.value = settings.lang;
}

function applyDisplaySettings() {
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.style.setProperty('--scale', String(settings.fontSize / 100));
  el.surah.classList.toggle('single', settings.single);
  el.surah.classList.toggle('mushaf', settings.mushaf);
  el.surah.classList.toggle('no-translit', !settings.translit);
  el.surah.classList.toggle('no-gloss', !settings.gloss);
  el.rateOut.textContent = settings.rate.toFixed(2) + '×';
  el.offsetOut.textContent = settings.offset + ' ms';
  el.fontOut.textContent = settings.fontSize + '%';
  el.rate.value = String(settings.rate);
  el.offset.value = String(settings.offset);
  el.fontSize.value = String(settings.fontSize);
  el.repeat.value = settings.repeat;
  el.toggleSingle.checked = settings.single;
  el.toggleMushaf.checked = settings.mushaf;
  el.toggleTranslit.checked = settings.translit;
  el.toggleGloss.checked = settings.gloss;
  el.toggleScroll.checked = settings.autoScroll;
  el.toggleTheme.checked = settings.theme === 'dark';
  el.toggleEdit.checked = settings.edit;
  el.surah.classList.toggle('editing', settings.edit);
  renderer.editing = settings.edit;
  renderer.autoScroll = settings.autoScroll;
  renderer.singleAyah = settings.single;
  setZen(settings.zen, { save: false });
  measureChrome();
}

// Publishes the real height of the toolbar and play bar so the layout can centre an ayah in the
// space that is actually free — these change with the settings row, the font size and focus mode.
function measureChrome() {
  const root = document.documentElement.style;
  root.setProperty('--chrome-top', document.querySelector('.toolbar').offsetHeight + 'px');
  root.setProperty('--chrome-bottom', document.querySelector('.playbar').offsetHeight + 'px');
}

// Measured straight away rather than only from the observer, whose callbacks need a rendering
// frame and so never arrive in a hidden or fully throttled tab.
measureChrome();
window.addEventListener('resize', measureChrome);
const chromeObserver = new ResizeObserver(measureChrome);
chromeObserver.observe(document.querySelector('.toolbar'));
chromeObserver.observe(document.querySelector('.playbar'));

let zenChromeTimer = null;

// The exit button behaves like video-player chrome: it appears on pointer movement, then fades.
function revealZenChrome() {
  document.body.classList.add('zen-chrome');
  clearTimeout(zenChromeTimer);
  zenChromeTimer = setTimeout(() => document.body.classList.remove('zen-chrome'), 2500);
}

function setZen(on, { save = true } = {}) {
  settings.zen = on;
  document.body.classList.toggle('zen', on);
  el.zenToggle.setAttribute('aria-pressed', String(on));
  el.zenExit.hidden = !on;
  if (on) {
    revealZenChrome(); // so entering focus mode always shows the way back out once
  } else {
    clearTimeout(zenChromeTimer);
    document.body.classList.remove('zen-chrome');
  }
  if (save) saveSettings();
}

/* -------------------------------------------------------------------- load */

async function load({ keepVerse = false } = {}) {
  const token = ++loadToken;
  const reciter = findReciter(reciters, settings.reciter);
  const surah = settings.surah;
  const targetVerse = keepVerse ? Math.min(settings.verse, ayahCount(surah)) : 1;

  player.pause();
  showBanner('');
  showStatus('Loading surah ' + surah + ' · ' + reciter.label + ' …');
  el.surah.innerHTML = '';

  try {
    const loaded = await loadSurah(surah, reciter, settings.lang, {
      onProgress: (done, total) => {
        if (token === loadToken) showStatus('Loading timings … ' + done + '/' + total);
      },
    });
    if (token !== loadToken) return;

    bundle = loaded;
    fillAyahSelect(bundle.ayahCount);
    renderer.render(bundle);
    player.setBundle(bundle);
    player.setRate(settings.rate);
    player.setOffset(settings.offset);
    applyRepeat();
    applyRange();

    const index = Math.max(0, bundle.verses.findIndex((v) => v.number === targetVerse));
    player.goToVerse(index);
    renderer.jumpTo(index);

    el.modeBadge.textContent =
      bundle.mode === 'gapless' ? 'gapless · one file per surah' : 'gapped · one file per ayah';

    updateGlossCount();
    const untimed = bundle.verses.filter((v) => v.words.every((w) => w.startMs === null)).length;
    showStatus(untimed ? untimed + ' ayah(s) in this surah have no word timings for this reciter.' : '');
  } catch (error) {
    if (token !== loadToken) return;
    console.error(error);
    showStatus('');
    showBanner(
      reciter.source === 'qul'
        ? 'Could not load this recitation from QUL (' + error.message + '). Pick a quran.com reciter below to carry on.'
        : 'Could not load this surah (' + error.message + '). Check your connection and try again.',
    );
  }
}

function applyRepeat() {
  const value = el.repeat.value === 'Infinity' ? Infinity : Number(el.repeat.value);
  player.setRepeat(value);
}

function applyRange() {
  if (!el.rangeOn.checked || !bundle) {
    player.setRange(null);
    return;
  }
  const total = bundle.ayahCount;
  let from = Math.min(Math.max(1, Number(el.rangeFrom.value) || 1), total);
  let to = Math.min(Math.max(1, Number(el.rangeTo.value) || total), total);
  if (to < from) [from, to] = [to, from];
  el.rangeFrom.value = String(from);
  el.rangeTo.value = String(to);
  player.setRange({ from, to });
}

/* ------------------------------------------------------------------ events */

el.surahSelect.addEventListener('change', () => {
  settings.surah = Number(el.surahSelect.value);
  settings.verse = 1;
  el.rangeFrom.value = '1';
  el.rangeTo.value = String(ayahCount(settings.surah));
  saveSettings();
  load();
});

el.reciterSelect.addEventListener('change', () => {
  settings.reciter = el.reciterSelect.value;
  saveSettings();
  load({ keepVerse: true });
});

el.langSelect.addEventListener('change', () => {
  settings.lang = el.langSelect.value;
  saveSettings();
  load({ keepVerse: true });
});

el.ayahSelect.addEventListener('change', () => {
  const number = Number(el.ayahSelect.value);
  const index = bundle?.verses.findIndex((v) => v.number === number) ?? -1;
  if (index >= 0) {
    player.goToVerse(index);
    renderer.jumpTo(index);
  }
});

el.zenToggle.addEventListener('click', () => {
  setZen(!settings.zen);
  el.zenToggle.blur(); // otherwise Space would re-trigger the button instead of playback
});

el.zenExit.addEventListener('click', () => {
  setZen(false);
  el.zenExit.blur();
});

document.addEventListener('mousemove', () => {
  if (settings.zen) revealZenChrome();
});

el.settingsToggle.addEventListener('click', () => {
  const open = el.settingsRow.hidden;
  el.settingsRow.hidden = !open;
  el.settingsToggle.setAttribute('aria-expanded', String(open));
  measureChrome(); // the toolbar just changed height
});

el.play.addEventListener('click', () => player.toggle());
el.prev.addEventListener('click', () => player.prevVerse());
el.next.addEventListener('click', () => player.nextVerse());

el.seek.addEventListener('pointerdown', () => {
  seeking = true;
});
el.seek.addEventListener('change', () => {
  seeking = false;
  player.seekFraction(Number(el.seek.value) / 1000);
});
el.seek.addEventListener('input', () => {
  const durationMs = player.durationMs();
  el.time.textContent = formatTime((Number(el.seek.value) / 1000) * durationMs);
});

el.rate.addEventListener('input', () => {
  settings.rate = Number(el.rate.value);
  el.rateOut.textContent = settings.rate.toFixed(2) + '×';
  player.setRate(settings.rate);
  saveSettings();
});

el.offset.addEventListener('input', () => {
  settings.offset = Number(el.offset.value);
  el.offsetOut.textContent = settings.offset + ' ms';
  player.setOffset(settings.offset);
  saveSettings();
});

el.fontSize.addEventListener('input', () => {
  settings.fontSize = Number(el.fontSize.value);
  el.fontOut.textContent = settings.fontSize + '%';
  document.documentElement.style.setProperty('--scale', String(settings.fontSize / 100));
  saveSettings();
});

el.repeat.addEventListener('change', () => {
  settings.repeat = el.repeat.value;
  applyRepeat();
  saveSettings();
});

for (const control of [el.rangeOn, el.rangeFrom, el.rangeTo]) {
  control.addEventListener('change', applyRange);
}

el.toggleSingle.addEventListener('change', () => {
  settings.single = el.toggleSingle.checked;
  el.surah.classList.toggle('single', settings.single);
  renderer.singleAyah = settings.single;
  saveSettings();
  // Leaving one-ayah mode: bring the ayah being recited back into view in the scrolling list.
  if (!settings.single) renderer.jumpTo(player.verseIndex);
});

el.toggleMushaf.addEventListener('change', () => {
  settings.mushaf = el.toggleMushaf.checked;
  el.surah.classList.toggle('mushaf', settings.mushaf);
  saveSettings();
});

el.toggleTranslit.addEventListener('change', () => {
  settings.translit = el.toggleTranslit.checked;
  el.surah.classList.toggle('no-translit', !settings.translit);
  saveSettings();
});

el.toggleGloss.addEventListener('change', () => {
  settings.gloss = el.toggleGloss.checked;
  el.surah.classList.toggle('no-gloss', !settings.gloss);
  saveSettings();
});

el.toggleScroll.addEventListener('change', () => {
  settings.autoScroll = el.toggleScroll.checked;
  renderer.autoScroll = settings.autoScroll;
  saveSettings();
});

el.toggleEdit.addEventListener('change', () => {
  settings.edit = el.toggleEdit.checked;
  renderer.editing = settings.edit;
  el.surah.classList.toggle('editing', settings.edit);
  if (!settings.edit) editor.close();
  saveSettings();
});

el.exportGlosses.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(mergedGlosses(), null, 2) + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'gloss-overrides.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

el.toggleTheme.addEventListener('change', () => {
  settings.theme = el.toggleTheme.checked ? 'dark' : 'light';
  document.documentElement.dataset.theme = settings.theme;
  saveSettings();
});

document.addEventListener('keydown', (event) => {
  const tag = event.target.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

  switch (event.key) {
    case ' ':
      event.preventDefault();
      player.toggle();
      break;
    case 'ArrowLeft':
      event.preventDefault();
      player.nextVerse(); // the text runs right-to-left, so left means forward
      break;
    case 'ArrowRight':
      event.preventDefault();
      player.prevVerse();
      break;
    case 'ArrowDown':
      event.preventDefault();
      player.stepWord(1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      player.stepWord(-1);
      break;
    case 'e':
      el.toggleEdit.checked = !el.toggleEdit.checked;
      el.toggleEdit.dispatchEvent(new Event('change'));
      break;
    case 'z':
      setZen(!settings.zen);
      break;
    case 'Escape':
      if (settings.zen) setZen(false);
      break;
    case 'o':
      el.toggleSingle.checked = !el.toggleSingle.checked;
      el.toggleSingle.dispatchEvent(new Event('change'));
      break;
    case 'm':
      el.toggleMushaf.checked = !el.toggleMushaf.checked;
      el.toggleMushaf.dispatchEvent(new Event('change'));
      break;
    case 't':
      el.toggleTheme.checked = !el.toggleTheme.checked;
      el.toggleTheme.dispatchEvent(new Event('change'));
      break;
    case 'r':
      el.repeat.value = el.repeat.value === '0' ? 'Infinity' : '0';
      el.repeat.dispatchEvent(new Event('change'));
      break;
    case '[':
      el.rate.value = String(Math.max(0.5, settings.rate - 0.05));
      el.rate.dispatchEvent(new Event('input'));
      break;
    case ']':
      el.rate.value = String(Math.min(1.5, settings.rate + 0.05));
      el.rate.dispatchEvent(new Event('input'));
      break;
    default:
      break;
  }
});

/* --------------------------------------------------------------- bootstrap */

// Handle for the console: karaoke.player.goToWord(0, 2), karaoke.bundle.verses[9], and so on.
window.karaoke = {
  player,
  renderer,
  get bundle() {
    return bundle;
  },
  get settings() {
    return settings;
  },
};

(async function start() {
  fillSurahSelect();
  fillLangSelect();
  applyDisplaySettings();
  await loadGlosses(); // hand-written glosses must be in hand before the first surah renders
  reciters = await loadReciters();
  if (!reciters.some((r) => r.key === settings.reciter)) settings.reciter = reciters[0].key;
  fillReciterSelect();
  await load({ keepVerse: true });
})();
