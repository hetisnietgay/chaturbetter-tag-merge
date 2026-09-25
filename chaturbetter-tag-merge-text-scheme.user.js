// ==UserScript==
// @name         Chaturbetter Same-Domain Tag Merge
// @namespace    chaturbetter-sdi
// @version      1.6.1
// @description  Query toggle next to .filter-search-toggle. AND/OR text is fetched as tags pages and merged.
// @author       you
// @updateURL    https://raw.githubusercontent.com/hetisnietgay/chaturbetter-tag-merge/main/chaturbetter-tag-merge-text-scheme.user.js
// @downloadURL  https://raw.githubusercontent.com/hetisnietgay/chaturbetter-tag-merge/main/chaturbetter-tag-merge-text-scheme.user.js
// @match        https://chaturbetter.com/*
// @match        https://www.chaturbetter.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root && root.document) api.boot();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /**
   * Chaturbetter no longer has an operator search. Tag pages are
   * AND-only, via the ?tags= parameter (comma = and). Excludes are ?extags=.
   *
   * The Query switch is inserted right after .filter-search-toggle.
   * Turn it on and the text box appears next to that button:
   *
   *   bigboobs AND (findom OR sph)
   *   blonde | redhead
   *   #blonde or #redhead -asian
   *
   * Operators: AND & &&   OR | ||   NOT -tag
   * # is optional. Parentheses group. Adjacent tags are AND.
   * Gender and sort already in the URL are kept on every fetch.
   *
   * Saved lines are optional. Each line is the same scheme, and it runs
   * when the page's tags are exactly one branch of it (then the other
   * branches are fetched). Nothing here is locked to one tag page.
   * WHERE key=value requires that param (f=yes is the female filter).
   */
  const SCHEME = `
# example, not active:
# bigboobs AND (findom OR sph) WHERE f=yes
`;

  const HUD_ID = "sdi-tag-merge-hud";
  const STYLE_ID = "sdi-tag-merge-style";
  const SOURCE_ATTR = "data-sdi-injected";
  const EXPR_PARAM = "expr";
  const STORE_KEY = "sdi-custom-search";
  const MODE_KEY = "sdi-query-mode";
  const QUERY_ID = "sdi-query";
  const RESULTS_PATHS = new Set(["/", "/cum", "/following"]);

  let observer = null;
  let running = false;
  let lastHref = "";
  /** @type {Map<string, { url: string, label: string, nodes: Map<string, Element> }>} */
  const cache = new Map();

  function parseTags(raw) {
    return String(raw || "")
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
  }

  function paramsMatch(search, required) {
    const sp = new URLSearchParams(search);
    for (const [k, v] of Object.entries(required || {})) {
      if ((sp.get(k) || "") !== String(v)) return false;
    }
    return true;
  }

  function stripComments(src) {
    return String(src || "")
      .split(/\r?\n/)
      .map((line) => line.replace(/#(?![a-z0-9_-]).*$/i, ""))
      .join("\n");
  }

  function tokenize(src) {
    const s = String(src || "");
    const out = [];
    let i = 0;
    const isTag = (c) => /[a-z0-9_-]/i.test(c || "");
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) {
        i += 1;
        continue;
      }
      if (c === "#") {
        i += 1;
        continue;
      }
      if (c === "(" || c === ")" || c === "," || c === "=") {
        out.push({ type: c });
        i += 1;
        continue;
      }
      if (c === "&") {
        if (s[i + 1] === "&") i += 1;
        out.push({ type: "AND" });
        i += 1;
        continue;
      }
      if (c === "|") {
        if (s[i + 1] === "|") i += 1;
        out.push({ type: "OR" });
        i += 1;
        continue;
      }
      if (c === "-" && !isTag(s[i - 1])) {
        out.push({ type: "NOT" });
        i += 1;
        continue;
      }
      if (isTag(c)) {
        let j = i + 1;
        while (j < s.length && isTag(s[j])) j += 1;
        const raw = s.slice(i, j);
        const up = raw.toUpperCase();
        if (up === "AND" || up === "OR" || up === "NOT" || up === "WHERE") out.push({ type: up });
        else out.push({ type: "TAG", value: raw.toLowerCase(), raw });
        i = j;
        continue;
      }
      throw new Error("bad scheme character " + JSON.stringify(c));
    }
    return out;
  }

  function parseSchemeTokens(tokens) {
    let p = 0;
    function peek() {
      return tokens[p] || { type: "EOF" };
    }
    function eat(type) {
      const t = peek();
      if (t.type !== type) throw new Error("expected " + type + ", got " + t.type);
      p += 1;
      return t;
    }
    function parseOr() {
      let node = parseAnd();
      while (peek().type === "OR") {
        eat("OR");
        node = { op: "OR", left: node, right: parseAnd() };
      }
      return node;
    }
    function parseAnd() {
      let node = parseUnary();
      while (true) {
        if (peek().type === "AND") {
          eat("AND");
          node = { op: "AND", left: node, right: parseUnary() };
          continue;
        }
        const t = peek().type;
        if (t === "TAG" || t === "NOT" || t === "(") {
          node = { op: "AND", left: node, right: parseUnary() };
          continue;
        }
        break;
      }
      return node;
    }
    function parseUnary() {
      if (peek().type === "NOT") {
        eat("NOT");
        const inner = parseUnary();
        if (!inner || inner.op !== "TAG") throw new Error("NOT only applies to a single tag");
        return { op: "NOT", value: inner.value };
      }
      return parseAtom();
    }
    function parseAtom() {
      const t = peek();
      if (t.type === "TAG") {
        eat("TAG");
        return { op: "TAG", value: t.value };
      }
      if (t.type === "(") {
        eat("(");
        const inner = parseOr();
        eat(")");
        return inner;
      }
      throw new Error("expected a tag or (, got " + t.type);
    }
    if (!tokens.length) throw new Error("empty scheme");
    const ast = parseOr();
    if (peek().type !== "EOF") throw new Error("trailing " + peek().type);
    return ast;
  }

  function parseScheme(src) {
    return parseSchemeTokens(tokenize(src));
  }

  function readParams(tokens, i) {
    const params = {};
    if (i >= tokens.length || tokens[i].type !== "TAG") throw new Error("WHERE needs key=value");
    while (i < tokens.length && tokens[i].type === "TAG") {
      const key = tokens[i].raw;
      i += 1;
      if (!tokens[i] || tokens[i].type !== "=") throw new Error("expected = after " + key);
      i += 1;
      if (!tokens[i] || tokens[i].type !== "TAG") throw new Error("expected value after " + key);
      params[key] = tokens[i].raw;
      i += 1;
      if (tokens[i] && tokens[i].type === ",") i += 1;
    }
    return { params, i };
  }

  function clausesOf(ast) {
    if (!ast) return [];
    if (ast.op === "TAG") return [{ include: [ast.value], exclude: [] }];
    if (ast.op === "NOT") return [{ include: [], exclude: [ast.value] }];
    if (ast.op === "OR") return clausesOf(ast.left).concat(clausesOf(ast.right));
    if (ast.op === "AND") {
      const out = [];
      for (const a of clausesOf(ast.left)) {
        for (const b of clausesOf(ast.right)) {
          const include = [...new Set(a.include.concat(b.include))].sort();
          const exclude = [...new Set(a.exclude.concat(b.exclude))].sort();
          for (const tag of include) {
            if (exclude.includes(tag)) throw new Error(tag + " is both required and excluded");
          }
          out.push({ include, exclude });
        }
      }
      return out;
    }
    return [];
  }

  function schemeClauses(src) {
    return clausesOf(parseScheme(src)).map((c) => ({
      include: [...c.include].sort(),
      exclude: [...c.exclude].sort(),
    }));
  }

  function sameClause(a, b) {
    return a.include.join("\0") === b.include.join("\0") && a.exclude.join("\0") === b.exclude.join("\0");
  }

  function covers(clause, tags, extags) {
    return clause.include.every((t) => tags.includes(t)) && clause.exclude.every((t) => extags.includes(t));
  }

  function parseWhereTail(src) {
    const tokens = tokenize(src);
    if (!tokens.length) return {};
    return readParams(tokens, 0).params;
  }

  function parseRuleLine(line) {
    const tokens = tokenize(line);
    const whereAt = tokens.findIndex((t) => t.type === "WHERE");
    const exprTokens = whereAt === -1 ? tokens : tokens.slice(0, whereAt);
    if (!exprTokens.length) throw new Error("missing tag expression");
    const ast = parseSchemeTokens(exprTokens);
    let params = {};
    if (whereAt !== -1) params = readParams(tokens, whereAt + 1).params;
    return { clauses: clausesOf(ast), params };
  }

  function parseSaved(src) {
    const rules = [];
    for (const raw of stripComments(src).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      rules.push(parseRuleLine(line));
    }
    return rules;
  }

  let SAVED = [];
  let SAVED_ERROR = "";
  try {
    SAVED = parseSaved(SCHEME);
  } catch (err) {
    SAVED_ERROR = err && err.message ? err.message : String(err);
  }

  function clauseLabel(c) {
    const inc = c.include.join(",") || "*";
    return c.exclude.length ? inc + " -" + c.exclude.join(" -") : inc;
  }

  function pageClause(url) {
    return {
      include: parseTags(url.searchParams.get("tags")).sort(),
      exclude: parseTags(url.searchParams.get("extags")).sort(),
    };
  }

  /**
   * What to fetch for this page.
   * expr= is a custom search: every AND-branch except the tags page
   * already on screen. If the URL isn't one of those branches, fetch
   * all of them and replace the list.
   * Saved schemes do the same when the current tags are exactly one branch.
   */
  function planFor(url) {
    const current = pageClause(url);
    const expr = url.searchParams.get(EXPR_PARAM);
    if (expr) {
      const clauses = schemeClauses(expr);
      const onBranch = clauses.some((c) => sameClause(c, current));
      return {
        replace: !onBranch,
        clauses: onBranch ? clauses.filter((c) => !sameClause(c, current)) : clauses,
      };
    }
    const clauses = [];
    for (const rule of SAVED) {
      if (!paramsMatch(url.search, rule.params)) continue;
      if (!rule.clauses.some((c) => sameClause(c, current))) continue;
      for (const c of rule.clauses) {
        if (!sameClause(c, current)) clauses.push({ ...c, params: rule.params });
      }
    }
    return { replace: false, clauses };
  }

  function clauseUrl(baseHref, clause) {
    const url = new URL(baseHref);
    if (!RESULTS_PATHS.has(url.pathname)) url.pathname = "/";
    if (clause.include.length) url.searchParams.set("tags", clause.include.join(","));
    else url.searchParams.delete("tags");
    if (clause.exclude.length) url.searchParams.set("extags", clause.exclude.join(","));
    else url.searchParams.delete("extags");
    for (const [k, v] of Object.entries(clause.params || {})) url.searchParams.set(k, String(v));
    url.searchParams.delete("offset");
    url.searchParams.delete("limit");
    url.searchParams.delete("search");
    url.searchParams.delete(EXPR_PARAM);
    url.hash = "";
    return url;
  }

  function findList(root) {
    if (!root || !root.querySelector) return null;
    const room = root.querySelector(".room_list_room");
    if (room && room.parentElement) return room.parentElement;
    const rows = root.querySelectorAll("div.row.g-2.pt-2");
    for (const row of rows) {
      if (/\brow-cols-/.test(row.className)) return row;
    }
    return null;
  }

  function itemKey(el) {
    if (!el || !el.querySelector) return "";
    const a =
      el.querySelector("a.room_username[href]") ||
      el.querySelector("a.thumb-box[href]") ||
      el.querySelector('a[href^="/c/"]');
    const href = a && a.getAttribute("href");
    if (!href) return "";
    const m = href.match(/\/c\/([^/?#]+)/i);
    return m ? decodeURIComponent(m[1]).toLowerCase() : "";
  }

  function listItems(list) {
    return Array.from(list.querySelectorAll(":scope > .room_list_room, :scope > .col"));
  }

  function keysInList(list) {
    /** @type {Map<string, Element[]>} */
    const map = new Map();
    for (const el of listItems(list)) {
      const k = itemKey(el);
      if (!k) continue;
      const arr = map.get(k);
      if (arr) arr.push(el);
      else map.set(k, [el]);
    }
    return map;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${HUD_ID} {
        position: fixed;
        z-index: 2147483646;
        right: 12px;
        bottom: 12px;
        max-width: min(420px, calc(100vw - 24px));
        padding: 8px 12px;
        border-radius: 999px;
        background: rgba(18, 16, 14, 0.92);
        color: #f3ece3;
        font: 12px/1.35 ui-sans-serif, system-ui, sans-serif;
        letter-spacing: 0.01em;
        box-shadow: 0 8px 24px rgba(0,0,0,.35);
        border: 1px solid rgba(224, 138, 60, 0.45);
        pointer-events: none;
      }
      #${HUD_ID}[data-state="error"] { border-color: rgba(220, 80, 60, 0.7); }
      #${QUERY_ID} {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-inline-start: 6px;
        vertical-align: middle;
      }
      #${QUERY_ID} .sdi-query-switch {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin: 0;
        padding: 4px 8px;
        border-radius: 999px;
        border: 1px solid rgba(224, 138, 60, 0.55);
        background: transparent;
        color: inherit;
        font: 12px/1 ui-sans-serif, system-ui, sans-serif;
        cursor: pointer;
        user-select: none;
      }
      #${QUERY_ID} .sdi-query-switch input { margin: 0; cursor: pointer; }
      #${QUERY_ID} form {
        display: none;
        align-items: center;
        gap: 4px;
      }
      html[data-sdi-query="1"] #${QUERY_ID} form { display: inline-flex; }
      #${QUERY_ID} input[type="text"] {
        width: min(280px, 46vw);
        border: 1px solid rgba(224, 138, 60, 0.45);
        border-radius: 999px;
        padding: 5px 10px;
        background: rgba(18, 16, 14, 0.92);
        color: #f3ece3;
        font: 12px/1.3 ui-sans-serif, system-ui, sans-serif;
      }
      #${QUERY_ID} button[type="submit"] {
        border: 0;
        border-radius: 999px;
        padding: 5px 10px;
        background: #e08a3c;
        color: #1a140e;
        font: 600 12px/1.2 ui-sans-serif, system-ui, sans-serif;
        cursor: pointer;
      }
      .room_list_room[${SOURCE_ATTR}],
      .col[${SOURCE_ATTR}] { position: relative; }
      .room_list_room[${SOURCE_ATTR}]::after,
      .col[${SOURCE_ATTR}]::after {
        content: attr(${SOURCE_ATTR});
        position: absolute;
        left: 6px;
        bottom: 6px;
        z-index: 4;
        pointer-events: none;
        font: 600 9px/1 ui-sans-serif, system-ui, sans-serif;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: #1a140e;
        background: #e08a3c;
        padding: 3px 6px;
        border-radius: 999px;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function setHud(text, state) {
    ensureStyle();
    let el = document.getElementById(HUD_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = HUD_ID;
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.dataset.state = state || "ok";
  }

  function hideHud() {
    const el = document.getElementById(HUD_ID);
    if (el) el.remove();
  }

  async function fetchItems(url, label) {
    const cached = cache.get(url.href);
    if (cached) return cached;
    const res = await fetch(url.href, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "text/html" },
    });
    if (!res.ok) throw new Error("fetch " + res.status);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const remoteList = findList(doc);
    /** @type {Map<string, Element>} */
    const nodes = new Map();
    if (remoteList) {
      for (const el of listItems(remoteList)) {
        const k = itemKey(el);
        if (!k || nodes.has(k)) continue;
        const clone = document.importNode(el, true);
        clone.setAttribute(SOURCE_ATTR, label);
        nodes.set(k, clone);
      }
    }
    const entry = { url: url.href, label, nodes };
    cache.set(url.href, entry);
    return entry;
  }

  function mergeEntries(entries) {
    /** @type {Map<string, Element>} */
    const nodes = new Map();
    const labels = [];
    for (const entry of entries) {
      labels.push(entry.label);
      for (const [key, node] of entry.nodes) {
        if (!nodes.has(key)) nodes.set(key, node);
      }
    }
    return { label: labels.join(" | "), nodes };
  }

  function sync(list, entry) {
    const byKey = keysInList(list);
    let added = 0;
    let skipped = 0;
    for (const [key, node] of entry.nodes) {
      const present = byKey.get(key) || [];
      const others = present.filter((el) => el !== node);
      if (others.length) {
        if (list.contains(node)) node.remove();
        skipped += 1;
        continue;
      }
      if (!list.contains(node)) {
        list.appendChild(node);
        added += 1;
      }
    }
    return { added, skipped, total: entry.nodes.size };
  }

  function watchList(list, entry, urlHref) {
    if (observer) observer.disconnect();
    let raf = 0;
    observer = new MutationObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (location.href !== urlHref) return;
        const live = findList(document);
        if (!live) return;
        sync(live, entry);
      });
    });
    const root = list.parentElement || document.body;
    observer.observe(root, { childList: true, subtree: true });
  }

  function waitForList(timeoutMs) {
    return new Promise((resolve) => {
      const found = findList(document);
      if (found) {
        resolve(found);
        return;
      }
      const obs = new MutationObserver(() => {
        const el = findList(document);
        if (el) {
          obs.disconnect();
          resolve(el);
        }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => {
        obs.disconnect();
        resolve(findList(document));
      }, timeoutMs);
    });
  }

  async function run() {
    if (running) return;
    if (SAVED_ERROR) {
      setHud("Scheme error: " + SAVED_ERROR, "error");
      return;
    }
    const url = new URL(location.href);
    let plan;
    try {
      plan = planFor(url);
    } catch (err) {
      setHud("Scheme error: " + (err && err.message ? err.message : err), "error");
      return;
    }
    if (!plan.clauses.length) {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      if (!url.searchParams.get(EXPR_PARAM)) hideHud();
      else setHud("Custom search is this tags page");
      lastHref = url.href;
      return;
    }

    running = true;
    lastHref = url.href;
    const label = plan.clauses.map(clauseLabel).join(" | ");
    setHud("Fetching " + plan.clauses.length + " tags page" + (plan.clauses.length === 1 ? "" : "s") + "…");
    try {
      const list = await waitForList(12000);
      if (!list || location.href !== url.href) return;
      const entries = [];
      for (const clause of plan.clauses) {
        entries.push(await fetchItems(clauseUrl(url.href, clause), clauseLabel(clause)));
      }
      if (location.href !== url.href) return;
      const entry = mergeEntries(entries);
      const live = findList(document) || list;
      if (plan.replace) {
        for (const el of listItems(live)) el.remove();
      }
      const { added, skipped, total } = sync(live, entry);
      watchList(live, entry, url.href);
      setHud(
        "Custom search +" +
          added +
          " from " +
          label +
          " · " +
          skipped +
          " duplicate" +
          (skipped === 1 ? "" : "s") +
          " · " +
          total +
          " rooms on the extra tags " +
          (plan.clauses.length === 1 ? "page" : "pages")
      );
    } catch (err) {
      setHud("Fetch failed: " + (err && err.message ? err.message : err), "error");
      console.warn("[sdi-tag-merge]", err);
    } finally {
      running = false;
    }
  }

  function remember(text) {
    try {
      localStorage.setItem(STORE_KEY, text);
    } catch (err) {
      /* private mode */
    }
  }

  function remembered() {
    try {
      return localStorage.getItem(STORE_KEY) || "";
    } catch (err) {
      return "";
    }
  }

  function goScheme(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return;
    const clauses = schemeClauses(trimmed);
    if (!clauses.length) throw new Error("empty scheme");
    remember(trimmed);
    const dest = clauseUrl(location.href, { ...clauses[0], params: {} });
    if (clauses.length > 1) dest.searchParams.set(EXPR_PARAM, trimmed);
    location.assign(dest.href);
  }

  function modeOn() {
    try {
      if (localStorage.getItem(MODE_KEY) === "1") return true;
      if (localStorage.getItem(MODE_KEY) === "0") return false;
    } catch (err) {
      /* ignore */
    }
    return false;
  }

  function setMode(on) {
    try {
      localStorage.setItem(MODE_KEY, on ? "1" : "0");
    } catch (err) {
      /* ignore */
    }
    document.documentElement.dataset.sdiQuery = on ? "1" : "0";
    const box = document.querySelector("#" + QUERY_ID + " input[type='checkbox']");
    if (box) box.checked = on;
  }

  function mountQuery() {
    const anchor = document.querySelector(".filter-search-toggle");
    if (!anchor || !anchor.parentElement) return;
    let host = document.getElementById(QUERY_ID);
    if (!host) {
      host = document.createElement("div");
      host.id = QUERY_ID;
      const label = document.createElement("label");
      label.className = "sdi-query-switch";
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.setAttribute("aria-label", "Enter a query instead of adding tags");
      const name = document.createElement("span");
      name.textContent = "Query";
      label.append(toggle, name);
      const form = document.createElement("form");
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "tag AND tag OR tag";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.setAttribute("aria-label", "Tag query");
      const expr = new URL(location.href).searchParams.get(EXPR_PARAM);
      input.value = expr || remembered();
      const button = document.createElement("button");
      button.type = "submit";
      button.textContent = "Go";
      form.append(input, button);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        event.stopPropagation();
        try {
          goScheme(input.value);
        } catch (err) {
          setHud("Scheme error: " + (err && err.message ? err.message : err), "error");
        }
      });
      toggle.addEventListener("change", () => {
        setMode(toggle.checked);
        if (toggle.checked) input.focus();
      });
      const on = modeOn() || Boolean(new URL(location.href).searchParams.get(EXPR_PARAM));
      toggle.checked = on;
      host.append(label, form);
      anchor.insertAdjacentElement("afterend", host);
      setMode(on);
      return;
    }
    if (host.previousElementSibling !== anchor) anchor.insertAdjacentElement("afterend", host);
  }

  function hookNavigation() {
    const fire = () => {
      mountQuery();
      if (location.href === lastHref) {
        try {
          if (planFor(new URL(location.href)).clauses.length) return;
        } catch (err) {
          /* rerun so the error shows */
        }
      }
      cache.clear();
      const input = document.querySelector("#" + QUERY_ID + " input[type='text']");
      const expr = new URL(location.href).searchParams.get(EXPR_PARAM);
      if (input && expr) input.value = expr;
      run();
    };
    const wrap = (fn) =>
      function () {
        const ret = fn.apply(this, arguments);
        queueMicrotask(fire);
        return ret;
      };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
    window.addEventListener("popstate", fire);
    window.addEventListener("sveltekit:navigation-end", fire);
  }

  function boot() {
    ensureStyle();
    mountQuery();
    let queued = 0;
    const watch = new MutationObserver(() => {
      if (queued) return;
      queued = requestAnimationFrame(() => {
        queued = 0;
        mountQuery();
      });
    });
    watch.observe(document.documentElement, { childList: true, subtree: true });
    hookNavigation();
    run();
  }

  return {
    boot,
    parseScheme,
    schemeClauses,
    parseSaved,
    planFor,
    clauseUrl,
    SAVED,
    SAVED_ERROR,
  };
});
