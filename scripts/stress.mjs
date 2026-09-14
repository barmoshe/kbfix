#!/usr/bin/env node
/**
 * stress - measure the detector against the corpora. DEVELOPMENT ONLY.
 *
 * `kbfix --bench` is the committed, hand-written gate: a hundred-odd lines that
 * must never fire, each chosen because it represents a way this can go wrong.
 * This is the other half - tens of thousands of synthetic-but-real lines built
 * from the same frequency corpora the models were trained on, reporting both
 * halves of the ledger, for every layout and every direction between them:
 *
 *   false positives   real prose the detector wrongly claims is a mistype
 *   recall            genuine mistypes it correctly catches
 *
 * False positives are the number that matters. A miss costs nothing; a wrong
 * call puts words in somebody's mouth.
 *
 * Needs the corpora that build-model.mjs caches:
 *   node scripts/build-model.mjs      (populates ~/.cache/kbfix)
 *   node scripts/stress.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createEngine } from './kbfix.mjs';
import { loadConfig } from './lib/config.mjs';
import { transpose, installedLayouts, LAYOUTS_DIR } from './lib/layout.mjs';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const cacheDir = arg('cache', join(process.env.HOME || '.', '.cache', 'kbfix'));
const N = Number(arg('n', '4000'));

const baseConfig = loadConfig();
const onlyPair = arg('pair');

// Every pair of installed layouts, or just the one named. kbfix runs on two
// languages at a time, so accuracy is a property of a PAIR, not of the toolkit:
// en-he and en-ru are separate configurations and each needs its own number.
function allPairs() {
  const langs = installedLayouts();
  const out = [];
  for (let i = 0; i < langs.length; i += 1) {
    for (let j = i + 1; j < langs.length; j += 1) out.push([langs[i], langs[j]]);
  }
  return out;
}
const pairs = onlyPair ? [onlyPair.split('-')] : allPairs();

function corpusWords(lang, max, layouts) {
  const spec = JSON.parse(readFileSync(join(LAYOUTS_DIR, lang, 'corpus.json'), 'utf8'));
  const file = join(cacheDir, spec.url.split('/').pop());
  if (!existsSync(file)) {
    console.error(`stress: no cached corpus at ${file}`);
    console.error('        run: node scripts/build-model.mjs');
    process.exit(1);
  }
  // Keep only words actually written in this language's alphabet. Frequency
  // corpora carry foreign tokens (the Russian subtitle list is ~1% Latin: ok,
  // tv, no), and those are not round-trips at all - they pass through the
  // recovery hop untouched and then get transposed on the way back, which would
  // show up as a decode error that is really a corpus artefact.
  const letters = layouts.get(lang).letters;
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const at = line.indexOf(spec.separator);
    if (at < 0) continue;
    const w = line.slice(0, at).trim();
    if (!w) continue;
    let pure = true;
    for (const ch of w) if (!letters.has(ch)) { pure = false; break; }
    if (pure) out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

// Deterministic, so a regression is reproducible rather than a rumour.
let seed = 20260914;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const sentence = (pool, lo, hi) =>
  Array.from({ length: lo + Math.floor(rnd() * (hi - lo + 1)) }, () => pick(pool)).join(' ');

function falsePositives(engine, label, pool, lo, hi) {
  let fired = 0;
  const examples = [];
  for (let i = 0; i < N; i += 1) {
    const line = sentence(pool, lo, hi);
    const r = engine.analyze(line);
    if (r.confident) {
      fired += 1;
      if (examples.length < 5) examples.push(`${JSON.stringify(line)} -> ${JSON.stringify(r.decoded)} (${r.direction}) ${JSON.stringify(r.scores)}`);
    }
  }
  console.log(`  ${label.padEnd(44)} ${String(fired).padStart(5)}/${N}  ${((fired / N) * 100).toFixed(2)}%`);
  for (const e of examples) console.log(`      ${e}`);
  return fired;
}

function recall(engine, layouts, from, to, pool, lo, hi) {
  let caught = 0;
  let exact = 0;
  let wrongLayout = 0;
  const n = Math.round(N / 2);
  for (let i = 0; i < n; i += 1) {
    const intended = sentence(pool, lo, hi);
    // What the keyboard really does: `from` is the language meant, `to` is the
    // layout that was actually selected, so the faithful simulation runs
    // intended-language text through the selected layout.
    const typo = transpose(intended, layouts.get(from), layouts.get(to), { faithful: true });
    if (!typo.trim()) continue;
    const r = engine.analyze(typo);
    if (r.confident) {
      caught += 1;
      if (r.decoded === intended) exact += 1;
      // Only a misattribution that also got the TEXT wrong is worth flagging.
      // Which of two same-script layouts produced a string is often undecidable
      // (English and Spanish differ on punctuation alone), and when the reading
      // comes out right anyway the label costs nothing.
      else if (r.direction !== `${to}->${from}`) wrongLayout += 1;
    }
  }
  const tag = wrongLayout ? `  inexact+misattributed ${wrongLayout}` : '';
  console.log(`  ${`${from} typed on the ${to} layout`.padEnd(44)} ${String(caught).padStart(5)}/${n}  ${((caught / n) * 100).toFixed(1)}%  exact ${exact}/${caught}${tag}`);
  return wrongLayout;
}

let badTotal = 0;
console.log(`kbfix stress: ${pairs.length} pair(s), ${N} lines per sweep\n`);

for (const pair of pairs) {
  const engine = createEngine({ ...baseConfig, pair });
  const { layouts, langs } = engine;
  const pools = new Map();
  const midPools = new Map();
  for (const lang of langs) {
    pools.set(lang, corpusWords(lang, 3000, layouts));
    midPools.set(lang, corpusWords(lang, 60000, layouts).slice(20000));
  }

  console.log(`=== ${langs.join(' <-> ')} ${engine.sameScript ? '(same script: punctuation only)' : ''}`);
  console.log('  false positives (real prose that must be left alone)');
  let bad = 0;
  for (const lang of langs) {
    const label = layouts.get(lang).label;
    bad += falsePositives(engine, `${label} sentences`, pools.get(lang), 2, 7);
    bad += falsePositives(engine, `${label} uncommon words`, midPools.get(lang), 2, 7);
    bad += falsePositives(engine, `${label} short (2-3 words)`, pools.get(lang), 2, 3);
  }
  console.log('  recall (genuine mistypes that should be caught)');
  for (const from of langs) {
    for (const to of langs) {
      if (from !== to) recall(engine, layouts, from, to, pools.get(from), 2, 7);
    }
  }
  badTotal += bad;
  console.log(`  ${bad === 0 ? 'clean' : `${bad} FALSE POSITIVE(S)`}\n`);
}

console.log(badTotal === 0 ? 'STRESS CLEAN: no false positives in any pair' : `STRESS FAILED: ${badTotal} false positive(s)`);
process.exit(badTotal === 0 ? 0 : 1);
