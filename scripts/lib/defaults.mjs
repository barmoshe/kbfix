/**
 * Default settings, kept in their own module because they are the one part of
 * the config that is pure. config.mjs reads files and cannot run in a browser;
 * the website needs these values and nothing else.
 */
export const DEFAULTS = {
  pair: ['en', 'he'],
  minSignalChars: 4,
  minLetterDensity: 0.5,
  minTargetScore: 0.65,
  minMargin: 0.35,
  minCandidateGap: 0.15,
};
