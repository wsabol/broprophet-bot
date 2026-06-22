// Tiny OpenAI Chat Completions client. We don't need streaming, function calls,
// or anything fancy — just "send messages, get a single string back".

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

/**
 * @param {any} env
 * @param {object} args
 * @param {{role:"system"|"user"|"assistant",content:string}[]} args.messages
 * @param {number} [args.temperature]
 * @param {number} [args.maxTokens]
 * @returns {Promise<string>}
 */
export async function chat(env, { messages, temperature = 1.0, maxTokens = 220 }) {
  if (!env.OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
  const model = env.OPENAI_MODEL || "gpt-4o-mini";

  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      // High top_p + presence/frequency penalties keep the BroProphet from
      // re-mashing the same 4 phrases over and over.
      top_p: 0.95,
      presence_penalty: 0.6,
      frequency_penalty: 0.4,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OpenAI ${res.status}: ${text}`);
  }
  const data = JSON.parse(text);
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`OpenAI returned no content: ${text}`);
  return content.trim();
}
