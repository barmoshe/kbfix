#!/usr/bin/env node
/**
 * build-model - regenerate a language's scoring model. DEVELOPMENT ONLY.
 *
 * This is the only part of kbfix that touches the network, and it never runs at
 * prompt time. It reads the frequency corpus named in layouts/<lang>/corpus.json
 * and writes layouts/<lang>/model.json, which is committed.
 *
 *   node scripts/build-model.mjs                 every installed language
 *   node scripts/build-model.mjs --lang ru
 *   node scripts/build-model.mjs --lang ru --corpus ~/ru_full.txt
 *
 * What it produces:
 *
 *   words   the N most frequent words, the strong signal
 *   logp    a character-bigram log-probability table, the fallback signal for
 *           everything not in `words` - this is what lets `ksudnt` be recognised
 *           as `לדוגמא` even though לדוגמא is nobody's stopword
 *   calib   the two bounds that map a mean bigram log-probability onto 0..1
 *
 * The calibration is the interesting part. The negative examples are not random
 * strings: they are every OTHER language's real words pushed through the real
 * key tables, which is exactly the distribution the detector has to reject.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadLayout, loadLayouts, installedLayouts, LAYOUTS_DIR, transpose } from './lib/layout.mjs';

const WORDLIST_N = 5000;      // words that score 1.0 outright
const CALIB_POOL = 30000;     // how many words each calibration pool draws
const ALPHA = 0.5;            // Laplace smoothing on the bigram counts
const BOUNDARY = 0;           // index of the word-boundary symbol

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function fetchCorpus(url, cacheDir) {
  mkdirSync(cacheDir, { recursive: true });
  const file = join(cacheDir, url.split('/').pop());
  if (existsSync(file)) { console.log(`    cached ${file}`); return file; }
  console.log(`    fetch  ${url}`);
  execFileSync('curl', ['-sSL', '--max-time', '180', '-o', file, url], { stdio: 'inherit' });
  return file;
}

/** The lowercase alphabet a model is built over. */
function modelAlphabet(L) {
  return [...new Set([...L.letters].map((c) => c.toLowerCase()))].sort();
}

/** Read a "<word><sep><count>" corpus, keeping only words made of `letters`. */
function readCorpus(file, separator, letters) {
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    const at = line.indexOf(separator);
    if (at < 0) continue;
    const word = line.slice(0, at).trim().toLowerCase();
    const freq = Number(line.slice(at + 1).trim());
    if (!word || !Number.isFinite(freq) || freq <= 0) continue;
    let ok = true;
    for (const ch of word) if (!letters.has(ch)) { ok = false; break; }
    if (ok) out.push({ word, freq });
  }
  out.sort((x, y) => y.freq - x.freq);
  return out;
}

/**
 * Bigram log-probabilities over [boundary, ...letters].
 *
 * Words are weighted by log(1 + freq), not raw frequency: the goal is a model of
 * what the language's spelling looks like, and raw counts would let the top
 * twenty function words drown out every other pattern in the language.
 */
function trainBigrams(corpus, alphabet) {
  const n = alphabet.length + 1;
  const index = new Map(alphabet.map((ch, i) => [ch, i + 1]));
  const counts = new Float64Array(n * n);

  for (const { word, freq } of corpus) {
    const w = Math.log(1 + freq);
    let prev = BOUNDARY;
    for (const ch of word) {
      const cur = index.get(ch);
      if (cur === undefined) { prev = BOUNDARY; continue; }
      counts[prev * n + cur] += w;
      prev = cur;
    }
    counts[prev * n + BOUNDARY] += w;
  }

  const logp = new Array(n * n).fill(0);
  for (let i = 0; i < n; i += 1) {
    let total = 0;
    for (let j = 0; j < n; j += 1) total += counts[i * n + j];
    const denom = total + ALPHA * n;
    for (let j = 0; j < n; j += 1) {
      logp[i * n + j] = round(Math.log((counts[i * n + j] + ALPHA) / denom), 4);
    }
  }
  return { index, n, logp };
}

function meanLogp(word, { index, n, logp }) {
  let prev = BOUNDARY;
  let sum = 0;
  let steps = 0;
  for (const ch of word) {
    const cur = index.get(ch);
    if (cur === undefined) continue;
    sum += logp[prev * n + cur];
    prev = cur;
    steps += 1;
  }
  if (steps === 0) return -Infinity;
  sum += logp[prev * n + BOUNDARY];
  return sum / (steps + 1);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[i];
}

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * The training set is cleaner than the word list is drawn from. A raw
 * web-or-subtitle frequency corpus is partly not the language it claims to be,
 * and training on that noise makes the model permissive enough to accept another
 * language pushed through a key table. Filtering only the training set keeps
 * domain words (github, npm) in the word list where they belong.
 */
function trainingSubset(corpus, spec) {
  if (spec.trainFilterFile && existsSync(spec.trainFilterFile)) {
    const allow = new Set(readFileSync(spec.trainFilterFile, 'utf8').toLowerCase().split('\n').map((s) => s.trim()));
    const kept = corpus.filter((e) => allow.has(e.word));
    if (kept.length >= 5000) {
      console.log(`    training on ${kept.length} of ${corpus.length} (filtered by ${spec.trainFilterFile})`);
      return kept;
    }
    console.log(`    filter ${spec.trainFilterFile} kept only ${kept.length}; ignoring it`);
  }
  if (spec.trainMaxWords && corpus.length > spec.trainMaxWords) {
    console.log(`    training on the top ${spec.trainMaxWords} of ${corpus.length}`);
    return corpus.slice(0, spec.trainMaxWords);
  }
  return corpus;
}

function buildLanguage(lang, { layouts, corpora, cacheDir }) {
  const L = layouts.get(lang);
  const dir = join(LAYOUTS_DIR, lang);
  const spec = JSON.parse(readFileSync(join(dir, 'corpus.json'), 'utf8'));
  const alphabet = modelAlphabet(L);

  console.log(`  ${L.label} (${lang}): alphabet ${alphabet.length}`);
  const corpus = corpora.get(lang);
  const trainCorpus = trainingSubset(corpus, spec);
  const model = trainBigrams(trainCorpus, alphabet);

  // Positives: real words of this language that are NOT in the word list, since
  // in-list words never reach the bigram channel anyway.
  const positives = trainCorpus
    .slice(WORDLIST_N, WORDLIST_N + CALIB_POOL)
    .map((e) => meanLogp(e.word, model))
    .filter(Number.isFinite)
    .sort((x, y) => x - y);

  // Negatives: every other language's real words pushed through the key tables,
  // kept SEPARATE per source language.
  //
  // Pooling them would be a bug. Languages differ in how confusable they are
  // once transposed, and one easy source drags a pooled percentile down, which
  // quietly makes the model permissive toward the hard one. (Adding Russian
  // pooled moved the English bound from -3.49 to -3.92 and `ksudnt` stopped
  // being detectable.) The bar has to be set by the hardest confuser, so take
  // the per-source percentile and keep the highest.
  const perSource = [];
  for (const [other, otherL] of layouts) {
    if (other === lang) continue;
    const scores = [];
    for (const { word } of (corpora.get(other) || []).slice(0, CALIB_POOL)) {
      const junk = transpose(word, otherL, L);
      if (junk.length < 2) continue;
      let pure = true;
      for (const ch of junk) if (!L.letters.has(ch)) { pure = false; break; }
      if (!pure) continue;
      const m = meanLogp(junk, model);
      if (Number.isFinite(m)) scores.push(m);
    }
    scores.sort((x, y) => x - y);
    if (scores.length) perSource.push({ other, p80: percentile(scores, 0.80), n: scores.length });
  }

  const lo = round(Math.max(...perSource.map((s) => s.p80)), 4);
  const hi = round(percentile(positives, 0.40), 4);
  console.log(`    positives p40 ${hi} (n=${positives.length})`);
  for (const s of perSource) {
    const hardest = round(s.p80, 4) === lo ? '  <- sets the bound' : '';
    console.log(`    negatives from ${s.other}: p80 ${round(s.p80, 4)} (n=${s.n})${hardest}`);
  }
  console.log(`    separation ${round(hi - lo, 2)}`);
  if (hi <= lo) console.log('    WARNING: the pools do not separate; scores will be uninformative');

  const extraFile = join(dir, 'extra-words.json');
  const extra = existsSync(extraFile) ? JSON.parse(readFileSync(extraFile, 'utf8')).words || [] : [];
  const words = [...new Set([...corpus.slice(0, WORDLIST_N).map((e) => e.word), ...extra])].sort();

  const out = {
    generated: new Date().toISOString().slice(0, 10),
    lang,
    wordlistSize: WORDLIST_N,
    source: spec.url,
    alphabet: alphabet.join(''),
    words,
    logp: model.logp,
    calib: { lo, hi },
  };
  const file = join(dir, 'model.json');
  writeFileSync(file, `${JSON.stringify(out)}\n`);
  console.log(`    wrote ${file} (${Math.round(readFileSync(file).length / 1024)} KB, ${words.length} words)`);
}

function main() {
  const only = arg('lang');
  const cacheDir = arg('cache', join(process.env.HOME || '.', '.cache', 'kbfix'));
  const langs = installedLayouts();
  const layouts = loadLayouts(langs);

  console.log(`kbfix build-model: ${langs.join(', ')}`);

  // Every language's corpus is needed even when building one, because the
  // calibration negatives come from the others.
  const corpora = new Map();
  for (const lang of langs) {
    const L = layouts.get(lang);
    const spec = JSON.parse(readFileSync(join(LAYOUTS_DIR, lang, 'corpus.json'), 'utf8'));
    const file = (only === lang && arg('corpus')) || fetchCorpus(spec.url, cacheDir);
    const letters = new Set([...L.letters].map((c) => c.toLowerCase()));
    corpora.set(lang, readCorpus(file, spec.separator, letters));
  }

  for (const lang of langs) {
    if (only && lang !== only) continue;
    buildLanguage(lang, { layouts, corpora, cacheDir });
  }
}

main();
