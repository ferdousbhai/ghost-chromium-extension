/**
 * The OpenRouter client, with `fetch` stubbed.
 *
 * The properties worth pinning are the ones that decide whether a failure is
 * honest: an insufficient-credit answer must arrive as OpenRouter's own
 * sentence rather than a guess of ours, an error that appears mid-stream must
 * be thrown rather than ending the turn silently, and PKCE's secret half must
 * never leave the browser.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  beginAuth,
  codeFromCallback,
  DEFAULT_MODEL,
  describeError,
  exchangeCode,
  listModels,
  OpenRouterError,
  OPENROUTER_ORIGIN,
  streamChat,
} from "../extension/openrouter.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function sseResponse(lines, { status = 200 } = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(new TextEncoder().encode(`${line}\n`));
      controller.close();
    },
  });
  return { ok: status < 400, status, body, json: async () => ({}) };
}

function jsonResponse(value, status = 200) {
  return { ok: status < 400, status, json: async () => value };
}

test("the authorize URL carries only the hashed half of the PKCE secret", async () => {
  const { url, verifier } = await beginAuth({ callbackUrl: "https://abc.chromiumapp.org/" });
  const parsed = new URL(url);
  assert.equal(parsed.origin, OPENROUTER_ORIGIN);
  assert.equal(parsed.pathname, "/auth");
  assert.equal(parsed.searchParams.get("code_challenge_method"), "S256");
  assert.equal(parsed.searchParams.get("callback_url"), "https://abc.chromiumapp.org/");
  const challenge = parsed.searchParams.get("code_challenge");
  assert.match(challenge, /^[A-Za-z0-9_-]+$/, "base64url, no padding to break the query");
  assert.notEqual(challenge, verifier);
  assert.ok(!url.includes(verifier), "the verifier must never appear in the URL");
});

test("the manual path omits the callback, which is what shows the code on screen", async () => {
  const { url } = await beginAuth();
  assert.equal(new URL(url).searchParams.get("callback_url"), null);
  assert.ok(new URL(url).searchParams.get("code_challenge"));
});

test("the code is read off the callback, and a callback without one is not a code", () => {
  assert.equal(codeFromCallback("https://abc.chromiumapp.org/?code=xyz"), "xyz");
  assert.equal(codeFromCallback("https://abc.chromiumapp.org/?error=denied"), null);
  assert.equal(codeFromCallback(""), null);
});

test("an insufficient-credit answer is OpenRouter's sentence, not ours", () => {
  const message = describeError(402, {
    error: { code: 402, message: "Insufficient credits. Add more at openrouter.ai/credits." },
  });
  assert.equal(message, "OpenRouter: Insufficient credits. Add more at openrouter.ai/credits.");
  // When the provider says nothing at all, the message says exactly that rather
  // than guessing a diagnosis from the status code.
  assert.equal(describeError(402, null), "OpenRouter answered 402 and said nothing else.");
});

test("a 402 on a paid model rejects with that message and no partial stream", async () => {
  globalThis.fetch = async () => jsonResponse(
    { error: { code: 402, message: "This request requires more credits." } },
    402,
  );
  await assert.rejects(
    streamChat({ key: "sk-test", model: "paid/model", messages: [], tools: [] }),
    (error) => {
      assert.ok(error instanceof OpenRouterError);
      assert.equal(error.status, 402);
      assert.equal(error.message, "OpenRouter: This request requires more credits.");
      return true;
    },
  );
});

test("a stream is assembled into text, tool calls, the answering model, and usage", async () => {
  let request = null;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return sseResponse([
      ": OPENROUTER PROCESSING",
      'data: {"model":"some/free-model","choices":[{"delta":{"content":"Look"}}]}',
      'data: {"choices":[{"delta":{"content":"ing."}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"open","arguments":"{\\"url\\":"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"https://e.com/\\"}"}}]}}]}',
      'data: {"usage":{"total_tokens":42,"cost":0},"choices":[{"finish_reason":"tool_calls","delta":{}}]}',
      "data: [DONE]",
    ]);
  };
  const deltas = [];
  const answer = await streamChat({
    key: "sk-test",
    model: DEFAULT_MODEL,
    messages: [{ role: "user", content: "go" }],
    tools: [{ type: "function", function: { name: "open" } }],
    onDelta: (text) => deltas.push(text),
  });

  assert.equal(answer.content, "Looking.");
  assert.equal(answer.model, "some/free-model", "the free router names the model it picked");
  assert.deepEqual(answer.usage, { total_tokens: 42, cost: 0 });
  assert.deepEqual(deltas, ["Look", "ing."]);
  assert.deepEqual(answer.toolCalls, [{
    id: "t1",
    type: "function",
    function: { name: "open", arguments: '{"url":"https://e.com/"}' },
  }]);

  assert.equal(request.url, `${OPENROUTER_ORIGIN}/api/v1/chat/completions`);
  assert.equal(request.options.headers.Authorization, "Bearer sk-test");
  const body = JSON.parse(request.options.body);
  assert.equal(body.stream, true);
  assert.equal(body.tool_choice, "auto");
});

test("an error that arrives mid-stream is thrown, never left looking like an end", async () => {
  globalThis.fetch = async () => sseResponse([
    'data: {"choices":[{"delta":{"content":"partial"}}]}',
    'data: {"error":{"code":429,"message":"Rate limit exceeded: free-models-per-day"}}',
  ]);
  await assert.rejects(
    streamChat({ key: "sk-test", model: DEFAULT_MODEL, messages: [], tools: [] }),
    /Rate limit exceeded: free-models-per-day/,
  );
});

test("the model list keeps only what can drive a tab, free ones first", async () => {
  globalThis.fetch = async () => jsonResponse({
    data: [
      { id: "z/paid", name: "Z Paid", pricing: { prompt: "0.001", completion: "0.002" }, supported_parameters: ["tools"] },
      { id: "a/free", name: "A Free", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] },
      { id: "n/no-tools", name: "No Tools", pricing: { prompt: "0", completion: "0" }, supported_parameters: [] },
    ],
  });
  const models = await listModels();
  assert.deepEqual(models.map((entry) => entry.id), ["a/free", "z/paid"]);
  assert.deepEqual(models.map((entry) => entry.free), [true, false]);
});

test("a spent authorization code fails with a sentence that says why", async () => {
  globalThis.fetch = async () => jsonResponse({}, 200);
  await assert.rejects(
    exchangeCode({ code: "used", verifier: "v" }),
    /single-use and expire in ten minutes/,
  );
});

test("the default model is the free router, so the default path costs nothing", () => {
  assert.equal(DEFAULT_MODEL, "openrouter/free");
});
