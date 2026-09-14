# Layout pairs

A layout pair is data. Adding one means adding a folder here, not editing any
code. The engine reads whichever pair `.kbfix.json` names.

```
layouts/<pair-id>/
  layout.json    the key table: what each physical key produces on each side
  corpus.json    where the scoring model's frequency corpora come from
  extra-words.json  optional hand-curated vocabulary merged into the word lists
  model.json     generated, committed: word lists, bigram tables, calibration
```

## The shipped pair is not universal

`en-he` was extracted from the macOS input sources **"ABC"** and plain
**"Hebrew"**. It is wrong for **"Hebrew - QWERTY"** and **"Hebrew - PC"**, which
map differently. If you use one of those, or any other pair of languages,
generate your own.

## 1. Dump the table from your own machine

Do not write the table from memory. Ask the operating system what the keys
actually do:

```bash
swift scripts/dump-layout.swift --list                       # what you have installed
swift scripts/dump-layout.swift "ABC" "Hebrew" --json        # the table
```

macOS only. It calls `UCKeyTranslate` against both layouts' real keyboard data
over every keycode and prints the keys where they disagree. Keys that agree are
absent by design: they carry no directional signal, so a digit-heavy string is
genuinely undecidable no matter how good the scorer is.

Copy `base`, `shift` and `droppedOnB` into your `layout.json`, and fill in the
rest:

```json
{
  "id": "en-ru",
  "a": { "lang": "en", "label": "English", "letterClass": "A-Za-z", "vowels": "aeiouy" },
  "b": { "lang": "ru", "label": "Russian", "letterClass": "а-я", "finalForms": [] }
}
```

`letterClass` is expanded into a literal character set, so ranges and single
characters both work. `vowels` and `finalForms` are optional: they drive the
structural rules, which cap a token's score when a near-decisive tell fires (a
vowel-less run in English, a final form away from the end of a Hebrew word). A
side that declares neither simply relies on the word list and bigrams.

Two things to check in the dump before trusting it:

- **Order decides collisions.** The reverse map takes the first side-a key
  listed for a given side-b character. On `en-he`, `C` and `K` both emit `לֹ` and
  `C` is listed first, so `לֹ` decodes to `c`.
- **`droppedOnB` may include non-letters.** The dumper reports every key with no
  output on side b, which on a Mac includes `§` and `±`. Keeping only the
  letters is what the shipped table does.

## 2. Build the scoring model

Name two frequency corpora in `corpus.json`, one per side, each a plain
`word<separator>count` file:

```json
{
  "a": { "url": "...", "separator": "\t", "trainFilterFile": "/usr/share/dict/words", "trainMaxWords": 40000 },
  "b": { "url": "...", "separator": "," }
}
```

Then:

```bash
node scripts/build-model.mjs --pair en-ru
```

Two things decide whether the result is any good.

**Corpus quality.** A raw web-frequency list is mostly not the language it claims
to be, and training on that noise makes the model permissive enough to accept
the other language pushed through the layout. `trainFilterFile` intersects the
training set with a real dictionary, which widened the English separation from
0.56 to 0.92. It only affects bigram training, never the word list, so domain
words like `github` and `npm` stay recognised.

**Morphology.** Use a corpus whose forms look like running text. Hebrew attaches
`ל ב ו ה ש מ כ` directly to the word, and a base-form list misses most of what
people actually type: `לדוגמה` is absent from the base list and rank 1987 in the
with-prefixes one. The same applies to any language with clitics or heavy
inflection.

The builder prints a **separation** figure per side, the gap between real words
and the other language transposed through your table. Below about 0.5 the
scorer will not discriminate and you should fix the corpus before going further.

## 3. Prove it

```bash
node scripts/kbfix.mjs --self-test      # fixtures, including must-abstain cases
node scripts/kbfix.mjs --bench          # the false-positive gate
node scripts/stress.mjs --pair en-ru    # thousands of lines from the corpora
```

Add cases to `tests/fixtures.json` and `tests/bench.json` for your pair. The
bench matters more than the fixtures: a miss costs nothing, but a false positive
puts words in somebody's mouth. Anything that fires there is a bug, not a tuning
opportunity.
