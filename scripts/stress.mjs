#!/usr/bin/env node
/**
 * stress - measure the detector against the corpora. DEVELOPMENT ONLY.
 *
 * `kbfix --bench` is the committed, hand-written gate: a few dozen lines that
 * must never fire, each one chosen because it represents a way this can go
 * wrong. This is the other half - tens of thousands of synthetic-but-real lines
 * built from the same frequency corpora the model was trained on, reporting
 * both halves of the ledger:
 *
 *   false positives   real prose the detector wrongly claims is a mistype
 *   recall            genuine mistypes it correctly catches
 *
 * False positives are the number that matters. A miss costs nothing; a wrong
 * call puts words in somebody's mouth.
 *
 * Needs the corpora that build-model.mjs caches:
 *   node scripts/build-model.mjs --pair en-he    (populates ~/.cache/kbfix)
 *   node scripts/stress.mjs --pair en-he
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createEngine } from './kbfix.mjs';
import { loadConfig } from './lib/config.mjs';
import { toA, toB, LAYOUTS_DIR } from './lib/layout.mjs';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const pair = arg('pair', 'en-he');
const cacheDir = arg('cache', join(process.env.HOME || '.', '.cache', 'kbfix'));
const N = Number(arg('n', '4000'));

const engine = createEngine({ ...loadConfig(), pair });
const { L } = engine;
const spec = JSON.parse(readFileSync(join(LAYOUTS_DIR, pair, 'corpus.json'), 'utf8'));

function corpusWords(side, max) {
  const file = join(cacheDir, spec[side].url.split('/').pop());
  if (!existsSync(file)) {
    console.error(`stress: no cached corpus at ${file}`);
    console.error(`        run: node scripts/build-model.mjs --pair ${pair}`);
    process.exit(1);
  }
  const sep = spec[side].separator;
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const at = line.indexOf(sep);
    if (at < 0) continue;
    const w = line.slice(0, at).trim();
    if (w) out.push(w);
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

function falsePositives(label, pool, lo, hi) {
  let fired = 0;
  const examples = [];
  for (let i = 0; i < N; i += 1) {
    const line = sentence(pool, lo, hi);
    const r = engine.analyze(line);
    if (r.confident) {
      fired += 1;
      if (examples.length < 6) examples.push(`${JSON.stringify(line)} -> ${JSON.stringify(r.decoded)} ${JSON.stringify(r.scores)}`);
    }
  }
  console.log(`  ${label.padEnd(40)} ${String(fired).padStart(5)}/${N}  ${((fired / N) * 100).toFixed(2)}%`);
  for (const e of examples) console.log(`      ${e}`);
  return fired;
}

function recall(label, pool, transpose, lo, hi) {
  let caught = 0;
  let exact = 0;
  const n = Math.round(N / 2);
  for (let i = 0; i < n; i += 1) {
    const intended = sentence(pool, lo, hi);
    const r = engine.analyze(transpose(intended));
    if (r.confident) { caught += 1; if (r.decoded === intended) exact += 1; }
  }
  console.log(`  ${label.padEnd(40)} ${String(caught).padStart(5)}/${n}  ${((caught / n) * 100).toFixed(1)}%  exact ${exact}/${caught}`);
}

const aPool = corpusWords('a', 3000);
const bPool = corpusWords('b', 3000);
const aMid = corpusWords('a', 40000).slice(15000);
const bMid = corpusWords('b', 60000).slice(20000);

console.log(`kbfix stress: ${pair}, ${N} lines per sweep\n`);
console.log('FALSE POSITIVES (real prose that must be left alone)');
let bad = 0;
bad += falsePositives(`${L.a.label} sentences`, aPool, 2, 7);
bad += falsePositives(`${L.a.label} uncommon words`, aMid, 2, 7);
bad += falsePositives(`${L.a.label} short (2-3 words)`, aPool, 2, 3);
bad += falsePositives(`${L.b.label} sentences`, bPool, 2, 7);
bad += falsePositives(`${L.b.label} uncommon words`, bMid, 2, 7);
bad += falsePositives(`${L.b.label} short (2-3 words)`, bPool, 2, 3);

console.log('\nRECALL (genuine mistypes that should be caught)');
recall(`${L.a.label} typed on the ${L.b.label} layout`, aPool, (s) => toB(s, L, { faithful: true }), 2, 7);
recall(`${L.b.label} typed on the ${L.a.label} layout`, bPool, (s) => toA(s, L), 2, 7);
recall(`${L.a.label} short mistype`, aPool, (s) => toB(s, L, { faithful: true }), 2, 3);
recall(`${L.b.label} short mistype`, bPool, (s) => toA(s, L), 2, 3);

console.log(bad === 0 ? '\nSTRESS CLEAN: no false positives' : `\nSTRESS FAILED: ${bad} false positive(s)`);
process.exit(bad === 0 ? 0 : 1);
