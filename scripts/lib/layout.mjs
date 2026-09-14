/**
 * Layouts and transposition.
 *
 * A layout is data: layouts/<lang>/layout.json says what every physical key
 * emits on that input source. Adding a language is adding a folder.
 *
 * Everything is expressed against one REFERENCE keyboard, the US ANSI layout,
 * and a "key" is named by the character that reference emits. So decoding is
 * always two hops: text in the layout that produced it, back to the keys that
 * were pressed, forward into the layout that was meant. With N layouts that is
 * N-1 candidate readings for any input, and no N-squared table of pairs.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = join(HERE, '..', '..');
export const LAYOUTS_DIR = join(PLUGIN_ROOT, 'layouts');

/** Expand a letter class like "a-z" or "а-яёА-ЯЁ" into the literal characters. */
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

/** Every language that has a layouts/<lang>/layout.json. */
export function installedLayouts({ layoutsDir = LAYOUTS_DIR } = {}) {
  return readdirSync(layoutsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(layoutsDir, e.name, 'layout.json')))
    .map((e) => e.name)
    .sort();
}

export function loadLayout(lang, { layoutsDir = LAYOUTS_DIR } = {}) {
  const file = join(layoutsDir, lang, 'layout.json');
  if (!existsSync(file)) throw new Error(`kbfix: no layout "${lang}" (looked in ${file})`);
  return compileLayout(JSON.parse(readFileSync(file, 'utf8')));
}

export function compileLayout(raw) {
  const keys = raw.keys || [];

  // FIRST writer wins in both directions. `new Map(pairs)` would let the LAST
  // entry win, which silently mis-decodes any key the dump lists twice: on the
  // Russian layout two physical keys both read as "." on the reference board,
  // emitting ю and , respectively, and only the first is the one people mean.
  const emit = new Map();
  for (const [key, out] of keys) if (!emit.has(key)) emit.set(key, out);

  const recover = new Map();
  for (const [key, out] of keys) if (!recover.has(out)) recover.set(out, key);

  // Longest output first, so a letter plus a combining mark matches before the
  // bare letter. Without this, שׁ recovers as ש plus a stray mark.
  const recoverByLen = [...recover.keys()].sort((a, b) => b.length - a.length);

  const unshift = new Map();
  for (let c = 65; c <= 90; c += 1) unshift.set(String.fromCharCode(c), String.fromCharCode(c + 32));

  return {
    lang: raw.lang,
    label: raw.label,
    // Two layouts can share a script (English and Spanish both write Latin).
    // When they do, nothing in the text says which one produced it, so both
    // have to be tried as the source.
    script: raw.script || raw.lang,
    reference: !!raw.reference,
    // A unicameral script has no capitals to preserve, so a shifted key that
    // emits some decorated variant is almost always a habit artifact rather
    // than intent. Bicameral scripts keep their capitals: on the Russian
    // layout Shift+K really is Л and throwing that away would be vandalism.
    hasCase: raw.hasCase !== false,
    letters: new Set(expandLetterClass(raw.letterClass)),
    letterClass: raw.letterClass,
    vowels: new Set((raw.vowels || '').split('')),
    finalForms: new Set(raw.finalForms || []),
    emit,
    recover,
    recoverByLen,
    dropped: new Set((raw.dropped || '').split('')),
    unshift,
    raw,
  };
}

export function loadLayouts(langs, opts = {}) {
  const out = new Map();
  for (const lang of langs) out.set(lang, loadLayout(lang, opts));
  return out;
}

/** Text as produced by `L` -> the reference keys that were pressed. */
export function toKeys(text, L) {
  if (L.reference) return text;
  let out = '';
  let i = 0;
  while (i < text.length) {
    let hit = null;
    for (const key of L.recoverByLen) {
      if (text.startsWith(key, i)) { hit = key; break; }
    }
    if (hit) { out += L.recover.get(hit); i += hit.length; }
    else { out += text[i]; i += 1; }
  }
  return out;
}

/**
 * Reference keys -> what `L` emits for them.
 *
 * `faithful: true` reproduces the keyboard exactly, including keys that emit
 * nothing, which is what the fixtures need to simulate a mistype. `faithful:
 * false` (the default, for decoding) falls back to the unshifted key rather
 * than swallowing the character, so `Akuo` reads as שלום and not as לום.
 */
export function fromKeys(keys, L, { faithful = false } = {}) {
  if (L.reference) return keys;
  let out = '';
  for (const ch of keys) {
    if (!faithful && !L.hasCase && L.unshift.has(ch)) {
      const base = L.unshift.get(ch);
      out += L.emit.get(base) ?? '';
      continue;
    }
    if (L.emit.has(ch)) { out += L.emit.get(ch); continue; }
    if (L.dropped.has(ch)) {
      if (faithful) continue;
      const base = L.unshift.get(ch);
      out += (base && L.emit.get(base)) || '';
      continue;
    }
    out += ch;
  }
  return out;
}

/** One hop: text produced by `from`, read as though `to` had been selected. */
export function transpose(text, from, to, opts = {}) {
  return fromKeys(toKeys(text, from), to, opts);
}

/**
 * Which SCRIPTS appear in the text, and how often.
 *
 * Scripts, not layouts: the characters tell you the alphabet, never which of
 * several same-script layouts produced them.
 */
export function scriptCounts(text, layouts) {
  const letters = new Map(); // script -> set of its characters
  for (const L of layouts.values()) {
    if (!letters.has(L.script)) letters.set(L.script, new Set());
    const set = letters.get(L.script);
    for (const ch of L.letters) set.add(ch);
  }
  const counts = new Map([...letters.keys()].map((s) => [s, 0]));
  for (const ch of text) {
    for (const [script, set] of letters) {
      if (set.has(ch)) { counts.set(script, counts.get(script) + 1); break; }
    }
  }
  return counts;
}
