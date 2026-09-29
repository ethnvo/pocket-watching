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

// ---------- badges ----------
const BADGES = [
  ["pay", "Pay", "Hourly, monthly or yearly pay for each job"],
  ["housing", "Housing stipend", "Monthly or lump-sum housing for internships"],
  ["verified", "Confirmed check", "Blue check on pay you've confirmed in Known pay"],
  ["unverified", "Unverified flag", "When Gemini couldn't confirm a company or its pay"],
  ["category", "Company type", "FAANG, Quant, Startup, Fintech and so on"],
  ["tiers", "Compliments", "THANOS, S and A tier on standout jobs and schools"],
  ["larp", "LARP flag", "Full-time titles held while still in school"],
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

// ---------- data ----------
const CACHE_KEY = /^(v\d+|entry|cache|edu|co\d*|pay\d*|school\d*):/;
async function countCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => CACHE_KEY.test(k));
  const jobs = keys.filter((k) => /^v\d+:/.test(k)).length;
  const schools = keys.filter((k) => /^school\d*:/.test(k)).length;
  const companies = keys.filter((k) => /^co\d*:/.test(k)).length;
  $("cacheStat").textContent = keys.length
    ? `${jobs} job${jobs === 1 ? "" : "s"}, ${schools} school${schools === 1 ? "" : "s"} and ${companies} compan${companies === 1 ? "y" : "ies"} saved.`
    : "No saved lookups yet.";
  return keys;
}
$("clear").onclick = async () => {
  const keys = await countCache();
  await chrome.storage.local.remove(keys);
  await countCache();
  flash($("dataStatus"), `Cleared ${keys.length} saved lookup${keys.length === 1 ? "" : "s"}.`);
};

renderKnown();
countCache();
