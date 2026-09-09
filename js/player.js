// Audio playback and the word-sync engine.
//
// The highlight is driven by requestAnimationFrame rather than the audio element's `timeupdate`
// event, which only fires about four times a second — far too coarse for word-level karaoke.
// `audio.currentTime` is a float and browsers quantise it, so seeking to a boundary of 131272 ms
// reads back as 131271.999 — a hair before the verse that was just jumped to. Without a little
// slack the resolver hands back the *previous* verse and the highlight jumps backwards.
const BOUNDARY_TOLERANCE_MS = 20;

export class Player {
  constructor({ onActiveChange, onStatusChange, onProgress, onError } = {}) {
    this.onActiveChange = onActiveChange || (() => {});
    this.onStatusChange = onStatusChange || (() => {});
    this.onProgress = onProgress || (() => {});
    this.onError = onError || (() => {});

    // No crossOrigin: plain playback needs no CORS, and requesting it would break any audio host
    // that does not send the headers.
    this.audio = new Audio();
    this.audio.preload = 'metadata';
    this.preloader = new Audio(); // warms the HTTP cache for the next ayah in gapped mode
    this.preloader.preload = 'auto';

    this.bundle = null;
    this.verseIndex = 0;
    this.wordIndex = -1;
    this.offsetMs = 0;
    this.rate = 1;
    this.repeatTimes = 0; // 0 = off, 2/3/... = total plays, Infinity = endless
    this.playsLeft = 0;
    this.range = null; // { from, to } as 1-based ayah numbers
    this.rafId = null;
    this.seekGuardUntil = 0;

    this.audio.addEventListener('ended', () => this.handleEnded());
    this.audio.addEventListener('play', () => {
      this.onStatusChange('playing');
      this.startLoop();
    });
    this.audio.addEventListener('pause', () => {
      this.onStatusChange('paused');
      this.stopLoop();
    });
    this.audio.addEventListener('waiting', () => this.onStatusChange('buffering'));
    this.audio.addEventListener('playing', () => {
      this.onStatusChange('playing');
      this.startLoop();
    });
    this.audio.addEventListener('seeked', () => this.tick());

    // Safety net. requestAnimationFrame is frozen in a hidden tab and throttled in an occluded or
    // backgrounded window, which would leave the highlight stuck while the audio keeps going.
    // `timeupdate` fires about four times a second regardless, so the highlight always advances,
    // and the rAF loop restarts as soon as the page is visible again.
    this.audio.addEventListener('timeupdate', () => {
      this.tick();
      if (this.isPlaying()) this.startLoop();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !this.isPlaying()) return;
      this.stopLoop();
      this.startLoop();
    });
    this.audio.addEventListener('error', () => {
      if (this.audio.src) this.onError('Audio could not be loaded — check your connection.');
    });
  }

  /* ------------------------------------------------------------------ setup */

  setBundle(bundle) {
    const wasPlaying = this.isPlaying();
    this.pause();
    this.bundle = bundle;
    this.verseIndex = 0;
    this.wordIndex = -1;
    this.playsLeft = 0;
    this.range = null;

    // Per verse, the indices of words that actually carry timing, in time order.
    for (const verse of bundle.verses) {
      verse.timed = verse.words
        .map((w, i) => (w.startMs === null ? -1 : i))
        .filter((i) => i >= 0)
        .sort((a, b) => verse.words[a].startMs - verse.words[b].startMs);
    }

    if (bundle.mode === 'gapless') {
      this.audio.src = bundle.audio.url;
    } else {
      this.loadVerseFile(0);
    }
    this.audio.playbackRate = this.rate;
    this.emitActive(0, -1, true);
    if (wasPlaying) this.play();
  }

  get verses() {
    return this.bundle?.verses || [];
  }

  isPlaying() {
    return !this.audio.paused && !this.audio.ended;
  }

  isGapless() {
    return this.bundle?.mode === 'gapless';
  }

  /* ---------------------------------------------------------------- helpers */

  verseAudioUrl(index) {
    const verse = this.verses[index];
    return verse ? this.bundle.audio.byVerse?.[verse.key] || null : null;
  }

  loadVerseFile(index) {
    const url = this.verseAudioUrl(index);
    if (!url) return;
    this.audio.src = url;
    this.audio.playbackRate = this.rate;
    const nextUrl = this.verseAudioUrl(index + 1);
    if (nextUrl) this.preloader.src = nextUrl;
  }

  currentMs() {
    return this.audio.currentTime * 1000;
  }

  // Time used for highlighting: the offset slider nudges the highlight ahead of or behind the audio.
  syncMs() {
    return this.currentMs() + this.offsetMs;
  }

  durationMs() {
    if (Number.isFinite(this.audio.duration) && this.audio.duration > 0) return this.audio.duration * 1000;
    if (this.isGapless() && this.bundle.audio.duration) return this.bundle.audio.duration * 1000;
    const verse = this.verses[this.verseIndex];
    return verse?.endMs || 0;
  }

  seekMs(ms) {
    const seconds = Math.max(0, ms) / 1000;
    try {
      this.audio.currentTime = seconds;
    } catch {
      // seeking before metadata is ready
      this.audio.addEventListener('loadedmetadata', () => {
        this.audio.currentTime = seconds;
      }, { once: true });
    }
    this.seekGuardUntil = performance.now() + 300;
    this.tick();
  }

  /* -------------------------------------------------------------- transport */

  async play() {
    if (!this.bundle) return;
    try {
      await this.audio.play();
    } catch (err) {
      if (err?.name !== 'AbortError') this.onError('Playback was blocked by the browser — press play again.');
    }
  }

  pause() {
    this.audio.pause();
  }

  toggle() {
    if (this.isPlaying()) this.pause();
    else this.play();
  }

  setRate(rate) {
    this.rate = rate;
    this.audio.playbackRate = rate;
    if ('preservesPitch' in this.audio) this.audio.preservesPitch = true;
  }

  setOffset(ms) {
    this.offsetMs = ms;
    this.tick();
  }

  setRepeat(times) {
    this.repeatTimes = times;
    this.playsLeft = times ? times - 1 : 0;
  }

  setRange(range) {
    this.range = range;
    if (range) {
      const index = range.from - 1;
      if (this.verseIndex < index || this.verseIndex > range.to - 1) this.goToVerse(index);
    }
  }

  goToVerse(index, { play = false } = {}) {
    const verse = this.verses[index];
    if (!verse) return;
    this.playsLeft = this.repeatTimes ? this.repeatTimes - 1 : 0;
    if (this.isGapless()) {
      this.verseIndex = index;
      this.seekMs((verse.startMs ?? 0) - this.offsetMs);
    } else {
      this.verseIndex = index;
      this.loadVerseFile(index);
      this.seekMs(0);
    }
    // Forced: verseIndex was assigned above so tick() resolves from the right place, which means
    // a plain emit would compare equal and return without ever telling the renderer to move.
    this.emitActive(index, -1, true);
    if (play || this.isPlaying()) this.play();
  }

  goToWord(verseIndex, wordIndex) {
    const verse = this.verses[verseIndex];
    const word = verse?.words[wordIndex];
    if (!verse) return;
    if (verseIndex !== this.verseIndex && !this.isGapless()) {
      this.verseIndex = verseIndex;
      this.loadVerseFile(verseIndex);
    }
    this.verseIndex = verseIndex;
    // Words without timing fall back to the nearest earlier timed word in the same verse.
    let ms = word?.startMs;
    if (ms === null || ms === undefined) {
      const earlier = verse.timed.filter((i) => i <= wordIndex);
      ms = earlier.length ? verse.words[earlier[earlier.length - 1]].startMs : verse.startMs ?? 0;
    }
    this.seekMs(ms - this.offsetMs);
    this.emitActive(verseIndex, wordIndex, true);
  }

  nextVerse() {
    this.goToVerse(Math.min(this.verseIndex + 1, this.verses.length - 1));
  }

  prevVerse() {
    // Restart the current ayah first, like a music player's "previous track".
    const verse = this.verses[this.verseIndex];
    const intoVerse = this.syncMs() - (this.isGapless() ? verse?.startMs ?? 0 : 0);
    if (intoVerse > 1500) this.goToVerse(this.verseIndex);
    else this.goToVerse(Math.max(this.verseIndex - 1, 0));
  }

  stepWord(delta) {
    const verse = this.verses[this.verseIndex];
    if (!verse) return;
    const target = this.wordIndex + delta;
    if (target < 0) {
      if (this.verseIndex > 0) {
        const prev = this.verses[this.verseIndex - 1];
        this.goToWord(this.verseIndex - 1, Math.max(prev.words.length - 1, 0));
      }
      return;
    }
    if (target >= verse.words.length) {
      if (this.verseIndex < this.verses.length - 1) this.goToWord(this.verseIndex + 1, 0);
      return;
    }
    this.goToWord(this.verseIndex, target);
  }

  seekFraction(fraction) {
    if (this.isGapless()) {
      this.seekMs(fraction * this.durationMs());
    } else {
      const verse = this.verses[this.verseIndex];
      this.seekMs(fraction * (verse?.endMs || this.durationMs()));
    }
  }

  /* -------------------------------------------------------------- sync loop */

  startLoop() {
    if (this.rafId !== null) return;
    const step = () => {
      // Schedule the next frame before doing any work: a throw inside tick() must not be able to
      // kill the loop for good and leave rafId pointing at a frame that will never run again.
      this.rafId = requestAnimationFrame(step);
      try {
        this.tick();
      } catch (error) {
        console.error('[karaoke] sync tick failed', error);
      }
    };
    this.rafId = requestAnimationFrame(step);
  }

  stopLoop() {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  tick() {
    if (!this.bundle) return;
    const t = this.syncMs();
    const verseIndex = this.isGapless() ? this.resolveVerse(t) : this.verseIndex;
    const verse = this.verses[verseIndex];

    if (verse) {
      const wordIndex = this.resolveWord(verse, t);
      this.emitActive(verseIndex, wordIndex);
    } else {
      this.emitActive(this.verseIndex, -1); // leading basmala, before the first timed ayah
    }

    this.onProgress(this.currentMs(), this.durationMs());
    if (this.isPlaying()) this.enforceBoundaries(t);
  }

  // Index of the last verse whose start is at or before `t`; -1 before the first one.
  resolveVerse(time) {
    const t = time + BOUNDARY_TOLERANCE_MS;
    const verses = this.verses;
    const current = verses[this.verseIndex];
    if (current && current.startMs !== null && t >= current.startMs && (current.endMs === null || time <= current.endMs)) {
      return this.verseIndex;
    }
    const next = verses[this.verseIndex + 1];
    if (next && next.startMs !== null && t >= next.startMs && (next.endMs === null || time <= next.endMs)) {
      return this.verseIndex + 1;
    }

    let lo = 0;
    let hi = verses.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const start = verses[mid].startMs;
      if (start === null || start <= t) {
        if (start !== null) found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  // Word whose segment contains `t`; otherwise the last word that has already started, so the
  // highlight stays put through the short silences inside an ayah.
  resolveWord(verse, time) {
    const t = time + BOUNDARY_TOLERANCE_MS;
    const timed = verse.timed || [];
    if (!timed.length) return -1;
    const words = verse.words;
    if (t < words[timed[0]].startMs) return -1;

    let lo = 0;
    let hi = timed.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const word = words[timed[mid]];
      if (word.startMs <= t) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found === -1 ? -1 : timed[found];
  }

  emitActive(verseIndex, wordIndex, force = false) {
    if (!force && verseIndex === this.verseIndex && wordIndex === this.wordIndex) return;
    const verseChanged = verseIndex !== this.verseIndex;
    this.verseIndex = verseIndex;
    this.wordIndex = wordIndex;
    if (verseChanged && this.repeatTimes) this.playsLeft = this.repeatTimes - 1;
    this.onActiveChange(verseIndex, wordIndex, verseChanged);
  }

  // Repeat and A–B range only need enforcing in gapless mode, where playback would otherwise
  // simply run on into the next ayah. Gapped mode handles it in `handleEnded`.
  enforceBoundaries(t) {
    if (!this.isGapless() || performance.now() < this.seekGuardUntil) return;
    const verse = this.verses[this.verseIndex];
    if (!verse || verse.endMs === null) return;

    if (this.repeatTimes && t >= verse.endMs) {
      if (this.repeatTimes === Infinity || this.playsLeft > 0) {
        if (this.playsLeft > 0) this.playsLeft--;
        this.seekMs((verse.startMs ?? 0) - this.offsetMs);
        return;
      }
      this.repeatTimes = 0;
    }

    if (this.range && this.verseIndex >= this.range.to - 1 && t >= verse.endMs) {
      const start = this.verses[this.range.from - 1];
      if (start) {
        this.verseIndex = this.range.from - 1;
        this.seekMs((start.startMs ?? 0) - this.offsetMs);
      }
    }
  }

  handleEnded() {
    if (this.isGapless()) {
      this.onStatusChange('ended');
      return;
    }
    if (this.repeatTimes && (this.repeatTimes === Infinity || this.playsLeft > 0)) {
      if (this.playsLeft > 0) this.playsLeft--;
      this.seekMs(0);
      this.play();
      return;
    }
    const last = this.range ? this.range.to - 1 : this.verses.length - 1;
    const nextIndex = this.verseIndex + 1;
    if (nextIndex > last) {
      if (this.range) {
        this.goToVerse(this.range.from - 1, { play: true });
      } else {
        this.onStatusChange('ended');
      }
      return;
    }
    this.goToVerse(nextIndex, { play: true });
  }
}
