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
 * It works on TWO languages at a time, both ways, and the pair is configured
 * rather than guessed. There is no search across installed layouts: for a
 * cross-script pair the characters say which side the text came from, and the
 * only question left is whether the reading is good enough to mention.
 *
 * What it never does is rewrite the prompt. The hook emits additionalContext
 * naming the reading and leaves the original text exactly as typed, so a false
 * positive stays visible and correctable instead of silently destroying what
 * somebody actually wrote.
 *
 * Usage:
 *   kbfix "בםצצןא שמג פודי אם צשןמ"   detect and print the reading
 *   kbfix --json "..."                full verdict, with every candidate
 *   kbfix --pair en-ru "..."          use this pair instead of the configured one
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
import { transpose, scriptCounts } from './lib/layout.mjs';
import {
  loadLayouts, loadModel, installedLayouts, PLUGIN_ROOT,
} from './lib/load.mjs';
import { createEngine as buildEngine } from './lib/engine.mjs';
import { loadConfig } from './lib/config.mjs';

/**
 * The CLI's engine: read the pair off disk, then hand it to the pure engine.
 * Exported under the old name so tests and scripts/stress.mjs keep working.
 */
export function createEngine(config = loadConfig()) {
  const pair = config.pair || [];
  const layouts = loadLayouts(pair);
  const models = new Map(pair.map((lang) => [lang, loadModel(lang)]));
  return buildEngine(config, layouts, models);
}

const TESTS_DIR = join(PLUGIN_ROOT, 'tests');

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tests. Fixtures and the bench corpus are data files so anyone adding a layout,
// or a case that bit them, edits JSON rather than this script.
// ---------------------------------------------------------------------------

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** Every pair of installed layouts, for the gates that must hold whatever is configured. */
function allPairs() {
  const langs = installedLayouts();
  const out = [];
  for (let i = 0; i < langs.length; i += 1) {
    for (let j = i + 1; j < langs.length; j += 1) out.push([langs[i], langs[j]]);
  }
  return out;
}

const engineFor = (pair, config) => createEngine({ ...config, pair });

function selfTest(config) {
  const { pairs } = readJson(join(TESTS_DIR, 'fixtures.json'));
  let failed = 0;

  for (const [pairId, cases] of Object.entries(pairs)) {
    const pair = pairId.split('-');
    let engine;
    try {
      engine = engineFor(pair, config);
    } catch (err) {
      failed += 1;
      console.error(`FAIL  pair ${pairId}: ${err.message}`);
      continue;
    }
    console.log(`\n--- ${pairId} ---`);
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
  }

  // Table properties, checked against the reference keyboard for every layout.
  console.log('\n--- layout tables ---');
  const langs = installedLayouts();
  const all = loadLayouts(langs);
  const en = all.get('en');
  for (const [lang, L] of all) {
    if (L.reference) continue;
    let bad = 0;
    for (const [key, out] of L.raw.keys) {
      if (L.recover.get(out) !== key) continue; // a collision resolved to another key
      if (transpose(out, L, en) !== key) { bad += 1; console.error(`FAIL  round-trip ${lang}: ${key} -> ${out}`); }
    }
    for (const ch of L.dropped) {
      if (transpose(ch, en, L, { faithful: true }) !== '') {
        bad += 1; console.error(`FAIL  ${lang}: ${ch} should emit nothing in faithful mode`);
      }
      // Only where an unshifted key exists behind it. Hebrew drops 21 shifted
      // letters, which all have one; Spanish drops dead keys, which do not.
      const base = L.unshift.get(ch);
      if (base && L.emit.has(base) && transpose(ch, en, L, { faithful: false }) === '') {
        bad += 1; console.error(`FAIL  ${lang}: ${ch} should fall back to its unshifted key when decoding`);
      }
    }
    failed += bad;
    if (bad === 0) console.log(`ok    ${lang}: ${L.raw.keys.length} keys round-trip, ${L.dropped.size} dropped behave`);
  }

  console.log(failed === 0 ? '\nALL KBFIX TESTS PASSED' : `\n${failed} KBFIX TEST(S) FAILED`);
  return failed === 0 ? 0 : 1;
}

/**
 * The false-positive gate.
 *
 * Run under EVERY pair, not just the configured one. These lines must be left
 * alone whatever two languages someone has set, and a line that is safe under
 * en-he can still be wrongly read under en-ru.
 */
function bench(config) {
  const { quiet } = readJson(join(TESTS_DIR, 'bench.json'));
  const pairs = allPairs();
  let hits = 0;
  let checked = 0;

  for (const group of quiet) {
    let groupHits = 0;
    for (const pair of pairs) {
      const engine = engineFor(pair, config);
      for (const line of group.lines) {
        checked += 1;
        const r = engine.analyze(line);
        if (r.confident) {
          groupHits += 1;
          console.error(`FALSE POSITIVE  [${pair.join('-')}] ${JSON.stringify(line)}`);
          console.error(`                read as ${JSON.stringify(r.decoded)} (${r.direction}) ${JSON.stringify(r.scores)}`);
        }
      }
    }
    hits += groupHits;
    console.log(`${groupHits === 0 ? 'ok   ' : 'FAIL '} ${group.label}: ${group.lines.length} lines x ${pairs.length} pairs, ${groupHits} false positive(s)`);
  }
  console.log(hits === 0
    ? `\nBENCH CLEAN: 0 false positives over ${checked} checks (${pairs.length} pairs)`
    : `\nBENCH FAILED: ${hits} false positive(s) over ${checked} checks`);
  return hits === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP = `kbfix - recover text typed with the wrong keyboard layout selected

  kbfix "<text>"           detect and print the reading
  kbfix --json "<text>"    full verdict, including every candidate reading
  kbfix --pair en-ru "..." use this pair for one run, instead of the config
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

kbfix works on TWO languages at a time, both ways. Set the pair in .kbfix.json in
the project or your home directory (see kbfix.config.example.json); the default
is en-he, and --layouts lists what is installed. Detection is whole-message or
nothing and abstains on mixed-script input.

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
  const pairIndex = argv.indexOf('--pair');
  const pairArg = pairIndex > -1 ? argv[pairIndex + 1] : null;
  const toIndex = argv.indexOf('--to');
  const toLang = toIndex > -1 ? argv[toIndex + 1] : null;
  // Guard the -1: `toIndex + 1` would be 0 when --to is absent, which silently
  // eats the first positional argument.
  const toValueIndex = toIndex > -1 ? toIndex + 1 : -1;
  const pairValueIndex = pairIndex > -1 ? pairIndex + 1 : -1;
  const rest = argv.filter((a, i) => !a.startsWith('--') && i !== toValueIndex && i !== pairValueIndex);

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

  const baseConfig = loadConfig();
  const engine = createEngine(pairArg ? { ...baseConfig, pair: pairArg.split('-') } : baseConfig);

  if (flags.has('--layouts')) {
    const active = new Set(engine.langs);
    for (const lang of installedLayouts()) {
      const L = loadLayouts([lang]).get(lang);
      const mark = active.has(lang) ? '*' : ' ';
      console.log(`${mark} ${lang}\t${L.label}${L.reference ? '  (reference keyboard)' : ''}\t${L.raw.keys ? L.raw.keys.length : 0} keys\t${L.script}`);
    }
    console.log(`\n* = the configured pair, ${engine.langs.join(' <-> ')}. Two at a time; set "pair" in .kbfix.json to change it.`);
    return 0;
  }
  if (flags.has('--config')) {
    console.log(JSON.stringify({ ...engine.config, active: engine.langs }, null, 2));
    return 0;
  }
  if (flags.has('--self-test')) return selfTest(engine.config);
  if (flags.has('--bench')) return bench(engine.config);

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
    // Source is the configured layout the text is NOT being converted to.
    // scriptCounts reports scripts, so match on that rather than on language.
    const counts = scriptCounts(text, engine.layouts);
    const present = [...counts].filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1]);
    const script = present.length ? present[0][0] : null;
    const from = [engine.A, engine.B].find((L) => L.lang !== forced && (!script || L.script === script))
      || [engine.A, engine.B].find((L) => L.lang !== forced);
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
