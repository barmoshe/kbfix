/**
 * The playground runs the plugin's REAL engine.
 *
 * These are the same modules the CLI and the UserPromptSubmit hook use, imported
 * straight out of ../../scripts/lib. They are pure, with no filesystem access,
 * which is the whole reason this is possible: nothing here reimplements the
 * detector, so the demo cannot quietly disagree with the tool it is advertising.
 *
 * Layouts and models are loaded lazily per language, so opening the page does
 * not pull down all four models (they are 50-90 KB each).
 */

import { compileLayout } from '../../scripts/lib/layout.mjs';
import { createEngine } from '../../scripts/lib/engine.mjs';
import { DEFAULTS } from '../../scripts/lib/defaults.mjs';

const layoutFiles = import.meta.glob('../../layouts/*/layout.json');
const modelFiles = import.meta.glob('../../layouts/*/model.json');

const pathFor = (files, lang, name) =>
  Object.keys(files).find((p) => p.endsWith(`/${lang}/${name}.json`));

const layoutCache = new Map();
const modelCache = new Map();

export const LANGS = Object.keys(layoutFiles)
  .map((p) => p.split('/').at(-2))
  .sort();

async function layoutFor(lang) {
  if (!layoutCache.has(lang)) {
    const mod = await layoutFiles[pathFor(layoutFiles, lang, 'layout')]();
    layoutCache.set(lang, compileLayout(mod.default));
  }
  return layoutCache.get(lang);
}

async function modelFor(lang) {
  if (!modelCache.has(lang)) {
    const mod = await modelFiles[pathFor(modelFiles, lang, 'model')]();
    modelCache.set(lang, mod.default);
  }
  return modelCache.get(lang);
}

const engineCache = new Map();

/** An engine for one pair, with the plugin's own default thresholds. */
export async function engineFor(pair, overrides = {}) {
  const key = `${pair.join('-')}|${JSON.stringify(overrides)}`;
  if (!engineCache.has(key)) {
    const [a, b] = pair;
    const [la, lb, ma, mb] = await Promise.all([
      layoutFor(a), layoutFor(b), modelFor(a), modelFor(b),
    ]);
    const layouts = new Map([[a, la], [b, lb]]);
    const models = new Map([[a, ma], [b, mb]]);
    engineCache.set(key, createEngine({ ...DEFAULTS, ...overrides, pair }, layouts, models));
  }
  return engineCache.get(key);
}

export async function labelFor(lang) {
  return (await layoutFor(lang)).label;
}

export const PAIRS = (() => {
  const out = [];
  for (let i = 0; i < LANGS.length; i += 1) {
    for (let j = i + 1; j < LANGS.length; j += 1) out.push([LANGS[i], LANGS[j]]);
  }
  return out;
})();
