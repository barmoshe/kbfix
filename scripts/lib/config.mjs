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
  layouts: null,          // null means every installed layout
  directions: null,       // null means every direction between them
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
 * Accept the pre-0.2 single-pair shape so an existing .kbfix.json keeps working:
 * `{"pair": "en-he"}` becomes `{"layouts": ["en", "he"]}`.
 */
export function normalise(raw) {
  const cfg = { ...DEFAULTS, ...raw };
  if (!cfg.layouts && typeof raw.pair === 'string' && raw.pair.includes('-')) {
    cfg.layouts = raw.pair.split('-');
    cfg.migratedFromPair = raw.pair;
  }
  return cfg;
}

export function loadConfig() {
  for (const file of configPaths()) {
    if (!existsSync(file)) continue;
    try {
      return { ...normalise(JSON.parse(readFileSync(file, 'utf8'))), source: file };
    } catch {
      // A broken config must not take the hook down with it.
      return { ...DEFAULTS, source: `${file} (unreadable, using defaults)` };
    }
  }
  return { ...DEFAULTS, source: 'built-in defaults' };
}
