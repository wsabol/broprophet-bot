// Thin wrapper around the X API v2 endpoints we care about.
// All requests use OAuth 1.0a user-context auth (single set of static keys).

import { buildOAuth1Header } from "./oauth1.js";

const API_BASE = "https://api.twitter.com";
const TWEET_FIELDS = "author_id,conversation_id,created_at,in_reply_to_user_id,referenced_tweets";
const USER_FIELDS = "username,name";

/**
 * @param {object} env
 * @returns {{consumerKey:string,consumerSecret:string,accessToken:string,accessTokenSecret:string}}
 */
function credsFromEnv(env) {
  for (const k of ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"]) {
    if (!env[k]) throw new Error(`Missing X credential: ${k}`);
  }
  return {
    consumerKey: env.X_API_KEY,
    consumerSecret: env.X_API_SECRET,
    accessToken: env.X_ACCESS_TOKEN,
    accessTokenSecret: env.X_ACCESS_TOKEN_SECRET,
  };
}

/**
 * Internal: signed JSON request helper.
 *
 * For v2 endpoints with JSON bodies the body is NOT included in the OAuth
 * signature base (only oauth + query params). For v1.1 form-encoded endpoints
 * we'd pass `formBody` so the params get folded in.
 */
async function signedRequest(env, { method, path, query = {}, json }) {
  const url = `${API_BASE}${path}`;
  const auth = await buildOAuth1Header({
    method,
    url,
    query,
    creds: credsFromEnv(env),
  });
  const qs = Object.keys(query).length
    ? "?" + new URLSearchParams(query).toString()
    : "";
  const res = await fetch(url + qs, {
    method,
    headers: {
      Authorization: auth,
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(
      `X API ${method} ${path} -> ${res.status}: ${JSON.stringify(body)}`,
    );
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/**
 * Post a new tweet, or a reply if `inReplyToTweetId` is provided.
 * @param {any} env
 * @param {string} text
 * @param {string} [inReplyToTweetId]
 */
export async function postTweet(env, text, inReplyToTweetId) {
  const body = { text };
  if (inReplyToTweetId) {
    body.reply = { in_reply_to_tweet_id: inReplyToTweetId };
  }
  return signedRequest(env, {
    method: "POST",
    path: "/2/tweets",
    json: body,
  });
}

/**
 * Look up the authed user (used once on startup / for handle->id mapping).
 * Caches by handle in env.BROPROPHET_KV when available.
 */
export async function getAuthedUser(env) {
  const cacheKey = `me:${env.X_HANDLE || "self"}`;
  if (env.BROPROPHET_KV) {
    const hit = await env.BROPROPHET_KV.get(cacheKey, "json");
    if (hit && hit.id) return hit;
  }
  const data = await signedRequest(env, { method: "GET", path: "/2/users/me" });
  const user = data.data;
  if (env.BROPROPHET_KV && user?.id) {
    await env.BROPROPHET_KV.put(cacheKey, JSON.stringify(user), {
      expirationTtl: 60 * 60 * 24 * 7,
    });
  }
  return user;
}

/**
 * Fetch recent mentions of the authed user.
 *
 * Both `sinceId` and `startTime` are server-side filters — when both are set
 * the API returns the intersection (i.e. mentions that satisfy both bounds),
 * which is exactly what we want to prevent ever fetching ancient history.
 *
 * Returns the parsed v2 envelope: { data, includes, meta }.
 *
 * @param {any} env
 * @param {string} userId
 * @param {object} [opts]
 * @param {string} [opts.sinceId] Only return mentions with id strictly greater than this.
 * @param {string} [opts.startTime] ISO 8601 timestamp; only return mentions newer than this.
 * @param {number} [opts.maxResults] 5..100, defaults 20.
 */
export async function getMentions(env, userId, opts = {}) {
  const { sinceId, startTime, maxResults = 20 } = opts;
  const query = {
    max_results: String(Math.max(5, Math.min(100, maxResults))),
    "tweet.fields": TWEET_FIELDS,
    expansions: "author_id",
    "user.fields": USER_FIELDS,
  };
  if (sinceId) query.since_id = sinceId;
  if (startTime) query.start_time = startTime;
  return signedRequest(env, {
    method: "GET",
    path: `/2/users/${userId}/mentions`,
    query,
  });
}

/**
 * Look up tweets by ID.
 *
 * @param {any} env
 * @param {string[]} ids
 */
export async function getTweetsByIds(env, ids) {
  const unique = Array.from(new Set(ids.map(String).filter((id) => /^\d+$/.test(id))));
  if (!unique.length) {
    return { data: [], includes: { users: [] }, meta: { result_count: 0 } };
  }

  return signedRequest(env, {
    method: "GET",
    path: "/2/tweets",
    query: {
      ids: unique.slice(0, 100).join(","),
      "tweet.fields": TWEET_FIELDS,
      expansions: "author_id",
      "user.fields": USER_FIELDS,
    },
  });
}

/**
 * Fetch tweets from a conversation thread using X recent search.
 *
 * X's mentions endpoint only returns the tweet that tagged us. For replies to
 * make sense in context, search the conversation_id and collect each page in
 * the thread. Recent search is bounded by X's API tier/history limits, so this
 * returns everything the API exposes for that conversation.
 *
 * Returns the parsed v2 envelope: { data, includes, meta }.
 *
 * @param {any} env
 * @param {string} conversationId
 * @param {object} [opts]
 * @param {number} [opts.pageSize] 10..100 tweets per API request, defaults 100.
 * @param {number} [opts.maxPages] Safety cap for pathological conversations, defaults 5.
 */
export async function getConversationTweets(env, conversationId, opts = {}) {
  const id = String(conversationId || "");
  if (!/^\d+$/.test(id)) {
    throw new Error(`Invalid conversation id: ${conversationId}`);
  }

  const pageSize = Math.max(10, Math.min(100, opts.pageSize ?? 100));
  const maxPages = Math.max(1, opts.maxPages ?? 5);
  const data = [];
  const users = new Map();
  let nextToken = null;

  for (let page = 0; page < maxPages; page++) {
    const query = {
      query: `conversation_id:${id}`,
      max_results: String(pageSize),
      "tweet.fields": TWEET_FIELDS,
      expansions: "author_id",
      "user.fields": USER_FIELDS,
    };
    if (nextToken) query.next_token = nextToken;

    const envelope = await signedRequest(env, {
      method: "GET",
      path: "/2/tweets/search/recent",
      query,
    });

    for (const tweet of envelope?.data || []) {
      data.push(tweet);
    }
    for (const user of envelope?.includes?.users || []) {
      users.set(user.id, user);
    }

    nextToken = envelope?.meta?.next_token || null;
    if (!nextToken) break;
  }

  const tweetsById = new Map();
  for (const tweet of data) {
    tweetsById.set(tweet.id, tweet);
  }
  if (!tweetsById.has(id)) {
    try {
      const root = await getTweetsByIds(env, [id]);
      for (const tweet of root?.data || []) {
        tweetsById.set(tweet.id, tweet);
      }
      for (const user of root?.includes?.users || []) {
        users.set(user.id, user);
      }
    } catch (err) {
      console.warn(`Could not fetch root tweet ${id}:`, err);
    }
  }

  return {
    data: Array.from(tweetsById.values()),
    includes: { users: Array.from(users.values()) },
    meta: {
      result_count: tweetsById.size,
      hit_page_cap: Boolean(nextToken),
    },
  };
}
