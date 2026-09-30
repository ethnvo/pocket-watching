# Robustness Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm test` runs the real `background.js` and `content.js` against ~45 fake model answers and ~12 fake LinkedIn pages, checking every case against shared invariants. `npm run eval` does the same against real Gemini, on demand.

**Architecture:** The unmodified `background.js` runs in a Node `vm` context and `content.js` runs in a jsdom window. Both are wired to one in-memory fake `chrome` (storage, messaging, tabs) and a fake `fetch` that serves canned Gemini answers. Every test pushes its results through `tests/invariants.mjs`, a set of rules no result or rendered badge may break. A test-only hook at the end of `content.js`'s IIFE exposes its internals.

**Tech Stack:** Node 22 `node:test` + `node:assert`, `jsdom@25` (the only dev dependency), plain ES modules.

**Spec:** `docs/superpowers/specs/2026-09-29-robustness-tests-design.md`

## Global Constraints

- `npm test` needs no network and no API key, and finishes in seconds.
- Source files are loaded **unmodified** except for one test hook at the end of `content.js`'s IIFE. It must be a no-op in the extension.
- `scripts/package.sh` and the Web Store zip must not change.
- The only dev dependency is `jsdom`. `package.json` is `"private": true`.
- Invariant ranges (from the spec): US hourly $7–$250; full-time total comp $30K–$1.5M; housing ≤ $5,000/month or ≤ $12,000 lump sum unless reported/community/edited.
- Tiers are shown only for THANOS / S / A.
- `npm run eval` is never part of `npm test`, and it reads `GEMINI_API_KEY` from the environment.
- Bugs found by the new tests are fixed **one per commit, after the harness lands**. Until then a failing fixture carries `"knownBug": "<why>"`, which runs it as a `todo` test.

**Deliberate refinements of the spec (these were found while planning; tell the user):**
- Invariant 7 in the spec says clubs are "never flagged LARP". The product rule (the prompt, `GRANDIOSE` in `background.js`) *does* flag grandiose titles at clubs, e.g. "Member of Technical Staff" at a school club. So the invariant is: a club with an **ordinary** title is never LARP.
- The "duplicated visually-hidden text" page fixture is dropped. How it behaves depends on Chrome layout, which jsdom can't reproduce. It's replaced with "a Volunteering section is ignored".
- Per-fixture rendering runs inside `pipeline.test.mjs` so each result is only computed once. `render.test.mjs` holds the scope × employment × housing × badge-settings matrix.

## Review Focus

1. **A model answer that is valid JSON but the wrong shape.** Examples: `pay_amount` is a string with a range (`"$40-50/hr"`), `housing_amount` is a string (`"$2,500"`), or `i` is a string. The expected behaviour is either a sane number or no number, never `NaN`, `—` or `undefined` in a badge. Pinned by fixtures 11, 24 and 42 plus render invariant 1.
2. **Refinement that fails or returns nothing.** The deep dive returns `null` pay, or the recheck returns `null`. Expected: the badge settles; it never stays on "checking pay…" and never shows a worse number. Pinned by fixtures 13 and 15 (the final result must have `refining: false`).
3. **The extension context dies at any point in a scan.** Expected: no uncaught error and no console noise; the script shuts down. Pinned by the Task 6 sweep over every kill point, in both throw and reject modes.
4. **The Education section renders after Experience.** Expected: the lookup waits and is sent *with* the education text. Pinned by the Task 5 test "education arrives late".
5. **Several roles at one company with inverted pay.** Expected: the earlier role's total comp ≤ the later one's. Pinned by fixture 26 and invariant 8.

---

## File Structure

```
package.json                     private; devDeps jsdom; scripts test / eval
.gitignore                       + node_modules/, eval/out/
content.js                       + test hook (last lines of the IIFE)
tests/
  harness.mjs                    createWorld(): fake chrome + fetch, loaders, settle, kill; contentUtils(); renderRow()
  match.mjs                      mismatches(actual, expected) with $range / $match / $absent
  invariants.mjs                 resultProblems(entry, r, all), renderProblems(entry, r, row)
  pipeline-run.mjs               runPipeline(fx, { live }) shared by pipeline tests and eval
  harness.test.mjs               the harness works (smoke)
  invariants.test.mjs            each rule catches its bad sample and passes its good one
  pipeline.test.mjs              every tests/fixtures/model/*.json
  render.test.mjs                badge matrix
  scrape.test.mjs                every tests/fixtures/profiles/*.html + full scan
  lifecycle.test.mjs             dead-context sweep
  fixtures/model/_bases.json     base model answers fixtures extend with "$base"
  fixtures/model/NN-*.json       ~45 cases
  fixtures/profiles/NN-*.html    12 pages
  fixtures/profiles/NN-*.expect.json
eval/
  live.mjs                       real Gemini run + report
  profiles.json                  ~15 fake profiles with loose expectations
README.md                        + "Testing" section
```

---

### Task 1: Tooling, content hook, harness

**Files:**
- Create: `package.json`, `tests/harness.mjs`, `tests/harness.test.mjs`
- Modify: `.gitignore`, `content.js` (the last lines, just before `})();`)

**Interfaces:**
- Produces:
  - `createWorld(opts) → World` with these options:
    - `local`, `sync`: initial storage objects;
    - `gemini`: `{ lookup|deepDive|recheck|edu: Answer[] | (prompt, n) => Answer }` or `"live"`;
    - `community`: an array or `"bundled"`;
    - `timeScale` (default 50);
    - `fetch` (used for the live Gemini calls).
  - An `Answer` is an array or object (JSON-encoded), a raw string, or `{ status, error }` for an HTTP error.
  - A `World` has:
    - storage and recordings: `local`, `sync`, `calls: {kind, prompt, text, status}[]`, `unexpected: string[]`, `unhandled: Error[]`, `uncaught: Error[]`, `logs: string[]`, `tabMessages: object[]`, `sent: object[]` (tab→background messages), `events: number`;
    - dead-context state: `dead`, `killAt: {event, mode} | null`;
    - methods: `loadBackground() → { ctx, eval(src), installed(details) }`, `loadContent(html, {url}) → { window, document, api }`, `message(msg) → Promise<response>` (as if sent from the tab), `kill(mode = "throw" | "reject")`, `settle({quiet, timeout})`, `dispose()`.
  - `geminiKind(prompt) → "lookup" | "deepDive" | "recheck" | "edu"`.
  - `contentUtils() → { window, document, api }`: a shared idle page, used for `parseHint` and rendering.
  - `renderRow(entry, r, badges = {}) → Element | null`: renders one result into a fresh block and returns its `.pw-row`.
  - `REPO`, `read(file)`, `DEAD`, `TAB_ID`.
  - Content hook: `window.__PW_TEST__.content = { render, findEntries, scan, parseHint, results, errors, loadBadges, dead (getter) }`.

- [ ] **Step 1: Add tooling**

`package.json`:
```json
{
  "name": "pocket-watching",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test tests/",
    "eval": "node eval/live.mjs"
  },
  "devDependencies": {
    "jsdom": "^25.0.1"
  }
}
```
Append to `.gitignore`:
```
node_modules/
eval/out/
```
Run: `npm install`. Expected: `node_modules/jsdom` exists and `package-lock.json` is created.

- [ ] **Step 2: Write the failing smoke test** in `tests/harness.test.mjs`

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createWorld, contentUtils, renderRow, geminiKind } from "./harness.mjs";

const INTERN = {
  i: 0, role: "Software Engineer Intern", company: "Acme Robotics", location: "San Jose, CA", is_internship: true,
  pay_amount: 45, pay_period: "hour", employment: "internship", currency: "USD", pay_scope: "company",
  pay_basis: "Glassdoor — Acme Robotics SWE intern (4 reports)", tier: "C", category: "Private co", verified: true, larp: false, unpaid: false,
};
const ENTRY = { key: "e0", text: "Software Engineer Intern\nAcme Robotics · Internship\nJun 2025 - Sep 2025 · 4 mos\nSan Jose, California, United States", group: "" };

test("geminiKind routes prompts", () => {
  assert.equal(geminiKind('Find the pay for "SWE" at Acme.'), "deepDive");
  assert.equal(geminiKind('Find the hourly pay for a "SWE" internship at Acme.'), "recheck");
  assert.equal(geminiKind("Rate each education entry (scraped…"), "edu");
  assert.equal(geminiKind("Today is 2026-09-29. Below are job entries…"), "lookup");
});

test("background lookup runs end to end through the message path", async () => {
  const w = createWorld({ gemini: { lookup: [[INTERN]] } });
  w.loadBackground();
  const entry = { ...ENTRY, hint: contentUtils().api.parseHint(ENTRY) };
  const resp = await w.message({ type: "pw:lookup", kind: "exp", entries: [entry], profile: { name: "Test Person" } });
  await w.settle();
  assert.equal(resp.ok, true);
  assert.equal(resp.results.e0.pay_hourly, 45);
  assert.equal(w.calls.length, 1);
  assert.deepEqual(w.unexpected, []);
  w.dispose();
});

test("content script scrapes and renders against the fake background", async () => {
  const w = createWorld({ gemini: { lookup: [[INTERN]] } });
  w.loadBackground();
  const page = w.loadContent(`<html><head><title>Test Person | LinkedIn</title></head><body><main>
    <section><div><h2>Experience</h2></div><ul><li componentkey="entity-collection-item-1"><div>
      <p>Software Engineer Intern</p><p>Acme Robotics · Internship</p><p>Jun 2025 - Sep 2025 · 4 mos</p><p>San Jose, California, United States</p>
    </div></li></ul></section>
    <section><div><h2>Education</h2></div><ul><li componentkey="entity-collection-item-2"><div>
      <p>University of California, Irvine</p><p>Bachelor of Science - BS, Computer Science</p><p>Sep 2022 - Jun 2026</p>
    </div></li></ul></section></main></body></html>`);
  w.gemini.edu = [[{ i: 0, tier: "A", label: "UC", level: "undergrad", tier_reason: "Strong UC CS program." }]];
  await w.settle();
  const rows = [...page.document.querySelectorAll(".pw-row")];
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /\$45\/hr/);
  assert.deepEqual([w.unhandled, w.uncaught], [[], []]);
  w.dispose();
});

test("renderRow renders one result", () => {
  const row = renderRow({ ...ENTRY, kind: "exp" }, { ...INTERN, pay_hourly: 45 });
  assert.match(row.textContent, /\$45\/hr/);
});

test("unhandled rejections inside the page are recorded", async () => {
  const w = createWorld();
  const page = w.loadContent("<html><body><main></main></body></html>", { url: "https://www.linkedin.com/feed/" });
  page.window.eval("Promise.reject(new Error('boom'))");
  await w.settle();
  assert.equal(w.unhandled.length, 1);
  w.dispose();
});
```
The edu answer uses `lookupEdu`'s real response fields: `i`, `level`, `tier`, `label`, `tier_reason`.

- [ ] **Step 3: Run it and confirm it fails**

Run: `npm test`. Expected: FAIL with `Cannot find module …/tests/harness.mjs`.

- [ ] **Step 4: Add the content hook.** In `content.js`, insert this directly before the final `})();`:

```js
  // Test hook: tests/harness.mjs sets __PW_TEST__ before loading this file. No-op in the extension.
  if (globalThis.__PW_TEST__) globalThis.__PW_TEST__.content = { render, findEntries, scan, parseHint, results, errors, loadBadges, get dead() { return dead; } };
```

- [ ] **Step 5: Write `tests/harness.mjs`**

```js
// Runs the real background.js (Node vm) and content.js (jsdom) against a fake chrome
// and a fake fetch that serves canned Gemini answers.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const read = (f) => fs.readFileSync(path.join(REPO, f), "utf8");
export const DEAD = "Extension context invalidated.";
export const TAB_ID = 7;
const EXT = "chrome-extension://test-extension/";
const GEMINI = "https://generativelanguage.googleapis.com/";
const COMMUNITY = "https://raw.githubusercontent.com/";
const realNow = Date.now.bind(Date);

let current = null; // the world that owns unhandled rejections right now
process.on("unhandledRejection", (err) => (current ? current.unhandled.push(err) : console.error("unhandled rejection outside a world:", err)));

export function geminiKind(prompt) {
  if (/^Find the hourly pay for/.test(prompt)) return "recheck";
  if (/^Find the pay for/.test(prompt)) return "deepDive";
  if (/^Rate each education entry/.test(prompt)) return "edu";
  return "lookup";
}

function event() {
  const listeners = [];
  return {
    listeners,
    addListener: (f) => void listeners.push(f),
    removeListener: (f) => void (listeners.includes(f) && listeners.splice(listeners.indexOf(f), 1)),
    hasListener: (f) => listeners.includes(f),
  };
}

const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(body) });

// innerText for jsdom: textContent with newlines at block boundaries, skipping hidden
// elements (content.js hides its own .pw-row with display:none before reading).
const BLOCK = new Set("ADDRESS ARTICLE ASIDE BLOCKQUOTE DD DIV DL DT FIELDSET FIGCAPTION FIGURE FOOTER FORM H1 H2 H3 H4 H5 H6 HEADER HR LI MAIN NAV OL P PRE SECTION TABLE TR UL".split(" "));
function installInnerText(win) {
  const walk = (node) => {
    let out = "";
    for (const c of node.childNodes) {
      if (c.nodeType === 3) out += c.textContent;
      else if (c.nodeType === 1) {
        if (c.hidden || c.style?.display === "none" || c.tagName === "SCRIPT" || c.tagName === "STYLE") continue;
        if (c.tagName === "BR") out += "\n";
        else out += BLOCK.has(c.tagName) ? `\n${walk(c)}\n` : walk(c);
      }
    }
    return out;
  };
  Object.defineProperty(win.HTMLElement.prototype, "innerText", {
    configurable: true,
    get() { return walk(this).replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n{2,}/g, "\n").trim(); },
  });
}

export function createWorld(opts = {}) {
  const w = {
    local: structuredClone(opts.local || {}),
    sync: { apiKey: "test-key", ...structuredClone(opts.sync || {}) },
    gemini: opts.gemini === "live" ? "live"
      : Object.fromEntries(Object.entries(opts.gemini || {}).map(([k, v]) => [k, typeof v === "function" ? v : [...v]])),
    community: opts.community ?? [],
    timeScale: opts.timeScale ?? 50,
    calls: [], unexpected: [], unhandled: [], uncaught: [], logs: [], tabMessages: [], sent: [],
    events: 0, dead: false, deadMode: "throw", killAt: null,
    inflight: 0, lastActivity: realNow(), disposed: false,
    bg: null, page: null,
  };
  current = w;
  const touch = () => (w.lastActivity = realNow());
  const safe = (f) => (...a) => {
    if (w.disposed) return;
    touch();
    try { f(...a); } catch (err) { w.uncaught.push(err); }
  };

  // ----- dead context -----
  // Every content-side chrome call and every callback delivery is one "event";
  // killAt makes the context die right before event n, like a reloaded extension.
  const step = () => {
    w.events++;
    if (w.killAt && w.events >= w.killAt.event) w.kill(w.killAt.mode);
  };
  const contentCall = (callbackForm) => {
    step();
    if (!w.dead) return null;
    if (w.deadMode === "throw" || callbackForm) throw new Error(DEAD);
    return Promise.reject(new Error(DEAD));
  };
  // Chrome never runs callbacks for a dead context.
  const deliver = (f, ...a) => setTimeout(() => { step(); if (!w.dead) safe(f)(...a); });
  w.kill = (mode = "throw") => { w.dead = true; w.deadMode = mode; w.killAt = null; };

  // ----- storage -----
  const onChanged = event();
  function storageArea(name, data, side) {
    const pick = (keys) => {
      if (keys == null) return structuredClone(data);
      if (typeof keys === "string") keys = [keys];
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
      return Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in data ? structuredClone(data[k]) : d]));
    };
    const op = (fn) => (...args) => {
      const cb = typeof args.at(-1) === "function" ? args.pop() : null;
      if (side === "content") { const dead = contentCall(!!cb); if (dead) return dead; }
      touch();
      const out = fn(...args);
      if (cb) return void (side === "content" ? deliver(cb, out) : setTimeout(() => safe(cb)(out)));
      return Promise.resolve(out);
    };
    return {
      get: op((keys) => pick(keys)),
      set: op((items) => {
        const changes = {};
        for (const [k, v] of Object.entries(items)) {
          changes[k] = { oldValue: data[k], newValue: structuredClone(v) };
          data[k] = structuredClone(v);
        }
        setTimeout(() => onChanged.listeners.forEach((f) => safe(f)(changes, name)));
      }),
      remove: op((keys) => { for (const k of [].concat(keys)) delete data[k]; }),
    };
  }

  // ----- messaging -----
  const bgMessage = event(), tabMessage = event(), onInstalled = event();
  async function dispatch(msg) {
    w.inflight++;
    touch();
    w.sent.push(structuredClone(msg));
    try {
      return await new Promise((resolve) => setTimeout(() => {
        let answered = false, later = false;
        const sendResponse = (r) => { if (!answered) { answered = true; resolve(r); } };
        for (const f of bgMessage.listeners) {
          try { if (f(structuredClone(msg), { tab: { id: TAB_ID } }, sendResponse) === true) later = true; }
          catch (err) { w.uncaught.push(err); }
        }
        if (!later && !answered) resolve(undefined);
      }));
    } finally { w.inflight--; touch(); }
  }
  w.message = dispatch;

  // ----- fetch -----
  const liveFetch = opts.fetch || globalThis.fetch;
  async function fakeFetch(url, init = {}) {
    url = String(url);
    touch();
    if (url.startsWith(GEMINI)) {
      const prompt = JSON.parse(init.body).contents[0].parts[0].text;
      const kind = geminiKind(prompt);
      if (w.gemini === "live") {
        w.inflight++;
        try {
          const res = await liveFetch(url, init);
          const body = await res.json().catch(() => ({}));
          const text = (body.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
          w.calls.push({ kind, prompt, text, status: res.status });
          return response(res.status, body);
        } finally { w.inflight--; touch(); }
      }
      const q = w.gemini[kind];
      const answer = typeof q === "function" ? q(prompt, w.calls.filter((c) => c.kind === kind).length) : q?.shift();
      if (answer === undefined) {
        w.unexpected.push(`${kind} call with no canned answer`);
        w.calls.push({ kind, prompt, text: null, status: null });
        throw new Error(`No canned Gemini answer for a ${kind} call`);
      }
      if (answer && typeof answer === "object" && !Array.isArray(answer) && "status" in answer) {
        w.calls.push({ kind, prompt, text: null, status: answer.status });
        return response(answer.status, { error: { message: answer.error } });
      }
      const text = typeof answer === "string" ? answer : JSON.stringify(answer);
      w.calls.push({ kind, prompt, text, status: 200 });
      return response(200, {
        candidates: [{ content: { parts: [{ text }] }, groundingMetadata: { webSearchQueries: [] } }],
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100 },
      });
    }
    if (url.startsWith(COMMUNITY)) return response(200, w.community === "bundled" ? JSON.parse(read("community-pay.json")) : w.community);
    if (url.startsWith(EXT)) return response(200, JSON.parse(read(url.slice(EXT.length))));
    w.unexpected.push(`fetch ${url}`);
    throw new Error(`Unexpected fetch: ${url}`);
  }

  // ----- background -----
  const bgChrome = {
    storage: { local: storageArea("local", w.local, "bg"), sync: storageArea("sync", w.sync, "bg"), onChanged },
    runtime: { id: "test-extension", onMessage: bgMessage, onInstalled, getURL: (f) => EXT + f, openOptionsPage() {}, lastError: undefined },
    action: { onClicked: event() },
    tabs: {
      create: async () => ({ id: 99 }),
      remove: async () => {},
      sendMessage: async (tabId, msg) => {
        w.tabMessages.push(structuredClone(msg));
        if (w.page && !w.dead) tabMessage.listeners.forEach((f) => deliver(f, structuredClone(msg), {}, () => {}));
      },
    },
  };
  w.loadBackground = () => {
    const ctx = vm.createContext({ chrome: bgChrome, fetch: fakeFetch, console, setTimeout, clearTimeout, setInterval, clearInterval, URL, structuredClone });
    ctx.self = ctx;
    vm.runInContext(read("background.js"), ctx, { filename: path.join(REPO, "background.js") });
    w.bg = {
      ctx,
      eval: (src) => vm.runInContext(src, ctx),
      installed: (details = { reason: "update" }) => Promise.all(onInstalled.listeners.map((f) => f(details))),
    };
    return w.bg;
  };

  // ----- content -----
  const contentChrome = {
    storage: { local: storageArea("local", w.local, "content"), sync: storageArea("sync", w.sync, "content"), onChanged },
    runtime: {
      get id() { return w.dead ? undefined : "test-extension"; },
      lastError: undefined,
      onMessage: tabMessage,
      getURL: (f) => EXT + f,
      sendMessage(msg, cb) {
        const dead = contentCall(!!cb);
        if (dead) return dead;
        const p = dispatch(msg);
        if (cb) return void p.then((r) => deliver(cb, r));
        return p;
      },
    },
  };
  w.loadContent = (html, { url = "https://www.linkedin.com/in/test-person/" } = {}) => {
    const virtualConsole = new VirtualConsole();
    for (const level of ["warn", "error"]) virtualConsole.on(level, (...a) => w.logs.push(`${level}: ${a.map(String).join(" ")}`));
    virtualConsole.on("jsdomError", (err) => w.uncaught.push(err));
    const dom = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true, virtualConsole });
    const win = dom.window;
    installInnerText(win);
    // Real timings are 600ms debounces and a 3s wait for Education; run them timeScale× faster.
    win.setTimeout = (f, ms = 0, ...a) => setTimeout(safe(() => f(...a)), ms / w.timeScale);
    win.clearTimeout = (t) => clearTimeout(t);
    const t0 = realNow();
    win.Date.now = () => t0 + (realNow() - t0) * w.timeScale;
    win.chrome = contentChrome;
    win.__PW_TEST__ = {};
    win.eval(read("content.js"));
    w.page = { window: win, document: win.document, api: win.__PW_TEST__.content };
    return w.page;
  };

  // Wait until nothing is in flight, the background queues are empty and nothing has
  // happened for `quiet` ms.
  w.settle = async ({ quiet = 30, timeout = 5000 } = {}) => {
    const start = realNow();
    for (;;) {
      await new Promise((r) => setTimeout(r, 5));
      const bgBusy = w.bg ? w.bg.eval("active + queue.length + refineActive + refineWaiting.length") : 0;
      if (!w.inflight && !bgBusy && realNow() - w.lastActivity >= quiet) return;
      if (realNow() - start > timeout) throw new Error(`World never settled (in flight ${w.inflight}, background busy ${bgBusy})`);
    }
  };
  w.dispose = () => {
    w.disposed = true;
    w.page?.window.close();
    if (current === w) current = null;
  };
  return w;
}

// A shared idle page (not a profile, so scan() does nothing) for parseHint and rendering.
let utils = null;
export function contentUtils() {
  if (utils) return utils;
  const saved = current;
  const w = createWorld();
  utils = w.loadContent("<html><body><main></main></body></html>", { url: "https://www.linkedin.com/feed/" });
  current = saved;
  return utils;
}

const DEFAULT_BADGES = { category: true, pay: true, housing: true, verified: true, unverified: true, larp: true, tenure: true, school: true, tiers: true };
export function renderRow(entry, r, badges = {}) {
  const { document, api } = contentUtils();
  api.loadBadges({ ...DEFAULT_BADGES, ...badges });
  const block = document.createElement("div");
  const dateEl = document.createElement("p");
  dateEl.textContent = (entry.text.split("\n").find((l) => /\d{4}\s*[-–]/.test(l)) || "Jan 2025 - Present");
  block.append(dateEl);
  document.querySelector("main").append(block);
  api.render({ key: entry.key || "row", kind: entry.kind || "exp", text: entry.text, group: entry.group || "", dateEl }, r, null);
  api.loadBadges(DEFAULT_BADGES);
  return block.querySelector(".pw-row");
}
```

- [ ] **Step 6: Run the tests**

Run: `npm test`. Expected: all 5 harness tests PASS.

- [ ] **Step 7: Check the Web Store zip is unchanged**

Run: `bash scripts/package.sh && unzip -l dist/pocket-watching-1.1.0.zip | grep -c -E "tests/|package.json|node_modules"`. Expected: `0`.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json .gitignore content.js tests/harness.mjs tests/harness.test.mjs
git commit -m "Test harness: real background/content scripts on a fake chrome + fake Gemini"
```

---

### Task 2: Invariants

**Files:**
- Create: `tests/invariants.mjs`, `tests/invariants.test.mjs`

**Interfaces:**
- Consumes: nothing from the harness (pure functions over plain objects and DOM elements).
- Produces:
  - `resultProblems(entry, r, all = []) → string[]`. Here `entry` is `{ key, text, group, hint }`, `r` is the final result, and `all` is `{ entry, r }[]` for the same profile.
  - `renderProblems(entry, r, row) → string[]`. Here `row` is the `.pw-row` element, or `null`.

- [ ] **Step 1: Write the failing tests** in `tests/invariants.test.mjs`. Each rule gets one sample that breaks it and one that doesn't:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { resultProblems, renderProblems } from "./invariants.mjs";

const row = (html) => new JSDOM(`<div class="pw-row">${html}</div>`).window.document.querySelector(".pw-row");
const entry = (text, company = "Acme Robotics", group = "") => ({ key: "e0", text, group, hint: { company, title: text.split("\n")[0] } });
const INTERN_TEXT = "Software Engineer Intern\nAcme Robotics · Internship\nJun 2025 - Sep 2025";
const intern = { company: "Acme Robotics", is_internship: true, employment: "internship", pay_hourly: 45, pay_annual: null, currency: "USD", pay_scope: "company" };
const has = (list, re) => list.some((p) => re.test(p));

test("1: no undefined/NaN/null/[object Object]/placeholder dash in badge text", () => {
  assert.ok(has(renderProblems(entry(INTERN_TEXT), intern, row(`<span class="pw-chip pw-pay">$NaN/hr</span>`)), /NaN/));
  assert.ok(has(renderProblems(entry(INTERN_TEXT), intern, row(`<span class="pw-chip pw-housing">🏠 —/mo housing <span class="pw-dim">est.</span></span>`)), /—/));
  assert.ok(has(renderProblems(entry(INTERN_TEXT), intern, row(`<span class="pw-chip" data-tip="Source: undefined">x</span>`)), /undefined/));
  assert.deepEqual(renderProblems(entry(INTERN_TEXT), intern, row(`<span class="pw-chip pw-pay" data-tip="Source: Glassdoor">$45/hr <span class="pw-dim">approx.</span></span>`)), []);
});

test("2: tooltip never says no company pay while its Source names the company (the Hexagon screenshot)", () => {
  const hexagon = { ...intern, company: "Hexagon Manufacturing Intelligence", pay_scope: "market" };
  const tip = "Estimated market rate: no pay found for this company, so this is typical pay for the title in San Jose, California, United States · Remote.\n\nSource: Indeed - Software Engineer Intern at Hexagon in San Francisco, CA, estimated average pay.";
  const bad = row(`<span class="pw-chip pw-pay pw-pay-est" data-tip="${tip}">$57.15/hr <span class="pw-dim">est. mkt</span></span>`);
  assert.ok(has(renderProblems(entry(INTERN_TEXT, "Hexagon Manufacturing Intelligence"), hexagon, bad), /Source names the company/));
  const ok = row(`<span class="pw-chip pw-pay pw-pay-est" data-tip="${tip.replace("Hexagon", "Acme")}">$57.15/hr <span class="pw-dim">est. mkt</span></span>`);
  assert.deepEqual(renderProblems(entry(INTERN_TEXT, "Hexagon Manufacturing Intelligence"), hexagon, ok), []);
});

test("3: est./approx. never sits next to a blue check", () => {
  const bad = row(`<span class="pw-chip pw-pay">$45/hr <span class="pw-dim">est.</span><span class="pw-check" data-tip="Confirmed · offer"></span></span>`);
  assert.ok(has(renderProblems(entry(INTERN_TEXT), intern, bad), /blue check/));
  const community = row(`<span class="pw-chip pw-pay">$45/hr <span class="pw-dim">community</span><span class="pw-check pw-check-community" data-tip="Community-reported · offer"></span></span>`);
  assert.deepEqual(renderProblems(entry(INTERN_TEXT), intern, community), []);
});

test("4: a real paid job always has pay", () => {
  assert.ok(has(resultProblems(entry(INTERN_TEXT), { ...intern, pay_hourly: null }), /no pay/));
  assert.deepEqual(resultProblems(entry(INTERN_TEXT), { ...intern, pay_hourly: null, unpaid: true }), []);
  assert.deepEqual(resultProblems(entry("Founder\nJun 2024 - Present", ""), { pay_hourly: null, category: null }), []); // no company on the page
});

test("5: sanity ranges", () => {
  assert.ok(has(resultProblems(entry(INTERN_TEXT), { ...intern, pay_hourly: 4 }), /outside/));
  assert.ok(has(resultProblems(entry(INTERN_TEXT), { ...intern, pay_hourly: 400 }), /outside/));
  const ft = { company: "Acme Robotics", is_internship: false, employment: "full-time", pay_annual: 9000, currency: "USD" };
  assert.ok(has(resultProblems(entry("Software Engineer\nAcme Robotics\nJun 2024 - Present"), ft), /outside/));
  assert.ok(has(resultProblems(entry(INTERN_TEXT), { ...intern, housing_amount: 9000, housing_period: "month" }), /housing/));
  assert.ok(has(resultProblems(entry(INTERN_TEXT), { ...intern, housing_amount: "$2,500", housing_period: "month" }), /housing/));
  assert.deepEqual(resultProblems(entry(INTERN_TEXT), { ...intern, currency: "INR", pay_hourly: 400 }), []);
  assert.deepEqual(resultProblems(entry(INTERN_TEXT), { ...intern, housing_amount: 9000, housing_period: "month", housing_scope: "reported" }), []);
});

test("6: internships are never annualized", () => {
  assert.ok(has(resultProblems(entry(INTERN_TEXT), { ...intern, pay_annual: 93600 }), /annualized/));
});

test("7: clubs are unpaid with no tier; ordinary club titles and incoming roles are never LARP", () => {
  const club = entry("Treasurer\nRobotics Club at UCI\nSep 2023 - Present", "Robotics Club at UCI");
  assert.ok(has(resultProblems(club, { unpaid: false, pay_hourly: 20, tier: "A", larp: true }), /not unpaid/));
  assert.ok(has(resultProblems(club, { unpaid: true, tier: "A" }), /tier/));
  assert.ok(has(resultProblems(club, { unpaid: true, larp: true }), /LARP/));
  const mts = entry("Member of Technical Staff\nAI Club at UCI\nSep 2023 - Present", "AI Club at UCI");
  assert.deepEqual(resultProblems(mts, { unpaid: true, larp: true }), []); // grandiose title at a club IS LARP
  const incoming = entry("Incoming Software Engineer Intern\nAcme Robotics · Internship\nJun 2027 - Sep 2027");
  assert.ok(has(resultProblems(incoming, { ...intern, larp: true }), /incoming/));
});

test("8: an earlier role at the same company doesn't out-earn the later one", () => {
  const later = { entry: entry("SDE II\nJan 2025 - Present", "Amazon", "Amazon · 2 yrs"), r: { company: "Amazon", employment: "full-time", pay_annual: 180000, currency: "USD" } };
  const earlier = { entry: entry("SDE I\nSep 2023 - Dec 2024", "Amazon", "Amazon · 2 yrs"), r: { company: "Amazon", employment: "full-time", pay_annual: 250000, currency: "USD" } };
  assert.ok(has(resultProblems(earlier.entry, earlier.r, [later, earlier]), /earlier role/));
  assert.deepEqual(resultProblems(later.entry, later.r, [later, earlier]), []);
});

test("9: shown housing always has a label", () => {
  assert.ok(has(renderProblems(entry(INTERN_TEXT), intern, row(`<span class="pw-chip pw-housing">🏠 $2,500/mo housing</span>`)), /housing without a label/));
});

test("10: tiers only as a compliment", () => {
  assert.ok(has(renderProblems(entry(INTERN_TEXT), intern, row(`<span class="pw-chip pw-tier">C tier</span>`)), /tier/));
  assert.deepEqual(renderProblems(entry(INTERN_TEXT), intern, row(`<span class="pw-chip pw-tier">THANOS tier</span>`)), []);
});

test("a missing row is only fine for skipped entries", () => {
  assert.deepEqual(renderProblems(entry(INTERN_TEXT), { skip: true }, null), []);
  assert.ok(has(renderProblems(entry(INTERN_TEXT), intern, null), /no badge row/));
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `node --test tests/invariants.test.mjs`. Expected: FAIL, `Cannot find module …/invariants.mjs`.

- [ ] **Step 3: Write `tests/invariants.mjs`**

```js
// Rules every result and every rendered badge row must follow. Each fixture is checked
// against all of them, so a new case can catch bugs nobody wrote an assertion for.
// Numbers match the spec: docs/superpowers/specs/2026-09-29-robustness-tests-design.md

const PAY_EXEMPT = /^(Student org|Volunteer|Self-employed)$/;
const REAL = /^(reported|community|edited)$/;
const CLUB = /\b(club|society|association|chapter|fraternity|sorority)\b|\bat (uc ?\w+|ucla|ucsd|ucsb|uci|university|college)\b/i;
// test-owned: titles that are obviously grandiose on a club
const GRANDIOSE = /member of (the )?technical staff|\bmts\b|forward[- ]deployed|founding engineer|research (scientist|engineer)|\bchief\b|\bc[etfo]o\b|head of|vp of|director of (engineering|ai|ml|research)|quant(itative)? (researcher|trader|developer)/i;
const MONTHS = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ");
const startOf = (text) => {
  const m = String(text || "").match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{4})\s*[-–—]/i);
  return m ? Number(m[2]) * 12 + MONTHS.indexOf(m[1].toLowerCase()) : null;
};
const employment = (r) => String(r.employment || (r.is_internship ? "internship" : "full-time")).toLowerCase();
const companyOf = (entry, r) => String(entry.hint?.company || String(entry.group || "").split("·")[0] || r?.company || "").toLowerCase().trim();
const usd = (r) => !r.currency || r.currency === "USD";
const money = (n) => `$${Math.round(n).toLocaleString("en-US")}`;

export function resultProblems(entry, r, all = []) {
  if (!r) return ["no result"];
  if (r.skip) return [];
  const out = [];
  const onPage = !!(entry.hint?.company || entry.group);
  const title = entry.hint?.title || String(entry.text || "").split("\n")[0];

  // 4
  if (!r.unpaid && !PAY_EXEMPT.test(r.category || "") && onPage && !r.pay_hourly && !r.pay_annual)
    out.push("real paid job has no pay (would show pay n/a)");
  // 5
  if (usd(r) && r.pay_hourly != null && (r.pay_hourly < 7 || r.pay_hourly > 250)) out.push(`hourly $${r.pay_hourly} outside $7–$250`);
  if (usd(r) && !r.is_internship && employment(r) === "full-time" && r.pay_annual != null && (r.pay_annual < 30000 || r.pay_annual > 1500000))
    out.push(`full-time TC ${money(r.pay_annual)} outside $30K–$1.5M`);
  if (r.housing_amount != null && !REAL.test(r.housing_scope || r.pay_scope || "")) {
    const n = Number(r.housing_amount);
    const max = r.housing_period === "month" ? 5000 : 12000;
    if (!(n > 0) || n > max) out.push(`housing ${JSON.stringify(r.housing_amount)} (${r.housing_period}) isn't a sane amount`);
  }
  // 6
  if (r.is_internship && r.pay_annual != null) out.push("internship was annualized");
  // 7
  if (CLUB.test(`${entry.hint?.company || ""} ${entry.group || ""}`)) {
    if (!r.unpaid) out.push("club/student org is not unpaid");
    if (r.pay_hourly || r.pay_annual) out.push("club/student org has pay");
    if (r.tier) out.push(`club/student org has tier ${r.tier}`);
    if (r.larp && !GRANDIOSE.test(title)) out.push("club role with an ordinary title flagged LARP");
  }
  if (r.larp && /\bincoming\b/i.test(entry.text)) out.push("incoming role flagged LARP");
  // 8
  if (!r.is_internship && employment(r) === "full-time" && r.pay_annual && !REAL.test(r.pay_scope || "")) {
    const co = companyOf(entry, r), start = startOf(entry.text);
    for (const o of all) {
      if (o.entry === entry || !o.r || o.r.is_internship || !o.r.pay_annual || employment(o.r) !== "full-time") continue;
      const s = startOf(o.entry.text);
      if (co && companyOf(o.entry, o.r) === co && start != null && s != null && start < s && r.pay_annual > o.r.pay_annual)
        out.push(`earlier role pays more (${money(r.pay_annual)}) than the later "${o.entry.text.split("\n")[0]}" (${money(o.r.pay_annual)})`);
    }
  }
  return out;
}

export function renderProblems(entry, r, row) {
  if (!row) return r?.skip ? [] : ["no badge row rendered"];
  if (r?.skip) return row.hidden || !row.textContent.trim() ? [] : ["skipped entry still shows badges"];
  const out = [];
  // 1
  const texts = [row.textContent, ...[...row.querySelectorAll("[data-tip]")].map((el) => el.dataset.tip)];
  for (const t of texts) {
    const m = String(t).match(/\bundefined\b|\bNaN\b|\bnull\b|\[object Object\]|—(\/(hr|mo)| lump sum| TC| housing)/);
    if (m) out.push(`"${m[0]}" in badge text: ${JSON.stringify(String(t).slice(0, 140))}`);
  }
  // 2
  const pay = row.querySelector(".pw-pay");
  if (pay) {
    const tip = pay.dataset.tip || "";
    const source = (tip.match(/^Source: (.*)$/m) || [])[1] || "";
    const co = String(r?.company || entry.hint?.company || "").toLowerCase().split(/\s+/)[0];
    if (/no pay (was )?found for this company/i.test(tip) && co.length > 2 && source.toLowerCase().includes(co))
      out.push("pay tooltip says no pay was found for this company, but its Source names the company");
  }
  // 3
  for (const chip of row.querySelectorAll(".pw-pay, .pw-housing")) {
    const solid = chip.querySelector(".pw-check:not(.pw-check-community)");
    const est = [...chip.querySelectorAll(".pw-dim")].map((d) => d.textContent.trim()).find((t) => /^(est\.|est\. mkt|approx\.|median|edited)$/.test(t));
    if (solid && est) out.push(`"${est}" and a blue check on the same number: ${chip.textContent.trim()}`);
  }
  // 9
  for (const h of row.querySelectorAll(".pw-housing"))
    if (!h.querySelector(".pw-check, .pw-dim")) out.push(`housing without a label: ${h.textContent.trim()}`);
  // 10
  for (const t of row.querySelectorAll(".pw-tier"))
    if (!/^(THANOS|S|A) tier$/.test(t.textContent.trim())) out.push(`tier shown that isn't a compliment: ${t.textContent.trim()}`);
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test tests/invariants.test.mjs`. Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/invariants.mjs tests/invariants.test.mjs
git commit -m "Invariants: the rules every result and badge must follow"
```

---

### Task 3: Pipeline runner + model-answer fixtures

**Files:**
- Create: `tests/match.mjs`, `tests/pipeline-run.mjs`, `tests/pipeline.test.mjs`, `tests/fixtures/model/_bases.json`, `tests/fixtures/model/NN-*.json` (45 files)

**Interfaces:**
- Consumes: `createWorld`, `contentUtils`, `renderRow` (Task 1); `resultProblems`, `renderProblems` (Task 2).
- Produces:
  - `mismatches(actual, expected, at = "") → string[]`. `expected` supports these matchers: `{ "$range": [lo, hi] }`, `{ "$match": "regex" }` (case-insensitive), `{ "$absent": true }`.
  - `expandAnswer(a)`: expands `{ "$base": "intern" | "ft" | "club", ...overrides }`.
  - `DEFAULT_PROFILE`.
  - `runPipeline(fx, { live }) → { world, bg, entries, response, first, final }`. Result keys are `e0`, `e1`, …
  - `fixtureProblems(fx, run) → string[]` (exported for `eval/live.mjs`).
  - Fixture JSON shape:
    ```
    { name, why?, knownBug?, kind? ("exp"|"edu"), profile?, sync?, local?, knownPay?, knownCompanies?, community?,
      entries: [{ text, group?, hint? }],
      gemini: { lookup?: Answer[], deepDive?: Answer[], recheck?: Answer[], edu?: Answer[] },
      expect?: { response?: {...}, results?: { "<index>": {...} }, calls?: { "<kind>": n } } }
    ```

- [ ] **Step 1: Write `tests/match.mjs`** and a quick self-check at the top of `pipeline.test.mjs` (Step 4)

```js
// Partial deep match: only keys present in `expected` are checked.
export function mismatches(actual, expected, at = "") {
  const show = (v) => JSON.stringify(v);
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if ("$range" in expected) {
      const [lo, hi] = expected.$range;
      return typeof actual === "number" && actual >= lo && actual <= hi ? [] : [`${at}: expected ${lo}–${hi}, got ${show(actual)}`];
    }
    if ("$match" in expected) return new RegExp(expected.$match, "i").test(String(actual ?? "")) ? [] : [`${at}: expected /${expected.$match}/i, got ${show(actual)}`];
    if ("$absent" in expected) return actual == null ? [] : [`${at}: expected nothing, got ${show(actual)}`];
    if (actual == null || typeof actual !== "object") return [`${at}: expected an object, got ${show(actual)}`];
    return Object.entries(expected).flatMap(([k, v]) => mismatches(actual[k], v, at ? `${at}.${k}` : k));
  }
  return show(actual) === show(expected) ? [] : [`${at}: expected ${show(expected)}, got ${show(actual)}`];
}
```

- [ ] **Step 2: Write `tests/pipeline-run.mjs`**

```js
import fs from "node:fs";
import path from "node:path";
import { createWorld, contentUtils, renderRow, REPO } from "./harness.mjs";
import { mismatches } from "./match.mjs";
import { resultProblems, renderProblems } from "./invariants.mjs";

export const DEFAULT_PROFILE = {
  name: "Test Person",
  headline: "CS @ UCI",
  education: "University of California, Irvine\nBachelor of Science - BS, Computer Science\nSep 2022 - Jun 2026",
};
const BASES = JSON.parse(fs.readFileSync(path.join(REPO, "tests/fixtures/model/_bases.json"), "utf8"));

export function expandAnswer(a) {
  if (Array.isArray(a)) return a.map(expandAnswer);
  if (a && typeof a === "object" && a.$base) {
    const { $base, ...rest } = a;
    if (!BASES[$base]) throw new Error(`Unknown $base "${$base}"`);
    return { ...BASES[$base], ...rest };
  }
  return a;
}

export async function runPipeline(fx, { live = false } = {}) {
  const world = createWorld({
    gemini: live ? "live" : Object.fromEntries(Object.entries(fx.gemini || {}).map(([k, list]) => [k, list.map(expandAnswer)])),
    sync: { ...(live ? { apiKey: process.env.GEMINI_API_KEY } : {}), ...fx.sync },
    local: { knownPay: fx.knownPay || [], knownCompanies: fx.knownCompanies || [], ...fx.local },
    community: fx.community ?? (live ? "bundled" : []),
  });
  const bg = world.loadBackground();
  const entries = fx.entries.map((e, i) => {
    const text = e.text, group = e.group || "";
    return { key: `e${i}`, kind: fx.kind || "exp", text, group, hint: e.hint || contentUtils().api.parseHint({ text, group }) };
  });
  const response = await world.message({
    type: "pw:lookup", kind: fx.kind || "exp",
    entries: entries.map(({ kind, ...e }) => e),
    profile: { ...DEFAULT_PROFILE, ...fx.profile },
  });
  await world.settle({ timeout: live ? 180000 : 5000 });
  const first = response?.ok ? response.results : {};
  const final = { ...first };
  for (const m of world.tabMessages) if (m.type === "pw:refined") final[m.key] = m.data;
  world.dispose();
  return { world, bg, entries, response, first, final };
}

export function fixtureProblems(fx, run, { live = false } = {}) {
  const { world } = run;
  const problems = [...world.unexpected, ...world.uncaught.map(String), ...world.unhandled.map(String)];
  if (!live) {
    for (const [kind, q] of Object.entries(world.gemini)) if (Array.isArray(q) && q.length) problems.push(`${q.length} unused ${kind} answer(s)`);
  }
  if (fx.expect?.response) problems.push(...mismatches(run.response, fx.expect.response, "response"));
  for (const [i, exp] of Object.entries(fx.expect?.results || {})) problems.push(...mismatches(run.final[`e${i}`], exp, `results[${i}]`));
  for (const [kind, n] of Object.entries(fx.expect?.calls || {})) {
    const got = world.calls.filter((c) => c.kind === kind).length;
    if (got !== n) problems.push(`calls.${kind}: expected ${n}, got ${got}`);
  }
  const all = run.entries.map((entry) => ({ entry, r: run.final[entry.key] })).filter((x) => x.r);
  for (const { entry, r } of all) {
    if (r.refining) problems.push(`[${entry.key}] still refining after everything settled`);
    problems.push(...resultProblems(entry, r, all).map((p) => `[${entry.key}] ${p}`));
    problems.push(...renderProblems(entry, r, renderRow(entry, r)).map((p) => `[${entry.key}] render: ${p}`));
  }
  return problems;
}
```

- [ ] **Step 3: Write `tests/fixtures/model/_bases.json`**

```json
{
  "intern": {
    "i": 0, "role": "Software Engineer Intern", "company": "Acme Robotics", "location": "San Jose, CA",
    "is_internship": true, "pay_amount": 45, "pay_period": "hour", "skip": false, "employment": "internship",
    "level": null, "housing_amount": null, "housing_period": null, "currency": "USD",
    "pay_scope": "company", "pay_basis": "Glassdoor — Acme Robotics SWE intern (4 reports)",
    "tier": "C", "category": "Private co", "stage": null, "valuation": null, "round_name": null,
    "round_amount": null, "round_date": null, "valuation_source": null, "yc_batch": null,
    "larp": false, "larp_reason": null, "unpaid": false, "verified": true, "verify_note": null,
    "tier_reason": "Engineering intern at a small company."
  },
  "ft": {
    "i": 0, "role": "Software Engineer", "company": "Acme Robotics", "location": "San Jose, CA",
    "is_internship": false, "pay_amount": 150000, "pay_period": "year", "skip": false, "employment": "full-time",
    "level": null, "housing_amount": null, "housing_period": null, "currency": "USD",
    "pay_scope": "company", "pay_basis": "Levels.fyi — Acme Robotics SWE (6 data points)",
    "tier": "C", "category": "Private co", "stage": null, "valuation": null, "round_name": null,
    "round_amount": null, "round_date": null, "valuation_source": null, "yc_batch": null,
    "larp": false, "larp_reason": null, "unpaid": false, "verified": true, "verify_note": null,
    "tier_reason": "Engineer at a small company."
  },
  "club": {
    "i": 0, "role": "Treasurer", "company": "Robotics Club at UCI", "location": "Irvine, CA",
    "is_internship": false, "pay_amount": null, "pay_period": null, "skip": false, "employment": "part-time",
    "level": null, "housing_amount": null, "housing_period": null, "currency": "USD",
    "pay_scope": null, "pay_basis": "Student organization — unpaid.",
    "tier": null, "category": "Student org", "stage": null, "valuation": null, "round_name": null,
    "round_amount": null, "round_date": null, "valuation_source": null, "yc_batch": null,
    "larp": false, "larp_reason": null, "unpaid": true, "verified": true, "verify_note": null,
    "tier_reason": "Club role."
  }
}
```

- [ ] **Step 4: Write `tests/pipeline.test.mjs`**

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { REPO } from "./harness.mjs";
import { mismatches } from "./match.mjs";
import { runPipeline, fixtureProblems } from "./pipeline-run.mjs";

test("mismatches matchers", () => {
  assert.deepEqual(mismatches({ a: 5, b: "x" }, { a: { $range: [1, 9] }, b: { $match: "^x$" }, c: { $absent: true } }), []);
  assert.equal(mismatches({ a: 10 }, { a: { $range: [1, 9] } }).length, 1);
});

const dir = path.join(REPO, "tests/fixtures/model");
for (const file of fs.readdirSync(dir).filter((f) => /^\d+-.*\.json$/.test(f)).sort()) {
  const fx = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  test(`${file}: ${fx.name}`, fx.knownBug ? { todo: fx.knownBug } : {}, async () => {
    const run = await runPipeline(fx);
    assert.deepEqual(fixtureProblems(fx, run), []);
  });
}
```

- [ ] **Step 5: Write the first two fixtures in full and run them**

`tests/fixtures/model/01-amount-string-dollars.json`:
```json
{
  "name": "pay_amount as a \"$52.50\" string",
  "why": "Convert pay deterministically from the quoted amount",
  "entries": [{ "text": "Software Engineer Intern\nAcme Robotics · Internship\nJun 2025 - Sep 2025 · 4 mos\nSan Jose, California, United States" }],
  "gemini": { "lookup": [[{ "$base": "intern", "pay_amount": "$52.50", "pay_period": "hour" }]] },
  "expect": { "response": { "ok": true }, "results": { "0": { "pay_hourly": 52.5, "pay_annual": null, "pay_period": "hour" } }, "calls": { "lookup": 1 } }
}
```
`tests/fixtures/model/16-sf-data-for-san-jose.json`, the case from the screenshot:
```json
{
  "name": "market estimate whose source is the same company in another city",
  "why": "User screenshot 2026-09-29: tooltip said no pay found for this company but Source named Hexagon",
  "entries": [{ "text": "AI/ML Software Engineering Intern\nHexagon Manufacturing Intelligence · Internship\nJun 2026 - Present · 4 mos\nSan Jose, California, United States · Remote" }],
  "gemini": { "lookup": [[{ "$base": "intern", "role": "AI/ML Software Engineering Intern", "company": "Hexagon Manufacturing Intelligence", "category": "Big Tech", "pay_amount": 57.15, "pay_scope": "market", "pay_basis": "Indeed - Software Engineer Intern at Hexagon in San Francisco, CA, estimated average pay" }]] },
  "expect": { "results": { "0": { "pay_scope": "market", "pay_hourly": 57.15 } } }
}
```
Run: `node --test tests/pipeline.test.mjs`. Expected: both PASS. Then prove invariant 2 catches the old tooltip: temporarily restore the old `market:` string in `content.js` (`Estimated market rate: no pay found for this company, so this is typical pay for the title…`), confirm fixture 16 FAILS with "Source names the company", then restore the current string.

- [ ] **Step 6: Write the remaining fixtures.** Each row below is one file, `tests/fixtures/model/NN-slug.json`.
  - **Entry text:** unless a row says otherwise, use the intern entry text from fixture 01 (`INTERN_TEXT`) for intern answers. For `ft` answers use `"Software Engineer\nAcme Robotics · Full-time\nJul 2024 - Present · 1 yr 3 mos\nSan Jose, California, United States"` (`FT_TEXT`).
  - **Answer:** the "Answer" column lists the `$base` plus its overrides.
  - **Expect:** the "Expect" column goes into `expect.results["0"]` unless a row says otherwise.
  - **Unspecified:** where a row says "invariants only", leave `expect` out.

| NN-slug | Entries (if not default) | gemini | Expect |
|---|---|---|---|
| 02-amount-k-suffix | FT_TEXT | lookup: ft, `pay_amount:"185k"`, `pay_period:"annual"` | `pay_annual:185000` |
| 03-period-yearly-word | FT_TEXT | lookup: ft, `pay_amount:160000`, `pay_period:"yearly"` | `pay_annual:160000` |
| 04-period-tc | FT_TEXT | lookup: ft, `pay_amount:200000`, `pay_period:"TC"` | `pay_annual:200000` |
| 05-period-missing-hourly | | lookup: intern, `pay_amount:48`, `pay_period:null` | `pay_hourly:48, pay_period:"hour"` |
| 06-period-missing-monthly | | lookup: intern, `pay_amount:9000`, `pay_period:null` | `pay_period:"month", pay_hourly:51.92` |
| 07-period-missing-annual | FT_TEXT | lookup: ft, `pay_amount:175000`, `pay_period:null` | `pay_annual:175000` |
| 08-tc-field-instead | FT_TEXT | lookup: ft, `pay_amount:null`, `pay_period:null`, `tc:"$190,000"` | `pay_annual:190000` |
| 09-monthly-as-quoted | | lookup: intern, `pay_amount:10200`, `pay_period:"month"` | `pay_period:"month", pay_amount:10200, pay_hourly:58.85` |
| 10-per-hour-phrase | | lookup: intern, `pay_amount:47`, `pay_period:"per hour"` | `pay_hourly:47` |
| 11-amount-range-string | | lookup: intern, `pay_amount:"$40-50/hr"`, `pay_period:"hour"` | `pay_hourly:{$range:[40,50]}` |
| 12-zero-pay-deep-dive | | lookup: intern, `pay_amount:0`, `pay_basis:"No data found"`; deepDive: `[{pay_amount:47,pay_period:"hour",level:null,estimate:true,pay_basis:"Levels.fyi comparable robotics interns"}]` | `pay_hourly:47, pay_scope:"market", refined:true`; calls `{lookup:1,deepDive:1}` |
| 13-deep-dive-returns-null | | lookup: intern, `pay_amount:null`; deepDive: `[{pay_amount:null,pay_period:null,level:null,estimate:true,pay_basis:"nothing"}]` | `refining:false`; invariants only |
| 14-company-wide-average-low | `"Software Development Engineer Intern\nAmazon · Internship\nJun 2025 - Sep 2025\nSeattle, Washington, United States"` | lookup: intern, `role:"Software Development Engineer Intern"`, `company:"Amazon"`, `location:"Seattle, WA"`, `pay_amount:19`, `pay_basis:"Indeed — average Amazon internship pay"`; recheck: `[{pay_amount:55,pay_period:"hour",pay_basis:"Levels.fyi — Amazon SDE intern Seattle"}]` | `category:"FAANG", pay_hourly:55`; calls `{lookup:1,recheck:1}` |
| 15-recheck-returns-null | same entry as 14 | lookup as 14; recheck: `[{pay_amount:null,pay_period:null,pay_basis:"none"}]` | `refining:false`; invariants only |
| 17-median-fallback-other-cities | | knownPay: `[{company:"Acme Robotics",role:"Software Engineer Intern",hourly:50,intern:true,location:"Seattle, Washington",source:"offer"},{company:"Acme Robotics",role:"Software Engineer Intern",hourly:46,intern:true,location:"Austin, Texas",source:"offer"}]`; lookup: intern, `pay_amount:25` | `pay_scope:"median", pay_hourly:48` |
| 18-median-fallback-skips-non-us | `"Software Engineer Intern\nAcme Robotics · Internship\nJun 2025 - Sep 2025\nToronto, Ontario, Canada"` | knownPay as 17; lookup: intern, `location:"Toronto, ON"`, `pay_amount:30`, `currency:"CAD"` | `pay_scope:"company", pay_hourly:30` |
| 19-known-pay-exact-wins | | knownPay: `[{company:"Acme Robotics",role:"Software Engineer Intern",hourly:60,intern:true,location:"San Jose, California",source:"Summer 2025 offer"}]`; lookup: intern | `pay_scope:"reported", pay_hourly:60` |
| 20-community-pay | | community: `[{company:"Acme Robotics",role:"Software Engineer Intern",hourly:52,intern:true,location:"San Jose, California",source:"Summer 2025 offer"}]`; lookup: intern | `pay_scope:"community", pay_hourly:52` |
| 21-housing-no-period | | lookup: intern, `housing_amount:3000`, `housing_period:null` | invariants only |
| 22-housing-above-max | | lookup: intern, `housing_amount:9000`, `housing_period:"month"` | `housing_amount:null` |
| 23-housing-lump-sum | | lookup: intern, `housing_amount:6000`, `housing_period:"total"` | `housing_total:6000` |
| 24-housing-string-amount | | lookup: intern, `housing_amount:"$2,500"`, `housing_period:"month"` | invariants only |
| 25-full-time-quoted-hourly | FT_TEXT | lookup: ft, `pay_amount:60`, `pay_period:"hour"` | `pay_annual:124800` |
| 26-promotion-inverted | entries: `{text:"SDE II\nJan 2025 - Present · 9 mos\nSeattle, WA", group:"Amazon · 2 yrs 1 mo"}`, `{text:"SDE I\nSep 2023 - Dec 2024 · 1 yr 4 mos", group:"Amazon · 2 yrs 1 mo"}` | lookup: `[ft i:0 role:"SDE II" company:"Amazon" location:"Seattle, WA" level:"SDE II" pay_amount:240000, ft i:1 role:"SDE I" company:"Amazon" location:"Seattle, WA" level:"SDE I" pay_amount:300000]` | results 0 `pay_annual:{$range:[220000,280000]}`, 1 `pay_annual:{$range:[160000,190000]}` |
| 27-meta-e3-out-of-band | `"Software Engineer\nMeta · Full-time\nJul 2025 - Present\nMenlo Park, California, United States"` | lookup: ft, `company:"Meta"`, `level:"E3"`, `pay_amount:370000` | `category:"MANGO", pay_annual:{$range:[185000,195000]}` |
| 28-facebook-alias | `"Software Engineer\nFacebook · Full-time\nJul 2019 - Jun 2021\nMenlo Park, California, United States"` | lookup: ft, `company:"Facebook"`, `category:"Big Tech"` | `category:"MANGO"` |
| 29-unicorn-no-valuation | FT_TEXT | lookup: ft, `category:"Unicorn"`, `valuation:null` | `category:"Startup"` |
| 30-unicorn-with-valuation | FT_TEXT | lookup: ft, `category:"Unicorn"`, `valuation:1150000000`, `valuation_source:"TechCrunch"`, `round_name:"Series C"` | `category:"Unicorn"` |
| 31-club-with-pay | `"Treasurer\nRobotics Club at UCI\nSep 2023 - Present\nIrvine, California"` | lookup: intern, `role:"Treasurer"`, `company:"Robotics Club at UCI"`, `is_internship:false`, `employment:"part-time"`, `pay_amount:20`, `category:"Startup"`, `tier:"A"` | `unpaid:true, tier:null, pay_hourly:null, category:"Student org"` |
| 32-club-mts-is-larp | `"Member of Technical Staff\nAI Club at UCI\nSep 2023 - Present"` | lookup: club, `role:"Member of Technical Staff"`, `company:"AI Club at UCI"` | `larp:true` |
| 33-club-ordinary-not-larp | 31's text | lookup: club, `larp:true`, `larp_reason:"inflated"` | `larp:false` |
| 34-incoming-not-larp | `"Incoming Software Engineer Intern\nAcme Robotics · Internship\nJun 2027 - Sep 2027"` | lookup: intern, `larp:true`, `larp_reason:"no evidence"` | `larp:false` |
| 35-elite-title-not-larp | `"Member of Technical Staff\nAnthropic · Full-time\nJan 2026 - Present\nSan Francisco, California, United States"` | lookup: ft, `role:"Member of Technical Staff"`, `company:"Anthropic"`, `pay_amount:400000`, `larp:true` | `category:"MANGO", larp:false` |
| 36-no-company-line | `{text:"Founder\nJun 2024 - Present", group:""}` | lookup: ft, `role:"Founder"`, `company:null`, `category:null`, `pay_amount:null`, `employment:"full-time"`, `pay_basis:"Founder — no salary known"` | invariants only |
| 37-fenced-with-prose | | lookup (raw string): ``"Here you go:\n```json\n[<intern base as JSON>]\n```\nLet me know if you need more."`` (Strings aren't expanded: paste the full intern JSON.) | `pay_hourly:45` |
| 38-empty-array | | lookup (raw string): `"[]"` | `response:{ok:true}`, results 0 `{$absent:true}` |
| 39-fewer-items-than-entries | entries: INTERN_TEXT, FT_TEXT | lookup: `[intern i:0]` | results 0 `pay_hourly:45`, 1 `{$absent:true}` |
| 40-http-error | | lookup: `{status:500, error:"Internal error"}` | `response:{ok:false, error:{$match:"Internal error"}}` |
| 41-truncated-json | | lookup (raw string): `"[{\"i\":0,\"role\":\"Software"` | `response:{ok:false, error:{$match:"parse"}}` |
| 42-index-as-string | | lookup: intern, `i:"0"` | `pay_hourly:45` |
| 43-non-usd | `"Software Engineer\nAcme Robotics · Full-time\nJul 2024 - Present\nBerlin, Germany"` | lookup: ft, `location:"Berlin"`, `currency:"EUR"`, `pay_amount:2500`, `pay_period:"month"` | `currency:"EUR", pay_annual:30000` |
| 44-everyday-skip | `"Barista\nStarbucks · Part-time\nJun 2021 - Aug 2022"` | lookup: intern, `skip:true`, `role:"Barista"`, `company:"Starbucks"` | `skip:true` |
| 45-volunteer-unpaid | `"Volunteer Tutor\nGirls Who Code · Volunteer\nJan 2023 - Present"` | lookup: club, `role:"Volunteer Tutor"`, `company:"Girls Who Code"`, `category:"Volunteer"` | `unpaid:true` |
| 46-no-api-key | | `sync:{apiKey:null}`; no gemini | `response:{ok:false, error:"NO_KEY"}`; calls `{lookup:0}` |
| 47-hourly-too-high | | lookup: intern, `pay_amount:4000`, `pay_period:"hour"` | invariants only |

Arithmetic used above: 9000×12/2080 = 51.92; 10200×12/2080 = 58.85; 60×2080 = 124800; 2500×12 = 30000; the median of 50 and 46 is 48.

- [ ] **Step 7: Run the suite and triage**

Run: `node --test tests/pipeline.test.mjs`. For each failing fixture, decide which it is:
- **Fixture mistake** (wrong arithmetic, wrong base, an answer that was never consumed): fix the fixture.
- **Real bug**: leave the expectation as the correct behaviour and add `"knownBug": "<one line: what's wrong>"`. The test then runs as `todo`. Record it in a `## Known bugs found` list at the bottom of this plan file, with the fixture name.

Expected result: 0 failures, N todos. The todo count equals the size of the known-bug list.

- [ ] **Step 8: Commit**

```bash
git add tests/match.mjs tests/pipeline-run.mjs tests/pipeline.test.mjs tests/fixtures/model docs/superpowers/plans/2026-09-29-robustness-tests.md
git commit -m "Pipeline tests: 47 fake model answers through the real background + render"
```

---

### Task 4: Badge render matrix

**Files:**
- Create: `tests/render.test.mjs`

**Interfaces:**
- Consumes: `createWorld().loadBackground().ctx.normalizePay` (Task 1), `renderRow` (Task 1), `renderProblems` (Task 2).

- [ ] **Step 1: Write the test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createWorld, renderRow } from "./harness.mjs";
import { renderProblems } from "./invariants.mjs";

const bg = createWorld().loadBackground().ctx;
const SCOPES = ["reported", "community", "edited", "company", "market", "median", undefined];
const PAY = {
  "intern hourly": { is_internship: true, employment: "internship", pay_amount: 45, pay_period: "hour" },
  "intern monthly": { is_internship: true, employment: "internship", pay_amount: 9000, pay_period: "month" },
  "full-time": { is_internship: false, employment: "full-time", pay_amount: 185000, pay_period: "year", level: "L3" },
  "part-time": { is_internship: false, employment: "part-time", pay_amount: 22, pay_period: "hour" },
};
const HOUSING = {
  none: {},
  "monthly est": { housing_amount: 2500, housing_period: "month" },
  "lump sum est": { housing_amount: 6000, housing_period: "total" },
  "reported": { housing_amount: 2500, housing_period: "month", housing_scope: "reported" },
  "community": { housing_amount: 6000, housing_period: "total", housing_scope: "community" },
};
const BADGES = { "all on": {}, "checks off": { verified: false }, "pay off": { pay: false } };
const SCOPE_LABEL = { market: "est. mkt", company: "approx.", median: "median", edited: "edited", community: "community", undefined: "approx." };
const entry = { key: "m", kind: "exp", text: "Software Engineer Intern\nAcme Robotics · Internship\nJun 2025 - Sep 2025", group: "", hint: { company: "Acme Robotics", title: "Software Engineer Intern" } };

for (const scope of SCOPES) {
  for (const [payName, pay] of Object.entries(PAY)) {
    test(`scope ${scope ?? "(none)"} · ${payName}`, () => {
      const problems = [];
      for (const [hName, housing] of Object.entries(HOUSING)) {
        for (const [bName, badges] of Object.entries(BADGES)) {
          const r = bg.normalizePay({
            role: "Software Engineer Intern", company: "Acme Robotics", location: "San Jose, CA", currency: "USD",
            category: "Private co", tier: "C", verified: true, pay_basis: "Glassdoor — Acme Robotics (4 reports)",
            pay_source: "Summer 2025 offer", ...pay, ...housing, pay_scope: scope,
          });
          const row = renderRow(entry, r, badges);
          const at = `[${hName} · ${bName}]`;
          problems.push(...renderProblems(entry, r, row).map((p) => `${at} ${p}`));
          const chip = row.querySelector(".pw-pay");
          if (badges.pay === false) { if (chip) problems.push(`${at} pay chip shown with pay badges off`); continue; }
          if (!chip) { problems.push(`${at} no pay chip`); continue; }
          const dims = [...chip.querySelectorAll(".pw-dim")].map((d) => d.textContent.trim());
          if (scope === "reported") {
            if (badges.verified !== false && !chip.querySelector(".pw-check")) problems.push(`${at} confirmed pay without a check`);
          } else if (!dims.includes(SCOPE_LABEL[scope])) problems.push(`${at} expected "${SCOPE_LABEL[scope]}", got ${JSON.stringify(dims)}`);
          if (payName === "full-time" && !/TC/.test(chip.textContent)) problems.push(`${at} full-time without TC`);
          if (payName === "intern monthly" && !/\/mo/.test(chip.textContent)) problems.push(`${at} monthly without /mo`);
          const h = row.querySelector(".pw-housing");
          if (pay.is_internship && housing.housing_amount && !h) problems.push(`${at} housing missing`);
          if (!pay.is_internship && h) problems.push(`${at} housing on a non-internship`);
        }
      }
      assert.deepEqual(problems, []);
    });
  }
}
```

- [ ] **Step 2: Run the tests**

Run: `node --test tests/render.test.mjs`. For each failing combination: if it's a test mistake (a wrong expected label), fix the test. If it's a real bug, split that combination into its own `test(..., { todo: "<why>" })` and add it to `## Known bugs found`. Expected: 0 failures.

- [ ] **Step 3: Commit**

```bash
git add tests/render.test.mjs docs/superpowers/plans/2026-09-29-robustness-tests.md
git commit -m "Render matrix: every pay scope × employment × housing × badge setting"
```

---

### Task 5: LinkedIn page shapes

**Files:**
- Create: `tests/scrape.test.mjs`, `tests/fixtures/profiles/NN-*.html`, `tests/fixtures/profiles/NN-*.expect.json`

**Interfaces:**
- Consumes: `createWorld`, `loadContent`, `loadBackground`, `settle`, `sent` (Task 1).
- `.expect.json` shape: `{ "url"?: string, "entries": [{ "kind": "exp"|"edu", "first": "<first line>", "group"?: string, "company"?: string }] }`. `entries` lists every entry `findEntries()` must return, in order, and no others.

Every HTML file uses this skeleton. Only the `<ul>` items change:
```html
<html><head><title>Test Person | LinkedIn</title></head><body><main>
<section><div><h2>Experience</h2></div><ul>
  <!-- items -->
</ul></section>
<section><div><h2>Education</h2></div><ul>
  <li componentkey="entity-collection-item-edu1"><div><p>University of California, Irvine</p><p>Bachelor of Science - BS, Computer Science</p><p>Sep 2022 - Jun 2026</p></div></li>
</ul></section>
</main></body></html>
```
The markup for a single role is `<li componentkey="entity-collection-item-X"><div><p>TITLE</p><p>COMPANY · TYPE</p><p>DATES</p><p>LOCATION</p></div></li>`.

- [ ] **Step 1: Write the page fixtures**

| File | Items / variation | Expected entries (`kind first · group · company`) |
|---|---|---|
| 01-single-role | Software Engineer Intern · Acme Robotics · Internship · Jun 2025 - Sep 2025 · 4 mos · San Jose, California, United States | exp "Software Engineer Intern" · "" · "Acme Robotics"; edu "University of California, Irvine" |
| 02-grouped-roles | outer `<li componentkey="entity-collection-item-g">` with `<div><p>Amazon</p><p>2 yrs 1 mo</p></div><ul>` containing two nested items: SDE II / Jan 2025 - Present · 9 mos / Seattle, WA and SDE I / Sep 2023 - Dec 2024 · 1 yr 4 mos | exp "SDE II" · "Amazon · 2 yrs 1 mo" · "Amazon"; exp "SDE I" · same · "Amazon"; edu |
| 03-group-flat | no nesting: `<li componentkey="entity-collection-item-h"><div><p>Google</p><p>Full-time · 3 yrs</p></div></li>` then sibling items with only TITLE / DATES: Software Engineer II / Jan 2024 - Present; Software Engineer / Sep 2022 - Dec 2023 | both exp with group "Google · Full-time · 3 yrs", company "Google"; edu |
| 04-part-time-no-location | Teaching Assistant · UC Irvine · Part-time · Jan 2025 - Jun 2025 (no location `<p>`) | exp "Teaching Assistant" · "" · "UC Irvine"; edu |
| 05-club | Treasurer · Robotics Club at UCI · Sep 2023 - Present | exp "Treasurer" · "" · "Robotics Club at UCI"; edu |
| 06-everyday-jobs | Barista · Starbucks · Part-time · Jun 2021 - Aug 2022; Data Analyst Intern · Starbucks · Internship · Jun 2024 - Sep 2024 | only exp "Data Analyst Intern"; edu |
| 07-incoming-role | Incoming Software Engineer Intern · Acme Robotics · Internship · Jun 2027 - Sep 2027 | exp "Incoming Software Engineer Intern"; edu |
| 08-education-late | as 01 but **no Education section** in the HTML (the test appends it) | exp "Software Engineer Intern" |
| 09-details-page | `url: https://www.linkedin.com/in/test-person/details/experience/`, Experience section only, two single roles | both exp, no edu |
| 10-year-only-dates | Software Engineer · Acme Robotics · Full-time · 2023 - 2024 | exp "Software Engineer"; edu |
| 11-volunteering-ignored | as 01, plus `<section><div><h2>Volunteering</h2></div><ul>` with Tutor · Girls Who Code · Jan 2023 - Present | same as 01 (no Tutor) |
| 12-existing-pw-row | as 01, with `<div class="pw-row"><span class="pw-chip">$45/hr</span></div>` already inside the role's `<div>` | same as 01 |

- [ ] **Step 2: Write `tests/scrape.test.mjs`**

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createWorld, REPO } from "./harness.mjs";

const dir = path.join(REPO, "tests/fixtures/profiles");
const GENERIC = (prompt) => {
  const n = (prompt.match(/^#\d+$/gm) || []).length;
  return Array.from({ length: n }, (_, i) => ({
    i, role: "Role", company: "Acme Robotics", location: "San Jose, CA", is_internship: false, pay_amount: 30, pay_period: "hour",
    employment: "part-time", currency: "USD", pay_scope: "company", pay_basis: "test", tier: "C", category: "Private co",
    verified: true, larp: false, unpaid: false, skip: false,
  }));
};
const EDU = (prompt) => (prompt.match(/^#\d+$/gm) || []).map((_, i) => ({ i, tier: "A", label: "UC", level: "undergrad", tier_reason: "Strong UC CS program." }));
const EDU_HTML = `<section><div><h2>Education</h2></div><ul><li componentkey="entity-collection-item-edu1"><div><p>University of California, Irvine</p><p>Bachelor of Science - BS, Computer Science</p><p>Sep 2022 - Jun 2026</p></div></li></ul></section>`;

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".html")).sort()) {
  const html = fs.readFileSync(path.join(dir, file), "utf8");
  const exp = JSON.parse(fs.readFileSync(path.join(dir, file.replace(".html", ".expect.json")), "utf8"));
  const url = exp.url || "https://www.linkedin.com/in/test-person/";

  test(`${file}: findEntries`, () => {
    const w = createWorld();
    const { api } = w.loadContent(html, { url });
    const got = api.findEntries().map((e) => ({ kind: e.kind, first: e.text.split("\n")[0], group: e.group, company: api.parseHint(e).company }));
    const want = exp.entries.map((e) => ({ kind: e.kind, first: e.first, ...(e.group != null && { group: e.group }), ...(e.company != null && { company: e.company }) }));
    assert.equal(got.length, want.length, `entries found: ${JSON.stringify(got)}`);
    got.forEach((g, i) => assert.deepEqual(Object.fromEntries(Object.keys(want[i]).map((k) => [k, g[k]])), want[i]));
    w.dispose();
  });

  test(`${file}: full scan puts badges under every entry`, async () => {
    const w = createWorld({ gemini: { lookup: GENERIC, edu: EDU } });
    w.loadBackground();
    const page = w.loadContent(html, { url });
    await w.settle();
    const rows = [...page.document.querySelectorAll(".pw-row")].filter((r) => !r.hidden && r.textContent.trim());
    const labelled = rows.filter((r) => !/checking/.test(r.textContent));
    assert.equal(labelled.length, exp.entries.length);
    assert.deepEqual([w.unexpected, w.uncaught, w.unhandled, w.logs], [[], [], [], []]);
    w.dispose();
  });
}

test("education arrives late: lookups wait and include it", async () => {
  const html = fs.readFileSync(path.join(dir, "08-education-late.html"), "utf8");
  const w = createWorld({ gemini: { lookup: GENERIC, edu: EDU } });
  w.loadBackground();
  const page = w.loadContent(html);
  await new Promise((r) => setTimeout(r, 20)); // < 3s scaled (60ms)
  page.document.querySelector("main").insertAdjacentHTML("beforeend", EDU_HTML);
  await w.settle();
  const lookups = w.sent.filter((m) => m.type === "pw:lookup" && m.kind === "exp");
  assert.ok(lookups.length > 0, "no job lookups sent");
  for (const m of lookups) assert.match(m.profile.education, /University of California, Irvine/);
  w.dispose();
});
```
For 12-existing-pw-row: `rowFor()` reuses the pre-existing `.pw-row`, so the count of labelled rows still equals the number of entries.

- [ ] **Step 3: Run the tests and triage**

Run: `node --test tests/scrape.test.mjs`. Triage as in Task 3 Step 7:
- A markup mistake gets fixed in the HTML.
- A real bug gets a `todo` with the reason, recorded under `## Known bugs found`.

The known quirk to check: for grouped roles, `parseHint(e).type` is the group's length ("2 yrs 1 mo"), not an employment type. Add an assertion that `parseHint` of 02's first entry has `type` equal to `""` or an employment type. If it fails, record it.

- [ ] **Step 4: Commit**

```bash
git add tests/scrape.test.mjs tests/fixtures/profiles docs/superpowers/plans/2026-09-29-robustness-tests.md
git commit -m "Scrape tests: 12 LinkedIn page shapes + full scans + late Education"
```

---

### Task 6: Dead-context lifecycle

**Files:**
- Create: `tests/lifecycle.test.mjs`

**Interfaces:**
- Consumes: `createWorld` with `killAt`, `kill`, `events`, `unhandled`, `uncaught`, `logs`; `api.dead` (Task 1).

- [ ] **Step 1: Write the test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createWorld, REPO } from "./harness.mjs";

const html = fs.readFileSync(path.join(REPO, "tests/fixtures/profiles/02-grouped-roles.html"), "utf8");
const lookup = (p) => (p.match(/^#\d+$/gm) || []).map((_, i) => ({ i, role: "SDE", company: "Amazon", is_internship: false, pay_amount: 180000, pay_period: "year", employment: "full-time", currency: "USD", pay_scope: "company", pay_basis: "test", category: "FAANG", tier: "A", verified: true }));
const edu = (p) => (p.match(/^#\d+$/gm) || []).map((_, i) => ({ i, tier: "A", label: "UC", level: "undergrad", tier_reason: "Strong UC CS program." }));

async function run(killAt) {
  const w = createWorld({ gemini: { lookup, edu } });
  w.killAt = killAt;
  w.loadBackground();
  const page = w.loadContent(html);
  await w.settle();
  // after dying, more DOM churn must not wake it up
  if (w.dead) page.document.querySelector("main").append(page.document.createElement("div"));
  await w.settle();
  const out = { w, page };
  w.dispose();
  return out;
}

test("a normal run makes chrome calls to kill at", async () => {
  const { w } = await run(null);
  assert.ok(w.events > 5, `only ${w.events} events`);
  assert.deepEqual([w.unhandled, w.uncaught, w.logs], [[], [], []]);
});

for (const mode of ["throw", "reject"]) {
  test(`dying at every point (${mode}) never leaves an uncaught error`, async () => {
    const { w: normal } = await run(null);
    const failures = [];
    for (let n = 1; n <= normal.events; n++) {
      const { w, page } = await run({ event: n, mode });
      const problems = [
        ...w.unhandled.map((e) => `unhandled: ${e?.message || e}`),
        ...w.uncaught.map((e) => `uncaught: ${e?.message || e}`),
        ...w.logs.filter((l) => /invalidated/i.test(l)).map((l) => `logged: ${l}`),
      ];
      if (w.dead && !page.api.dead) problems.push("context died but the script didn't shut down");
      if (problems.length) failures.push(`kill before event ${n}: ${problems.join("; ")}`);
    }
    assert.deepEqual(failures, []);
  });
}
```
A killed page whose next chrome call throws inside a place `content.js` doesn't guard would make `page.api.dead` stay false and/or produce `uncaught`. That's exactly what this test is for.

- [ ] **Step 2: Prove it catches the `storage.local.set` bug.** Temporarily remove the `await` from `await chrome.storage.local.set({ [\`edu:${sl}\`]: education });` in `content.js`. Run `node --test tests/lifecycle.test.mjs`. Expected: the `reject` sweep FAILS with `unhandled: Extension context invalidated.` Restore the `await` and run again. Expected: PASS, apart from any new real bugs.

- [ ] **Step 3: Triage.** Every remaining failure is a real bug in `content.js`. Each distinct kill point gets its own `test(\`kill before event N (mode)\`, { todo: "<why>" }, …)` so the sweep itself passes, and goes into `## Known bugs found`. Expected: 0 failures.

- [ ] **Step 4: Commit**

```bash
git add tests/lifecycle.test.mjs docs/superpowers/plans/2026-09-29-robustness-tests.md
git commit -m "Lifecycle tests: kill the extension context at every chrome call"
```

---

### Task 7: Live Gemini eval

**Files:**
- Create: `eval/live.mjs`, `eval/profiles.json`

**Interfaces:**
- Consumes: `runPipeline(fx, { live: true })`, `fixtureProblems(fx, run, { live: true })` (Task 3). Profiles use the same shape as model fixtures, minus `gemini`.

- [ ] **Step 1: Write `eval/profiles.json`.** There are 15 entries; each one is a fixture without `gemini`. In the `expect` column, the numbers are loose ranges:

| name | entry text (group) | expect results[0] |
|---|---|---|
| amazon-sde-intern-seattle | Software Development Engineer Intern / Amazon · Internship / Jun 2025 - Sep 2025 / Seattle, Washington, United States | `category:"FAANG", pay_hourly:{$range:[48,70]}, is_internship:true` |
| meta-e3 | Software Engineer / Meta · Full-time / Jul 2025 - Present / Menlo Park, California, United States | `category:"MANGO", pay_annual:{$range:[185000,195000]}` |
| google-l4 | Software Engineer III / Google · Full-time / Jan 2024 - Present / Mountain View, California, United States | `category:"MANGO", pay_annual:{$range:[230000,320000]}` |
| uci-club | Treasurer / Robotics Club at UCI / Sep 2023 - Present | `unpaid:true, tier:null` |
| club-mts | Member of Technical Staff / AI Club at UCI / Sep 2023 - Present | `larp:true` |
| rivian-swe | Software Engineer / Rivian · Full-time / Jul 2024 - Present / Irvine, California, United States | `category:{$match:"^(Public co|Big Tech)$"}` |
| unknown-startup | Software Engineer Intern / Zentrix Labs · Internship / Jun 2025 - Sep 2025 / Irvine, California, United States | `pay_hourly:{$range:[15,60]}` |
| jane-street-intern | Software Engineer Intern / Jane Street · Internship / Jun 2025 - Aug 2025 / New York, New York, United States | `category:"Quant", tier:"THANOS"` |
| incoming-intern | Incoming Software Engineer Intern / Meta · Internship / Jun 2027 - Sep 2027 | `larp:false, is_internship:true` |
| uci-ta | Teaching Assistant / University of California, Irvine · Part-time / Jan 2025 - Jun 2025 / Irvine, California, United States | `category:"University", pay_hourly:{$range:[18,35]}` |
| barista | Barista / Starbucks · Part-time / Jun 2021 - Aug 2022 | `skip:true` |
| anthropic-mts | Member of Technical Staff / Anthropic · Full-time / Jan 2026 - Present / San Francisco, California, United States | `category:"MANGO", larp:false, tier:"THANOS"` |
| amazon-promotion | two entries in group "Amazon · 2 yrs 1 mo": SDE II / Jan 2025 - Present / Seattle, WA; SDE I / Sep 2023 - Dec 2024 | results 0 `pay_annual:{$range:[220000,280000]}`, 1 `pay_annual:{$range:[160000,190000]}` |
| hexagon-intern | AI/ML Software Engineering Intern / Hexagon Manufacturing Intelligence · Internship / Jun 2026 - Present / San Jose, California, United States · Remote | `pay_hourly:{$range:[30,70]}` |
| toronto-intern | Software Engineer Intern / Shopify · Internship / May 2025 - Aug 2025 / Toronto, Ontario, Canada | `currency:"CAD"` |

- [ ] **Step 2: Write `eval/live.mjs`**

```js
// Runs eval/profiles.json through the real Gemini prompt (GEMINI_API_KEY) and reports
// which invariants / expectations failed. Failing runs are saved to eval/out/ in
// fixture shape so they can be promoted to tests/fixtures/model/.
import fs from "node:fs";
import path from "node:path";
import { REPO } from "../tests/harness.mjs";
import { runPipeline, fixtureProblems } from "../tests/pipeline-run.mjs";

if (!process.env.GEMINI_API_KEY) {
  console.error("Set GEMINI_API_KEY to run the live eval (it makes ~15–30 Gemini calls).");
  process.exit(1);
}
const only = process.argv[2];
const profiles = JSON.parse(fs.readFileSync(path.join(REPO, "eval/profiles.json"), "utf8")).filter((p) => !only || p.name.includes(only));
const outDir = path.join(REPO, "eval/out");
fs.mkdirSync(outDir, { recursive: true });

let failed = 0, calls = 0;
for (const fx of profiles) {
  const run = await runPipeline(fx, { live: true });
  const problems = fixtureProblems(fx, run, { live: true });
  calls += run.world.calls.length;
  const r = run.final.e0 || {};
  const pay = r.pay_annual && !r.is_internship ? `$${Math.round(r.pay_annual / 1000)}K` : r.pay_hourly ? `$${r.pay_hourly}/hr` : "—";
  console.log(`${problems.length ? "FAIL" : "ok  "}  ${fx.name.padEnd(28)} ${String(r.category ?? "").padEnd(14)} ${pay.padEnd(10)} ${r.pay_scope ?? ""}  ${r.pay_basis ?? ""}`.slice(0, 200));
  for (const p of problems) console.log(`        - ${p}`);
  if (problems.length) {
    failed++;
    const gemini = {};
    for (const c of run.world.calls) (gemini[c.kind] ||= []).push(c.text);
    fs.writeFileSync(path.join(outDir, `${fx.name}.json`), JSON.stringify({ ...fx, why: `live eval ${new Date().toISOString().slice(0, 10)}: ${problems[0]}`, gemini }, null, 2));
  }
}
console.log(`\n${profiles.length - failed}/${profiles.length} passed · ${calls} Gemini calls${failed ? " · failures saved to eval/out/" : ""}`);
process.exit(failed ? 1 : 0);
```

- [ ] **Step 3: Run it against a fake key to prove it's wired up.** Run: `GEMINI_API_KEY=invalid npm run eval -- amazon-sde`. Expected: FAIL for `amazon-sde-intern-seattle` with a Gemini API-key error in `response.error`, and a file in `eval/out/`. Delete `eval/out/` afterwards (it's gitignored anyway).

- [ ] **Step 4: Ask the user before the real run.** It costs about 15–30 Gemini calls on their key. If they agree, run `GEMINI_API_KEY=<their key> npm run eval` and paste the table into the task report. Don't run it without asking.

- [ ] **Step 5: Commit**

```bash
git add eval/live.mjs eval/profiles.json
git commit -m "Live eval: 15 fake profiles through real Gemini, same invariants"
```

---

### Task 8: README + finish

**Files:**
- Modify: `README.md` (add a "Testing" section before the license section, or at the end if there isn't one)

- [ ] **Step 1: Add the section**

```markdown
## Testing

`npm install` once, then:

- `npm test` runs the real extension code against fake LinkedIn pages and fake Gemini answers
  (no network, no API key, a few seconds). Every case is checked against the rules in
  `tests/invariants.mjs`: no `NaN`/`undefined` in badges, no "est." next to a blue check,
  clubs unpaid, internships never annualized, and so on.
- `GEMINI_API_KEY=… npm run eval` runs `eval/profiles.json` through the real Gemini prompt
  (~15–30 calls) and saves failing answers to `eval/out/`.

Saw a wrong badge? Save the entry and the model's answer as a file in
`tests/fixtures/model/` (see the others; `"$base": "intern"` fills in the boring fields),
or add a rule to `tests/invariants.mjs`, watch it fail, then fix it.
```

- [ ] **Step 2: Full run.** Run `npm test`. Expected: 0 failures; todos equal the `## Known bugs found` count. Paste the summary lines (`# tests`, `# pass`, `# fail`, `# todo`).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "README: how to run and extend the tests"
```

### Task 9: Fix the known bugs (one commit each)

For each item in `## Known bugs found`, in order:

- [ ] Remove its `knownBug` / `todo`, run its test, and confirm it FAILS for the recorded reason.
- [ ] Use superpowers:systematic-debugging to find the root cause in `background.js` / `content.js`, then make the smallest fix.
- [ ] Run `npm test`: that test passes, nothing else regresses.
- [ ] Commit it alone: `git commit -m "Fix: <what users saw> (<fixture name>)"`.

If a "bug" turns out to be a product decision (for example, whether 13-deep-dive-returns-null should show "pay n/a"), stop and ask the user instead of choosing.

## Known bugs found

(Filled in during Tasks 3–6.)

1. `13-deep-dive-returns-null` — when the deep dive also finds no pay, a real paid job shows "pay n/a". **Product decision** (show n/a, or a labelled rough estimate?) — ask.
2. `24-housing-string-amount` — `housing_amount: "$2,500"` isn't parsed; badge shows "🏠 —/mo housing".
3. `47-hourly-too-high` — an absurd $4000/hr estimate is shown as-is; nothing rejects out-of-range pay.
