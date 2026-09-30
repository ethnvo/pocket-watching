# Robustness tests: fake profiles, fake model answers, invariants

Date: 2026-09-29 · Status: draft for review

## Goal

Catch the "strange but semi-normal" cases before they show up on a real LinkedIn
profile. Most fixes in this repo's history were of this kind: messy model output
("185k", "annual", company-wide averages, data from the wrong city), classification
rules (clubs, LARP, Rivian as a startup), badge text that contradicts itself (today's
"no pay found for this company" next to a Source line naming the company), and
LinkedIn page shapes (grouped roles, sections that render late, a dead extension
context).

Success looks like this:

- `npm test` runs in seconds with no network and no API key, and exercises the real
  `background.js` and `content.js`, not copies of them.
- Every fixture is checked against a shared set of **invariants**, so a new fixture
  can find bugs nobody wrote an assertion for.
- Adding a case means dropping one JSON or HTML file into `tests/fixtures/`.
- `npm run eval` runs fake profiles through real Gemini on demand and reports rule
  violations. It is never part of `npm test`.

Out of scope: the options page, driving real Chrome (Playwright), and CI setup.
Each can be added later without changing this design.

## Approach

Load the unmodified source files into Node's `vm` with fake browser globals. No
build step, no module split. The Web Store zip is unaffected because
`scripts/package.sh` lists its files explicitly.

The only source change is a test hook at the end of `content.js`'s IIFE:

```js
if (globalThis.__PW_TEST__) globalThis.__PW_TEST__.content = { render, findEntries, scan, results, ... };
```

`background.js` needs no hook: its top-level function declarations become
properties of the vm context.

## Components

### `tests/harness.mjs`

- **Fake `chrome`**: in-memory `storage.local` / `storage.sync` (both the promise
  and the callback forms, plus `onChanged`), `runtime.sendMessage` / `onMessage`
  wired between a background context and a content context, `runtime.getURL`,
  `runtime.lastError`, `runtime.id`, and `action` / `onInstalled` stubs.
- **Dead-context switch**: `harness.kill()` makes every `chrome.*` call throw, and
  `chrome.runtime.id` become undefined, like a reloaded extension. Unhandled promise
  rejections are recorded, and a test fails if any occur.
- **Fake `fetch`**:
  - Gemini URL → returns the next canned answer. Canned answers are matched to the
    request by call kind (main lookup / deep dive / low-pay recheck / education),
    inferred from the prompt text.
  - `chrome.runtime.getURL(...)` files and the community-pay URL → served from disk.
  - Any other URL throws.
- **Loaders**:
  - `loadBackground()` returns a context with every `background.js` function.
  - `loadContent(html, { url })` creates a jsdom page at a LinkedIn URL and runs
    `content.js` in it.
- **`innerText` polyfill**: jsdom doesn't implement it and `findSection()` relies on
  it. The polyfill is `textContent` with a newline at block-element boundaries. This
  is good enough for synthetic markup, and it is a known fidelity gap compared with
  real Chrome.

### `tests/invariants.mjs`

Pure checks on a pipeline result and on rendered badge HTML. Every test runs all of
them. The first set:

1. No rendered text contains `undefined`, `NaN`, `null` or `[object Object]`.
2. A pay tooltip never claims no company data while its Source line names the same
   company.
3. A number never carries both an `est.`/`approx.` label and a blue check.
4. A real paid job (not unpaid, not skipped) never shows pay as n/a. The result has
   `pay_hourly` or `pay_annual`.
5. Sanity ranges: US hourly pay $7–$250; full-time total comp $30K–$1.5M; housing
   within `HOUSING_MAX`.
6. Internships are never annualized: `is_internship` means `pay_annual == null`.
7. Clubs and student orgs are unpaid, get no tier, and are never flagged LARP.
   Incoming roles are never LARP.
8. Several roles at the same company: the earlier role's total comp is ≤ the later
   one's (full-time only).
9. When housing is shown, it has a label (a check, a community check, or est./edited).
10. Tiers are shown only for THANOS / S / A.

Adding a new rule is the main way the suite grows.

### Fixtures

- `tests/fixtures/model/*.json`, about 40 files, run through the pipeline. Each file
  holds:
  - the scraped entries and profile (the same shape the content script sends);
  - the canned Gemini answer(s), raw text included, so fences, prose and truncated
    JSON can be tested;
  - optional `knownPay` / `community` / `knownCompanies` data;
  - optional `expect`: exact field values for this case.

  The first batch comes from the commit history: amounts as strings or `k`
  suffixes; periods written as annual/yearly/tc/missing; a monthly salary quoted as
  hourly; a company-wide internship average; data from SF for a San Jose role; a
  wrong-city median fallback; housing with no period or above the maximum; a full-time
  role reported as hourly; promotions whose total comp is inverted; Facebook
  vs. Meta aliases; a public company labelled Startup; Unicorn with no valuation;
  a club with pay; an incoming intern flagged LARP; non-US currency; a model answer
  wrapped in ```json fences with trailing prose; an empty array; fewer items than
  entries; a model HTTP error.
- `tests/fixtures/profiles/*.html`, about 12 files of synthetic LinkedIn Experience
  and Education markup that uses the real structural hooks
  (`[componentkey^="entity-collection-item"]`, section headings, date lines). Cases:
  single role; grouped roles under one company; a group with no company line; a
  part-time job with no location; a club; an everyday job (skipped); an incoming role;
  the Education section rendering after Experience; the `/details/experience/` page;
  non-English month names absent; duplicated visually-hidden text; our own `.pw-row`
  already present.
  Each file has a sibling `.expect.json` listing the expected entries (kind, group,
  first line).

### Tests

- `tests/pipeline.test.mjs` runs each model fixture: background `lookup()` with the
  canned answers, then `expect` plus all result invariants. It also checks that
  refinement (deep dive / recheck) is triggered and applied when the fixture
  provides those answers.
- `tests/render.test.mjs` takes each pipeline result into the real `render()`, then
  checks the chip text and `data-tip` values plus all rendering invariants. It covers
  every `pay_scope` × employment type × housing scope combination and the badge
  settings on/off.
- `tests/scrape.test.mjs` runs each profile HTML through the real `findEntries()`
  and compares against `.expect.json`. It also runs a full `scan()` with the fake
  background wired up and asserts that badges appear under the right entries.
- `tests/lifecycle.test.mjs` kills the context at each await point during
  `scan()`, and between messages, and asserts there is no unhandled rejection,
  that the observer is disconnected, and that nothing is logged as an error. This
  is the regression test for today's `storage.local.set` bug.

Runner: `node --test` (Node 22, built in). Only dev dependency: `jsdom`. A new
`package.json` (private) holds `"test": "node --test tests/"` and
`"eval": "node eval/live.mjs"`.

### `eval/live.mjs`

- About 15 fake profiles in `eval/profiles.json`: known companies and roles with
  known answers (Amazon SDE intern Seattle, Meta E3, a UCI club, a Rivian SWE, an
  unknown startup, a Jane Street intern, an incoming intern, a TA job, and others).
- Runs the real background `lookup()` with the real `fetch` and `GEMINI_API_KEY`
  from the environment. Refinement is on.
- Applies the same invariants, plus loose per-profile expectations such as "hourly
  between $45 and $65", "category FAANG", "unpaid" or "not LARP".
- Prints a table: profile, pass/fail, which rules failed, and the raw basis. It also
  writes failing model answers to `eval/out/` so they can be promoted into
  `tests/fixtures/model/`.
- Cost: roughly 15–30 calls per run. It prints the usage the extension's own counter
  recorded.

## Workflow when a bad badge appears

1. Capture the entry and the model answer (Estimates browser or `eval/out/`).
2. Save it as a fixture with an `expect`, or add an invariant if it's a general rule.
3. Watch it fail, fix the code, and commit the fixture with the fix.

## Bugs found while building

Bugs the new tests uncover are fixed one per commit, each with its fixture, after
the harness itself lands. They are not bundled into the harness commit.

## Risks

- jsdom vs. Chrome: layout-dependent behaviour (`innerText`, visibility) is
  approximated. Mitigation: keep the scrape fixtures structural, and consider
  Playwright later if page-shape bugs slip through.
- Hook drift: if `content.js` renames functions, the hook breaks loudly. That's
  fine.
- Live eval is nondeterministic. It reports; it doesn't gate.
