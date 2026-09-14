/**
 * The detector.
 *
 * Pure: it is handed already-loaded layouts and models, so the same source runs
 * in Node and in a browser. load.mjs supplies them on the CLI side.
 *
 * kbfix converts between TWO languages, both ways, and the pair is configured
 * rather than guessed. There is no search across installed layouts: for a
 * cross-script pair the characters say which side the text came from, and the
 * only question left is whether the reading is good enough to mention.
 */

import { transpose, scriptCounts } from './layout.mjs';
import { makeScorer, structuralRuleFor } from './score.mjs';

/**
 * @param config  settings, including `pair`
 * @param layouts Map of lang -> compiled layout, for exactly that pair
 * @param models  Map of lang -> scoring model, for exactly that pair
 */
export function createEngine(config, layouts, models) {
  const [aLang, bLang] = config.pair;
  const A = layouts.get(aLang);
  const B = layouts.get(bLang);
  if (!A || !B || aLang === bLang) {
    throw new Error(`kbfix: pair must name two different installed layouts, got ${JSON.stringify(config.pair)}`);
  }

  const scorers = new Map();
  for (const [lang, L] of layouts) {
    scorers.set(lang, makeScorer(models.get(lang), { letters: L.letters, structural: structuralRuleFor(L) }));
  }

  const sameScript = A.script === B.script;

  /**
   * One pair, both ways.
   *
   * Two languages at a time is the whole design. There is no search over
   * installed layouts and no guessing which of several languages was meant: the
   * only open question is which of the configured two produced the text, and
   * for a cross-script pair the characters answer that outright.
   */
  function analyze(text) {
    const raw = text ?? '';
    const counts = scriptCounts(raw, layouts);
    const present = [...counts].filter(([, n]) => n > 0);
    const signal = present.reduce((n, [, c]) => n + c, 0);
    const base = { input: raw, decoded: null, direction: null, confident: false, candidates: [] };

    if (signal < config.minSignalChars) return { ...base, reason: 'not enough letters to judge' };
    if (present.length > 1) return { ...base, reason: 'mixed scripts, left alone by design' };

    // The models only read letters, so a mostly-punctuation string is judged on
    // almost nothing. `if (a) { b(); }` has exactly four letters and they spell
    // if/a/b, which scored a flawless 1.0 as English and produced a confident
    // reading of pure mangled code. Density, not just count: four letters out of
    // four characters is evidence, four out of eleven is not.
    const dense = raw.replace(/\s+/g, '').length;
    if (dense > 0 && signal / dense < config.minLetterDensity) {
      return { ...base, reason: 'too much punctuation relative to letters to judge' };
    }

    // Which way round. A cross-script pair is decided by the characters
    // themselves. A same-script pair (English and Spanish share every letter)
    // cannot be, so both directions are tried and scored.
    const script = present[0][0];
    const directions = sameScript
      ? [[A, B], [B, A]]
      : [A.script === script ? [A, B] : [B, A]];

    const candidates = [];
    for (const [fromL, toL] of directions) {
      const decoded = transpose(raw, fromL, toL);

      // No change means no evidence. Two layouts of one script agree on every
      // letter, so most text transposes to itself; scoring an unchanged string
      // would just compare two language models and "detect" a mistype in text
      // nobody mistyped, flagging every correctly typed Spanish sentence as
      // English gone wrong.
      if (decoded === raw) continue;

      // Within one script the only recoverable mistake is a punctuation key
      // that the other layout reads as a LETTER: ma;ana for mañana. Demand
      // exactly that, or there is nothing to go on.
      const glued = gluedLetters(raw, decoded, fromL, toL);
      if (sameScript && !glued) continue;

      const junk = intraWordJunk(decoded, toL);
      const targetScore = round(scorers.get(toL.lang)(decoded));
      const sourceScore = round(scorers.get(fromL.lang)(raw));
      candidates.push({
        direction: `${fromL.lang}->${toL.lang}`,
        decoded,
        target: junk ? Math.min(targetScore, GLUED_SOURCE_CAP) : targetScore,
        source: glued ? Math.min(sourceScore, GLUED_SOURCE_CAP) : sourceScore,
        ...(glued ? { glued } : {}),
        ...(junk ? { junk } : {}),
      });
    }

    if (candidates.length === 0) {
      return { ...base, reason: 'transposing changes nothing, so there is no evidence either way' };
    }
    candidates.sort((x, y) => y.target - x.target);

    const best = candidates[0];
    const runnerUp = candidates[1];
    return verdict({
      ...base,
      direction: best.direction,
      decoded: best.decoded,
      target: best.target,
      source: best.source,
      runnerUp: runnerUp ? round(runnerUp.target) : null,
      candidates,
    }, config);
  }

  return { layouts, langs: [aLang, bLang], A, B, sameScript, config, analyze, scorers };
}

/**
 * Three gates, all of which must pass.
 *
 * `target` is how much the reading looks like real prose. `margin` is how far it
 * beats the text as typed, and it is the one that keeps ordinary prompts safe:
 * real prose scores near 1 in its own language, so nothing can out-run it.
 * `gap` is how far the best reading beats the second-best, and it only exists
 * once there are three or more layouts: when Latin input reads plausibly as both
 * Hebrew and Russian, neither answer is safe to give.
 */
function verdict(v, config) {
  const margin = round(v.target - v.source);
  const gap = v.runnerUp === null ? null : round(v.target - v.runnerUp);

  const failedTarget = v.target < config.minTargetScore;
  const failedMargin = margin < config.minMargin;
  const failedGap = gap !== null && gap < config.minCandidateGap;
  const confident = !failedTarget && !failedMargin && !failedGap;

  return {
    ...v,
    scores: { target: round(v.target), source: round(v.source), margin, gap },
    confident,
    reason: confident
      ? 'the transposed text reads as real prose and the original does not'
      : failedTarget
        ? 'the transposed text does not read as real prose'
        : failedMargin
          ? 'the original reads about as well as the transposition, so no call is safe'
          : 'two layouts read about equally well, so the reading is ambiguous',
  };
}

const round = (n) => Math.round(n * 100) / 100;

const GLUED_SOURCE_CAP = 0.25;

/**
 * Count the places where a non-letter sits between two letters and the other
 * layout reads it as a letter.
 *
 * Only meaningful when the transposition is character-for-character, so it
 * bails on a length change (a Hebrew key that emits a letter plus a combining
 * mark, or one that emits nothing). Cross-script candidates do not need this:
 * there, every character changes and the ordinary scorers have plenty to go on.
 */
// Punctuation that really does live inside a word: contractions, hyphenation,
// abbreviations, identifiers and paths. Anything else wedged between two letters
// is a sign the text was not typed on the layout being proposed.
const INTRA_WORD_PUNCT = new Set(["'", '’', '-', '.', '_', '/']);

/**
 * Count implausible punctuation left sitting inside a word in the decode.
 *
 * The mirror of gluedLetters, on the target side. Without it `ma;ana` reads as
 * `ma<ana` just as well as it reads as `mañana`, because the scorer splits on
 * the junk character and finds two real words either way, so the two readings
 * tie and the ambiguity gate throws both away.
 */
function intraWordJunk(text, L) {
  let n = 0;
  for (let i = 1; i < text.length - 1; i += 1) {
    const ch = text[i];
    // Whitespace between two letters is a word boundary, not junk inside a word.
    if (/\s/.test(ch)) continue;
    if (L.letters.has(ch) || INTRA_WORD_PUNCT.has(ch)) continue;
    if (!L.letters.has(text[i - 1]) || !L.letters.has(text[i + 1])) continue;
    n += 1;
  }
  return n;
}

function gluedLetters(raw, decoded, fromL, toL) {
  if (raw.length !== decoded.length) return 0;
  let n = 0;
  for (let i = 1; i < raw.length - 1; i += 1) {
    if (fromL.letters.has(raw[i])) continue;          // already a letter, no news
    if (!toL.letters.has(decoded[i])) continue;       // does not become a letter
    if (!fromL.letters.has(raw[i - 1]) || !fromL.letters.has(raw[i + 1])) continue;
    n += 1;
  }
  return n;
}

