import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "node:test";

import {
  callScript,
  FIND_ELEMENTS_SCRIPT,
  MAX_FIND_RESULTS,
  MAX_FIND_SCAN_ELEMENTS,
  unsupportedFindSyntax,
} from "../extension/page-scripts.js";

class FakeElement {
  constructor(tag, text, { attributes = {}, children = [], selectors = [], value } = {}) {
    this.tagName = tag.toUpperCase();
    this._text = text;
    this.attributes = attributes;
    this.children = children;
    this.disabled = false;
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

function runFind(elements, query, limit) {
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
  const result = vm.runInNewContext(
    callScript(FIND_ELEMENTS_SCRIPT, { query, limit }),
    { document, window },
  );
  return { result, walkerCreations };
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
    Array.from(result, ({ ref, tag, text, name }) => ({ ref, tag, text, name })),
    [
      { ref: "e1", tag: "button", text: "Needle action", name: undefined },
      { ref: "e2", tag: "input", text: "", name: "Needle field" },
      { ref: "e3", tag: "span", text: "Needle child", name: undefined },
      { ref: "e4", tag: "p", text: "Needle copy", name: undefined },
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
