# Quran Karaoke

A browser Quran reader that plays a recitation and lights up the word being recited right now,
with a word-by-word gloss under every word.

By default it shows **one ayah at a time**, centred and enlarged, and flips to the next ayah as the
recitation reaches it. Turn *One ayah* off to get the whole surah as a scrolling list that follows
along instead.

No build step, no dependencies, no API key — plain HTML, CSS and ES modules.

## Run it

ES modules need a real origin, so open it through a local server rather than double-clicking the file:

```bash
npx serve .          # or: python -m http.server 8000
```

Then open <http://localhost:8000>.

## Where the data comes from

| What | Source |
| --- | --- |
| Word text, word-by-word gloss, transliteration | `api.quran.com/api/v4/verses/by_chapter` |
| Word timings + gapless surah audio (40 reciters) | `qul.tarteel.ai/api/v1/audio/surah_segments` |
| Word timings + ayah-by-ayah audio (12 reciters) | `api.quran.com/api/v4/recitations/{id}/by_chapter?fields=segments` |

Both come from Tarteel's [Quranic Universal Library](https://qul.tarteel.ai) data lineage and are
public and CORS-open, so the page talks to them directly. A surah is fetched once and then kept in
IndexedDB, so replaying it works offline.

Two timing shapes are normalized in `js/data.js`: QUL segments are `[wordPosition, startMs, endMs]`
and absolute within the surah-long mp3; quran.com segments are `[index, wordPosition, startMs, endMs]`
and local to that ayah's own file.

## Controls

| | |
| --- | --- |
| `Space` | play / pause |
| `←` / `→` | next / previous ayah |
| `↓` / `↑` | next / previous word |
| `R` | endless repeat of the current ayah |
| `[` `]` | slower / faster |
| `Z` / `Esc` | enter / leave focus mode |
| `E` | edit words on / off |
| `O` | one-ayah mode |
| `M` | mushaf-line layout |
| `T` | dark mode |

**Focus mode** (the *Focus* button or `Z`) strips the page down to the ayah alone — toolbar, play
bar and the word line under it all go, leaving whatever word options you have switched on. Playback
stays on the keyboard and on clicking a word; an exit hint fades in whenever you move the pointer,
and `Esc` leaves. An error banner is still allowed through, so a failed load never shows a blank
screen. Add `F11` for true fullscreen.

Click any word to jump the audio there. The **Sync offset** slider shifts the highlight relative to
the audio (±500 ms) if a reciter's timings feel early or late. **Loop range** repeats a stretch of
ayahs for memorization.

## Word-by-word languages

English is complete. Turkish, Bengali, Persian, Hindi, Tamil and Ingush have gaps — where a word
has no gloss the API silently returns the English one, so the app fetches an English pass alongside
the chosen language and renders those words muted and italic, which is the giveaway that you are
looking at a fallback. German word-by-word exists in QUL but is copyright-restricted and not served.

## Fixing the untranslated words by hand

Where a language has no gloss for a word, the API returns the English one and the app renders it
muted. You can correct those yourself:

1. Switch on **Edit words** in Settings (or press `E`). Untranslated words get a dashed outline.
2. Click a word. A small editor opens showing the Arabic, the transliteration and the English gloss
   as a reference, with the current text ready to overwrite.
3. `Enter` saves, `Tab` saves and moves to the next word, **Next gap →** jumps to the next word that
   is still English, `Esc` closes. **Reset** puts the original text back.

Edited words keep a dotted underline so your own work stays visible. Edits live in `localStorage`,
keyed by language and `surah:ayah:wordPosition`, and are re-applied over the cached surah on every
load — changing reciter, surah or language never loses them.

To make them permanent and portable, press **Export edits**: it downloads a `gloss-overrides.json`
like

```json
{ "tr": { "18:10:5": "mağaraya", "18:10:10": "kendi katından" } }
```

Drop that file into `data/` (replacing the empty one) and it loads on every browser and device.
The file is the base layer and `localStorage` edits win over it, so exporting again always gives you
everything merged.

## Refreshing the reciter catalog

`js/catalog.js` ships with a built-in list. `data/qul-reciters.json` (already generated) widens it
with every gapless QUL recitation that has segments:

```bash
node scripts/qul-reciters.mjs
```

It scrapes the QUL resource index, keeps the entries tagged *Surah by Surah* + *With segments*, and
resolves each one's internal recitation id from its detail page.

## Files

```
index.html          markup and controls
css/styles.css      theme tokens, word cards, highlight states
js/app.js           state, control wiring, keyboard, persistence
js/data.js          fetch + normalize + IndexedDB cache
js/player.js        audio element and the requestAnimationFrame sync loop
js/render.js        DOM build, highlight swap, auto-scroll, focus panel
js/catalog.js       endpoints, reciter list, gloss languages
js/glosses.js       hand-written gloss overrides (file layer + localStorage)
js/editor.js        the click-to-edit gloss popover
js/surahs.js        static surah metadata (generated once)
scripts/qul-reciters.mjs   catalog builder
```

## Theming

The light palette is deep teal on warm cream, defined as four raw colours at the top of
`css/styles.css`:

```css
--teal: #004c56;   /* ink, accent, buttons, sliders */
--cream: #f0ebdb;  /* page background */
--sage: #a2c2c0;   /* borders and the active-word pill */
--sage-deep: #88a7a5;  /* focus rings, edited-word underline */
```

Panels are white. The secondary and muted text tints are mixed from the teal and the cream with
`color-mix()` rather than being picked separately, because `--sage-deep` only reaches 2.2:1 against
the cream — fine for a border, not for a word. Everything else is a semantic token (`--fg`,
`--muted`, `--accent`, …), so swapping those four lines re-skins the whole app. Dark mode is a
separate block and untouched.

## Debugging

The page exposes `window.karaoke` — `karaoke.player`, `karaoke.renderer`, `karaoke.bundle`,
`karaoke.settings` — so the sync engine can be driven from the console, e.g.
`karaoke.player.goToWord(9, 4)` or `karaoke.bundle.verses[9].words`.

Note that Chrome does not load audio in a hidden tab, so playback can only start in a visible
window. The highlight itself survives throttling: `requestAnimationFrame` drives it at full frame
rate when the window is visible, and the audio element's `timeupdate` event keeps it moving (about
four times a second) when rAF is frozen or throttled.
