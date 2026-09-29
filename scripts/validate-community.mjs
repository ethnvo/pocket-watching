// Validates community-pay.json. Run: node scripts/validate-community.mjs
import { readFileSync } from "node:fs";

const FILE = new URL("../community-pay.json", import.meta.url);
const ALLOWED = new Set(["company", "role", "location", "hourly", "monthly", "annual", "housing", "housing_period", "intern", "source", "reference", "contributor"]);
const RANGES = { hourly: [10, 400], monthly: [1000, 60000], annual: [20000, 3000000] };

let rows;
try {
  rows = JSON.parse(readFileSync(FILE, "utf8"));
} catch (e) {
  console.error(`community-pay.json isn't valid JSON: ${e.message}`);
  process.exit(1);
}
if (!Array.isArray(rows)) {
  console.error("community-pay.json must be a JSON array of offers.");
  process.exit(1);
}

const errors = [];
const seen = new Set();
rows.forEach((r, i) => {
  const at = `Entry ${i + 1}${r?.company ? ` (${r.company})` : ""}`;
  if (!r || typeof r !== "object") return errors.push(`${at}: must be an object.`);
  for (const k of Object.keys(r)) if (!ALLOWED.has(k)) errors.push(`${at}: unknown field "${k}".`);
  for (const k of ["company", "role", "location", "source"])
    if (typeof r[k] !== "string" || !r[k].trim()) errors.push(`${at}: "${k}" is required text.`);
  if (typeof r.intern !== "boolean") errors.push(`${at}: "intern" must be true or false.`);
  const pays = ["hourly", "monthly", "annual"].filter((k) => r[k] != null);
  if (pays.length !== 1) errors.push(`${at}: give exactly one of "hourly", "monthly" or "annual".`);
  for (const k of pays) {
    const [lo, hi] = RANGES[k];
    if (typeof r[k] !== "number" || r[k] < lo || r[k] > hi) errors.push(`${at}: "${k}" should be a number between ${lo} and ${hi}.`);
  }
  if (r.monthly != null && r.intern === false) errors.push(`${at}: monthly pay is for internships; use "annual" (total comp) for full-time.`);
  if (r.housing != null && (typeof r.housing !== "number" || r.housing <= 0)) errors.push(`${at}: "housing" must be a positive number.`);
  if (r.housing != null && !["month", "total"].includes(r.housing_period)) errors.push(`${at}: "housing_period" must be "month" or "total".`);
  if (r.reference != null && typeof r.reference !== "boolean") errors.push(`${at}: "reference" must be true or false.`);
  const id = [r.company, r.role, r.location, r.source].map((x) => String(x).toLowerCase().trim()).join("|");
  if (seen.has(id)) errors.push(`${at}: duplicate of an earlier entry.`);
  seen.add(id);
});

if (errors.length) {
  console.error(`community-pay.json has ${errors.length} problem${errors.length === 1 ? "" : "s"}:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
console.log(`community-pay.json looks good (${rows.length} offers).`);
