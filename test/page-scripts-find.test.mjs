import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import { test } from "node:test";

import {
  callScript,
  FIND_ELEMENTS_SCRIPT,
  FOCUS_AND_CLEAR_SCRIPT,
  MAX_FIND_RESULTS,
  MAX_FIND_SCAN_ELEMENTS,
  RESOLVE_NODE_SCRIPT,
  unsupportedFindSyntax,
} from "../page-scripts.js";

class FakeElement {
  constructor(tag, text, { attributes = {}, children = [], selectors = [], value } = {}) {
    this.tagName = tag.toUpperCase();
    this._text = text;
    this.attributes = attributes;
    this.children = children;
    this.disabled = false;
    this.readOnly = false;
    this.type = attributes.type ?? "text";
    this.isConnected = true;
    this.shadowRoot = null;
    this.selectors = new Set(selectors);
    this.textReads = 0;
    this.rectReads = 0;
    this.styleReads = 0;
    if (value !== undefined) this.value = value;
  }

  get innerText() {
    this.textReads += 1;
    return this._text;
  }

  get textContent() {
    return this._text;
  }

  set textContent(text) {
    this._text = text;
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  hasAttribute(name) {
    return Object.hasOwn(this.attributes, name);
  }

  matches(selector) {
    if (this.selectors.has(selector)) return true;
    return selector.toLowerCase() === this.tagName.toLowerCase();
  }

  getBoundingClientRect() {
    this.rectReads += 1;
    return { width: 100, height: 20 };
  }
}

function createPage(elements, url = "http://example.test/") {
  let walkerCreations = 0;
  const document = {
    documentElement: elements[0] ?? null,
    createTreeWalker(root) {
      walkerCreations += 1;
      const nodes = root === document ? elements : (root.elements ?? []);
      let index = 0;
      return {
        nextNode() {
          const node = nodes[index];
          index += 1;
          return node ?? null;
        },
      };
    },
    querySelectorAll() {
      throw new Error("find must not eagerly materialize a NodeList");
    },
  };
  const window = {
    getComputedStyle(element) {
      element.styleReads += 1;
      return { visibility: "visible", display: "block" };
    },
  };
  const context = vm.createContext({ document, window, crypto: webcrypto, location: { href: url } });
  return {
    find(query, limit) {
      const result = vm.runInContext(callScript(FIND_ELEMENTS_SCRIPT, { query, limit }), context);
      return { result, walkerCreations };
    },
    resolve(ref) {
      return vm.runInContext(callScript(RESOLVE_NODE_SCRIPT, { ref }), context);
    },
    context,
  };
}

function runFind(elements, query, limit) {
  return createPage(elements).find(query, limit);
}

test("text find keeps ordering and reads layout-backed text once per element", () => {
  const child = new FakeElement("span", "Needle child");
  const parent = new FakeElement("div", "Needle parent and child", { children: [child] });
  const copy = new FakeElement("p", "Needle copy");
  const action = new FakeElement("button", "Needle action");
  const field = new FakeElement("input", "", {
    attributes: { placeholder: "Needle field" },
    value: "",
  });
  const elements = [parent, child, copy, action, field];

  const { result, walkerCreations } = runFind(elements, "needle", 20);

  assert.equal(walkerCreations, 1);
  assert.deepEqual(
    Array.from(result, ({ tag, text, name }) => ({ tag, text, name })),
    [
      { tag: "button", text: "Needle action", name: undefined },
      { tag: "input", text: "", name: "Needle field" },
      { tag: "span", text: "Needle child", name: undefined },
      { tag: "p", text: "Needle copy", name: undefined },
    ],
  );
  assert.equal(parent.rectReads, 0, "a non-result must not pay geometry/style layout cost");
  for (const element of elements) {
    assert.equal(element.textReads, 1, `${element.tagName} text should be read once`);
  }
  for (const element of [child, copy, action, field]) {
    assert.equal(element.rectReads, 1);
    assert.equal(element.styleReads, 1);
  }
});

test("selector and text paths enforce result and scan caps", () => {
  const selectorElements = Array.from(
    { length: MAX_FIND_RESULTS + 25 },
    (_, index) => new FakeElement("button", `Button ${index}`),
  );
  const selectorRun = runFind(selectorElements, "button", 50_000);

  assert.equal(selectorRun.result.length, MAX_FIND_RESULTS);
  assert.equal(selectorRun.walkerCreations, 1);
  assert.equal(selectorElements[MAX_FIND_RESULTS - 1].textReads, 1);
  assert.equal(selectorElements[MAX_FIND_RESULTS].textReads, 0);

  const textElements = Array.from(
    { length: MAX_FIND_SCAN_ELEMENTS + 20 },
    (_, index) => new FakeElement("p", `needle ${index}`),
  );
  const textRun = runFind(textElements, "needle", 50_000);

  assert.equal(textRun.result.length, MAX_FIND_RESULTS);
  assert.equal(textElements[MAX_FIND_SCAN_ELEMENTS - 1].textReads, 1);
  assert.equal(textElements[MAX_FIND_SCAN_ELEMENTS].textReads, 0);
});

test("scope-sensitive syntax is rejected while quoted selector values remain opaque", () => {
  for (const query of [
    ":scope",
    ":scope > body",
    ":/**/scope",
    String.raw`:sc\6f pe`,
    "&",
    "& > body",
    ":is(&)",
  ]) {
    assert.notEqual(unsupportedFindSyntax(query), null, query);
  }
  const quoted = `[data-label=":scope"]`;
  const quotedEscape = String.raw`[data-label="sc\6f pe"]`;
  const quotedAmpersand = `[data-label="&"]`;
  assert.equal(unsupportedFindSyntax(quoted), null);
  assert.equal(unsupportedFindSyntax(quotedEscape), null);
  assert.equal(unsupportedFindSyntax(quotedAmpersand), null);

  const html = new FakeElement("html", "Page");
  const field = new FakeElement("input", "", {
    selectors: [quoted, quotedEscape, quotedAmpersand],
  });
  assert.deepEqual(
    Array.from(runFind([html, field], quoted, 10).result, (match) => match.tag),
    ["input"],
  );
  assert.deepEqual(
    Array.from(runFind([html, field], quotedEscape, 10).result, (match) => match.tag),
    ["input"],
  );
  assert.deepEqual(
    Array.from(runFind([html, field], quotedAmpersand, 10).result, (match) => match.tag),
    ["input"],
  );
});

test("shadow traversal keeps recursive order and shares one visit budget", () => {
  const html = new FakeElement("html", "");
  const host = new FakeElement("section", "");
  const shadowMatches = Array.from(
    { length: MAX_FIND_SCAN_ELEMENTS - 2 },
    (_, index) => new FakeElement("p", `needle shadow ${index}`),
  );
  host.shadowRoot = { elements: shadowMatches };
  const afterHost = new FakeElement("p", "needle after host");

  const { result, walkerCreations } = runFind([html, host, afterHost], "needle", 2);

  assert.equal(walkerCreations, 2);
  assert.deepEqual(
    Array.from(result, (match) => match.text),
    ["needle shadow 0", "needle shadow 1"],
  );
  assert.equal(shadowMatches.at(-1).textReads, 1);
  assert.equal(afterHost.textReads, 0, "the document walker must share the shadow visit budget");
});


test("successive and empty finds preserve unique refs for the original elements", () => {
  const button = new FakeElement("button", "Save");
  const field = new FakeElement("input", "", { value: "" });
  const link = new FakeElement("a", "Help");
  const page = createPage([button, field, link]);
  const first = page.find("button", 20).result;
  assert.match(first[0].ref, /^e[0-9a-f]{32}:1$/);
  const second = page.find("input", 20).result;
  assert.match(second[0].ref, /^e[0-9a-f]{32}:2$/);
  assert.notEqual(first[0].ref, second[0].ref);
  assert.equal(page.find("missing text", 20).result.length, 0);
  assert.equal(page.resolve(first[0].ref), button);
  assert.equal(page.resolve(second[0].ref), field);
  assert.equal(page.find("button", 20).result[0].ref, first[0].ref);
  const third = page.find("a", 20).result[0].ref;
  assert.match(third, /^e[0-9a-f]{32}:3$/);
  assert.equal(page.resolve(third), link);
  assert.equal(page.resolve("e999"), null);
  const registry = vm.runInContext("globalThis.__ghostRegistry", page.context);
  assert.equal(registry.byRef.get(first[0].ref).el.deref(), button);
  assert.equal(Object.hasOwn(button, "__ghostRef"), false);
});

test("an existing registry preserves legacy refs and namespaces new refs after code reload", () => {
  const button = new FakeElement("button", "Save");
  const field = new FakeElement("input", "");
  const page = createPage([button, field]);
  page.context.legacyElement = button;
  vm.runInContext(`globalThis.__ghostRegistry = {
    v: 1,
    byEl: new WeakMap([[legacyElement, "e1"]]),
    byRef: new Map([["e1", { el: new WeakRef(legacyElement), tag: "button" }]]),
  }`, page.context);
  const ref = page.find("input", 20).result[0].ref;
  assert.match(ref, /^e[0-9a-f]{32}:1$/);
  assert.equal(page.resolve("e1"), button);
  assert.equal(page.resolve(ref), field);
  assert.equal(page.find("button", 20).result[0].ref, "e1");
});

test("a same-URL reload cannot resolve an earlier document's ref to its new element", () => {
  const url = "http://example.test/same-page";
  const before = new FakeElement("button", "Save");
  const after = new FakeElement("button", "Delete");
  const firstPage = createPage([before], url);
  const secondPage = createPage([after], url);
  const oldRef = firstPage.find("button", 20).result[0].ref;
  const newRef = secondPage.find("button", 20).result[0].ref;
  assert.notEqual(oldRef, newRef);
  assert.equal(firstPage.resolve(oldRef), before);
  assert.equal(secondPage.resolve(oldRef), null);
  assert.equal(secondPage.resolve(newRef), after);
});


test("detached refs are stale before focus, including contenteditable fields", () => {
  const editor = new FakeElement("div", "Draft", { attributes: { contenteditable: "true" } });
  editor.isContentEditable = true;
  editor.focus = () => { throw new Error("detached contenteditable must never be focused"); };
  const upload = new FakeElement("input", "", { attributes: { type: "file" } });
  const page = createPage([editor, upload]);
  const editorRef = page.find("div", 20).result[0].ref;
  const uploadRef = page.find("input", 20).result[0].ref;
  assert.equal(page.resolve(editorRef), editor);
  assert.equal(page.resolve(uploadRef), upload);

  editor.isConnected = false;
  upload.isConnected = false;
  assert.equal(page.resolve(editorRef), null);
  assert.equal(page.resolve(uploadRef), null);
  const focused = vm.runInContext(callScript(FOCUS_AND_CLEAR_SCRIPT, { ref: editorRef }), page.context);
  assert.equal(focused.found, false);
  assert.equal(focused.reason, "stale-ref");
  assert.equal(editor.textContent, "Draft");
});


test("contenteditable must own focus itself before clearing its descendants", () => {
  const editor = new FakeElement("div", "Draft");
  editor.value = "component metadata";
  editor.isContentEditable = true;
  editor.focus = () => {};
  const root = { activeElement: new FakeElement("input", "Unrelated") };
  editor.getRootNode = () => root;
  const descendant = new FakeElement("span", "Draft child");
  editor.contains = (element) => element === descendant;
  let events = 0;
  editor.dispatchEvent = () => { events += 1; };
  const page = createPage([editor]);
  page.context.Event = class { constructor(type) { this.type = type; } };
  const ref = page.find("div", 20).result[0].ref;
  const failed = vm.runInContext(callScript(FOCUS_AND_CLEAR_SCRIPT, { ref }), page.context);
  assert.equal(failed.found, true);
  assert.equal(failed.editable, false);
  assert.equal(failed.reason, "not-focusable");
  assert.equal(editor.textContent, "Draft");
  assert.equal(events, 0);

  root.activeElement = descendant;
  const descendantFocused = vm.runInContext(callScript(FOCUS_AND_CLEAR_SCRIPT, { ref }), page.context);
  assert.equal(descendantFocused.editable, false);
  assert.equal(descendantFocused.reason, "not-focusable");
  assert.equal(editor.textContent, "Draft");
  assert.equal(events, 0);

  root.activeElement = editor;
  const succeeded = vm.runInContext(callScript(FOCUS_AND_CLEAR_SCRIPT, { ref }), page.context);
  assert.equal(succeeded.editable, true);
  assert.equal(editor.textContent, "");
  assert.equal(events, 1);
  assert.equal(editor.value, "component metadata");
});


test("clearing a field must not authorize typing after an input handler redirects focus", () => {
  const editor = new FakeElement("div", "Draft");
  editor.isContentEditable = true;
  editor.focus = () => {};
  const root = { activeElement: editor };
  editor.getRootNode = () => root;
  editor.dispatchEvent = () => { root.activeElement = new FakeElement("input", "Unrelated"); };
  const page = createPage([editor]);
  page.context.Event = class { constructor(type) { this.type = type; } };
  const ref = page.find("div", 20).result[0].ref;
  const result = vm.runInContext(callScript(FOCUS_AND_CLEAR_SCRIPT, { ref }), page.context);
  assert.equal(editor.textContent, "");
  assert.equal(result.editable, false);
  assert.equal(result.reason, "not-focusable");
});


for (const tag of ["input", "textarea"]) {
  test(`readonly ${tag} is rejected before focus or clearing`, () => {
    const field = new FakeElement(tag, "", { value: "Keep this" });
    field.readOnly = true;
    field.focus = () => { throw new Error("readonly field must not be focused"); };
    field.dispatchEvent = () => { throw new Error("readonly field must not dispatch input"); };
    const page = createPage([field]);
    const ref = page.find(tag, 20).result[0].ref;
    const result = vm.runInContext(callScript(FOCUS_AND_CLEAR_SCRIPT, { ref }), page.context);
    assert.equal(result.editable, false);
    assert.equal(result.reason, "readonly");
    assert.equal(field.value, "Keep this");
  });
}

for (const type of ["checkbox", "radio", "button", "submit", "reset", "file", "hidden", "image", "color", "range", "date", "datetime-local", "month", "time", "week"]) {
  test(`non-text input type ${type} is rejected without invoking its setter`, () => {
    const field = new FakeElement("input", "", { attributes: { type } });
    Object.defineProperty(field, "value", {
      get: () => "Keep this",
      set: () => { throw new Error("non-text value setter must never be called"); },
    });
    field.focus = () => { throw new Error("non-text input must not be focused"); };
    const page = createPage([field]);
    const ref = page.find("input", 20).result[0].ref;
    const result = vm.runInContext(callScript(FOCUS_AND_CLEAR_SCRIPT, { ref }), page.context);
    assert.equal(result.editable, false);
    assert.equal(result.reason, "not-a-field");
    assert.equal(field.value, "Keep this");
  });
}

test("disabled text field is rejected before clearing", () => {
  const field = new FakeElement("input", "", { value: "Keep this" });
  field.disabled = true;
  field.focus = () => { throw new Error("disabled field must not be focused"); };
  const page = createPage([field]);
  const ref = page.find("input", 20).result[0].ref;
  const result = vm.runInContext(callScript(FOCUS_AND_CLEAR_SCRIPT, { ref }), page.context);
  assert.equal(result.editable, false);
  assert.equal(result.reason, "disabled");
  assert.equal(field.value, "Keep this");
});


for (const phase of ["focus", "input"]) {
  for (const [property, value, reason] of [
    ["readOnly", true, "readonly"],
    ["disabled", true, "disabled"],
    ["type", "file", "not-a-field"],
  ]) {
    test(`${property} changed by ${phase} handler is revalidated before further mutation`, () => {
      const field = new FakeElement("input", "", { value: "Keep this" });
      const root = { activeElement: field };
      field.getRootNode = () => root;
      field.focus = () => { if (phase === "focus") field[property] = value; };
      let events = 0;
      field.dispatchEvent = () => {
        events += 1;
        if (phase === "input") field[property] = value;
      };
      const page = createPage([field]);
      let setters = 0;
      class NativeInput {}
      Object.defineProperty(NativeInput.prototype, "value", {
        set(value) { setters += 1; this.value = value; },
      });
      page.context.HTMLInputElement = NativeInput;
      page.context.Event = class { constructor(type) { this.type = type; } };
      const ref = page.find("input", 20).result[0].ref;
      const result = vm.runInContext(callScript(FOCUS_AND_CLEAR_SCRIPT, { ref }), page.context);
      assert.equal(result.editable, false);
      assert.equal(result.reason, reason);
      assert.equal(setters, phase === "focus" ? 0 : 1);
      assert.equal(events, phase === "focus" ? 0 : 1);
      assert.equal(field.value, phase === "focus" ? "Keep this" : "");
    });
  }
}
