// Pocket Watching — service worker. One Gemini call (with Google Search
// grounding) per batch of experience entries: prestige tier + pay for each.

const DEFAULT_MODEL = "gemini-2.5-flash";
// Pay conversions: 40 hrs/week × 52 weeks ÷ 12 months ≈ 173.3 hrs/month, 2080 hrs/year.
// Internship length / which months it runs doesn't matter — a monthly stipend is just
// hourly × 173.3 (and vice versa).
const HOURS_PER_MONTH = (40 * 52) / 12;
const HOURS_PER_YEAR = 40 * 52;

function normalizePay(item) {
  const amt = Number(item.pay_amount);
  const period = item.pay_period;
  if (item.unpaid || !amt || !period) {
    // Backward compat with results that already carry converted fields.
    return item;
  }
  const hourly =
    period === "hour" ? amt : period === "month" ? amt / HOURS_PER_MONTH : amt / HOURS_PER_YEAR;
  return {
    ...item,
    pay_hourly: Math.round(hourly * 100) / 100,
    pay_monthly: item.is_internship ? Math.round(period === "month" ? amt : hourly * HOURS_PER_MONTH) : null,
    pay_annual: item.is_internship ? null : Math.round(period === "year" ? amt : hourly * HOURS_PER_YEAR),
  };
}

const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;      // per-entry results
const SHARED_TTL_MS = 30 * 24 * 60 * 60 * 1000;     // company facts + pay, shared across profiles

// Shared-cache keys: the same company / role+location seen on a different profile
// is fed back to the model as known facts so it doesn't search again.
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const coKey = (company) => `co2:${norm(company)}`;
const payKey = (company, title, location, intern) =>
  `pay:${norm(company)}|${norm(title)}|${norm(location)}|${intern ? "intern" : "ft"}`;

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

// Seed the "Known pay" / "Known companies" lists from the bundled JSON the first time.
chrome.runtime.onInstalled.addListener(async () => {
  const have = await chrome.storage.local.get(["knownPay", "knownCompanies"]);
  const load = (f) => fetch(chrome.runtime.getURL(f)).then((r) => r.json()).catch(() => []);
  if (!have.knownPay) await chrome.storage.local.set({ knownPay: await load("seed-pay.json") });
  if (!have.knownCompanies) await chrome.storage.local.set({ knownCompanies: await load("seed-companies.json") });
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "pw:options") return void chrome.runtime.openOptionsPage();
  if (msg?.type !== "pw:lookup") return;
  limited(() => lookup(msg.entries, msg.profile || {}))
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
  const keys = entries.map((e) => `v6:${e.key}`);
  const cached = await chrome.storage.local.get(keys);
  const misses = [];
  for (const e of entries) {
    const hit = cached[`v6:${e.key}`];
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
  1. Use COMPANY-SPECIFIC pay for that role first: Levels.fyi (including its intern pages), Glassdoor/Indeed company salary pages, H-1B/LCA data, or published intern rates. Big tech intern pay is well documented (e.g. Amazon SDE interns in Seattle earn roughly $50-60/hr) — do NOT substitute a generic market "intern median" when company data exists.
  2. Only if no company data exists, use the market median for that title in that metro, and set pay_scope to "market".
  3. Report the pay figure exactly as your source quotes it — don't convert it yourself. Set pay_amount to that number and pay_period to "hour", "month" or "year" (e.g. an intern stipend quoted as $9,000/month → pay_amount 9000, pay_period "month"). Conversions are done downstream.
  4. Full-time: use median BASE annual salary. Internships: never annualize.
  5. Founder/self-employed/volunteer/unpaid: pay fields null, explain in pay_basis.

C) PRESTIGE TIER — how impressive/selective THIS SPECIFIC ROLE at THIS company is. The role matters as much as the company: rate the seat, not the logo.
  THANOS = the absolute peak: core roles at top quant/HFT/prop firms (Jane Street, Citadel/Citadel Securities, Hudson River Trading, Jump, Two Sigma, DE Shaw, Optiver, IMC, SIG, Five Rings, Radix, Tower) — quant trader, quant researcher, quant dev, SWE; research scientist/engineer at frontier AI labs (OpenAI, Anthropic, Google DeepMind); FOUNDING ENGINEER / first engineers at a legit, VC-backed startup (YC, a16z, Sequoia, etc.) — that seat beats a regular SWE job at big tech.
  S = elite & hyper-selective: SWE/eng at frontier AI labs or the hottest top startups, MBB consulting, elite rotational APM programs (Google APM, Meta RPM), top-bucket IB.
  A = strong core roles at Big Tech / top unicorns: SWE/ML/eng at Google, Meta, Apple, Nvidia, Netflix, Microsoft, Amazon, Stripe, Databricks, etc.
  B = good but not elite: non-core or less-selective roles at big tech (e.g. a product/PM or program-manager internship at Amazon is B, not A), core roles at well-known large companies (Visa, Salesforce, Adobe, big banks' tech), Big 4.
  MID = decent: solid respectable job that isn't impressive — mid-size/regional companies, defense contractors, non-tech corporate roles, funded startups with no notable brand.
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

  const toStore = {};
  for (const raw of arr) {
    const e = misses[raw?.i];
    const item = e ? normalizePay(raw) : raw;
    if (!e) continue;
    results[e.key] = item;
    toStore[`v6:${e.key}`] = { at: Date.now(), data: item };

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
        ? `$${item.pay_hourly}/hr intern`
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
    const hourly = k.hourly ?? (k.monthly ? k.monthly / HOURS_PER_MONTH : k.annual ? k.annual / HOURS_PER_YEAR : null);
    results[e.key] = {
      ...r,
      unpaid: false,
      is_internship: intern,
      pay_hourly: hourly ? Math.round(hourly * 100) / 100 : null,
      pay_monthly: intern && hourly ? Math.round(k.monthly ?? hourly * HOURS_PER_MONTH) : null,
      pay_annual: intern ? null : k.annual ?? (hourly ? Math.round(hourly * HOURS_PER_YEAR) : null),
      currency: k.currency || "USD",
      pay_scope: "reported",
      pay_basis: `Reported pay${k.role ? ` for ${k.role}` : ""} at ${k.company} (from your Known pay list).`,
      verified: true,
    };
  }
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
