/**
 * The one provider this extension talks to, and the only account it ever uses:
 * the owner's own OpenRouter account.
 *
 * There is no Ghost account, no proxy of ours, and no per-provider login. A key
 * is minted by OpenRouter for this browser, kept in `chrome.storage.local`, and
 * sent to exactly one origin. Nothing here logs it, and nothing here sends it
 * anywhere but `https://openrouter.ai`.
 *
 * `fetch` is the global one on purpose: OpenRouter answers extension origins
 * with `Access-Control-Allow-Origin: *`, so an extension page reaches it under
 * ordinary CORS and the manifest needs no host grant over any site. Tests stub
 * `globalThis.fetch`.
 */

export const OPENROUTER_ORIGIN = "https://openrouter.ai";
/**
 * Where the key lives in `chrome.storage.local`. The side panel writes and
 * reads it; the service worker only asks whether the name is set, to light the
 * toolbar badge, and never reads the value.
 */
export const KEY_STORE = "openRouterKey";
const AUTH_URL = `${OPENROUTER_ORIGIN}/auth`;
const KEYS_URL = `${OPENROUTER_ORIGIN}/api/v1/auth/keys`;
const MODELS_URL = `${OPENROUTER_ORIGIN}/api/v1/models`;
const COMPLETIONS_URL = `${OPENROUTER_ORIGIN}/api/v1/chat/completions`;

/**
 * The free models router. It picks a free model that can do what the request
 * needs — tool calling included — and reports which one it used, so the default
 * path costs nothing without pinning a model that may be retired next week.
 */
export const DEFAULT_MODEL = "openrouter/free";

/** Attribution headers OpenRouter documents; neither carries owner data. */
const ATTRIBUTION = {
  "HTTP-Referer": "https://github.com/ferdousbhai/ghost-chromium-extension",
  "X-Title": "Ghost",
};

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * Begin PKCE. The verifier is the secret half and never leaves this browser;
 * only its SHA-256 goes to OpenRouter in the authorize URL.
 *
 * `callbackUrl` is the one-click path (`chrome.identity`'s
 * `https://<id>.chromiumapp.org/`). Omitting it is OpenRouter's documented
 * headless mode: the page shows the code for the owner to copy, which is the
 * fallback that works no matter what a callback URL is allowed to be.
 */
export async function beginAuth({ callbackUrl = null } = {}) {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const url = new URL(AUTH_URL);
  url.searchParams.set("code_challenge", base64url(new Uint8Array(digest)));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("key_label", "Ghost");
  if (callbackUrl !== null) url.searchParams.set("callback_url", callbackUrl);
  return { url: url.toString(), verifier };
}

/** The `code` OpenRouter puts on the callback URL, or null if it is not there. */
export function codeFromCallback(redirect) {
  try {
    const code = new URL(redirect).searchParams.get("code");
    return typeof code === "string" && code !== "" ? code : null;
  } catch {
    return null;
  }
}

/**
 * OpenRouter's own words for a failure, never ours. A provider message is the
 * only honest thing to show for "you are out of credit" or "that model is
 * gone"; inventing a friendlier sentence would be inventing a diagnosis.
 */
export function describeError(status, body) {
  const message = typeof body?.error?.message === "string" && body.error.message !== ""
    ? body.error.message
    : typeof body?.error === "string" && body.error !== ""
      ? body.error
      : "";
  if (message !== "") return `OpenRouter: ${message}`;
  return `OpenRouter answered ${status} and said nothing else.`;
}

async function readBody(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export class OpenRouterError extends Error {
  constructor(status, body) {
    super(describeError(status, body));
    this.name = "OpenRouterError";
    this.status = status;
  }
}

/** Trade the authorization code for this browser's key. */
export async function exchangeCode({ code, verifier, signal }) {
  const response = await fetch(KEYS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
    signal,
  });
  const body = await readBody(response);
  if (!response.ok) throw new OpenRouterError(response.status, body);
  const key = body?.key;
  if (typeof key !== "string" || key === "") {
    throw new Error("OpenRouter returned no key for that code. Codes are single-use and expire in ten minutes.");
  }
  return key;
}

/**
 * The catalog, narrowed to what this agent can actually drive: a model with no
 * tool calling cannot click anything, so listing it would only produce a turn
 * that ends in an apology.
 */
export async function listModels({ signal } = {}) {
  const response = await fetch(MODELS_URL, { signal });
  const body = await readBody(response);
  if (!response.ok) throw new OpenRouterError(response.status, body);
  const rows = Array.isArray(body?.data) ? body.data : [];
  const models = rows
    .filter((row) => Array.isArray(row?.supported_parameters)
      && row.supported_parameters.includes("tools")
      && typeof row.id === "string")
    .map((row) => ({
      id: row.id,
      name: typeof row.name === "string" && row.name !== "" ? row.name : row.id,
      free: row.pricing?.prompt === "0" && row.pricing?.completion === "0",
    }));
  // Free first, then by name: the default path is the one that costs nothing,
  // so it should also be the one at the top of the list.
  models.sort((left, right) =>
    (Number(right.free) - Number(left.free)) || left.name.localeCompare(right.name));
  return models;
}

/** `data:` lines of an SSE body, with the keep-alive comments dropped. */
async function* sseEvents(response, signal) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("OpenRouter returned no response body to stream.");
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") return;
          try {
            yield JSON.parse(data);
          } catch {
            // A truncated frame is a lost token, not a failed turn.
          }
        }
        newline = buffer.indexOf("\n");
      }
    }
  } finally {
    // Abort leaves the socket open otherwise, and the side panel may start the
    // next turn immediately.
    if (signal?.aborted) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function mergeToolCall(calls, delta) {
  const index = Number.isInteger(delta.index) ? delta.index : calls.length;
  const existing = calls[index] ?? { id: "", type: "function", function: { name: "", arguments: "" } };
  calls[index] = {
    id: delta.id ?? existing.id,
    type: "function",
    function: {
      name: delta.function?.name ?? existing.function.name,
      arguments: existing.function.arguments + (delta.function?.arguments ?? ""),
    },
  };
}

/**
 * One assistant turn, streamed.
 *
 * Returns what the assistant said, the tool calls it asked for, the model that
 * actually answered (the free router names its pick here), and the usage row.
 * OpenRouter's API reference marks `stream_options.include_usage` deprecated
 * because full usage, `cost` included, is always in the final chunk; nothing
 * needs opting into.
 *
 * A model error that arrives mid-stream is thrown, never swallowed: a turn that
 * quietly stops is indistinguishable from a hang.
 */
export async function streamChat({ key, model, messages, tools, signal, onDelta }) {
  const response = await fetch(COMPLETIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...ATTRIBUTION,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      ...(tools && tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
    }),
    signal,
  });
  if (!response.ok) throw new OpenRouterError(response.status, await readBody(response));

  let content = "";
  const toolCalls = [];
  let answered = model;
  let usage = null;
  for await (const chunk of sseEvents(response, signal)) {
    if (chunk?.error) throw new OpenRouterError(chunk.error.code ?? 502, chunk);
    if (typeof chunk?.model === "string" && chunk.model !== "") answered = chunk.model;
    if (chunk?.usage) usage = chunk.usage;
    const choice = chunk?.choices?.[0];
    if (!choice) continue;
    const text = choice.delta?.content;
    if (typeof text === "string" && text !== "") {
      content += text;
      onDelta?.(text);
    }
    for (const delta of choice.delta?.tool_calls ?? []) mergeToolCall(toolCalls, delta);
  }
  return {
    content,
    toolCalls: toolCalls.filter(Boolean).filter((call) => call.function.name !== ""),
    model: answered,
    usage,
  };
}
