// BroProphet bot — Cloudflare Worker entry point.
//
// Cron triggers (configured in wrangler.toml):
//   - `DAILY_POST_CRON` (default 20 17 * * *) fires once a day → post a saying.
//   - Any other scheduled run polls X mentions and replies to new ones.
//
// HTTP routes (mostly for manual ops; protect with `OPS_TOKEN` if set):
//   GET  /            — health check + handle/last-mention info
//   GET  /preview     — generate a daily-post candidate WITHOUT posting it
//   POST /post-now    — post a daily saying immediately
//   POST /check-mentions — poll mentions immediately

import { chat } from "./openai.js";
import { checkVoice, newSayingMessages, replyMessages } from "./prompts.js";
import { pickForcedToken, randomQuote } from "./corpus.js";
import { parseAlwaysHashtags, pickHashtags } from "./hashtags.js";
import {
  getAuthedUser,
  getConversationTweets,
  getMentions,
  postTweet,
} from "./x.js";
import {
  getLastDailyPostDate,
  getLastMentionId,
  hasReplied,
  markReplied,
  recordPost,
  setLastDailyPostDate,
  setLastMentionId,
} from "./storage.js";

// -------------------------------------------------------------------------
// Tweet composition helpers
// -------------------------------------------------------------------------

/**
 * Strip wrapping quotes/backticks the model sometimes adds, plus stray
 * surrounding asterisks from the corpus.
 */
function cleanGenerated(text) {
  let s = String(text || "").trim();
  s = s.replace(/^[\*\u201c\u201d"'`]+|[\*\u201c\u201d"'`]+$/g, "").trim();
  // Collapse runs of whitespace introduced by the model.
  s = s.replace(/\s+\n/g, "\n").replace(/[ \t]{2,}/g, " ");
  return s;
}

/** Hard-truncate to a length, trying to break on a word boundary. */
function clampToLength(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  if (space > max * 0.7) return cut.slice(0, space).replace(/[.,;:!\-]$/, "") + "…";
  return cut.replace(/[.,;:!\-]$/, "") + "…";
}

/** @param {any} env */
function maxTweetLength(env) {
  const n = Number(env.MAX_TWEET_LENGTH || 280);
  return Number.isFinite(n) && n > 0 ? n : 280;
}

/**
 * Compose final tweet text = saying + space + hashtags.
 *
 * Strategy: reserve up to 60 chars of budget for hashtags, but only if the
 * saying is short enough to leave room. Otherwise we shrink the hashtag budget
 * and (worst case) drop hashtags entirely so the saying always gets through.
 *
 * @param {any} env
 * @param {string} sayingRaw
 * @returns {string}
 */
function composeTweet(env, sayingRaw) {
  const limit = maxTweetLength(env);
  const saying = clampToLength(cleanGenerated(sayingRaw), limit);

  const remaining = limit - saying.length;
  // We always need at least " #x" (3 chars) for a single hashtag to be worth it.
  if (remaining < 6) return saying.slice(0, limit);

  const budget = Math.min(remaining, 80); // cap so we don't drown in tags
  const tags = pickHashtags({
    budget,
    alwaysInclude: parseAlwaysHashtags(env.ALWAYS_HASHTAGS),
  });
  if (!tags.length) return saying;

  const joined = tags.join(" ");
  const out = `${saying} ${joined}`;
  if (out.length <= limit) return out;
  // Should not happen given the budget math above, but be safe.
  return saying.slice(0, limit);
}

/**
 * Compose a reply: "@handle <reply>" optionally followed by 0-2 hashtags.
 *
 * Replies are shorter — 1 hashtag max — to keep the bot from looking spammy
 * in conversation threads.
 */
function composeReply(env, replyBody, recipientHandle) {
  const limit = maxTweetLength(env);
  const prefix = `@${recipientHandle} `;
  const bodyMax = Math.max(20, limit - prefix.length);
  const body = clampToLength(cleanGenerated(replyBody), bodyMax);
  let out = `${prefix}${body}`;
  const remaining = limit - out.length;
  if (remaining >= 12) {
    const tags = pickHashtags({
      budget: Math.min(remaining, 30),
      alwaysInclude: [],
    }).slice(0, 1);
    if (tags.length) out = `${out} ${tags[0]}`;
  }
  return out.slice(0, limit);
}

// -------------------------------------------------------------------------
// Core actions
// -------------------------------------------------------------------------

/**
 * Call the model with the given prompt-builder and run a "voice quality"
 * loop: if the output contains a banned guru phrase, retry up to `maxRetries`
 * times with an explicit "rewrite without X" coaching line. Returns the best
 * draft we got, plus a flag indicating whether it passed the voice check.
 *
 * The forced-token (if any) is injected on the first attempt only — on
 * retries the model is already constrained enough by the rewrite coaching.
 *
 * @param {any} env
 * @param {object} args
 * @param {(opts:{forcedToken?:string,retryHint?:string})=>{role:string,content:string}[]} args.buildMessages
 * @param {number} args.maxRetries
 * @param {number} [args.forceTokenProbability]
 * @param {number} [args.temperature]
 */
async function generateInVoice(env, { buildMessages, maxRetries, forceTokenProbability = 0.5, temperature }) {
  const forcedToken = pickForcedToken({ probability: forceTokenProbability });

  let lastDraft = "";
  let lastFail = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const retryHint = lastFail
      ? `Your previous attempt contained the banned phrase "${lastFail}". Rewrite from scratch without it. Stay in the absurdist Lebowski/TPB/Funkadelic register — not the sage/guru register.`
      : undefined;
    const messages = buildMessages({
      forcedToken: attempt === 0 ? forcedToken || undefined : undefined,
      retryHint,
    });
    const raw = await chat(env, {
      messages,
      temperature: temperature ?? 0.9,
      maxTokens: 220,
    });
    const cleaned = cleanGenerated(raw);
    lastDraft = cleaned;
    const verdict = checkVoice(cleaned);
    if (verdict.ok) {
      return { text: cleaned, attempts: attempt + 1, forcedToken, passed: true };
    }
    lastFail = verdict.match;
    console.warn(
      `voice check failed on attempt ${attempt + 1}: matched "${verdict.match}". Retrying…`,
    );
  }
  return { text: lastDraft, attempts: maxRetries + 1, forcedToken, passed: false };
}

/**
 * Generate the body of a daily post — either pulled from the corpus or freshly
 * generated, weighted by NEW_SAYING_PROBABILITY.
 *
 * @param {any} env
 * @returns {Promise<{ kind: "corpus" | "model", text: string, meta?: object }>}
 */
export async function buildDailySaying(env) {
  const limit = maxTweetLength(env);
  const reserveForHashtags = 50;
  const sayingBudget = Math.max(60, limit - reserveForHashtags);

  const newProb = Number(env.NEW_SAYING_PROBABILITY ?? "0.5");
  const useModel = Math.random() < (Number.isFinite(newProb) ? newProb : 0.5);

  if (useModel) {
    try {
      const result = await generateInVoice(env, {
        buildMessages: ({ forcedToken, retryHint }) =>
          newSayingMessages({ maxLength: sayingBudget, forcedToken, retryHint }),
        maxRetries: 2,
        forceTokenProbability: 0.6,
        temperature: 0.95,
      });
      return {
        kind: "model",
        text: result.text,
        meta: {
          attempts: result.attempts,
          forcedToken: result.forcedToken,
          voicePassed: result.passed,
        },
      };
    } catch (err) {
      console.warn("Model generation failed, falling back to corpus:", err);
    }
  }
  return { kind: "corpus", text: randomQuote(sayingBudget) };
}

/**
 * Post the daily saying. Idempotent against re-runs on the same UTC date
 * (so a misfiring cron won't double-post).
 *
 * @param {any} env
 * @returns {Promise<{posted:boolean,reason?:string,tweetId?:string,text?:string,kind?:string}>}
 */
export async function postDailySaying(env) {
  const today = new Date().toISOString().slice(0, 10);
  const last = await getLastDailyPostDate(env).catch(() => null);
  if (last === today) {
    return { posted: false, reason: `already_posted:${today}` };
  }

  const { kind, text: sayingBody } = await buildDailySaying(env);
  const tweetText = composeTweet(env, sayingBody);

  const resp = await postTweet(env, tweetText);
  const id = resp?.data?.id;
  await setLastDailyPostDate(env, today).catch(() => {});
  await recordPost(env, { id: id || "unknown", text: tweetText, kind: "daily" });
  return { posted: true, tweetId: id, text: tweetText, kind };
}

/**
 * Maximum age (in hours) of a mention we'll still reply to. Anything older
 * than this is treated as ancient history regardless of the cursor state.
 * @param {any} env
 */
function maxMentionAgeHours(env) {
  const n = Number(env.MAX_MENTION_AGE_HOURS ?? "24");
  return Number.isFinite(n) && n > 0 ? n : 24;
}

/** @param {any} env */
function threadContextMaxPages(env) {
  const n = Number(env.THREAD_CONTEXT_MAX_PAGES ?? "5");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
}

/** @param {any} envelope */
function usersByIdFromEnvelope(envelope) {
  return (envelope?.includes?.users || []).reduce((acc, u) => {
    acc[u.id] = u;
    return acc;
  }, /** @type {Record<string, any>} */ ({}));
}

function compareTweetIds(a, b) {
  try {
    const ai = BigInt(a);
    const bi = BigInt(b);
    if (ai < bi) return -1;
    if (ai > bi) return 1;
    return 0;
  } catch {
    return String(a).localeCompare(String(b));
  }
}

function sortTweetsChronologically(tweets) {
  return tweets.slice().sort((a, b) => compareTweetIds(a.id, b.id));
}

function dedupeTweets(tweets) {
  const byId = new Map();
  for (const tweet of tweets) {
    if (tweet?.id) byId.set(tweet.id, tweet);
  }
  return Array.from(byId.values());
}

/**
 * Render a compact, chronological transcript for the reply prompt. Usernames
 * are part of the input context only; the model is still forbidden to emit
 * @-mentions, and composeReply adds the single recipient mention later.
 */
function formatThreadContext(tweets, usersById, mentionTweet) {
  const allTweets = dedupeTweets([...tweets, mentionTweet]);
  const sorted = sortTweetsChronologically(allTweets);
  return sorted
    .map((tweet) => {
      const user = usersById[tweet.author_id];
      const handle = user?.username || tweet.author_id || "unknown";
      const marker = tweet.id === mentionTweet.id ? "[MENTION] " : "";
      return `${marker}@${handle}: ${tweet.text || ""}`;
    })
    .join("\n");
}

async function buildMentionThreadContext(env, mentionTweet, mentionUsersById, threadCache) {
  const conversationId = mentionTweet.conversation_id || mentionTweet.id;
  let envelope = threadCache.get(conversationId);
  if (!envelope) {
    envelope = await getConversationTweets(env, conversationId, {
      pageSize: 100,
      maxPages: threadContextMaxPages(env),
    });
    threadCache.set(conversationId, envelope);
  }

  return formatThreadContext(envelope?.data || [], {
    ...mentionUsersById,
    ...usersByIdFromEnvelope(envelope),
  }, mentionTweet);
}

/**
 * Poll mentions and reply to anything new. Limits itself to 5 replies per run
 * to avoid burning rate limit budget when there's a backlog.
 *
 * Safety guarantees:
 *   - First-ever run (no `last_mention_id` in KV) seeds the cursor to the
 *     newest current mention and replies to NOTHING. This stops the bot from
 *     spamming years of historical @-mentions when it first comes online.
 *   - Every subsequent run additionally enforces an age cutoff
 *     (`MAX_MENTION_AGE_HOURS`, default 24) both at the API layer and
 *     client-side, so a wiped KV or long outage can never re-trigger backlog.
 *
 * @param {any} env
 * @param {{maxReplies?:number, allowBootstrapReplies?:boolean}} [opts]
 */
export async function processMentions(env, opts = {}) {
  const maxReplies = opts.maxReplies ?? 5;
  const me = await getAuthedUser(env);
  if (!me?.id) throw new Error("Could not resolve authed user");

  const sinceId = await getLastMentionId(env);
  const isBootstrap = !sinceId && !opts.allowBootstrapReplies;

  const ageHours = maxMentionAgeHours(env);
  const cutoffMs = Date.now() - ageHours * 60 * 60 * 1000;
  const startTime = new Date(cutoffMs).toISOString();

  const envelope = await getMentions(env, me.id, {
    sinceId: sinceId || undefined,
    startTime,
    maxResults: 20,
  });
  const tweets = envelope?.data || [];
  const users = usersByIdFromEnvelope(envelope);

  // Sort ascending by id so the resulting cursor is the highest at the end.
  const sortedAsc = tweets.slice().sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  let highest = sinceId || "0";
  for (const t of sortedAsc) {
    if (BigInt(t.id) > BigInt(highest)) highest = t.id;
  }

  // First-run bootstrap: seed the cursor and bail. We deliberately don't reply
  // to anything on this path even if the mentions fall inside the age window —
  // the user explicitly turns on replies by waiting for the *next* tick.
  if (isBootstrap) {
    if (highest !== "0") {
      await setLastMentionId(env, highest);
    }
    return {
      processed: tweets.length,
      replied: 0,
      newest: highest === "0" ? null : highest,
      bootstrap: true,
      reason: "first_run_seed_cursor",
    };
  }

  if (!tweets.length) {
    return { processed: 0, replied: 0, newest: sinceId || null };
  }

  let replied = 0;
  const errors = [];
  const skipped = { tooOld: 0, self: 0, alreadyReplied: 0, threadUnavailable: 0 };
  const threadCache = new Map();

  for (const t of sortedAsc) {
    // Never reply to ourselves, even if we somehow tag ourselves.
    if (t.author_id === me.id) {
      skipped.self++;
      continue;
    }

    // Defense in depth — server already filtered by start_time, but if X ever
    // misbehaves or the field is missing, this guarantees the age contract.
    if (t.created_at) {
      const ts = Date.parse(t.created_at);
      if (Number.isFinite(ts) && ts < cutoffMs) {
        skipped.tooOld++;
        continue;
      }
    }

    if (replied >= maxReplies) continue;
    if (await hasReplied(env, t.id)) {
      skipped.alreadyReplied++;
      continue;
    }

    const author = users[t.author_id];
    const handle = author?.username || "dude";
    const replyMaxLen = Math.max(60, maxTweetLength(env) - (handle.length + 2) - 24);
    let threadContext;
    try {
      threadContext = await buildMentionThreadContext(env, t, users, threadCache);
    } catch (err) {
      console.warn(`thread fetch failed for ${t.id}:`, err);
      errors.push({ id: t.id, error: `thread_context:${String(err)}` });
      skipped.threadUnavailable++;
      continue;
    }

    let replyBody;
    try {
      const result = await generateInVoice(env, {
        buildMessages: ({ forcedToken, retryHint }) =>
          replyMessages({
            tweetText: t.text || "",
            threadContext,
            tweetAuthorHandle: handle,
            maxLength: replyMaxLen,
            forcedToken,
            retryHint,
          }),
        maxRetries: 2,
        // Replies should track the tweet they're answering, so force a token
        // less often than for stand-alone daily posts.
        forceTokenProbability: 0.35,
        temperature: 0.9,
      });
      replyBody = result.text;
    } catch (err) {
      console.warn(`reply generation failed for ${t.id}:`, err);
      errors.push({ id: t.id, error: String(err) });
      continue;
    }

    const replyText = composeReply(env, replyBody, handle);

    try {
      const resp = await postTweet(env, replyText, t.id);
      await markReplied(env, t.id);
      await recordPost(env, {
        id: resp?.data?.id || "unknown",
        text: replyText,
        kind: "reply",
        inReplyTo: t.id,
      });
      replied++;
    } catch (err) {
      console.warn(`reply post failed for ${t.id}:`, err);
      errors.push({ id: t.id, error: String(err) });
    }
  }

  // Advance the cursor even when individual replies failed, so a single bad
  // tweet can't jam the queue forever.
  if (highest !== (sinceId || "0")) {
    await setLastMentionId(env, highest);
  }

  return { processed: tweets.length, replied, newest: highest, skipped, errors };
}

// -------------------------------------------------------------------------
// HTTP / scheduled entrypoints
// -------------------------------------------------------------------------

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** Optional bearer-token gate for ops routes. */
function isAuthorized(request, env) {
  if (!env.OPS_TOKEN) return true; // no token configured = open (dev convenience)
  const got = request.headers.get("Authorization") || "";
  return got === `Bearer ${env.OPS_TOKEN}`;
}

export default {
  /**
   * Cron handler. We dispatch based on which cron expression triggered this
   * run so the same Worker can both daily-post and poll mentions.
   *
   * @param {ScheduledEvent} event
   * @param {any} env
   * @param {ExecutionContext} ctx
   */
  async scheduled(event, env, ctx) {
    const cron = event.cron;
    const dailyCron = env.DAILY_POST_CRON || "20 16 * * *";

    if (cron === dailyCron) {
      ctx.waitUntil(
        postDailySaying(env)
          .then((r) => console.log("daily post:", JSON.stringify(r)))
          .catch((err) => console.error("daily post failed:", err)),
      );
    } else {
      ctx.waitUntil(
        processMentions(env)
          .then((r) => console.log("mentions:", JSON.stringify(r)))
          .catch((err) => console.error("mentions failed:", err)),
      );
    }
  },

  /**
   * @param {Request} request
   * @param {any} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/") {
      const lastMention = await getLastMentionId(env).catch(() => null);
      const lastDaily = await getLastDailyPostDate(env).catch(() => null);
      return jsonResponse({
        ok: true,
        bot: "broprophet",
        handle: env.X_HANDLE || null,
        model: env.OPENAI_MODEL || "gpt-4o-mini",
        last_mention_id: lastMention,
        last_daily_post_date: lastDaily,
      });
    }

    if (path === "/preview") {
      // Generate a sample without posting — safe to leave open.
      const { kind, text, meta } = await buildDailySaying(env);
      const tweet = composeTweet(env, text);
      return jsonResponse({ kind, raw: text, tweet, length: tweet.length, meta });
    }

    if (path === "/post-now") {
      if (request.method !== "POST") return jsonResponse({ error: "use POST" }, 405);
      if (!isAuthorized(request, env)) return jsonResponse({ error: "unauthorized" }, 401);
      try {
        const result = await postDailySaying(env);
        return jsonResponse(result);
      } catch (err) {
        return jsonResponse({ error: String(err) }, 500);
      }
    }

    if (path === "/check-mentions") {
      if (request.method !== "POST") return jsonResponse({ error: "use POST" }, 405);
      if (!isAuthorized(request, env)) return jsonResponse({ error: "unauthorized" }, 401);
      try {
        const result = await processMentions(env);
        return jsonResponse(result);
      } catch (err) {
        return jsonResponse({ error: String(err) }, 500);
      }
    }

    // Manually advance the mention cursor without replying. Useful when the
    // bot has been spamming backlog and you want to fast-forward past it.
    // Body (JSON, optional): { "to": "<tweet_id>" }. If omitted, seeds to the
    // newest current mention.
    if (path === "/skip-mentions") {
      if (request.method !== "POST") return jsonResponse({ error: "use POST" }, 405);
      if (!isAuthorized(request, env)) return jsonResponse({ error: "unauthorized" }, 401);
      try {
        let target = null;
        try {
          const body = await request.json();
          if (body && typeof body.to === "string") target = body.to;
        } catch {
          // empty body is fine
        }
        if (!target) {
          const me = await getAuthedUser(env);
          if (!me?.id) throw new Error("Could not resolve authed user");
          const envelope = await getMentions(env, me.id, { maxResults: 5 });
          const tweets = envelope?.data || [];
          if (!tweets.length) {
            return jsonResponse({ ok: true, newest: null, note: "no mentions found" });
          }
          target = tweets
            .map((t) => t.id)
            .reduce((max, id) => (BigInt(id) > BigInt(max) ? id : max), "0");
        }
        await setLastMentionId(env, target);
        return jsonResponse({ ok: true, newest: target });
      } catch (err) {
        return jsonResponse({ error: String(err) }, 500);
      }
    }

    return jsonResponse({ error: "not found", path }, 404);
  },
};
