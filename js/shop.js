// Shop: products from Supabase, the browser-stored cart, and product grids.
// Loaded after auth.js on every page. Exposes window.bffShop for the page scripts.
(() => {
const sb = window.bffAuth;
const CART_KEY = "bff_cart";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function money(cents) {
  return cents === 0 ? "Free" : "$" + (cents / 100).toFixed(2);
}

// ---------- Cart (product ids in localStorage; prices are always re-checked on the server) ----------
function readCart() {
  try {
    const ids = JSON.parse(localStorage.getItem(CART_KEY) || "[]");
    return Array.isArray(ids) ? ids.filter((i) => typeof i === "string") : [];
  } catch {
    return [];
  }
}

function writeCart(ids) {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify([...new Set(ids)]));
  } catch {
    /* storage blocked: cart lasts for this page only */
  }
  renderCartCount();
  document.dispatchEvent(new CustomEvent("cart:change"));
}

const cart = {
  items: readCart,
  has: (id) => readCart().includes(id),
  add: (id) => writeCart([...readCart(), id]),
  remove: (id) => writeCart(readCart().filter((i) => i !== id)),
  set: (ids) => writeCart(ids),
  clear: () => writeCart([]),
};

function renderCartCount() {
  const n = readCart().length;
  document.querySelectorAll("[data-cart-count]").forEach((el) => {
    el.textContent = n;
    const link = el.closest("a");
    if (link) link.setAttribute("aria-label", `Cart, ${n} item${n === 1 ? "" : "s"}`);
  });
}

window.addEventListener("storage", (e) => e.key === CART_KEY && renderCartCount());
renderCartCount();

// ---------- Products ----------
// Products are public, so they load through the signed-out connection (see auth.js) and retry
// a couple of times on a flaky network before giving up.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchProducts() {
  const db = window.bffPublic || sb;
  let lastError;
  for (const delay of [0, 800, 2000]) {
    if (delay) await wait(delay);
    const { data, error } = await db
      .from("products")
      .select("id, slug, name, summary, description, includes, price_cents, compare_at_cents, image_url, template_count, categories")
      .order("sort_order");
    if (!error) return data;
    lastError = error;
  }
  console.error("Products failed to load:", lastError);
  throw lastError;
}

let productsPromise;
function loadProducts() {
  productsPromise ??= fetchProducts().catch((err) => {
    productsPromise = null; // let the next call try again
    throw err;
  });
  return productsPromise;
}

function priceHtml(p) {
  return p.compare_at_cents
    ? `<s>${money(p.compare_at_cents)}</s>${money(p.price_cents)}`
    : money(p.price_cents);
}

function cartButtonLabel(p) {
  if (cart.has(p.id)) return "In cart ✓ — view";
  return p.price_cents === 0 ? "Get it free" : "Add to cart";
}

function productCard(p) {
  const tag = p.price_cents === 0 ? "Free" : p.compare_at_cents ? "On Sale" : "";
  const url = `/product?p=${encodeURIComponent(p.slug)}`;
  const inCart = cart.has(p.id);
  return `
    <article class="product" data-cat="${esc(["all", ...p.categories].join(" "))}">
      <a href="${url}" class="product__cover">
        <img src="${esc(p.image_url)}" alt="${esc(p.name)} cover" loading="lazy" />
        ${tag ? `<span class="product__tag">${tag}</span>` : ""}
      </a>
      <div class="product__body">
        ${p.summary ? `<p class="product__summary">${esc(p.summary)}</p>` : ""}
        <h3><a href="${url}">${esc(p.name)}</a></h3>
        <p class="product__price">${priceHtml(p)}</p>
        <div class="product__actions">
          <button type="button" class="btn btn--dark product__add${inCart ? " is-added" : ""}" data-add-to-cart="${p.id}">${cartButtonLabel(p)}</button>
          <a href="${url}" class="product__details">Details</a>
        </div>
      </div>
    </article>`;
}

// Card buttons: add to cart, or go to the cart when it's already there
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-add-to-cart]");
  if (!btn) return;
  const id = btn.dataset.addToCart;
  if (cart.has(id)) {
    location.href = "/cart";
    return;
  }
  cart.add(id);
});
document.addEventListener("cart:change", () => {
  document.querySelectorAll("[data-add-to-cart]").forEach((btn) => {
    const inCart = cart.has(btn.dataset.addToCart);
    btn.classList.toggle("is-added", inCart);
    const isFree = btn.closest(".product").querySelector(".product__tag")?.textContent === "Free";
    btn.textContent = inCart ? "In cart ✓ — view" : isFree ? "Get it free" : "Add to cart";
  });
});

// Any element with [data-products] becomes a product grid (optional data-limit).
// Tabs with [data-filter] inside the same section filter it.
async function renderGrids() {
  const grids = document.querySelectorAll("[data-products]");
  if (!grids.length) return;
  let products;
  try {
    products = await loadProducts();
  } catch {
    grids.forEach((g) => {
      g.innerHTML = `<div class="shop-note">
          <p>Templates couldn't load right now. Please check your internet connection.</p>
          <button type="button" class="btn btn--dark" data-retry>Try again</button>
        </div>`;
      g.querySelector("[data-retry]").addEventListener("click", () => {
        grids.forEach((x) => (x.innerHTML = `<p class="shop-note">Loading templates…</p>`));
        renderGrids();
      });
    });
    return;
  }
  // Everything a search can match: name, summary, description and the "What's included" list
  const haystack = new Map(products.map((p) => [
    p.id,
    [p.name, p.summary, p.description, ...p.includes, ...p.categories].join(" ").toLowerCase(),
  ]));

  grids.forEach((grid) => {
    const limit = Number(grid.dataset.limit) || Infinity;
    const section = grid.closest("section") || document;
    const search = section.querySelector("[data-shop-search]");
    const results = section.querySelector("[data-shop-results]");
    const tabs = section.querySelectorAll(".tab[data-filter]");
    let filter = "all";

    const draw = () => {
      const words = search ? search.value.toLowerCase().split(/\s+/).filter(Boolean) : [];
      const list = products
        .filter((p) => filter === "all" || p.categories.includes(filter))
        .filter((p) => words.every((w) => haystack.get(p.id).includes(w)))
        .slice(0, limit);
      grid.innerHTML = list.length
        ? list.map(productCard).join("")
        : words.length
          ? `<p class="shop-note">No templates match “${esc(search.value.trim())}”. Try another word, or <a href="/contact" class="link-arrow">ask us for a custom template</a>.</p>`
          : `<p class="shop-note">No templates in this category yet.</p>`;
      if (results) {
        results.textContent = words.length
          ? `${list.length} template${list.length === 1 ? "" : "s"} found for “${search.value.trim()}”`
          : "";
      }
    };

    tabs.forEach((tab) =>
      tab.addEventListener("click", () => {
        tabs.forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
        filter = tab.dataset.filter;
        draw();
      })
    );
    if (search) {
      // /shop?q=planner pre-fills the search; /shop#search focuses it
      const q = new URLSearchParams(location.search).get("q");
      if (q) search.value = q;
      if (q || location.hash === "#search") search.focus();
      search.addEventListener("input", draw);
    }
    draw();
  });
}
renderGrids();

// Call an edge function and surface its JSON error message on failure
// The signed-in user's token (if any), without waiting more than 2.5s on a stuck sign-in renewal
async function authHeader() {
  try {
    const res = await Promise.race([sb.auth.getSession(), wait(2500).then(() => null)]);
    const token = res && res.data && res.data.session && res.data.session.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

async function callFunction(name, body) {
  const client = window.bffPublic || sb;
  const { data, error } = await client.functions.invoke(name, { body, headers: await authHeader() });
  if (error) {
    let message = "Something went wrong. Please try again.";
    let payload = null;
    try {
      payload = await error.context.json();
      if (payload && payload.error) message = payload.error;
    } catch {
      /* network error: keep the generic message */
    }
    const err = new Error(message);
    err.payload = payload;
    throw err;
  }
  return data;
}

window.bffShop = { cart, loadProducts, money, priceHtml, esc, callFunction };
})();
