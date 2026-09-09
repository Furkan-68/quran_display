// Builds the surah once, then moves the highlight by toggling classes on a couple of nodes.
// Nothing is re-rendered while the audio plays.

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export class Renderer {
  constructor({ container, focus, onWordClick, onWordEdit }) {
    this.container = container;
    this.focus = focus;
    this.onWordClick = onWordClick || (() => {});
    this.onWordEdit = onWordEdit || (() => {});
    this.editing = false; // while on, clicking a word edits its gloss instead of seeking

    this.verseEls = [];
    this.wordEls = [];
    this.activeVerse = -1;
    this.activeWord = -1;
    this.autoScroll = true;
    this.singleAyah = false; // in one-ayah mode there is nothing to scroll to
    this.suspendScrollUntil = 0;
    this.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.container.addEventListener('click', (event) => {
      const button = event.target.closest('.word');
      if (!button) return;
      const verseIndex = Number(button.dataset.v);
      const wordIndex = Number(button.dataset.w);
      if (this.editing) this.onWordEdit(verseIndex, wordIndex, button);
      else this.onWordClick(verseIndex, wordIndex);
    });

    // Any manual scrolling pauses auto-follow for a few seconds so the page stops fighting the user.
    const suspend = () => {
      this.suspendScrollUntil = performance.now() + 4000;
    };
    this.container.addEventListener('wheel', suspend, { passive: true });
    this.container.addEventListener('touchstart', suspend, { passive: true });
  }

  render(bundle) {
    const html = bundle.verses
      .map((verse, vi) => {
        const words = verse.words
          .map((word, wi) => {
            const glossClass = word.fallback ? 'gl fallback' : 'gl';
            const title = word.fallback ? ' title="No gloss in this language — English shown"' : '';
            const edited = word.edited ? ' edited' : '';
            return (
              '<button class="word' + edited + '" type="button" data-v="' + vi + '" data-w="' + wi + '"' + title + '>' +
              '<span class="ar">' + escapeHtml(word.arabic) + '</span>' +
              '<span class="tl">' + escapeHtml(word.translit) + '</span>' +
              '<span class="' + glossClass + '">' + escapeHtml(word.gloss) + '</span>' +
              '</button>'
            );
          })
          .join('');
        const marker = verse.endMarker
          ? '<span class="end-marker" aria-hidden="true">' + escapeHtml(verse.endMarker) + '</span>'
          : '';
        const untimed = verse.words.every((w) => w.startMs === null) ? ' untimed' : '';
        return (
          '<section class="verse' + untimed + '" data-index="' + vi + '" id="verse-' + vi + '">' +
          '<div class="verse-key">' + escapeHtml(verse.key) + '</div>' +
          '<div class="verse-words">' + words + marker + '</div>' +
          '</section>'
        );
      })
      .join('');

    this.container.innerHTML = html;
    this.verseEls = Array.from(this.container.querySelectorAll('.verse'));
    this.wordEls = this.verseEls.map((el) => Array.from(el.querySelectorAll('.word')));
    this.activeVerse = -1;
    this.activeWord = -1;
    this.bundle = bundle;
  }

  setActive(verseIndex, wordIndex, verseChanged) {
    if (verseChanged || verseIndex !== this.activeVerse) {
      const previous = this.verseEls[this.activeVerse];
      if (previous) {
        previous.classList.remove('active');
        for (const word of this.wordEls[this.activeVerse] || []) word.classList.remove('read', 'active');
      }
      const current = this.verseEls[verseIndex];
      if (current) current.classList.add('active');
      this.activeVerse = verseIndex;
      this.activeWord = -1;
      if (current) this.scrollTo(current, 'center');
    }

    if (wordIndex === this.activeWord) return;
    const words = this.wordEls[verseIndex] || [];
    const previousWord = words[this.activeWord];
    if (previousWord) previousWord.classList.remove('active');

    // Everything before the active word in this ayah counts as already recited.
    if (wordIndex > this.activeWord) {
      for (let i = Math.max(this.activeWord, 0); i < wordIndex; i++) words[i]?.classList.add('read');
    } else {
      for (let i = wordIndex; i <= this.activeWord; i++) words[i]?.classList.remove('read');
    }

    const currentWord = words[wordIndex];
    if (currentWord) {
      currentWord.classList.add('active');
      currentWord.classList.remove('read');
      this.scrollIfOffscreen(currentWord);
    }
    this.activeWord = wordIndex;
    this.updateFocus(verseIndex, wordIndex);
  }

  wordElement(verseIndex, wordIndex) {
    return this.wordEls[verseIndex]?.[wordIndex] || null;
  }

  // Repaints one word after its gloss was edited — no re-render, so playback is undisturbed.
  updateWord(verseIndex, wordIndex, word) {
    const button = this.wordElement(verseIndex, wordIndex);
    if (!button) return;
    const gloss = button.querySelector('.gl');
    gloss.textContent = word.gloss;
    gloss.classList.toggle('fallback', !!word.fallback);
    button.classList.toggle('edited', !!word.edited);
    if (word.fallback) button.title = 'No gloss in this language — English shown';
    else button.removeAttribute('title');
    if (verseIndex === this.activeVerse && wordIndex === this.activeWord) {
      this.updateFocus(verseIndex, wordIndex);
    }
  }

  updateFocus(verseIndex, wordIndex) {
    if (!this.focus || !this.bundle) return;
    const verse = this.bundle.verses[verseIndex];
    const word = verse?.words[wordIndex];
    this.focus.key.textContent = verse ? verse.key : '';
    this.focus.arabic.textContent = word ? word.arabic : '';
    this.focus.translit.textContent = word ? word.translit : '';
    this.focus.gloss.textContent = word ? word.gloss : '';
    this.focus.gloss.classList.toggle('fallback', !!word?.fallback);
    // Show the English gloss too when the chosen language has its own wording.
    const secondary = word && word.glossEn && word.glossEn !== word.gloss ? word.glossEn : '';
    this.focus.secondary.textContent = secondary;
    this.focus.secondary.hidden = !secondary;
  }

  scrollTo(element, block) {
    if (this.singleAyah || !this.autoScroll || performance.now() < this.suspendScrollUntil) return;
    element.scrollIntoView({ block, behavior: this.reduceMotion ? 'auto' : 'smooth' });
  }

  scrollIfOffscreen(element) {
    if (this.singleAyah || !this.autoScroll || performance.now() < this.suspendScrollUntil) return;
    const rect = element.getBoundingClientRect();
    const margin = 80;
    if (rect.top < margin || rect.bottom > window.innerHeight - margin) {
      element.scrollIntoView({ block: 'center', behavior: this.reduceMotion ? 'auto' : 'smooth' });
    }
  }

  jumpTo(verseIndex) {
    this.suspendScrollUntil = 0;
    if (this.singleAyah) return;
    const element = this.verseEls[verseIndex];
    if (element) element.scrollIntoView({ block: 'center', behavior: 'auto' });
  }
}
