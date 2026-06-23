# broprophet-bot

> *"Free your mind and your ass will follow."* — The BroProphet

An X (Twitter) bot that channels **The BroProphet**: existential Dude vibes, college party bravado, the manical fiendish joy of 60s drug culture, Parliament/Funkadelic psychedelia, with seasoning from Steely Dan, Trailer Park Boys, Big Lebowski, Chuck Norris, and 10guy memes.

Deployed as a single Cloudflare Worker. JavaScript, no build step.

## What it does

- **Daily post** (one cron per day): posts either a verbatim quote from `data/*.txt` or a freshly generated saying from OpenAI, mixed by `NEW_SAYING_PROBABILITY`.
- **Replies to mentions** (cron every 15 min): polls the authed user's mentions; for each new one, generates an in-character reply with OpenAI and posts it as a real X reply (`in_reply_to_tweet_id`).
- **Hashtags** are picked from three buckets and squeezed into whatever budget the tweet has left: on-brand BroProphet/Funkadelic tags, absurd-humor tags, and audience-reach tags (jazz, funk, day-of-week tags, etc.).
- **Idempotency**: KV stores `since_id` for mentions, a `replied:<id>` marker per tweet, and a `last_daily_post_date` guard so a misfiring cron can't double-post.

## Project layout

```
src/broprophet/
  index.js     # Worker entry: scheduled() + fetch() + post/reply orchestration
  oauth1.js    # OAuth 1.0a HMAC-SHA1 signing via Web Crypto
  x.js         # X v2 API client (postTweet, getMentions, getAuthedUser)
  openai.js    # Tiny chat-completions client
  corpus.js    # Loads data/*.txt as text imports; sample / few-shot helpers
  prompts.js   # System prompt (the BroProphet voice) + message builders
  hashtags.js  # Hashtag bank + budget-aware picker
  storage.js   # KV wrapper (mention cursor, replied set, daily-post guard)

data/
  archive.txt
  band-group.txt
  clickhole.txt
  facebook.txt   # ← the canonical BroProphet corpus
```

## Setup

### 1. Install

```bash
npm install
```

### 2. Get credentials

You need:

- An **OpenAI API key** with access to your chosen model (defaults to `gpt-4o-mini`).
- An **X developer app** with:
  - OAuth 1.0a User-context enabled
  - **Read + Write** app permissions (Write is required to post)
  - Your bot account's **Access Token** and **Access Token Secret** (regenerate these *after* enabling write perms or they'll be read-only)
  - The app's **API Key** and **API Secret** (consumer creds)

### 3. Create the KV namespace

```bash
npm run kv:create
```

Wrangler will print an `id`. Paste it into `wrangler.toml` where it says `REPLACE_WITH_KV_ID`.

### 4. Set secrets

```bash
npm run secret:openai
npm run secret:x-key
npm run secret:x-secret
npm run secret:x-token
npm run secret:x-token-secret
```

(Each command prompts for the value. For local dev, copy `.dev.vars.example` to `.dev.vars` and fill it in.)

### 5. Configure non-secret vars in `wrangler.toml`

- `X_HANDLE` — your bot's X handle (no `@`). Prevents self-mentions from triggering replies.
- `OPENAI_MODEL` — defaults to `gpt-4o-mini`. Use `gpt-4o` for higher quality at higher cost.
- `NEW_SAYING_PROBABILITY` — `0.5` posts a freshly generated saying half the time and a corpus quote the other half. Set to `0.0` for corpus-only, `1.0` for model-only.
- `MAX_TWEET_LENGTH` — `280` by default. Bump if your account is X Premium.
- `ALWAYS_HASHTAGS` — optional comma-separated tags to always include (e.g. `BroProphet,FunkIsItsOwnReward`).
- `DAILY_POST_CRON` — the cron expression that triggers the daily post. Must match exactly one of the entries in `[triggers].crons`.

### 6. Deploy

```bash
npm run deploy
```

## Cron schedule

Defined in `wrangler.toml`:

```toml
crons = ["20 16 * * *", "*/15 * * * *"]
```

The Worker checks `event.cron` against `DAILY_POST_CRON`:

- match → daily post
- otherwise → poll mentions and reply

To change post time, edit both the cron in `[triggers].crons` and the `DAILY_POST_CRON` var.

## Manual ops endpoints

These exist so you can preview/trigger things without waiting for cron. They live behind an optional `OPS_TOKEN` (set via `wrangler secret put OPS_TOKEN`); if no token is set, they're open (fine for local dev, lock it down in prod).

- `GET /` — health check; shows handle, model, and KV cursors.
- `GET /preview` — generates a daily-post candidate **without posting**. Great for tuning the voice.
- `POST /post-now` — posts the daily saying immediately (still respects the one-per-UTC-day guard).
- `POST /check-mentions` — runs the mention poll immediately.

With a token:

```bash
curl -X POST https://<your-worker>.workers.dev/post-now \
  -H "Authorization: Bearer $OPS_TOKEN"
```

## How the voice is enforced

`src/broprophet/prompts.js` builds the system prompt. It bakes in:

1. A **VOICE_GUIDE** describing the BroProphet's soul (Dude / Funkadelic / Jack Kerouac / college bro / Steely Dan / TPB / Chuck Norris / 10guy).
2. A rolling set of **14 random few-shot examples** sampled from your `data/*.txt` files on every generation — so the model is always seeing the canon, but never quite the same canon twice.
3. Hard rules: third-person OK, no hashtags or @-mentions in model output (those are added by the system), no breaking character.

To tweak the personality, edit `VOICE_GUIDE` in `prompts.js`. To add more canon, drop new lines into `data/*.txt` — they'll be picked up at the next deploy.

## Cost / rate limits

- OpenAI cost is tiny: ~1 daily post + ~5 replies/day at most ≈ pennies/month on `gpt-4o-mini`.
- X API: the free/basic tier of the v2 API has tight read limits. Mentions polling every 15 min should fit in basic, but if you hit 429s, increase the cron interval (e.g. `*/30 * * `* *).
- Cloudflare Workers free tier handles this load with room to spare.

## Safety notes

- The system prompt explicitly forbids slurs, harassment, real-world threats, sexual content involving minors, and doxxing. It does *not* forbid the BroProphet's canonical horniness/profanity — if you want it cleaner, tighten `VOICE_GUIDE`.
- Replies are capped at 5 per run to prevent runaway behavior if mention volume spikes.
- The `last_mention_id` cursor advances even when individual replies fail, so a single bad tweet can't permanently block the queue.

## Local development

```bash
cp .dev.vars.example .dev.vars
# fill in real secrets
npx wrangler dev
```

Then hit `http://localhost:8787/preview` to see what the bot *would* tweet.

To exercise the cron handler locally:

```bash
npx wrangler dev --test-scheduled
# then in another shell:
curl "http://localhost:8787/__scheduled?cron=20+16+*+*+*"
```

