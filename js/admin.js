// Admin dashboard: overview, templates (add / edit / archive / delete, cover + file uploads),
// contact form submissions and orders. Every action is also enforced by the database's row level
// security, so a non-admin who opens this page can't read or change anything.
(() => {
const sb = window.bffAuth;
const { esc, money } = window.bffShop;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Local preview only: /admin?demo shows sample data so the layout can be checked without signing in.
const DEMO = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && new URLSearchParams(location.search).has("demo");

const CATEGORY_LABELS = {
  cleaning: "Cleaning", salon: "Salon", finance: "Finance",
  "real-estate": "Real Estate", office: "Office Admin", planners: "Planners",
};
const VIEW_TITLES = { overview: "Overview", templates: "Templates", inquiries: "Submissions", orders: "Orders" };

const state = {
  view: "overview",
  products: [],
  fileCounts: {},      // slug -> number of download files
  inquiries: [],
  orders: [],
  filters: { templates: "all", inquiries: "new", orders: "paid" },
  search: { templates: "", inquiries: "", orders: "" },
};

// ---------- Small helpers ----------
const fmtDate = (iso, withTime) =>
  new Date(iso).toLocaleString(undefined, withTime
    ? { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", year: "numeric" });

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return fmtDate(iso);
}

function slugify(s) {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);
}
const toCents = (v) => (v === "" || v == null ? null : Math.round(parseFloat(v) * 100));
const safeFileName = (n) => n.replace(/[^\w.\-]+/g, "_").slice(-120);
const fileSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB");
const matches = (text, q) => !q || text.toLowerCase().includes(q.toLowerCase().trim());

function toast(message, type = "ok") {
  const box = $("[data-toasts]");
  const el = document.createElement("div");
  el.className = `adm-toast adm-toast--${type}`;
  el.setAttribute("role", type === "error" ? "alert" : "status");
  el.innerHTML = `<span>${esc(message)}</span><button type="button" aria-label="Dismiss">&times;</button>`;
  el.querySelector("button").addEventListener("click", () => el.remove());
  box.appendChild(el);
  setTimeout(() => el.classList.add("is-leaving"), type === "error" ? 7000 : 3500);
  setTimeout(() => el.remove(), type === "error" ? 7400 : 3900);
}

// Styled replacement for the browser's confirm(): resolves true only when the action button is pressed
let confirmOpen = false;
function askConfirm({ title, message = "", confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false }) {
  if (confirmOpen) return Promise.resolve(false); // one at a time
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "adm-confirm";
    dlg.setAttribute("aria-labelledby", "adm-confirm-title");
    dlg.innerHTML = `
      <div class="adm-confirm__icon${danger ? " is-danger" : ""}" aria-hidden="true">!</div>
      <h2 id="adm-confirm-title">${esc(title)}</h2>
      ${message ? `<p>${esc(message)}</p>` : ""}
      <div class="adm-confirm__actions">
        <button type="button" class="btn btn--outline" data-no>${esc(cancelLabel)}</button>
        <button type="button" class="btn ${danger ? "adm-btn--danger" : "btn--dark"}" data-yes>${esc(confirmLabel)}</button>
      </div>`;
    document.body.appendChild(dlg);
    confirmOpen = true;
    const done = (ok) => {
      dlg.classList.add("is-leaving");
      setTimeout(() => { dlg.close(); dlg.remove(); confirmOpen = false; }, 160);
      resolve(ok);
    };
    dlg.querySelector("[data-yes]").addEventListener("click", () => done(true));
    dlg.querySelector("[data-no]").addEventListener("click", () => done(false));
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); done(false); }); // Escape
    dlg.addEventListener("click", (e) => { if (e.target === dlg) done(false); }); // backdrop
    dlg.showModal();
    dlg.querySelector(danger ? "[data-no]" : "[data-yes]").focus();
  });
}

function emptyState(icon, title, text, action = "") {
  return `<div class="adm-empty"><span class="adm-empty__icon">${icon}</span><h3>${title}</h3><p>${text}</p>${action}</div>`;
}
const ICON_BOX = '<svg viewBox="0 0 24 24"><path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 7v10l9 4 9-4V7"/></svg>';
const ICON_MAIL = '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>';
const ICON_BAG = '<svg viewBox="0 0 24 24"><path d="M5 8h14l-1 13H6z"/><path d="M9 8a3 3 0 0 1 6 0"/></svg>';

// ---------- Access ----------
async function start() {
  if (DEMO) {
    loadDemo();
    return openApp("demo@thebusinessff.com");
  }
  const { data } = await sb.auth.getSession();
  if (!data.session) {
    $("[data-gate-msg]").innerHTML = `Sign in with an admin account to open the dashboard.<br /><a href="/account?next=/admin" class="btn btn--dark">Sign in</a>`;
    return;
  }
  const { data: isAdmin, error } = await sb.rpc("is_admin");
  if (error || !isAdmin) {
    $("[data-gate-msg]").innerHTML = `You're signed in as <strong>${esc(data.session.user.email)}</strong>, which isn't an admin account.<br /><a href="/" class="btn btn--dark">Back to the website</a>`;
    return;
  }
  openApp(data.session.user.email);
  await Promise.all([loadProducts(), loadInquiries(), loadOrders()]);
}

function openApp(email) {
  $("[data-gate]").hidden = true;
  $("[data-app]").hidden = false;
  $("[data-user-email]").textContent = email;
  $("[data-user-initial]").textContent = email.charAt(0).toUpperCase();
  const fromHash = location.hash.slice(1);
  showView(VIEW_TITLES[fromHash] ? fromHash : "overview");
  if (DEMO) toast("Demo mode: sample data, nothing is saved.", "info");
}

$("[data-signout]").addEventListener("click", async () => {
  if (!DEMO) await sb.auth.signOut();
  location.href = "/";
});

// ---------- Navigation ----------
function showView(view) {
  state.view = view;
  $$("[data-view]").forEach((v) => (v.hidden = v.dataset.view !== view));
  $$("[data-view-btn]").forEach((b) => b.dataset.viewBtn === view ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current"));
  $("[data-view-title]").textContent = VIEW_TITLES[view];
  $(".adm-head [data-new-template]").hidden = !(view === "overview" || view === "templates");
  history.replaceState(null, "", view === "overview" ? location.pathname + location.search : "#" + view);
  window.scrollTo(0, 0);
}
$$("[data-view-btn]").forEach((b) => b.addEventListener("click", () => showView(b.dataset.viewBtn)));
document.addEventListener("click", (e) => {
  const go = e.target.closest("[data-goto]");
  if (go) showView(go.dataset.goto);
});

// Filters + search (shared)
$$("[data-chips]").forEach((group) => {
  const key = group.dataset.chips;
  group.addEventListener("click", (e) => {
    const chip = e.target.closest(".adm-chip");
    if (!chip) return;
    $$(".adm-chip", group).forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
    state.filters[key] = chip.dataset.value;
    render(key);
  });
});
$$("[data-search]").forEach((input) =>
  input.addEventListener("input", () => {
    state.search[input.dataset.search] = input.value;
    render(input.dataset.search);
  })
);
function setChipCounts(key, counts) {
  $$(`[data-chips="${key}"] .adm-chip`).forEach((c) => {
    const n = counts[c.dataset.value];
    c.querySelector("em").textContent = n == null ? "" : n;
  });
}
function render(key) {
  if (key === "templates") renderTemplates();
  if (key === "inquiries") renderInquiries();
  if (key === "orders") renderOrders();
  renderOverview();
}

// ---------- Data ----------
async function loadProducts() {
  const { data, error } = await sb
    .from("products")
    .select("id, slug, name, summary, description, includes, price_cents, compare_at_cents, image_url, categories, sort_order, active, created_at")
    .order("sort_order").order("created_at");
  if (error) return toast("Templates couldn't load: " + error.message, "error");
  state.products = data;
  // Count download files per template (one small listing each)
  const counts = await Promise.all(data.map(async (p) => {
    const { data: files } = await sb.storage.from("downloads").list(p.slug, { limit: 100 });
    return [p.slug, (files || []).filter((f) => f.id && !f.name.startsWith(".")).length];
  }));
  state.fileCounts = Object.fromEntries(counts);
  render("templates");
}

async function loadInquiries() {
  const { data, error } = await sb.from("inquiries").select("*").order("created_at", { ascending: false });
  if (error) return toast("Submissions couldn't load: " + error.message, "error");
  state.inquiries = data;
  render("inquiries");
}

async function loadOrders() {
  const { data, error } = await sb
    .from("orders")
    .select("id, email, status, total_cents, created_at, paid_at, order_items(name)")
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return toast("Orders couldn't load: " + error.message, "error");
  state.orders = data;
  render("orders");
}

// ---------- Overview ----------
function renderOverview() {
  const paid = state.orders.filter((o) => o.status === "paid");
  const revenue = paid.reduce((s, o) => s + o.total_cents, 0);
  const paidRevenueOrders = paid.filter((o) => o.total_cents > 0).length;
  const active = state.products.filter((p) => p.active);
  const newInq = state.inquiries.filter((i) => i.status === "new");
  const noFiles = state.products.filter((p) => p.active && !state.fileCounts[p.slug]);

  $('[data-stat="revenue"]').textContent = "$" + (revenue / 100).toFixed(2);
  $('[data-stat="orders"]').textContent = paid.length;
  $('[data-stat-sub="orders"]').textContent = `${paidRevenueOrders} paid · ${paid.length - paidRevenueOrders} free downloads`;
  $('[data-stat="inquiries"]').textContent = newInq.length;
  $('[data-stat="templates"]').textContent = active.length;
  $('[data-stat-sub="templates"]').textContent = `${state.products.length - active.length} archived`;

  // Sidebar counts
  $('[data-count="templates"]').textContent = state.products.length || "";
  $('[data-count="inquiries"]').textContent = newInq.length || "";
  $('[data-count="orders"]').textContent = paid.length || "";

  // Needs attention
  const todo = [];
  if (noFiles.length) {
    todo.push(`<li class="adm-todo__item adm-todo__item--warn">
      <span class="adm-dot"></span>
      <div><strong>${noFiles.length} active template${noFiles.length === 1 ? " has" : "s have"} no download files</strong>
      <span>Buyers will see "files are being added": ${noFiles.slice(0, 3).map((p) => esc(p.name)).join(", ")}${noFiles.length > 3 ? "…" : ""}</span></div>
      <button type="button" class="adm-textbtn" data-goto-filter="nofiles">Fix</button></li>`);
  }
  if (newInq.length) {
    todo.push(`<li class="adm-todo__item">
      <span class="adm-dot adm-dot--pink"></span>
      <div><strong>${newInq.length} new submission${newInq.length === 1 ? "" : "s"}</strong>
      <span>Oldest from ${timeAgo(newInq[newInq.length - 1].created_at)}</span></div>
      <button type="button" class="adm-textbtn" data-goto="inquiries">Reply</button></li>`);
  }
  const pending = state.orders.filter((o) => o.status === "pending" && Date.now() - new Date(o.created_at) > 3600e3);
  if (pending.length) {
    todo.push(`<li class="adm-todo__item">
      <span class="adm-dot"></span>
      <div><strong>${pending.length} unpaid checkout${pending.length === 1 ? "" : "s"}</strong>
      <span>Started but not completed — usually abandoned carts.</span></div>
      <button type="button" class="adm-textbtn" data-goto-filter="pending">View</button></li>`);
  }
  $("[data-attention]").innerHTML = todo.length ? todo.join("") :
    `<li class="adm-todo__item adm-todo__item--ok"><span class="adm-dot adm-dot--ok"></span><div><strong>All caught up</strong><span>Nothing needs your attention right now.</span></div></li>`;

  // Recent submissions
  const recentInq = state.inquiries.slice(0, 4);
  $("[data-recent-inquiries]").innerHTML = recentInq.length ? recentInq.map((i) => `
    <li><button type="button" class="adm-mini__row" data-goto="inquiries">
      <span class="adm-avatar">${esc(i.name.charAt(0).toUpperCase())}</span>
      <span class="adm-mini__main"><strong>${esc(i.name)}</strong><span>${esc(i.service)} · ${esc(i.business)}</span></span>
      <span class="adm-mini__meta">${i.status === "new" ? '<span class="adm-pill adm-pill--pink">New</span>' : ""}<span>${timeAgo(i.created_at)}</span></span>
    </button></li>`).join("") : `<li class="adm-mini__empty">No submissions yet.</li>`;

  // Recent orders
  const recentOrders = state.orders.slice(0, 5);
  $("[data-recent-orders]").innerHTML = recentOrders.length ? ordersTable(recentOrders) :
    emptyState(ICON_BAG, "No orders yet", "Orders appear here as soon as someone checks out.");
}

$("[data-attention]").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-goto-filter]");
  if (!btn) return;
  const v = btn.dataset.gotoFilter;
  const key = v === "nofiles" ? "templates" : "orders";
  state.filters[key] = v;
  $$(`[data-chips="${key}"] .adm-chip`).forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.value === v)));
  render(key);
  showView(key);
});

// ---------- Templates ----------
function renderTemplates() {
  const ps = state.products;
  const has = (p) => !!state.fileCounts[p.slug];
  setChipCounts("templates", {
    all: ps.length,
    active: ps.filter((p) => p.active).length,
    archived: ps.filter((p) => !p.active).length,
    nofiles: ps.filter((p) => !has(p)).length,
  });
  const f = state.filters.templates;
  const q = state.search.templates;
  const list = ps.filter((p) =>
    (f === "all" || (f === "active" && p.active) || (f === "archived" && !p.active) || (f === "nofiles" && !has(p))) &&
    matches(`${p.name} ${p.summary} ${p.categories.join(" ")}`, q));

  const box = $("[data-templates]");
  if (!ps.length) {
    box.innerHTML = emptyState(ICON_BOX, "No templates yet", "Add your first template to start selling.",
      `<button type="button" class="btn btn--dark" data-new-template>+ New template</button>`);
    return;
  }
  if (!list.length) {
    box.innerHTML = emptyState(ICON_BOX, "Nothing matches", "Try a different search or filter.");
    return;
  }
  box.innerHTML = `
    <div class="adm-trow adm-trow--head" aria-hidden="true">
      <span>Template</span><span>Price</span><span>Files</span><span>Visible</span><span></span>
    </div>` + list.map((p) => {
    const files = state.fileCounts[p.slug] || 0;
    return `
    <div class="adm-trow ${p.active ? "" : "is-archived"}">
      <button type="button" class="adm-tmain" data-edit="${p.id}">
        ${p.image_url ? `<img src="${esc(p.image_url)}" alt="" loading="lazy" />` : `<span class="adm-noimg">No image</span>`}
        <span>
          <strong>${esc(p.name)}</strong>
          <span>${esc(p.categories.map((c) => CATEGORY_LABELS[c] || c).join(" · ") || "No category")}</span>
        </span>
      </button>
      <span class="adm-tprice" data-label="Price">${p.compare_at_cents ? `<s>${money(p.compare_at_cents)}</s>` : ""}${money(p.price_cents)}</span>
      <span data-label="Files">${files
        ? `<span class="adm-pill adm-pill--ok">${files} file${files === 1 ? "" : "s"}</span>`
        : `<button type="button" class="adm-pill adm-pill--warn" data-edit="${p.id}" data-focus-files>No files — add</button>`}</span>
      <span data-label="Visible">
        <label class="adm-switch" title="${p.active ? "Shown in the shop" : "Archived (hidden)"}">
          <input type="checkbox" ${p.active ? "checked" : ""} data-toggle-active="${p.id}" aria-label="Show ${esc(p.name)} in the shop" />
          <span class="adm-switch__track"></span>
        </label>
      </span>
      <span class="adm-tactions">
        <a class="adm-iconbtn" href="/product?p=${encodeURIComponent(p.slug)}" target="_blank" rel="noopener" title="View on website" aria-label="View ${esc(p.name)} on the website">
          <svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>
        </a>
        <button type="button" class="adm-iconbtn" data-edit="${p.id}" title="Edit" aria-label="Edit ${esc(p.name)}">
          <svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="m13.5 6.5 4 4"/></svg>
        </button>
      </span>
    </div>`;
  }).join("");
}

$("[data-templates]").addEventListener("change", async (e) => {
  const t = e.target.closest("[data-toggle-active]");
  if (!t) return;
  const p = state.products.find((x) => x.id === t.dataset.toggleActive);
  const active = t.checked;
  if (DEMO) { p.active = active; render("templates"); return toast(`Demo: "${p.name}" ${active ? "shown" : "archived"}.`, "info"); }
  const { error } = await sb.from("products").update({ active }).eq("id", p.id);
  if (error) { t.checked = !active; return toast("Couldn't update: " + error.message, "error"); }
  p.active = active;
  render("templates");
  toast(active ? `"${p.name}" is back in the shop.` : `"${p.name}" archived — hidden from the shop.`);
});

document.addEventListener("click", (e) => {
  const edit = e.target.closest("[data-edit]");
  if (edit) openDrawer(state.products.find((p) => p.id === edit.dataset.edit), !!edit.dataset.focusFiles);
  if (e.target.closest("[data-new-template]")) openDrawer(null);
});

// ---------- Editor drawer ----------
const drawer = $("[data-drawer]");
const scrim = $("[data-scrim]");
const form = $("#template-form");
const coverInput = $("[data-cover-input]");
const filesInput = $("[data-files-input]");
let editing = null;
let pendingCover = null;   // File
let pendingFiles = [];     // File[]
let existingFiles = [];    // storage objects
let dirty = false;
let slugTouched = false;

function showCover(url) {
  const img = $("[data-cover-img]");
  img.hidden = !url;
  $("[data-cover-empty]").hidden = !!url;
  if (url) img.src = url;
}

function updateIncludesCount() {
  const n = form.includes.value.split("\n").filter((s) => s.trim()).length;
  $("[data-includes-count]").textContent = `${n} item${n === 1 ? "" : "s"}`;
}

function renderFiles() {
  const list = $("[data-files]");
  const rows = [
    ...existingFiles.map((f) => `
      <li><span class="adm-file__icon">${(f.name.split(".").pop() || "").slice(0, 4).toUpperCase()}</span>
        <span class="adm-file__name">${esc(f.name)}<small>${f.metadata && f.metadata.size ? fileSize(f.metadata.size) : ""}</small></span>
        <button type="button" class="adm-textbtn adm-textbtn--danger" data-remove-existing="${esc(f.name)}">Remove</button></li>`),
    ...pendingFiles.map((f, i) => `
      <li class="is-pending"><span class="adm-file__icon">${(f.name.split(".").pop() || "").slice(0, 4).toUpperCase()}</span>
        <span class="adm-file__name">${esc(f.name)}<small>${fileSize(f.size)} · uploads on save</small></span>
        <button type="button" class="adm-textbtn" data-remove-pending="${i}">Undo</button></li>`),
  ];
  list.innerHTML = rows.length ? rows.join("") : `<li class="adm-files__empty">No files yet — buyers will see "files are being added".</li>`;
}

async function openDrawer(p, focusFiles) {
  editing = p || null;
  pendingCover = null;
  pendingFiles = [];
  existingFiles = [];
  slugTouched = false;
  form.reset();
  $("[data-drawer-crumb]").textContent = p ? "Edit template" : "New template";
  $("[data-drawer-title]").textContent = p ? p.name : "Add a template";
  form.name.value = p ? p.name : "";
  form.summary.value = p ? p.summary : "";
  form.slug.value = p ? p.slug : "";
  form.slug.readOnly = !!p;
  $("[data-slug-hint]").textContent = p
    ? "Fixed after creation, because the download files are stored under it."
    : "Created from the name. Fixed after saving, because files are stored under it.";
  form.price.value = p ? (p.price_cents / 100).toFixed(2) : "";
  form.compare.value = p && p.compare_at_cents ? (p.compare_at_cents / 100).toFixed(2) : "";
  $$('input[name="cat"]', form).forEach((c) => (c.checked = !!p && p.categories.includes(c.value)));
  form.sort.value = p ? p.sort_order : state.products.reduce((m, x) => Math.max(m, x.sort_order), 0) + 10;
  form.active.checked = p ? p.active : true;
  $("[data-active-text]").textContent = form.active.checked ? "Active" : "Archived";
  form.description.value = p ? p.description : "";
  form.includes.value = p ? p.includes.join("\n") : "";
  form.image_url.value = p && p.image_url ? p.image_url : "";
  updateIncludesCount();
  showCover(p && p.image_url);
  $("[data-delete-template]").hidden = !p;
  renderFiles();

  scrim.hidden = false;
  drawer.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => { drawer.classList.add("is-open"); scrim.classList.add("is-open"); });
  document.body.style.overflow = "hidden";
  dirty = false;

  if (p && !DEMO) {
    $("[data-files]").innerHTML = `<li class="adm-files__empty">Loading files…</li>`;
    const { data } = await sb.storage.from("downloads").list(p.slug, { limit: 100 });
    existingFiles = (data || []).filter((f) => f.id && !f.name.startsWith("."));
    renderFiles();
  }
  setTimeout(() => (focusFiles ? $('[data-drop="files"]').scrollIntoView({ block: "center" }) : form.name.focus()), 260);
}

async function closeDrawer(force) {
  if (!force && dirty && !(await askConfirm({ title: "Discard unsaved changes?", message: "The changes you made to this template haven't been saved.", confirmLabel: "Discard changes", cancelLabel: "Keep editing", danger: true }))) return;
  drawer.classList.remove("is-open");
  scrim.classList.remove("is-open");
  drawer.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  setTimeout(() => (scrim.hidden = true), 250);
}

$$("[data-close-drawer]").forEach((b) => b.addEventListener("click", () => closeDrawer()));
scrim.addEventListener("click", () => closeDrawer());
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !confirmOpen && drawer.classList.contains("is-open")) closeDrawer(); });

form.addEventListener("input", (e) => {
  dirty = true;
  if (e.target === form.name && !editing && !slugTouched) form.slug.value = slugify(form.name.value);
  if (e.target === form.slug) slugTouched = true;
  if (e.target === form.image_url && !pendingCover) showCover(form.image_url.value.trim());
  if (e.target === form.includes) updateIncludesCount();
  if (e.target === form.active) $("[data-active-text]").textContent = form.active.checked ? "Active" : "Archived";
});
form.active.addEventListener("change", () => ($("[data-active-text]").textContent = form.active.checked ? "Active" : "Archived"));

function takeCover(file) {
  if (!file || !file.type.startsWith("image/")) return toast("Please choose an image file.", "error");
  pendingCover = file;
  dirty = true;
  showCover(URL.createObjectURL(file));
}
function takeFiles(list) {
  pendingFiles.push(...list);
  dirty = true;
  renderFiles();
}
coverInput.addEventListener("change", () => takeCover(coverInput.files[0]));
filesInput.addEventListener("change", () => { takeFiles([...filesInput.files]); filesInput.value = ""; });

// Drag & drop on both drop zones
$$("[data-drop]").forEach((zone) => {
  ["dragenter", "dragover"].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add("is-over"); }));
  ["dragleave", "drop"].forEach((ev) => zone.addEventListener(ev, () => zone.classList.remove("is-over")));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    if (zone.dataset.drop === "cover") takeCover(files[0]);
    else takeFiles(files);
  });
});

$("[data-files]").addEventListener("click", async (e) => {
  const undo = e.target.closest("[data-remove-pending]");
  if (undo) { pendingFiles.splice(Number(undo.dataset.removePending), 1); renderFiles(); return; }
  const rm = e.target.closest("[data-remove-existing]");
  if (!rm || !editing) return;
  const name = rm.dataset.removeExisting;
  if (!(await askConfirm({ title: `Remove "${name}"?`, message: "Buyers will no longer be able to download this file.", confirmLabel: "Remove file", danger: true }))) return;
  if (DEMO) { existingFiles = existingFiles.filter((f) => f.name !== name); renderFiles(); return; }
  const { error } = await sb.storage.from("downloads").remove([`${editing.slug}/${name}`]);
  if (error) return toast("Couldn't remove the file: " + error.message, "error");
  existingFiles = existingFiles.filter((f) => f.name !== name);
  state.fileCounts[editing.slug] = existingFiles.length;
  renderFiles();
  render("templates");
  toast(`Removed ${name}.`);
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const slug = editing ? editing.slug : (form.slug.value.trim() || slugify(form.name.value));
  const price = toCents(form.price.value);
  const compare = toCents(form.compare.value);
  const fail = (msg, field) => { toast(msg, "error"); if (field) field.focus(); };
  if (!form.name.value.trim()) return fail("Please give the template a name.", form.name);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return fail("The web address can only use lowercase letters, numbers and dashes.", form.slug);
  if (price == null || isNaN(price) || price < 0) return fail("Please enter a price (0 for free).", form.price);
  if (compare != null && compare <= price) return fail("The original price must be higher than the price.", form.compare);

  const row = {
    name: form.name.value.trim(),
    summary: form.summary.value.trim(),
    description: form.description.value.trim(),
    includes: form.includes.value.split("\n").map((s) => s.trim()).filter(Boolean),
    price_cents: price,
    compare_at_cents: compare,
    image_url: form.image_url.value.trim() || null,
    categories: $$('input[name="cat"]:checked', form).map((c) => c.value),
    sort_order: parseInt(form.sort.value, 10) || 0,
    active: form.active.checked,
  };

  if (DEMO) {
    if (editing) Object.assign(editing, row);
    else state.products.push({ ...row, id: crypto.randomUUID(), slug, created_at: new Date().toISOString() });
    state.fileCounts[slug] = (state.fileCounts[slug] || 0) + pendingFiles.length;
    closeDrawer(true);
    render("templates");
    return toast(`Demo: "${row.name}" saved (not really).`, "info");
  }

  const save = $("[data-save]");
  save.disabled = true;
  save.textContent = "Saving…";
  try {
    if (pendingCover) {
      const path = `${slug}/${Date.now()}-${safeFileName(pendingCover.name)}`;
      const { error } = await sb.storage.from("product-images").upload(path, pendingCover, { contentType: pendingCover.type });
      if (error) throw new Error("Cover upload failed: " + error.message);
      row.image_url = sb.storage.from("product-images").getPublicUrl(path).data.publicUrl;
    }
    const { error } = editing
      ? await sb.from("products").update(row).eq("id", editing.id)
      : await sb.from("products").insert({ ...row, slug });
    if (error) throw new Error(error.code === "23505" ? "Another template already uses that web address." : error.message);

    for (const f of pendingFiles) {
      const { error: upErr } = await sb.storage.from("downloads")
        .upload(`${slug}/${safeFileName(f.name)}`, f, { contentType: f.type || "application/octet-stream", upsert: true });
      if (upErr) throw new Error(`Saved, but "${f.name}" didn't upload: ${upErr.message}`);
    }
    closeDrawer(true);
    toast(`"${row.name}" saved${pendingFiles.length ? ` with ${pendingFiles.length} new file${pendingFiles.length === 1 ? "" : "s"}` : ""}.`);
    await loadProducts();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    save.disabled = false;
    save.textContent = "Save template";
  }
});

$("[data-delete-template]").addEventListener("click", async () => {
  const p = editing;
  if (!p || !(await askConfirm({ title: `Delete "${p.name}" permanently?`, message: 'Its files are deleted too. To just hide it, switch "Visible in shop" off instead.', confirmLabel: "Delete template", danger: true }))) return;
  if (DEMO) { state.products = state.products.filter((x) => x.id !== p.id); closeDrawer(true); render("templates"); return toast("Demo: deleted (not really).", "info"); }
  const { error } = await sb.from("products").delete().eq("id", p.id);
  if (error) {
    return toast(error.code === "23503"
      ? `"${p.name}" has orders, so it can't be deleted (buyers still need their downloads). Switch it off to archive it instead.`
      : "Couldn't delete: " + error.message, "error");
  }
  for (const bucket of ["downloads", "product-images"]) {
    const { data } = await sb.storage.from(bucket).list(p.slug, { limit: 1000 });
    const paths = (data || []).filter((f) => f.id).map((f) => `${p.slug}/${f.name}`);
    if (paths.length) await sb.storage.from(bucket).remove(paths);
  }
  closeDrawer(true);
  toast(`"${p.name}" deleted.`);
  loadProducts();
});

// ---------- Submissions ----------
function renderInquiries() {
  const all = state.inquiries;
  setChipCounts("inquiries", {
    new: all.filter((i) => i.status === "new").length,
    contacted: all.filter((i) => i.status === "contacted").length,
    done: all.filter((i) => i.status === "done").length,
    all: all.length,
  });
  const f = state.filters.inquiries;
  const q = state.search.inquiries;
  const list = all.filter((i) => (f === "all" || i.status === f) && matches(`${i.name} ${i.business} ${i.email} ${i.service} ${i.notes}`, q));
  const box = $("[data-inquiries]");
  if (!list.length) {
    box.innerHTML = emptyState(ICON_MAIL,
      all.length ? "Nothing here" : "No submissions yet",
      all.length ? "Try another filter or search." : "Inquiries from the Contact page appear here.");
    return;
  }
  box.innerHTML = list.map((i) => {
    const subject = encodeURIComponent(`Re: your inquiry — The Business FF`);
    const body = encodeURIComponent(`Hi ${i.name.split(" ")[0]},\n\nThank you for reaching out about ${i.service.toLowerCase()}.\n\n`);
    return `
    <article class="adm-inq adm-inq--${i.status}">
      <header class="adm-inq__head">
        <span class="adm-avatar adm-avatar--lg">${esc(i.name.charAt(0).toUpperCase())}</span>
        <div class="adm-inq__who">
          <h3>${esc(i.name)}</h3>
          <p>${esc(i.business)} · <span title="${fmtDate(i.created_at, true)}">${timeAgo(i.created_at)}</span></p>
        </div>
        <div class="adm-seg" role="group" aria-label="Status">
          ${["new", "contacted", "done"].map((s) => `<button type="button" data-set-status="${s}" data-id="${i.id}" aria-pressed="${i.status === s}">${s[0].toUpperCase() + s.slice(1)}</button>`).join("")}
        </div>
      </header>
      <dl class="adm-inq__facts">
        <div><dt>Service</dt><dd>${esc(i.service)}</dd></div>
        <div><dt>Preferred time</dt><dd>${i.preferred_at ? fmtDate(i.preferred_at, true) : "Not given"}</dd></div>
        <div><dt>Email</dt><dd><a href="mailto:${esc(i.email)}">${esc(i.email)}</a></dd></div>
        <div><dt>Phone</dt><dd><a href="tel:${esc(i.phone.replace(/[^\d+]/g, ""))}">${esc(i.phone)}</a></dd></div>
      </dl>
      ${i.notes ? `<p class="adm-inq__notes">${esc(i.notes)}</p>` : ""}
      <footer class="adm-inq__actions">
        <a class="btn btn--dark adm-btn-sm" href="mailto:${esc(i.email)}?subject=${subject}&body=${body}" data-replied="${i.id}">Reply by email</a>
        <a class="btn btn--outline adm-btn-sm" href="tel:${esc(i.phone.replace(/[^\d+]/g, ""))}">Call</a>
        <span class="adm-spacer"></span>
        <button type="button" class="adm-textbtn adm-textbtn--danger" data-delete-inquiry="${i.id}">Delete</button>
      </footer>
    </article>`;
  }).join("");
}

async function setInquiryStatus(id, status, quiet) {
  const i = state.inquiries.find((x) => x.id === id);
  if (!i || i.status === status) return;
  if (!DEMO) {
    const { error } = await sb.from("inquiries").update({ status }).eq("id", id);
    if (error) return toast("Couldn't update: " + error.message, "error");
  }
  i.status = status;
  render("inquiries");
  if (!quiet) toast(`${i.name} marked as ${status}.`);
}

$("[data-inquiries]").addEventListener("click", async (e) => {
  const s = e.target.closest("[data-set-status]");
  if (s) return setInquiryStatus(s.dataset.id, s.dataset.setStatus);
  const replied = e.target.closest("[data-replied]");
  if (replied) {
    // Opening a reply moves a new inquiry to "contacted"
    const i = state.inquiries.find((x) => x.id === replied.dataset.replied);
    if (i && i.status === "new") setTimeout(() => setInquiryStatus(i.id, "contacted", true), 300);
    return;
  }
  const del = e.target.closest("[data-delete-inquiry]");
  if (!del || !(await askConfirm({ title: "Delete this submission?", message: "It will be removed permanently. This can't be undone.", confirmLabel: "Delete", danger: true }))) return;
  if (!DEMO) {
    const { error } = await sb.from("inquiries").delete().eq("id", del.dataset.deleteInquiry);
    if (error) return toast("Couldn't delete: " + error.message, "error");
  }
  state.inquiries = state.inquiries.filter((x) => x.id !== del.dataset.deleteInquiry);
  render("inquiries");
  toast("Submission deleted.");
});

// ---------- Orders ----------
const statusPill = (s) => {
  const cls = s === "paid" ? "ok" : s === "pending" ? "warn" : "muted";
  return `<span class="adm-pill adm-pill--${cls}">${esc(s[0].toUpperCase() + s.slice(1))}</span>`;
};

const ICON_TRASH = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/></svg>`;

// withDelete: the Orders view shows a delete button on each row (the overview's "Latest orders" doesn't)
function ordersTable(list, withDelete) {
  return `
    <div class="adm-otable${withDelete ? " adm-otable--actions" : ""}">
      <div class="adm-orow adm-orow--head" aria-hidden="true"><span>Date</span><span>Customer</span><span>Templates</span><span>Total</span><span>Status</span>${withDelete ? "<span></span>" : ""}</div>
      ${list.map((o) => `
        <div class="adm-orow">
          <span data-label="Date" title="${fmtDate(o.paid_at || o.created_at, true)}">${fmtDate(o.paid_at || o.created_at)}</span>
          <span data-label="Customer"><a href="mailto:${esc(o.email)}">${esc(o.email)}</a></span>
          <span data-label="Templates">${o.order_items.map((i) => esc(i.name)).join("<br />")}</span>
          <span data-label="Total" class="adm-strong">${o.total_cents === 0 ? "Free" : money(o.total_cents)}</span>
          <span data-label="Status">${statusPill(o.status)}</span>
          ${withDelete ? `<span data-label="Delete"><button type="button" class="adm-iconbtn adm-iconbtn--danger" data-delete-order="${o.id}" aria-label="Delete order from ${esc(o.email)}" title="Delete order">${ICON_TRASH}</button></span>` : ""}
        </div>`).join("")}
    </div>`;
}

function renderOrders() {
  const all = state.orders;
  setChipCounts("orders", {
    paid: all.filter((o) => o.status === "paid").length,
    pending: all.filter((o) => o.status === "pending").length,
    other: all.filter((o) => o.status === "failed" || o.status === "refunded").length,
    all: all.length,
  });
  const f = state.filters.orders;
  const q = state.search.orders;
  const list = all.filter((o) =>
    (f === "all" || o.status === f || (f === "other" && (o.status === "failed" || o.status === "refunded"))) &&
    matches(`${o.email} ${o.order_items.map((i) => i.name).join(" ")}`, q));
  $("[data-orders]").innerHTML = list.length ? ordersTable(list, true) :
    emptyState(ICON_BAG, all.length ? "Nothing here" : "No orders yet",
      all.length ? "Try another filter or search." : "Orders appear here as soon as someone checks out.");
}

$("[data-orders]").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-delete-order]");
  if (!btn) return;
  const o = state.orders.find((x) => x.id === btn.dataset.deleteOrder);
  if (!o) return;
  const message = o.status === "paid"
    ? `${o.email} will lose access to their download page for this order. This can't be undone. It doesn't refund the payment in PayPal.`
    : "The order record will be removed permanently. This can't be undone.";
  if (!(await askConfirm({ title: `Delete this ${o.status} order?`, message, confirmLabel: "Delete order", danger: true }))) return;
  if (!DEMO) {
    btn.disabled = true;
    const { data, error } = await sb.from("orders").delete().eq("id", o.id).select("id");
    if (error || !data.length) {
      btn.disabled = false;
      return toast("Couldn't delete the order" + (error ? ": " + error.message : "."), "error");
    }
  }
  state.orders = state.orders.filter((x) => x.id !== o.id);
  render("orders");
  toast("Order deleted.");
});

// ---------- Demo data (local preview only) ----------
function loadDemo() {
  const img = (id) => `https://pe56d.s3.amazonaws.com/${id}.png`;
  const now = Date.now();
  const ago = (h) => new Date(now - h * 3600e3).toISOString();
  state.products = [
    { id: "d1", slug: "freebie-daily-planner", name: "FREEBIE Daily Planner", summary: "Free template", description: "A simple daily planner.", includes: ["Daily schedule", "To-do list"], price_cents: 0, compare_at_cents: null, image_url: img("o_1k2i3hbqndtu4e11o30khd12t015"), categories: ["planners"], sort_order: 10, active: true, created_at: ago(400) },
    { id: "d2", slug: "ultimate-office-admin-essentials-bundle", name: "Ultimate Office Admin Essentials BUNDLE!", summary: "16 ready-to-use templates", description: "", includes: ["Employee Information Form"], price_cents: 749, compare_at_cents: 999, image_url: img("o_1k503o4f3kcb1fbahd5pkp1mlc15"), categories: ["office"], sort_order: 20, active: true, created_at: ago(390) },
    { id: "d3", slug: "finance-business-tracker-bundle", name: "Finance & Business Tracker BUNDLE!", summary: "5 ready-to-use templates", description: "", includes: ["Invoice Tracker"], price_cents: 524, compare_at_cents: 699, image_url: img("o_1k2fq53k41vsajc46i11hk3kl15"), categories: ["cleaning", "salon", "finance"], sort_order: 30, active: true, created_at: ago(380) },
    { id: "d4", slug: "real-estate-agent-bundle", name: "Real Estate Agent BUNDLE!", summary: "5 ready-to-use templates", description: "", includes: ["Client Tracker"], price_cents: 524, compare_at_cents: 699, image_url: img("o_1k2deh2i575v13l5c6q6u1lpa1u"), categories: ["real-estate"], sort_order: 50, active: false, created_at: ago(370) },
  ];
  state.fileCounts = { "freebie-daily-planner": 1, "ultimate-office-admin-essentials-bundle": 3 };
  state.inquiries = [
    { id: "i1", name: "Aisha Rahman", business: "Rahman Trading LLC", email: "aisha@example.com", phone: "+971 50 123 4567", service: "Admin Support", preferred_at: ago(-30), notes: "We need help with invoices and follow-ups, about 10 hours a week.", status: "new", created_at: ago(2) },
    { id: "i2", name: "Daniel Cruz", business: "Cruz Cleaning Co.", email: "daniel@example.com", phone: "+971 55 222 0000", service: "Document Preparation", preferred_at: null, notes: "", status: "contacted", created_at: ago(30) },
  ];
  state.orders = [
    { id: "o1", email: "maria@example.com", status: "paid", total_cents: 749, created_at: ago(5), paid_at: ago(5), order_items: [{ name: "Ultimate Office Admin Essentials BUNDLE!" }] },
    { id: "o2", email: "li@example.com", status: "paid", total_cents: 0, created_at: ago(20), paid_at: ago(20), order_items: [{ name: "FREEBIE Daily Planner" }] },
    { id: "o3", email: "sam@example.com", status: "pending", total_cents: 524, created_at: ago(26), paid_at: null, order_items: [{ name: "Finance & Business Tracker BUNDLE!" }] },
  ];
  ["templates", "inquiries", "orders"].forEach(render);
}

start();
})();
