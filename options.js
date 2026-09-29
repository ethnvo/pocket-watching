const $ = (id) => document.getElementById(id);
chrome.storage.sync.get(["apiKey", "model"], ({ apiKey, model }) => {
  $("apiKey").value = apiKey || "";
  $("model").value = model || "";
});
const flash = (t) => { $("status").textContent = t; setTimeout(() => ($("status").textContent = ""), 1500); };
$("save").onclick = async () => {
  await chrome.storage.sync.set({ apiKey: $("apiKey").value.trim(), model: $("model").value.trim() });
  flash("Saved");
};
$("clear").onclick = async () => {
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter((k) => /^(v\d+|entry|cache|edu|co\d*|pay):/.test(k)));
  flash("Cache cleared");
};

// ---------- Known pay ----------
async function renderKnown() {
  const { knownPay = [] } = await chrome.storage.local.get("knownPay");
  $("known").innerHTML = knownPay
    .map((k, i) => {
      const amt = k.hourly ? `$${k.hourly}/hr${k.intern ? " (intern)" : ""}` : `$${Number(k.annual).toLocaleString()}/yr`;
      return `<tr style="border-bottom:1px solid #eee"><td style="padding:6px 0"><b>${esc(k.company)}</b></td><td>${esc(k.role || "any role")}</td><td>${amt}</td><td style="text-align:right"><a href="#" data-i="${i}">remove</a></td></tr>`;
    })
    .join("");
  $("known").querySelectorAll("a[data-i]").forEach((a) => (a.onclick = async (ev) => {
    ev.preventDefault();
    knownPay.splice(+a.dataset.i, 1);
    await chrome.storage.local.set({ knownPay });
    renderKnown();
  }));
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
$("kpAdd").onclick = async () => {
  const company = $("kpCompany").value.trim();
  const amount = parseFloat($("kpAmount").value.replace(/[$,]/g, ""));
  if (!company || !amount) return flash("Need a company and pay");
  const unit = $("kpUnit").value;
  const entry = { company, role: $("kpRole").value.trim() || undefined };
  if (unit === "yr") Object.assign(entry, { annual: amount, intern: false });
  else Object.assign(entry, { hourly: amount, intern: unit === "hr" });
  const { knownPay = [] } = await chrome.storage.local.get("knownPay");
  knownPay.push(entry);
  await chrome.storage.local.set({ knownPay });
  ["kpCompany", "kpRole", "kpAmount"].forEach((id) => ($(id).value = ""));
  renderKnown();
  flash("Added");
};
renderKnown();
