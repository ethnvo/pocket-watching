import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { REPO } from "./harness.mjs";
import { mismatches } from "./match.mjs";
import { runPipeline, fixtureProblems } from "./pipeline-run.mjs";

test("mismatches matchers", () => {
  assert.deepEqual(mismatches({ a: 5, b: "x" }, { a: { $range: [1, 9] }, b: { $match: "^x$" }, c: { $absent: true } }), []);
  assert.equal(mismatches({ a: 10 }, { a: { $range: [1, 9] } }).length, 1);
});

const dir = path.join(REPO, "tests/fixtures/model");
for (const file of fs.readdirSync(dir).filter((f) => /^\d+-.*\.json$/.test(f)).sort()) {
  const fx = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  test(`${file}: ${fx.name}`, fx.knownBug ? { todo: fx.knownBug } : {}, async () => {
    const run = await runPipeline(fx);
    assert.deepEqual(fixtureProblems(fx, run), []);
  });
}
