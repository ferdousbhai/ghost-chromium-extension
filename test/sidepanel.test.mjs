/**
 * The side panel document, against a fake DOM and a stubbed OpenRouter.
 *
 * `agent.js` pins the loop's rules; this pins the surface that carries them —
 * that an unconnected panel offers no composer, that a turn's tool calls and
 * cost are visible rather than silent, and that the script card is a real gate
 * whose buttons decide whether the page op runs at all.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";

const originals = {
  chrome: globalThis.chrome,
  document: globalThis.document,
  fetch: globalThis.fetch,
  window: globalThis.window,
};

afterEach(() => {
  for (const [field, value] of Object.entries(originals)) {
    if (value === undefined) delete globalThis[field];
    else globalThis[field] = value;
  }
});

class FakeNode {
  constructor(tag = "div", id = "") {
    this.tag = tag;
    this.id = id;
    this.className = "";
    this.textContent = "";
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.children = [];
    this.parent = null;
    this.listeners = new Map();
    this.style = {};
    this.scrollHeight = 0;
    this.popoverOpen = false;
  }

  addEventListener(event, listener) {
    this.listeners.set(event, listener);
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node instanceof FakeNode) node.parent = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  remove() {
    const siblings = this.parent?.children;
    if (siblings) siblings.splice(siblings.indexOf(this), 1);
    this.parent = null;
  }

  get lastElementChild() {
    return this.children.at(-1) ?? null;
  }

  querySelector(selector) {
    const wanted = selector.replace(".", "");
    for (const child of this.children) {
      if (!(child instanceof FakeNode)) continue;
      if (child.className.split(" ").includes(wanted)) return child;
      const deeper = child.querySelector(selector);
      if (deeper) return deeper;
    }
    return null;
  }

  get classList() {
    const names = () => this.className.split(" ").filter(Boolean);
    return {
      add: (name) => { if (!names().includes(name)) this.className = [...names(), name].join(" "); },
      remove: (name) => { this.className = names().filter((entry) => entry !== name).join(" "); },
      toggle: (name, on) => { this.className = [...names().filter((entry) => entry !== name), ...(on ? [name] : [])].join(" "); },
      contains: (name) => names().includes(name),
    };
  }

  /** One `.class` or tag selector, up the parent chain. */
  closest(selector) {
    for (let node = this; node; node = node.parent) {
      if (selector.startsWith(".") ? node.classList.contains(selector.slice(1)) : node.tag === selector) return node;
    }
    return null;
  }

  focus() {}

  scrollIntoView() {}

  /** The native popover, as `popovertarget` drives it. */
  showPopover() {
    this.listeners.get("beforetoggle")?.({ newState: "open" });
    this.popoverOpen = true;
    this.listeners.get("toggle")?.({ newState: "open" });
  }

  hidePopover() {
    this.popoverOpen = false;
  }

  matches(selector) {
    return selector === ":popover-open" && this.popoverOpen;
  }

  click() {
    this.listeners.get("click")?.({});
  }

  get text() {
    return `${this.textContent}${this.children.map((child) => child.text ?? child.textContent ?? "").join("")}`;
  }
}

/**
 * Every element the markup gives an id, and whether it ships `hidden`, so the
 * fake has what the panel looks up and starts where the real panel does.
 */
const PANEL_ELEMENTS = [...readFileSync(new URL("../sidepanel.html", import.meta.url), "utf8")
  .matchAll(/<[^>]*\bid="([^"]+)"([^>]*)>/g)]
  .map(([tag, id]) => [id, /\shidden[\s>/]/.test(tag)]);

function panelDocument() {
  const elements = Object.fromEntries(PANEL_ELEMENTS.map(([id, hidden]) => {
    const node = new FakeNode("div", id);
    node.hidden = hidden;
    return [id, node];
  }));
  const listeners = new Map();
  return {
    elements,
    activeElement: null,
    getElementById: (id) => elements[id],
    querySelector: (selector) => Object.values(elements).find((node) => node.matches(selector)) ?? null,
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (text) => ({ textContent: text, text }),
    addEventListener: (event, listener) => listeners.set(event, listener),
  };
}

function storageArea(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    get: async (defaults) => {
      const out = { ...defaults };
      for (const field of Object.keys(defaults)) {
        if (store.has(field)) out[field] = store.get(field);
      }
      return out;
    },
    set: async (value) => {
      for (const [field, entry] of Object.entries(value)) store.set(field, entry);
    },
    remove: async (field) => { store.delete(field); },
  };
}

function sseBody(lines) {
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(new TextEncoder().encode(`${line}\n`));
      controller.close();
    },
  });
}

function setUp({ key = "sk-or-test", ops = async () => ({ ok: true, result: {} }), enabled = true } = {}) {
  const document = panelDocument();
  const local = storageArea({ ...(key === null ? {} : { openRouterKey: key }), enabled });
  const sent = [];
  const storageListeners = [];
  globalThis.document = document;
  globalThis.window = { addEventListener: () => {} };
  globalThis.chrome = {
    identity: {
      getRedirectURL: () => "https://abc.chromiumapp.org/",
      launchWebAuthFlow: async () => "https://abc.chromiumapp.org/?code=granted",
    },
    runtime: {
      sendMessage: async (message) => {
        sent.push(message);
        if (message.type === "ghost-relay-local-close") return { ok: true };
        if (message.type === "ghost-relay-status") {
          return { connected: false, paired: false, pairingCode: "246810", pairingDenied: false,
            token: "", enabled, port: 7717, lastError: "", tabs: [] };
        }
        if (message.type === "ghost-relay-settings-update") {
          local.store.set("enabled", message.settings.enabled ?? enabled);
          return { ok: true, settings: { port: 7717, token: "", ...message.settings } };
        }
        return ops(message);
      },
    },
    storage: {
      local,
      session: storageArea(),
      onChanged: { addListener: (listener) => storageListeners.push(listener) },
    },
    tabs: { create: async () => ({ id: 1 }) },
  };
  return { document, local, sent, storageListeners };
}

const load = (label) => import(`../sidepanel.js?${label}=${Date.now()}-${Math.random()}`);

/**
 * Tick until `check` holds: a test waits for the state it asserts on, never
 * for a guessed number of hops, so an extra `await` in the panel is not a
 * failure. Returns what `check` found; throws if the state never arrives.
 */
async function until(check, what = String(check), times = 500) {
  for (let turn = 0; turn < times; turn += 1) {
    const got = check();
    if (got) return got;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`never happened: ${what}`);
}

/** Clicking Send shows Stop at once; Stop hides again when the turn is over. */
const turnEnds = (document) => until(() => document.elements.stop.hidden, "the turn ends");

async function settle(times = 6) {
  for (let turn = 0; turn < times; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("an unconnected panel offers a way to connect and no way to chat", async () => {
  const { document } = setUp({ key: null });
  globalThis.fetch = async () => { throw new Error("must not call OpenRouter before connecting"); };
  await load("unconnected");
  await settle();

  assert.equal(document.elements.connect.hidden, false);
  assert.equal(document.elements.composerBar.hidden, true);
  assert.equal(document.elements.log.hidden, true);
  assert.equal(document.elements.toolbar.hidden, true);
  // Only OAuth: one click, or OAuth's own paste-the-code mode. No key box.
  assert.equal(document.elements.manual.placeholder ?? "Paste the code", "Paste the code");
});

test("the model picker groups the catalog, filters it, and remembers the choice", async () => {
  const { document, local } = setUp();
  const tools = ["tools"];
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [
      { id: "openrouter/free", name: "Free router", supported_parameters: tools,
        pricing: { prompt: "0", completion: "0" } },
      { id: "qwen/qwen3-coder:free", name: "Qwen: Qwen3 Coder (free)", supported_parameters: tools,
        pricing: { prompt: "0", completion: "0" } },
      { id: "anthropic/claude-sonnet-5", name: "Anthropic: Claude Sonnet 5", supported_parameters: tools,
        pricing: { prompt: "0.000003", completion: "0.000015" } },
    ] }),
  });
  await load("picker");
  await settle();
  const { modelName, modelMenu, modelSearch, modelList } = document.elements;

  assert.equal(modelName.textContent, "Free router");
  modelMenu.showPopover(); // what the button's popovertarget does

  const shown = (name) => modelList.children.filter((node) => !node.hidden && node.classList.contains(name));
  const groups = () => shown("group").map((node) => node.textContent);
  const options = () => shown("option");
  assert.deepEqual(groups(), ["Free", "Paid"]);
  assert.deepEqual(options().map((node) => node.children[0].textContent), ["Free router", "Qwen3 Coder", "Claude Sonnet 5"]);
  assert.match(options()[0].className, /selected/);

  modelSearch.value = "sonnet";
  modelSearch.listeners.get("input")();
  assert.deepEqual(groups(), ["Paid"]);
  modelSearch.listeners.get("keydown")({ key: "Enter", preventDefault() {} });

  assert.equal(modelMenu.matches(":popover-open"), false);
  assert.equal(modelName.textContent, "Claude Sonnet 5");
  assert.equal(local.store.get("openRouterModel"), "anthropic/claude-sonnet-5");
});

test("a turn shows the tool calls it made, and what the answer cost", async () => {
  const calls = [];
  const { document, sent } = setUp({
    ops: async (message) => {
      calls.push([message.op, message.args]);
      return { ok: true, result: { page: { url: "https://example.com/" }, id: "17" } };
    },
  });
  let step = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/models")) {
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    step += 1;
    return {
      ok: true,
      status: 200,
      body: step === 1
        ? sseBody([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"open","arguments":"{\\"url\\":\\"https://example.com/\\"}"}}]}}]}',
          "data: [DONE]",
        ])
        : sseBody([
          'data: {"model":"some/free-model","choices":[{"delta":{"content":"Opened it."}}]}',
          'data: {"usage":{"total_tokens":20,"cost":0}}',
          "data: [DONE]",
        ]),
      json: async () => ({}),
    };
  };

  await load("turn");
  await settle();
  document.elements.input.value = "open example.com";
  document.elements.send.listeners.get("click")();
  await turnEnds(document);

  assert.deepEqual(calls, [["open", { url: "https://example.com/" }]]);
  const shown = document.elements.log.children.map((node) => node.text);
  assert.ok(shown.some((line) => line.includes("open example.com")), "the ask is in the log");
  assert.ok(shown.some((line) => line.includes("→ open")), "the tool call is visible");
  assert.ok(shown.some((line) => line.includes("Opened it.")), "the answer is visible");
  assert.ok(shown.some((line) => line.includes("some/free-model") && line.includes("free")),
    "the model that answered and its cost are visible");
  assert.equal(document.elements.log.children.at(-1).text, "some/free-model · 20 tokens · free");
  // The panel names its conversation, never a workspace; the worker maps one
  // to the other and stamps it.
  for (const message of sent.filter((entry) => entry.type === "ghost-relay-local-op")) {
    assert.equal(message.args.session, undefined);
    assert.match(message.conversation, /^[0-9a-f-]{36}$/);
  }
});

test("page script runs only when the owner presses the card's allow button", async () => {
  for (const [label, button, expected] of [["allow", 0, 1], ["deny", 1, 0]]) {
    const runs = [];
    const { document } = setUp({
      ops: async (message) => {
        runs.push(message.op);
        return { ok: true, result: { value: "Example" } };
      },
    });
    let step = 0;
    globalThis.fetch = async (url) => {
      if (String(url).includes("/models")) {
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      }
      step += 1;
      return {
        ok: true,
        status: 200,
        body: step === 1
          ? sseBody([
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"javascript","arguments":"{\\"tab\\":\\"17\\",\\"code\\":\\"document.title\\"}"}}]}}]}',
            "data: [DONE]",
          ])
          : sseBody(['data: {"choices":[{"delta":{"content":"ok"}}]}', "data: [DONE]"]),
        json: async () => ({}),
      };
    };

    await load(`confirm-${label}`);
    await settle();
    document.elements.input.value = "read the title with script";
    document.elements.send.listeners.get("click")();
    const card = await until(() => document.elements.log.children.find((node) => node.className === "confirm"),
      `${label}: the card is shown before anything runs`);
    assert.deepEqual(runs, [], `${label}: nothing ran while the card was open`);
    assert.ok(card.text.includes("document.title"), `${label}: the card shows the exact code`);

    card.querySelector(".row").children[button].click();
    await turnEnds(document);
    assert.deepEqual(runs, expected === 1 ? ["javascript"] : [],
      `${label}: the button decided whether the op ran`);
  }
});

/** A fetch that streams nothing and ends only when its signal is aborted. */
function hangingFetch() {
  let started = 0;
  let aborted = 0;
  const fetch = async (url, options) => {
    if (String(url).includes("/models")) {
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    started += 1;
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          options.signal.addEventListener("abort", () => {
            aborted += 1;
            controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        },
      }),
      json: async () => ({}),
    };
  };
  return { fetch, started: () => started, count: () => aborted };
}

test("pause arriving from the menu switch stops the turn in flight", async () => {
  const { document, storageListeners } = setUp();
  const hanging = hangingFetch();
  globalThis.fetch = hanging.fetch;

  await load("paused");
  await settle();
  document.elements.input.value = "do something slow";
  document.elements.send.listeners.get("click")();
  await until(() => hanging.started() === 1, "the request is in flight");
  assert.equal(document.elements.stop.hidden, false, "a turn is in flight");
  assert.equal(hanging.count(), 0);

  storageListeners[0]({ enabled: { newValue: false } }, "local");
  await turnEnds(document);

  assert.equal(hanging.count(), 1, "the in-flight request was aborted by the pause");
  assert.equal(document.elements.paused.hidden, false);
  assert.ok(document.elements.log.children.some((node) => node.text.includes("Resume Ghost from the menu")));
});

test("Stop aborts the request and says it is stopping until the turn ends", async () => {
  const { document } = setUp();
  const hanging = hangingFetch();
  globalThis.fetch = hanging.fetch;

  await load("stop");
  await settle();
  document.elements.input.value = "do something slow";
  document.elements.send.listeners.get("click")();
  await until(() => hanging.started() === 1, "the request is in flight");

  document.elements.stop.listeners.get("click")();
  assert.equal(document.elements.stop.textContent, "Stopping…");
  assert.equal(document.elements.stop.disabled, true);
  await turnEnds(document);
  assert.equal(hanging.count(), 1);
});

test("persisted history is cut at turn boundaries and keeps the system prompt", async () => {
  setUp();
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) });
  const { trimTurns } = await load("trim");
  const history = [
    { role: "system", content: "rules" },
    { role: "user", content: "one" },
    { role: "assistant", content: "", tool_calls: [{ id: "a" }] },
    { role: "tool", tool_call_id: "a", content: "r" },
    { role: "assistant", content: "done one" },
    { role: "user", content: "two" },
    { role: "assistant", content: "done two" },
  ];
  const isUser = (message) => message.role === "user" && typeof message.content === "string";
  const kept = trimTurns(history, isUser, (entries) => entries.length <= 4);
  assert.deepEqual(kept.map((message) => `${message.role}:${message.content}`), [
    "system:rules", "user:two", "assistant:done two",
  ]);
  // A cut that would strand a tool result never happens: the whole turn goes.
  assert.ok(!kept.some((message) => message.role === "tool"));
  assert.deepEqual(trimTurns(history, isUser, () => true), history);
});

test("a one-click failure reveals the manual path instead of pointing at a closed drawer", async () => {
  const { document } = setUp({ key: null });
  chrome.identity.launchWebAuthFlow = async () => "https://abc.chromiumapp.org/?error=denied";
  globalThis.fetch = async () => { throw new Error("must not be reached"); };
  await load("oauth-failure");
  await settle();

  document.elements.oauth.listeners.get("click")();
  await until(() => !document.elements.connectError.hidden, "the connect error shows");
  assert.equal(document.elements.codePath.hidden, false);
  assert.equal(document.elements.oauth.disabled, true, "the failed button is not offered again");
});

test("conversations are separate: new chat, history, delete closes that chat's tabs", async () => {
  const { document, sent, local } = setUp();
  globalThis.fetch = async (url) => {
    if (String(url).includes("/models")) {
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    }
    return {
      ok: true,
      status: 200,
      body: sseBody(['data: {"choices":[{"delta":{"content":"hi"}}]}', 'data: {"usage":{"total_tokens":1,"cost":0}}', "data: [DONE]"]),
      json: async () => ({}),
    };
  };
  await load("conversations");
  await settle();

  document.elements.input.value = "first";
  document.elements.send.listeners.get("click")();
  const titles = () => local.store.get("localChats")?.chats.map((chat) => chat.title).join();
  await until(() => titles() === "first", "the first conversation is saved with its title");

  document.elements.newChat.listeners.get("click")();
  await settle();
  assert.equal(document.elements.empty.hidden, false, "a new conversation starts empty");
  document.elements.input.value = "second";
  document.elements.send.listeners.get("click")();
  await until(() => titles() === "second,first", "the second conversation is saved with its title");
  const both = local.store.get("localChats");

  document.elements.history.listeners.get("click")();
  await settle();
  assert.equal(document.elements.historyList.hidden, false);
  const rows = document.elements.historyList.children.filter((node) => node.tag === "button");
  assert.deepEqual(rows.map((row) => row.text), ["secondnow", "firstnow"]);
  rows[1].click();
  await settle();
  assert.equal(document.elements.historyList.hidden, true);
  assert.ok(document.elements.log.children.some((node) => node.text.includes("first")));

  document.elements.deleteChat.listeners.get("click")();
  await until(() => sent.some((message) => message.type === "ghost-relay-local-close"), "the workspace is closed");
  const closes = sent.filter((message) => message.type === "ghost-relay-local-close");
  assert.equal(closes.length, 1);
  assert.equal(closes[0].conversation, both.chats[1].id, "the deleted conversation's workspace is retired");
  assert.deepEqual(local.store.get("localChats").chats.map((chat) => chat.title), ["second"]);
});

test("disconnect forgets the key and puts the connect panel back", async () => {
  const { document, local } = setUp();
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) });
  await load("disconnect");
  await settle();
  assert.equal(document.elements.connect.hidden, true);

  document.elements.disconnect.listeners.get("click")();
  await settle();

  assert.equal(local.store.has("openRouterKey"), false);
  assert.equal(document.elements.connect.hidden, false);
  assert.equal(document.elements.composerBar.hidden, true);
});

test("the menu pauses Ghost, and the pairing screen shows the code the HUD shows", async () => {
  const { document, sent } = setUp();
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) });
  await load("menu");
  await settle();

  assert.equal(document.elements.pauseToggle.textContent, "Pause Ghost");
  document.elements.pauseToggle.listeners.get("click")();
  await settle();
  const update = sent.find((message) => message.type === "ghost-relay-settings-update");
  assert.deepEqual(update.settings, { enabled: false }, "pause is the same switch the ghost obeys");

  document.elements.ghostMachine.listeners.get("click")();
  await settle();
  assert.equal(document.elements.ghostView.hidden, false);
  assert.equal(document.elements.composerBar.hidden, true);
  assert.equal(document.elements.statusText.textContent, "Not paired");
  assert.equal(document.elements.pairCode.textContent, "246 810");
  assert.equal(document.elements.pair.hidden, false);

  document.elements.ghostBack.listeners.get("click")();
  await settle();
  assert.equal(document.elements.ghostView.hidden, true);
  assert.equal(document.elements.composerBar.hidden, false);
});
