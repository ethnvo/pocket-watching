// Pocket Watching — service worker. One Gemini call (with Google Search
// grounding) per batch of experience entries: prestige tier + pay for each.

const DEFAULT_MODEL = "gemini-2.5-flash";
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;      // per-entry results
const SHARED_TTL_MS = 30 * 24 * 60 * 60 * 1000;     // company facts + pay, shared across profiles

// Shared-cache keys: the same company / role+location seen on a different profile
// is fed back to the model as known facts so it doesn't search again.
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const coKey = (company) => `co:${norm(company)}`;
const payKey = (company, title, location, intern) =>
  `pay:${norm(company)}|${norm(title)}|${norm(location)}|${intern ? "intern" : "ft"}`;

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

// Seed the "Known pay" list from seed-pay.json the first time (install or update).
chrome.runtime.onInstalled.addListener(async () => {
  const { knownPay } = await chrome.storage.local.get("knownPay");
  if (knownPay) return;
  const seed = await fetch(chrome.runtime.getURL("seed-pay.json")).then((r) => r.json()).catch(() => []);
  await chrome.storage.local.set({ knownPay: seed });
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
  const keys = entries.map((e) => `v4:${e.key}`);
  const cached = await chrome.storage.local.get(keys);
  const misses = [];
  for (const e of entries) {
    const hit = cached[`v4:${e.key}`];
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) results[e.key] = hit.data;
    else misses.push(e);
  }
  const { knownPay = [] } = await chrome.storage.local.get("knownPay");
  if (!misses.length) return applyKnownPay(results, entries, knownPay);

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
    if (k) facts.push(`${k.company}${k.role ? ` (${k.role})` : ""}: pay is ${k.hourly ? `$${k.hourly}/hr` : `$${k.annual}/yr`} — reported directly, exact.`);
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
  3. Internships: report the HOURLY rate as the primary figure (pay_hourly) plus pay_monthly (hourly × 173). Don't annualize interns; set pay_annual null.
  4. Full-time: report median BASE annual salary (pay_annual) and pay_hourly = annual / 2080.
  5. Founder/self-employed/volunteer/unpaid: pay fields null, explain in pay_basis.

C) PRESTIGE TIER — how impressive/selective THIS SPECIFIC ROLE at THIS company is. The role matters as much as the company: rate the seat, not the logo.
  THANOS = the absolute peak: core roles at top quant/HFT/prop firms (Jane Street, Citadel/Citadel Securities, Hudson River Trading, Jump, Two Sigma, DE Shaw, Optiver, IMC, SIG, Five Rings, Radix, Tower) — quant trader, quant researcher, quant dev, SWE; research scientist/engineer at frontier AI labs (OpenAI, Anthropic, Google DeepMind).
  S = elite & hyper-selective: SWE/eng at frontier AI labs or the hottest top startups, MBB consulting, elite rotational APM programs (Google APM, Meta RPM), top-bucket IB.
  A = strong core roles at Big Tech / top unicorns: SWE/ML/eng at Google, Meta, Apple, Nvidia, Netflix, Microsoft, Amazon, Stripe, Databricks, etc.
  B = good but not elite: non-core or less-selective roles at big tech (e.g. a product/PM or program-manager internship at Amazon is B, not A), core roles at well-known large companies (Visa, Salesforce, Adobe, big banks' tech), Big 4.
  MID = decent: solid respectable job that isn't impressive — mid-size/regional companies, defense contractors, non-tech corporate roles, funded startups with no notable brand.
  C = weak signal: lesser-known startups/small companies, or a peripheral role anywhere.
  D = unknown/tiny company, non-selective or unrelated role.
  Non-core functions (ops, program/project management, sales, support, marketing, HR, IT) usually rank 1-2 tiers below the company's core engineering/trading seat. Founder: rate on the startup's traction/funding (default C if unknown).

D) VERIFICATION — verified=true if the company is well known or you confirmed it exists, AND the pay figure is grounded in real data you know or found (for unpaid roles, just the org). verified=false if the company is too obscure to confirm or you're guessing the pay; say what's missing in verify_note.

E) CATEGORY — pick exactly one:
  "FAANG" = Meta, Apple, Amazon (incl. AWS, Amazon Music, etc.), Netflix, Google/Alphabet.
  "FAANG+" = the other megacap tech peers: Microsoft, Nvidia, Tesla, LinkedIn.
  "FAANG-lite" = top-paying, prestigious tech one step below: Airbnb, Uber, Lyft, Snap, Pinterest, DoorDash, Coinbase, Robinhood, Databricks, Snowflake, Palantir, Roblox, Figma, Discord, Scale AI, etc.
  "AI Lab" = frontier AI labs: OpenAI, Anthropic, Google DeepMind, xAI, Mistral.
  "Quant" = quant trading / HFT / prop / market makers: Jane Street, Citadel Securities, HRT, Jump, Optiver, IMC, SIG, Five Rings, Tower, DRW.
  "Hedge Fund" = hedge funds & multi-managers: Citadel, Two Sigma, DE Shaw, Bridgewater, Millennium, Point72, Renaissance.
  "Fintech" = payments/financial tech: Visa, Mastercard, PayPal, Stripe, Block, Plaid, Ramp, Brex, Chime, Affirm.
  "Big Tech" = large established tech not above: Oracle, IBM, Salesforce, Adobe, Intel, Cisco, AMD, Qualcomm, ServiceNow, Workday.
  "Unicorn" = private startup valued at $1B+ not listed above.
  "Startup" = other startups (set stage when known).
  "Bank", "Consulting", "Defense", "Public co" (other public companies), "Private co", "University", "Government", "Nonprofit", "Student org", "Volunteer", "Self-employed".
  stage: for Startup only (not Unicorn), e.g. "Pre-seed", "Seed", "Series A", "Series B"; otherwise null.

Respond with ONLY a JSON array (no markdown fences), one object per entry, in the same order:
[{
  "i": number,                         // entry index
  "role": string,
  "company": string,
  "location": string | null,
  "is_internship": boolean,
  "pay_hourly": number | null,
  "pay_monthly": number | null,
  "pay_annual": number | null,
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
  for (const item of arr) {
    const e = misses[item?.i];
    if (!e) continue;
    results[e.key] = item;
    toStore[`v4:${e.key}`] = { at: Date.now(), data: item };

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
  return applyKnownPay(results, entries, knownPay);
}

// ---------- Known (user-reported) pay: always wins over the model's estimate ----------

function findKnownPay(list, company, title) {
  const c = norm(company);
  if (!c) return null;
  return (
    list.find((k) => norm(k.company) === c && k.role && norm(title).includes(norm(k.role))) ||
    list.find((k) => norm(k.company) === c && !k.role) ||
    list.find((k) => norm(k.company) === c) ||
    null
  );
}

function applyKnownPay(results, entries, list) {
  if (!list.length) return results;
  for (const e of entries) {
    const r = results[e.key];
    if (!r) continue;
    const k = findKnownPay(list, e.hint?.company || r.company, e.hint?.title || r.role);
    if (!k) continue;
    const intern = k.intern ?? r.is_internship;
    const hourly = k.hourly ?? (k.annual ? Math.round(k.annual / 2080) : null);
    results[e.key] = {
      ...r,
      unpaid: false,
      is_internship: intern,
      pay_hourly: hourly,
      pay_monthly: intern && hourly ? Math.round(hourly * 173) : null,
      pay_annual: intern ? null : k.annual ?? (hourly ? hourly * 2080 : null),
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
