/**
 * The local turn loop, with stubbed network and fake tabs.
 *
 * Everything pinned here is something a plausible future edit would break
 * silently: the script-confirmation gate (a turn that runs page JavaScript
 * without asking looks exactly like one that asked), the per-turn call ceiling
 * and result clipping (an unbounded loop only shows up on a bill), and the rule
 * that a stopped turn stops rather than finishing quietly in the background.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_TOOL_CALLS_PER_TURN,
  MAX_TOOL_RESULT_CHARS,
  MAX_RETAINED_IMAGES,
  pruneImages,
  renderToolResult,
  runTurn,
  TurnStopped,
} from "../agent.js";
import { CONFIRM_OPS, TOOL_OPS, toolDefinitions } from "../tools.js";
import { OPS } from "../protocol.js";

/** A chat stub that plays a fixed script of assistant answers. */
function scriptedChat(answers) {
  const seen = [];
  let index = 0;
  return {
    seen,
    chat: async ({ messages, tools, onDelta }) => {
      seen.push({ messages: structuredClone(messages), tools });
      const answer = answers[Math.min(index, answers.length - 1)];
      index += 1;
      if (answer.content) onDelta?.(answer.content);
      return {
        content: answer.content ?? "",
        toolCalls: answer.toolCalls ?? [],
        model: answer.model ?? "test/model",
        usage: answer.usage ?? { total_tokens: 3, cost: 0 },
        finishReason: answer.toolCalls?.length ? "tool_calls" : "stop",
      };
    },
  };
}

function call(id, name, args) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

const never = async () => { throw new Error("must not be reached"); };
const allow = async () => true;
const deny = async () => false;

test("every op the model may call is a relay op; close and upload are withheld", () => {
  for (const op of TOOL_OPS) assert.ok(OPS.includes(op), `${op} is a relay op`);
  assert.ok(!TOOL_OPS.includes("close"), "workspace teardown belongs to the owner, not the model");
  assert.ok(!TOOL_OPS.includes("upload"), "the one op that reads the owner's disk is not the model's");
  assert.deepEqual(TOOL_OPS, OPS.filter((op) => op !== "close" && op !== "upload"));
  const definitions = toolDefinitions();
  assert.deepEqual(definitions.map((tool) => tool.function.name), TOOL_OPS);
  for (const tool of definitions) {
    assert.ok(!("session" in tool.function.parameters.properties),
      `${tool.function.name} must not let the model choose a workspace`);
  }
});

test("page script runs only after the owner allows it, every time", async () => {
  assert.deepEqual([...CONFIRM_OPS], ["javascript"]);
  const asked = [];
  const ran = [];
  const { chat } = scriptedChat([
    { toolCalls: [call("a", "javascript", { tab: "17", code: "document.title" })] },
    { toolCalls: [call("b", "javascript", { tab: "17", code: "location.href" })] },
    { content: "done" },
  ]);
  const messages = [];
  await runTurn({
    messages,
    model: "test/model",
    tools: [],
    chat,
    runTool: async (name, args) => {
      ran.push([name, args.code]);
      return { value: "ok" };
    },
    confirm: async ({ name, args }) => {
      asked.push([name, args.code]);
      // The first is allowed, the second refused: a single yes is not a policy.
      return asked.length === 1;
    },
  });

  assert.deepEqual(asked, [["javascript", "document.title"], ["javascript", "location.href"]]);
  assert.deepEqual(ran, [["javascript", "document.title"]]);
  const refusal = messages.find((message) =>
    message.role === "tool" && message.tool_call_id === "b");
  assert.match(refusal.content, /owner declined to run javascript/);
});

test("a refused tool call is reported to the model rather than thrown away", async () => {
  const { chat } = scriptedChat([
    { toolCalls: [call("a", "read", { tab: "99" })] },
    { content: "I cannot reach that tab." },
  ]);
  const messages = [];
  await runTurn({
    messages,
    model: "test/model",
    tools: [],
    chat,
    runTool: async () => {
      throw new Error("Tab 99 belongs to a ghost's browser workspace, not this browser's local chat.");
    },
    confirm: never,
  });
  const result = messages.find((message) => message.role === "tool");
  assert.match(result.content, /belongs to a ghost's browser workspace/);
});

test("a long tool result is clipped before it can be re-sent on every later step", () => {
  const long = "x".repeat(MAX_TOOL_RESULT_CHARS * 3);
  const rendered = renderToolResult({ text: long });
  assert.ok(rendered.length < long.length / 2);
  assert.match(rendered, /\[truncated: \d+ more characters\]$/);
  assert.equal(renderToolResult({ ok: true }), '{"ok":true}');
});

test("a screenshot travels as its own image message, and old ones are dropped", async () => {
  const shots = MAX_RETAINED_IMAGES + 2;
  const answers = Array.from({ length: shots }, (_value, index) =>
    ({ toolCalls: [call(`s${index}`, "screenshot", { tab: "17" })] }));
  answers.push({ content: "seen" });
  const { chat } = scriptedChat(answers);
  const messages = [];
  await runTurn({
    messages,
    model: "test/model",
    tools: [],
    chat,
    runTool: async () => ({ page: { url: "https://example.com/" }, png: "QUJD" }),
    confirm: never,
  });

  const images = messages.filter((message) => Array.isArray(message.content));
  assert.equal(images.length, MAX_RETAINED_IMAGES);
  // The bytes never enter a tool result, where they would also blow its budget.
  for (const message of messages.filter((entry) => entry.role === "tool")) {
    assert.ok(!message.content.includes("QUJD"));
    assert.match(message.content, /"screenshot":"attached below"/);
  }
});

test("pruneImages keeps the newest and leaves everything else untouched", () => {
  const image = () => ({ role: "user", content: [{ type: "image_url", image_url: { url: "data:," } }] });
  const messages = [{ role: "user", content: "hi" }, image(), image(), image()];
  pruneImages(messages, 1);
  assert.equal(messages[0].content, "hi");
  assert.equal(typeof messages[1].content, "string");
  assert.equal(typeof messages[2].content, "string");
  assert.ok(Array.isArray(messages[3].content));
});

test("a turn stops calling tools at its ceiling and answers without them", async () => {
  let asks = 0;
  const lastTools = [];
  const chat = async ({ tools }) => {
    asks += 1;
    lastTools.push(tools.length);
    return {
      content: tools.length === 0 ? "I ran out of steps." : "",
      toolCalls: tools.length === 0 ? [] : [call(`c${asks}`, "read", { tab: "17" })],
      model: "test/model",
      usage: { total_tokens: 1, cost: 0 },
    };
  };
  const outcome = await runTurn({
    messages: [],
    model: "test/model",
    tools: toolDefinitions(),
    chat,
    runTool: async () => ({ text: "page" }),
    confirm: never,
  });
  assert.equal(outcome.calls, MAX_TOOL_CALLS_PER_TURN);
  assert.equal(lastTools.at(-1), 0, "the last ask offers no tools at all");
});

test("stop ends the turn between tool calls rather than after them", async () => {
  const controller = new AbortController();
  const ran = [];
  const { chat } = scriptedChat([
    { toolCalls: [call("a", "read", { tab: "17" }), call("b", "read", { tab: "17" })] },
  ]);
  await assert.rejects(
    runTurn({
      messages: [],
      model: "test/model",
      tools: [],
      chat,
      runTool: async (name) => {
        ran.push(name);
        controller.abort();
        return { text: "page" };
      },
      confirm: never,
        signal: controller.signal,
    }),
    (error) => error instanceof TurnStopped,
  );
  assert.deepEqual(ran, ["read"], "the second call of the same step must not run");
});

test("a router's first pick is pinned for the rest of the turn, never swapped silently", async () => {
  const asked = [];
  const chat = async ({ model }) => {
    asked.push(model);
    const first = asked.length === 1;
    return {
      content: first ? "" : "done",
      toolCalls: first ? [call("a", "read", { tab: "17" })] : [],
      model: "vendor/picked-model:free",
      usage: { total_tokens: 1, cost: 0 },
    };
  };
  const outcome = await runTurn({
    messages: [],
    model: "openrouter/free",
    tools: toolDefinitions(),
    chat,
    runTool: async () => ({ text: "page" }),
    confirm: never,
  });
  assert.deepEqual(asked, ["openrouter/free", "vendor/picked-model:free"]);
  assert.equal(outcome.model, "vendor/picked-model:free");
});

test("a model that sends unparseable arguments is told so instead of crashing the turn", async () => {
  const { chat } = scriptedChat([
    { toolCalls: [{ id: "a", type: "function", function: { name: "read", arguments: "{oops" } }] },
    { content: "sorry" },
  ]);
  const messages = [];
  await runTurn({
    messages,
    model: "test/model",
    tools: [],
    chat,
    runTool: never,
    confirm: never,
  });
  assert.match(messages.find((entry) => entry.role === "tool").content, /not valid JSON/);
});

test("the turn reports the model that actually answered and what it cost", async () => {
  const { chat } = scriptedChat([
    { content: "hello", model: "some/free-model", usage: { total_tokens: 12, cost: 0 } },
  ]);
  const outcome = await runTurn({
    messages: [],
    model: "openrouter/free",
    tools: [],
    chat,
    runTool: never,
    confirm: allow,
  });
  assert.equal(outcome.model, "some/free-model");
  assert.equal(outcome.usage.cost, 0);
});

test("a provider failure surfaces as itself, not as a stalled turn", async () => {
  const boom = Object.assign(new Error("OpenRouter: insufficient credits"), { status: 402 });
  await assert.rejects(
    runTurn({
      messages: [],
      model: "paid/model",
      tools: [],
      chat: async () => { throw boom; },
      runTool: never,
      confirm: deny,
      }),
    /insufficient credits/,
  );
});
