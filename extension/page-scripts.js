/**
 * The code that runs *inside* the owner's pages.
 *
 * Strings, evaluated through CDP `Runtime.evaluate`, for the same reason the
 * relay keeps its snippets as strings: they are the one part of the
 * system with a DOM in scope, and quarantining them in a named file beats smearing
 * `document` through modules that have no business with it.
 *
 * **These snippets run in a per-frame *isolated world*, not the page's main
 * world.** `ops.js` creates one with `Page.createIsolatedWorld` and evaluates
 * every snippet against its `executionContextId`. That is a separate JavaScript
 * realm sharing the same DOM: `document.querySelectorAll`, `elementFromPoint`,
 * `getBoundingClientRect`, `getComputedStyle`, the `HTMLInputElement.prototype`
 * value setter — all resolve to the browser's native implementations, which the
 * page cannot override for us. A hostile page can no longer redefine those to
 * spoof the hit-test or feed a forged `location`/`title` to the model. The whole
 * safety of the actionability probe depends on this isolation.
 *
 * **Refs live in a `WeakMap` inside that isolated world, not on the elements.**
 * Earlier this file stamped `element.__ghostRef = "e3"`, a property the page
 * could both read and *write* — so a page could stamp `__ghostRef="e1"` on a
 * decoy and steal the next click. The ref table is now `globalThis.__ghostRegistry`
 * in the isolated world (`byEl`: element → ref, `byRef`: ref → weak element +
 * descriptor). The page's realm has no handle to that global, so it cannot forge,
 * read, or overwrite a ref. Nothing is written onto the owner's elements at all,
 * so there is also nothing for a CSS selector, a `MutationObserver`, or a
 * framework vdom to trip over. The technique is Playwright's `_ariaRef`, by way of
 * oh-my-pi, hardened into the isolated world.
 *
 * Resolution goes straight through `byRef` (a `WeakRef`), then verifies the node
 * is still the exact one `find` minted the ref for and still the tag it described,
 * before anyone acts on it. That rejects a collected, different, or tag-changed
 * node; it cannot detect a page semantically changing the same surviving same-tag
 * element, which remains ordinary live-DOM behavior.
 *
 * Every snippet walks open shadow roots. Half the web's buttons live in one.
 */

export function callScript(script, arg) {
  return `(${script})(${arg === undefined ? "" : JSON.stringify(arg)})`;
}

const WALK = `
  const ghostWalk = (visit, maxVisits = Number.POSITIVE_INFINITY) => {
    // TreeWalker advances one node at a time, so the visit budget is enforced
    // before the browser materializes an unbounded NodeList. Keep a walker stack
    // so an open shadow root is visited immediately after its host, matching the
    // old recursive querySelectorAll order.
    const walkers = [{ root: document, walker: document.createTreeWalker(document, 1) }];
    let visits = 0;
    while (walkers.length > 0 && visits < maxVisits) {
      const current = walkers[walkers.length - 1];
      const el = current.walker.nextNode();
      if (!el) {
        walkers.pop();
        continue;
      }
      visits += 1;
      if (visit(el, current.root === document) === false) break;
      if (el.shadowRoot) {
        walkers.push({
          root: el.shadowRoot,
          walker: document.createTreeWalker(el.shadowRoot, 1),
        });
      }
    }
    return visits;
  };
`;

const DESCRIBE = `
  const ghostDescribe = (el, ref, cachedText) => {
    let visible = false;
    try {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      visible = rect.width > 0 && rect.height > 0
        && style.visibility !== "hidden" && style.display !== "none";
    } catch {}
    const rawText = cachedText === undefined
      ? (el.innerText || el.textContent || "")
      : cachedText;
    const text = rawText.replace(/\\s+/g, " ").trim();
    const attr = (name) => el.getAttribute(name) || undefined;
    return {
      ref,
      tag: el.tagName.toLowerCase(),
      role: attr("role"),
      name: attr("aria-label") || attr("placeholder") || attr("name") || attr("title"),
      href: attr("href"),
      value: typeof el.value === "string" ? el.value.slice(0, 120) : undefined,
      text: text.slice(0, 160),
      visible,
      disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
    };
  };
`;

/** Relay-side caps: the daemon is paired, but it is still a separate trust boundary. */
export const DEFAULT_FIND_RESULTS = 20;
export const MAX_FIND_RESULTS = 100;
export const MAX_FIND_SCAN_ELEMENTS = 10_000;

/**
 * Syntax that cannot safely cross the document-querySelectorAll → bounded
 * Element.matches boundary. Quotes are opaque, so attribute values containing
 * these characters keep working; comments and escapes outside them are CSS-token
 * transformations and would require a complete CSS parser to classify safely.
 */
export function unsupportedFindSyntax(query) {
  let quote = "";
  for (let index = 0; index < query.length; index += 1) {
    const char = query[index];
    if (quote !== "") {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "\\") return "CSS escapes outside quoted strings";
    if (char === "/" && query[index + 1] === "*") return "CSS comments";
    if (char === "&") return "the CSS nesting selector &, which aliases document scope";
    const pseudo = query.slice(index, index + 6);
    const next = query[index + 6] || "";
    if (pseudo.toLowerCase() === ":scope" && !/[a-z0-9_-]/i.test(next)) {
      return "the document-scoped :scope pseudo-class";
    }
  }
  return null;
}

/**
 * The ref table, living on the isolated world's own global. The page's realm
 * cannot reach `globalThis` here, so it can neither read a ref nor forge one.
 * `byEl` maps element → ref (so `find` never mints two refs for one node);
 * `byRef` maps ref → { weak element, descriptor } for O(1), verified resolution.
 */
const REGISTRY = `
  const ghostRegistry = () => {
    let reg = globalThis.__ghostRegistry;
    if (!reg || reg.v !== 1) {
      reg = { v: 1, byEl: new WeakMap(), byRef: new Map() };
      globalThis.__ghostRegistry = reg;
    }
    return reg;
  };
  const ghostResolveRef = (ref) => {
    const reg = ghostRegistry();
    const entry = reg.byRef.get(ref);
    if (!entry) return null;
    const el = entry.el.deref();
    // The node must still be alive, still carry this exact ref, and still be the
    // tag find described. A page cannot forge an entry here — the table is in
    // this isolated world. A collected, different, or tag-changed node is stale;
    // the same surviving same-tag node remains live even if its meaning changed.
    if (!el || reg.byEl.get(el) !== ref) return null;
    if (el.tagName.toLowerCase() !== entry.tag) return null;
    return el;
  };
`;

/**
 * Readable text for the current page, untruncated — the session layer owns the
 * budget, and it must be the same budget for both backends. Byte-for-byte the
 * container preference `read` has always used, so it returns the same
 * shape of thing whichever browser the ghost is driving.
 */
export const READ_PAGE_SCRIPT = `() => {
  const pick = document.querySelector("article")
    || document.querySelector("main")
    || document.querySelector("[role=main]")
    || document.body;
  const raw = pick ? (pick.innerText || pick.textContent || "") : "";
  const text = raw
    .replace(/[ \\t\\u00a0]+/g, " ")
    .replace(/\\n{3,}/g, "\\n\\n")
    .trim();
  return { title: document.title || "", url: location.href, text };
}`;

/**
 * Find elements by CSS selector, or — when the query is not a selector that matches
 * anything — by visible text and accessible attributes. Same two-pass strategy and
 * same "deepest text match only" rule the session layer's refs assume, so `e1` means the
 * same thing to the model in either mode.
 */
export const FIND_ELEMENTS_SCRIPT = `({ query, limit }) => {
  ${WALK}
  ${DESCRIBE}
  ${REGISTRY}
  // Each find is the new truth: replace the whole table so a ref the last find
  // minted can never resolve again. It lives in this isolated world, so the page
  // cannot pre-seed a ref to steal a later click.
  const reg = ghostRegistry();
  reg.byEl = new WeakMap();
  reg.byRef = new Map();

  const resultLimit = Math.min(
    ${MAX_FIND_RESULTS},
    Math.max(1, Number.isInteger(limit) ? limit : ${DEFAULT_FIND_RESULTS}),
  );
  const results = [];
  const seen = new Set();
  const describe = (el, cachedText) => {
    if (!el || seen.has(el) || results.length >= resultLimit) return;
    seen.add(el);
    const ref = "e" + (results.length + 1);
    const described = ghostDescribe(el, ref, cachedText);
    reg.byEl.set(el, ref);
    reg.byRef.set(ref, { el: new WeakRef(el), tag: described.tag, text: described.text });
    results.push(described);
  };

  let selectorValid = false;
  try {
    // Element.matches validates without allocating a page-sized NodeList.
    document.documentElement.matches(query);
    selectorValid = true;
  } catch {}

  const elements = [];
  const selectorHits = [];
  ghostWalk((el, inDocument) => {
    elements.push(el);
    // querySelectorAll on document did not cross shadow boundaries; retain that
    // selector behavior while the text fallback continues to search open roots.
    if (selectorValid && inDocument && el.matches(query)) {
      selectorHits.push(el);
      if (selectorHits.length >= resultLimit) return false;
    }
  }, ${MAX_FIND_SCAN_ELEMENTS});

  if (selectorHits.length > 0) {
    for (const el of selectorHits) describe(el);
  } else {
    const needle = query.toLowerCase();
    const interactive = (el) =>
      /^(a|button|input|textarea|select|summary|label|option)$/.test(el.tagName.toLowerCase())
      || el.hasAttribute("role") || el.hasAttribute("onclick");
    const records = [];
    const byElement = new Map();
    for (const el of elements) {
      // innerText can force layout. Read it exactly once per scanned element,
      // then reuse it for deepest-match filtering and the returned descriptor.
      const text = el.innerText || el.textContent || "";
      const haystack = [
        el.getAttribute("aria-label"), el.getAttribute("placeholder"),
        el.getAttribute("title"), el.getAttribute("name"),
        typeof el.value === "string" ? el.value : null,
      ].filter(Boolean).join(" ").toLowerCase();
      const record = { el, text, lowerText: text.toLowerCase(), haystack };
      records.push(record);
      byElement.set(el, record);
    }

    const hits = [];
    const hitElements = new Set();
    const addHit = (record) => {
      if (hitElements.has(record.el)) return;
      hitElements.add(record.el);
      hits.push(record);
    };

    // Keep the old ordering exactly: deepest text hits in document order first,
    // attribute hits second, then stable-sort interactive elements ahead of the
    // rest. Deduplicating before the sort is equivalent because interactivity is
    // an element property, and keeps the candidate list bounded by the scan cap.
    for (const record of records) {
      if (!record.lowerText.includes(needle)) continue;
      let childMatches = false;
      for (const child of record.el.children) {
        const childText = byElement.get(child)?.lowerText;
        if (childText?.includes(needle)) {
          childMatches = true;
          break;
        }
      }
      if (!childMatches) addHit(record);
    }
    for (const record of records) {
      if (record.haystack !== "" && record.haystack.includes(needle)) addHit(record);
    }

    hits.sort((left, right) => Number(interactive(right.el)) - Number(interactive(left.el)));
    for (const record of hits) {
      describe(record.el, record.text);
      if (results.length >= resultLimit) break;
    }
  }

  return results;
}`;

/**
 * Resolve a ref or selector to a viewport point that a real mouse event can land
 * on, and say precisely why not when there isn't one.
 *
 * The hit test is the part that earns its keep. Dispatching a trusted click at an
 * element's centre is only correct if that centre is *actually* the element —
 * `elementFromPoint` catches the cookie banner, the sticky header, and the
 * transparent overlay that would otherwise swallow the click and leave the ghost
 * insisting it pressed the button. The rect is clipped to the viewport first, so a
 * half-scrolled element still yields a usable point, and a `contains` in either
 * direction is accepted, which is what makes `<button><svg>` and label-wraps-input
 * work. Ported from oh-my-pi's `isClickActionable`.
 */
export const RESOLVE_SCRIPT = `({ ref, selector, clickable }) => {
  ${WALK}
  ${REGISTRY}
  let el = null;
  if (ref) {
    el = ghostResolveRef(ref);
    if (!el) return { found: false, reason: "stale-ref" };
  } else {
    try { el = document.querySelector(selector); } catch { return { found: false, reason: "bad-selector" }; }
    if (!el) {
      ghostWalk((node) => {
        if (el || !node.shadowRoot) return;
        try { el = node.shadowRoot.querySelector(selector); } catch {}
      });
    }
    if (!el) return { found: false, reason: "no-match" };
  }

  // The nearest thing that is actually clickable: a text node's parent span is a
  // match, but it is not the button the model meant.
  if (clickable) {
    const target = el.closest
      && el.closest('a,button,[role="button"],[role="link"],input,textarea,select,summary,label,[onclick]');
    if (target) el = target;
  }

  // One instant scroll, not scrollIntoViewIfNeeded: an IntersectionObserver-based
  // wait can hang forever on a page that never stops animating.
  try { el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" }); } catch {}

  const tag = el.tagName.toLowerCase();
  const style = window.getComputedStyle(el);
  if (style.display === "none") return { found: true, actionable: false, reason: "display:none", tag };
  if (style.visibility === "hidden") return { found: true, actionable: false, reason: "visibility:hidden", tag };
  if (style.pointerEvents === "none") return { found: true, actionable: false, reason: "pointer-events:none", tag };
  if (Number(style.opacity) === 0) return { found: true, actionable: false, reason: "opacity:0", tag };

  const rect = el.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return { found: true, actionable: false, reason: "zero-size", tag };
  const left = Math.max(0, Math.min(window.innerWidth, rect.left));
  const right = Math.max(0, Math.min(window.innerWidth, rect.right));
  const top = Math.max(0, Math.min(window.innerHeight, rect.top));
  const bottom = Math.max(0, Math.min(window.innerHeight, rect.bottom));
  if (right - left < 1 || bottom - top < 1) {
    return { found: true, actionable: false, reason: "off-viewport", tag };
  }
  const x = Math.floor((left + right) / 2);
  const y = Math.floor((top + bottom) / 2);
  if (clickable) {
    const topEl = document.elementFromPoint(x, y);
    if (!topEl) return { found: true, actionable: false, reason: "nothing-at-point", tag };
    const hit = topEl === el || el.contains(topEl) || topEl.contains(el);
    if (!hit) {
      const blocker = topEl.tagName.toLowerCase()
        + (topEl.id ? "#" + topEl.id : "")
        + (topEl.className && typeof topEl.className === "string"
          ? "." + topEl.className.trim().split(/\\s+/).slice(0, 2).join(".") : "");
      return { found: true, actionable: false, reason: "obscured by " + blocker, tag };
    }
  }
  return { found: true, actionable: true, x, y, tag };
}`;

/**
 * Focus a field and empty it, the way a framework will believe.
 *
 * `el.value = ""` fires no event, so a controlled React/Vue input snaps straight
 * back to its old value on the next render. Going through the prototype's native
 * setter and dispatching `input` is the shape those frameworks listen for.
 */
export const FOCUS_AND_CLEAR_SCRIPT = `({ ref, selector }) => {
  ${WALK}
  ${REGISTRY}
  let el = null;
  if (ref) {
    el = ghostResolveRef(ref);
  } else {
    try { el = document.querySelector(selector); } catch { return { found: false, reason: "bad-selector" }; }
    if (!el) {
      ghostWalk((node) => {
        if (el || !node.shadowRoot) return;
        try { el = node.shadowRoot.querySelector(selector); } catch {}
      });
    }
  }
  if (!el) return { found: false, reason: ref ? "stale-ref" : "no-match" };

  const tag = el.tagName.toLowerCase();
  if (tag === "select") {
    return { found: true, editable: false, reason: "select", tag };
  }
  try { el.focus({ preventScroll: false }); } catch {}
  if (document.activeElement !== el && !el.isContentEditable) {
    return { found: true, editable: false, reason: "not-focusable", tag };
  }

  if (typeof el.value === "string") {
    const proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, "");
    else el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } else if (el.isContentEditable) {
    el.textContent = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    return { found: true, editable: false, reason: "not-a-field", tag };
  }
  return { found: true, editable: true, tag };
}`;

/**
 * Resolve a ref or selector to *the element itself*, so a caller evaluating this
 * with `returnByValue: false` gets a CDP `objectId` for the node — which is what
 * `DOM.setFileInputFiles` needs to set files on a file input. Returns `null` when
 * nothing matches; the caller turns that into a stale-ref / not-found failure.
 *
 * Same isolated-world resolution as the other snippets: a ref goes through the
 * hardened registry (so the page cannot forge one), a selector is tried against
 * the document and every open shadow root.
 */
export const RESOLVE_NODE_SCRIPT = `({ ref, selector }) => {
  ${WALK}
  ${REGISTRY}
  if (ref) return ghostResolveRef(ref);
  let el = null;
  try { el = document.querySelector(selector); } catch { return null; }
  if (!el) {
    ghostWalk((node) => {
      if (el || !node.shadowRoot) return;
      try { el = node.shadowRoot.querySelector(selector); } catch {}
    });
  }
  return el;
}`;
