// OAuth 1.0a HMAC-SHA1 signing for X (Twitter) API, built on Web Crypto so it
// runs unmodified in Cloudflare Workers. We only need the 3-legged user-context
// flavor where consumer_key/secret + access_token/secret are all known up front.

/**
 * Percent-encode per RFC 3986 (stricter than encodeURIComponent).
 * @param {string} value
 */
function percentEncode(value) {
  return encodeURIComponent(value).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** @param {Record<string,string>} obj */
function sortedEncodedPairs(obj) {
  return Object.keys(obj)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(obj[k])}`);
}

/**
 * @param {ArrayBuffer} buf
 * @returns {string}
 */
function bufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  // btoa is available in Workers' global scope.
  return btoa(binary);
}

/**
 * @param {string} key HMAC key
 * @param {string} message Signature base string
 */
async function hmacSha1(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
  return bufferToBase64(sig);
}

/** Generate a hex nonce. */
function nonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build the `Authorization` header value for an OAuth 1.0a request.
 *
 * @param {object} args
 * @param {"GET"|"POST"|"PUT"|"DELETE"} args.method
 * @param {string} args.url Full request URL (no query string)
 * @param {Record<string,string|number|boolean>} [args.query] Query parameters (used in signature only)
 * @param {Record<string,string>} [args.formBody] application/x-www-form-urlencoded body params (used in signature)
 * @param {object} args.creds
 * @param {string} args.creds.consumerKey
 * @param {string} args.creds.consumerSecret
 * @param {string} args.creds.accessToken
 * @param {string} args.creds.accessTokenSecret
 */
export async function buildOAuth1Header({ method, url, query = {}, formBody = {}, creds }) {
  const oauthParams = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: nonce(),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };

  // Per spec: combine oauth + query + form params, percent-encode, sort, then
  // join with '&' for the parameter string portion of the signature base.
  const allParams = {};
  for (const [k, v] of Object.entries(oauthParams)) allParams[k] = String(v);
  for (const [k, v] of Object.entries(query)) allParams[k] = String(v);
  for (const [k, v] of Object.entries(formBody)) allParams[k] = String(v);

  const parameterString = sortedEncodedPairs(allParams).join("&");
  const baseString = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(parameterString),
  ].join("&");

  const signingKey = `${percentEncode(creds.consumerSecret)}&${percentEncode(creds.accessTokenSecret)}`;
  const signature = await hmacSha1(signingKey, baseString);

  const headerParams = {
    ...oauthParams,
    oauth_signature: signature,
  };

  return (
    "OAuth " +
    Object.keys(headerParams)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(headerParams[k])}"`)
      .join(", ")
  );
}
