#!/usr/bin/env node
/**
 * kbfix - recover text typed with the wrong keyboard layout selected.
 *
 * When the wrong input source is active the keystrokes still land; only the
 * table that rendered them was wrong. `commit and push to main` typed on the
 * Hebrew layout arrives as `בםצצןא שמג פודי אם צשןמ`, `לדוגמא` typed on the
 * English one arrives as `ksudnt`, and `привет` arrives as `ghbdtn`. All of it
 * is recoverable.
 *
 * Detection is symmetric and works over any number of layouts. Identify which
 * alphabet the text is in, transpose it into every other installed layout, and
 * ask whether any of those readings is both plausible prose AND clearly better
 * than both the original and the runner-up. Otherwise say nothing: with three
 * layouts a Latin string has two possible readings, and picking the wrong one
 * is worse than picking neither.
 *
 * What it never does is rewrite the prompt. The hook emits additionalContext
 * naming the reading and leaves the original text exactly as typed, so a false
 * positive stays visible and correctable instead of silently destroying what
 * somebody actually wrote.
 *
 * Usage:
 *   kbfix "בםצצןא שמג פודי אם צשןמ"   detect and print the reading
 *   kbfix --json "..."                full verdict, with every candidate
 *   kbfix --to ru "..."               force one direction, no scoring
 *   kbfix --force "..."               best transposition even when not confident
 *   kbfix --explain "..."             per-token scoring breakdown
 *   echo '<hook json>' | kbfix --hook UserPromptSubmit mode
 *   kbfix --self-test                 fixtures
 *   kbfix --bench                     false-positive gate on real prose
 *
 * Exit codes (non-hook modes): 0 confident, 3 abstained, 1 usage error.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadLayouts, installedLayouts, transpose, scriptCounts, PLUGIN_ROOT,
} from './lib/layout.mjs';
import { loadModel, makeScorer, structuralRuleFor } from './lib/score.mjs';
import { loadConfig } from './lib/config.mjs';

const TESTS_DIR = join(PLUGIN_ROOT, 'tests');

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export function createEngine(config = loadConfig()) {
  const langs = config.layouts && config.layouts.length ? config.layouts : installedLayouts();
  const layouts = loadLayouts(langs);

  const scorers = new Map();
  for (const [lang, L] of layouts) {
    scorers.set(lang, makeScorer(loadModel(lang), { letters: L.letters, structural: structuralRuleFor(L) }));
  }

  const allowed = config.directions ? new Set(config.directions) : null;
  const permitted = (from, to) => !allowed || allowed.has(`${from}->${to}`);

  // Group the layouts by script. `primary` is the one layout per script used to
  // transpose through (the reference keyboard where there is one), and
  // `sameScript` holds every script that has more than one layout, which is
  // where the awkward cases live.
  const byScript = new Map();
  for (const L of layouts.values()) {
    if (!byScript.has(L.script)) byScript.set(L.script, []);
    byScript.get(L.script).push(L);
  }
  const primary = new Map();
  for (const [script, list] of byScript) primary.set(script, list.find((L) => L.reference) || list[0]);
  const sameScript = new Map([...byScript].filter(([, list]) => list.length > 1));

  /**
   * How well does this text read in ANY language written in this script?
   *
   * Taking the best is what stops a Spanish sentence being "recovered" as
   * Hebrew: `duro jo` is mediocre English but perfectly good Spanish, and the
   * margin has to be measured against the best explanation of the text as
   * typed, not against whichever language happens to be listed first.
   */
  function bestScriptScore(text, script) {
    let best = 0;
    for (const L of byScript.get(script) || []) best = Math.max(best, scorers.get(L.lang)(text));
    return best;
  }

  /**
   * Whole-message or nothing. A line mixing two alphabets is left alone rather
   * than half-decoded, because short words are genuinely ambiguous: `אם` is both
   * real Hebrew ("if") and layout-typed `to`.
   */
  function analyze(text) {
    const raw = text ?? '';
    const counts = scriptCounts(raw, layouts);
    const present = [...counts].filter(([, n]) => n > 0);
    const signal = present.reduce((n, [, c]) => n + c, 0);
    const base = { input: raw, decoded: null, direction: null, confident: false, candidates: [] };

    if (signal < config.minSignalChars) return { ...base, reason: 'not enough letters to judge' };
    if (present.length > 1) return { ...base, reason: 'mixed scripts, left alone by design' };

    // The language models only read letters, so a mostly-punctuation string is
    // judged on almost nothing. `if (a) { b(); }` has exactly four letters, and
    // they happen to spell if/a/b, which scored a flawless 1.0 as English and
    // produced a confident reading of pure mangled code. Density, not just
    // count: four letters out of four characters is evidence, four out of
    // eleven is not.
    const dense = raw.replace(/\s+/g, '').length;
    if (dense > 0 && signal / dense < config.minLetterDensity) {
      return { ...base, reason: 'too much punctuation relative to letters to judge' };
    }

    // The characters name a SCRIPT, not a layout, and detection is organised
    // the same way. Two layouts of one script agree on every letter, so they
    // produce near-identical readings of the same input: offering both as rival
    // candidates made them cancel each other out under the ambiguity gate and
    // cost Hebrew-to-English recall a fifth of its accuracy. One candidate per
    // target script, transposed through that script's reference layout, scored
    // by whichever of its languages fits best.
    const script = present[0][0];
    const sourceScore = round(bestScriptScore(raw, script));

    const candidates = [];
    for (const [targetScript, toL] of primary) {
      if (targetScript === script) continue;

      // Which layout of the source script actually produced this text is not
      // knowable from the characters, and it matters: Russian typed on a
      // Spanish board arrives with ñ where ж should be, and recovering it
      // through the English table leaves that ñ stranded inside a Cyrillic
      // word. So try each one and keep the reading that comes out cleanest.
      // Still ONE candidate per target script, so the alternatives never
      // compete with each other under the ambiguity gate.
      let best = null;
      for (const fromL of byScript.get(script) || []) {
        if (!permitted(fromL.lang, toL.lang)) continue;
        const decoded = transpose(raw, fromL, toL);
        if (decoded === raw) continue;
        const junk = intraWordJunk(decoded, toL);
        const score = junk
          ? Math.min(round(bestScriptScore(decoded, targetScript)), GLUED_SOURCE_CAP)
          : round(bestScriptScore(decoded, targetScript));
        if (!best || score > best.target) {
          best = {
            // Named by language, which is what a person reads, even though the
            // candidate is really "this script read as that one".
            direction: `${fromL.lang}->${toL.lang}`,
            decoded,
            target: score,
            source: sourceScore,
            ...(junk ? { junk } : {}),
          };
        }
      }
      if (best) candidates.push(best);
    }

    // Within one script the letters are identical, so the only recoverable
    // mistake is a punctuation key that the other layout reads as a LETTER:
    // ma;ana for mañana. Demand exactly that as the price of admission, which
    // is why correctly typed Spanish never produces a candidate at all.
    for (const fromL of sameScript.get(script) || []) {
      const from = fromL.lang;
      for (const toL of sameScript.get(script) || []) {
        const to = toL.lang;
        if (to === from || !permitted(from, to)) continue;
        const decoded = transpose(raw, fromL, toL);
        // No change means no evidence. Between two layouts that agree on every
        // letter, most text transposes to itself, and scoring an unchanged
        // string would just compare two language models and "detect" a mistype
        // in text nobody mistyped: every correctly typed Spanish sentence would
        // be flagged as English gone wrong. If the keys produce the same
        // characters, there is nothing to report.
        if (decoded === raw) continue;
        const glued = gluedLetters(raw, decoded, fromL, toL);
        if (!glued) continue;

        // The word scorer cannot see this on its own: it splits on the very
        // character that is the evidence and then scores the two halves as real
        // words, which is how `ma;ana` scored a flawless 1.0 as English.
        const junk = intraWordJunk(decoded, toL);
        const targetScore = round(scorers.get(to)(decoded));
        candidates.push({
          direction: `${from}->${to}`,
          decoded,
          target: junk ? Math.min(targetScore, GLUED_SOURCE_CAP) : targetScore,
          source: Math.min(round(scorers.get(from)(raw)), GLUED_SOURCE_CAP),
          glued,
          ...(junk ? { junk } : {}),
        });
      }
    }
    if (candidates.length === 0) {
      return { ...base, reason: 'transposing changes nothing, so there is no evidence either way' };
    }
    candidates.sort((a, b) => b.target - a.target);
    const distinct = candidates;

    const best = distinct[0];
    const runnerUp = distinct[1];
    return verdict({
      ...base,
      direction: best.direction,
      decoded: best.decoded,
      target: best.target,
      source: best.source,
      runnerUp: runnerUp ? round(runnerUp.target) : null,
      candidates: distinct,
    }, config);
  }

  return { layouts, langs, config, analyze, scorers, analyzeCandidatesOnly: analyze };
}

/**
 * Three gates, all of which must pass.
 *
 * `target` is how much the reading looks like real prose. `margin` is how far it
 * beats the text as typed, and it is the one that keeps ordinary prompts safe:
 * real prose scores near 1 in its own language, so nothing can out-run it.
 * `gap` is how far the best reading beats the second-best, and it only exists
 * once there are three or more layouts: when Latin input reads plausibly as both
 * Hebrew and Russian, neither answer is safe to give.
 */
function verdict(v, config) {
  const margin = round(v.target - v.source);
  const gap = v.runnerUp === null ? null : round(v.target - v.runnerUp);

  const failedTarget = v.target < config.minTargetScore;
  const failedMargin = margin < config.minMargin;
  const failedGap = gap !== null && gap < config.minCandidateGap;
  const confident = !failedTarget && !failedMargin && !failedGap;

  return {
    ...v,
    scores: { target: round(v.target), source: round(v.source), margin, gap },
    confident,
    reason: confident
      ? 'the transposed text reads as real prose and the original does not'
      : failedTarget
        ? 'the transposed text does not read as real prose'
        : failedMargin
          ? 'the original reads about as well as the transposition, so no call is safe'
          : 'two layouts read about equally well, so the reading is ambiguous',
  };
}

const round = (n) => Math.round(n * 100) / 100;

const GLUED_SOURCE_CAP = 0.25;

/**
 * Count the places where a non-letter sits between two letters and the other
 * layout reads it as a letter.
 *
 * Only meaningful when the transposition is character-for-character, so it
 * bails on a length change (a Hebrew key that emits a letter plus a combining
 * mark, or one that emits nothing). Cross-script candidates do not need this:
 * there, every character changes and the ordinary scorers have plenty to go on.
 */
// Punctuation that really does live inside a word: contractions, hyphenation,
// abbreviations, identifiers and paths. Anything else wedged between two letters
// is a sign the text was not typed on the layout being proposed.
const INTRA_WORD_PUNCT = new Set(["'", '’', '-', '.', '_', '/']);

/**
 * Count implausible punctuation left sitting inside a word in the decode.
 *
 * The mirror of gluedLetters, on the target side. Without it `ma;ana` reads as
 * `ma<ana` just as well as it reads as `mañana`, because the scorer splits on
 * the junk character and finds two real words either way, so the two readings
 * tie and the ambiguity gate throws both away.
 */
function intraWordJunk(text, L) {
  let n = 0;
  for (let i = 1; i < text.length - 1; i += 1) {
    const ch = text[i];
    // Whitespace between two letters is a word boundary, not junk inside a word.
    if (/\s/.test(ch)) continue;
    if (L.letters.has(ch) || INTRA_WORD_PUNCT.has(ch)) continue;
    if (!L.letters.has(text[i - 1]) || !L.letters.has(text[i + 1])) continue;
    n += 1;
  }
  return n;
}

function gluedLetters(raw, decoded, fromL, toL) {
  if (raw.length !== decoded.length) return 0;
  let n = 0;
  for (let i = 1; i < raw.length - 1; i += 1) {
    if (fromL.letters.has(raw[i])) continue;          // already a letter, no news
    if (!toL.letters.has(decoded[i])) continue;       // does not become a letter
    if (!fromL.letters.has(raw[i - 1]) || !fromL.letters.has(raw[i + 1])) continue;
    n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Tests. Fixtures and the bench corpus are data files so anyone adding a layout,
// or a case that bit them, edits JSON rather than this script.
// ---------------------------------------------------------------------------

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

function selfTest(engine) {
  const { cases } = readJson(join(TESTS_DIR, 'fixtures.json'));
  let failed = 0;
  for (const c of cases) {
    const r = engine.analyze(c.input);
    const got = r.confident ? r.decoded : null;
    const gotDir = r.confident ? r.direction : null;
    if (got === (c.expect ?? null) && gotDir === (c.direction ?? null)) {
      console.log(`ok    ${JSON.stringify(c.input)} -> ${JSON.stringify(got)}`);
    } else {
      failed += 1;
      console.error(`FAIL  ${JSON.stringify(c.input)}   (${c.why || ''})`);
      console.error(`      expected ${JSON.stringify(c.expect ?? null)} (${c.direction ?? null})`);
      console.error(`      got      ${JSON.stringify(got)} (${gotDir})  ${JSON.stringify(r.scores)}  ${r.reason}`);
    }
  }

  // Property: every key round-trips through every non-reference layout.
  for (const [lang, L] of engine.layouts) {
    if (L.reference) continue;
    for (const [key, out] of L.raw.keys) {
      if (L.recover.get(out) !== key) continue; // a collision resolved to another key
      const back = transpose(out, L, engine.layouts.get('en') || L);
      if (back !== key) { failed += 1; console.error(`FAIL  round-trip ${lang}: ${key} -> ${out} -> ${back}`); }
    }
    // Property: a dropped key emits nothing faithfully. When decoding it falls
    // back to its unshifted key, but ONLY where such a key exists: Hebrew drops
    // 21 shifted letters, which all have one, while Spanish drops [ { ' " -
    // dead keys for accents, which have no unshifted letter behind them and
    // stay unrecoverable.
    const en = engine.layouts.get('en');
    for (const ch of L.dropped) {
      if (transpose(ch, en, L, { faithful: true }) !== '') {
        failed += 1; console.error(`FAIL  ${lang}: ${ch} should emit nothing in faithful mode`);
      }
      const base = L.unshift.get(ch);
      if (base && L.emit.has(base) && transpose(ch, en, L, { faithful: false }) === '') {
        failed += 1; console.error(`FAIL  ${lang}: ${ch} should fall back to its unshifted key when decoding`);
      }
    }
  }

  console.log(failed === 0 ? '\nALL KBFIX TESTS PASSED' : `\n${failed} KBFIX TEST(S) FAILED`);
  return failed === 0 ? 0 : 1;
}

/**
 * The false-positive gate.
 *
 * Every ordinary prompt is a detection candidate, so the corpus that must be
 * left ALONE is the one that decides whether this is shippable. Anything flagged
 * here is a bug, not a tuning opportunity.
 */
function bench(engine) {
  const { quiet } = readJson(join(TESTS_DIR, 'bench.json'));
  let hits = 0;
  for (const group of quiet) {
    let groupHits = 0;
    for (const line of group.lines) {
      const r = engine.analyze(line);
      if (r.confident) {
        groupHits += 1;
        console.error(`FALSE POSITIVE  ${JSON.stringify(line)}`);
        console.error(`                read as ${JSON.stringify(r.decoded)} (${r.direction}) ${JSON.stringify(r.scores)}`);
      }
    }
    hits += groupHits;
    console.log(`${groupHits === 0 ? 'ok   ' : 'FAIL '} ${group.label}: ${group.lines.length} lines, ${groupHits} false positive(s)`);
  }
  const total = quiet.reduce((n, g) => n + g.lines.length, 0);
  console.log(hits === 0
    ? `\nBENCH CLEAN: 0 false positives over ${total} lines of real prose`
    : `\nBENCH FAILED: ${hits} false positive(s) over ${total} lines`);
  return hits === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `kbfix - recover text typed with the wrong keyboard layout selected

  kbfix "<text>"           detect and print the reading
  kbfix --json "<text>"    full verdict, including every candidate reading
  kbfix --to <lang> "..."  force a direction, no scoring (--to-en, --to-he alias)
  kbfix --faithful         with --to, simulate the keyboard exactly (drops the
                           shifted keys that emit nothing) instead of falling
                           back to the physical key
  kbfix --force "<text>"   print the best transposition even when unsure
  kbfix --explain "<text>" per-token scoring breakdown
  kbfix --layouts          list installed layouts
  kbfix --config           show the active config and where it came from
  kbfix --self-test        run the fixtures
  kbfix --bench            false-positive gate over real prose
  kbfix --hook             read a UserPromptSubmit payload on stdin and, only
                           when confident, emit additionalContext

Reads stdin when given no text. Exit 0 confident, 3 abstained, 1 usage error.

Detection is whole-message or nothing, runs between every installed layout, and
abstains on mixed-script input or when two layouts read equally well. Configure
with .kbfix.json in the project or your home directory; see
kbfix.config.example.json.

Known limits of the shipped tables, all verified against the real layouts:
  - On the Hebrew layout 21 shifted Latin letters emit nothing, so capitals are
    lost at the keyboard and their case cannot be recovered. Russian has a full
    uppercase alphabet, so there its case survives.
  - C and K both emit לֹ, so that character decodes to C.
  - Digits and most symbols are identical across layouts and carry no signal.
  - Mixed-script lines are left alone rather than half-decoded.
  - The tables are for the macOS "ABC", "Hebrew" and "Russian" input sources.
    They are WRONG for "Hebrew - QWERTY", "Hebrew - PC" and the phonetic
    "Russian - QWERTY"; see layouts/README.md to make your own.`;

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const toIndex = argv.indexOf('--to');
  const toLang = toIndex > -1 ? argv[toIndex + 1] : null;
  // Guard the -1: `toIndex + 1` would be 0 when --to is absent, which silently
  // eats the first positional argument.
  const toValueIndex = toIndex > -1 ? toIndex + 1 : -1;
  const rest = argv.filter((a, i) => !a.startsWith('--') && i !== toValueIndex);

  if (flags.has('--help') || flags.has('-h')) { console.log(HELP); return 0; }

  if (flags.has('--hook')) {
    // Fail open and stay silent on anything unexpected. A keyboard convenience
    // must never be able to interfere with somebody's prompt.
    try {
      const payload = JSON.parse(await readStdin());
      const r = createEngine().analyze(payload.prompt ?? payload.user_prompt ?? '');
      if (r.confident) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext:
              `[kbfix] The prompt above looks like it was typed with the wrong keyboard ` +
              `layout selected. Transposed through the verified layout table it reads: ` +
              `"${r.decoded}". Treat that as the intended request, say in one short line ` +
              `that you read it that way, and act on it. If it does not make sense in ` +
              `context, ask instead of guessing.`,
          },
          systemMessage: `kbfix: read as "${r.decoded}"`,
        }));
      }
    } catch { /* silent by design */ }
    return 0;
  }

  const engine = createEngine();

  if (flags.has('--layouts')) {
    for (const [lang, L] of engine.layouts) {
      console.log(`${lang}\t${L.label}${L.reference ? '  (reference keyboard)' : ''}\t${L.raw.keys ? L.raw.keys.length : 0} keys`);
    }
    return 0;
  }
  if (flags.has('--config')) {
    console.log(JSON.stringify({ ...engine.config, active: engine.langs }, null, 2));
    return 0;
  }
  if (flags.has('--self-test')) return selfTest(engine);
  if (flags.has('--bench')) return bench(engine);

  const text = rest.length > 0 ? rest.join(' ') : (await readStdin()).replace(/\n$/, '');
  if (!text) { console.error(HELP); return 1; }

  // Explicit direction: --to <lang>, plus the pre-0.2 --to-en / --to-he aliases.
  let forced = toLang;
  for (const f of flags) {
    const m = /^--to-([a-z]{2})$/.exec(f);
    if (m) forced = m[1];
  }
  if (forced) {
    const to = engine.layouts.get(forced);
    if (!to) { console.error(`kbfix: no layout "${forced}" (have: ${engine.langs.join(', ')})`); return 1; }
    const counts = scriptCounts(text, engine.layouts);
    const present = [...counts].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    const from = engine.layouts.get(present.length ? present[0][0] : 'en') || engine.layouts.get('en');
    console.log(transpose(text, from, to, { faithful: flags.has('--faithful') }));
    return 0;
  }

  const r = engine.analyze(text);

  if (flags.has('--explain')) {
    const detail = {};
    for (const c of r.candidates) {
      detail[c.direction] = { decoded: c.decoded, tokens: engine.scorers.get(c.direction.split('->')[1]).explain(c.decoded) };
    }
    console.log(JSON.stringify({ verdict: r, candidates: detail }, null, 2));
    return r.confident ? 0 : 3;
  }
  if (flags.has('--json')) { console.log(JSON.stringify(r, null, 2)); return r.confident ? 0 : 3; }

  if (r.confident) { console.log(r.decoded); return 0; }
  if (flags.has('--force') && r.candidates.length) { console.log(r.candidates[0].decoded); console.error(`(forced; not confident: ${r.reason})`); return 0; }

  console.error(`kbfix: no confident reading (${r.reason})`);
  for (const c of r.candidates) console.error(`  ${c.direction}  ${c.decoded}   [${c.target}]`);
  return 3;
}

// Run only when invoked as a program, not when imported by a test.
let isEntry = false;
try {
  isEntry = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch { /* fall through to not-entry */ }

if (isEntry) main().then((code) => process.exit(code));
