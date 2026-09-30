import fs from "node:fs";
import path from "node:path";
import { createWorld, contentUtils, renderRow, REPO } from "./harness.mjs";
import { mismatches } from "./match.mjs";
import { resultProblems, renderProblems } from "./invariants.mjs";

export const DEFAULT_PROFILE = {
  name: "Test Person",
  headline: "CS @ UCI",
  education: "University of California, Irvine\nBachelor of Science - BS, Computer Science\nSep 2022 - Jun 2026",
};
const BASES = JSON.parse(fs.readFileSync(path.join(REPO, "tests/fixtures/model/_bases.json"), "utf8"));

export function expandAnswer(a) {
  if (Array.isArray(a)) return a.map(expandAnswer);
  if (a && typeof a === "object" && a.$base) {
    const { $base, ...rest } = a;
    if (!BASES[$base]) throw new Error(`Unknown $base "${$base}"`);
    return { ...BASES[$base], ...rest };
  }
  return a;
}

export async function runPipeline(fx, { live = false } = {}) {
  const world = createWorld({
    gemini: live ? "live" : Object.fromEntries(Object.entries(fx.gemini || {}).map(([k, list]) => [k, list.map(expandAnswer)])),
    sync: { ...(live ? { apiKey: process.env.GEMINI_API_KEY } : {}), ...fx.sync },
    local: { knownPay: fx.knownPay || [], knownCompanies: fx.knownCompanies || [], ...fx.local },
    community: fx.community ?? (live ? "bundled" : []),
  });
  const bg = world.loadBackground();
  const entries = fx.entries.map((e, i) => {
    const text = e.text, group = e.group || "";
    return { key: `e${i}`, kind: fx.kind || "exp", text, group, hint: e.hint || contentUtils().api.parseHint({ text, group }) };
  });
  const response = await world.message({
    type: "pw:lookup", kind: fx.kind || "exp",
    entries: entries.map(({ kind, ...e }) => e),
    profile: { ...DEFAULT_PROFILE, ...fx.profile },
  });
  await world.settle({ timeout: live ? 180000 : 5000 });
  const first = response?.ok ? response.results : {};
  const final = { ...first };
  for (const m of world.tabMessages) if (m.type === "pw:refined") final[m.key] = m.data;
  world.dispose();
  return { world, bg, entries, response, first, final };
}

export function fixtureProblems(fx, run, { live = false } = {}) {
  const { world } = run;
  const problems = [...world.unexpected, ...world.uncaught.map(String), ...world.unhandled.map(String)];
  if (!live) {
    for (const [kind, q] of Object.entries(world.gemini)) if (Array.isArray(q) && q.length) problems.push(`${q.length} unused ${kind} answer(s)`);
  }
  if (fx.expect?.response) problems.push(...mismatches(run.response, fx.expect.response, "response"));
  for (const [i, exp] of Object.entries(fx.expect?.results || {})) problems.push(...mismatches(run.final[`e${i}`], exp, `results[${i}]`));
  for (const [kind, n] of Object.entries(fx.expect?.calls || {})) {
    const got = world.calls.filter((c) => c.kind === kind).length;
    if (got !== n) problems.push(`calls.${kind}: expected ${n}, got ${got}`);
  }
  const all = run.entries.map((entry) => ({ entry, r: run.final[entry.key] })).filter((x) => x.r);
  for (const { entry, r } of all) {
    if (r.refining) problems.push(`[${entry.key}] still refining after everything settled`);
    problems.push(...resultProblems(entry, r, all).map((p) => `[${entry.key}] ${p}`));
    problems.push(...renderProblems(entry, r, renderRow(entry, r)).map((p) => `[${entry.key}] render: ${p}`));
  }
  // a fixture can accept a problem that's the intended outcome (e.g. pay n/a when every call failed)
  const allowed = (fx.allow || []).map((a) => new RegExp(a, "i"));
  return problems.filter((p) => !allowed.some((re) => re.test(p)));
}
