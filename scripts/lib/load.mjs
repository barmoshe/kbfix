/**
 * Reading layouts and models off disk.
 *
 * Everything that touches the filesystem lives here and nowhere else, so
 * layout.mjs, score.mjs and engine.mjs stay pure and run unchanged in a browser.
 * That is what lets the website run the real engine rather than a second
 * implementation of it that would quietly drift out of agreement.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileLayout } from './layout.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = join(HERE, '..', '..');
export const LAYOUTS_DIR = join(PLUGIN_ROOT, 'layouts');

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

export function loadLayouts(langs, opts = {}) {
  const out = new Map();
  for (const lang of langs) out.set(lang, loadLayout(lang, opts));
  return out;
}

export function loadModel(lang, { layoutsDir = LAYOUTS_DIR } = {}) {
  const file = join(layoutsDir, lang, 'model.json');
  if (!existsSync(file)) {
    throw new Error(`kbfix: no scoring model for "${lang}" (expected ${file}). Run: node scripts/build-model.mjs --lang ${lang}`);
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}
