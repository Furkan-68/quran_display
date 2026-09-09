// A small popover for correcting a word's gloss by hand — mainly for the words where the chosen
// language has no entry and the API hands back the English one instead.
//
// Keyboard while it is open: Enter saves, Tab saves and moves to the next word, Shift+Tab to the
// previous, Escape closes. "Next gap" jumps to the next word still showing English.
import { clearGloss, hasLocalGloss, setGloss } from './glosses.js';
import { applyGlossToWord } from './data.js';

const TEMPLATE = `
  <div class="ge-head">
    <span class="ge-key"></span>
    <button class="ge-close" type="button" aria-label="Close">✕</button>
  </div>
  <div class="ge-ar"></div>
  <div class="ge-meta">
    <span class="ge-tl"></span>
    <span class="ge-en"></span>
  </div>
  <input class="ge-input" type="text" autocomplete="off" spellcheck="false" />
  <div class="ge-actions">
    <button class="ge-save" type="button">Save</button>
    <button class="ge-reset" type="button">Reset</button>
    <button class="ge-next-gap" type="button">Next gap →</button>
  </div>
  <div class="ge-hint">Enter save · Tab next word · Esc close</div>
`;

export class GlossEditor {
  constructor({ getBundle, onSaved, onGoToWord }) {
    this.getBundle = getBundle;
    this.onSaved = onSaved || (() => {});
    this.onGoToWord = onGoToWord || (() => {});
    this.verseIndex = -1;
    this.wordIndex = -1;

    this.root = document.createElement('div');
    this.root.className = 'gloss-editor';
    this.root.hidden = true;
    this.root.innerHTML = TEMPLATE;
    document.body.appendChild(this.root);

    this.input = this.root.querySelector('.ge-input');
    this.root.querySelector('.ge-close').addEventListener('click', () => this.close());
    this.root.querySelector('.ge-save').addEventListener('click', () => this.save());
    this.root.querySelector('.ge-reset').addEventListener('click', () => this.reset());
    this.root.querySelector('.ge-next-gap').addEventListener('click', () => this.nextGap());

    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.save();
        this.close();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.close();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        this.save();
        this.step(event.shiftKey ? -1 : 1);
      }
    });

    document.addEventListener('pointerdown', (event) => {
      if (this.root.hidden) return;
      if (this.root.contains(event.target) || event.target.closest('.word')) return;
      this.close();
    });
  }

  get isOpen() {
    return !this.root.hidden;
  }

  wordAt(verseIndex, wordIndex) {
    const verse = this.getBundle()?.verses[verseIndex];
    return verse ? { verse, word: verse.words[wordIndex] } : null;
  }

  open(verseIndex, wordIndex, anchor) {
    const found = this.wordAt(verseIndex, wordIndex);
    if (!found?.word) return;
    const { verse, word } = found;

    this.verseIndex = verseIndex;
    this.wordIndex = wordIndex;
    this.root.querySelector('.ge-key').textContent = verse.key + ' · word ' + word.pos;
    this.root.querySelector('.ge-ar').textContent = word.arabic;
    this.root.querySelector('.ge-tl').textContent = word.translit;
    // The English gloss is the thing being translated, so it is always shown as the reference.
    this.root.querySelector('.ge-en').textContent = word.glossEn || word.origGloss || '';
    this.root.querySelector('.ge-reset').hidden = !hasLocalGloss(this.getBundle().lang, verse.key, word.pos);

    this.input.value = word.gloss || '';
    this.root.hidden = false;
    this.position(anchor);
    // The Arabic line reflows once the Quran font is in, which changes the popover's height, so
    // place it again after that layout settles rather than trusting the first measurement.
    setTimeout(() => this.position(anchor), 0);
    document.fonts?.ready.then(() => {
      if (!this.root.hidden) this.position(anchor);
    });
    this.input.focus();
    this.input.select();
  }

  position(anchor) {
    const rect = anchor?.getBoundingClientRect();
    const box = this.root.getBoundingClientRect();
    const margin = 8;
    let left = rect ? rect.left + rect.width / 2 - box.width / 2 : window.innerWidth / 2 - box.width / 2;
    let top = rect ? rect.bottom + margin : window.innerHeight / 2;
    if (rect && top + box.height > window.innerHeight - margin) top = rect.top - box.height - margin;
    left = Math.max(margin, Math.min(left, window.innerWidth - box.width - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - box.height - margin));
    this.root.style.left = left + 'px';
    this.root.style.top = top + 'px';
  }

  close() {
    this.root.hidden = true;
    this.verseIndex = -1;
    this.wordIndex = -1;
  }

  save() {
    const found = this.wordAt(this.verseIndex, this.wordIndex);
    if (!found?.word) return;
    const bundle = this.getBundle();
    const { verse, word } = found;
    const value = this.input.value.trim();

    if (value && value !== word.gloss) {
      setGloss(bundle.lang, verse.key, word.pos, value);
    } else if (!value) {
      clearGloss(bundle.lang, verse.key, word.pos);
    }
    applyGlossToWord(bundle.lang, verse.key, word);
    this.onSaved(this.verseIndex, this.wordIndex, word);
  }

  reset() {
    const found = this.wordAt(this.verseIndex, this.wordIndex);
    if (!found?.word) return;
    const bundle = this.getBundle();
    clearGloss(bundle.lang, found.verse.key, found.word.pos);
    applyGlossToWord(bundle.lang, found.verse.key, found.word);
    this.onSaved(this.verseIndex, this.wordIndex, found.word);
    this.input.value = found.word.gloss || '';
    this.root.querySelector('.ge-reset').hidden = true;
  }

  step(delta) {
    const bundle = this.getBundle();
    let verseIndex = this.verseIndex;
    let wordIndex = this.wordIndex + delta;

    while (verseIndex >= 0 && verseIndex < bundle.verses.length) {
      const words = bundle.verses[verseIndex].words;
      if (wordIndex >= 0 && wordIndex < words.length) {
        this.onGoToWord(verseIndex, wordIndex);
        return;
      }
      verseIndex += delta;
      const next = bundle.verses[verseIndex];
      if (!next) break;
      wordIndex = delta > 0 ? 0 : next.words.length - 1;
    }
    this.close();
  }

  // The next word still showing an English fallback, from wherever the editor is now.
  nextGap() {
    const bundle = this.getBundle();
    let verseIndex = this.verseIndex < 0 ? 0 : this.verseIndex;
    let wordIndex = this.wordIndex + 1;

    for (; verseIndex < bundle.verses.length; verseIndex++, wordIndex = 0) {
      const words = bundle.verses[verseIndex].words;
      for (; wordIndex < words.length; wordIndex++) {
        if (words[wordIndex].fallback) {
          this.onGoToWord(verseIndex, wordIndex);
          return;
        }
      }
    }
    this.root.querySelector('.ge-hint').textContent = 'No more untranslated words in this surah.';
  }
}
