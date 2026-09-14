# kbfix

A Claude Code plugin that recovers text typed with the wrong keyboard layout
selected.

```
בםצצןא שמג פודי אם צשןמ   ->  commit and push to main
ksudnt                    ->  לדוגמא
ghbdtn                    ->  привет
руддщ                     ->  hello
ma;ana                    ->  mañana
```

Nothing was lost when you typed that. The keystrokes landed; only the table that
rendered them was wrong. kbfix reads every prompt, and when it is confident the
keys came out of the wrong layout it tells Claude how the prompt actually reads.

It works on **two languages at a time**, both ways, and you choose which two. It
is not a language detector and it will not guess among several languages: you
configure a pair, and it converts between exactly those. English, Hebrew, Russian
and Spanish ship; adding a language is adding a folder.

## What it does not do

**It never rewrites your prompt.** It adds a note saying how it read the text and
leaves what you typed exactly as you typed it. This is the whole design
constraint: a wrong guess has to stay visible and correctable. A tool that
silently replaced your words would, on its first false positive, destroy
something you meant.

For the same reason it would rather say nothing than guess. It abstains on mixed
scripts, on anything under four letters, on text that is mostly punctuation, and
whenever the original reads about as well as the transposition does.

## Install

```
/plugin marketplace add barmoshe/kbfix
/plugin install kbfix@kbfix
```

Needs `node` on your PATH. The default pair is English and Hebrew; set `pair` in
`.kbfix.json` to change it.

## Use

Most of the time you do nothing. Type a sentence with the wrong input source
selected, send it, and Claude reads it correctly.

When you want to convert something by hand:

```
/kbfix ghbdtn
```

Or from the shell:

```bash
node scripts/kbfix.mjs "בםצצןא שמג פודי אם צשןמ"   # detect and print the reading
node scripts/kbfix.mjs --json "..."                 # full verdict, every candidate
node scripts/kbfix.mjs --explain "..."              # per-token breakdown
node scripts/kbfix.mjs --pair en-ru "ghbdtn"        # use another pair for one run
node scripts/kbfix.mjs --to ru "hello"              # force a direction, no scoring
node scripts/kbfix.mjs --force "..."                # best guess after it abstained
node scripts/kbfix.mjs --layouts                    # what is installed, and the active pair
```

Exit 0 means confident, 3 means it abstained.

## Configure

Copy [kbfix.config.example.json](kbfix.config.example.json) to `.kbfix.json` in
your project, or `~/.kbfix.json` for the whole machine. Project wins over home.

```json
{
  "pair": ["en", "he"],
  "minTargetScore": 0.65,
  "minMargin": 0.35
}
```

`pair` is the one setting that matters. Raise the thresholds to make it quieter.

## How it decides

Everything is expressed against one reference keyboard, the US ANSI layout, and a
key is named by the character that reference emits. Decoding is two hops: text
back to the keys that were pressed, then forward into the layout that was meant.
Each layout is one small table, so a language costs one folder.

For each prompt it works out which of your two configured languages the text is
written in, transposes it into the other, and asks whether the result is
plausible prose and clearly better than the text as typed. For a cross-script
pair the characters settle the direction outright, which is why there is nothing
to guess.

"Reads like prose" is three channels per language. A list of the most frequent
words scores 1 outright. A character-bigram model scores everything else on
whether the spelling is plausible for that language. A structural rule caps the
score when a near-decisive tell fires: in Hebrew, a final form (`ך ם ן ף ץ`)
anywhere but the end of a word, which does not happen in real words and happens
constantly in layout junk.

The bigram channel is the one that earns its keep. A word list can say "this is
not gibberish" but it cannot say "this is Hebrew" about a word it has never seen,
and that is most of the language. `לדוגמא` is nobody's stopword, so a list-only
scorer cannot recover `ksudnt` at all.

The margin requirement is what keeps ordinary prompts safe. Real prose scores
near 1 in its own language, and a transposition of it cannot beat that by the
required margin, so there is nothing for a false positive to stand on.

Models are generated from published frequency corpora by
`scripts/build-model.mjs` and committed. Nothing is tuned by hand at runtime.

## Accuracy

Accuracy is a property of the **pair**, not of the tool, so it is reported that
way. Measured with `scripts/stress.mjs`, 4,000 lines per sweep, zero false
positives in every pair:

| pair | caught | exact decode |
|---|---|---|
| **en ↔ he** (default) | 99.9% / 99.7% | **100%** |
| **en ↔ ru** | 99.9% / 99.9% | **100%** |
| **he ↔ ru** | 99.7% / 99.7% | **100%** |
| en ↔ es | 0% / 5.5% | 100% |
| es ↔ he | 48% / 82% | partial |
| es ↔ ru | 49% / 96% | partial |

The three cross-script pairs are what this is for. Spanish is the odd one out for
a reason no amount of tuning changes, explained below.

`node scripts/kbfix.mjs --bench` is the committed gate: every line must be left
alone under **every** pair, not just the configured one, because a line that is
safe under en-he can still be misread under en-ru.

## Known limits

All verified against the real layouts, not assumed:

- **On the Hebrew layout, capitals are destroyed at the keyboard.** 21 shifted
  Latin letters emit nothing at all, so `Push` loses its `P` before any software
  sees it. Capitalisation is unrecoverable in principle there. Russian has a full
  uppercase alphabet, so `Ghbdtn` correctly reads as `Привет`.
- **`C` and `K` both emit `לֹ`**, so that character decodes to `c`.
- **Digits and most symbols are identical across layouts.** They carry no
  directional signal, so a number-heavy string is genuinely undecidable.
- **Mixed-script lines are left alone** rather than half-decoded. `אם` is at once
  real Hebrew ("if") and layout-typed `to`.
- **Only the configured pair is considered.** With `en-he` set, `ghbdtn` is left
  alone rather than read as `привет`. That is the design: two at a time, chosen
  rather than guessed. Use `--pair en-ru` for a one-off.
- **Short mistypes get missed.** `.פר` could be `/pr`, but four letters is the
  floor for having any evidence at all.
- **Text that is mostly punctuation is left alone.** The models only read
  letters, so `if (a) { b(); }` offers four letters to judge on, and they spell
  `if`, `a` and `b`. It needs letters to be at least half the non-space
  characters.
- **The shipped tables are for the macOS "ABC", "Hebrew", "Russian" and
  "Spanish" input sources.** They are wrong for "Hebrew - QWERTY", "Hebrew - PC"
  and the phonetic "Russian - QWERTY". Generate your own with
  `swift scripts/dump-layout.swift`.

## Why Spanish barely works, and Hebrew and Russian do

This is worth stating plainly, because it is a property of the alphabets and not
something a better model would fix.

Hebrew and Russian write **different scripts** from English. Every letter moves,
so a wrong-layout mistake turns a sentence into visible nonsense, and every one of
those characters is evidence. `commit and push to main` becomes
`בםצצןא שמג פודי אם צשןמ`, and recovering it is close to certain.

Spanish writes the **same script** as English and puts every letter `a` to `z` in
the same place. Compare the two key tables and exactly **zero letters** differ.
So a Spanish speaker on a US keyboard does not get nonsense, they get Spanish with
one wrong character: `ma;ana` for `mañana`. There is no signal to recover except
that single punctuation mark.

What follows from that:

- **`ñ` and `ç` are recoverable.** `ma;ana` reads as `mañana`, because `;` sits
  where `ñ` does and a punctuation mark wedged inside a word is real evidence.
- **Accented vowels are not.** `á` is a dead-key sequence, two keystrokes, and
  this model maps single keys. `pequeno` stays `pequeno`.
- **Correctly typed Spanish is never touched.** Transposing it changes nothing at
  all, and no change means no evidence. Without that rule every Spanish sentence
  would be flagged as mistyped English, since the Spanish model scores it 1.0 and
  the English model does not.
- **Spanish typed on a Hebrew or Russian board recovers normally,** at about 45%.
  That is a different script, so the usual machinery applies; the shortfall is
  accented words, which arrive as mixed script and are left alone by design.

The honest summary: the `en-es` pair buys you `ñ` and nothing else. Spanish
paired with Hebrew or Russian behaves normally, because that is a cross-script
pair like any other.

## Development

```bash
node scripts/kbfix.mjs --self-test   # fixtures, including must-abstain cases
node scripts/kbfix.mjs --bench       # the false-positive gate
bash tests/hook.test.sh              # the hook wrapper's fail-open contract
node scripts/build-model.mjs         # regenerate every scoring model
node scripts/stress.mjs              # thousands of lines, every direction
```

`tests/fixtures.json` and `tests/bench.json` are data. Add the case that bit you.
To add a language, see [layouts/README.md](layouts/README.md).

## Credits

Word frequencies from [Peter Norvig's](https://norvig.com/ngrams/) count_1w,
[eyaler/hebrew_wordlists](https://github.com/eyaler/hebrew_wordlists) (CC-100
intersected with hspell), and
[hermitdave/FrequencyWords](https://github.com/hermitdave/FrequencyWords)
(OpenSubtitles 2018).

MIT.
