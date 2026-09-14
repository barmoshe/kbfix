# kbfix

A Claude Code plugin that recovers text typed with the wrong keyboard layout
selected.

```
בםצצןא שמג פודי אם צשןמ   ->  commit and push to main
ksudnt                    ->  לדוגמא
ghbdtn                    ->  привет
руддщ                     ->  hello
```

Nothing was lost when you typed that. The keystrokes landed; only the table that
rendered them was wrong. kbfix reads every prompt, and when it is confident the
keys came out of the wrong layout it tells Claude how the prompt actually reads.

English, Hebrew and Russian ship. Adding a language is adding a folder.

## What it does not do

**It never rewrites your prompt.** It adds a note saying how it read the text and
leaves what you typed exactly as you typed it. This is the whole design
constraint: a wrong guess has to stay visible and correctable. A tool that
silently replaced your words would, on its first false positive, destroy
something you meant.

For the same reason it would rather say nothing than guess. It abstains on mixed
scripts, on anything under four letters, and whenever the original reads about as
well as the transposition does. With three layouts it also abstains when two
languages read equally well, because then neither answer is safe.

## Install

```
/plugin marketplace add barmoshe/kbfix
/plugin install kbfix@kbfix
```

Needs `node` on your PATH.

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
node scripts/kbfix.mjs --to ru "hello"              # force a direction, no scoring
node scripts/kbfix.mjs --force "..."                # best guess after it abstained
node scripts/kbfix.mjs --layouts                    # what is installed
```

Exit 0 means confident, 3 means it abstained.

## Configure

Copy [kbfix.config.example.json](kbfix.config.example.json) to `.kbfix.json` in
your project, or `~/.kbfix.json` for the whole machine. Project wins over home.

```json
{
  "layouts": ["en", "he"],
  "minTargetScore": 0.55,
  "minMargin": 0.35,
  "minCandidateGap": 0.15
}
```

Listing only the layouts you actually type is worth doing: every extra language
adds a candidate reading to every prompt. Raise the thresholds to make it
quieter.

## How it decides

Everything is expressed against one reference keyboard, the US ANSI layout, and a
key is named by the character that reference emits. Decoding is two hops: text
back to the keys that were pressed, then forward into the layout that was meant.
Three layouts give six directions and still only three tables.

For each prompt it works out which alphabet the text is in, transposes it into
every other layout, and asks whether any reading is plausible prose, clearly
better than the text as typed, and clearly better than the runner-up.

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

Measured with `scripts/stress.mjs` over sentences built from the same corpora the
models were trained on, 4,000 lines per sweep:

| | result |
|---|---|
| False positives, 36,000 lines of real English, Hebrew and Russian | **0** |
| Caught, English typed on the Hebrew or Russian layout | 99.9% |
| Caught, Hebrew typed on the English or Russian layout | 99.4% / 99.5% |
| Caught, Russian typed on the English or Hebrew layout | 99.7% / 99.6% |
| Exact decode, of those caught | **100%** |

`node scripts/kbfix.mjs --bench` is the committed gate and must stay at zero
false positives.

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
- **Short mistypes get missed.** `.פר` could be `/pr`, but four letters is the
  floor for having any evidence at all.
- **The shipped tables are for the macOS "ABC", "Hebrew" and "Russian" input
  sources.** They are wrong for "Hebrew - QWERTY", "Hebrew - PC" and the
  phonetic "Russian - QWERTY". Generate your own with
  `swift scripts/dump-layout.swift`.

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
