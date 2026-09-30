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
