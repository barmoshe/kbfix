# kbfix

A Claude Code plugin that recovers text typed with the wrong keyboard layout
selected.

```
בםצצןא שמג פודי אם צשןמ   ->  commit and push to main
ksudnt                    ->  לדוגמא
```

Nothing was lost when you typed that. The keystrokes landed; only the table that
rendered them was wrong. kbfix reads every prompt, and when it is confident the
keys came out of the other layout it tells Claude how the prompt actually reads.

## What it does not do

**It never rewrites your prompt.** It adds a note saying how it read the text and
leaves what you typed exactly as you typed it. This is the whole design
constraint: a wrong guess has to stay visible and correctable. A tool that
silently replaced your words would, on its first false positive, destroy
something you meant.

For the same reason it would rather say nothing than guess. It abstains on mixed
Hebrew and English, on anything under four letters, and whenever the original
reads about as well as the transposition does.

## Install

```
/plugin marketplace add barmoshe/kbfix
/plugin install kbfix@kbfix
```

Needs `node` on your PATH. Ships with English and Hebrew; see
[layouts/README.md](layouts/README.md) to add your own pair.

## Use

Most of the time you do nothing. Type a sentence with the wrong input source
selected, send it, and Claude reads it correctly.

When you want to convert something by hand:

```
/kbfix ksudnt
```

Or from the shell:

```bash
node scripts/kbfix.mjs "בםצצןא שמג פודי אם צשןמ"   # detect and print the reading
node scripts/kbfix.mjs --json "..."                 # full verdict with scores
node scripts/kbfix.mjs --explain "..."              # per-token breakdown
node scripts/kbfix.mjs --to-en "..."                # force a direction, no scoring
node scripts/kbfix.mjs --force "..."                # transpose anyway after it abstained
```

Exit 0 means confident, 3 means it abstained.

## Configure

Copy [kbfix.config.example.json](kbfix.config.example.json) to `.kbfix.json` in
your project, or `~/.kbfix.json` for the whole machine. Project wins over home.

```json
{
  "pair": "en-he",
  "directions": ["he->en", "en->he"],
  "minTargetScore": 0.55,
  "minMargin": 0.35
}
```

Drop a direction to switch it off. Raise the thresholds to make it quieter.

## How it decides

For each prompt it transposes the text through the layout table and asks one
question: does the result read more like real prose than the original did? It
says so only when the gap is wide.

"Reads like real prose" is three channels per language. A list of the most
frequent words scores 1 outright. A character-bigram model scores everything
else on whether the spelling is plausible for that language. A structural rule
caps the score when a near-decisive tell fires: in Hebrew, a final form
(`ך ם ן ף ץ`) anywhere but the end of a word, which does not happen in real
words and happens constantly in layout junk.

The bigram channel is the one that earns its keep. A word list can say "this is
not gibberish" but it cannot say "this is Hebrew" about a word it has never
seen, and that is most of the language. `לדוגמא` is nobody's stopword, so a
list-only scorer cannot recover `ksudnt` at all.

The margin requirement is what keeps ordinary prompts safe. Real prose scores
near 1 in its own language, and a transposition of it cannot beat that by the
required margin, so there is nothing for a false positive to stand on.

Both models are generated from published frequency corpora by
`scripts/build-model.mjs` and committed. Nothing is tuned by hand at runtime.

## Accuracy

Measured on this machine with `scripts/stress.mjs`, over sentences built from
the same corpora the model was trained on:

| | result |
|---|---|
| False positives, 24,000 lines of real English and Hebrew | **0** |
| Caught: English typed on the Hebrew layout | 99.7% |
| Caught: Hebrew typed on the English layout | 99.3% |
| Caught: short mistypes, 2 to 3 words | 98.4% / 98.8% |
| Exact decode, of those caught | 99.9% |

`node scripts/kbfix.mjs --bench` is the committed gate and must stay at zero
false positives.

## Known limits

All verified against the real layouts, not assumed:

- **Capitals are destroyed at the keyboard.** 21 shifted Latin letters emit
  nothing at all on the Hebrew layout, so `Push` loses its `P` before any
  software sees it. Capitalisation is unrecoverable in principle.
- **`C` and `K` both emit `לֹ`**, so that character decodes to `c`.
- **Digits and most symbols are identical in both layouts.** They carry no
  directional signal, so a number-heavy string is genuinely undecidable.
- **Mixed-script lines are left alone** rather than half-decoded. `אם` is at once
  real Hebrew ("if") and layout-typed `to`.
- **Short mistypes get missed.** `.פר` could be `/pr`, but four letters is the
  floor for having any evidence at all.
- **The shipped table is for macOS "ABC" and "Hebrew".** It is wrong for
  "Hebrew - QWERTY" and "Hebrew - PC". Generate your own with
  `swift scripts/dump-layout.swift`.

## Development

```bash
node scripts/kbfix.mjs --self-test    # fixtures, including must-abstain cases
node scripts/kbfix.mjs --bench        # the false-positive gate
bash tests/hook.test.sh               # the hook wrapper's fail-open contract
node scripts/build-model.mjs --pair en-he   # regenerate the scoring model
node scripts/stress.mjs --pair en-he        # thousands of lines from the corpora
```

`tests/fixtures.json` and `tests/bench.json` are data. Add the case that bit you.

## Credits

Word frequencies from [Peter Norvig's](https://norvig.com/ngrams/) count_1w and
[eyaler/hebrew_wordlists](https://github.com/eyaler/hebrew_wordlists) (CC-100
intersected with hspell).

MIT.
