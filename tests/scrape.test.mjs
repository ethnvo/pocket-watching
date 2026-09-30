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

test("grouped roles: parseHint's type is an employment type, not the group's length", { todo: "parseHint takes the group header's length (\"2 yrs 1 mo\") as the employment type, so grouped intern roles can miss intern-only Known pay" }, () => {
  const html = fs.readFileSync(path.join(dir, "02-grouped-roles.html"), "utf8");
  const w = createWorld();
  const { api } = w.loadContent(html);
  const [first] = api.findEntries();
  assert.match(api.parseHint(first).type, /^(|full-time|part-time|internship|contract|self-employed|freelance|seasonal|apprenticeship)$/i);
  w.dispose();
});
