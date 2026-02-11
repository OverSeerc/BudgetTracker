import {
  auth, db,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  doc, setDoc, getDoc, updateDoc, deleteDoc,
  collection, addDoc, getDocs,
  query, where, orderBy
} from "./firebase.js";

/* =========================
   Helpers
========================= */
const $ = (id) => document.getElementById(id);

function setText(idOrEl, value) {
  const el = (typeof idOrEl === "string") ? $(idOrEl) : idOrEl;
  if (!el) return false;
  el.textContent = String(value ?? "");
  return true;
}

const fmtRM = (n) => {
  const v = Number(n || 0);
  return "RM " + v.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const pad2 = (n) => String(n).padStart(2, "0");
const toYM = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
const sum = (arr) => arr.reduce((a, b) => a + (Number(b) || 0), 0);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[m]));
}

function addMonthsYM(ym, add) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1, 1);
  d.setMonth(d.getMonth() + add);
  return toYM(d);
}

function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function computeEffectiveMonth(dateISO, cutoffDay) {
  const d = new Date(dateISO + "T00:00:00");
  const day = d.getDate();
  const ym = toYM(d);
  return (day >= Number(cutoffDay)) ? addMonthsYM(ym, 1) : ym;
}

function normalizeKey(group, category, type) {
  return `${(group || "").trim().toLowerCase()}||${(category || "").trim().toLowerCase()}||${(type || "").trim().toLowerCase()}`;
}

function ymInRange(ym, startYM, endYM) {
  if (startYM && ym < startYM) return false;
  if (endYM && ym > endYM) return false;
  return true;
}

function dateFromYMDay(ym, day) {
  const [y, m] = ym.split("-").map(Number);
  const dd = clampInt(day, 1, 28, 1);
  return `${y}-${pad2(m)}-${pad2(dd)}`;
}

function recurringTxDocId(recurringId, dateISO) {
  return `rec_${recurringId}_${dateISO}`;
}
function billTxDocId(billId, dateISO) {
  return `bill_${billId}_${dateISO}`;
}
function debtPayTxDocId(debtId, ym) {
  return `debtpay_${debtId}_${ym}`;
}
function fundContribTxDocId(fundId, ym, dateISO) {
  return `fund_${fundId}_${ym}_${dateISO}`;
}
function monthsBetweenYM(a, b) {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return (by - ay) * 12 + (bm - am);
}

function makeIdSafe(s) {
  return String(s || "").replace(/[^a-z0-9_-]/gi, "_");
}

/* =========================
   Toast (no alerts)
========================= */
let toastEl = null;
function ensureToast() {
  if (toastEl) return toastEl;
  toastEl = document.createElement("div");
  toastEl.className = "toast";
  toastEl.id = "toast";
  document.body.appendChild(toastEl);
  return toastEl;
}
function showToast(msg = "Done ✅", ms = 1600) {
  const el = ensureToast();
  el.textContent = msg;
  el.classList.add("show");
  window.clearTimeout(showToast._t);
  showToast._t = window.setTimeout(() => el.classList.remove("show"), ms);
}

/* =========================
   Modal (vehicle checklist)
========================= */
let vehModalEl = null;
function ensureVehModal() {
  if (vehModalEl) return vehModalEl;

  const wrap = document.createElement("div");
  wrap.className = "modalOverlay hidden";
  wrap.id = "vehSugModal";
  wrap.innerHTML = `
    <div class="modalCard" role="dialog" aria-modal="true" aria-label="Vehicle checklist">
      <div class="modalHead">
        <div class="modalTitle" id="vehSugTitle">Maintenance checklist</div>
        <button class="modalClose" type="button" id="vehSugClose">Close</button>
      </div>
      <div class="modalBody">
        <div class="muted small" id="vehSugSub"></div>
        <div class="sugList" id="vehSugList"></div>
        <div class="muted small" style="margin-top:10px;">
          Tip: Ticking an item logs it instantly (no prompts) ✅
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);

  const close = () => wrap.classList.add("hidden");
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
  wrap.querySelector("#vehSugClose").addEventListener("click", close);
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  vehModalEl = wrap;
  return vehModalEl;
}

function pillClass(status) {
  if (status === "overdue") return "overdue";
  if (status === "soon") return "soon";
  return "ok";
}

/* =========================
   Loading Overlay
========================= */
const loadingOverlay = $("loadingOverlay");
const loadingTitle = $("loadingTitle");
const loadingSub = $("loadingSub");

let loadingCount = 0;

function showLoading(title = "Loading…", sub = "Please wait") {
  loadingCount += 1;
  if (!loadingOverlay) return;
  setText(loadingTitle, title);
  setText(loadingSub, sub);
  loadingOverlay.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function hideLoading() {
  loadingCount = Math.max(0, loadingCount - 1);
  if (loadingCount > 0) return;
  if (!loadingOverlay) return;
  loadingOverlay.classList.add("hidden");
  document.body.style.overflow = "";
}

async function withLoading(title, fn, sub = "Please wait") {
  showLoading(title, sub);
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    // keep error visible, but don’t use alerts
    showToast(e?.message || "Something went wrong ❌", 2400);
    throw e;
  } finally {
    hideLoading();
  }
}

/* =========================
   DOM
========================= */
const authCard = $("authCard");
const appCard = $("appCard");

const emailEl = $("email");
const passEl = $("password");
const btnLogin = $("btnLogin");
const btnRegister = $("btnRegister");
const btnSignOut = $("btnSignOut");
const authStatus = $("authStatus");
const userChip = $("userChip");

const monthPicker = $("monthPicker");
const cutoffDayEl = $("cutoffDay");

const btnSeedDemo = $("btnSeedDemo");
const btnAddPlanRow = $("btnAddPlanRow");
const btnSavePlan = $("btnSavePlan");
const planTableBody = $("planTable")?.querySelector("tbody") || null;
const planSavedHint = $("planSavedHint");

const btnAddTx = $("btnAddTx");
const txTableBody = $("txTable")?.querySelector("tbody") || null;

const kpiPlannedNet = $("kpiPlannedNet");
const kpiActualNet = $("kpiActualNet");
const kpiActualOutflows = $("kpiActualOutflows");
const kpiUnpaidBills = $("kpiUnpaidBills");
const kpiUnpaidBillsHint = $("kpiUnpaidBillsHint");

// Optional
const kpiActualIncome = $("kpiActualIncome");

const btnExportPdf = $("btnExportPdf");
const btnExportPdf2 = $("btnExportPdf2");

/* Monthly view */
const monthlyTableBody = $("monthlyTable")?.querySelector("tbody") || null;
const monthlyGroupFilter = $("monthlyGroupFilter");
const monthlySearch = $("monthlySearch");
const monthlyTotalsHint = $("monthlyTotalsHint");

/* Category manager */
const catGroup = $("catGroup");
const catName = $("catName");
const catType = $("catType");
const btnAddCategory = $("btnAddCategory");
const btnRefreshCategories = $("btnRefreshCategories");
const catStatus = $("catStatus");
const catsTableBody = $("catsTable")?.querySelector("tbody") || null;

/* Datalists */
const dlGroups = $("dlGroups");
const dlCategories = $("dlCategories");

/* Recurring */
const recType = $("recType");
const recGroup = $("recGroup");
const recCategory = $("recCategory");
const recAmount = $("recAmount");
const recDay = $("recDay");
const recStart = $("recStart");
const recEnd = $("recEnd");
const recActive = $("recActive");
const btnAddRecurring = $("btnAddRecurring");
const btnApplyRecurring = $("btnApplyRecurring");
const btnRefreshRecurring = $("btnRefreshRecurring");
const recStatus = $("recStatus");
const recTableBody = $("recTable")?.querySelector("tbody") || null;

/* Bills */
const billName = $("billName");
const billGroup = $("billGroup");
const billAmount = $("billAmount");
const billDueDay = $("billDueDay");
const btnAddBill = $("btnAddBill");
const btnApplyBills = $("btnApplyBills");
const btnRefreshBills = $("btnRefreshBills");
const billStatus = $("billStatus");
const billsTableBody = $("billsTable")?.querySelector("tbody") || null;

/* Debts */
const debtName = $("debtName");
const debtType = $("debtType");
const debtApr = $("debtApr");
const debtBalance = $("debtBalance");
const debtMonthlyPay = $("debtMonthlyPay");
const debtDueDay = $("debtDueDay");
const btnAddDebt = $("btnAddDebt");
const btnRefreshDebts = $("btnRefreshDebts");
const debtStatus = $("debtStatus");
const debtsTableBody = $("debtsTable")?.querySelector("tbody") || null;

/* Funds */
const fundName = $("fundName");
const fundGoal = $("fundGoal");
const fundTarget = $("fundTarget");
const fundSaved = $("fundSaved");
const btnAddFund = $("btnAddFund");
const btnRefreshFunds = $("btnRefreshFunds");
const fundStatus = $("fundStatus");
const fundsTableBody = $("fundsTable")?.querySelector("tbody") || null;

/* Overtime calculator */
const otBaseRate = $("otBaseRate");
const otDate = $("otDate");
const otHours15 = $("otHours15");
const otHours20 = $("otHours20");
const otHours30 = $("otHours30");
const otCategory = $("otCategory");
const otResultTotal = $("otResultTotal");
const btnAddOtIncome = $("btnAddOtIncome");

/* Savings suggestion */
const savePct = $("savePct");
const investPct = $("investPct");
const leftoverThisMonth = $("leftoverThisMonth");
const suggestedSavings = $("suggestedSavings");
const suggestedInvestment = $("suggestedInvestment");

/* Vehicles */
const vehName = $("vehName");
const vehPlate = $("vehPlate");
const vehMileage = $("vehMileage");
const vehIntervalKm = $("vehIntervalKm");
const vehIntervalMonths = $("vehIntervalMonths");
const btnAddVehicle = $("btnAddVehicle");
const btnRefreshVehicles = $("btnRefreshVehicles");
const vehStatus = $("vehStatus");
const vehiclesTableBody = $("vehiclesTable")?.querySelector("tbody") || null;

/* =========================
   Tabs
========================= */
function showTab(name) {
  document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".tabpane").forEach(p => p.classList.remove("active"));
  const tabBtn = document.querySelector(`.tab[data-tab="${name}"]`);
  if (tabBtn) tabBtn.classList.add("active");
  const pane = $("tab-" + name);
  if (pane) pane.classList.add("active");
}
document.querySelectorAll(".tab").forEach(btn => {
  btn.addEventListener("click", () => showTab(btn.dataset.tab));
});

/* =========================
   State
========================= */
let currentUser = null;
let currentMonthYM = toYM(new Date());
let settings = { cutoffDay: 27 };
let categories = [];
let recurring = [];
let bills = [];
let debts = [];
let funds = [];
let vehicles = [];
let maintenanceLogs = [];

// ✅ required state
let currentPlan = [];
let currentTransactions = [];
let charts = { bar: null, pie: null, line: null };

// Vehicle maintenance state
let maintenanceItems = [];
let vehicleMaintenance = [];
let suggestionsByVehicleId = new Map();

/* =========================
   Firestore paths
========================= */
function userRoot(uid) {
  return {
    settingsDoc: doc(db, "users", uid, "settings", "main"),
    planDoc: (ym) => doc(db, "users", uid, "plans", ym),

    txCol: collection(db, "users", uid, "transactions"),
    catsCol: collection(db, "users", uid, "categories"),
    recCol: collection(db, "users", uid, "recurring"),
    billsCol: collection(db, "users", uid, "bills"),
    billStatusCol: collection(db, "users", uid, "billStatus"),
    debtsCol: collection(db, "users", uid, "debts"),
    fundsCol: collection(db, "users", uid, "funds"),
    vehiclesCol: collection(db, "users", uid, "vehicles"),
    maintCol: collection(db, "users", uid, "maintenanceLogs"),

    // NEW
    maintItemsCol: collection(db, "users", uid, "maintenanceItems"),
    vehicleMaintCol: collection(db, "users", uid, "vehicleMaintenance"),
  };
}

/* =========================
   Auth
========================= */
btnLogin?.addEventListener("click", async () => {
  await withLoading("Signing in…", async () => {
    await signInWithEmailAndPassword(auth, emailEl.value.trim(), passEl.value);
  }, "Checking your account…");
});

btnRegister?.addEventListener("click", async () => {
  await withLoading("Creating account…", async () => {
    await createUserWithEmailAndPassword(auth, emailEl.value.trim(), passEl.value);
  }, "Setting up your account…");
});

btnSignOut?.addEventListener("click", async () => {
  await withLoading("Signing out…", async () => {
    await signOut(auth);
  }, "See you again soon");
});

onAuthStateChanged(auth, async (user) => {
  currentUser = user || null;

  if (!currentUser) {
    authCard?.classList.remove("hidden");
    appCard?.classList.add("hidden");
    btnSignOut?.classList.add("hidden");
    userChip?.classList.add("hidden");
    setText(authStatus, "Not signed in");
    return;
  }

  authCard?.classList.add("hidden");
  appCard?.classList.remove("hidden");
  btnSignOut?.classList.remove("hidden");
  userChip?.classList.remove("hidden");
  setText(userChip, currentUser.email || "Signed in");
  setText(authStatus, "Signed in");

  monthPicker && (monthPicker.value = currentMonthYM);

  await withLoading("Loading your dashboard…", async () => {
    await loadSettings();
    cutoffDayEl && (cutoffDayEl.value = settings.cutoffDay);

    await loadAllMasterData();
    await applyAutoStuffForMonth(currentMonthYM);
    await loadMonthData();
    await loadTrendDataAndRender();
  }, "Getting your data…");
});

/* =========================
   Settings
========================= */
async function loadSettings() {
  const { settingsDoc } = userRoot(currentUser.uid);
  const snap = await getDoc(settingsDoc);
  if (!snap.exists()) {
    settings = { cutoffDay: 25 };
    await setDoc(settingsDoc, settings, { merge: true });
  } else {
    settings = { cutoffDay: 25, ...snap.data() };
    settings.cutoffDay = clampInt(settings.cutoffDay, 1, 28, 25);
  }
}
async function saveSettings() {
  const { settingsDoc } = userRoot(currentUser.uid);
  await setDoc(settingsDoc, settings, { merge: true });
}

cutoffDayEl?.addEventListener("change", async () => {
  await withLoading("Updating cutoff day…", async () => {
    settings.cutoffDay = clampInt(cutoffDayEl.value, 1, 28, 25);
    cutoffDayEl.value = settings.cutoffDay;
    await saveSettings();

    await recomputeAllTxEffectiveMonths();
    await applyAutoStuffForMonth(currentMonthYM);

    await loadMonthData();
    await loadTrendDataAndRender();
  }, "Recalculating months…");
});

/* =========================
   Month picker
========================= */
monthPicker?.addEventListener("change", async () => {
  await withLoading("Switching month…", async () => {
    currentMonthYM = monthPicker.value || toYM(new Date());
    await applyAutoStuffForMonth(currentMonthYM);
    await loadMonthData();
  }, "Loading month data…");
});

/* =========================
   Load all master data
========================= */
async function loadAllMasterData() {
  await Promise.all([
    loadCategories(),
    loadRecurring(),
    loadBills(),
    loadDebts(),
    loadFunds(),
    loadVehicles(),
    loadMaintenanceLogs()
  ]);
  buildCategoryDatalists();
}

/* =========================
   Categories
========================= */
btnAddCategory?.addEventListener("click", async () => {
  await withLoading("Saving category…", async () => {
    const g = (catGroup?.value || "").trim();
    const n = (catName?.value || "").trim();
    const t = (catType?.value === "income") ? "income" : "expense";
    if (!g || !n) { setText(catStatus, "Please fill Group and Category."); return; }

    const exists = categories.some(c => c.group.toLowerCase() === g.toLowerCase() && c.name.toLowerCase() === n.toLowerCase() && c.type === t);
    if (exists) { setText(catStatus, "Already exists."); return; }

    const { catsCol } = userRoot(currentUser.uid);
    await addDoc(catsCol, { group: g, name: n, type: t, createdAt: Date.now() });

    if (catGroup) catGroup.value = "";
    if (catName) catName.value = "";
    if (catType) catType.value = "expense";
    setText(catStatus, "Saved.");
    showToast("Saved ✅");

    await loadCategories();
    await loadMonthData();
  });
});

btnRefreshCategories?.addEventListener("click", async () => {
  await withLoading("Refreshing categories…", async () => {
    await loadCategories();
    setText(catStatus, "Refreshed.");
    showToast("Refreshed ✅");
  });
});

async function loadCategories() {
  const { catsCol } = userRoot(currentUser.uid);
  const snap = await getDocs(catsCol);
  const list = [];
  snap.forEach(d => {
    const x = d.data() || {};
    list.push({
      id: d.id,
      group: String(x.group || "").trim(),
      name: String(x.name || "").trim(),
      type: (x.type === "income" ? "income" : "expense")
    });
  });
  list.sort((a, b) => (a.group.localeCompare(b.group)) || (a.type.localeCompare(b.type)) || (a.name.localeCompare(b.name)));
  categories = list;
  renderCategoriesTable();
}

function renderCategoriesTable() {
  if (!catsTableBody) return;
  catsTableBody.innerHTML = "";
  for (const c of categories) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(c.group)}</td>
      <td>${escapeHtml(c.name)}</td>
      <td><span class="badge">${c.type === "income" ? "income" : "spending"}</span></td>
      <td><button class="iconBtn danger" type="button">✕</button></td>
    `;
    tr.querySelector("button").addEventListener("click", async () => {
      await withLoading("Deleting category…", async () => {
        if (!confirm(`Delete "${c.group} / ${c.name}"?`)) return;
        await deleteDoc(doc(db, "users", currentUser.uid, "categories", c.id));
        await loadCategories();
        await loadMonthData();
        showToast("Deleted ✅");
      });
    });
    catsTableBody.appendChild(tr);
  }
}

function buildCategoryDatalists() {
  if (!dlGroups || !dlCategories) return;
  const groups = [...new Set(categories.map(c => c.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  dlGroups.innerHTML = groups.map(g => `<option value="${escapeHtml(g)}"></option>`).join("");

  const names = [...new Set(categories.map(c => c.name).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  dlCategories.innerHTML = names.map(n => `<option value="${escapeHtml(n)}"></option>`).join("");
}

/* =========================
   Recurring
========================= */
btnAddRecurring?.addEventListener("click", async () => {
  await withLoading("Saving recurring…", async () => {
    const type = (recType?.value === "income") ? "income" : "expense";
    const group = (recGroup?.value || "").trim();
    const category = (recCategory?.value || "").trim();
    const amount = Number(recAmount?.value || 0);
    const dayOfMonth = clampInt(recDay?.value, 1, 28, 1);
    const startMonth = (recStart?.value || "").trim();
    const endMonth = (recEnd?.value || "").trim();
    const active = (recActive?.value === "true");

    if (!group || !category) { setText(recStatus, "Please fill Group and Category."); return; }
    if (!startMonth) { setText(recStatus, "Please pick a start month."); return; }

    const { recCol } = userRoot(currentUser.uid);
    await addDoc(recCol, {
      type, group, category, amount,
      dayOfMonth,
      startMonth,
      endMonth: endMonth || null,
      active,
      createdAt: Date.now()
    });

    setText(recStatus, "Saved.");
    showToast("Saved ✅");
    if (recAmount) recAmount.value = "";
    if (recDay) recDay.value = "";
    if (recEnd) recEnd.value = "";

    await loadRecurring();
    await applyAutoStuffForMonth(currentMonthYM);
    await loadMonthData();
  }, "Updating month…");
});

btnRefreshRecurring?.addEventListener("click", async () => {
  await withLoading("Refreshing recurring…", async () => {
    await loadRecurring();
    setText(recStatus, "Refreshed.");
    showToast("Refreshed ✅");
  });
});

btnApplyRecurring?.addEventListener("click", async () => {
  await withLoading("Applying recurring…", async () => {
    await ensureRecurringForMonth(currentMonthYM);
    await loadMonthData();
    setText(recStatus, "Applied to this month.");
    showToast("Applied ✅");
  }, "Creating missing items…");
});

async function loadRecurring() {
  const { recCol } = userRoot(currentUser.uid);
  const snap = await getDocs(recCol);
  const list = [];
  snap.forEach(d => {
    const x = d.data() || {};
    list.push({
      id: d.id,
      type: (x.type === "income" ? "income" : "expense"),
      group: String(x.group || "").trim(),
      category: String(x.category || "").trim(),
      amount: Number(x.amount || 0),
      dayOfMonth: clampInt(x.dayOfMonth, 1, 28, 1),
      startMonth: String(x.startMonth || "").trim(),
      endMonth: x.endMonth ? String(x.endMonth).trim() : null,
      active: (x.active !== false)
    });
  });
  list.sort((a, b) => ((b.active ? 1 : 0) - (a.active ? 1 : 0)) || a.group.localeCompare(b.group) || a.category.localeCompare(b.category));
  recurring = list;
  renderRecurringTable();
}

function renderRecurringTable() {
  if (!recTableBody) return;
  recTableBody.innerHTML = "";
  for (const r of recurring) {
    const tr = document.createElement("tr");
    const range = `${r.startMonth}${r.endMonth ? " → " + r.endMonth : ""}`;
    tr.innerHTML = `
      <td>
        <select class="r-active">
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      </td>
      <td><span class="badge">${r.type === "income" ? "income" : "spending"}</span></td>
      <td>${escapeHtml(r.group)}</td>
      <td>${escapeHtml(r.category)}</td>
      <td class="money">${escapeHtml(fmtRM(r.amount))}</td>
      <td>${escapeHtml(String(r.dayOfMonth))}</td>
      <td>${escapeHtml(range)}</td>
      <td><button class="iconBtn danger" type="button">✕</button></td>
    `;
    const sel = tr.querySelector(".r-active");
    sel.value = r.active ? "true" : "false";
    sel.addEventListener("change", async () => {
      await withLoading("Updating recurring…", async () => {
        await updateDoc(doc(db, "users", currentUser.uid, "recurring", r.id), { active: (sel.value === "true"), updatedAt: Date.now() });
        await loadRecurring();
        await applyAutoStuffForMonth(currentMonthYM);
        await loadMonthData();
        showToast("Updated ✅");
      });
    });
    tr.querySelector("button").addEventListener("click", async () => {
      await withLoading("Deleting recurring…", async () => {
        if (!confirm(`Delete recurring "${r.group} / ${r.category}"?`)) return;
        await deleteDoc(doc(db, "users", currentUser.uid, "recurring", r.id));
        await loadRecurring();
        await loadMonthData();
        showToast("Deleted ✅");
      });
    });
    recTableBody.appendChild(tr);
  }
}

async function ensureRecurringForMonth(ym) {
  const uid = currentUser.uid;
  const writes = [];
  for (const r of recurring) {
    if (!r.active) continue;
    if (!r.startMonth) continue;
    if (!ymInRange(ym, r.startMonth, r.endMonth)) continue;

    const dateISO = dateFromYMDay(ym, r.dayOfMonth);
    const eff = computeEffectiveMonth(dateISO, settings.cutoffDay);
    const txId = recurringTxDocId(r.id, dateISO);

    const txDoc = doc(db, "users", uid, "transactions", txId);
    const data = {
      date: dateISO,
      type: r.type,
      group: r.group,
      category: r.category,
      amount: Number(r.amount || 0),
      effectiveMonth: eff,
      isRecurring: true,
      recurringId: r.id,
      sourceMonth: ym,
      updatedAt: Date.now()
    };
    writes.push(setDoc(txDoc, data, { merge: true }));
  }
  if (writes.length) await Promise.all(writes);
}

/* =========================
   Bills
========================= */
btnAddBill?.addEventListener("click", async () => {
  await withLoading("Saving bill…", async () => {
    const name = (billName?.value || "").trim();
    const group = (billGroup?.value || "").trim() || "Needs";
    const amount = Number(billAmount?.value || 0);
    const dueDay = clampInt(billDueDay?.value, 1, 28, 1);

    if (!name) { setText(billStatus, "Please enter bill name."); return; }
    if (!amount || amount <= 0) { setText(billStatus, "Please enter amount."); return; }

    const { billsCol } = userRoot(currentUser.uid);
    await addDoc(billsCol, { name, group, amount, dueDay, active: true, createdAt: Date.now() });

    if (billName) billName.value = "";
    if (billAmount) billAmount.value = "";
    if (billDueDay) billDueDay.value = "";
    setText(billStatus, "Saved.");
    showToast("Saved ✅");

    await loadBills();
    await applyAutoStuffForMonth(currentMonthYM);
    await loadMonthData();
  });
});

btnRefreshBills?.addEventListener("click", async () => {
  await withLoading("Refreshing bills…", async () => {
    await loadBills();
    setText(billStatus, "Refreshed.");
    showToast("Refreshed ✅");
  });
});

btnApplyBills?.addEventListener("click", async () => {
  await withLoading("Applying bills…", async () => {
    await ensureBillsForMonth(currentMonthYM);
    await loadMonthData();
    setText(billStatus, "Applied to this month.");
    showToast("Applied ✅");
  }, "Creating missing bill items…");
});

async function loadBills() {
  const { billsCol } = userRoot(currentUser.uid);
  const snap = await getDocs(billsCol);
  const list = [];
  snap.forEach(d => {
    const x = d.data() || {};
    list.push({
      id: d.id,
      name: String(x.name || "").trim(),
      group: String(x.group || "Needs").trim(),
      amount: Number(x.amount || 0),
      dueDay: clampInt(x.dueDay, 1, 28, 1),
      active: (x.active !== false)
    });
  });
  list.sort((a, b) => ((b.active ? 1 : 0) - (a.active ? 1 : 0)) || a.dueDay - b.dueDay || a.name.localeCompare(b.name));
  bills = list;
  await renderBillsTable();
}

async function getBillPaidStatusForMonth(ym) {
  const { billStatusCol } = userRoot(currentUser.uid);
  const snap = await getDocs(query(billStatusCol, where("month", "==", ym)));
  const map = new Map();
  snap.forEach(d => {
    const x = d.data() || {};
    map.set(String(x.billId), { id: d.id, paid: !!x.paid, paidDate: x.paidDate || null });
  });
  return map;
}

async function renderBillsTable() {
  if (!billsTableBody) return;
  billsTableBody.innerHTML = "";
  const paidMap = await getBillPaidStatusForMonth(currentMonthYM);

  for (const b of bills) {
    const status = paidMap.get(b.id);
    const paid = status ? !!status.paid : false;
    const paidDate = status?.paidDate ? String(status.paidDate).slice(0, 10) : "-";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <select class="b-paid">
          <option value="false">No</option>
          <option value="true">Yes</option>
        </select>
      </td>
      <td class="muted">${escapeHtml(paid ? paidDate : "-")}</td>
      <td>${escapeHtml(b.name)}</td>
      <td class="money">${escapeHtml(fmtRM(b.amount))}</td>
      <td>${escapeHtml(String(b.dueDay))}</td>
      <td><button class="iconBtn danger" type="button">✕</button></td>
    `;

    const sel = tr.querySelector(".b-paid");
    sel.value = paid ? "true" : "false";

    sel.addEventListener("change", async () => {
      await withLoading("Updating bill status…", async () => {
        const val = sel.value === "true";
        const stId = `bill_${b.id}_${currentMonthYM}`;
        const stDoc = doc(db, "users", currentUser.uid, "billStatus", stId);
        await setDoc(stDoc, {
          billId: b.id,
          month: currentMonthYM,
          paid: val,
          paidDate: val ? new Date().toISOString() : null,
          updatedAt: Date.now()
        }, { merge: true });

        await loadBills();
        await loadMonthData();
        showToast("Updated ✅");
      });
    });

    tr.querySelector("button").addEventListener("click", async () => {
      await withLoading("Deleting bill…", async () => {
        if (!confirm(`Delete bill "${b.name}"?`)) return;
        await deleteDoc(doc(db, "users", currentUser.uid, "bills", b.id));
        await loadBills();
        await loadMonthData();
        showToast("Deleted ✅");
      });
    });

    billsTableBody.appendChild(tr);
  }
}

async function ensureBillsForMonth(ym) {
  const uid = currentUser.uid;
  const writes = [];
  for (const b of bills) {
    if (!b.active) continue;
    const dateISO = dateFromYMDay(ym, b.dueDay);
    const eff = computeEffectiveMonth(dateISO, settings.cutoffDay);
    const txId = billTxDocId(b.id, dateISO);

    const txDoc = doc(db, "users", uid, "transactions", txId);
    const data = {
      date: dateISO,
      type: "expense",
      group: b.group || "Needs",
      category: b.name,
      amount: Number(b.amount || 0),
      effectiveMonth: eff,
      isBill: true,
      billId: b.id,
      sourceMonth: ym,
      updatedAt: Date.now()
    };
    writes.push(setDoc(txDoc, data, { merge: true }));
  }
  if (writes.length) await Promise.all(writes);
}

/* =========================
   Debts & Loans
========================= */
btnAddDebt?.addEventListener("click", async () => {
  await withLoading("Saving debt…", async () => {
    const name = (debtName?.value || "").trim();
    const type = debtType?.value || "home_loan";
    const apr = Number(debtApr?.value || 0);
    const balance = Number(debtBalance?.value || 0);
    const monthly = Number(debtMonthlyPay?.value || 0);
    const dueDay = clampInt(debtDueDay?.value, 1, 28, 1);

    if (!name) { setText(debtStatus, "Please enter debt name."); return; }
    if (!balance || balance <= 0) { setText(debtStatus, "Please enter current balance."); return; }
    if (!monthly || monthly <= 0) { setText(debtStatus, "Please enter monthly payment."); return; }

    const { debtsCol } = userRoot(currentUser.uid);
    await addDoc(debtsCol, {
      name, type, apr,
      currentBalance: balance,
      monthlyPayment: monthly,
      dueDay,
      active: true,
      createdAt: Date.now()
    });

    if (debtName) debtName.value = "";
    if (debtApr) debtApr.value = "";
    if (debtBalance) debtBalance.value = "";
    if (debtMonthlyPay) debtMonthlyPay.value = "";
    if (debtDueDay) debtDueDay.value = "";
    setText(debtStatus, "Saved.");
    showToast("Saved ✅");

    await loadDebts();
    await loadMonthData();
  });
});

btnRefreshDebts?.addEventListener("click", async () => {
  await withLoading("Refreshing debts…", async () => {
    await loadDebts();
    setText(debtStatus, "Refreshed.");
    showToast("Refreshed ✅");
  });
});

async function loadDebts() {
  const { debtsCol } = userRoot(currentUser.uid);
  const snap = await getDocs(debtsCol);
  const list = [];
  snap.forEach(d => {
    const x = d.data() || {};
    list.push({
      id: d.id,
      name: String(x.name || "").trim(),
      type: String(x.type || "home_loan"),
      apr: Number(x.apr || 0),
      currentBalance: Number(x.currentBalance || 0),
      monthlyPayment: Number(x.monthlyPayment || 0),
      dueDay: clampInt(x.dueDay, 1, 28, 1),
      active: (x.active !== false),
      lastPaidMonth: x.lastPaidMonth || null
    });
  });
  list.sort((a, b) => a.name.localeCompare(b.name));
  debts = list;
  renderDebtsTable();
}

function renderDebtsTable() {
  if (!debtsTableBody) return;
  debtsTableBody.innerHTML = "";
  for (const d of debts) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(d.name)}</td>
      <td class="money">${escapeHtml(fmtRM(d.currentBalance))}</td>
      <td class="money">${escapeHtml(fmtRM(d.monthlyPayment))}</td>
      <td><button class="iconBtn pay" type="button">Pay this month</button></td>
      <td><button class="iconBtn danger del" type="button">✕</button></td>
    `;

    tr.querySelector(".pay").addEventListener("click", async () => {
      await withLoading("Recording payment…", async () => {
        await recordDebtPaymentForMonth(d.id, currentMonthYM);
        await loadDebts();
        await applyAutoStuffForMonth(currentMonthYM);
        await loadMonthData();
        await loadTrendDataAndRender();
        showToast("Logged ✅");
      }, "Updating balance…");
    });

    tr.querySelector(".del").addEventListener("click", async () => {
      await withLoading("Deleting debt…", async () => {
        if (!confirm(`Delete debt "${d.name}"?`)) return;
        await deleteDoc(doc(db, "users", currentUser.uid, "debts", d.id));
        await loadDebts();
        await loadMonthData();
        showToast("Deleted ✅");
      });
    });

    debtsTableBody.appendChild(tr);
  }
}

async function recordDebtPaymentForMonth(debtId, ym) {
  const debt = debts.find(x => x.id === debtId);
  if (!debt) return;

  const uid = currentUser.uid;
  const txId = debtPayTxDocId(debtId, ym);
  const txDoc = doc(db, "users", uid, "transactions", txId);
  const existing = await getDoc(txDoc);
  if (existing.exists()) {
    showToast("Already recorded ✅");
    return;
  }

  const dateISO = dateFromYMDay(ym, debt.dueDay);
  const eff = computeEffectiveMonth(dateISO, settings.cutoffDay);

  const monthlyRate = (Number(debt.apr || 0) / 100) / 12;
  const interest = debt.currentBalance * monthlyRate;
  const payment = Number(debt.monthlyPayment || 0);
  const principal = Math.max(0, payment - interest);
  const newBalance = Math.max(0, debt.currentBalance - principal);

  await setDoc(txDoc, {
    date: dateISO,
    type: "expense",
    group: "Debt",
    category: debt.name,
    amount: payment,
    effectiveMonth: eff,
    isDebtPayment: true,
    debtId,
    month: ym,
    interest: Number(interest.toFixed(2)),
    principal: Number(principal.toFixed(2)),
    balanceAfter: Number(newBalance.toFixed(2)),
    updatedAt: Date.now()
  }, { merge: true });

  await updateDoc(doc(db, "users", uid, "debts", debtId), {
    currentBalance: Number(newBalance.toFixed(2)),
    lastPaidMonth: ym,
    updatedAt: Date.now()
  });
}

/* =========================
   Funds (sinking funds)
========================= */
btnAddFund?.addEventListener("click", async () => {
  await withLoading("Saving fund…", async () => {
    const name = (fundName?.value || "").trim();
    const goal = Number(fundGoal?.value || 0);
    const target = (fundTarget?.value || "").trim();
    const saved = Number(fundSaved?.value || 0);

    if (!name) { setText(fundStatus, "Please enter fund name."); return; }
    if (!goal || goal <= 0) { setText(fundStatus, "Please enter goal."); return; }
    if (!target) { setText(fundStatus, "Please choose target month."); return; }

    const { fundsCol } = userRoot(currentUser.uid);
    await addDoc(fundsCol, { name, goalAmount: goal, targetMonth: target, currentSaved: saved, active: true, createdAt: Date.now() });

    if (fundName) fundName.value = "";
    if (fundGoal) fundGoal.value = "";
    if (fundTarget) fundTarget.value = "";
    if (fundSaved) fundSaved.value = "";
    setText(fundStatus, "Saved.");
    showToast("Saved ✅");

    await loadFunds();
    await loadMonthData();
  });
});

btnRefreshFunds?.addEventListener("click", async () => {
  await withLoading("Refreshing funds…", async () => {
    await loadFunds();
    setText(fundStatus, "Refreshed.");
    showToast("Refreshed ✅");
  });
});

async function loadFunds() {
  const { fundsCol } = userRoot(currentUser.uid);
  const snap = await getDocs(fundsCol);
  const list = [];
  snap.forEach(d => {
    const x = d.data() || {};
    list.push({
      id: d.id,
      name: String(x.name || "").trim(),
      goalAmount: Number(x.goalAmount || 0),
      targetMonth: String(x.targetMonth || "").trim(),
      currentSaved: Number(x.currentSaved || 0),
      active: (x.active !== false)
    });
  });
  list.sort((a, b) => a.name.localeCompare(b.name));
  funds = list;
  renderFundsTable();
}

function calcMonthlyNeeded(f) {
  const nowYM = currentMonthYM;
  const remaining = Math.max(0, (Number(f.goalAmount || 0) - Number(f.currentSaved || 0)));
  const diff = monthsBetweenYM(nowYM, f.targetMonth);
  const monthsLeft = Math.max(1, diff + 1);
  return remaining / monthsLeft;
}

function renderFundsTable() {
  if (!fundsTableBody) return;
  fundsTableBody.innerHTML = "";
  for (const f of funds) {
    const need = calcMonthlyNeeded(f);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(f.name)}</td>
      <td class="money">${escapeHtml(fmtRM(f.currentSaved))}</td>
      <td class="money">${escapeHtml(fmtRM(f.goalAmount))}</td>
      <td class="money">${escapeHtml(fmtRM(need))}</td>
      <td>
        <button class="iconBtn add" type="button">Add saving</button>
        <button class="iconBtn danger del" type="button">✕</button>
      </td>
    `;

    tr.querySelector(".add").addEventListener("click", async () => {
      const val = prompt(`Add saving amount for "${f.name}" (RM)`, String(need.toFixed(2)));
      if (val === null) return;
      const amt = Number(val);
      if (!amt || amt <= 0) { showToast("Enter valid amount ❌"); return; }

      await withLoading("Adding saving…", async () => {
        await addFundContribution(f.id, amt, currentMonthYM);
        await loadFunds();
        await loadMonthData();
        await loadTrendDataAndRender();
        showToast("Logged ✅");
      });
    });

    tr.querySelector(".del").addEventListener("click", async () => {
      await withLoading("Deleting fund…", async () => {
        if (!confirm(`Delete fund "${f.name}"?`)) return;
        await deleteDoc(doc(db, "users", currentUser.uid, "funds", f.id));
        await loadFunds();
        await loadMonthData();
        showToast("Deleted ✅");
      });
    });

    fundsTableBody.appendChild(tr);
  }
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function addDaysToISO(dateISO, days) {
  const d = new Date(dateISO + "T00:00:00");
  d.setDate(d.getDate() + Number(days || 0));
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function addMonthsToISO(dateISO, months) {
  const d = new Date(dateISO + "T00:00:00");
  d.setMonth(d.getMonth() + Number(months || 0));
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

async function addFundContribution(fundId, amount, ym) {
  const fund = funds.find(x => x.id === fundId);
  if (!fund) return;

  const uid = currentUser.uid;
  const dateISO = todayISO();
  const eff = computeEffectiveMonth(dateISO, settings.cutoffDay);

  const txId = fundContribTxDocId(fundId, ym, dateISO);
  await setDoc(doc(db, "users", uid, "transactions", txId), {
    date: dateISO,
    type: "expense",
    group: "Savings",
    category: fund.name,
    amount: Number(amount),
    effectiveMonth: eff,
    isFundContribution: true,
    fundId,
    month: ym,
    updatedAt: Date.now()
  }, { merge: true });

  const newSaved = Number(fund.currentSaved || 0) + Number(amount);
  await updateDoc(doc(db, "users", uid, "funds", fundId), {
    currentSaved: Number(newSaved.toFixed(2)),
    updatedAt: Date.now()
  });
}

/* =========================
   Vehicle Maintenance Templates
========================= */
const DEFAULT_MAINT_ITEMS = [
  { code: "engine_oil",    name: "Engine oil",                intervalKm: 10000, intervalMonths: 6,  kind: "maintenance" },
  { code: "oil_filter",    name: "Oil filter",                intervalKm: 10000, intervalMonths: 6,  kind: "maintenance" },
  { code: "air_filter",    name: "Engine air filter",         intervalKm: 20000, intervalMonths: 12, kind: "maintenance" },
  { code: "cabin_filter",  name: "Cabin filter",              intervalKm: 20000, intervalMonths: 12, kind: "maintenance" },
  { code: "brake_fluid",   name: "Brake fluid",               intervalKm: 0,     intervalMonths: 24, kind: "maintenance" },
  { code: "coolant",       name: "Coolant",                   intervalKm: 0,     intervalMonths: 36, kind: "maintenance" },
  { code: "spark_plugs",   name: "Spark plugs",               intervalKm: 80000, intervalMonths: 0,  kind: "maintenance" },
  { code: "tyre_rotation", name: "Tyres rotation",            intervalKm: 10000, intervalMonths: 0,  kind: "maintenance" },
  { code: "alignment",     name: "Alignment / balancing",     intervalKm: 10000, intervalMonths: 0,  kind: "maintenance" },
  { code: "tyres_replace", name: "Tyres replacement (check)", intervalKm: 45000, intervalMonths: 0,  kind: "maintenance" },
];

async function ensureMaintenanceItemsSeeded() {
  const uid = currentUser.uid;
  const { maintItemsCol } = userRoot(uid);
  const snap = await getDocs(maintItemsCol);
  if (!snap.empty) return;

  for (const it of DEFAULT_MAINT_ITEMS) {
    await addDoc(maintItemsCol, {
      code: it.code,
      name: it.name,
      defaultIntervalKm: Number(it.intervalKm || 0),
      defaultIntervalMonths: Number(it.intervalMonths || 0),
      kind: it.kind || "maintenance",
      active: true,
      createdAt: Date.now()
    });
  }
}

async function loadMaintenanceItems() {
  const uid = currentUser.uid;
  const { maintItemsCol } = userRoot(uid);

  const snap = await getDocs(maintItemsCol);
  const list = [];
  snap.forEach(d => {
    const x = d.data() || {};
    list.push({
      id: d.id,
      code: String(x.code || "").trim(),
      name: String(x.name || "").trim(),
      defaultIntervalKm: Number(x.defaultIntervalKm || 0),
      defaultIntervalMonths: Number(x.defaultIntervalMonths || 0),
      active: (x.active !== false)
    });
  });

  list.sort((a, b) => a.name.localeCompare(b.name));
  maintenanceItems = list;
}

async function ensureVehicleMaintenanceDefaults(vehicle) {
  const uid = currentUser.uid;
  const { vehicleMaintCol } = userRoot(uid);

  const qy = query(vehicleMaintCol, where("vehicleId", "==", vehicle.id));
  const snap = await getDocs(qy);

  const existingCodes = new Set();
  snap.forEach(d => {
    const x = d.data() || {};
    existingCodes.add(String(x.itemCode || ""));
  });

  const baseDate = todayISO();
  const baseMileage = Number(vehicle.currentMileage || 0);

  for (const item of maintenanceItems) {
    if (!item.active) continue;
    if (existingCodes.has(item.code)) continue;

    await addDoc(vehicleMaintCol, {
      vehicleId: vehicle.id,
      itemCode: item.code,
      intervalKm: Number(item.defaultIntervalKm || 0),
      intervalMonths: Number(item.defaultIntervalMonths || 0),
      lastDoneMileage: baseMileage,
      lastDoneDate: baseDate,
      active: true,
      createdAt: Date.now()
    });
  }
}

async function loadVehicleMaintenance() {
  const uid = currentUser.uid;
  const { vehicleMaintCol } = userRoot(uid);

  const snap = await getDocs(vehicleMaintCol);
  const list = [];
  snap.forEach(d => {
    const x = d.data() || {};
    list.push({
      id: d.id,
      vehicleId: String(x.vehicleId || ""),
      itemCode: String(x.itemCode || ""),
      intervalKm: Number(x.intervalKm || 0),
      intervalMonths: Number(x.intervalMonths || 0),
      lastDoneMileage: Number(x.lastDoneMileage || 0),
      lastDoneDate: String(x.lastDoneDate || ""),
      active: (x.active !== false)
    });
  });

  vehicleMaintenance = list;
}

function getItemByCode(code) {
  return maintenanceItems.find(x => x.code === code) || null;
}

function computeSuggestion(vehicle, cfg) {
  const item = getItemByCode(cfg.itemCode);
  const name = item?.name || cfg.itemCode;

  const nowMileage = Number(vehicle.currentMileage || 0);
  const lastMileage = Number(cfg.lastDoneMileage || 0);
  const lastDate = cfg.lastDoneDate || "";

  const nextDueMileage = (cfg.intervalKm > 0) ? (lastMileage + Number(cfg.intervalKm)) : null;
  const nextDueDate = (cfg.intervalMonths > 0 && lastDate) ? addMonthsToISO(lastDate, Number(cfg.intervalMonths)) : null;

  const KM_SOON = 500;
  const DAYS_SOON = 14;
  const today = todayISO();

  let overdue = false;
  let dueSoon = false;

  if (nextDueMileage != null && nowMileage >= nextDueMileage) overdue = true;
  if (nextDueDate && today >= nextDueDate) overdue = true;

  if (!overdue) {
    if (nextDueMileage != null && (nextDueMileage - nowMileage) <= KM_SOON) dueSoon = true;
    if (nextDueDate) {
      const soonDate = addDaysToISO(today, DAYS_SOON);
      if (nextDueDate <= soonDate) dueSoon = true;
    }
  }

  const status = overdue ? "overdue" : (dueSoon ? "soon" : "ok");

  return {
    vehicleId: vehicle.id,
    itemCode: cfg.itemCode,
    name,
    status,
    nowMileage,
    nextDueMileage,
    nextDueDate,
    intervalKm: cfg.intervalKm,
    intervalMonths: cfg.intervalMonths
  };
}

function computeSuggestionsForVehicle(vehicle) {
  const cfgs = vehicleMaintenance.filter(x => x.vehicleId === vehicle.id && x.active);
  const sug = cfgs.map(cfg => computeSuggestion(vehicle, cfg));

  const rank = (s) => (s.status === "overdue" ? 0 : (s.status === "soon" ? 1 : 2));
  sug.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return sug;
}

function recomputeAllVehicleSuggestions() {
  suggestionsByVehicleId = new Map();
  for (const v of vehicles) {
    suggestionsByVehicleId.set(v.id, computeSuggestionsForVehicle(v));
  }
}

function suggestionBadgeText(status) {
  if (status === "overdue") return "Overdue";
  if (status === "soon") return "Due soon";
  return "OK";
}

function suggestionDueText(s) {
  const parts = [];
  if (s.nextDueMileage != null) parts.push(`~${Math.round(s.nextDueMileage).toLocaleString()} km`);
  if (s.nextDueDate) parts.push(s.nextDueDate);
  return parts.join(" or ") || "-";
}

async function updateVehicleMaintLastDone(vehicleId, itemCode, dateISO, mileage) {
  const uid = currentUser.uid;
  const cfg = vehicleMaintenance.find(x => x.vehicleId === vehicleId && x.itemCode === itemCode);
  if (!cfg) return;

  await updateDoc(doc(db, "users", uid, "vehicleMaintenance", cfg.id), {
    lastDoneDate: dateISO,
    lastDoneMileage: Number(mileage || 0),
    updatedAt: Date.now()
  });

  cfg.lastDoneDate = dateISO;
  cfg.lastDoneMileage = Number(mileage || 0);
}

/* =========================
   Vehicles + Maintenance
========================= */
btnAddVehicle?.addEventListener("click", async () => {
  await withLoading("Saving vehicle…", async () => {
    const name = (vehName?.value || "").trim();
    const plate = (vehPlate?.value || "").trim();
    const mileage = Number(vehMileage?.value || 0);
    const intervalKm = Number(vehIntervalKm?.value || 10000);
    const intervalMonths = Number(vehIntervalMonths?.value || 6);

    if (!name) { setText(vehStatus, "Please enter vehicle name."); return; }

    await ensureMaintenanceItemsSeeded();
    await loadMaintenanceItems();

    const { vehiclesCol } = userRoot(currentUser.uid);
    const ref = await addDoc(vehiclesCol, {
      name, plate,
      currentMileage: mileage,
      serviceIntervalKm: intervalKm,
      serviceIntervalMonths: intervalMonths,
      active: true,
      createdAt: Date.now()
    });

    await ensureVehicleMaintenanceDefaults({ id: ref.id, currentMileage: mileage });

    if (vehName) vehName.value = "";
    if (vehPlate) vehPlate.value = "";
    if (vehMileage) vehMileage.value = "";
    if (vehIntervalKm) vehIntervalKm.value = "";
    if (vehIntervalMonths) vehIntervalMonths.value = "";
    setText(vehStatus, "Saved.");
    showToast("Saved ✅");

    showTab("vehicle");

    await loadVehicles();
    await loadVehicleMaintenance();
    recomputeAllVehicleSuggestions();

    await loadMaintenanceLogs();
    await loadMonthData();
  });
});

btnRefreshVehicles?.addEventListener("click", async () => {
  await withLoading("Refreshing vehicles…", async () => {
    await loadVehicles();
    await loadMaintenanceLogs();
    setText(vehStatus, "Refreshed.");
    showToast("Refreshed ✅");
  });
});

async function loadVehicles() {
  await ensureMaintenanceItemsSeeded();
  await loadMaintenanceItems();

  const { vehiclesCol } = userRoot(currentUser.uid);
  const snap = await getDocs(vehiclesCol);
  const list = [];
  snap.forEach(d => {
    const x = d.data() || {};
    list.push({
      id: d.id,
      name: String(x.name || "").trim(),
      plate: String(x.plate || "").trim(),
      currentMileage: Number(x.currentMileage || 0),
      serviceIntervalKm: Number(x.serviceIntervalKm || 10000),
      serviceIntervalMonths: Number(x.serviceIntervalMonths || 6),
      active: (x.active !== false)
    });
  });
  list.sort((a, b) => a.name.localeCompare(b.name));
  vehicles = list;

  for (const v of vehicles) {
    await ensureVehicleMaintenanceDefaults(v);
  }

  await loadVehicleMaintenance();
  recomputeAllVehicleSuggestions();

  renderVehiclesTable();
}

async function loadMaintenanceLogs() {
  const { maintCol } = userRoot(currentUser.uid);
  const snap = await getDocs(maintCol);
  const list = [];
  snap.forEach(d => {
    const x = d.data() || {};
    list.push({
      id: d.id,
      vehicleId: String(x.vehicleId || ""),
      date: String(x.date || ""),
      mileage: Number(x.mileage || 0),
      serviceType: String(x.serviceType || "Service"),
      cost: Number(x.cost || 0),
      notes: String(x.notes || ""),
      logType: String(x.logType || "maintenance"),
      itemCode: String(x.itemCode || "")
    });
  });
  list.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  maintenanceLogs = list;
}

function latestServiceForVehicle(vehicleId) {
  return maintenanceLogs.find(l => l.vehicleId === vehicleId && (l.logType || "maintenance") !== "accessory") || null;
}

/* ✅ QUICK LOG: NO prompts for checklist ticking */
async function logMaintenanceQuick(vehicleId, itemCode, serviceType) {
  const v = vehicles.find(x => x.id === vehicleId);
  if (!v) return;

  const dateISO = todayISO();
  const mileage = Number(v.currentMileage || 0);

  const { maintCol } = userRoot(currentUser.uid);
  await addDoc(maintCol, {
    vehicleId,
    date: dateISO,
    mileage,
    serviceType: String(serviceType || "Maintenance").trim(),
    cost: 0,
    notes: "",
    logType: "maintenance",
    itemCode: String(itemCode || ""),
    createdAt: Date.now()
  });

  if (itemCode) {
    await updateVehicleMaintLastDone(vehicleId, itemCode, dateISO, mileage);
  }
}

/* Manual add: prompts (still available) */
async function addServiceLogPrompt(vehicleId, opts = {}) {
  const v = vehicles.find(x => x.id === vehicleId);
  if (!v) return;

  const {
    logType = "maintenance",
    itemCode = "",
    prefillServiceType = "Service",
  } = opts;

  const dateISO = prompt("Date (YYYY-MM-DD)", todayISO());
  if (!dateISO) return;

  let mileage = Number(v.currentMileage || 0);
  if (logType !== "accessory") {
    mileage = Number(prompt("Mileage (km)", String(v.currentMileage || 0)) || 0);
  }

  const serviceType = (prompt("Type / Item", prefillServiceType) || prefillServiceType).trim();
  const cost = Number(prompt("Cost (RM)", "0") || 0);
  const notes = prompt("Notes (optional)", "") || "";

  const { maintCol } = userRoot(currentUser.uid);
  await addDoc(maintCol, {
    vehicleId,
    date: dateISO,
    mileage: Number(mileage || 0),
    serviceType,
    cost: Number(cost || 0),
    notes,
    logType,
    itemCode: String(itemCode || ""),
    createdAt: Date.now()
  });

  if (logType !== "accessory" && mileage > Number(v.currentMileage || 0)) {
    await updateDoc(doc(db, "users", currentUser.uid, "vehicles", vehicleId), {
      currentMileage: mileage,
      updatedAt: Date.now()
    });
    v.currentMileage = mileage;
  }

  if (logType === "maintenance" && itemCode) {
    await updateVehicleMaintLastDone(vehicleId, itemCode, dateISO, mileage);
  }

  if (cost > 0) {
    const eff = computeEffectiveMonth(dateISO, settings.cutoffDay);
    const safeCode = (itemCode || serviceType || "log").replace(/\s+/g, "_").toLowerCase();
    const txId = `vehlog_${vehicleId}_${safeCode}_${dateISO}`;

    await setDoc(doc(db, "users", currentUser.uid, "transactions", txId), {
      date: dateISO,
      type: "expense",
      group: "Vehicle",
      category: `${v.name} - ${serviceType}`,
      amount: Number(cost || 0),
      effectiveMonth: eff,
      isVehicleMaintenance: (logType === "maintenance"),
      isVehicleAccessory: (logType === "accessory"),
      isVehicleExpense: true,
      vehicleId,
      maintenanceItemCode: String(itemCode || ""),
      logType,
      updatedAt: Date.now()
    }, { merge: true });
  }
}

function renderVehiclesTable() {
  if (!vehiclesTableBody) return;
  vehiclesTableBody.innerHTML = "";

  for (const v of vehicles) {
    const last = latestServiceForVehicle(v.id);

    const lastMileage = last ? Number(last.mileage || 0) : null;
    const lastDate = last ? String(last.date || "") : null;

    const nextKm = (lastMileage != null)
      ? (lastMileage + Number(v.serviceIntervalKm || 0))
      : (Number(v.currentMileage || 0) + Number(v.serviceIntervalKm || 0));

    const nextDate = (lastDate)
      ? addMonthsToISO(lastDate, v.serviceIntervalMonths || 6)
      : null;

    const dueText = [
      `~ ${Math.round(nextKm).toLocaleString()} km`,
      nextDate ? `or ${nextDate}` : ""
    ].filter(Boolean).join(" ");

    const sugList = suggestionsByVehicleId.get(v.id) || [];
    const dueCount = sugList.filter(s => s.status !== "ok").length;
    const btnLabel = dueCount ? `Checklist (${dueCount})` : `Checklist`;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <div style="font-weight:900">${escapeHtml(v.name)}</div>
        <div class="muted" style="font-size:12px">${escapeHtml(v.plate || "")}</div>
      </td>

      <td>
        <div>${escapeHtml(dueText || "Add first service")}</div>
        <div style="margin-top:8px;">
          <button class="btnTiny primary" type="button" data-act="openChecklist">
            ${escapeHtml(btnLabel)}
          </button>
        </div>
      </td>

      <td class="muted">
        ${last ? `${escapeHtml(last.serviceType)} • ${escapeHtml(last.date)} • ${escapeHtml(fmtRM(last.cost))}` : "No logs yet"}
      </td>

      <td>
        <button class="iconBtn add" type="button">Add service</button>
        <button class="iconBtn" data-act="acc" type="button">Accessory</button>
        <button class="iconBtn danger del" type="button">✕</button>
      </td>
    `;

    // ✅ Clean checklist modal (tick logs instantly, no prompts)
    tr.querySelector('[data-act="openChecklist"]').addEventListener("click", () => {
      const modal = ensureVehModal();
      const title = modal.querySelector("#vehSugTitle");
      const sub = modal.querySelector("#vehSugSub");
      const listEl = modal.querySelector("#vehSugList");

      const all = suggestionsByVehicleId.get(v.id) || [];
      const priority = all.filter(s => s.status !== "ok");
      const show = (priority.length ? priority : all).slice(0, 12);

      title.textContent = `${v.name} — Checklist`;
      sub.textContent = priority.length
        ? `${priority.length} item(s) due/soon. Tick to log.`
        : `All OK. Tick anything you just did.`;

      listEl.innerHTML = "";
      if (!show.length) {
        listEl.innerHTML = `<div class="muted">No items found.</div>`;
      } else {
        for (const s of show) {
          const row = document.createElement("div");
          row.className = "sugItem";
          row.innerHTML = `
            <input class="sugChk" type="checkbox" />
            <div class="sugMain">
              <div class="sugTop">
                <span class="pillMini ${pillClass(s.status)}">${escapeHtml(suggestionBadgeText(s.status))}</span>
                <span class="sugName">${escapeHtml(s.name)}</span>
              </div>
              <div class="sugMeta">Due: ${escapeHtml(suggestionDueText(s))}</div>
            </div>
          `;
          const chk = row.querySelector(".sugChk");
          chk.addEventListener("change", async () => {
            if (!chk.checked) return;
            chk.disabled = true;

            await withLoading("Logging…", async () => {
              await logMaintenanceQuick(v.id, s.itemCode, s.name);
              await loadMaintenanceLogs();
              await loadVehicles(); // recompute suggestions + rerender
              await loadMonthData();
            });

            showToast("Logged ✅");
            modal.classList.add("hidden");
          });

          listEl.appendChild(row);
        }
      }

      modal.classList.remove("hidden");
    });

    // Manual add service (prompts allowed)
    tr.querySelector(".add").addEventListener("click", async () => {
      await withLoading("Adding service…", async () => {
        await addServiceLogPrompt(v.id, { logType: "maintenance", prefillServiceType: "Service" });
        await loadMaintenanceLogs();
        await loadVehicles();
        await loadMonthData();
        showToast("Logged ✅");
      });
    });

    // Accessory (prompts allowed)
    tr.querySelector('[data-act="acc"]').addEventListener("click", async () => {
      await withLoading("Adding accessory…", async () => {
        await addServiceLogPrompt(v.id, { logType: "accessory", prefillServiceType: "Accessory (e.g., Dashcam)" });
        await loadMaintenanceLogs();
        await loadVehicles();
        await loadMonthData();
        showToast("Logged ✅");
      });
    });

    // Delete
    tr.querySelector(".del").addEventListener("click", async () => {
      await withLoading("Deleting vehicle…", async () => {
        if (!confirm(`Delete vehicle "${v.name}"?`)) return;
        await deleteDoc(doc(db, "users", currentUser.uid, "vehicles", v.id));
        await loadVehicles();
        await loadMonthData();
        showToast("Deleted ✅");
      });
    });

    vehiclesTableBody.appendChild(tr);
  }
}

/* =========================
   Auto-stuff for a month
========================= */
async function applyAutoStuffForMonth(ym) {
  if (!recurring.length) await loadRecurring();
  if (!bills.length) await loadBills();
  await ensureRecurringForMonth(ym);
  await ensureBillsForMonth(ym);
  await renderBillsTable();
}

/* =========================
   Plan
========================= */
btnAddPlanRow?.addEventListener("click", () => addPlanRow({ group: "", category: "", type: "expense", planned: 0 }));

btnSavePlan?.addEventListener("click", async () => {
  await withLoading("Saving plan…", async () => {
    currentPlan = readPlanFromTable();
    await savePlan(currentMonthYM, currentPlan);
    setText(planSavedHint, `Saved at ${new Date().toLocaleString()}`);
    showToast("Saved ✅");
    await loadMonthData();
  });
});

async function loadPlan(ym) {
  const snap = await getDoc(userRoot(currentUser.uid).planDoc(ym));
  if (!snap.exists()) return [];
  return Array.isArray(snap.data().items) ? snap.data().items : [];
}

async function savePlan(ym, items) {
  await setDoc(userRoot(currentUser.uid).planDoc(ym), { items, updatedAt: Date.now() }, { merge: true });
}

function renderPlanTable(items) {
  if (!planTableBody) return;
  planTableBody.innerHTML = "";
  items.forEach(addPlanRow);
}

function addPlanRow(item) {
  if (!planTableBody) return;
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><input class="p-group" list="dlGroups" placeholder="e.g. Needs" value="${escapeHtml(item.group || "")}"></td>
    <td><input class="p-category" list="dlCategories" placeholder="e.g. Groceries" value="${escapeHtml(item.category || "")}"></td>
    <td>
      <select class="p-type">
        <option value="expense">spending</option>
        <option value="income">income</option>
      </select>
    </td>
    <td><input class="p-planned" type="number" step="0.01" value="${Number(item.planned || 0)}"></td>
    <td><button class="iconBtn danger" type="button">✕</button></td>
  `;
  tr.querySelector(".p-type").value = item.type === "income" ? "income" : "expense";
  tr.querySelector("button").addEventListener("click", () => tr.remove());
  planTableBody.appendChild(tr);
}

function readPlanFromTable() {
  if (!planTableBody) return [];
  return [...planTableBody.querySelectorAll("tr")]
    .map(tr => ({
      group: tr.querySelector(".p-group")?.value?.trim() || "",
      category: tr.querySelector(".p-category")?.value?.trim() || "",
      type: tr.querySelector(".p-type")?.value === "income" ? "income" : "expense",
      planned: Number(tr.querySelector(".p-planned")?.value || 0)
    }))
    .filter(x => x.group || x.category);
}

/* =========================
   Transactions
========================= */
btnAddTx?.addEventListener("click", () => {
  const d = new Date();
  const iso = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  addTxRow({
    id: null, date: iso, type: "expense", group: "", category: "", amount: 0,
    effectiveMonth: computeEffectiveMonth(iso, settings.cutoffDay)
  });
});

async function loadTransactionsForMonth(ym) {
  const { txCol } = userRoot(currentUser.uid);
  const qy = query(txCol, where("effectiveMonth", "==", ym), orderBy("date", "asc"));
  const snap = await getDocs(qy);
  const out = [];
  snap.forEach(d => out.push({ id: d.id, ...d.data() }));
  return out;
}

function renderTxTable(items) {
  if (!txTableBody) return;
  txTableBody.innerHTML = "";
  items.forEach(addTxRow);
}

function addTxRow(tx) {
  if (!txTableBody) return;

  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><input class="t-date" type="date" value="${tx.date || ""}" title="Date"></td>
    <td>
      <select class="t-type" title="Type">
        <option value="expense">spending</option>
        <option value="income">income</option>
      </select>
    </td>
    <td><input class="t-group" list="dlGroups" placeholder="e.g. Needs" value="${escapeHtml(tx.group || "")}" title="Group"></td>
    <td><input class="t-category" list="dlCategories" placeholder="e.g. Groceries" value="${escapeHtml(tx.category || "")}" title="Category"></td>
    <td><input class="t-amount" type="number" step="0.01" value="${Number(tx.amount || 0)}" title="Amount"></td>
    <td><span class="pill t-month">${tx.effectiveMonth || ""}</span></td>
    <td>
      <button class="iconBtn t-save" type="button">Save</button>
      <button class="iconBtn danger t-del" type="button">✕</button>
    </td>
  `;

  tr.querySelector(".t-type").value = tx.type === "income" ? "income" : "expense";

  const updateMonthBadge = () => {
    const dateISO = tr.querySelector(".t-date").value;
    const eff = computeEffectiveMonth(dateISO, settings.cutoffDay);
    tr.querySelector(".t-month").textContent = eff;
    return eff;
  };
  tr.querySelector(".t-date").addEventListener("change", updateMonthBadge);

  tr.querySelector(".t-save").addEventListener("click", async () => {
    await withLoading("Saving transaction…", async () => {
      const dateISO = tr.querySelector(".t-date").value;
      if (!dateISO) { showToast("Pick a date ❌"); return; }

      const type = tr.querySelector(".t-type").value === "income" ? "income" : "expense";
      const group = tr.querySelector(".t-group").value.trim();
      const category = tr.querySelector(".t-category").value.trim();
      const amount = Number(tr.querySelector(".t-amount").value || 0);
      const effectiveMonth = updateMonthBadge();

      const data = { date: dateISO, type, group, category, amount, effectiveMonth, updatedAt: Date.now() };

      if (!tx.id) {
        const docRef = await addDoc(userRoot(currentUser.uid).txCol, { ...data, createdAt: Date.now() });
        tx.id = docRef.id;
      } else {
        await updateDoc(doc(db, "users", currentUser.uid, "transactions", tx.id), data);
      }

      await loadMonthData();
      await loadTrendDataAndRender();
      showToast("Saved ✅");
    }, "Updating dashboard…");
  });

  tr.querySelector(".t-del").addEventListener("click", async () => {
    await withLoading("Deleting transaction…", async () => {
      if (!tx.id) { tr.remove(); return; }
      if (!confirm("Delete this item?")) return;
      await deleteDoc(doc(db, "users", currentUser.uid, "transactions", tx.id));
      await loadMonthData();
      await loadTrendDataAndRender();
      showToast("Deleted ✅");
    });
  });

  txTableBody.appendChild(tr);
}

/* =========================
   Monthly view
========================= */
monthlyGroupFilter?.addEventListener("change", () => renderMonthlyView());
monthlySearch?.addEventListener("input", () => renderMonthlyView());

function setMonthlyGroupOptions() {
  if (!monthlyGroupFilter) return;

  const groups = new Set();
  currentPlan.forEach(p => p.group && groups.add(p.group.trim()));
  currentTransactions.forEach(t => t.group && groups.add(t.group.trim()));
  categories.forEach(c => c.group && groups.add(c.group.trim()));
  bills.forEach(b => b.group && groups.add(b.group.trim()));

  const sorted = [...groups].filter(Boolean).sort((a, b) => a.localeCompare(b));
  const prev = monthlyGroupFilter.value || "All";
  monthlyGroupFilter.innerHTML = "";
  monthlyGroupFilter.appendChild(new Option("All", "All"));
  sorted.forEach(g => monthlyGroupFilter.appendChild(new Option(g, g)));
  monthlyGroupFilter.value = [...monthlyGroupFilter.options].some(o => o.value === prev) ? prev : "All";
}

function buildMonthlyRows() {
  const map = new Map();

  for (const p of currentPlan) {
    const type = p.type === "income" ? "income" : "expense";
    const group = (p.group || "").trim();
    const category = (p.category || "").trim();
    if (!group && !category) continue;
    const key = normalizeKey(group, category, type);
    if (!map.has(key)) map.set(key, { group, category, type, planned: 0, actual: 0 });
    map.get(key).planned += Number(p.planned || 0);
  }

  for (const t of currentTransactions) {
    const type = t.type === "income" ? "income" : "expense";
    const group = (t.group || "Other").trim() || "Other";
    const category = (t.category || "Other").trim() || "Other";
    const key = normalizeKey(group, category, type);
    if (!map.has(key)) map.set(key, { group, category, type, planned: 0, actual: 0 });
    map.get(key).actual += Number(t.amount || 0);
  }

  const rows = [];
  for (const r of map.values()) {
    let diff = 0, status = "On plan", badge = "ok";

    if (r.type === "expense") {
      diff = r.planned - r.actual;
      if (r.planned === 0 && r.actual > 0) { status = "Not planned"; badge = "warn"; }
      else if (diff >= 0) { status = "Good (within plan)"; badge = "ok"; }
      else { status = "Over budget"; badge = "bad"; }
    } else {
      diff = r.actual - r.planned;
      if (r.planned === 0 && r.actual > 0) { status = "Extra income"; badge = "ok"; }
      else if (diff > 0) { status = "Good (above plan)"; badge = "ok"; }
      else if (diff === 0) { status = "On plan"; badge = "ok"; }
      else { status = "Below plan"; badge = "warn"; }
    }

    rows.push({ ...r, diff, status, badge });
  }

  rows.sort((a, b) => {
    if (a.type !== b.type) return a.type === "expense" ? -1 : 1;
    if (a.diff !== b.diff) return a.diff - b.diff;
    return (a.group || "").localeCompare(b.group || "") || (a.category || "").localeCompare(b.category || "");
  });

  return rows;
}

function renderMonthlyView() {
  if (!monthlyTableBody || !monthlyTotalsHint || !monthlyGroupFilter || !monthlySearch) return;

  const rows = buildMonthlyRows();
  const group = monthlyGroupFilter.value || "All";
  const q = (monthlySearch.value || "").trim().toLowerCase();

  const filtered = rows.filter(r => {
    if (group !== "All" && (r.group || "") !== group) return false;
    if (q) {
      const hay = `${r.group} ${r.category} ${r.type}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const plannedIncome = sum(rows.filter(r => r.type === "income").map(r => r.planned));
  const plannedExpense = sum(rows.filter(r => r.type === "expense").map(r => r.planned));
  const actualIncome = sum(rows.filter(r => r.type === "income").map(r => r.actual));
  const actualExpense = sum(rows.filter(r => r.type === "expense").map(r => r.actual));
  setText(monthlyTotalsHint, `Planned result: ${fmtRM(plannedIncome - plannedExpense)} • Actual result: ${fmtRM(actualIncome - actualExpense)}`);

  monthlyTableBody.innerHTML = "";
  for (const r of filtered) {
    const tr = document.createElement("tr");
    const diffClass = r.diff >= 0 ? "pos" : "neg";
    tr.innerHTML = `
      <td>${escapeHtml(r.group || "")}</td>
      <td>${escapeHtml(r.category || "")}</td>
      <td><span class="badge">${r.type === "income" ? "income" : "spending"}</span></td>
      <td class="money">${escapeHtml(fmtRM(r.planned))}</td>
      <td class="money">${escapeHtml(fmtRM(r.actual))}</td>
      <td class="money ${diffClass}">${escapeHtml(fmtRM(r.diff))}</td>
      <td><span class="badge ${r.badge}">${escapeHtml(r.status)}</span></td>
      <td><button class="iconBtn" type="button">＋</button></td>
    `;
    tr.querySelector("button").addEventListener("click", () => {
      showTab("spending");
      const d = new Date();
      const iso = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      addTxRow({
        id: null, date: iso, type: r.type, group: r.group, category: r.category, amount: 0,
        effectiveMonth: computeEffectiveMonth(iso, settings.cutoffDay)
      });
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    });
    monthlyTableBody.appendChild(tr);
  }
}

/* =========================
   Overview + Charts
========================= */
async function computeUnpaidBillsForMonth(ym) {
  if (!bills.length) return { total: 0, count: 0 };

  const paidMap = await getBillPaidStatusForMonth(ym);
  let total = 0;
  let count = 0;

  for (const b of bills) {
    const st = paidMap.get(b.id);
    const isPaid = st ? !!st.paid : false;
    if (!isPaid) {
      total += Number(b.amount || 0);
      count += 1;
    }
  }
  return { total, count };
}

function computeOtPay() {
  const base = Number(otBaseRate?.value || 0);
  const h15 = Number(otHours15?.value || 0);
  const h20 = Number(otHours20?.value || 0);
  const h30 = Number(otHours30?.value || 0);

  const total =
    (base * 1.5 * h15) +
    (base * 2.0 * h20) +
    (base * 3.0 * h30);

  return Number(total.toFixed(2));
}

function renderOtCalculator() {
  if (!otResultTotal || !otBaseRate) return;
  const total = computeOtPay();
  otResultTotal.textContent = fmtRM(total);
}

function renderSavingsSuggestion(actualIncome, actualExpense) {
  if (!leftoverThisMonth || !suggestedSavings || !suggestedInvestment) return;

  const leftover = Number(actualIncome || 0) - Number(actualExpense || 0);
  const saveP = Number(savePct?.value || 0) / 100;
  const investP = Number(investPct?.value || 0) / 100;

  const saveAmt = Math.max(0, leftover * saveP);
  const investAmt = Math.max(0, leftover * investP);

  leftoverThisMonth.textContent = fmtRM(leftover);
  suggestedSavings.textContent = fmtRM(saveAmt);
  suggestedInvestment.textContent = fmtRM(investAmt);
}

function wireOtAndSuggestionListenersOnce() {
  const inputs = [otBaseRate, otHours15, otHours20, otHours30, savePct, investPct];
  inputs.forEach(el => el?.addEventListener("input", () => {
    renderOtCalculator();
    renderOverview();
  }));

  btnAddOtIncome?.addEventListener("click", async () => {
    const total = computeOtPay();
    if (!total || total <= 0) { showToast("OT total is 0 ❌"); return; }

    const cat = (otCategory?.value || "Overtime").trim() || "Overtime";
    const dateISO = (otDate?.value || new Date().toISOString().slice(0, 10));
    const eff = computeEffectiveMonth(dateISO, settings.cutoffDay);

    await withLoading("Saving OT income…", async () => {
      await addDoc(userRoot(currentUser.uid).txCol, {
        date: dateISO,
        type: "income",
        group: "Income",
        category: cat,
        amount: total,
        effectiveMonth: eff,
        isOvertime: true,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });

      await loadMonthData();
      await loadTrendDataAndRender();
      showToast("Logged ✅");
    });
  });
}

async function renderOverview() {
  const planIncome = sum(currentPlan.filter(i => i.type === "income").map(i => i.planned));
  const planExpense = sum(currentPlan.filter(i => i.type !== "income").map(i => i.planned));
  const planNet = planIncome - planExpense;

  const actualIncome = sum(currentTransactions.filter(t => t.type === "income").map(t => t.amount));
  const actualExpense = sum(currentTransactions.filter(t => t.type !== "income").map(t => t.amount));
  const actualNet = actualIncome - actualExpense;

  setText(kpiPlannedNet, fmtRM(planNet));
  setText(kpiActualNet, fmtRM(actualNet));
  setText(kpiActualOutflows, fmtRM(actualExpense));
  setText(kpiActualIncome, fmtRM(actualIncome));

  const unpaid = await computeUnpaidBillsForMonth(currentMonthYM);
  setText(kpiUnpaidBills, fmtRM(unpaid.total));
  setText(kpiUnpaidBillsHint, unpaid.count ? `${unpaid.count} bill(s) not paid yet` : "All bills paid 🎉");

  renderBarChart(planIncome, planExpense, actualIncome, actualExpense);
  renderPieChart(currentTransactions);
  renderOtCalculator();
  renderSavingsSuggestion(actualIncome, actualExpense);
}

function renderBarChart(planIncome, planExpense, actualIncome, actualExpense) {
  const ctx = document.getElementById("barPlannedActual");
  if (charts.bar) charts.bar.destroy();
  if (!window.Chart || !ctx) return;

  charts.bar = new Chart(ctx, {
    type: "bar",
    data: {
      labels: ["Income", "Spending"],
      datasets: [
        { label: "Planned", data: [planIncome, planExpense] },
        { label: "Actual", data: [actualIncome, actualExpense] }
      ]
    },
    options: { responsive: true, plugins: { legend: { display: true } } }
  });
}

function renderPieChart(transactions) {
  const ctx = document.getElementById("pieExpenses");
  if (charts.pie) charts.pie.destroy();
  if (!window.Chart || !ctx) return;

  const expenses = transactions.filter(t => t.type !== "income");
  const byGroup = new Map();
  expenses.forEach(t => {
    const g = (t.group || "Other").trim() || "Other";
    byGroup.set(g, (byGroup.get(g) || 0) + Number(t.amount || 0));
  });

  charts.pie = new Chart(ctx, {
    type: "pie",
    data: { labels: [...byGroup.keys()], datasets: [{ label: "Spending", data: [...byGroup.values()] }] },
    options: { responsive: true }
  });
}

/* Trend */
async function loadTrendDataAndRender() {
  const pts = await computeNetTrendLast12(currentMonthYM);
  renderLineChart(pts);
}

async function computeNetTrendLast12(anchorYM) {
  const months = [];
  for (let i = 11; i >= 0; i--) months.push(addMonthsYM(anchorYM, -i));
  const out = [];
  for (const ym of months) {
    const txs = await loadTransactionsForMonth(ym);
    const inc = sum(txs.filter(t => t.type === "income").map(t => t.amount));
    const exp = sum(txs.filter(t => t.type !== "income").map(t => t.amount));
    out.push({ ym, net: inc - exp });
  }
  return out;
}

function renderLineChart(points) {
  const ctx = document.getElementById("lineNet");
  if (charts.line) charts.line.destroy();
  if (!window.Chart || !ctx) return;

  charts.line = new Chart(ctx, {
    type: "line",
    data: { labels: points.map(p => p.ym), datasets: [{ label: "Net (income - spending)", data: points.map(p => p.net) }] },
    options: { responsive: true }
  });
}

/* =========================
   Load month data
========================= */
async function loadMonthData() {
  currentPlan = await loadPlan(currentMonthYM);
  renderPlanTable(currentPlan.length ? currentPlan : [{ group: "", category: "", type: "expense", planned: 0 }]);

  currentTransactions = await loadTransactionsForMonth(currentMonthYM);
  renderTxTable(currentTransactions);

  setMonthlyGroupOptions();
  renderMonthlyView();
  await renderOverview();

  await renderBillsTable();
}

/* =========================
   Recompute effectiveMonth for all tx
========================= */
async function recomputeAllTxEffectiveMonths() {
  const { txCol } = userRoot(currentUser.uid);
  const snap = await getDocs(txCol);

  const updates = [];
  snap.forEach(d => {
    const x = d.data() || {};
    if (!x.date) return;
    const eff = computeEffectiveMonth(x.date, settings.cutoffDay);
    if (x.effectiveMonth !== eff) {
      updates.push(updateDoc(doc(db, "users", currentUser.uid, "transactions", d.id), { effectiveMonth: eff, updatedAt: Date.now() }));
    }
  });

  if (updates.length) await Promise.all(updates);
}

/* =========================
   Seed demo
========================= */
btnSeedDemo?.addEventListener("click", async () => {
  await withLoading("Adding sample setup…", async () => {
    const demoCats = [
      { group: "Income", name: "Salary", type: "income" },
      { group: "Income", name: "Other", type: "income" },
      { group: "Needs", name: "Rent", type: "expense" },
      { group: "Needs", name: "Groceries", type: "expense" },
      { group: "Needs", name: "Transport", type: "expense" },
      { group: "Needs", name: "Bills", type: "expense" },
      { group: "Wants", name: "Eating Out", type: "expense" },
      { group: "Wants", name: "Shopping", type: "expense" },
      { group: "Savings", name: "Emergency Fund", type: "expense" },
      { group: "Vehicle", name: "Maintenance", type: "expense" },
      { group: "Debt", name: "Loan Payment", type: "expense" }
    ];

    const { catsCol } = userRoot(currentUser.uid);
    const existing = new Set(categories.map(c => `${c.group.toLowerCase()}||${c.name.toLowerCase()}||${c.type}`));
    const adds = [];
    for (const c of demoCats) {
      const key = `${c.group.toLowerCase()}||${c.name.toLowerCase()}||${c.type}`;
      if (!existing.has(key)) adds.push(addDoc(catsCol, { ...c, createdAt: Date.now() }));
    }
    if (adds.length) await Promise.all(adds);
    await loadCategories();

    const { recCol } = userRoot(currentUser.uid);
    await addDoc(recCol, {
      type: "income", group: "Income", category: "Salary",
      amount: 5000, dayOfMonth: 25, startMonth: currentMonthYM, endMonth: null, active: true, createdAt: Date.now()
    });

    const { billsCol } = userRoot(currentUser.uid);
    await addDoc(billsCol, { name: "Rent", group: "Needs", amount: 1200, dueDay: 1, active: true, createdAt: Date.now() });

    const { fundsCol } = userRoot(currentUser.uid);
    await addDoc(fundsCol, { name: "Car Maintenance", goalAmount: 3000, targetMonth: addMonthsYM(currentMonthYM, 10), currentSaved: 0, active: true, createdAt: Date.now() });

    const { debtsCol } = userRoot(currentUser.uid);
    await addDoc(debtsCol, { name: "Car Loan", type: "car_loan", apr: 3.2, currentBalance: 40000, monthlyPayment: 850, dueDay: 5, active: true, createdAt: Date.now() });

    const { vehiclesCol } = userRoot(currentUser.uid);
    await addDoc(vehiclesCol, { name: "My Car", plate: "", currentMileage: 60000, serviceIntervalKm: 10000, serviceIntervalMonths: 6, active: true, createdAt: Date.now() });

    await loadAllMasterData();
    await applyAutoStuffForMonth(currentMonthYM);
    await loadMonthData();

    showToast("Sample setup added ✅", 2200);
  });
});

/* =========================
   PDF Export (unchanged)
========================= */
btnExportPdf?.addEventListener("click", () => withLoading("Building PDF…", exportMonthlyPdf, "Preparing your report…"));
btnExportPdf2?.addEventListener("click", () => withLoading("Building PDF…", exportMonthlyPdf, "Preparing your report…"));

function exportMonthlyPdf() {
  // (kept as-is from your current version)
  const rows = buildMonthlyRows();

  const plannedIncome = sum(rows.filter(r => r.type === "income").map(r => r.planned));
  const plannedExpense = sum(rows.filter(r => r.type === "expense").map(r => r.planned));
  const actualIncome = sum(rows.filter(r => r.type === "income").map(r => r.actual));
  const actualExpense = sum(rows.filter(r => r.type === "expense").map(r => r.actual));
  const plannedNet = plannedIncome - plannedExpense;
  const actualNet = actualIncome - actualExpense;

  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = pdf.internal.pageSize.getWidth();
  const margin = 44;
  let y = 56;

  const newPageIfNeeded = (extra = 0) => {
    if (y + extra > 780) {
      pdf.addPage();
      y = 56;
    }
  };

  pdf.setFont("helvetica", "bold"); pdf.setFontSize(18);
  pdf.text(`Budget report — ${currentMonthYM}`, margin, y);
  y += 18;

  pdf.setFont("helvetica", "normal"); pdf.setFontSize(11);
  pdf.text(`Generated: ${new Date().toLocaleString()}`, margin, y);
  y += 18;

  pdf.setDrawColor(27, 42, 107); pdf.setLineWidth(1);
  pdf.line(margin, y, pageW - margin, y);
  y += 22;

  pdf.setFont("helvetica", "bold"); pdf.setFontSize(12);
  pdf.text("Summary", margin, y);
  y += 16;

  pdf.setFont("helvetica", "normal"); pdf.setFontSize(11);
  const lines = [
    `Planned income:   ${fmtRM(plannedIncome)}`,
    `Planned spending: ${fmtRM(plannedExpense)}`,
    `Planned result:   ${fmtRM(plannedNet)}`,
    "",
    `Actual income:    ${fmtRM(actualIncome)}`,
    `Actual spending:  ${fmtRM(actualExpense)}`,
    `Actual result:    ${fmtRM(actualNet)}`
  ];
  lines.forEach(line => {
    if (!line) { y += 8; return; }
    pdf.text(line, margin, y);
    y += 14;
  });

  y += 10;
  pdf.setFont("helvetica", "bold");
  pdf.text("Category breakdown (planned vs actual)", margin, y);
  y += 14;

  const cols = [
    { t: "Group", w: 120 },
    { t: "Category", w: 170 },
    { t: "Type", w: 70 },
    { t: "Planned", w: 80 },
    { t: "Actual", w: 80 }
  ];

  pdf.setFontSize(10);
  let x = margin;
  cols.forEach(c => { pdf.text(c.t, x, y); x += c.w; });
  y += 8;
  pdf.setDrawColor(120); pdf.setLineWidth(0.5);
  pdf.line(margin, y, pageW - margin, y);
  y += 14;

  pdf.setFont("helvetica", "normal");

  const printable = rows.filter(r => (Number(r.planned) || 0) !== 0 || (Number(r.actual) || 0) !== 0);
  for (const r of printable) {
    newPageIfNeeded(30);
    let x2 = margin;

    const vals = [
      r.group || "",
      r.category || "",
      r.type === "income" ? "income" : "spending",
      fmtRM(r.planned),
      fmtRM(r.actual)
    ];

    vals.forEach((val, idx) => {
      const max = idx === 1 ? 28 : 18;
      const safe = String(val).length > max ? String(val).slice(0, max - 1) + "…" : String(val);
      pdf.text(safe, x2, y);
      x2 += cols[idx].w;
    });
    y += 16;
  }

  pdf.save(`budget-report-${currentMonthYM}.pdf`);
}

/* =========================
   Boot
========================= */
currentMonthYM = toYM(new Date());
if (monthPicker) monthPicker.value = currentMonthYM;
showTab("overview");
wireOtAndSuggestionListenersOnce();
renderOtCalculator();
