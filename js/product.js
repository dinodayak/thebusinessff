// Product page: /product?p=<slug>
(() => {
const { cart, loadProducts, money, priceHtml, esc } = window.bffShop;
const root = document.querySelector("[data-product]");
const slug = new URLSearchParams(location.search).get("p");

function render(p) {
  document.title = `${p.name} | The Business FF`;
  const free = p.price_cents === 0;
  root.innerHTML = `
    <div class="pdp__media">
      <img src="${esc(p.image_url)}" alt="${esc(p.name)} cover" />
    </div>
    <div class="pdp__info">
      <p class="eyebrow"><a href="/shop">Template shop</a> / ${esc(p.summary)}</p>
      <h1>${esc(p.name)}</h1>
      <p class="pdp__price">${free ? "Free download" : priceHtml(p)}</p>
      <div class="pdp__actions">
        <button type="button" class="btn btn--dark btn--block" data-add></button>
        <a href="/cart" class="btn btn--outline btn--block" data-buy>${free ? "Get it now" : "Buy now"}</a>
      </div>
      <p class="pdp__description">${esc(p.description)}</p>
      ${p.includes.length ? `
        <h2>What's included</h2>
        <ul class="checklist">
          ${p.includes.map((i) => `<li><svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>${esc(i)}</li>`).join("")}
        </ul>` : ""}
      <p class="pdp__note">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0-4-4m4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
        Instant digital download after checkout — no physical product will be shipped.
      </p>
    </div>`;

  const addBtn = root.querySelector("[data-add]");
  const sync = () => {
    const inCart = cart.has(p.id);
    addBtn.textContent = inCart ? "In your cart ✓ — view cart" : "Add to cart";
    addBtn.classList.toggle("is-added", inCart);
  };
  addBtn.addEventListener("click", () => {
    if (cart.has(p.id)) location.href = "/cart";
    else cart.add(p.id);
  });
  root.querySelector("[data-buy]").addEventListener("click", () => cart.add(p.id));
  document.addEventListener("cart:change", sync);
  sync();
}

loadProducts()
  .then((products) => {
    const p = products.find((x) => x.slug === slug);
    if (p) render(p);
    else root.innerHTML = `<div class="pdp__missing"><h1>Template not found</h1><p>It may have been removed.</p><a href="/shop" class="btn btn--dark">Back to the shop</a></div>`;
  })
  .catch(() => {
    root.innerHTML = `<div class="pdp__missing"><h1>Something went wrong</h1><p>Please refresh the page.</p></div>`;
  });
})();
