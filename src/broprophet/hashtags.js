// Hashtag bank for The BroProphet.
//
// Mix of three buckets:
//   1. ON-BRAND: in-universe BroProphet / Funkadelic / Dude references that
//      lean into the joke for people already in the church.
//   2. ABSURD-HUMOR: surreal one-off hashtags that make the joke funnier on
//      their own (so even strangers chuckle).
//   3. AUDIENCE-REACH: broadly-used X tags that put the bot in front of new
//      eyes (jazz, funk, memes, mondaymotivation, etc.).
//
// `pickHashtags` selects 2-3 tags weighted toward variety, while staying under
// the bot's tweet length budget.

import { sample, sampleMany } from "./corpus.js";

const ON_BRAND = [
  "#BroProphet",
  "#TheBroProphet",
  "#FunkIsLove",
  "#FunkIsLife",
  "#FunkIsItsOwnReward",
  "#TrumpetJelly",
  "#OceanOfTrumpets",
  "#TheLickIsLove",
  "#Skerlack",
  "#Mothership",
  "#GiveUpTheFunk",
  "#FreeYourMindAndYourAssWillFollow",
  "#TheDudeAbides",
  "#NewShitHasComeToLight",
  "#BigJazzBoy",
  "#WhiteRussian",
  "#ShotgunABeerYesterday",
  "#WorstCaseOntario",
  "#TheWayShePoursADrinkInTheStrandHotel",
  "#SteelyDan",
  "#KidCharlemagne",
  "#RememberClifford",
  "#TwoMoonsInTheSky",
];

const ABSURD_HUMOR = [
  "#PartyingOnTheMothership",
  "#JazzBoyOfHistory",
  "#WheelOfFortuneBuysVowelsFromMe",
  "#DonkeyKongWasAnInsideJob",
  "#TenOutOfTenJazzBoys",
  "#GotEm",
  "#NotAllHeroesWearPants",
  "#10Guy",
  "#WhatIfShoesAreReversedFeet",
  "#CourageWolf",
  "#FactsAboutMe",
  "#ChuckNorrisCouldntDoThis",
  "#WoosWomenWithTrombone",
  "#PrayForTheLiver",
];

const AUDIENCE_REACH = [
  "#jazz",
  "#funk",
  "#funkadelic",
  "#parliamentfunkadelic",
  "#lebowski",
  "#bigLebowski",
  "#trailerparkboys",
  "#bubbles",
  "#chucknorris",
  "#memes",
  "#shitposting",
  "#mondaymotivation",
  "#mondayvibes",
  "#wednesdaywisdom",
  "#thursdaythoughts",
  "#fridayfeeling",
  "#friyay",
  "#saturdayvibes",
  "#sundayfunday",
  "#wisdom",
  "#prophecy",
  "#420",
  "#cosmicwisdom",
  "#yolo",
  "#vibes",
  "#mood",
];

/** Day-of-week aware "reach" hashtag to ride the weekly wave. */
function dailyTimingTag(date = new Date()) {
  // Use UTC day; cron runs in UTC.
  const dow = date.getUTCDay();
  return [
    "#sundayfunday", // 0
    "#mondaymotivation", // 1
    "#tuesdaymood", // 2
    "#wednesdaywisdom", // 3
    "#thursdaythoughts", // 4
    "#friyay", // 5
    "#saturdayvibes", // 6
  ][dow];
}

/**
 * Pick a small, varied set of hashtags whose total length (plus separating
 * spaces) fits within `budget` characters.
 *
 * Bucket strategy: one on-brand + one absurd + one timing/reach. Drop any that
 * blow the budget. Always include any tags listed in `alwaysInclude`.
 *
 * @param {object} args
 * @param {number} args.budget How many chars (incl. leading spaces) the
 *   hashtags are allowed to consume.
 * @param {string[]} [args.alwaysInclude]
 * @param {Date} [args.now]
 */
export function pickHashtags({ budget, alwaysInclude = [], now = new Date() }) {
  /** @type {string[]} */
  const picks = [];

  const tryAdd = (tag) => {
    if (!tag) return false;
    if (picks.includes(tag)) return false;
    // Each tag costs its length + 1 for the leading space.
    const cost = tag.length + 1;
    const used = picks.reduce((n, t) => n + t.length + 1, 0);
    if (used + cost > budget) return false;
    picks.push(tag);
    return true;
  };

  for (const t of alwaysInclude) tryAdd(t);
  tryAdd(sample(ON_BRAND));
  tryAdd(sample(ABSURD_HUMOR));
  tryAdd(dailyTimingTag(now));

  // Fill remaining budget opportunistically with reach tags.
  for (const t of sampleMany(AUDIENCE_REACH, AUDIENCE_REACH.length)) {
    if (!tryAdd(t)) continue;
    if (picks.length >= 4) break;
  }

  return picks;
}

/**
 * Parse the comma-separated ALWAYS_HASHTAGS env var into an array of
 * `#`-prefixed tags. Empty / falsy returns [].
 */
export function parseAlwaysHashtags(raw) {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith("#") ? s : `#${s}`));
}
