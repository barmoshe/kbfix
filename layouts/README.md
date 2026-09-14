# Layouts

A layout is data. Adding a language means adding a folder here, not editing any
code.

```
layouts/<lang>/
  layout.json       what every physical key emits on that input source
  corpus.json       where the scoring model's frequency corpus comes from
  extra-words.json  optional hand-curated vocabulary merged into the word list
  model.json        generated, committed: word list, bigram table, calibration
```

Everything is expressed against one **reference keyboard**, the US ANSI layout
(`layouts/en/`), and a key is named by the character that reference emits. So
decoding is two hops: text back to the keys that were pressed, then forward into
the layout that was meant. Each layout is one table, so a language costs one
folder no matter how many others are installed.

kbfix runs on **two** of them at a time, named by `pair` in `.kbfix.json`.
Installing a layout makes it available; it does not put it into the detector.

Shipped: English (the reference), Hebrew, Russian, Spanish.

**Before adding a language, check whether it shares a script with one already
here.** That single fact decides how well it can possibly work. Hebrew and
Russian write different scripts from English, so every letter moves and a
wrong-layout mistake is fully recoverable. Spanish writes the same script and
puts every letter `a` to `z` in the same place: exactly zero letters differ
between the two tables, so the only recoverable mistake is a punctuation key that
the other layout reads as a letter (`;` for `ñ`). A same-script layout will never
reach the accuracy of a cross-script one, no matter how good its corpus is.

## The shipped tables are not universal

They were extracted from the macOS input sources **"ABC"**, **"Hebrew"**,
**"Russian"** (the standard ЙЦУКЕН board) and **"Spanish"** (ISO). They are wrong
for **"Hebrew - QWERTY"**, **"Hebrew - PC"**, the phonetic **"Russian -
QWERTY"**, and **"Spanish - Legacy"**, which map differently. If you use one of
those, or another language, generate your own.

## 1. Dump the table from your own machine

Do not write the table from memory. Ask the operating system what the keys
actually do:

```bash
swift scripts/dump-layout.swift --list                     # what you have installed
swift scripts/dump-layout.swift "ABC" "Russian" --json     # the table
```

macOS only. It calls `UCKeyTranslate` against both layouts' real keyboard data
over every keycode and prints the keys where they disagree. Keys that agree are
absent by design: they carry no directional signal, which is why a digit-heavy
string is undecidable no matter how good the scorer is.

Copy `base` and `shift` into `keys`, and `droppedOnB` into `dropped`:

```json
{
  "lang": "ru",
  "label": "Russian",
  "hasCase": true,
  "letterClass": "а-яёА-ЯЁ",
  "keys": [["q", "й"], ["w", "ц"], "..."],
  "dropped": ""
}
```

Five fields decide behaviour, and most of them are easy to get wrong:

- **`script`** groups layouts that write the same alphabet. Detection works per
  script, not per language, because nothing in the characters says which of two
  same-script layouts produced them. Get this wrong and two layouts will offer
  rival readings of the same text and cancel each other out under the ambiguity
  gate, which cost Hebrew-to-English recall a fifth of its accuracy before the
  grouping existed.

- **`hasCase`** is whether the script is bicameral. Hebrew is not, so a shifted
  key there is almost always a habit artefact and decoding falls back to the
  unshifted letter. Russian is, so `Shift+K` really is `Л` and the capital is
  preserved. Setting this wrong either destroys capitals or invents them.
- **`dropped`** lists keys that emit nothing on this layout. On the Hebrew board
  21 shifted Latin letters emit nothing, so their case is destroyed before any
  software sees it. Russian drops nothing. Spanish drops `[ { ' "`, which are
  dead keys for accents: they wait for a following vowel, so they are not
  recoverable and accented Spanish cannot be reconstructed.
- **`letterClass`** is expanded into a literal character set. Include both cases
  for a bicameral script (`а-яёА-ЯЁ`), and do not forget the letters that sit
  outside the main range, such as `ё`.
- **`finalForms`** and **`vowels`** are optional and drive the structural rule: a
  final form away from the end of a word (Hebrew), or a vowel-less run
  (English). Declare neither and the language relies on its word list and
  bigrams, which is what Russian does.

Two things to check in the dump before trusting it:

- **Order decides collisions,** in both directions, first entry wins. On the
  Hebrew board `C` and `K` both emit `לֹ` and `C` is listed first, so `לֹ`
  recovers as `c`. On the Russian board two physical keys both read as `.` on
  the reference board, emitting `ю` and `,`; the first is the one people mean.
- **`dropped` may include non-letters.** The dumper reports every key with no
  output, which on a Mac includes `§` and `±`. Keep only the letters.

## 2. Build the scoring model

Name a frequency corpus in `corpus.json`, a plain `word<separator>count` file:

```json
{
  "url": "https://...",
  "separator": " ",
  "trainFilterFile": "/usr/share/dict/words",
  "trainMaxWords": 60000
}
```

Then:

```bash
node scripts/build-model.mjs --lang ru
```

Three things decide whether the result is any good.

**Corpus quality.** A raw web or subtitle frequency list is partly not the
language it claims to be, and training on that noise makes the model permissive
enough to accept another language pushed through a key table. `trainFilterFile`
intersects the training set with a real dictionary, which widened the English
separation from 0.56 to 0.92; where no dictionary is available, `trainMaxWords`
caps the long tail instead. Neither affects the word list, so domain words like
`github` stay recognised.

**Morphology.** Use a corpus whose forms look like running text. Hebrew attaches
`ל ב ו ה ש מ כ` directly to the word, and a base-form list misses most of what
people type: `לדוגמה` is absent from the base list and rank 1987 in the
with-prefixes one.

**Negatives are kept per source language, never pooled.** The builder calibrates
against every other layout's real words pushed through the real key tables, and
takes the percentile of the **hardest** confuser. Pooling is a bug: languages
differ in how confusable they are once transposed, and one easy source drags a
pooled percentile down, quietly making the model permissive toward the hard one.
Adding Russian pooled moved the English bound from -3.49 to -3.92 and broke
detection of `ksudnt` outright. The builder prints each source's bound and marks
which one sets the bar. Below about 0.5 separation the scorer will not
discriminate and the corpus needs fixing first.

## 3. Prove it

```bash
node scripts/kbfix.mjs --self-test   # fixtures, including must-abstain cases
node scripts/kbfix.mjs --bench       # the false-positive gate
node scripts/stress.mjs              # thousands of lines, every direction
```

Add cases to `tests/fixtures.json` and `tests/bench.json` for your language. The
bench matters more than the fixtures: a miss costs nothing, but a false positive
puts words in somebody's mouth. Anything that fires there is a bug, not a tuning
opportunity.

`--bench` runs every line under every pair, and `stress.mjs` sweeps every pair in
turn, because accuracy is a property of the PAIR and not of the toolkit. Check
the pairs your new language forms with each existing one, not just the obvious
one against English.

This used to matter far more. When the detector searched every installed layout
at once, adding Spanish quietly cut Hebrew-to-English recall from 99.4% to 77.6%
and introduced false positives in text that had nothing to do with Spanish, all
while its own fixtures passed. Configuring one pair at a time removed that whole
class of interference: a language you are not using cannot cost you anything.
