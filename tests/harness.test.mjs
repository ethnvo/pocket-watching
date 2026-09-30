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
