// Pocket Watching — service worker. One Gemini call (with Google Search
// grounding) per batch of experience entries: prestige tier + pay for each.

const DEFAULT_MODEL = "gemini-2.5-flash";
// Pay math. Everything is derived from an hourly rate at 40 hrs/week:
//  - paycheck (biweekly)  = hourly × 80
//  - internship total     = hourly × 40 × INTERN_WEEKS  (12 weeks = 6 paychecks)
//  - a quoted "monthly" salary is annual/12 → hourly = monthly × 12 / 2080
// Housing stipends are added on top of the internship total (monthly ones prorated
// over the internship: 12 weeks ≈ 2.77 months).
const HOURS_PER_YEAR = 40 * 52;
const HOURS_PER_PAYCHECK = 80;
const INTERN_WEEKS = 12;
const INTERN_MONTHS = (INTERN_WEEKS * 12) / 52;
const round2 = (n) => Math.round(n * 100) / 100;

function toHourly(amount, period) {
  const a = Number(amount);
  if (!a || !period) return null;
  return period === "hour" ? a : period === "month" ? (a * 12) / HOURS_PER_YEAR : a / HOURS_PER_YEAR;
}

function withPayMath(item, hourly) {
  if (item.unpaid || !hourly) return item;
  const out = { ...item, pay_hourly: round2(hourly), pay_paycheck: Math.round(hourly * HOURS_PER_PAYCHECK) };
  if (item.is_internship) {
    const housing = Number(item.housing_amount) || 0;
    const housingTotal = item.housing_period === "month" ? housing * INTERN_MONTHS : housing;
    out.pay_annual = null;
    out.pay_total = Math.round(hourly * 40 * INTERN_WEEKS);
    out.housing_total = Math.round(housingTotal) || null;
    out.total_with_housing = Math.round(out.pay_total + housingTotal);
  } else {
    out.pay_annual = Math.round(item.pay_period === "year" ? Number(item.pay_amount) : hourly * HOURS_PER_YEAR);
  }
  return out;
}

const ELITE = /^(FAANG|FAANG-adjacent|FAANG\+|AI Lab|Quant|Hedge Fund)$/;
const ENG_ROLE = /engineer|developer|\bsde\b|\bswe\b|software|quant|research/i;

function normalizePay(item) {
  const out = withPayMath(item, toHourly(item.pay_amount, item.pay_period));
  if (out.is_internship && ELITE.test(out.category || "") && ENG_ROLE.test(out.role || "") && out.pay_hourly && out.pay_hourly < 35) {
    out.verified = false;
    out.verify_note = `$${out.pay_hourly}/hr is far below typical pay for this role here — likely an all-roles average. Add the real number under Known pay.`;
  }
  return out;
}

const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;      // per-entry results
const SHARED_TTL_MS = 30 * 24 * 60 * 60 * 1000;     // company facts + pay, shared across profiles

// Shared-cache keys: the same company / role+location seen on a different profile
// is fed back to the model as known facts so it doesn't search again.
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const coKey = (company) => `co2:${norm(company)}`;
const payKey = (company, title, location, intern) =>
  `pay2:${norm(company)}|${norm(title)}|${norm(location)}|${intern ? "intern" : "ft"}`;

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

// Seed the "Known pay" / "Known companies" lists from the bundled JSON the first time.
chrome.runtime.onInstalled.addListener(async () => {
  const have = await chrome.storage.local.get(["knownPay", "knownCompanies", "seededIds"]);
  const load = (f) => fetch(chrome.runtime.getURL(f)).then((r) => r.json()).catch(() => []);
  const id = (k) => `${norm(k.company)}|${norm(k.role)}`;
  // Seed rows carry an optional version "v"; bumping it pushes the new row to existing installs.
  const seedId = (k) => `${id(k)}@${k.v || 1}`;
  const seeded = new Set(have.seededIds || []);
  // Add seed rows that were never seeded before (a row you deleted stays deleted).
  const merge = (list = [], seed) => {
    const out = [...list];
    for (const row of seed) {
      if (seeded.has(seedId(row)) || (!row.v && seeded.has(id(row)))) continue;
      seeded.add(seedId(row));
      const i = out.findIndex((k) => id(k) === id(row));
      if (i >= 0) out[i] = row; else out.push(row);
    }
    return out;
  };
  const knownPay = merge(have.knownPay, await load("seed-pay.json"));
  const knownCompanies = merge(have.knownCompanies, await load("seed-companies.json"));
  await chrome.storage.local.set({ knownPay, knownCompanies, seededIds: [...seeded] });
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "pw:options") return void chrome.runtime.openOptionsPage();
  if (msg?.type !== "pw:lookup") return;
  const job = msg.kind === "edu" ? () => lookupEdu(msg.entries) : () => lookup(msg.entries, msg.profile || {});
  limited(job)
    .then((results) => sendResponse({ ok: true, results }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // async response
});

// Cap concurrent Gemini calls so a long profile doesn't trip free-tier rate limits.
const MAX_CONCURRENT = 5;
let active = 0;
const queue = [];
function limited(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
}
function pump() {
  while (active < MAX_CONCURRENT && queue.length) {
    const { fn, resolve, reject } = queue.shift();
    active++;
    fn().then(resolve, reject).finally(() => {
      active--;
      pump();
    });
  }
}

async function lookup(entries, profile) {
  const results = {};
  const keys = entries.map((e) => `v9:${e.key}`);
  const cached = await chrome.storage.local.get(keys);
  const misses = [];
  for (const e of entries) {
    const hit = cached[`v9:${e.key}`];
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) results[e.key] = hit.data;
    else misses.push(e);
  }
  const { knownPay = [], knownCompanies = [] } = await chrome.storage.local.get(["knownPay", "knownCompanies"]);
  const finish = (r) => applyKnownCompanies(applyKnownPay(r, entries, knownPay), entries, knownCompanies);
  if (!misses.length) return finish(results);

  const { apiKey, model } = await chrome.storage.sync.get(["apiKey", "model"]);
  if (!apiKey) throw new Error("NO_KEY");

  const list = misses
    .map((e, i) => `#${i}\n${e.group ? `[Company group: ${e.group}]\n` : ""}${e.text}`)
    .join("\n\n");

  // Known facts from the shared cache (by the scraped company / title / location).
  const sharedKeys = [];
  for (const e of misses) {
    const h = e.hint || {};
    if (!h.company) continue;
    const intern = /intern|co-?op/i.test(h.type + " " + h.title);
    sharedKeys.push(coKey(h.company), payKey(h.company, h.title, h.location, intern));
  }
  const shared = sharedKeys.length ? await chrome.storage.local.get(sharedKeys) : {};
  const facts = Object.values(shared)
    .filter((v) => v && Date.now() - v.at < SHARED_TTL_MS)
    .map((v) => v.fact);
  for (const e of misses) {
    const k = findKnownPay(knownPay, e.hint?.company, e.hint?.title);
    if (k) facts.push(`${k.company}${k.role ? ` (${k.role})` : ""}: pay is ${k.hourly ? `$${k.hourly}/hr` : k.monthly ? `$${k.monthly}/month` : `$${k.annual}/yr`} — reported directly, exact.`);
    const kc = findKnownCompany(knownCompanies, e.hint?.company);
    if (kc?.note) facts.push(`${kc.company}: ${kc.note}`);
  }
  const knownFacts = facts.length
    ? `KNOWN FACTS from earlier lookups — trust these and don't search for them again:\n${facts.map((f) => "- " + f).join("\n")}\n\n`
    : "";

  const today = new Date().toISOString().slice(0, 10);
  const prompt = `Today is ${today}. Below are job entries scraped from the Experience section of a LinkedIn profile, plus the person's headline and Education section. For EACH entry:

A) Parse: role title, company, location, and the REAL employment type. Don't trust the title alone:
  - Use the Education section (and headline, e.g. "Student at X", "CS @ UCI") to work out when they were/are enrolled. A role held while they were a student — current or past — is almost always an internship, co-op or part-time job even if it's titled "Software Engineer" and not tagged "Internship". Treat it as an internship for pay.
  - LARP: set larp=true when a student (or someone clearly pre-graduation at the time) lists a full-time-sounding title (e.g. "Software Engineer", "Product Manager", "CTO", "Founder & CEO" of something with no real footprint) that is really an internship, part-time gig, club/project, or inflated title. Explain in larp_reason. Don't flag roles already clearly labeled Internship/Intern/Co-op/Part-time.
  - UNPAID: school clubs, student orgs, university project teams, hackathon teams, research-for-credit, volunteering, and personal projects are unpaid — set unpaid=true, pay fields null, category "Student org" (or "Volunteer" for volunteering). Paid university jobs (TA, paid research assistant) are NOT unpaid.

SPEED: Be fast. For well-known companies (big tech, quant firms, major banks, well-known startups) answer from your own knowledge — do NOT search. Only use Google Search for companies or pay you genuinely don't know, and use at most 2 searches total.

B) PAY. Rules, in priority order:
  0. The pay must be for THIS ROLE FAMILY (e.g. software engineering intern), never a company-wide average across all roles/internships (those mix in ops, warehouse, retail, etc. and are far lower). Subsidiaries/teams use the parent's figure for the role (Amazon Music, AWS → Amazon SDE intern pay). If a source says "average pay for <Company> internships" without the role, ignore it.
  1. Use COMPANY-SPECIFIC pay for that role first: Levels.fyi (including its intern pages), Glassdoor/Indeed company salary pages, H-1B/LCA data, or published intern rates. Big tech intern pay is well documented (e.g. Amazon SDE interns in Seattle earn roughly $50-60/hr) — do NOT substitute a generic market "intern median" when company data exists.
  2. Only if no company data exists, use the market median for that title in that metro, and set pay_scope to "market".
  3. Report the pay figure exactly as your source quotes it — don't convert it yourself. Set pay_amount to that number and pay_period to "hour", "month" or "year" (e.g. an intern salary quoted as $9,000/month → pay_amount 9000, pay_period "month"). Conversions are done downstream.
  3b. Internship HOUSING: if the company gives a housing stipend/relocation for interns, set housing_amount and housing_period ("month" for a monthly stipend, "total" for a lump sum). Big tech usually does (e.g. a monthly housing stipend or a lump sum). If none or unknown, null.
  4. Full-time: use median BASE annual salary. Internships: never annualize.
  5. Founder/self-employed/volunteer/unpaid: pay fields null, explain in pay_basis.

C) PRESTIGE TIER — how impressive/selective THIS SPECIFIC ROLE at THIS company is. The role matters as much as the company: rate the seat, not the logo.
  THANOS = the absolute peak: core roles at top quant/HFT/prop firms (Jane Street, Citadel/Citadel Securities, Hudson River Trading, Jump, Two Sigma, DE Shaw, Optiver, IMC, SIG, Five Rings, Radix, Tower) — quant trader, quant researcher, quant dev, SWE; research scientist/engineer at frontier AI labs (OpenAI, Anthropic, Google DeepMind); FOUNDING ENGINEER / first engineers at a legit, VC-backed startup (YC, a16z, Sequoia, etc.) — that seat beats a regular SWE job at big tech.
  S = elite & hyper-selective: SWE/eng at frontier AI labs or the hottest top startups, MBB consulting, elite rotational APM programs (Google APM, Meta RPM), top-bucket IB.
  A = strong, selective core roles at Big Tech / top unicorns: SWE/ML/eng at Google, Meta, Apple, Nvidia, Netflix, Microsoft, Stripe, Databricks, etc.
  B = good but not elite: Amazon SDE/SWE (high-volume hiring, less selective than the rest of FAANG), non-core or less-selective roles at big tech (a PM or program-manager internship at Amazon is B or lower), core roles at well-known large companies (Visa, Salesforce, Adobe, big banks' tech), Big 4.
  MID = decent, RECOGNIZABLE companies: established mid-size/large companies people have heard of, regional names, defense primes, well-funded startups with a real brand. Being verified to exist is not enough — small or obscure private companies and early startups are C.
  C = the DEFAULT for any company that isn't well known — small/lesser-known startups and companies, anything you can't verify — unless a role bump below applies. Also a peripheral role anywhere.
  D = non-selective or unrelated role (e.g. retail, food service) or clearly fake/placeholder company.
  ROLE BUMPS / DROPS:
  - Founding engineer or one of the first ~5 engineers at a verified, VC-backed startup → THANOS. At an unfunded/unverifiable company → C bumped one tier (MID).
  - Founder/co-founder: rate on real traction/funding — top-VC-backed or YC → S/THANOS; unfunded or unknown → C.
  - Non-core functions (ops, program/project management, sales, support, marketing, HR, IT) usually rank 1-2 tiers below the company's core engineering/trading seat.

D) VERIFICATION — verified=true if the company is well known or you confirmed it exists, AND the pay figure is grounded in real data you know or found (for unpaid roles, just the org). verified=false if the company is too obscure to confirm or you're guessing the pay; say what's missing in verify_note.

E) CATEGORY — pick exactly one:
  "FAANG" = Meta, Apple, Amazon (incl. AWS, Amazon Music, etc.), Netflix, Google/Alphabet.
  "FAANG-adjacent" = peers right next to FAANG: Microsoft, Nvidia, Uber, DoorDash, LinkedIn, Tesla.
  "FAANG-lite" = strong, well-paying companies a step below: Capital One, Airbnb, Lyft, Snap, Pinterest, Coinbase, Robinhood, Databricks, Snowflake, Palantir, Roblox, Figma, Discord, Scale AI, Stripe, Instacart, Reddit, Dropbox, etc.
  "AI Lab" = frontier AI labs: OpenAI, Anthropic, Google DeepMind, xAI, Mistral.
  "Quant" = quant trading / HFT / prop / market makers: Jane Street, Citadel Securities, HRT, Jump, Optiver, IMC, SIG, Five Rings, Tower, DRW.
  "Hedge Fund" = hedge funds & multi-managers: Citadel, Two Sigma, DE Shaw, Bridgewater, Millennium, Point72, Renaissance.
  "Fintech" = payments/financial tech: Visa, Mastercard, PayPal, Block, Plaid, Ramp, Brex, Chime, Affirm.
  "Big Tech" = large established tech not above: Oracle, IBM, Salesforce, Adobe, Intel, Cisco, AMD, Qualcomm, ServiceNow, Workday.
  "Unicorn" = private startup valued at $1B+ not listed above.
  "Startup" = other startups (set stage when known).
  "Bank", "Consulting", "Defense", "Public co" (other public companies), "Private co", "University", "Government", "Nonprofit", "Student org", "Volunteer", "Self-employed".
  stage: for Startup only (not Unicorn), and ONLY if you found an actual announced funding round ("Seed", "Series A", "Series B", ...). Unfunded/bootstrapped or unknown → null. Never guess "Pre-seed".

Respond with ONLY a JSON array (no markdown fences), one object per entry, in the same order:
[{
  "i": number,                         // entry index
  "role": string,
  "company": string,
  "location": string | null,
  "is_internship": boolean,
  "pay_amount": number | null,         // as quoted by the source
  "pay_period": "hour" | "month" | "year" | null,
  "housing_amount": number | null,     // interns only
  "housing_period": "month" | "total" | null,
  "currency": string,                  // ISO code, e.g. "USD"
  "pay_scope": "company" | "market",
  "pay_basis": string,                 // one short sentence: what the number is and where it came from
  "tier": "THANOS" | "S" | "A" | "B" | "MID" | "C" | "D",
  "category": string,
  "stage": string | null,
  "larp": boolean,
  "larp_reason": string | null,
  "unpaid": boolean,
  "verified": boolean,
  "verify_note": string | null,
  "tier_reason": string                // one short sentence
}]

PROFILE:
Name: ${profile.name || "(unknown)"}
Headline: ${profile.headline || "(unknown)"}
Education:
${profile.education || "(not visible on this page)"}

${knownFacts}ENTRIES:
${list}`;

  const arr = await callGemini(prompt, apiKey, model);

  const toStore = {};
  for (const raw of arr) {
    const e = misses[raw?.i];
    const item = e ? normalizePay(raw) : raw;
    if (!e) continue;
    results[e.key] = item;
    toStore[`v9:${e.key}`] = { at: Date.now(), data: item };

    // Feed the shared cache (keyed on the scraped hint so the next lookup can find it).
    const h = e.hint || {};
    if (!h.company || !item.company) continue;
    if (item.category) {
      toStore[coKey(h.company)] = {
        at: Date.now(),
        fact: `${item.company}: category ${item.category}${item.stage ? ` (${item.stage})` : ""}${item.verified === false ? ", could not be verified online" : ", verified to exist"}.`,
      };
    }
    if (!item.unpaid && !item.larp && item.pay_scope === "company" && (item.pay_hourly || item.pay_annual)) {
      const intern = /intern|co-?op/i.test(h.type + " " + h.title);
      const pay = item.is_internship
        ? `$${item.pay_hourly}/hr intern${item.housing_amount ? ` + $${item.housing_amount}${item.housing_period === "month" ? "/mo" : " lump-sum"} housing` : ""}`
        : `$${item.pay_annual}/yr base`;
      toStore[payKey(h.company, h.title, h.location, intern)] = {
        at: Date.now(),
        fact: `${item.role} at ${item.company}${item.location ? ` in ${item.location}` : ""}: ${pay} (${item.currency || "USD"}) — ${item.pay_basis || "company data"}.`,
      };
    }
  }
  await chrome.storage.local.set(toStore);
  return finish(results);
}

// ---------- Known (user-reported) pay: always wins over the model's estimate ----------

const sameCompany = (known, scraped) => {
  const k = norm(known), c = norm(scraped);
  return !!k && !!c && (c === k || c.startsWith(k + " "));
};

function findKnownPay(list, company, title) {
  const hits = list.filter((k) => sameCompany(k.company, company));
  return (
    hits.find((k) => k.role && norm(title).includes(norm(k.role))) ||
    hits.find((k) => !k.role) ||
    hits[0] ||
    null
  );
}

function findKnownCompany(list, company) {
  return list.find((k) => sameCompany(k.company, company)) || null;
}

// Known companies: fixed category/stage (e.g. your own startup).
function applyKnownCompanies(results, entries, list) {
  for (const e of entries) {
    const r = results[e.key];
    const k = r && findKnownCompany(list, e.hint?.company || r.company);
    if (!k) continue;
    results[e.key] = {
      ...r,
      ...(k.category ? { category: k.category } : {}),
      stage: k.stage ?? null,
      ...(k.tier ? { tier: k.tier } : {}),
      ...(k.larp === false ? { larp: false, larp_reason: null } : {}),
    };
  }
  return results;
}

function applyKnownPay(results, entries, list) {
  if (!list.length) return results;
  for (const e of entries) {
    const r = results[e.key];
    if (!r) continue;
    const k = findKnownPay(list, e.hint?.company || r.company, e.hint?.title || r.role);
    if (!k) continue;
    const intern = k.intern ?? r.is_internship;
    const hourly = k.hourly ?? toHourly(k.monthly, "month") ?? toHourly(k.annual, "year");
    const base = {
      ...r,
      unpaid: false,
      is_internship: intern,
      pay_amount: k.monthly ?? k.hourly ?? k.annual ?? null,
      pay_period: k.monthly ? "month" : k.hourly ? "hour" : k.annual ? "year" : null,
      ...(k.housing != null ? { housing_amount: k.housing, housing_period: k.housing_period || "month" } : {}),
      currency: k.currency || "USD",
      pay_scope: "reported",
      pay_basis: `Reported pay${k.role ? ` for ${k.role}` : ""} at ${k.company} (from your Known pay list).`,
      verified: true,
    };
    results[e.key] = withPayMath(base, hourly);
  }
  return results;
}

async function callGemini(prompt, apiKey, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model || DEFAULT_MODEL
  )}:generateContent`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: {
        temperature: 0.2,
        // 2.5-series models think by default, which is most of the latency. This task
        // is lookup + judgement, so skip it.
        ...(/^gemini-2\.5-flash/.test(model || DEFAULT_MODEL) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      },
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `Gemini HTTP ${res.status}`);

  const text = (body.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  const arr = parseJsonArray(text);
  if (!arr) throw new Error("Couldn't parse model response");
  return arr;
}

// ---------- Education: school + program prestige ----------

async function lookupEdu(entries) {
  const results = {};
  const cached = await chrome.storage.local.get(entries.map((e) => `school2:${e.key}`));
  const misses = [];
  for (const e of entries) {
    const hit = cached[`school2:${e.key}`];
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) results[e.key] = hit.data;
    else misses.push(e);
  }
  if (!misses.length) return results;

  const { apiKey, model } = await chrome.storage.sync.get(["apiKey", "model"]);
  if (!apiKey) throw new Error("NO_KEY");

  const list = misses.map((e, i) => `#${i}\n${e.text}`).join("\n\n");
  const prompt = `Rate each education entry (scraped from a LinkedIn Education section) for prestige in tech recruiting. BOTH the school and the specific program/major matter — rate the program, not just the logo. Answer from your own knowledge; only search for schools you don't know.

TIERS:
  THANOS = the absolute peak for CS: MIT (EECS/CS), Stanford (CS), Carnegie Mellon (SCS / CS).
  S = elite: UC Berkeley EECS or CS, Caltech, Princeton, Harvard, Cornell, UIUC CS, UW (Allen School) CS, Waterloo CS/SE/CE, Georgia Tech CS, Oxford/Cambridge CS, ETH Zurich.
  A = strong: other top-25 CS programs (e.g. UCLA, UCSD, Michigan, UT Austin, Columbia, Penn, Purdue, Maryland, USC, Wisconsin), or an elite school with a non-CS STEM major.
  B = good: solid top-50 CS programs and strong state flagships, or an elite school with a non-STEM major.
  MID = decent: regional/state universities and less competitive programs.
  C = lesser-known colleges, community colleges, bootcamps.
  D = unaccredited programs, certificate mills.
  Grad programs: rate the grad program itself — a low-selectivity, cash-cow master's is about one tier below that school's undergrad CS. PhDs at top programs rank at the top of their school's tier.
  High school, certificates, courses, and anything that isn't a college degree → tier null.

Respond with ONLY a JSON array (no markdown fences), one object per entry, same order:
[{
  "i": number,
  "school": string,
  "program": string | null,     // major/degree as listed
  "level": "undergrad" | "community college" | "grad" | "phd" | "high school" | "bootcamp" | "other",
  "tier": "THANOS" | "S" | "A" | "B" | "MID" | "C" | "D" | null,
  "label": string | null,       // very short, e.g. "Top 5 CS", "Top 20 CS", "Ivy", "UC", "Community college", "Bootcamp"
  "tier_reason": string         // one short sentence
}]

ENTRIES:
${list}`;

  const arr = await callGemini(prompt, apiKey, model);
  const toStore = {};
  for (const item of arr) {
    const e = misses[item?.i];
    if (!e) continue;
    results[e.key] = item;
    toStore[`school2:${e.key}`] = { at: Date.now(), data: item };
  }
  await chrome.storage.local.set(toStore);
  return results;
}

function parseJsonArray(text) {
  const cleaned = text.replace(/```(?:json)?/g, "");
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
