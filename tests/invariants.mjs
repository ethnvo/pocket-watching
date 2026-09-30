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
