---
description: Convert text that was typed with the wrong keyboard layout selected
argument-hint: <text>
---

Convert `$ARGUMENTS` through the keyboard layout table.

Run the tool and report what it says:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kbfix.mjs" --json "$ARGUMENTS"
```

Then:

- **If `confident` is true**, give the reading in `decoded` as the answer, in one
  short line. Do not pad it with the scores.
- **If `confident` is false**, say it is not sure and show both transpositions so
  the person can pick, using `--to-en` and `--to-he`. The `reason` field says
  which gate it failed: not enough letters, mixed scripts, or the original
  reading about as well as the transposition. Say which one in plain words.
- **If they clearly want one specific direction**, skip the scoring entirely and
  use `--to-en` or `--to-he`.

This command converts on request, so it has no confidence gate to respect: when
someone explicitly asks, give them the transposition even if the detector would
have abstained. That is what `--force` is for.

Never present a guess as certain. Capitalisation is lost at the keyboard on the
Hebrew side and cannot be recovered, so do not claim to have restored it.
