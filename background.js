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

// The model doesn't always return clean numbers: "$185,000", "185k", "annual", "yearly"…
function parseMoney(v) {
  if (typeof v === "number") return v > 0 ? v : null;
  if (typeof v !== "string") return null;
  const m = v.replace(/[, ]/g, "").match(/\$?(\d+(?:\.\d+)?)([kKmM])?/);
  if (!m) return null;
  const n = parseFloat(m[1]) * ({ k: 1e3, m: 1e6 }[(m[2] || "").toLowerCase()] || 1);
  return n > 0 ? n : null;
}
function normPeriod(p) {
  const t = String(p || "").toLowerCase();
  if (/^(hour|hr|hourly|per hour|\/hr)/.test(t)) return "hour";
  if (/^(month|mo|monthly|per month|\/mo)/.test(t)) return "month";
  if (/^(year|yr|yearly|annual|annually|per year|\/yr|tc)/.test(t)) return "year";
  return null;
}
// No usable period: infer it from the size of the number.
const inferPeriod = (n) => (n >= 20000 ? "year" : n >= 1500 ? "month" : n > 0 ? "hour" : null);

// Normalize whatever pay shape the model returned into pay_amount + pay_period.
function cleanPay(item) {
  const amount = parseMoney(item.pay_amount) ?? parseMoney(item.tc) ?? parseMoney(item.total_compensation) ??
    parseMoney(item.pay_annual) ?? parseMoney(item.pay_monthly) ?? parseMoney(item.pay_hourly);
  if (!amount) return { ...item, pay_amount: null };
  const period = normPeriod(item.pay_period) ||
    (item.tc != null || item.total_compensation != null || item.pay_annual != null ? "year" : item.pay_monthly != null ? "month" : null) ||
    inferPeriod(amount);
  return { ...item, pay_amount: amount, pay_period: period };
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

// Same company + title elsewhere in the US is known: if nothing was found here, or the
// figure is >20% below the median of those references (usually an all-roles average or
// an error), use the median instead.
function medianFallback(item, refs, location) {
  if (!refs?.length || item.unpaid || !isUS(location)) return item;
  const med = median(refs.map((r) => r.hourly));
  if (item.pay_hourly && item.pay_hourly >= med * 0.8) return item;
  const period = median(refs.map((r) => ({ hour: 0, month: 1, year: 2 })[r.period] ?? 0)) >= 1 ? "month" : "hour";
  const amount = period === "month" ? Math.round((med * HOURS_PER_YEAR) / 12) : Math.round(med * 100) / 100;
  const why = item.pay_hourly
    ? `The figure found here ($${item.pay_hourly}/hr) was well below this role's pay elsewhere, so this is`
    : `No pay found for this location, so this is`;
  return withPayMath(
    {
      ...item,
      pay_amount: amount,
      pay_period: period,
      pay_scope: "median",
      pay_basis: `${why} the median of ${refs.length} known US data point${refs.length === 1 ? "" : "s"} for this role (${refs.map((r) => r.location + (r.src === "unconfirmed" ? ", unconfirmed" : "")).join("; ")}).`,
      verified: item.verified !== false || /far below typical/.test(item.verify_note || ""),
      verify_note: null,
    },
    med
  );
}

// Full-time TC bands (US, $/yr) for well-documented big-tech levels. The model sometimes
// returns a figure that's a level or two off (e.g. $370K for Meta E3); anything outside
// the band snaps to its middle.
const LEVEL_BANDS = [
  [/^(meta|facebook|instagram|whatsapp)\b/, [
    [/\be\s?3\b|\bic\s?3\b/i, 185000, 195000],
    [/\be\s?4\b|\bic\s?4\b/i, 250000, 290000],
    [/\be\s?5\b|\bic\s?5\b/i, 360000, 440000],
  ]],
  [/^(google|alphabet|youtube)\b/, [
    [/\bl\s?3\b/i, 185000, 205000],
    [/\bl\s?4\b/i, 255000, 295000],
    [/\bl\s?5\b/i, 350000, 420000],
  ]],
  [/^(amazon|aws|amazon web services)\b/, [
    [/\bsde\s?(i|1)\b|\bl\s?4\b/i, 160000, 190000],
    [/\bsde\s?(ii|2)\b|\bl\s?5\b/i, 220000, 280000],
  ]],
];
function applyLevelBand(item, company, location) {
  if (item.unpaid || item.is_internship || !item.pay_annual || !item.level || !isUS(location || item.location)) return item;
  if (/^(reported|community|edited)$/.test(item.pay_scope || "")) return item; // real numbers win
  const levels = LEVEL_BANDS.find(([re]) => re.test(canonCompany(company || item.company)))?.[1];
  const band = levels?.find(([re]) => re.test(item.level));
  if (!band) return item;
  const [, lo, hi] = band;
  if (item.pay_annual >= lo && item.pay_annual <= hi) return item;
  const tc = Math.round((lo + hi) / 2 / 1000) * 1000;
  return withPayMath(
    {
      ...item,
      pay_amount: tc,
      pay_period: "year",
      pay_basis: `Typical ${item.level} TC is $${lo / 1000}K–$${hi / 1000}K; the figure found ($${Math.round(item.pay_annual / 1000)}K) was outside that range.`,
    },
    tc / HOURS_PER_YEAR
  );
}

// Start date of an entry ("Aug 2025 - Jun 2026") as a sortable number, or null.
const MONTHS = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ");
function startOf(text) {
  const m = String(text || "").match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{4})\s*[-–—]/i);
  return m ? Number(m[2]) * 12 + MONTHS.indexOf(m[1].toLowerCase()) : null;
}

// Full-time roles at the same company: an earlier role can't pay more than a later one
// (a promotion doesn't come with a pay cut). Cap the earlier estimate at the later figure.
function applyPromotionOrder(results, entries) {
  const byCo = {};
  for (const e of entries) {
    const r = results[e.key];
    const co = canonCompany(e.hint?.company || e.group || r?.company);
    const start = startOf(e.text);
    if (!r || !co || start == null || r.unpaid || r.is_internship || !r.pay_annual) continue;
    (byCo[co] ||= []).push({ key: e.key, start });
  }
  for (const list of Object.values(byCo)) {
    list.sort((a, b) => b.start - a.start); // newest first
    let cap = null;
    for (const { key } of list) {
      const r = results[key];
      if (cap != null && r.pay_annual > cap && !/^(reported|community|edited)$/.test(r.pay_scope || "")) {
        results[key] = withPayMath(
          {
            ...r,
            pay_amount: cap,
            pay_period: "year",
            pay_basis: `Capped at the later role's TC ($${Math.round(cap / 1000)}K) — an earlier, lower-level role can't pay more; the figure found was $${Math.round(r.pay_annual / 1000)}K.`,
          },
          cap / HOURS_PER_YEAR
        );
      }
      cap = cap == null ? results[key].pay_annual : Math.min(cap, results[key].pay_annual);
    }
  }
  return results;
}

// Titles that only make sense at a real (big) company — wildly inflated on a club.
const GRANDIOSE = /member of (the )?technical staff|\bmts\b|forward[- ]deployed|founding engineer|research (scientist|engineer)|staff (software )?engineer|principal engineer|distinguished|\bchief\b|\bc[etfo]o\b|head of (ai|ml|engineering|research|product)|vp of (engineering|ai|product)|director of (engineering|ai|ml|research)|quant(itative)? (researcher|trader|developer)|\bai (researcher|engineer)\b/i;

// "Unicorn" needs a reported $1B+ valuation with a source; otherwise it's a Startup.
function checkUnicorn(item) {
  if (item.category !== "Unicorn") return item;
  if (Number(item.valuation) >= 1e9 && item.valuation_source) return item;
  return { ...item, category: "Startup" };
}

const ORDINARY_TITLE = /\b(president|vice president|vp|treasurer|secretary|officer|chair(person)?|co-?chair|board member|member|coordinator|organizer|tech(nical)? lead|team lead|lead|developer|technical developer|maintainer|webmaster|mentor|tutor|volunteer|ambassador|representative|director of (events|marketing|outreach|finance|operations)|events|marketing|outreach)\b/i;

// Well-known companies get their category by name, not by the model (first match wins).
const CATEGORY_BY_NAME = [
  ["MANGO", /^(meta|facebook|instagram|whatsapp|anthropic|nvidia|google|alphabet|deepmind|google deepmind|youtube|openai)\b/],
  ["FAANG", /^(apple|amazon|aws|amazon web services|netflix)\b/],
  ["FAANG-adjacent", /^(spacex|space exploration technologies|tesla|microsoft|uber|doordash|linkedin)\b/],
  ["FAANG-lite", /^(capital one|airbnb|lyft|snap|snapchat|pinterest|coinbase|robinhood|databricks|snowflake|palantir|roblox|figma|discord|scale ai|stripe|instacart|reddit|dropbox|netflix games)\b/],
  ["Quant", /^(jane street|citadel securities|hudson river trading|hrt|jump trading|optiver|imc trading|imc|susquehanna|sig|five rings|tower research|drw|radix|virtu|akuna)\b/],
  ["Hedge Fund", /^(citadel|two sigma|d ?e shaw|bridgewater|millennium|point72|renaissance technologies)\b/],
];
function applyKnownCategory(item, company) {
  if (!company) return item; // only trust names that were actually on the page
  const c = canonCompany(company);
  const hit = CATEGORY_BY_NAME.find(([, re]) => re.test(c));
  return hit ? { ...item, category: hit[0], stage: null } : item;
}

const ELITE = /^(MANGO|FAANG|FAANG-adjacent|FAANG\+|FAANG-lite|AI Lab|Quant|Hedge Fund)$/;
const ENG_ROLE = /engineer|developer|\bsde\b|\bswe\b|software|quant|research/i;
const ELITE_INTERN_FLOOR = 40; // $/hr — below this at a top company is almost always a bad source

const looksLowElite = (item) =>
  item.is_internship && ELITE.test(item.category || "") && ENG_ROLE.test(item.role || "") &&
  item.pay_hourly && item.pay_hourly < ELITE_INTERN_FLOOR && item.pay_scope !== "reported";

function normalizePay(item) {
  const c = cleanPay(item);
  return withPayMath(c, toHourly(c.pay_amount, c.pay_period));
}

// No pay at all for a real, paid job → one focused deep dive. If there's no exact data,
// the model must still give its best estimate (shown as "est. mkt").
async function deepDivePay(item, hint, apiKey, model) {
  if (!needsDeepDive(item, hint)) return item;
  const ft = (item.employment || (item.is_internship ? "internship" : "full-time")) === "full-time";
  const where = hint?.location ? ` in ${hint.location}` : "";
  const prompt = `Find the pay for "${hint?.title || item.role}" at ${hint?.company || item.company}${where}.
${ft ? `This is a full-time role: give yearly TOTAL COMPENSATION (base + annualized stock + bonus) at the new-grad/entry level unless the title says otherwise${item.level ? ` (level: ${item.level})` : ""}.` : "This is an internship/part-time role: give the hourly rate, or the monthly salary if that's how it's quoted."}
Check Levels.fyi first, then Glassdoor/Blind submissions, then official posting ranges. Don't use modeled averages (ZipRecruiter, Salary.com, Payscale).
If you can't find exact data, you MUST still give your best estimate for this role, level and location from comparable data — never return null for a real paid job. Set "estimate": true when it's an estimate.
Respond with ONLY a JSON array with one object: [{"pay_amount": number, "pay_period": "hour" | "month" | "year", "level": string | null, "estimate": boolean, "pay_basis": string}] — pay_basis names the source or what the estimate is based on.`;
  try {
    const [r] = await callGemini(prompt, apiKey, model, { refinement: true });
    const c = cleanPay({ ...r });
    const hourly = toHourly(c.pay_amount, c.pay_period);
    if (hourly) {
      return withPayMath(
        {
          ...item,
          pay_amount: c.pay_amount,
          pay_period: c.pay_period,
          level: item.level || r.level || null,
          pay_scope: r.estimate ? "market" : "company",
          pay_basis: `${r.pay_basis || "Deep-dive search"}${r.estimate ? " (best estimate)" : ""}`,
        },
        hourly
      );
    }
  } catch {}
  return item;
}

// Double-check suspiciously low pay at a top company with one focused search.
async function recheckLowPay(item, hint, apiKey, model) {
  if (!looksLowElite(item)) return item;
  const where = hint?.location ? ` in ${hint.location}` : "";
  const prompt = `Find the hourly pay for a "${hint?.title || item.role}" internship at ${hint?.company || item.company}${where}.
A previous lookup found $${item.pay_hourly}/hr (${item.pay_basis || "unknown source"}), which looks too low — probably a modeled aggregator average. Engineering interns at companies like this usually make $40–60+/hr.
Use Levels.fyi or Glassdoor/Blind submissions for this exact role (or the official posting range). Do NOT use ZipRecruiter, Salary.com, Payscale or other modeled averages.
Respond with ONLY a JSON array with one object: [{"pay_amount": number | null, "pay_period": "hour" | "month" | null, "pay_basis": string}] — pay_basis names the source.`;
  try {
    const [r] = await callGemini(prompt, apiKey, model, { refinement: true });
    const hourly = toHourly(r?.pay_amount, r?.pay_period);
    if (hourly && hourly > item.pay_hourly) {
      return withPayMath({ ...item, pay_amount: r.pay_amount, pay_period: r.pay_period, pay_basis: `${r.pay_basis} (re-checked)` }, hourly);
    }
  } catch {}
  return {
    ...item,
    verified: false,
    verify_note: `$${item.pay_hourly}/hr looks low for this role here and a re-check found nothing better. If you know the real number, add it under Known pay.`,
  };
}

const JOB_CACHE = "v26:"; // per-entry job results (estimates); bump to re-run every lookup
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;      // per-entry results
const SHARED_TTL_MS = 30 * 24 * 60 * 60 * 1000;     // company facts + pay, shared across profiles

// Shared-cache keys: the same company / role+location seen on a different profile
// is fed back to the model as known facts so it doesn't search again.
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// Company aliases → one canonical name (applies to known pay, references and the shared cache).
const COMPANY_ALIASES = { facebook: "meta", "meta platforms": "meta", "facebook inc": "meta", "meta platforms inc": "meta" };
const canonCompany = (s) => {
  const n = norm(s);
  for (const [alias, canon] of Object.entries(COMPANY_ALIASES)) {
    if (n === alias || n.startsWith(alias + " ")) return canon + n.slice(alias.length);
  }
  return n;
};
const coKey = (company) => `co3:${canonCompany(company)}`;
const payKey = (company, title, location, intern) =>
  `pay2:${canonCompany(company)}|${norm(title)}|${norm(location)}|${intern ? "intern" : "ft"}`;

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

// Drop results from older cache versions so storage (read on every lookup) stays small.
chrome.runtime.onInstalled.addListener(async () => {
  const all = await chrome.storage.local.get(null);
  const monthAgo = new Date(Date.now() - 30 * 864e5).toLocaleDateString("en-CA");
  const stale = Object.keys(all).filter(
    (k) => (/^v\d+:/.test(k) && !k.startsWith(JOB_CACHE)) || /^(entry|cache|school1|co|co2|pay):/.test(k) ||
      (k.startsWith("usage:") && k.slice(6) < monthAgo)
  );
  if (stale.length) await chrome.storage.local.remove(stale);
});

// Seed the "Known pay" / "Known companies" lists from the bundled JSON the first time.
chrome.runtime.onInstalled.addListener(async () => {
  const have = await chrome.storage.local.get(["knownPay", "knownCompanies", "seededIds"]);
  const load = (f) => fetch(chrome.runtime.getURL(f)).then((r) => r.json()).catch(() => []);
  // Rows are identified by company + role + location (pay is location-specific).
  const id = (k) => `${norm(k.company)}|${norm(k.role)}|${norm(k.location)}`;
  const coRole = (k) => `${norm(k.company)}|${norm(k.role)}`;
  // Seed rows carry an optional version "v"; bumping it pushes the new row to existing installs.
  const seedId = (k) => `${id(k)}@${k.v || 1}`;
  const seeded = new Set(have.seededIds || []);
  // Add seed rows that were never seeded before (a row you deleted stays deleted).
  const merge = (list = [], seed) => {
    const out = [...list];
    for (const row of seed) {
      if (seeded.has(seedId(row)) || (!row.v && seeded.has(id(row)))) continue;
      seeded.add(seedId(row));
      // same row, or an older copy of it saved before rows had a location
      let i = out.findIndex((k) => id(k) === id(row));
      if (i < 0 && row.location) i = out.findIndex((k) => !k.location && coRole(k) === coRole(row));
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
  if (msg?.type === "pw:isImportTab") return void sendResponse(importWaiters.has(_sender.tab?.id));
  if (msg?.type === "pw:imported") return void importWaiters.get(_sender.tab?.id)?.(msg.data);
  if (msg?.type === "pw:allowMore") {
    allowMoreToday(msg.searches, msg.calls).then((u) => sendResponse({ ok: true, usage: u }));
    return true;
  }
  if (msg?.type === "pw:editEstimate") {
    editEstimate(msg.key, msg.patch)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (msg?.type === "pw:import") {
    importProfile(msg.url)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (msg?.type !== "pw:lookup") return;
  const job = msg.kind === "edu" ? () => lookupEdu(msg.entries) : () => lookup(msg.entries, msg.profile || {}, _sender.tab?.id);
  limited(job)
    .then((results) => sendResponse({ ok: true, results }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // async response
});

// ---------- Import a profile's jobs (for filling in Known pay) ----------
// Opens the profile's Experience page in a background tab; the content script sees
// it's an import tab, scrapes the entries (no Gemini calls) and reports back.
const importWaiters = new Map(); // tabId -> resolve(data)

async function importProfile(url) {
  const slug = String(url || "").match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1];
  if (!slug) throw new Error("That isn't a LinkedIn profile link. It should look like linkedin.com/in/username.");
  const tab = await chrome.tabs.create({ url: `https://www.linkedin.com/in/${slug}/details/experience/`, active: false });
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      importWaiters.delete(tab.id);
      chrome.tabs.remove(tab.id).catch(() => {});
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error("The profile didn't load within 40 seconds. Check that you're signed in to LinkedIn and try again."));
    }, 40000);
    importWaiters.set(tab.id, (data) => {
      done();
      resolve(data);
    });
  });
}

// ---------- Settings → Estimates: correct a saved estimate ----------
async function editEstimate(key, patch) {
  const cur = (await chrome.storage.local.get(key))[key];
  if (!cur) throw new Error("That estimate no longer exists.");
  let item = {
    ...cur.data,
    ...patch,
    unpaid: false,
    pay_scope: "edited",
    pay_basis: "You corrected this estimate in Settings.",
    verify_note: null,
  };
  if (patch.pay_amount != null) item = withPayMath(item, toHourly(item.pay_amount, item.pay_period));
  const toStore = { [key]: { ...cur, at: Date.now(), data: item } };
  // let other profiles with the same job benefit from the correction
  const h = cur.hint || {};
  if (h.company && item.pay_hourly) {
    const intern = /intern|co-?op/i.test(`${h.type || ""} ${h.title || ""}`);
    toStore[payKey(h.company, h.title, h.location, intern)] = {
      at: Date.now(),
      location: h.location || null,
      hourly: item.pay_hourly,
      period: item.pay_period || "hour",
      fact: `${h.title} at ${h.company}${h.location ? ` in ${h.location}` : ""}: ${item.pay_period === "month" ? `$${item.pay_amount}/month` : item.pay_period === "year" ? `$${item.pay_amount}/yr` : `$${item.pay_hourly}/hr`} (corrected by the user, not confirmed).`,
    };
  }
  await chrome.storage.local.set(toStore);
  return item;
}

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

async function lookup(entries, profile, tabId) {
  const results = {};
  const keys = entries.map((e) => `${JOB_CACHE}${e.key}`);
  const cached = await chrome.storage.local.get(keys);
  const misses = [];
  for (const e of entries) {
    const hit = cached[`${JOB_CACHE}${e.key}`];
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) results[e.key] = hit.data;
    else misses.push(e);
  }
  const { knownPay = [], knownCompanies = [] } = await chrome.storage.local.get(["knownPay", "knownCompanies"]);
  const community = await communityPay();
  // your Known pay first, then community offers for entries yours doesn't cover
  const finish = (r) => {
    for (const e of entries) if (r[e.key]) r[e.key] = applyLevelBand(r[e.key], e.hint?.company, e.hint?.location);
    return applyPromotionOrder(
      applyKnownCompanies(applyKnownPay(applyKnownPay(r, entries, knownPay), entries, community, "community"), entries, knownCompanies),
      entries
    );
  };
  if (!misses.length) {
    const { apiKey, model } = await chrome.storage.sync.get(["apiKey", "model"]);
    return apiKey ? startRefining(finish(results), entries, { apiKey, model, tabId, knownPay, community, knownCompanies }) : finish(results);
  }

  const { apiKey, model } = await chrome.storage.sync.get(["apiKey", "model"]);
  if (!apiKey) throw new Error("NO_KEY");

  const list = misses
    .map((e, i) => `#${i}\n${e.group ? `[Company group: ${e.group}]\n` : e.hint?.company ? "" : "[Company: not shown — do NOT guess one; leave company null and category null]\n"}${e.text}`)
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
  // Two kinds of facts, kept apart so a past guess is never passed off as confirmed:
  //   confirmed — from you (Known pay, known companies): exact, permanent
  //   estimated — learned from earlier Gemini lookups: expire, may be wrong
  const confirmed = [];
  const facts = Object.values(shared) // estimated
    .filter((v) => v && Date.now() - v.at < SHARED_TTL_MS)
    .map((v) => v.fact);
  // Same company + title in other locations: known pay rows + pay learned from earlier lookups.
  const allStored = await chrome.storage.local.get(null);
  const refsByKey = {};
  for (const e of misses) {
    const h = e.hint || {};
    if (!h.company) continue;
    const { exact, refs } = knownPayFor([...knownPay, ...community], h.company, h.title, h.location, internOf(h));
    const list = refs.map((k) => ({
      location: k.location || "US, location unknown",
      hourly: knownHourly(k),
      period: knownPeriod(k),
      housing: k.housing || null,
      src: k.reference ? "unconfirmed" : k.community ? "community" : "reported",
    }));
    const prefix = `pay2:${canonCompany(h.company)}|${norm(h.title)}|`;
    for (const [key, v] of Object.entries(allStored)) {
      if (!key.startsWith(prefix) || !v?.hourly || !v.location || Date.now() - v.at > SHARED_TTL_MS) continue;
      if (h.location && sameLocation(v.location, h.location)) continue;
      if (!list.some((x) => sameLocation(x.location, v.location))) list.push({ location: v.location, hourly: v.hourly, period: v.period || "hour", src: "lookup" });
    }
    const us = list.filter((x) => isUS(x.location) && x.hourly);
    if (!exact && us.length) {
      refsByKey[e.key] = us;
      const where = h.location ? `in ${h.location}` : "for this entry's location";
      const fmt = (x) =>
        `${x.location}: ${x.period === "month" ? `$${Math.round((x.hourly * HOURS_PER_YEAR) / 12)}/month` : x.period === "year" ? `$${Math.round(x.hourly * HOURS_PER_YEAR)}/yr` : `$${x.hourly}/hr`}${x.housing ? ` + $${x.housing}/month housing` : ""}`;
      const head = `Pay for "${h.title}" at ${h.company} elsewhere (pay varies by location — look up the figure ${where} specifically): `;
      const conf = us.filter((x) => x.src === "reported" || x.src === "community");
      const est = us.filter((x) => x.src !== "reported" && x.src !== "community");
      if (conf.length) confirmed.push(head + conf.map((x) => fmt(x) + (x.src === "community" ? " (community-reported offer)" : "")).join("; ") + ".");
      if (est.length) facts.push(head + est.map((x) => fmt(x) + (x.src === "unconfirmed" ? " (unconfirmed secondhand report)" : " (earlier estimate)")).join("; ") + ".");
    }
    if (exact) {
      confirmed.push(`${exact.company}${exact.role ? ` (${exact.role})` : ""}${exact.location ? ` in ${exact.location}` : ""}: pay is ${exact.hourly ? `$${exact.hourly}/hr` : exact.monthly ? `$${exact.monthly}/month` : `$${exact.annual}/yr`}${exact.community ? " (community-reported offer)" : ""}.`);
    }
    const kc = findKnownCompany(knownCompanies, e.hint?.company);
    if (kc?.note) confirmed.push(`${kc.company}: ${kc.note}`);
  }
  const knownFacts =
    (confirmed.length
      ? `CONFIRMED by the user — exact, use as-is:\n${confirmed.map((f) => "- " + f).join("\n")}\n\n`
      : "") +
    (facts.length
      ? `EARLIER ESTIMATES from past lookups — probably right but NOT confirmed; use them to save searching, but prefer better data if you have it:\n${facts.map((f) => "- " + f).join("\n")}\n\n`
      : "");

  const today = new Date().toISOString().slice(0, 10);
  const prompt = `Today is ${today}. Below are job entries scraped from the Experience section of a LinkedIn profile, plus the person's headline and Education section. For EACH entry:

A) Parse: role title, company, location, and the REAL employment type. Don't trust the title alone:
  - Use the Education section (and headline, e.g. "Student at X", "CS @ UCI") to work out when they were/are enrolled. A role held while they were a student — current or past — is almost always an internship, co-op or part-time job even if it's titled "Software Engineer" and not tagged "Internship". Treat it as an internship for pay.
  - LARP: set larp=true ONLY when the title is obscenely inflated for what the thing really is — a grandiose big-company title on something small. Examples that ARE LARP: "Member of Technical Staff" or "Forward Deployed Engineer" at a school club; "Founding Engineer"/"Head of AI" at a class project; "Founder & CEO" of an app with no users. NOT LARP: ordinary titles, even at small things — Treasurer, VP, President, Website Maintainer, Developer, Team Lead at a club; "Software Engineer" at a real small company; anything labeled Intern/Co-op/Part-time; "incoming"/future roles (e.g. "Incoming SWE Intern", or a start date in the future). When in doubt, don't flag. Explain in larp_reason.
  - UNPAID: school clubs, student orgs, university project teams, hackathon teams, research-for-credit, volunteering, and personal projects are unpaid — set unpaid=true, pay fields null, category "Student org" (or "Volunteer" for volunteering). Paid university jobs (TA, paid research assistant) are NOT unpaid.

SPEED: Be fast. For well-known companies (big tech, quant firms, major banks, well-known startups) answer from your own knowledge — do NOT search. Only use Google Search for companies or pay you genuinely don't know, and use at most 2 searches total.

B) PAY. Rules, in priority order:
  0. The pay must be for THIS ROLE FAMILY (e.g. software engineering intern), never a company-wide average across all roles/internships (those mix in ops, warehouse, retail, etc. and are far lower). Subsidiaries/teams use the parent's figure for the role (Amazon Music, AWS → Amazon SDE intern pay). If a source says "average pay for <Company> internships" without the role, ignore it.
  1. Use COMPANY-SPECIFIC pay for that role first, in this order of trust: Levels.fyi (incl. intern pages) > Glassdoor / Blind submissions for that exact role > the company's official posting range > H-1B/LCA data > Indeed. NEVER use modeled "average" estimators (ZipRecruiter, Salary.com, Payscale, Comparably, "annual pay ÷ 2080" figures) — they're usually far too low. Engineering interns at top tech companies typically make $40–60+/hr. Big tech intern pay is well documented (e.g. Amazon SDE interns in Seattle earn roughly $50-60/hr) — do NOT substitute a generic market "intern median" when company data exists.
  2. Only if no company data exists, use the market median for that title in that metro, and set pay_scope to "market".
  3. Report the pay figure exactly as your source quotes it — don't convert it yourself. Set pay_amount to that number and pay_period to "hour", "month" or "year" (e.g. an intern salary quoted as $9,000/month → pay_amount 9000, pay_period "month"). Conversions are done downstream.
  3b. Internship HOUSING: if the company gives a housing stipend/relocation for interns, set housing_amount and housing_period ("month" for a monthly stipend, "total" for a lump sum). Big tech usually does (e.g. a monthly housing stipend or a lump sum). If none or unknown, null.
  4. Full-time: report median TOTAL COMPENSATION per year (TC = base + annualized stock + bonus) as pay_amount with pay_period "year". Assume the NEW-GRAD / entry level unless the title states a higher one (Senior, Staff, Principal, Lead, II/III, …). Put the company's level name in "level" (e.g. Meta E3, Google L3, Amazon SDE I, Microsoft 59, Apple ICT2, Netflix L4). Levels.fyi is the best source. Sanity anchors (US TC): Meta E3 ≈ $185–195K, E4 ≈ $250–290K; Google L3 ≈ $185–205K, L4 ≈ $255–295K; Amazon SDE I ≈ $160–190K, SDE II ≈ $220–280K. Several roles at the SAME company are usually promotions: the earlier role's TC must be LOWER than the later one's. Internships: never annualize.
  4b. Part-time, contract and on-campus/university jobs: hourly pay (pay_period "hour").
  5. Founder/self-employed/volunteer/unpaid: pay fields null, explain in pay_basis.

C) PRESTIGE TIER — how impressive/selective THIS SPECIFIC ROLE at THIS company is. The role matters as much as the company: rate the seat, not the logo.
  Rate the TEAM / SPECIALTY inside the company too — the same logo can be several tiers apart (Nvidia CUDA / deep-learning SWE is S; Nvidia embedded or semiconductor-validation SWE is A).
  THANOS = the rarest seats, overwhelmingly selective:
    - quant trader / researcher / developer / SWE at top quant, HFT and prop firms (Jane Street, Citadel Securities, Hudson River Trading, Jump, Optiver, IMC, SIG, Five Rings, Radix, Tower, Two Sigma, DE Shaw);
    - research and AI roles at frontier labs — Research Scientist/Engineer, AI/ML research, and Member of Technical Staff (MTS) at Anthropic, OpenAI, Google DeepMind (MTS is a real, very selective title there);
    - AI research teams inside MANGO (e.g. Meta FAIR / superintelligence lab, Google Gemini research);
    - founding engineer at a top-tier-backed startup, and founder/co-founder of a startup that was acquired or is backed by a top-tier VC (a16z, Sequoia, Founders Fund, Benchmark, Accel, Greylock, Kleiner, Index, Lightspeed, General Catalyst…). A quick check is enough.
  S = elite: general software engineering at Anthropic or OpenAI (non-research); AI/ML or core-platform engineering at MANGO (Nvidia CUDA / deep learning, Google Gemini / Search infra, Meta AI); core engineering at the hottest top startups; MBB consulting; elite rotational APM programs (Google APM, Meta RPM); top-bucket IB.
  A = excellent: product/general SWE at MANGO outside AI; specialized or peripheral engineering at MANGO (embedded, semiconductor/hardware validation, IT); core engineering/ML at FAANG and FAANG+ companies (Apple, Amazon, Netflix, Microsoft, SpaceX, Snowflake, Databricks, Stripe, Palantir and peers).
  B = good but not elite: non-core roles at big tech (PM or program-manager internships), core roles at well-known large companies (Visa, Salesforce, Adobe, big banks' tech), Big 4.
  MID = decent, RECOGNIZABLE companies: established mid-size/large companies people have heard of, regional names, defense primes, well-funded startups with a real brand. Being verified to exist is not enough — small or obscure private companies and early startups are C.
  C = the DEFAULT for any company that isn't well known — small/lesser-known startups and companies, anything you can't verify — unless a role bump below applies. Also a peripheral role anywhere.
  D = non-selective or unrelated role (e.g. retail, food service) or clearly fake/placeholder company.
  ROLE BUMPS / DROPS:
  - Founding engineer or one of the first ~5 engineers at a verified, VC-backed startup → THANOS. At an unfunded/unverifiable company → C bumped one tier (MID).
  - Founder/co-founder: acquired, or backed by a top-tier VC → THANOS; YC or other real funding → S; unfunded or unknown → C.
  - Non-core functions (ops, program/project management, sales, support, marketing, HR, IT) usually rank 1-2 tiers below the company's core engineering/trading seat.

D) VERIFICATION — verified=true if the company is well known or you confirmed it exists, AND the pay figure is grounded in real data you know or found (for unpaid roles, just the org). verified=false if the company is too obscure to confirm or you're guessing the pay; say what's missing in verify_note.

E) CATEGORY — pick exactly one:
  "MANGO" = Meta (incl. Facebook, Instagram, WhatsApp), Anthropic, Nvidia, Google/Alphabet (incl. DeepMind, YouTube), OpenAI — the newer tier above FAANG.
  "FAANG" = Apple, Amazon (incl. AWS, Amazon Music, etc.), Netflix. (Meta and Google are MANGO.)
  "FAANG-adjacent" = peers right next to FAANG: SpaceX, Tesla, Microsoft, Uber, DoorDash, LinkedIn.
  "FAANG-lite" = strong, well-paying companies a step below: Capital One, Airbnb, Lyft, Snap, Pinterest, Coinbase, Robinhood, Databricks, Snowflake, Palantir, Roblox, Figma, Discord, Scale AI, Stripe, Instacart, Reddit, Dropbox, etc.
  "AI Lab" = frontier AI labs other than MANGO: xAI, Mistral, Safe Superintelligence, Thinking Machines, Reflection, etc.
  "Quant" = quant trading / HFT / prop / market makers: Jane Street, Citadel Securities, HRT, Jump, Optiver, IMC, SIG, Five Rings, Tower, DRW.
  "Hedge Fund" = hedge funds & multi-managers: Citadel, Two Sigma, DE Shaw, Bridgewater, Millennium, Point72, Renaissance.
  "Fintech" = payments/financial tech: Visa, Mastercard, PayPal, Block, Plaid, Ramp, Brex, Chime, Affirm.
  "Big Tech" = large established tech not above: Oracle, IBM, Salesforce, Adobe, Intel, Cisco, AMD, Qualcomm, ServiceNow, Workday.
  "Unicorn" = private startup with a REPORTED valuation of $1B+ (from a funding announcement or reliable press) and not listed above. Only use it if you can state the valuation and its source (valuation, valuation_source, plus round_name / round_amount / round_date); otherwise use "Startup". For funded startups, fill in the round fields too when you find them.
  "Startup" = other startups (set stage when known). A publicly traded company is NEVER a startup, however young (e.g. Rivian, Lucid, Robinhood, Coinbase are public); neither is a big, established private company with thousands of employees (SpaceX, Stripe, Databricks, Anduril).
  Clubs, associations, societies, chapters, design/project teams and anything named "<thing> at <University>" (e.g. "Unmanned Aerial Vehicles at UCI") are "Student org" — never a startup.
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
  "skip": boolean,                     // true for everyday non-career jobs (retail, food service, hospitality, rideshare/delivery, babysitting…); if true, other fields may be null
  "employment": "full-time" | "part-time" | "internship" | "contract",
  "level": string | null,              // full-time only, e.g. "E3", "L3", "SDE I"
  "housing_amount": number | null,     // interns only
  "housing_period": "month" | "total" | null,
  "currency": string,                  // ISO code, e.g. "USD"
  "pay_scope": "company" | "market",
  "pay_basis": string,                 // name the source and what the figure is, e.g. "Levels.fyi — Acorns SWE intern, 2025 (3 data points)". No boilerplate like "hourly pay for this position".
  "tier": "THANOS" | "S" | "A" | "B" | "MID" | "C" | "D",
  "category": string,
  "stage": string | null,
  "valuation": number | null,          // latest reported valuation in USD (Unicorn requires it), e.g. 1150000000
  "round_name": string | null,         // latest funding round, e.g. "Series C" (startups/unicorns)
  "round_amount": number | null,       // USD raised in that round, e.g. 300000000
  "round_date": string | null,         // e.g. "Feb 2026"
  "valuation_source": string | null,   // where the valuation/round was reported, e.g. "TechCrunch"
  "yc_batch": string | null,           // Y Combinator batch if it's a YC company, e.g. "W24", "S25"; else null
  "larp": boolean,
  "larp_reason": string | null,
  "unpaid": boolean,
  "verified": boolean,
  "verify_note": string | null,
  "tier_reason": string                // one sentence naming the specific seat and why it's selective, e.g. "Member of Technical Staff at Anthropic — one of the most selective engineering seats in AI." Never generic ("core engineering internship at a FAANG company").
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
    if (!e) continue;
    // Fast path only — the slower deep dive / low-pay re-check run after we answer (refine()).
    const item = applyLevelBand(
      medianFallback(normalizePay(checkUnicorn(applyKnownCategory(raw, e.hint?.company))), refsByKey[e.key], e.hint?.location || raw.location),
      e.hint?.company, e.hint?.location
    );
    // "Incoming …" is announcing an offer, not LARPing — in the entry itself, or in a
    // headline that names this entry's company.
    const headlineIncoming = /\bincoming\b/i.test(profile.headline || "") && e.hint?.company &&
      norm(profile.headline).includes(norm(e.hint.company).split(" ")[0]);
    // Clubs / student orgs: ordinary titles are never LARP; a grandiose big-company
    // title (Member of Technical Staff, Forward Deployed Engineer, CTO…) always is.
    const org = `${e.hint?.company || ""} ${e.group || ""}`;
    const looksStudentOrg = /\b(club|society|association|chapter|student|fraternity|sorority)\b|\bat (uc ?\w+|ucla|ucsd|ucsb|uci|university|college)\b/i.test(org);
    if (looksStudentOrg) {
      // The model sometimes calls club roles "Startup" or even "Big Tech" and prices them.
      // A club is a club: unpaid, no pay estimate, no compliment.
      Object.assign(item, {
        category: "Student org", stage: null, tier: null, unpaid: true,
        pay_amount: null, pay_period: null, pay_hourly: null, pay_annual: null, pay_paycheck: null,
        housing_amount: null, housing_period: null, pay_scope: null, verify_note: null,
        pay_basis: "Student organization — unpaid.",
      });
    }
    if (looksStudentOrg || /^(Student org|Volunteer)$/.test(item.category || "")) {
      const title = e.hint?.title || item.role || "";
      if (GRANDIOSE.test(title)) {
        item.larp = true;
        item.larp_reason = item.larp_reason || `"${title}" is a big-company title for a student org.`;
      } else {
        item.larp = false;
        item.larp_reason = null;
      }
    }
    // A real title at a real top company (MTS at Anthropic, SWE at Nvidia…) is never LARP.
    if (item.larp && ELITE.test(item.category || "")) {
      item.larp = false;
      item.larp_reason = null;
    }
    // Ordinary titles are never LARP, anywhere — it has to be obscene.
    const title = e.hint?.title || item.role || "";
    if (item.larp && ORDINARY_TITLE.test(title) && !GRANDIOSE.test(title)) {
      item.larp = false;
      item.larp_reason = null;
    }
    if (item.larp && (/\bincoming\b/i.test(e.text) || headlineIncoming)) {
      item.larp = false;
      item.larp_reason = null;
    }
    results[e.key] = item;
    // who/hint let Settings → Estimates show where an estimate came from
    toStore[`${JOB_CACHE}${e.key}`] = { at: Date.now(), who: profile.name || null, hint: e.hint || null, data: item };

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
        : `$${item.pay_annual}/yr TC${item.level ? ` (${item.level})` : ""}`;
      toStore[payKey(h.company, h.title, h.location, intern)] = {
        at: Date.now(),
        location: h.location || item.location || null,
        hourly: item.pay_hourly,
        period: item.pay_period || "hour",
        fact: `${item.role} at ${item.company}${item.location ? ` in ${item.location}` : ""}: ${pay} (${item.currency || "USD"}) — ${item.pay_basis || "company data"}.`,
      };
    }
  }
  await chrome.storage.local.set(toStore);
  return startRefining(finish(results), misses, { apiKey, model, tabId, knownPay, community, knownCompanies });
}

// Background refinement for jobs with missing or suspiciously low pay. The tab gets the
// improved result when it's ready; the first answer shows right away. Each job is refined
// at most once (r.refined), including ones loaded from the cache.
function startRefining(done, entries, ctx) {
  for (const e of entries) {
    const r = done[e.key];
    if (!r || r.refined || r.pay_scope === "reported" || r.pay_scope === "community") continue;
    if (!needsDeepDive(r, e.hint) && !looksLowElite(r)) continue;
    done[e.key] = { ...r, refining: true };
    refineQueue(() => refine(e, r, ctx));
  }
  return done;
}

const needsDeepDive = (item, hint) =>
  !item.unpaid && !item.skip && !item.pay_hourly && !item.pay_annual && !!(hint?.company || item.company) &&
  !/^(Student org|Volunteer|Self-employed)$/.test(item.category || "");

async function refine(e, item, { apiKey, model, tabId, knownPay, community, knownCompanies }) {
  let r = await recheckLowPay(await deepDivePay(item, e.hint, apiKey, model), e.hint, apiKey, model);
  r = applyKnownCompanies(applyKnownPay(applyKnownPay({ [e.key]: r }, [e], knownPay), [e], community, "community"), [e], knownCompanies)[e.key];
  r = { ...r, refining: false, refined: true };
  const key = `${JOB_CACHE}${e.key}`;
  const cur = (await chrome.storage.local.get(key))[key];
  if (cur) await chrome.storage.local.set({ [key]: { ...cur, data: r } });
  if (tabId != null) chrome.tabs.sendMessage(tabId, { type: "pw:refined", key: e.key, data: r }).catch(() => {});
}

// Follow-up searches get their own small queue so they never hold up first answers.
const refineWaiting = [];
let refineActive = 0;
function refineQueue(fn) {
  refineWaiting.push(fn);
  pumpRefine();
}
function pumpRefine() {
  while (refineActive < 2 && refineWaiting.length) {
    const fn = refineWaiting.shift();
    refineActive++;
    fn().catch(() => {}).finally(() => {
      refineActive--;
      pumpRefine();
    });
  }
}

// ---------- Community pay: offers submitted to the repo via pull request ----------
// Fetched from GitHub about once a day (data only), falling back to the bundled copy.
const COMMUNITY_URL = "https://raw.githubusercontent.com/ethnvo/pocket-watching/main/community-pay.json";
const COMMUNITY_TTL_MS = 24 * 60 * 60 * 1000;
const validCommunityRow = (r) =>
  r && typeof r.company === "string" && typeof r.role === "string" && typeof r.location === "string" &&
  [r.hourly, r.monthly, r.annual].filter((x) => typeof x === "number" && x > 0).length === 1;

async function communityPay() {
  const { useCommunity } = await chrome.storage.sync.get("useCommunity");
  if (useCommunity === false) return [];
  const { community } = await chrome.storage.local.get("community");
  if (community && Date.now() - community.at < COMMUNITY_TTL_MS) return community.rows;
  let rows = null;
  try {
    const res = await fetch(COMMUNITY_URL, { cache: "no-store" });
    if (res.ok) rows = await res.json();
  } catch {}
  if (!Array.isArray(rows)) rows = await fetch(chrome.runtime.getURL("community-pay.json")).then((r) => r.json()).catch(() => []);
  rows = (Array.isArray(rows) ? rows : []).filter(validCommunityRow).map((r) => ({ ...r, community: true }));
  await chrome.storage.local.set({ community: { at: Date.now(), rows } });
  return rows;
}

// ---------- Known (user-reported) pay: always wins over the model's estimate ----------

const sameCompany = (known, scraped) => {
  const k = canonCompany(known), c = canonCompany(scraped);
  return !!k && !!c && (c === k || c.startsWith(k + " "));
};

// ---------- Locations ----------
const STATES = { al:"alabama", ak:"alaska", az:"arizona", ar:"arkansas", ca:"california", co:"colorado", ct:"connecticut", de:"delaware", fl:"florida", ga:"georgia", hi:"hawaii", id:"idaho", il:"illinois", in:"indiana", ia:"iowa", ks:"kansas", ky:"kentucky", la:"louisiana", me:"maine", md:"maryland", ma:"massachusetts", mi:"michigan", mn:"minnesota", ms:"mississippi", mo:"missouri", mt:"montana", ne:"nebraska", nv:"nevada", nh:"new hampshire", nj:"new jersey", nm:"new mexico", ny:"new york", nc:"north carolina", nd:"north dakota", oh:"ohio", ok:"oklahoma", or:"oregon", pa:"pennsylvania", ri:"rhode island", sc:"south carolina", sd:"south dakota", tn:"tennessee", tx:"texas", ut:"utah", vt:"vermont", va:"virginia", wa:"washington", wv:"west virginia", wi:"wisconsin", wy:"wyoming", dc:"district of columbia" };
const NON_US = /\b(india|canada|united kingdom|uk|england|scotland|ireland|germany|france|netherlands|spain|italy|poland|israel|singapore|japan|china|hong kong|australia|brazil|mexico|switzerland|sweden|korea|taiwan|vietnam|philippines|dubai|uae|toronto|vancouver|london|bangalore|bengaluru|hyderabad)\b/i;

function locParts(loc) {
  const parts = String(loc || "").split("·")[0].split(",").map((p) => norm(p));
  const city = (parts[0] || "").replace(/\b(greater|metropolitan|metro|area|region|bay)\b/g, " ").replace(/\s+/g, " ").trim();
  const st = parts[1] || "";
  return { city, state: STATES[st] || st };
}
function sameLocation(a, b) {
  const A = locParts(a), B = locParts(b);
  if (!A.city || !B.city) return false;
  return A.city === B.city || A.city.includes(B.city) || B.city.includes(A.city);
}
const isUS = (loc) => !NON_US.test(String(loc || ""));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
// "Software Development Engineer" ≈ "SDE", "Software Engineer(ing)" ≈ "SWE".
const normRole = (s) =>
  norm(s)
    .replace(/\bsoftware development engineer(ing)?\b/g, "sde")
    .replace(/\bsoftware engineer(ing)?\b/g, "swe")
    .replace(/\binternship\b/g, "intern");
const roleMatch = (role, title) => {
  const r = normRole(role), t = normRole(title);
  return !!r && !!t && (t.includes(r) || r.includes(t));
};

// Known pay is location-specific. Returns the row that applies here (exact) and rows
// for the same company + role in other locations (references).
function knownPayFor(list, company, title, location, intern) {
  // an intern figure never applies to a full-time role (and vice versa)
  const byCo = list.filter((k) => sameCompany(k.company, company) && (intern == null || (k.intern ?? true) === intern));
  const roleHits = byCo.filter((k) => k.role && roleMatch(k.role, title));
  const pool = roleHits.length ? roleHits : byCo.filter((k) => !k.role);
  // "reference" rows (unconfirmed numbers) never apply exactly — they only inform.
  const exact =
    pool.find((k) => !k.reference && (!k.location || !location || sameLocation(k.location, location))) || null;
  const refs = pool.filter((k) => k !== exact && (k.location || k.reference));
  return { exact, refs };
}
// Intern if LinkedIn tags it (or the title says so); else trust the model's call if we have one.
const internOf = (h, r) =>
  /intern|co-?op/i.test(`${h?.type || ""} ${h?.title || ""}`) ? true : r ? !!r.is_internship : null;
const knownHourly = (k) => k.hourly ?? toHourly(k.monthly, "month") ?? toHourly(k.annual, "year");
const knownPeriod = (k) => (k.monthly ? "month" : k.hourly ? "hour" : "year");

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
      ...(k.larp === true ? { larp: true, larp_reason: k.larp_reason || r.larp_reason || null } : {}),
    };
  }
  return results;
}

function applyKnownPay(results, entries, list, scope = "reported") {
  if (!list.length) return results;
  for (const e of entries) {
    const r = results[e.key];
    if (!r || r.pay_scope === "reported") continue; // your own confirmed pay always wins
    const k = knownPayFor(list, e.hint?.company || r.company, e.hint?.title || r.role, e.hint?.location || r.location, internOf(e.hint, r)).exact;
    if (!k) continue;
    const intern = k.intern ?? r.is_internship;
    const hourly = knownHourly(k);
    const base = {
      ...r,
      unpaid: false,
      is_internship: intern,
      pay_amount: k.monthly ?? k.hourly ?? k.annual ?? null,
      pay_period: k.monthly ? "month" : k.hourly ? "hour" : k.annual ? "year" : null,
      ...(k.housing != null
        ? { housing_amount: k.housing, housing_period: k.housing_period || "month", housing_scope: scope }
        : { housing_scope: r.housing_amount ? r.housing_scope || r.pay_scope || "company" : null }), // housing stays an estimate
      currency: k.currency || "USD",
      pay_scope: scope,
      pay_source: scope === "community" ? `${k.source || "Offer"} · community-reported` : k.source || "your Known pay list",
      pay_basis: `${k.source || "Reported pay"}${k.role ? ` for ${k.role}` : ""} at ${k.company}${k.location ? ` in ${k.location}` : ""} (${scope === "community" ? "community-reported offer from the Pocket Watching repo" : "from your Known pay list"}).`,
      verified: true,
    };
    results[e.key] = withPayMath(base, hourly);
  }
  return results;
}

// ---------- Usage + spending guard ----------
// Gemini 2.5 Flash: $0.30 / 1M input tokens, $2.50 / 1M output, Google Search grounding
// free for 1,500 prompts a day then $35 / 1,000. Limits are per day and set in Settings.
const PRICE = { in: 0.3 / 1e6, out: 2.5 / 1e6, search: 35 / 1000, freeSearches: 1500 };
const DEFAULT_LIMITS = { dailySearchLimit: 1000, dailyCallLimit: 2000 };
const usageKey = () => `usage:${new Date().toLocaleDateString("en-CA")}`; // YYYY-MM-DD, local

async function getUsage() {
  const k = usageKey();
  return (await chrome.storage.local.get(k))[k] || { calls: 0, searches: 0, inTok: 0, outTok: 0 };
}
async function getLimits() {
  return { ...DEFAULT_LIMITS, ...(await chrome.storage.sync.get(Object.keys(DEFAULT_LIMITS))) };
}
// true once the day's budget is used up (refinements stop earlier, at 80% of the search limit)
async function overBudget({ refinement = false, search = true } = {}) {
  const [u, l] = await Promise.all([getUsage(), getLimits()]);
  if (u.calls >= l.dailyCallLimit + (u.extraCalls || 0)) return true;
  return search && u.searches >= (l.dailySearchLimit + (u.extraSearches || 0)) * (refinement ? 0.8 : 1);
}

// "Allow more today": a one-day bump on top of the regular limits.
async function allowMoreToday(searches = 500, calls = 1000) {
  const k = usageKey();
  const u = await getUsage();
  u.extraSearches = (u.extraSearches || 0) + searches;
  u.extraCalls = (u.extraCalls || 0) + calls;
  await chrome.storage.local.set({ [k]: u });
  return u;
}
async function recordUsage(body, searched) {
  const k = usageKey();
  const u = await getUsage();
  const m = body?.usageMetadata || {};
  u.calls += 1;
  u.searches += searched ? 1 : 0;
  u.inTok += m.promptTokenCount || 0;
  u.outTok += (m.candidatesTokenCount || 0) + (m.thoughtsTokenCount || 0);
  await chrome.storage.local.set({ [k]: u });
}

async function callGemini(prompt, apiKey, model, { search = true, refinement = false } = {}) {
  if (await overBudget({ refinement, search })) throw new Error("DAILY_LIMIT");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model || DEFAULT_MODEL
  )}:generateContent`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      ...(search ? { tools: [{ google_search: {} }] } : {}),
      generationConfig: {
        temperature: 0.2,
        // 2.5-series models think by default, which is most of the latency. This task
        // is lookup + judgement, so skip it.
        ...(/^gemini-2\.5-flash/.test(model || DEFAULT_MODEL) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      },
    }),
  });

  const body = await res.json().catch(() => ({}));
  // a grounded prompt is billed when the model actually ran a search
  const searched = !!body.candidates?.[0]?.groundingMetadata?.webSearchQueries?.length;
  await recordUsage(body, searched);
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

  const arr = await callGemini(prompt, apiKey, model, { search: false }); // schools don't need a web search
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
