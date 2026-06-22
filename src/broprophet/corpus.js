// Loads the BroProphet training corpus from data/*.txt at bundle time.
// Wrangler's `[[rules]] type = "Text"` rule makes these imports return strings.

import archiveText from "../../data/archive.txt";
import bandGroupText from "../../data/band-group.txt";
import clickholeText from "../../data/clickhole.txt";
import facebookText from "../../data/facebook.txt";

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
};

/** All known sayings, deduplicated. */
export const ALL_QUOTES = Array.from(
  new Set([...SOURCES.archive, ...SOURCES.bandGroup, ...SOURCES.clickhole, ...SOURCES.facebook]),
);

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
 * @param {number} [n]
 * @param {number} [maxLen]
 */
export function fewShotExamples(n = 12, maxLen = 240) {
  const usable = ALL_QUOTES.filter((q) => q.length <= maxLen && q.length >= 30).map((q) =>
    q.replace(/^\*+|\*+$/g, "").trim(),
  );
  return sampleMany(usable, n);
}
