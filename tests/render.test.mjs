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
          problems.push(...renderProblems(entry, r, row, badges).map((p) => `${at} ${p}`));
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
