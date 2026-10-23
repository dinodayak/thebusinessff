// Cart page: list items, collect an email, then either complete a free order
// or pay with the PayPal / debit-or-credit-card buttons.
(() => {
const sb = window.bffAuth;
const { cart, loadProducts, money, esc, callFunction } = window.bffShop;
const list = document.querySelector("[data-cart-items]");
const summary = document.querySelector("[data-cart-summary]");
const form = document.querySelector("#checkout-form");
const emailInput = form.querySelector("#checkout-email");
const status = form.querySelector(".form-status");
const freeBtn = form.querySelector("[data-free-btn]");
const payBox = form.querySelector("[data-paypal-buttons]");
let products = [];
let paypalRendered = false;

function setStatus(message, isError) {
  status.textContent = message || "";
  status.classList.toggle("is-error", !!isError);
}

function render() {
  const ids = cart.items();
  const items = products.filter((p) => ids.includes(p.id));
  // Drop ids for products that no longer exist
  if (products.length && items.length !== ids.length) return cart.set(items.map((p) => p.id)); // re-renders

  if (!items.length) {
    list.innerHTML = `
      <div class="cart-empty">
        <p>Your cart is empty.</p>
        <a href="/shop" class="btn btn--dark">Browse templates</a>
      </div>`;
    summary.hidden = true;
    return;
  }
  summary.hidden = false;
  list.innerHTML = items.map((p) => `
    <div class="cart-item">
      <a href="/product?p=${encodeURIComponent(p.slug)}" class="cart-item__img"><img src="${esc(p.image_url)}" alt="" /></a>
      <div class="cart-item__info">
        <a href="/product?p=${encodeURIComponent(p.slug)}" class="cart-item__name">${esc(p.name)}</a>
        <span class="cart-item__meta">${esc(p.summary)} · Digital download</span>
        <button type="button" class="cart-item__remove" data-remove="${p.id}">Remove</button>
      </div>
      <div class="cart-item__price">${p.compare_at_cents ? `<s>${money(p.compare_at_cents)}</s>` : ""}${money(p.price_cents)}</div>
    </div>`).join("");

  const total = items.reduce((s, p) => s + p.price_cents, 0);
  const saved = items.reduce((s, p) => s + (p.compare_at_cents ? p.compare_at_cents - p.price_cents : 0), 0);
  summary.querySelector("[data-subtotal]").textContent = money(total);
  summary.querySelector("[data-savings-row]").hidden = saved === 0;
  summary.querySelector("[data-savings]").textContent = "−$" + (saved / 100).toFixed(2);
  summary.querySelector("[data-total]").textContent = "$" + (total / 100).toFixed(2);

  const free = total === 0;
  freeBtn.hidden = !free;
  payBox.hidden = free;
  summary.querySelector("[data-pay-note]").hidden = free;
  if (!free) setupPayPal();
}

list.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-remove]");
  if (btn) cart.remove(btn.dataset.remove);
});
document.addEventListener("cart:change", render);

// Signed-in buyers check out with their account email
sb.auth.getSession().then(({ data }) => {
  const user = data.session && data.session.user;
  if (user) {
    emailInput.value = user.email;
    emailInput.readOnly = true;
    form.querySelector("[data-email-hint]").textContent = "Signed in — this order will appear under My purchases.";
  }
});

// Free orders: no payment step
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (freeBtn.hidden || !emailInput.reportValidity()) return;
  setStatus("");
  freeBtn.disabled = true;
  freeBtn.textContent = "Please wait…";
  try {
    const { url } = await callFunction("checkout", { items: cart.items(), email: emailInput.value.trim() });
    location.href = url;
  } catch (err) {
    setStatus(err.message, true);
    freeBtn.disabled = false;
    freeBtn.textContent = "Get my free download";
  }
});

// ---------- PayPal ----------
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("PayPal couldn't load. Check your connection and refresh the page."));
    document.head.appendChild(s);
  });
}

async function setupPayPal() {
  if (paypalRendered) return;
  paypalRendered = true;
  try {
    const config = await callFunction("checkout", { action: "config" });
    if (!config.paypal_client_id) {
      payBox.innerHTML = `<p class="pay-buttons__loading">Card payments aren't switched on yet. Please check back soon.</p>`;
      return;
    }
    await loadScript(
      "https://www.paypal.com/sdk/js?client-id=" + encodeURIComponent(config.paypal_client_id) +
      "&currency=" + config.currency + "&intent=capture&components=buttons&disable-funding=paylater,venmo"
    );
  } catch (err) {
    payBox.innerHTML = `<p class="pay-buttons__loading">${esc(err.message)}</p>`;
    paypalRendered = false;
    return;
  }

  let orderId = null;
  let paypalOrderId = null;
  // The PayPal window was closed or failed: tell the server so the unpaid order doesn't linger
  const retireOrder = (ppId) => {
    const id = ppId || paypalOrderId;
    if (orderId && id) callFunction("paypal-capture", { action: "cancel", order_id: orderId, paypal_order_id: id }).catch(() => {});
  };
  payBox.innerHTML = "";
  window.paypal.Buttons({
    style: { layout: "vertical", color: "gold", shape: "rect", label: "paypal", height: 48 },

    // Make sure we have an email before PayPal opens
    onClick: (_data, actions) => {
      setStatus("");
      if (!emailInput.reportValidity()) return actions.reject();
      return actions.resolve();
    },

    // Our server creates the order using database prices and returns PayPal's order id
    createOrder: async () => {
      try {
        const res = await callFunction("checkout", { items: cart.items(), email: emailInput.value.trim() });
        orderId = res.order_id;
        paypalOrderId = res.paypal_order_id;
        return res.paypal_order_id;
      } catch (err) {
        setStatus(err.message, true);
        throw err;
      }
    },

    // Buyer approved: our server captures the payment and confirms the amount
    onApprove: async (data, actions) => {
      setStatus("Confirming your payment…");
      try {
        const res = await callFunction("paypal-capture", { order_id: orderId, paypal_order_id: data.orderID });
        location.href = res.url;
      } catch (err) {
        setStatus(err.message, true);
        if (err.payload && err.payload.restart) return actions.restart();
      }
    },

    onCancel: (data) => {
      setStatus("Payment cancelled — your cart is still here whenever you're ready.");
      retireOrder(data && data.orderID);
    },
    onError: () => {
      if (!status.textContent) setStatus("Something went wrong with PayPal. Please try again.", true);
      retireOrder();
    },
  }).render(payBox).catch(() => {
    payBox.innerHTML = `<p class="pay-buttons__loading">Payment options couldn't load. Please refresh the page.</p>`;
  });
}

loadProducts()
  .then((p) => { products = p; render(); })
  .catch(() => { list.innerHTML = `<p class="shop-note">Your cart couldn't load. Please refresh the page.</p>`; });
})();
