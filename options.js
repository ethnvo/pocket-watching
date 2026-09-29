const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
const money = (n, digits = 0) =>
  `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const num = (v) => parseFloat(String(v || "").replace(/[$,\s]/g, ""));
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function flash(el, text, kind = "ok", ms = 2500) {
  el.textContent = text;
  el.className = `status ${kind}`;
  clearTimeout(el._t);
  if (ms) el._t = setTimeout(() => (el.textContent = ""), ms);
}

// ---------- watch dial: hands show the current time ----------
(function dial() {
  const ticks = document.querySelector(".dial-ticks");
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
    const r1 = i % 3 === 0 ? 11.5 : 13, r2 = 14.5;
    l.setAttribute("x1", 24 + Math.sin(a) * r1); l.setAttribute("y1", 26 - Math.cos(a) * r1);
    l.setAttribute("x2", 24 + Math.sin(a) * r2); l.setAttribute("y2", 26 - Math.cos(a) * r2);
    ticks.appendChild(l);
  }
  const set = () => {
    const d = new Date();
    const m = d.getMinutes() + d.getSeconds() / 60;
    const h = (d.getHours() % 12) + m / 60;
    $("hand-m").setAttribute("transform", `rotate(${m * 6} 24 26)`);
    $("hand-h").setAttribute("transform", `rotate(${h * 30} 24 26)`);
  };
  set();
  setInterval(set, 15000);
})();

// ---------- rail: highlight the section in view ----------
const railLinks = [...document.querySelectorAll(".rail a")];
const railObs = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) railLinks.forEach((a) => a.classList.toggle("active", a.getAttribute("href") === `#${e.target.id}`));
    }
  },
  { rootMargin: "-20% 0px -70% 0px" }
);
document.querySelectorAll("main section").forEach((s) => railObs.observe(s));
// the last section can't scroll into the observer band — light it up at the bottom
addEventListener("scroll", () => {
  if (innerHeight + scrollY >= document.body.scrollHeight - 4)
    railLinks.forEach((a, i) => a.classList.toggle("active", i === railLinks.length - 1));
});

// ---------- setup ----------
chrome.storage.sync.get(["apiKey", "model"], ({ apiKey, model }) => {
  $("apiKey").value = apiKey || "";
  $("model").value = model || "";
});
$("toggleKey").onclick = () => {
  const show = $("apiKey").type === "password";
  $("apiKey").type = show ? "text" : "password";
  $("toggleKey").textContent = show ? "Hide" : "Show";
};
$("saveKey").onclick = async () => {
  await chrome.storage.sync.set({ apiKey: $("apiKey").value.trim(), model: $("model").value.trim() });
  flash($("keyStatus"), "Key saved");
};
$("testKey").onclick = async () => {
  const key = $("apiKey").value.trim();
  if (!key) return flash($("keyStatus"), "Paste a key first.", "err");
  const model = $("model").value.trim() || "gemini-2.5-flash";
  $("testKey").disabled = true;
  flash($("keyStatus"), "Testing…", "", 0);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`, {
      headers: { "x-goog-api-key": key },
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) flash($("keyStatus"), `Key works with ${body.displayName || model}.`);
    else flash($("keyStatus"), body?.error?.message || `Gemini returned ${res.status}.`, "err", 6000);
  } catch {
    flash($("keyStatus"), "Couldn't reach Gemini. Check your connection.", "err", 6000);
  } finally {
    $("testKey").disabled = false;
  }
};

// ---------- community pay ----------
chrome.storage.sync.get("useCommunity", ({ useCommunity }) => ($("useCommunity").checked = useCommunity !== false));
$("useCommunity").onchange = async () => {
  await chrome.storage.sync.set({ useCommunity: $("useCommunity").checked });
  await chrome.storage.local.remove("community"); // re-fetch on next lookup
};
chrome.storage.local.get("community", ({ community }) => {
  if (community?.rows?.length)
    $("communityStat").textContent = `${community.rows.length} real offers people submitted to the repo, reviewed before they're added. Your own Known pay always wins.`;
});

// ---------- known pay ----------
async function getKnown() {
  const { knownPay = [] } = await chrome.storage.local.get("knownPay");
  return knownPay;
}
async function setKnown(list) {
  await chrome.storage.local.set({ knownPay: list });
  renderKnown();
}
const knownId = (k) => `${norm(k.company)}|${norm(k.role)}|${norm(k.location)}`;

function describePay(k) {
  const main = k.hourly
    ? `${money(k.hourly, Number.isInteger(k.hourly) ? 0 : 2)}/hr`
    : k.monthly
      ? `${money(k.monthly)}/mo`
      : `${money(k.annual)}/yr`;
  const kind = k.intern ? "intern" : "full-time";
  const housing = k.housing ? `${money(k.housing)}${k.housing_period === "total" ? "" : "/mo"} housing` : "";
  return `${main} <span class="kind">${kind}${k.reference ? " · reference only" : ""}</span>${housing ? `<small>${housing}</small>` : ""}${k.source ? `<small class="src">${esc(k.source)}</small>` : ""}`;
}

async function renderKnown() {
  const list = await getKnown();
  $("knownEmpty").hidden = list.length > 0;
  $("knownTable").innerHTML = list
    .map(
      (k, i) => `<div class="row" role="row">
        <span class="co" role="cell">${esc(k.company)}</span>
        <span class="role" role="cell">${esc(k.role || "Any role")}<small>${esc(k.location || "Any location")}</small></span>
        <span class="pay" role="cell">${describePay(k)}</span>
        <button class="remove" data-i="${i}" type="button" aria-label="Remove ${esc(k.company)}">Remove</button>
      </div>`
    )
    .join("");
  $("knownTable").querySelectorAll(".remove").forEach(
    (b) =>
      (b.onclick = async () => {
        const list = await getKnown();
        list.splice(+b.dataset.i, 1);
        setKnown(list);
      })
  );
}

function entryFrom(company, role, amount, unit, housing, location, source, reference) {
  const e = { company, ...(role ? { role } : {}), ...(location ? { location } : {}), ...(source ? { source } : {}), ...(reference ? { reference: true } : {}) };
  if (unit === "yr") Object.assign(e, { annual: amount, intern: false });
  else if (unit === "mo") Object.assign(e, { monthly: amount, intern: true });
  else Object.assign(e, { hourly: amount, intern: unit === "hr" });
  if (housing) Object.assign(e, { housing, housing_period: "month" });
  return e;
}

async function upsertKnown(entries) {
  const list = await getKnown();
  for (const e of entries) {
    const i = list.findIndex((k) => knownId(k) === knownId(e));
    if (i >= 0) list[i] = e;
    else list.push(e);
  }
  await setKnown(list);
}

$("addForm").onsubmit = async (ev) => {
  ev.preventDefault();
  const amount = num($("kpAmount").value);
  if (!amount) return $("kpAmount").focus();
  await upsertKnown([
    entryFrom($("kpCompany").value.trim(), $("kpRole").value.trim(), amount, $("kpUnit").value, num($("kpHousing").value), $("kpLocation").value.trim(), $("kpSource").value.trim(), $("kpReference").checked),
  ]);
  ["kpCompany", "kpRole", "kpLocation", "kpAmount", "kpHousing", "kpSource"].forEach((id) => ($(id).value = ""));
  $("kpReference").checked = false;
  $("kpCompany").focus();
};

// ---------- import a profile ----------
$("importForm").onsubmit = (ev) => {
  ev.preventDefault();
  const url = $("importUrl").value.trim();
  $("importBtn").disabled = true;
  $("importList").hidden = true;
  flash($("importStatus"), "Opening the profile in a background tab. This takes a few seconds…", "", 0);
  chrome.runtime.sendMessage({ type: "pw:import", url }, async (resp) => {
    $("importBtn").disabled = false;
    if (chrome.runtime.lastError || !resp?.ok) {
      return flash($("importStatus"), resp?.error || chrome.runtime.lastError?.message || "Import failed.", "err", 0);
    }
    const { name, jobs } = resp.data;
    if (!jobs.length) return flash($("importStatus"), "No jobs found on that profile.", "err", 0);
    $("importStatus").textContent = "";
    renderImport(name, jobs, await getKnown());
  });
};

// Same matching as the badges: "Amazon Music" counts as "Amazon"; a role-specific row wins.
const canonCompany = (s) => norm(s).replace(/^(facebook( inc)?|meta platforms( inc)?)\b/, "meta");

function findKnown(list, company, title, location) {
  const c = canonCompany(company);
  const city = (l) => norm(String(l || "").split(",")[0]).replace(/\b(greater|metropolitan|metro|area|region|bay)\b/g, " ").trim();
  const here = (k) => !k.location || !location || city(k.location).includes(city(location)) || city(location).includes(city(k.location));
  const hits = list.filter((k) => { const kc = canonCompany(k.company); return kc && (c === kc || c.startsWith(kc + " ")) && here(k); });
  return hits.find((k) => k.role && norm(title).includes(norm(k.role))) || hits.find((k) => !k.role) || null;
}

function unitFor(job, known) {
  if (known) return known.annual ? "yr" : known.monthly ? "mo" : known.intern ? "hr" : "hrft";
  return /intern|co-?op/i.test(`${job.type} ${job.title}`) ? "hr" : "yr";
}

function renderImport(name, jobs, known) {
  const box = $("importList");
  box.hidden = false;
  box.innerHTML =
    `<div class="import-head"><strong>${esc(name || "Imported profile")}</strong><span class="hint" style="margin:0">${jobs.length} job${jobs.length === 1 ? "" : "s"} · leave pay blank to skip</span></div>` +
    jobs
      .map((j, i) => {
        const k = findKnown(known, j.company, j.title, j.location);
        const amount = k ? k.hourly ?? k.monthly ?? k.annual : "";
        const unit = unitFor(j, k);
        const opt = (v, t) => `<option value="${v}"${v === unit ? " selected" : ""}>${t}</option>`;
        return `<div class="job" data-i="${i}">
          <div class="what"><b>${esc(j.title)}</b><span>${esc(j.company || "Unknown company")}${j.type ? ` · ${esc(j.type)}` : ""}</span><em>${esc(j.dates || "")}</em></div>
          <div class="field"><label for="il${i}">Location</label><input id="il${i}" value="${esc(j.location || "")}" placeholder="Anywhere"></div>
          <div class="field money"><label for="ip${i}">Pay</label><input id="ip${i}" inputmode="decimal" value="${esc(amount)}" placeholder="—"></div>
          <div class="field"><label for="iu${i}">Per</label><select id="iu${i}">${opt("hr", "hour · intern")}${opt("mo", "month · intern")}${opt("hrft", "hour · full-time")}${opt("yr", "year · full-time")}</select></div>
          <div class="field money"><label for="ih${i}">Housing / mo</label><input id="ih${i}" inputmode="decimal" value="${esc(k?.housing ?? "")}" placeholder="—"></div>
        </div>`;
      })
      .join("") +
    `<div class="import-foot"><div class="field" style="margin:0 auto 0 0;min-width:220px"><label for="importSource">Source for these</label><input id="importSource" placeholder="e.g. Summer 2026 offers"></div><button class="ghost" type="button" id="importCancel">Discard</button><button class="primary" type="button" id="importSave">Save to Known pay</button></div>`;

  const k0 = (j) => findKnown(known, j.company, j.title, j.location);
  $("importCancel").onclick = () => { box.hidden = true; };
  $("importSave").onclick = async () => {
    const entries = [];
    jobs.forEach((j, i) => {
      const amount = num($(`ip${i}`).value);
      if (!amount || !j.company) return;
      entries.push(entryFrom(j.company, j.title, amount, $(`iu${i}`).value, num($(`ih${i}`).value), $(`il${i}`).value.trim(), $("importSource").value.trim() || k0(j)?.source));
    });
    if (!entries.length) return flash($("importStatus"), "Fill in pay for at least one job.", "err");
    await upsertKnown(entries);
    box.hidden = true;
    flash($("importStatus"), `Saved pay for ${entries.length} job${entries.length === 1 ? "" : "s"}.`);
    $("known").scrollIntoView();
  };
}

// ---------- estimates: browse, correct, confirm, delete ----------
const JOB_CACHE = "v25:"; // keep in sync with background.js
const CATEGORY_OPTIONS = ["MANGO", "FAANG", "FAANG-adjacent", "FAANG-lite", "AI Lab", "Quant", "Hedge Fund", "Fintech", "Big Tech", "Unicorn", "Startup", "Bank", "Consulting", "Defense", "Public co", "Private co", "University", "Government", "Nonprofit", "Student org", "Volunteer", "Self-employed"];

function estPay(d) {
  if (d.unpaid) return "Unpaid";
  if (!d.pay_hourly && !d.pay_annual) return "No pay found";
  const ft = (d.employment || (d.is_internship ? "internship" : "full-time")) === "full-time";
  if (ft) return `${money(d.pay_annual)} TC${d.level ? ` · ${d.level}` : ""}`;
  if (d.pay_period === "month") return `${money(d.pay_amount)}/mo`;
  return `${money(d.pay_hourly, Number.isInteger(d.pay_hourly) ? 0 : 2)}/hr`;
}
const SCOPE_LABEL = { company: "approx.", market: "est. mkt", median: "median", edited: "edited", reported: "confirmed", community: "community" };

async function renderEstimates() {
  const all = await chrome.storage.local.get(null);
  const q = norm($("estSearch").value);
  const rows = Object.entries(all)
    .filter(([k, v]) => k.startsWith(JOB_CACHE) && v?.data)
    .map(([key, v]) => ({ key, ...v, h: v.hint || {}, d: v.data }))
    .filter((r) => !q || norm(`${r.h.company || r.d.company} ${r.h.title || r.d.role} ${r.h.location || r.d.location} ${r.who}`).includes(q))
    .sort((a, b) => b.at - a.at);
  $("estEmpty").hidden = rows.length > 0;
  $("estTable").innerHTML = rows
    .map((r) => {
      const scope = r.d.pay_scope || "company";
      return `<div class="row" data-key="${esc(r.key)}">
        <span><b>${esc(r.h.company || r.d.company || "Unknown")}</b><span class="role" style="display:block">${esc(r.h.title || r.d.role || "")}</span>
          <span class="who">${esc(r.h.location || r.d.location || "")}${r.who ? ` · from ${esc(r.who)}` : ""}</span></span>
        <span class="pay">${esc(estPay(r.d))}<span class="tags"><span class="tag${scope === "edited" ? " edited" : ""}">${SCOPE_LABEL[scope] || "approx."}</span>${r.d.category ? `<span class="tag">${esc(r.d.category)}</span>` : ""}</span></span>
        <span class="who">${new Date(r.at).toLocaleDateString()}</span>
        <span class="row-actions">
          <button type="button" data-act="edit">Edit</button>
          <button type="button" data-act="confirm" title="Move to Known pay with a blue check">Confirm</button>
          <button type="button" data-act="del" class="del">Delete</button>
        </span>
      </div>`;
    })
    .join("");
}

function editRowHtml(d) {
  const unit = d.pay_period === "month" ? "mo" : d.pay_period === "year" ? "yr" : "hr";
  const ft = (d.employment || (d.is_internship ? "internship" : "full-time")) === "full-time";
  const amount = d.pay_period === "year" ? d.pay_annual ?? d.pay_amount : d.pay_period === "month" ? d.pay_amount : d.pay_hourly;
  const opt = (v, t, cur) => `<option value="${v}"${v === cur ? " selected" : ""}>${t}</option>`;
  return `<div class="edit-row">
    <div class="field money"><label>Pay</label><input data-f="amount" inputmode="decimal" value="${esc(amount ?? "")}"></div>
    <div class="field"><label>Per</label><select data-f="unit">${opt("hr", "hour", unit)}${opt("mo", "month", unit)}${opt("yr", ft ? "year · TC" : "year", unit)}</select></div>
    <div class="field money"><label>Housing/mo</label><input data-f="housing" inputmode="decimal" value="${esc(d.housing_period === "month" ? d.housing_amount ?? "" : "")}"></div>
    <div class="field"><label>Company type</label><select data-f="category">${CATEGORY_OPTIONS.map((c) => opt(c, c, d.category)).join("")}</select></div>
    <div class="field"><label>Level</label><input data-f="level" value="${esc(d.level || "")}" placeholder="${ft ? "E3, L3…" : "—"}"></div>
    <div class="btns"><button type="button" class="ghost" data-act="cancel">Cancel</button><button type="button" class="primary" data-act="save">Save</button></div>
  </div>`;
}

$("estSearch").oninput = () => renderEstimates();
$("estTable").onclick = async (ev) => {
  const btn = ev.target.closest("button[data-act]");
  if (!btn) return;
  const row = btn.closest(".row") || btn.closest(".edit-row")?.previousElementSibling;
  const key = row?.dataset.key;
  const cur = key && (await chrome.storage.local.get(key))[key];
  if (!cur) return renderEstimates();
  const d = cur.data, h = cur.hint || {};

  if (btn.dataset.act === "del") {
    await chrome.storage.local.remove(key);
    flash($("estStatus"), "Deleted. It'll be looked up again next time you visit that profile.");
    return renderEstimates();
  }
  if (btn.dataset.act === "edit") {
    row.nextElementSibling?.classList.contains("edit-row") ? row.nextElementSibling.remove() : row.insertAdjacentHTML("afterend", editRowHtml(d));
    return;
  }
  if (btn.dataset.act === "cancel") return btn.closest(".edit-row").remove();
  if (btn.dataset.act === "save") {
    const form = btn.closest(".edit-row");
    const f = (n) => form.querySelector(`[data-f="${n}"]`).value.trim();
    const amount = num(f("amount"));
    const period = { hr: "hour", mo: "month", yr: "year" }[f("unit")];
    const housing = num(f("housing"));
    const patch = {
      category: f("category"),
      level: f("level") || null,
      ...(amount ? { pay_amount: amount, pay_period: period } : {}),
      ...(housing ? { housing_amount: housing, housing_period: "month" } : { housing_amount: null, housing_period: null }),
    };
    chrome.runtime.sendMessage({ type: "pw:editEstimate", key, patch }, (resp) => {
      if (chrome.runtime.lastError || !resp?.ok) return flash($("estStatus"), resp?.error || "Couldn't save.", "err", 6000);
      flash($("estStatus"), "Saved. Refresh LinkedIn to see it.");
      renderEstimates();
    });
    return;
  }
  if (btn.dataset.act === "confirm") {
    if (!d.pay_hourly && !d.pay_annual) return flash($("estStatus"), "There's no pay to confirm on that one. Edit it first.", "err");
    const ft = (d.employment || (d.is_internship ? "internship" : "full-time")) === "full-time";
    const unit = ft ? "yr" : d.pay_period === "month" ? "mo" : d.is_internship ? "hr" : "hrft";
    const amount = unit === "yr" ? d.pay_annual : unit === "mo" ? d.pay_amount : d.pay_hourly; // hr / hrft
    await upsertKnown([
      entryFrom(h.company || d.company, h.title || d.role, amount, unit, d.housing_period === "month" ? d.housing_amount : null, h.location || d.location, "Confirmed from an estimate"),
    ]);
    flash($("estStatus"), `Confirmed. ${h.company || d.company} is in Known pay now.`);
    return;
  }
};

// ---------- badges ----------
const BADGES = [
  ["pay", "Pay", "Hourly, monthly or yearly pay for each job"],
  ["housing", "Housing stipend", "Monthly or lump-sum housing for internships"],
  ["verified", "Confirmed check", "Blue check on pay you've confirmed in Known pay"],
  ["unverified", "Unverified flag", "When Gemini couldn't confirm a company or its pay"],
  ["category", "Company type", "MANGO, FAANG, Quant, Startup, Fintech and so on"],
  ["tiers", "Compliments", "THANOS, S and A tier on standout jobs and schools"],
  ["larp", "LARP flag", "Wildly inflated titles, like Member of Technical Staff at a school club"],
  ["school", "School label", "Top 5 CS, Ivy, UC and similar"],
  ["tenure", "Time in school", "Early grad, super senior and beyond"],
];
chrome.storage.sync.get("badges", ({ badges = {} }) => {
  $("toggles").innerHTML = BADGES.map(
    ([key, title, desc]) => `<label class="toggle" for="b-${key}">
      <span><span class="t">${title}</span><span class="d">${desc}</span></span>
      <span class="switch"><input type="checkbox" id="b-${key}" data-key="${key}"${badges[key] === false ? "" : " checked"}><span></span></span>
    </label>`
  ).join("");
  $("toggles").querySelectorAll("input").forEach(
    (inp) =>
      (inp.onchange = async () => {
        const { badges = {} } = await chrome.storage.sync.get("badges");
        badges[inp.dataset.key] = inp.checked;
        chrome.storage.sync.set({ badges });
      })
  );
});

// ---------- data: confirmed vs estimated ----------
const ESTIMATE_KEY = /^(v\d+|entry|cache|edu|co\d*|pay\d*|school\d*):/;
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

async function countConfirmed() {
  const { knownPay = [], knownCompanies = [] } = await chrome.storage.local.get(["knownPay", "knownCompanies"]);
  const conf = knownPay.filter((k) => !k.reference).length;
  const refs = knownPay.length - conf;
  $("confirmedStat").textContent =
    `${plural(conf, "confirmed pay entry", "confirmed pay entries")}` +
    (refs ? `, ${plural(refs, "reference")}` : "") +
    `, ${plural(knownCompanies.length, "company", "companies")}.`;
}

async function countCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => ESTIMATE_KEY.test(k));
  const jobs = keys.filter((k) => /^v\d+:/.test(k)).length;
  const schools = keys.filter((k) => /^school\d*:/.test(k)).length;
  const facts = keys.filter((k) => /^(co|pay)\d*:/.test(k)).length;
  $("cacheStat").textContent = keys.length
    ? `${plural(jobs, "job")}, ${plural(schools, "school")}, ${plural(facts, "shared fact")}.`
    : "Nothing estimated yet.";
  return keys;
}

$("clear").onclick = async () => {
  const keys = await countCache();
  await chrome.storage.local.remove(keys);
  await countCache();
  flash($("dataStatus"), `Cleared ${plural(keys.length, "estimate")}. Confirmed data is untouched.`);
};

$("exportConfirmed").onclick = async () => {
  const { knownPay = [], knownCompanies = [] } = await chrome.storage.local.get(["knownPay", "knownCompanies"]);
  const blob = new Blob([JSON.stringify({ app: "pocket-watching", version: 1, knownPay, knownCompanies }, null, 2)], { type: "application/json" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: `pocket-watching-confirmed-${new Date().toISOString().slice(0, 10)}.json`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  flash($("dataStatus"), "Backup downloaded.");
};

$("importConfirmed").onchange = async () => {
  const file = $("importConfirmed").files[0];
  $("importConfirmed").value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.knownPay)) throw new Error();
    await upsertKnown(data.knownPay);
    if (Array.isArray(data.knownCompanies)) {
      const { knownCompanies = [] } = await chrome.storage.local.get("knownCompanies");
      for (const c of data.knownCompanies) {
        const i = knownCompanies.findIndex((k) => norm(k.company) === norm(c.company));
        if (i >= 0) knownCompanies[i] = c; else knownCompanies.push(c);
      }
      await chrome.storage.local.set({ knownCompanies });
    }
    countConfirmed();
    flash($("dataStatus"), `Restored ${plural(data.knownPay.length, "pay entry", "pay entries")}.`);
  } catch {
    flash($("dataStatus"), "That file isn't a Pocket Watching backup.", "err", 6000);
  }
};

chrome.storage.onChanged?.addListener((ch, area) => {
  if (area === "local" && (ch.knownPay || ch.knownCompanies)) countConfirmed();
});

renderKnown();
renderEstimates();
countCache();
countConfirmed();
