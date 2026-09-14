/**
 * Layout pair loading and transposition.
 *
 * A layout pair is data, not code: layouts/<id>/layout.json holds the key table
 * for two input sources, and everything here is driven by it. Adding a pair is
 * adding a folder, not editing this file.
 *
 * Naming: "a" and "b" are the two sides of the pair, never "english"/"hebrew".
 * For the shipped en-he pair, a is English and b is Hebrew.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = join(HERE, '..', '..');
export const LAYOUTS_DIR = join(PLUGIN_ROOT, 'layouts');

/** Expand a letter class like "a-z" or "א-ת" into the literal set of characters. */
export function expandLetterClass(spec) {
  const out = [];
  for (let i = 0; i < spec.length; i += 1) {
    if (spec[i + 1] === '-' && spec[i + 2]) {
      const lo = spec.codePointAt(i);
      const hi = spec.codePointAt(i + 2);
      for (let c = lo; c <= hi; c += 1) out.push(String.fromCodePoint(c));
      i += 2;
    } else {
      out.push(spec[i]);
    }
  }
  return out;
}

export function loadLayout(pairId, { layoutsDir = LAYOUTS_DIR } = {}) {
  const file = join(layoutsDir, pairId, 'layout.json');
  if (!existsSync(file)) throw new Error(`kbfix: no layout pair "${pairId}" (looked in ${file})`);
  return compileLayout(JSON.parse(readFileSync(file, 'utf8')));
}

export function compileLayout(raw) {
  const pairs = [...raw.base, ...raw.shift];

  // a -> b is a plain per-character map.
  const A_TO_B = new Map(pairs);

  // b -> a: first writer wins, so a collision resolves to whichever key the
  // table lists first (for en-he, C beats K on לֹ).
  const B_TO_A = new Map();
  for (const [a, b] of pairs) if (!B_TO_A.has(b)) B_TO_A.set(b, a);

  // Longest b-sequence first, so a letter+niqqud pair matches before the bare
  // letter. Without this, שׁ decodes as ש plus a stray combining mark.
  const B_KEYS_BY_LEN = [...B_TO_A.keys()].sort((x, y) => y.length - x.length);

  // Unshifted key for every shifted key, so a capital can fall back to the
  // letter its physical key produces. Built from the base row by position.
  const UNSHIFT = new Map();
  for (const [a] of raw.base) {
    const upper = a.toUpperCase();
    if (upper !== a) UNSHIFT.set(upper, a);
  }

  const aLetters = new Set(expandLetterClass(raw.a.letterClass));
  const bLetters = new Set(expandLetterClass(raw.b.letterClass));

  return {
    ...raw,
    A_TO_B,
    B_TO_A,
    B_KEYS_BY_LEN,
    UNSHIFT,
    aLetters,
    bLetters,
    droppedOnB: new Set((raw.droppedOnB || '').split('')),
    finalForms: new Set(raw.b.finalForms || []),
    aVowels: new Set((raw.a.vowels || '').split('')),
  };
}

/** Characters produced on side b, mapped back to the keys that produced them. */
export function toA(text, L) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    let hit = null;
    for (const key of L.B_KEYS_BY_LEN) {
      if (text.startsWith(key, i)) { hit = key; break; }
    }
    if (hit) { out += L.B_TO_A.get(hit); i += hit.length; }
    else { out += text[i]; i += 1; }
  }
  return out;
}

/**
 * Characters produced on side a, mapped to what the same physical keys give on
 * side b.
 *
 * Two modes, and the difference matters. `faithful: true` reproduces the real
 * keyboard exactly: a shifted key with no output on side b emits nothing, which
 * is what actually happens and what the fixtures need in order to simulate the
 * mistype. `faithful: false` (the default, used for decoding) falls back to the
 * unshifted key instead, because someone who typed `Ksudnt` meant `לדוגמא` and
 * dropping the K would silently eat a letter out of their sentence.
 */
export function toB(text, L, { faithful = false } = {}) {
  let out = '';
  for (const ch of text) {
    // Decoding mode: every shifted letter falls back to its physical key, so
    // `Akuo` reads as שלום and not שׁלום. In faithful mode the shifted entries
    // win, because on the real keyboard they are what shift+A actually emits.
    if (!faithful && L.UNSHIFT.has(ch)) {
      const base = L.UNSHIFT.get(ch);
      out += L.A_TO_B.has(base) ? L.A_TO_B.get(base) : '';
      continue;
    }
    if (L.A_TO_B.has(ch)) { out += L.A_TO_B.get(ch); continue; }
    if (L.droppedOnB.has(ch)) continue; // emits nothing on the real keyboard
    out += ch;
  }
  return out;
}

/** Count how many characters of each side's alphabet appear in the text. */
export function scriptCounts(text, L) {
  let a = 0;
  let b = 0;
  for (const ch of text) {
    if (L.aLetters.has(ch)) a += 1;
    else if (L.bLetters.has(ch)) b += 1;
  }
  return { a, b };
}
