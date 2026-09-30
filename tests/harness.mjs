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
// node:test fails the running test on any unhandled rejection. While a world is active we
// record them instead (lifecycle tests count them); otherwise they go to node:test as usual.
let others = [];
function onUnhandled(err, promise) {
  if (current) current.unhandled.push(err);
  else others.forEach((f) => f(err, promise));
}
function claimUnhandled() {
  for (const f of process.listeners("unhandledRejection")) {
    if (f === onUnhandled) continue;
    others.push(f);
    process.removeListener("unhandledRejection", f);
  }
  if (!process.listeners("unhandledRejection").includes(onUnhandled)) process.on("unhandledRejection", onUnhandled);
}

export function geminiKind(prompt) {
  if (/^Find the hourly pay for/.test(prompt)) return "recheck";
  if (/^Find the pay for/.test(prompt)) return "deepDive";
  if (/^Rate each education entry/.test(prompt)) return "edu";
  if (/^Estimate typical pay for/.test(prompt)) return "estimate";
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
  claimUnhandled();
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
