// Thin wrapper around the X API v2 endpoints we care about.
// All requests use OAuth 1.0a user-context auth (single set of static keys).

import { buildOAuth1Header } from "./oauth1.js";

const API_BASE = "https://api.twitter.com";

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
    "tweet.fields": "author_id,conversation_id,created_at,in_reply_to_user_id,referenced_tweets",
    expansions: "author_id",
    "user.fields": "username,name",
  };
  if (sinceId) query.since_id = sinceId;
  if (startTime) query.start_time = startTime;
  return signedRequest(env, {
    method: "GET",
    path: `/2/users/${userId}/mentions`,
    query,
  });
}
