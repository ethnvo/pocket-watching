import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createWorld, REPO } from "./harness.mjs";

const html = fs.readFileSync(path.join(REPO, "tests/fixtures/profiles/02-grouped-roles.html"), "utf8");
const ok = (p) => (p.match(/^#\d+$/gm) || []).map((_, i) => ({ i, role: "SDE", company: "Amazon", is_internship: false, pay_amount: 180000, pay_period: "year", employment: "full-time", currency: "USD", pay_scope: "company", pay_basis: "test", category: "FAANG", tier: "A", verified: true }));
const edu = (p) => (p.match(/^#\d+$/gm) || []).map((_, i) => ({ i, tier: "A", label: "UC", level: "undergrad", tier_reason: "Strong UC CS program." }));
const zero = { status: 429, error: "Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-2.5-flash" };

test("switching model in Settings retries in the open LinkedIn tab (no page reload)", async () => {
  // gemini-2.5-flash has no quota for this key; anything else works
  const w = createWorld({ sync: { model: "gemini-2.5-flash" }, gemini: { lookup: (p, n) => w.sync.model === "gemini-2.5-flash" ? zero : ok(p), edu } });
  w.loadBackground();
  const page = w.loadContent(html);
  await w.settle();
  const text = () => page.document.body.textContent;
  assert.match(text(), /Gemini quota/);

  await w.bg.ctx.chrome.storage.sync.set({ model: "gemini-3.8-flash" }); // Settings → Save
  await w.settle();
  assert.doesNotMatch(text(), /Gemini quota/);
  assert.match(text(), /FAANG|\$180K/);
  w.dispose();
});
