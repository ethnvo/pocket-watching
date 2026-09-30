import test from "node:test";
import assert from "node:assert/strict";
import { createWorld, contentUtils } from "./harness.mjs";

// Results cached before the 2026-09-29 pay fixes ("$2,500" housing, $4000/hr) must not
// be served or fed back into prompts.
const text = "Software Engineer Intern\nAcme Robotics · Internship\nJun 2025 - Sep 2025\nSan Jose, California, United States";
const answer = [{ i: 0, role: "Software Engineer Intern", company: "Acme Robotics", location: "San Jose, CA", is_internship: true, pay_amount: 45, pay_period: "hour", employment: "internship", currency: "USD", pay_scope: "company", pay_basis: "Glassdoor", category: "Private co", tier: "C", verified: true }];
const staleJob = { at: Date.now(), data: { pay_hourly: 4000, pay_scope: "company" } };
const staleFact = { at: Date.now(), location: "Seattle, WA", hourly: 4000, period: "hour", fact: "Software Engineer Intern at Acme Robotics: $4000/hr intern" };

test("results cached before the pay fixes are looked up again", async () => {
  const w = createWorld({ gemini: { lookup: [answer] }, local: { "v26:e0": staleJob } });
  w.loadBackground();
  const resp = await w.message({ type: "pw:lookup", kind: "exp", entries: [{ key: "e0", text, group: "", hint: contentUtils().api.parseHint({ text, group: "" }) }], profile: {} });
  await w.settle();
  assert.equal(resp.results.e0.pay_hourly, 45);
  assert.equal(w.calls.filter((c) => c.kind === "lookup").length, 1);
  w.dispose();
});

test("pay facts learned before the fixes aren't fed back into the prompt", async () => {
  const w = createWorld({ gemini: { lookup: [answer] }, local: { "pay2:acme robotics|software engineer intern|seattle wa|intern": staleFact } });
  w.loadBackground();
  await w.message({ type: "pw:lookup", kind: "exp", entries: [{ key: "e0", text, group: "", hint: contentUtils().api.parseHint({ text, group: "" }) }], profile: {} });
  await w.settle();
  assert.doesNotMatch(w.calls[0].prompt, /4000/);
  w.dispose();
});

test("updating the extension deletes the stale entries", async () => {
  const w = createWorld({ local: { "v26:e0": staleJob, "pay2:x|y|z|intern": staleFact, keep: 1 } });
  w.loadBackground();
  await w.bg.installed();
  assert.deepEqual(Object.keys(w.local).filter((k) => /^(v26|pay2):/.test(k)), []);
  assert.equal(w.local.keep, 1);
  w.dispose();
});

test("Settings → Estimates reads the same cache version as the background", async () => {
  const { read } = await import("./harness.mjs");
  const version = (f) => read(f).match(/const JOB_CACHE = "(v\d+:)"/)[1];
  assert.equal(version("options.js"), version("background.js"));
});
