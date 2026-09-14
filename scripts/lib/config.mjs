/**
 * Config lookup.
 *
 * Deliberately not inside the plugin: ${CLAUDE_PLUGIN_ROOT} is replaced on every
 * plugin update, so anything written there is lost. Project config wins over
 * home config so one repo can differ from the rest of the machine.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULTS = {
  pair: ['en', 'he'],
  minSignalChars: 4,
  minLetterDensity: 0.5,
  minTargetScore: 0.65,
  minMargin: 0.35,
  minCandidateGap: 0.15,
};

export function configPaths() {
  const out = [];
  const project = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (project) out.push(join(project, '.kbfix.json'));
  if (process.env.HOME) out.push(join(process.env.HOME, '.kbfix.json'));
  return out;
}

/**
 * kbfix works on exactly TWO languages at a time, and `pair` names them.
 *
 * Older shapes still parse. 0.1 wrote the pair as one string, `"en-he"`. 0.2 and
 * 0.3 searched every installed layout at once through a `layouts` array, which
 * is the behaviour this replaces; a longer list is cut to its first two and the
 * result says so, rather than silently doing something else.
 */
export function normalise(raw = {}) {
  const cfg = { ...DEFAULTS, ...raw };
  let pair = raw.pair ?? raw.layouts;

  if (typeof pair === 'string') pair = pair.split('-');
  if (!Array.isArray(pair) || pair.length === 0) pair = DEFAULTS.pair;

  const cleaned = pair.map((s) => String(s).trim()).filter(Boolean);
  cfg.pair = cleaned.slice(0, 2);
  if (cleaned.length > 2) cfg.truncatedFrom = cleaned;
  if (cfg.pair.length !== 2) cfg.invalidPair = cleaned;

  delete cfg.layouts;
  delete cfg.directions;
  return cfg;
}

export function loadConfig() {
  for (const file of configPaths()) {
    if (!existsSync(file)) continue;
    try {
      return { ...normalise(JSON.parse(readFileSync(file, 'utf8'))), source: file };
    } catch {
      // A broken config must not take the hook down with it.
      return { ...normalise({}), source: `${file} (unreadable, using defaults)` };
    }
  }
  return { ...normalise({}), source: 'built-in defaults' };
}
