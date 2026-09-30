// Runs eval/profiles.json through the real Gemini prompt (GEMINI_API_KEY) and reports
// which invariants / expectations failed. Failing runs are saved to eval/out/ in
// fixture shape so they can be promoted to tests/fixtures/model/.
import fs from "node:fs";
import path from "node:path";
import { REPO } from "../tests/harness.mjs";
import { runPipeline, fixtureProblems } from "../tests/pipeline-run.mjs";

if (!process.env.GEMINI_API_KEY) {
  console.error("Set GEMINI_API_KEY to run the live eval (it makes ~15–30 Gemini calls).");
  process.exit(1);
}
const only = process.argv[2];
const profiles = JSON.parse(fs.readFileSync(path.join(REPO, "eval/profiles.json"), "utf8")).filter((p) => !only || p.name.includes(only));
const outDir = path.join(REPO, "eval/out");
fs.mkdirSync(outDir, { recursive: true });

let failed = 0, calls = 0;
for (const fx of profiles) {
  const run = await runPipeline(fx, { live: true });
  const problems = fixtureProblems(fx, run, { live: true });
  if (!run.response?.ok) problems.unshift(`lookup failed: ${run.response?.error ?? "no response"}`);
  calls += run.world.calls.length;
  const r = run.final.e0 || {};
  const pay = r.pay_annual && !r.is_internship ? `$${Math.round(r.pay_annual / 1000)}K` : r.pay_hourly ? `$${r.pay_hourly}/hr` : "—";
  console.log(`${problems.length ? "FAIL" : "ok  "}  ${fx.name.padEnd(28)} ${String(r.category ?? "").padEnd(14)} ${pay.padEnd(10)} ${r.pay_scope ?? ""}  ${r.pay_basis ?? ""}`.slice(0, 200));
  for (const p of problems) console.log(`        - ${p}`);
  if (problems.length) {
    failed++;
    const gemini = {};
    for (const c of run.world.calls) (gemini[c.kind] ||= []).push(c.text);
    fs.writeFileSync(path.join(outDir, `${fx.name}.json`), JSON.stringify({ ...fx, why: `live eval ${new Date().toISOString().slice(0, 10)}: ${problems[0]}`, gemini }, null, 2));
  }
}
console.log(`\n${profiles.length - failed}/${profiles.length} passed · ${calls} Gemini calls${failed ? " · failures saved to eval/out/" : ""}`);
process.exit(failed ? 1 : 0);
