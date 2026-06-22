// Loads the BroProphet training corpus from data/*.txt at bundle time.
// Wrangler's `[[rules]] type = "Text"` rule makes these imports return strings.

import archiveText from "../../data/archive.txt";
import bandGroupText from "../../data/band-group.txt";
import clickholeText from "../../data/clickhole.txt";
import facebookText from "../../data/facebook.txt";
import goldAbsurdistText from "../../data/gold-absurdist.txt";

/**
 * Split a corpus file into individual sayings. We treat each non-empty line
 * as one quote; some lines are very long (multi-sentence), which is fine —
 * the bot can excerpt or rewrite when asked to.
 *
 * @param {string} raw
 * @returns {string[]}
 */
function splitLines(raw) {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

const SOURCES = {
  archive: splitLines(archiveText),
  bandGroup: splitLines(bandGroupText),
  clickhole: splitLines(clickholeText),
  facebook: splitLines(facebookText),
  gold: splitLines(goldAbsurdistText),
};

/** All known sayings, deduplicated. */
export const ALL_QUOTES = Array.from(
  new Set([
    ...SOURCES.gold,
    ...SOURCES.archive,
    ...SOURCES.bandGroup,
    ...SOURCES.clickhole,
    ...SOURCES.facebook,
  ]),
);

/**
 * Hand-curated absurdist lines — the "non-guru" canon. Used as the bulk of
 * the few-shot pool to keep the model from drifting into mystic/sage register.
 */
export const GOLD_QUOTES = SOURCES.gold.slice();

/** Pick a uniformly random element from an array. */
export function sample(arr) {
  if (!arr.length) throw new Error("sample() called on empty array");
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Pick `n` distinct random elements (without replacement). If n >= arr.length,
 * returns the whole array shuffled.
 */
export function sampleMany(arr, n) {
  const copy = arr.slice();
  const out = [];
  while (out.length < n && copy.length) {
    const idx = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(idx, 1)[0]);
  }
  return out;
}

/**
 * Return a random saying suitable for direct posting:
 *   - fits inside `maxLength` (default 240 to leave room for hashtags)
 *   - isn't surrounded with markdown asterisks (we strip them)
 *   - looks like a complete thought
 *
 * Falls back to a shorter trimmed quote if no clean match is found.
 *
 * @param {number} [maxLength]
 */
export function randomQuote(maxLength = 240) {
  const cleaned = ALL_QUOTES.map((q) => q.replace(/^\*+|\*+$/g, "").trim());
  const fits = cleaned.filter((q) => q.length <= maxLength && q.length >= 30);
  if (fits.length) return sample(fits);
  // Fallback: pick the shortest available.
  const sorted = cleaned.slice().sort((a, b) => a.length - b.length);
  return sorted[0].slice(0, maxLength);
}

/**
 * Pick `n` quotes to use as few-shot examples for the model. Filters to
 * tweet-sized examples so the model learns the right cadence.
 *
 * Bias is roughly 80% from the hand-curated absurdist `gold` corpus and 20%
 * from the broader canon. This stops the model from over-anchoring on the
 * mystical-leaning lines in the original archive that pull it toward
 * guru-speak.
 *
 * @param {number} [n]
 * @param {number} [maxLen]
 */
export function fewShotExamples(n = 12, maxLen = 240) {
  const clean = (q) => q.replace(/^\*+|\*+$/g, "").trim();
  const fits = (q) => q.length <= maxLen && q.length >= 20;

  const goldPool = GOLD_QUOTES.map(clean).filter(fits);
  const restPool = ALL_QUOTES.filter((q) => !GOLD_QUOTES.includes(q))
    .map(clean)
    .filter(fits);

  const nGold = Math.min(goldPool.length, Math.max(1, Math.round(n * 0.8)));
  const nRest = Math.max(0, n - nGold);

  const picks = [...sampleMany(goldPool, nGold), ...sampleMany(restPool, nRest)];
  for (let i = picks.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [picks[i], picks[j]] = [picks[j], picks[i]];
  }
  return picks;
}

/**
 * A curated bank of concrete pop-culture tokens we forcibly inject into one
 * generation in two, to keep the model's vocabulary planted in the right
 * universe (Lebowski / TPB / Funkadelic / Steely Dan / college-bro). When the
 * model is told "your output MUST contain X", its whole register shifts to
 * accommodate X — which is the lever we want.
 */
export const FORCED_TOKEN_BANK = [
  // Lebowski
  "Donny",
  "Walter",
  "Maude",
  "the rug",
  "marmot",
  "White Russian",
  "Caucasian",
  "calmer than you are",
  "the Dude abides",
  "new shit has come to light",
  "in the parlance of our times",
  "nihilists",
  // Trailer Park Boys
  "Ricky",
  "Bubbles",
  "Mr. Lahey",
  "kitties",
  "shit-winds",
  "the liquor",
  "decent",
  "Sunnyvale",
  "worst-case Ontario",
  "supply and command",
  "get two birds stoned at once",
  "Conky",
  // Funkadelic / canon
  "Mothership",
  "Trumpet Jelly",
  "Dr. Funkenstein",
  "skerlack",
  "larbo-larbo",
  "give up the funk",
  // Steely Dan
  "Kid Charlemagne",
  "Dr. Wu",
  "any major Dude",
  "Rikki",
  "Aja",
  // College bro
  "shotgun",
  "Dos Equis",
  "hot-and-ready",
  "Tuesday",
  "hard six",
];

/** Pick one random forced-token, or `null` to leave it unforced. */
export function pickForcedToken({ probability = 0.5 } = {}) {
  if (Math.random() > probability) return null;
  return sample(FORCED_TOKEN_BANK);
}
