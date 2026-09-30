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
  w.loadBackground();
  const page = w.loadContent(html);
  // The context can't die during the script's first synchronous run, only after it.
  const loaded = w.events;
  w.killAt = killAt;
  await w.settle();
  // after dying, more DOM churn must not wake it up
  if (w.dead) page.document.querySelector("main").append(page.document.createElement("div"));
  await w.settle();
  const out = { w, page, loaded };
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
    const { w: normal, loaded } = await run(null);
    const failures = [];
    for (let n = loaded + 1; n <= normal.events; n++) {
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
