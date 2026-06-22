// Thin KV wrapper. We persist just enough state to:
//   - know what mention IDs we've already processed (since_id pointer)
//   - know which tweet IDs we've already replied to (idempotency across runs)
//   - record the last daily-post date to avoid double-posting if cron fires twice

const KEYS = {
  lastMentionId: "last_mention_id",
  lastDailyPostDate: "last_daily_post_date",
  repliedPrefix: "replied:",
  recentPostsPrefix: "post:",
};

/**
 * @typedef {{ get:(k:string,t?:string)=>Promise<any>, put:(k:string,v:string,o?:any)=>Promise<void>, delete:(k:string)=>Promise<void>, list:(o:any)=>Promise<any> }} KV
 */

/** @param {any} env */
function kv(env) {
  if (!env.BROPROPHET_KV) {
    throw new Error("BROPROPHET_KV binding missing. Run `npm run kv:create` and update wrangler.toml.");
  }
  return /** @type {KV} */ (env.BROPROPHET_KV);
}

/** @param {any} env */
export async function getLastMentionId(env) {
  return (await kv(env).get(KEYS.lastMentionId)) || null;
}

/** @param {any} env @param {string} id */
export async function setLastMentionId(env, id) {
  await kv(env).put(KEYS.lastMentionId, id);
}

/** @param {any} env @param {string} tweetId */
export async function hasReplied(env, tweetId) {
  const v = await kv(env).get(`${KEYS.repliedPrefix}${tweetId}`);
  return !!v;
}

/** @param {any} env @param {string} tweetId */
export async function markReplied(env, tweetId) {
  await kv(env).put(`${KEYS.repliedPrefix}${tweetId}`, "1", {
    // 30 days is enough to dedupe; the since_id pointer handles the rest.
    expirationTtl: 60 * 60 * 24 * 30,
  });
}

/** Return ISO date (YYYY-MM-DD) we last did a daily post on, or null. */
export async function getLastDailyPostDate(env) {
  return (await kv(env).get(KEYS.lastDailyPostDate)) || null;
}

/** @param {any} env @param {string} isoDate */
export async function setLastDailyPostDate(env, isoDate) {
  await kv(env).put(KEYS.lastDailyPostDate, isoDate);
}

/**
 * Record a posted tweet for inspection/debug (optional). Keyed by tweet id,
 * stored for 7 days. Best-effort — failure is non-fatal to the caller.
 *
 * @param {any} env
 * @param {{id:string,text:string,kind:"daily"|"reply",inReplyTo?:string}} record
 */
export async function recordPost(env, record) {
  try {
    await kv(env).put(
      `${KEYS.recentPostsPrefix}${record.id}`,
      JSON.stringify({ ...record, ts: new Date().toISOString() }),
      { expirationTtl: 60 * 60 * 24 * 7 },
    );
  } catch (err) {
    console.warn("recordPost failed (ignored):", err);
  }
}
