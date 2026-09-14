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
  pair: 'en-he',
  directions: ['he->en', 'en->he'],
  minSignalChars: 4,
  minTargetScore: 0.55,
  minMargin: 0.35,
};

export function configPaths() {
  const out = [];
  const project = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (project) out.push(join(project, '.kbfix.json'));
  if (process.env.HOME) out.push(join(process.env.HOME, '.kbfix.json'));
  return out;
}

export function loadConfig() {
  for (const file of configPaths()) {
    if (!existsSync(file)) continue;
    try {
      return { ...DEFAULTS, ...JSON.parse(readFileSync(file, 'utf8')), source: file };
    } catch {
      // A broken config must not take the hook down with it.
      return { ...DEFAULTS, source: `${file} (unreadable, using defaults)` };
    }
  }
  return { ...DEFAULTS, source: 'built-in defaults' };
}
