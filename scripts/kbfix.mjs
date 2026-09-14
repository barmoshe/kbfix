#!/usr/bin/env node
/**
 * kbfix - recover text typed with the wrong keyboard layout selected.
 *
 * When the wrong input source is active the keystrokes still land; only the
 * table that rendered them was wrong. `commit and push to main` typed on the
 * Hebrew layout arrives as `בםצצןא שמג פודי אם צשןמ`, and `לדוגמא` typed on the
 * English one arrives as `ksudnt`. Both are fully recoverable.
 *
 * Detection runs in BOTH directions, and the verdict is symmetric: transpose,
 * then ask whether the result reads better as real prose than the original did.
 * It only says so when the gap is wide. When in doubt it abstains, because a
 * wrong call is worse than no call.
 *
 * What it never does is rewrite the prompt. The hook emits additionalContext
 * naming the reading and leaves the original text exactly as typed, so a false
 * positive stays visible and correctable instead of silently destroying what
 * somebody actually wrote.
 *
 * Usage:
 *   kbfix "בםצצןא שמג פודי אם צשןמ"   detect and print the reading
 *   kbfix --json "..."                full verdict with scores
 *   kbfix --to-en "..." / --to-he     force one direction, no scoring
 *   kbfix --force "..."               transpose even when not confident
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
import { loadLayout, toA, toB, scriptCounts, PLUGIN_ROOT } from './lib/layout.mjs';
import { loadModel, makeScorer, structuralRuleFor } from './lib/score.mjs';
import { loadConfig, DEFAULTS } from './lib/config.mjs';

const TESTS_DIR = join(PLUGIN_ROOT, 'tests');

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export function createEngine(config = loadConfig()) {
  const L = loadLayout(config.pair);
  const model = loadModel(config.pair);

  const scoreA = makeScorer(model.a, { letters: L.aLetters, structural: structuralRuleFor(L, 'a') });
  const scoreB = makeScorer(model.b, { letters: L.bLetters, structural: structuralRuleFor(L, 'b') });

  // Readable direction names derived from the pair, with generic aliases so a
  // config written as "b->a" works for any layout pair.
  const BA = `${L.b.lang}->${L.a.lang}`;
  const AB = `${L.a.lang}->${L.b.lang}`;
  const wanted = new Set(config.directions || DEFAULTS.directions);
  const enabled = {
    ba: wanted.has(BA) || wanted.has('b->a'),
    ab: wanted.has(AB) || wanted.has('a->b'),
  };

  /**
   * Whole-message or nothing, and only one candidate can ever exist: mixed
   * script is rejected before we get here. A mixed line is left alone rather
   * than half-decoded, because short words are genuinely ambiguous - `אם` is
   * both real Hebrew ("if") and layout-typed `to`.
   */
  function analyze(text) {
    const raw = text ?? '';
    const { a, b } = scriptCounts(raw, L);
    const base = { input: raw, decoded: null, direction: null, confident: false };

    if (a + b < config.minSignalChars) {
      return { ...base, reason: 'not enough letters to judge' };
    }
    if (a > 0 && b > 0) {
      return { ...base, reason: 'mixed scripts, left alone by design' };
    }

    if (b > 0) {
      if (!enabled.ba) return { ...base, reason: `direction ${BA} is switched off in config` };
      const decoded = toA(raw, L);
      return verdict({ ...base, direction: BA, decoded, target: scoreA(decoded), source: scoreB(raw) }, config);
    }

    if (!enabled.ab) return { ...base, reason: `direction ${AB} is switched off in config` };
    const decoded = toB(raw, L);
    return verdict({ ...base, direction: AB, decoded, target: scoreB(decoded), source: scoreA(raw) }, config);
  }

  return { L, config, analyze, scoreA, scoreB, directions: { BA, AB }, enabled };
}

function verdict(v, config) {
  const { target, source } = v;
  const margin = target - source;
  const confident = target >= config.minTargetScore && margin >= config.minMargin;
  return {
    ...v,
    scores: { target: round(target), source: round(source), margin: round(margin) },
    confident,
    reason: confident
      ? 'the transposed text reads as real prose and the original does not'
      : target < config.minTargetScore
        ? 'the transposed text does not read as real prose'
        : 'the original reads about as well as the transposition, so no call is safe',
  };
}

const round = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Tests. Fixtures and the bench corpus are data files so anyone adding a layout
// pair, or a case that bit them, edits JSON rather than this script.
// ---------------------------------------------------------------------------

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function selfTest(engine) {
  const { cases } = readJson(join(TESTS_DIR, 'fixtures.json'));
  let failed = 0;
  for (const c of cases) {
    const r = engine.analyze(c.input);
    const got = r.confident ? r.decoded : null;
    const gotDir = r.confident ? r.direction : null;
    const ok = got === (c.expect ?? null) && gotDir === (c.direction ?? null);
    if (ok) {
      console.log(`ok    ${JSON.stringify(c.input)} -> ${JSON.stringify(got)}`);
    } else {
      failed += 1;
      console.error(`FAIL  ${JSON.stringify(c.input)}   (${c.why || ''})`);
      console.error(`      expected ${JSON.stringify(c.expect ?? null)} (${c.direction ?? null})`);
      console.error(`      got      ${JSON.stringify(got)} (${gotDir})  ${JSON.stringify(r.scores)}  ${r.reason}`);
    }
  }

  // Property: every key that survives on side b must come back as itself.
  const { L } = engine;
  for (const [a, b] of L.base) {
    const back = toA(b, L);
    if (back !== a) { failed += 1; console.error(`FAIL  round-trip ${a} -> ${b} -> ${back}`); }
  }
  // Property: faithful mode drops the shifted keys that emit nothing, decoding
  // mode falls back to the physical key instead.
  for (const ch of L.droppedOnB) {
    if (toB(ch, L, { faithful: true }) !== '') { failed += 1; console.error(`FAIL  ${ch} should emit nothing in faithful mode`); }
    if (toB(ch, L, { faithful: false }) === '') { failed += 1; console.error(`FAIL  ${ch} should fall back to its unshifted key when decoding`); }
  }

  console.log(failed === 0 ? '\nALL KBFIX TESTS PASSED' : `\n${failed} KBFIX TEST(S) FAILED`);
  return failed === 0 ? 0 : 1;
}

/**
 * The false-positive gate.
 *
 * With both directions live, every ordinary prompt is a detection candidate, so
 * the corpus that must be left ALONE is the one that decides whether this is
 * shippable. Anything flagged here is a bug, not a tuning opportunity.
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

  kbfix "<text>"          detect and print the reading
  kbfix --json "<text>"   full verdict as JSON
  kbfix --to-en "<text>"  force side b -> side a, no scoring
  kbfix --to-he "<text>"  force side a -> side b, no scoring
  kbfix --faithful        with --to-he, simulate the keyboard exactly (drops
                          the shifted keys that emit nothing) instead of
                          falling back to the physical key
  kbfix --force "<text>"  transpose anyway when it is not confident
  kbfix --explain "<text>" per-token scoring breakdown for both readings
  kbfix --config          show the active config and where it came from
  kbfix --self-test       run the fixtures
  kbfix --bench           false-positive gate over real prose
  kbfix --hook            read a UserPromptSubmit payload on stdin and, only when
                          confident, emit additionalContext naming the reading

Reads stdin when given no text. Exit 0 confident, 3 abstained, 1 usage error.

Detection is whole-message or nothing, runs in both directions, and abstains on
mixed-script input. Configure with .kbfix.json in the project or your home
directory; see kbfix.config.example.json.

Known limits of the shipped en-he table, all verified against the real layouts:
  - 21 shifted Latin letters emit nothing on the Hebrew layout, so capitals are
    lost at the keyboard and their case cannot be recovered.
  - C and K both emit לֹ, so that character decodes to C.
  - Digits and most symbols are identical in both layouts and carry no signal.
  - Mixed-script lines are left alone rather than half-decoded.
  - The table is for the macOS "Hebrew" input source. It is WRONG for
    "Hebrew - QWERTY" and "Hebrew - PC"; see layouts/README.md to make your own.`;

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const rest = argv.filter((a) => !a.startsWith('--'));

  if (flags.has('--help') || flags.has('-h')) { console.log(HELP); return 0; }

  if (flags.has('--hook')) {
    // Fail open and stay silent on anything unexpected. A keyboard convenience
    // must never be able to interfere with somebody's prompt.
    try {
      const payload = JSON.parse(await readStdin());
      const engine = createEngine();
      const r = engine.analyze(payload.prompt ?? payload.user_prompt ?? '');
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

  if (flags.has('--config')) {
    console.log(JSON.stringify({ ...engine.config, enabled: engine.enabled, directions: engine.directions }, null, 2));
    return 0;
  }
  if (flags.has('--self-test')) return selfTest(engine);
  if (flags.has('--bench')) return bench(engine);

  const text = rest.length > 0 ? rest.join(' ') : (await readStdin()).replace(/\n$/, '');
  if (!text) { console.error(HELP); return 1; }

  const { L } = engine;
  if (flags.has('--to-en')) { console.log(toA(text, L)); return 0; }
  if (flags.has('--to-he')) { console.log(toB(text, L, { faithful: flags.has('--faithful') })); return 0; }

  const r = engine.analyze(text);

  if (flags.has('--explain')) {
    console.log(JSON.stringify({
      verdict: r,
      asA: engine.scoreA.explain(r.direction === engine.directions.BA ? r.decoded ?? toA(text, L) : text),
      asB: engine.scoreB.explain(r.direction === engine.directions.AB ? r.decoded ?? toB(text, L) : text),
    }, null, 2));
    return r.confident ? 0 : 3;
  }
  if (flags.has('--json')) { console.log(JSON.stringify(r, null, 2)); return r.confident ? 0 : 3; }

  if (r.confident) { console.log(r.decoded); return 0; }
  if (flags.has('--force')) {
    const { b } = scriptCounts(text, L);
    console.log(b > 0 ? toA(text, L) : toB(text, L));
    console.error(`(forced; not confident: ${r.reason})`);
    return 0;
  }
  console.error(`kbfix: no confident reading (${r.reason})`);
  console.error(`  as ${L.a.label}: ${toA(text, L)}`);
  console.error(`  as ${L.b.label}: ${toB(text, L)}`);
  return 3;
}

// Run only when invoked as a program, not when imported by a test. realpath on
// both sides so a symlinked install still matches.
let isEntry = false;
try {
  isEntry = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch { /* fall through to not-entry */ }

if (isEntry) main().then((code) => process.exit(code));
