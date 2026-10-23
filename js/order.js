// Order confirmation + downloads: /order?id=<order id>&token=<access token>
(() => {
const { cart, money, esc, callFunction } = window.bffShop;
const root = document.querySelector("[data-order]");
const params = new URLSearchParams(location.search);
const id = params.get("id");
const token = params.get("token");
let attempts = 0;

function itemHtml(item, index) {
  const many = item.files.length > 1;
  const list = item.files.map((f) => `
      <li><span>${esc(f.name)}</span><a href="${esc(f.url)}" class="link-arrow" download>Download</a></li>`).join("");
  const downloads = !item.files.length
    ? `<p class="order-item__pending">Your files are being added — check back on this page shortly. Need help? <a href="/contact">Contact us</a>.</p>`
    : many
      ? `<button type="button" class="btn btn--dark download-all" data-zip="${index}">Download all ${item.files.length} files (.zip)</button>
         <p class="download-all__status" data-zip-status="${index}" role="status" aria-live="polite"></p>
         <ul class="order-files">${list}</ul>`
      : `<a href="${esc(item.files[0].url)}" class="btn btn--dark download-btn" download>Download ${esc(item.files[0].name)}</a>`;
  return `
    <div class="order-item">
      <img src="${esc(item.image_url)}" alt="" class="order-item__img" />
      <div class="order-item__body">
        <h3>${esc(item.name)}</h3>
        <span class="order-item__price">${money(item.price_cents)}</span>
        <div class="order-item__downloads">${downloads}</div>
      </div>
    </div>`;
}

function render(order) {
  if (order.status === "pending") {
    root.innerHTML = `
      <p class="eyebrow">Order received</p>
      <h1>Confirming your payment…</h1>
      <p class="order-lead">This usually takes a few seconds. Please keep this page open.</p>`;
    if (attempts++ < 15) setTimeout(load, 2000);
    else root.querySelector(".order-lead").textContent = "This is taking longer than usual. Refresh in a minute — your download links will appear here once payment is confirmed.";
    return;
  }
  if (order.status !== "paid") {
    root.innerHTML = `
      <p class="eyebrow">Order ${esc(order.status)}</p>
      <h1>This order isn't active</h1>
      <p class="order-lead">The payment didn't go through or was refunded. You can try again from your cart.</p>
      <a href="/cart" class="btn btn--dark">Back to cart</a>`;
    return;
  }

  cart.clear();
  const date = new Date(order.paid_at || order.created_at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  root.innerHTML = `
    <p class="eyebrow">Order confirmed</p>
    <h1>Thank you! Your templates are ready.</h1>
    <p class="order-lead">Download your files below. <strong>Bookmark this page</strong> to download again anytime, or <a href="/account#signup">create an account</a> with <strong>${esc(order.email)}</strong> to find all your purchases in one place.</p>
    <div class="order-items">${order.items.map((item, i) => itemHtml(item, i)).join("")}</div>
    <dl class="order-meta">
      <div><dt>Order</dt><dd>#${esc(order.id.slice(0, 8).toUpperCase())}</dd></div>
      <div><dt>Date</dt><dd>${date}</dd></div>
      <div><dt>Total</dt><dd>${order.total_cents === 0 ? "Free" : money(order.total_cents)}</dd></div>
    </dl>
    <div class="btn-row">
      <a href="/shop" class="btn btn--outline">Keep shopping</a>
      <a href="/account" class="btn btn--outline">My account</a>
    </div>`;

  root.querySelectorAll("[data-zip]").forEach((btn) =>
    btn.addEventListener("click", () => downloadZip(order.items[Number(btn.dataset.zip)], btn))
  );
}

// "Download all": fetch every file in the browser, bundle them into one .zip and save it
let jszipPromise;
function loadJSZip() {
  jszipPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
    s.onload = () => resolve(window.JSZip);
    s.onerror = () => { jszipPromise = null; reject(new Error("zip tool failed to load")); };
    document.head.appendChild(s);
  });
  return jszipPromise;
}

async function downloadZip(item, btn) {
  const status = root.querySelector(`[data-zip-status="${btn.dataset.zip}"]`);
  const label = btn.textContent;
  btn.disabled = true;
  status.classList.remove("is-error");
  try {
    const JSZip = await loadJSZip();
    const zip = new JSZip();
    let done = 0;
    status.textContent = `Preparing your files… 0 of ${item.files.length}`;
    await Promise.all(item.files.map(async (f) => {
      const res = await fetch(f.url);
      if (!res.ok) throw new Error("download link expired");
      zip.file(f.name, await res.blob());
      status.textContent = `Preparing your files… ${++done} of ${item.files.length}`;
    }));
    const blob = await zip.generateAsync({ type: "blob" }); // PDFs are already compressed: store as-is
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (item.slug || "templates") + ".zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    status.textContent = "Done! Check your downloads folder.";
  } catch (err) {
    status.classList.add("is-error");
    status.textContent = /expired/.test(err.message)
      ? "The download links have expired. Please refresh the page and try again."
      : "The zip couldn't be created. Please refresh and try again, or download the files one by one below.";
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function load() {
  try {
    const { order } = await callFunction("order", { id, token });
    render(order);
  } catch (err) {
    root.innerHTML = `
      <h1>Order not found</h1>
      <p class="order-lead">${esc(err.message)} Check the link in your receipt email, or sign in to see your purchases.</p>
      <a href="/account" class="btn btn--dark">Go to my account</a>`;
  }
}

if (id && token) load();
else root.innerHTML = `<h1>Order not found</h1><p class="order-lead">This link is incomplete.</p><a href="/shop" class="btn btn--dark">Visit the shop</a>`;
})();
