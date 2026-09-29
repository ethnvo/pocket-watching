// Pocket Watching — content script. Finds each entry in a LinkedIn profile's
// Experience section and adds inline badges: prestige tier + pay.

(() => {
  const DATE_RE = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)?\s?\d{4}\s*[-–]\s*(?:Present|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)?\s?\d{4})/;
  const SECTION_HEADINGS = /^(Experience|Education|Volunteering|Volunteer experience|Licenses & certifications|Projects|Honors & awards|Courses|Publications|Organizations|Test scores)$/;
  const TIER_LABELS = { THANOS: "THANOS tier", S: "S tier", A: "A tier", B: "B tier", MID: "Mid tier", C: "C tier", D: "D tier" };
  const ITEM_SEL = '[componentkey^="entity-collection-item"]';

  // Instant tooltips for badges (native title tooltips are slow and flaky inside
  // LinkedIn's entry links).
  const tipEl = document.createElement("div");
  tipEl.className = "pw-tip";
  tipEl.hidden = true;
  document.documentElement.appendChild(tipEl);
  document.addEventListener("mouseover", (ev) => {
    const t = ev.target.closest?.(".pw-row [data-tip]");
    if (!t || !t.dataset.tip) return void (tipEl.hidden = true);
    tipEl.textContent = t.dataset.tip;
    tipEl.hidden = false;
    const b = t.getBoundingClientRect();
    const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    const left = Math.min(Math.max(8, b.left + b.width / 2 - w / 2), innerWidth - w - 8);
    const top = b.bottom + 8 + h > innerHeight ? b.top - h - 8 : b.bottom + 8;
    tipEl.style.left = `${left}px`;
    tipEl.style.top = `${top}px`;
  });
  addEventListener("scroll", () => (tipEl.hidden = true), true);

  const results = new Map();   // entry key -> result
  const pending = new Set();   // keys currently being looked up
  let lastError = null;         // global errors only (e.g. no API key)
  const errors = new Map();    // entry key -> error message
  let scanTimer = null;
  // Tiers only ever show as a compliment.
  const SHOWN_TIERS = new Set(["THANOS", "S", "A"]);

  // Settings → Badges (all on by default).
  const DEFAULT_BADGES = { category: true, pay: true, housing: true, verified: true, unverified: true, larp: true, tenure: true, school: true, tiers: true };
  let badges = { ...DEFAULT_BADGES };
  let badgesKey = "";
  const loadBadges = (v) => {
    badges = { ...DEFAULT_BADGES, ...(v || {}) };
    badgesKey = JSON.stringify(badges);
    scheduleScan();
  };
  chrome.storage.sync.get("badges", (v) => loadBadges(v.badges));
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === "sync" && ch.badges) loadBadges(ch.badges.newValue);
  });

  // Import tabs (opened by Settings → Import) just scrape the jobs and report back.
  let importMode = null;
  let modeKnown = false; // don't start lookups until we know this isn't an import tab
  chrome.runtime.sendMessage({ type: "pw:isImportTab" }, (yes) => {
    importMode = !!yes && !chrome.runtime.lastError ? { lastCount: -1, stableSince: 0 } : null;
    modeKnown = true;
    scheduleScan();
  });
  let lastSlug = null;
  let firstSeenAt = 0;         // when experience entries first appeared on this page
  let storedEdu = { slug: null, text: "" };

  new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true });
  scheduleScan();

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 600);
  }

  async function scan() {
    if (!modeKnown || !location.pathname.startsWith("/in/")) return;
    const entries = findEntries();
    if (importMode) return importScan(entries);
    if (!entries.length || slug() !== lastSlug) {
      lastSlug = slug();
      firstSeenAt = 0;
      if (!entries.length) return;
    }
    if (!firstSeenAt) firstSeenAt = Date.now();

    const ctx = await profileContext();
    // On the main profile page Education renders after Experience — give it a moment
    // so we know whether they're still a student before judging titles/pay.
    if (!ctx.education && !isDetailsPage() && Date.now() - firstSeenAt < 3000) {
      entries.forEach((e) => results.has(e.key + ctx.hash) || render(e, null));
      return scheduleScan();
    }
    entries.forEach((e) => (e.key += ctx.hash));

    const tenure = undergradTenure(entries);
    const missing = [];
    for (const e of entries) {
      if (results.has(e.key)) render(e, results.get(e.key), tenure?.key === e.key ? tenure : null);
      else if (lastError) renderError(e, lastError);
      else if (errors.has(e.key)) renderError(e, errors.get(e.key));
      else {
        render(e, null);
        if (!pending.has(e.key)) missing.push(e);
      }
    }
    missing.forEach((e) => lookup(e, ctx));
  }

  function importScan(entries) {
    const jobs = entries.filter((e) => e.kind === "exp");
    const now = Date.now();
    if (jobs.length !== importMode.lastCount) {
      importMode.lastCount = jobs.length;
      importMode.stableSince = now;
    }
    // wait until the list has stopped growing for 2s
    if (!jobs.length || now - importMode.stableSince < 2000) return void setTimeout(scheduleScan, 700);
    const name = document.title.split("|")[0].replace(/^\(\d+\)\s*/, "").trim();
    const data = {
      name,
      jobs: jobs.map((e) => {
        const h = parseHint(e);
        return { ...h, dates: e.dateEl.textContent.trim() };
      }),
    };
    importMode = null;
    chrome.runtime.sendMessage({ type: "pw:imported", data });
  }

  // One request per entry so each badge fills in as soon as its own search finishes.
  function lookup(e, ctx) {
    pending.add(e.key);
    const profile = { name: ctx.name, headline: ctx.headline, education: ctx.education };
    const entry = { key: e.key, text: e.text, group: e.group, hint: parseHint(e) };
    chrome.runtime.sendMessage({ type: "pw:lookup", kind: e.kind, entries: [entry], profile }, (resp) => {
      pending.delete(e.key);
      const err = chrome.runtime.lastError?.message || (!resp?.ok && (resp?.error || "Unknown error"));
      if (err === "NO_KEY") lastError = err;
      else if (err) errors.set(e.key, err);
      else if (resp.results[e.key]) results.set(e.key, resp.results[e.key]);
      else errors.set(e.key, "No result for this entry");
      scheduleScan();
    });
  }

  // ---------- DOM discovery ----------

  function findEntries() {
    const leaves = [...document.querySelectorAll("main p, main span, main div")].filter(
      (el) => el.childElementCount === 0 && DATE_RE.test(el.textContent) && el.textContent.length < 80
    );
    const seen = new Set();
    const out = [];
    for (const dateEl of leaves) {
      if (dateEl.closest(".pw-row")) continue;
      const section = sectionOf(dateEl);
      if (section !== "Experience" && section !== "Education") continue;
      const kind = section === "Education" ? "edu" : "exp";
      if (kind === "exp" && isEverydayJob(textOf(dateEl.parentElement), dateEl)) continue;
      const block = dateEl.parentElement;
      if (!block || seen.has(block)) continue;
      seen.add(block);

      const text = textOf(block);
      // Grouped roles (one company, several positions): the company lives in the outer item's header.
      const inner = dateEl.closest(ITEM_SEL);
      const outer = inner?.parentElement?.closest(ITEM_SEL);
      const group = outer ? textOf(outer).split("\n").slice(0, 2).join(" · ") : "";
      out.push({ key: hash(kind + "\n" + group + "\n" + text), kind, text, group, dateEl });
    }
    return out;
  }

  // ---------- everyday jobs we don't pocket-watch ----------
  // Cashier at McDonald's, barista, retail, delivery driving… get no badges and no lookup.
  const EVERYDAY_TITLE = /\b(cashier|barista|server|waiter|waitress|host|hostess|busser|busboy|dishwasher|(line |prep )?cook|crew (member|trainer)|team member|sales (associate|floor)|retail|stocker|stock associate|merchandiser|shift (lead|leader|manager|supervisor)|delivery driver|driver|courier|dasher|shopper|lifeguard|babysitter|nanny|dog walker|pet sitter|camp counselor|janitor|custodian|valet|front desk|bagger|food runner|bartender|usher|ticket taker|warehouse associate|package handler|picker|packer|brand ambassador)\b/i;
  const EVERYDAY_EMPLOYER = /\b(mcdonald'?s|starbucks|chipotle|in-n-out|taco bell|wendy'?s|burger king|subway|panda express|chick-fil-a|kfc|popeyes|dunkin|jamba|pizza|boba|tea house|cafe|caf\u00e9|restaurant|target|walmart|costco|trader joe'?s|whole foods|kroger|safeway|ralphs|cvs|walgreens|home depot|lowe'?s|best buy|sephora|ulta|zara|h&m|uniqlo|nordstrom|macy'?s|old navy|amc theatres|regal|kumon|mathnasium|mod pizza|raising cane'?s|sprouts|vons|albertsons)\b/i;
  const CAREER_TITLE = /engineer|developer|software|programmer|data|analyst|scientist|research|product|design|intern|marketing|finance|consult|account(ant|ing)|operations manager|strategy|it |information technology|security/i;

  function isEverydayJob(text, dateEl) {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const title = lines[0] || "";
    if (CAREER_TITLE.test(title)) return false;
    const d = lines.findIndex((l) => DATE_RE.test(l));
    const outer = dateEl.closest(ITEM_SEL)?.parentElement?.closest(ITEM_SEL);
    const company = d >= 2 ? lines[1] : outer ? textOf(outer).split("\n")[0] : "";
    return EVERYDAY_TITLE.test(title) || EVERYDAY_EMPLOYER.test(company);
  }

  const sectionCache = new WeakMap();
  function sectionOf(el) {
    if (sectionCache.has(el)) return sectionCache.get(el);
    const s = findSection(el)?.name || null;
    if (s) sectionCache.set(el, s); // don't cache misses — the heading may not have rendered yet
    return s;
  }

  function findSection(el) {
    let p = el.parentElement;
    for (let i = 0; i < 18 && p && p !== document.body; i++, p = p.parentElement) {
      const first = (p.innerText || "").trimStart().split("\n")[0].trim();
      if (SECTION_HEADINGS.test(first)) return { name: first, el: p };
    }
    return null;
  }

  // ---------- profile context (are they still a student?) ----------

  const isDetailsPage = () => /^\/in\/[^/]+\/details\//.test(location.pathname);
  const slug = () => location.pathname.split("/")[2] || "";

  async function profileContext() {
    const name = document.title.split("|")[0].replace(/^\(\d+\)\s*/, "").trim();
    const headline = headlineFor(name);

    let education = "";
    const eduDate = [...document.querySelectorAll("main p, main span, main div")].find(
      (el) => el.childElementCount === 0 && DATE_RE.test(el.textContent) && sectionOf(el) === "Education"
    );
    const eduSection = eduDate && findSection(eduDate);
    // textOf() skips our own badge rows — otherwise every school badge update would
    // change the context hash, re-key every job and flash them back to "checking…".
    if (eduSection) education = textOf(eduSection.el).slice(0, 1500);

    const sl = slug();
    if (education) {
      if (storedEdu.slug !== sl || storedEdu.text !== education) {
        storedEdu = { slug: sl, text: education };
        chrome.storage.local.set({ [`edu:${sl}`]: education });
      }
    } else {
      if (storedEdu.slug !== sl) {
        const got = await chrome.storage.local.get(`edu:${sl}`);
        storedEdu = { slug: sl, text: got[`edu:${sl}`] || "" };
      }
      education = storedEdu.text;
    }
    return { name, headline, education, hash: "." + hash(headline + "\n" + education) };
  }

  // The headline is the first text after the person's name (top card or sticky header).
  function headlineFor(name) {
    if (!name) return "";
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let found = false;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.textContent.trim();
      if (!t) continue;
      if (!found) found = t === name;
      else if (t !== name && t.length > 3 && !/^(·|\d+(st|nd|rd|th)|He\/Him|She\/Her|They\/Them)/i.test(t)) return t.slice(0, 200);
    }
    return "";
  }

  // ---------- rendering ----------

  function syncTheme() {
    const m = getComputedStyle(document.body).backgroundColor.match(/\d+/g);
    const dark = m && (0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]) < 100 && (m[3] === undefined || m[3] !== "0");
    document.documentElement.classList.toggle("pw-dark", !!dark);
  }

  function rowFor(e) {
    syncTheme();
    const block = e.dateEl.parentElement;
    let row = block.querySelector(":scope > .pw-row");
    if (!row) {
      row = document.createElement("div");
      row.className = "pw-row";
      // Each LinkedIn entry is one big link: keep badge clicks/drags from navigating
      // so the text can be selected.
      row.setAttribute("draggable", "false");
      row.addEventListener("click", (ev) => {
        if (ev.target.closest(".pw-err")) return;
        ev.preventDefault();
        ev.stopPropagation();
      });
      row.addEventListener("dragstart", (ev) => ev.preventDefault());
      block.append(row);
    }
    return row;
  }

  function render(e, r, tenure) {
    const row = rowFor(e);
    const sig = r ? `done|${badgesKey}${tenure ? "|" + tenure.label : ""}` : "loading";
    if (row.dataset.sig === sig) return;
    if (!r && row.dataset.sig?.startsWith("done")) return; // once loaded, stay loaded
    row.dataset.sig = sig;
    if (!r) {
      row.innerHTML = `<span class="pw-chip pw-wait"><span class="pw-spin"></span>${e.kind === "edu" ? "checking school…" : "checking pockets…"}</span>`;
      return;
    }
    if (e.kind === "edu") return void (row.innerHTML = eduChips(r) + (badges.tenure ? tenureChip(tenure) : ""));
    if (r.skip) {
      row.innerHTML = "";
      row.hidden = true;
      return;
    }
    const cur = r.currency || "USD";
    const chips = [];
    const tier = String(r.tier || "").toUpperCase();
    if (badges.tiers && SHOWN_TIERS.has(tier)) {
      chips.push(`<span class="pw-chip pw-tier pw-t-${tier}" data-tip="${esc(r.tier_reason || "")}">${TIER_LABELS[tier]}</span>`);
    }
    if (badges.larp && r.larp) {
      const larpTip = `LARP: a wildly inflated title for what it really was, like "Member of Technical Staff" at a school club or "CEO" of an app with no users.\n\nWhy: ${r.larp_reason || "The title is far bigger than the role."}`;
      chips.push(`<span class="pw-chip pw-larp" data-tip="${esc(larpTip)}">LARP</span>`);
    }
    const cat = badges.category ? categoryChip(r) : "";
    if (cat) chips.push(cat);
    const yc = badges.category ? ycBatch(r, e) : null;
    if (yc) chips.push(`<span class="pw-chip pw-yc" data-tip="Y Combinator ${esc(yc)} batch"><span class="pw-yc-y">Y</span>${esc(yc === "YC" ? "Combinator" : yc)}</span>`);
    if (badges.unverified && r.verified === false) {
      chips.push(`<span class="pw-chip pw-unverified" data-tip="${esc(r.verify_note || "Couldn't confirm this company/role or its pay online")}">unverified</span>`);
    }
    if (!badges.pay) {
      // pay badges off
    } else if (r.unpaid) {
      chips.push(`<span class="pw-chip pw-unpaid" data-tip="${esc(r.pay_basis || "")}">unpaid</span>`);
    } else if (r.pay_hourly || r.pay_annual) {
      const kind = employmentOf(r, e);
      const parts =
        kind === "full-time"
          ? [`${money(r.pay_annual, cur, 0, true)} TC`, r.level ? `<span class="pw-dim">${esc(r.level)}</span>` : null]
          : r.pay_period === "month"
            ? [money(r.pay_amount, cur, 0) + "/mo", `<span class="pw-dim">≈${hourlyStr(r.pay_hourly, cur)}/hr</span>`]
            : [hourlyStr(r.pay_hourly, cur) + "/hr"];
      // Blue check = confirmed by you (Known pay). Everything found online is an estimate.
      const confirmed = r.pay_scope === "reported";
      const scope = confirmed ? "" : ` <span class="pw-dim">${{ market: "est. mkt", median: "median", edited: "edited" }[r.pay_scope] || "approx."}</span>`;
      const check = badges.verified && confirmed ? verifiedCheck(`Confirmed · ${r.pay_source}`) : "";
      const what =
        kind === "full-time"
          ? `Total compensation per year (base + stock + bonus)${r.level ? ` at ${r.level}` : ", assuming the new-grad level"}.`
          : r.pay_period === "month"
            ? "Monthly salary. The hourly figure is only an equivalent (salary × 12 ÷ 2080 hrs)."
            : "";
      const how = {
        reported: `Confirmed by you · ${r.pay_source || "Known pay"}`,
        edited: "Estimate you corrected in Settings. Not confirmed.",
        company: "Approximate: pay found online for this company and role. Not confirmed, so it could be off.",
        market: `Estimated market rate: no pay found for this company, so this is typical pay for the title${r.location ? ` in ${r.location}` : ""}.`,
        median: "Estimate: the median of pay known for this role at this company in other US locations.",
      }[r.pay_scope] || "Estimate. Not confirmed.";
      const source = r.pay_scope === "reported" || r.pay_scope === "edited" ? "" : r.pay_basis ? `Source: ${r.pay_basis}` : "";
      const payTip = [how, what, source].filter(Boolean).join("\n\n");
      chips.push(`<span class="pw-chip pw-pay" data-tip="${esc(payTip)}">${parts.filter(Boolean).join(" ")}${scope}${check}</span>`);
      if (badges.housing && r.is_internship && r.housing_amount) {
        const h = r.housing_period === "month" ? `${money(r.housing_amount, cur, 0)}/mo` : money(r.housing_amount, cur, 0);
        chips.push(`<span class="pw-chip pw-housing" data-tip="Housing stipend${r.housing_period === "month" ? " (monthly)" : " (lump sum)"}">🏠 ${h} housing</span>`);
      }
    } else if (r.pay_basis) {
      chips.push(`<span class="pw-chip pw-dim" data-tip="${esc(r.pay_basis)}">pay n/a</span>`);
    }
    row.innerHTML = chips.join("");
  }

  function renderError(e, err) {
    const row = rowFor(e);
    if (row.dataset.sig === "err") return;
    row.dataset.sig = "err";
    const noKey = err === "NO_KEY";
    row.innerHTML = `<span class="pw-chip pw-err" data-tip="${esc(err)}">⌚ ${noKey ? "add Gemini key" : "lookup failed — retry"}</span>`;
    row.firstChild.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (noKey) chrome.runtime.sendMessage({ type: "pw:options" });
      else {
        errors.delete(e.key);
        scan();
      }
    };
  }

  // YC batch: from the company name ("Acme (YC W24)") or the model's yc_batch.
  function ycBatch(r, e) {
    const m = `${e.text}\n${e.group}`.match(/\(?\bYC\s*[-–]?\s*([WSFX]\s?'?\d{2}|(?:Winter|Summer|Fall|Spring)\s*'?\d{2,4})\)?/i);
    if (m) return m[1].replace(/\s|'/g, "").replace(/^(Winter|Summer|Fall|Spring)(\d{2,4})$/i, (_, t, y) => t[0].toUpperCase() + y.slice(-2)).toUpperCase();
    const b = String(r.yc_batch || "").trim();
    return b ? b.replace(/^YC\s*/i, "") || "YC" : null;
  }

  // internship / part-time / contract are shown hourly (or monthly); full-time as TC.
  function employmentOf(r, e) {
    const t = String(r.employment || "").toLowerCase();
    if (t) return t;
    if (/·\s*(part-time|contract|freelance|seasonal)/i.test(e.text)) return "part-time";
    return r.is_internship ? "internship" : "full-time";
  }

  // "Skyryse is valued at $1.15B after a $300M Series C (Feb 2026). Source: TechCrunch"
  function fundingTip(r, name) {
    const co = r.company || "This company";
    const round = r.round_name
      ? `${r.round_amount ? `a ${fmtValuation(r.round_amount)} ` : "a "}${r.round_name}${r.round_date ? ` (${r.round_date})` : ""}`
      : "";
    const line = r.valuation
      ? `${co} is valued at ${fmtValuation(r.valuation)}${round ? ` after ${round}` : ""}.`
      : `${co} raised ${round}.`;
    const lead = name === "Unicorn" ? "Unicorn: a private startup valued at $1B+.\n\n" : "";
    return `${lead}${line}${r.valuation_source ? `\nSource: ${r.valuation_source}` : ""}`;
  }

  function fmtValuation(n) {
    return n >= 1e9 ? `$${(n / 1e9).toFixed(n >= 1e10 ? 0 : 2).replace(/\.?0+$/, "")}B` : `$${Math.round(n / 1e6)}M`;
  }

  function verifiedCheck(tip) {
    return `<span class="pw-check" data-tip="${esc(tip)}"><svg viewBox="0 0 16 16" width="13" height="13" aria-label="verified"><circle cx="8" cy="8" r="8" fill="#1d9bf0"/><path d="M4.5 8.2l2.3 2.3 4.7-4.9" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
  }

  function eduChips(r) {
    const tier = String(r.tier || "").toUpperCase();
    if (!TIER_LABELS[tier]) return ""; // high school, certificates, etc.
    const chips = badges.tiers && SHOWN_TIERS.has(tier) ? [`<span class="pw-chip pw-tier pw-t-${tier}" data-tip="${esc(r.tier_reason || "")}">${TIER_LABELS[tier]}</span>`] : [];
    if (badges.school && r.label) chips.push(`<span class="pw-chip pw-cat pw-c-school"><span class="pw-ico">🎓</span>${esc(r.label)}</span>`);
    return chips.join("");
  }

  // ---------- time in undergrad (incl. community college) ----------
  //
  // Sum the months enrolled across undergrad + community-college entries (overlaps
  // count once, gaps between schools don't count). A standard 4 years (Sep → Jun) is
  // 45 months; each extra year adds ~12.
  //   ≤ 41 mo → early grad · 42–50 → on time · 51–62 → super senior · ≥ 63 → super duper senior
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const UNDERGRAD = /^(undergrad|community college)$/;

  function parseRange(text) {
    const m = text.match(/\b(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s)?(\d{4})\s*[-–]\s*(?:(Present)|(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s)?(\d{4}))/i);
    if (!m) return null;
    const start = +m[2] * 12 + (m[1] ? MONTHS[m[1].toLowerCase()] : 8); // year-only start → Sep
    const now = new Date();
    const end = m[3] ? now.getFullYear() * 12 + now.getMonth() : +m[5] * 12 + (m[4] ? MONTHS[m[4].toLowerCase()] : 5); // year-only end → Jun
    return end > start ? { start, end } : null;
  }

  function undergradTenure(entries) {
    const spans = [];
    for (const e of entries) {
      const r = e.kind === "edu" && results.get(e.key);
      if (!r || !UNDERGRAD.test(r.level || "")) continue;
      const range = parseRange(e.text);
      if (range) spans.push({ ...range, e, cc: r.level === "community college" });
    }
    if (!spans.length) return null;

    // union of intervals
    const sorted = [...spans].sort((a, b) => a.start - b.start);
    let months = 0, curS = sorted[0].start, curE = sorted[0].end;
    for (const sp of sorted.slice(1)) {
      if (sp.start <= curE) curE = Math.max(curE, sp.end);
      else { months += curE - curS; curS = sp.start; curE = sp.end; }
    }
    months += curE - curS;

    // badge goes on the (non-CC) school they finish at
    const target = [...spans].sort((a, b) => (a.cc - b.cc) || (b.end - a.end))[0];
    const now = new Date();
    const ongoing = target.end > now.getFullYear() * 12 + now.getMonth();
    // academic years: Sep→Jun (45 mo) = 4, so years ≈ (months + 3) / 12, to the half year
    const yrs = `${Math.round(((months + 3) / 12) * 2) / 2} yrs`;
    const cc = spans.some((s) => s.cc) ? " incl. community college" : "";
    const [label, cls] =
      months <= 41 ? ["Early grad", "early"] :
      months <= 50 ? ["On time", "ontime"] :
      months <= 62 ? ["Super senior", "super"] :
      ["SUPER DUPER SENIOR", "superduper"];
    const tip = `${Math.round(months)} months of undergrad${cc} (~${yrs}${ongoing ? ", expected" : ""}). ~45 months = a standard 4 years.`;
    return { key: target.e.key, label: `${label} · ${yrs}${ongoing ? " (exp.)" : ""}`, cls, tip };
  }

  function tenureChip(t) {
    return t ? `<span class="pw-chip pw-tenure pw-ten-${t.cls}" data-tip="${esc(t.tip)}">${esc(t.label)}</span>` : "";
  }

  const CATEGORY_TIPS = {
    MANGO: "MANGO = Meta, Anthropic, Nvidia, Google, OpenAI. The newer, AI-era answer to FAANG, and a tier above it.",
    FAANG: "FAANG = Facebook (Meta), Apple, Amazon, Netflix, Google. The staple of the bootcamp era and the peak back then, but lowkey fell off. Meta and Google moved up to MANGO.",
    "FAANG-adjacent": "Right next to FAANG: Microsoft, Uber, DoorDash, LinkedIn, Tesla.",
    "FAANG-lite": "Strong, well-paying tech a step below FAANG: Capital One, Airbnb, Stripe, Snowflake, Databricks and similar.",
    Quant: "Quant trading / HFT / market making.",
    "AI Lab": "A frontier AI lab.",
    Unicorn: "A private startup valued at $1B+.",
  };

  const CATEGORIES = {
    "MANGO": { cls: "mango", icon: "🥭" },
    "FAANG": { cls: "faang", icon: "★" },
    "FAANG-adjacent": { cls: "faangadj", icon: "☆" },
    "FAANG+": { cls: "faangadj", icon: "☆" },
    "FAANG-lite": { cls: "faanglite", icon: "" },
    "AI Lab": { cls: "ailab", icon: "✦" },
    "Quant": { cls: "quant", icon: "∑" },
    "Hedge Fund": { cls: "hedge", icon: "◆" },
    "Fintech": { cls: "fintech", icon: "$" },
    "Big Tech": { cls: "bigtech", icon: "▣" },
    "Unicorn": { cls: "unicorn", icon: "🦄" },
    "Startup": { cls: "startup", icon: "🚀" },
    "Bank": { cls: "bank", icon: "🏦" },
    "Consulting": { cls: "consulting", icon: "◇" },
    "Defense": { cls: "defense", icon: "⛨" },
    "University": { cls: "school", icon: "🎓" },
    "Student org": { cls: "school", icon: "🎓" },
    "Government": { cls: "plain", icon: "🏛" },
  };

  function categoryChip(r) {
    const name = r.category || r.company_type;
    if (!name) return "";
    const c = CATEGORIES[name] || { cls: "plain", icon: "" };
    // Funding round only means something for regular startups; a unicorn is just $1B+.
    const label = name === "Startup" && r.stage ? `${r.stage} startup` : name === "University" ? "University position" : name;
    const tip = (name === "Unicorn" || name === "Startup") && (r.valuation || r.round_name) ? fundingTip(r, name) : CATEGORY_TIPS[name];
    const val = name === "Unicorn" && r.valuation ? ` <span class="pw-dim">${fmtValuation(r.valuation)}</span>` : "";
    return `<span class="pw-chip pw-cat pw-c-${c.cls}"${tip ? ` data-tip="${esc(tip)}"` : ""}>${c.icon ? `<span class="pw-ico">${c.icon}</span>` : ""}<span class="pw-lbl">${esc(label)}</span>${val}</span>`;
  }

  // ---------- utils ----------

  // $21/hr stays "$21", $57.69/hr keeps its cents.
  function hourlyStr(n, cur) {
    return money(n, cur, Number.isInteger(Number(n)) ? 0 : 2);
  }

  function money(n, cur, digits, compact) {
    if (n == null || isNaN(n)) return "—";
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency", currency: cur, maximumFractionDigits: digits, minimumFractionDigits: digits,
        ...(compact ? { notation: "compact" } : {}),
      }).format(n);
    } catch {
      return `${Math.round(n)} ${cur}`;
    }
  }

  // Rough title/company/location parse — only used as a key for the shared company/pay cache.
  function parseHint(e) {
    const lines = e.text.split("\n").map((l) => l.trim()).filter(Boolean);
    const d = lines.findIndex((l) => DATE_RE.test(l));
    const title = lines[0] || "";
    const companyLine = d >= 2 ? lines[1] : e.group || "";
    const company = companyLine.split("·")[0].trim();
    const type = (companyLine.split("·")[1] || "").trim();
    const loc = d >= 0 && lines[d + 1] && lines[d + 1].length < 60 ? lines[d + 1].split("·")[0].trim() : "";
    return { title, company, type, location: loc };
  }

  // innerText of an element, minus any badge rows we injected (they'd change the entry's key).
  function textOf(el) {
    const rows = [...el.querySelectorAll(".pw-row")];
    rows.forEach((r) => (r.style.display = "none"));
    const t = tidy(el.innerText);
    rows.forEach((r) => (r.style.display = ""));
    return t;
  }

  function tidy(t) {
    return (t || "").replace(/\n{2,}/g, "\n").trim();
  }

  function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
})();
