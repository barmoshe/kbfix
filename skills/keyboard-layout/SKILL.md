---
name: keyboard-layout
description: Use when text arrived through the wrong keyboard layout, so it looks like consonant soup in another alphabet. Covers the kbfix tool, every direction between the installed layouts (English, Hebrew, Russian), and the four ways a naive character swap gets it wrong. Triggers on unreadable strings like "בםצצןא שמג פודי", "ksudnt" or "ghbdtn", "this is gibberish", "wrong keyboard", "fix this text I typed in the wrong language", "layout", "מקלדת", "раскладка", or a prompt that only parses once transposed.
license: MIT
---

# Wrong keyboard layout

When the wrong input source is selected the keystrokes still register, but the
characters arrive from whichever layout was active. `commit and push to main`
typed while Hebrew is selected arrives as `בםצצןא שמג פודי אם צשןמ`, `לדוגמא`
typed while English is selected arrives as `ksudnt`, and `привет` arrives as
`ghbdtn`. Nothing is lost except the rendering, so all of it is recoverable.

English, Hebrew, Russian and Spanish ship. Everything is expressed against one
reference keyboard (US ANSI), so decoding is two hops: text back to the keys that
were pressed, then forward into the layout that was meant.

**Spanish is a special case worth knowing before you promise anything.** It
shares the Latin script with English and puts every letter in the same place, so
a wrong-layout mistake there mangles punctuation and nothing else. `ma;ana` is
recoverable as `mañana` because `;` is where `ñ` lives. Accented vowels are dead
keys and are gone for good, and correctly typed Spanish is untouched because
transposing it changes nothing.

A `UserPromptSubmit` hook already handles the common case: when it is confident
it annotates the prompt with the reading, and otherwise it stays silent. Reach
for this skill for the manual cases, or when the hook abstained and the text
still looks wrong.

## The tool

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kbfix.mjs" "בםצצןא שמג פודי אם צשןמ"
```

`--json` for the full verdict with scores, `--explain` for the per-token
breakdown when you want to know why it decided what it decided, `--to <lang>` to
transpose without scoring, `--layouts` to see what is installed, `--force` to transpose anyway after it
abstained, `--self-test` and `--bench` for the gates. Exit 0 means confident, 3
means it abstained. `--help` carries the full flag list.

Detection runs between **every installed layout** and is whole-message or
nothing. The verdict is symmetric: transpose into each other layout, then ask
whether any reading is plausible prose, clearly better than the text as typed,
and clearly better than the runner-up. With three layouts a Latin string has two
possible readings, and when both look fine it abstains rather than pick.

## How it decides

Three channels per language, in descending order of trust. A word list of the
most frequent words scores 1 outright. A character-bigram model scores
everything else on whether the spelling is plausible for that language. A
structural rule caps the score when a near-decisive tell fires.

The bigram channel is the one that matters for anything interesting. A word list
can say "this is not gibberish" but it cannot say "this is Hebrew" about a word
it has never seen, and that is most of the language. `לדוגמא` is nobody's
stopword, so under a list-only scorer `ksudnt` is undetectable.

Both channels are generated from frequency corpora by `scripts/build-model.mjs`
and committed as `layouts/<lang>/model.json`. Nothing is tuned by hand at
runtime. If you change the model, re-run `--bench` and `scripts/stress.mjs`
before trusting it.

## Four things a naive character swap gets wrong

1. **Capitals vanish on the Hebrew layout.** 21 shifted Latin letters
   (`Q W E R T Y I O P S F G H J L Z X V B N M`) emit nothing there. `Push`
   loses its `P` at the keyboard, so intended capitalisation is unrecoverable
   and you must never claim to have restored it. This is a property of the
   script, not a bug: Hebrew is unicameral. Russian is bicameral and drops
   nothing, so there the case genuinely survives and `Ghbdtn` reads as `Привет`.
2. **Five capitals do emit, and two collide.** `A→שׁ`, `C→לֹ`, `D→„`, `K→לֹ`,
   `U→וֹ`. These are multi-codepoint (letter plus niqqud), so decode
   longest-match first. `C` and `K` both give `לֹ`, and the tool picks `c`.
3. **Punctuation shifts silently.** `q→/`, `w→׳`, `'→,`, `,→ת`, `.→ץ`, `/→.`,
   `;→ף`, `` ` ``→`;`, and `[`↔`]` swap. A decoder that only handles א-ת mangles
   these. This is why `/commit` arrives as `.בםצצןא`.
4. **Digits and most symbols are identical across layouts,** so they carry zero
   directional signal. A number-heavy string is genuinely undecidable.

## When to abstain

The tool refuses rather than guesses in these cases, and you should too:

- **Mixed scripts.** `commit and push לmain` is left alone. Half-decoding is
  worse than not decoding, because short words are ambiguous: `אם` is at once
  real Hebrew ("if") and layout-typed `to`.
- **Two readings score equally well.** Latin input could be intended Hebrew or
  intended Russian. When neither wins clearly, no answer is safe.
- **Transposing changes nothing.** Between two layouts of the same script there
  is simply no evidence, which is why correctly typed Spanish is never touched.
- **Mostly punctuation.** The scorer reads only letters, so `if (a) { b(); }`
  offers almost nothing to judge.
- **Under four signal letters.** `.פר` could be `/pr`, but there is not enough
  evidence. Ask.
- **The original reads about as well as the transposition.** No call is safe.

The strongest single tell that Hebrew text is layout junk rather than real
Hebrew: a **final form** (`ך ם ן ף ץ`) anywhere but the end of a word. Real
Hebrew words do not do that. `בםצצןא` has two.

## Gotchas seen in practice

- **Say how you read it, in one line, then act.** The original text stays
  visible so a bad reading is correctable. Do not silently rewrite it, and do
  not stop to ask when the reading is unambiguous.
- **A reading that does not fit the conversation is probably wrong.** The scorer
  only knows whether the words are real, not whether the request makes sense
  here. If it reads as valid prose but asks for something that makes no sense in
  context, ask rather than act.
- **The shipped tables are for specific input sources.** They are correct for
  macOS "ABC", "Hebrew" and "Russian" (the standard ЙЦУКЕН board), and wrong for
  "Hebrew - QWERTY", "Hebrew - PC" and the phonetic "Russian - QWERTY". See
  `layouts/README.md` to generate your own.
