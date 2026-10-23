// Account page: sign in, create account, reset password, and the signed-in view.
(() => {
const sb = window.bffAuth;
const views = document.querySelectorAll("[data-view]");
const tabs = document.querySelector(".auth-tabs");
const authTabs = document.querySelectorAll(".auth-tab");
const pageUrl = window.location.origin + window.location.pathname;
// Read the email-link details now, before Supabase clears them from the address bar
const hash = new URLSearchParams(window.location.hash.slice(1));
let recovering = hash.get("type") === "recovery";

// Where to go after signing in or confirming a new account: ?next=/cart, otherwise the homepage.
// Only same-site paths are allowed, so the link can't be used to send people elsewhere.
function nextPath() {
  const next = new URLSearchParams(location.search).get("next") || "";
  return /^\/(?!\/)/.test(next) ? next : "/";
}

function show(name) {
  views.forEach((v) => (v.hidden = v.dataset.view !== name));
  tabs.hidden = !(name === "signin" || name === "signup");
  authTabs.forEach((t) => t.setAttribute("aria-selected", String(t.dataset.target === name)));
  views.forEach((v) => {
    const status = v.querySelector(".form-status");
    if (status) { status.textContent = ""; status.classList.remove("is-error"); }
  });
}

function setStatus(form, msg, isError) {
  const el = form.querySelector(".form-status");
  el.textContent = msg;
  el.classList.toggle("is-error", !!isError);
}

function busy(form, on) {
  const btn = form.querySelector("button[type=submit]");
  btn.disabled = on;
  btn.dataset.label = btn.dataset.label || btn.textContent;
  btn.textContent = on ? "Please wait…" : btn.dataset.label;
}

function friendly(error) {
  const m = (error && error.message) || "Something went wrong. Please try again.";
  if (/invalid login credentials/i.test(m)) return "That email and password don't match. Please try again.";
  if (/email not confirmed/i.test(m)) return "Please confirm your email first — check your inbox for the link we sent.";
  if (/already registered/i.test(m)) return "An account with this email already exists. Try signing in instead.";
  if (/session missing|invalid jwt|token.*expired/i.test(m)) return "This link is no longer valid. Please request a new password reset link.";
  if (/same.*password|different from the old/i.test(m)) return "Please choose a password you haven't used before.";
  if (/rate limit/i.test(m)) return "Too many attempts right now. Please wait a few minutes and try again.";
  return m;
}

function renderSignedIn(user) {
  const name = (user.user_metadata && user.user_metadata.full_name) || user.email.split("@")[0];
  document.querySelector("[data-user-name]").textContent = name;
  document.querySelector("[data-user-email]").textContent = user.email;
  document.querySelector("[data-user-since]").textContent = new Date(user.created_at).toLocaleDateString(undefined, {
    year: "numeric", month: "long", day: "numeric",
  });
  show("account");
  loadPurchases();
  sb.rpc("is_admin").then(({ data }) => {
    const link = document.querySelector("[data-admin-link]");
    if (link) link.hidden = !data;
  });
}

// Paid orders for this account (matched by user id or email; enforced by row level security)
async function loadPurchases() {
  const box = document.querySelector("[data-purchases]");
  const { esc, money } = window.bffShop;
  const { data, error } = await sb
    .from("orders")
    .select("id, access_token, total_cents, paid_at, created_at, order_items(name)")
    .order("created_at", { ascending: false });
  const heading = "<h3>My purchases</h3>";
  if (error) {
    box.innerHTML = heading + `<p class="purchases__empty">Your purchases couldn't load. Please refresh.</p>`;
    return;
  }
  if (!data.length) {
    box.innerHTML = heading + `<p class="purchases__empty">No purchases yet. <a href="/shop" class="link-arrow">Browse templates →</a></p>`;
    return;
  }
  box.innerHTML = heading + data.map((o) => {
    const date = new Date(o.paid_at || o.created_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    const names = o.order_items.map((i) => esc(i.name)).join(", ");
    return `
      <div class="purchase">
        <div>${names}<span>${date} · ${o.total_cents === 0 ? "Free" : money(o.total_cents)}</span></div>
        <a href="/order?id=${o.id}&token=${o.access_token}">Download</a>
      </div>`;
  }).join("");
}

// "Email not confirmed": let the person ask for a fresh confirmation link
function offerResend(form, email) {
  const status = form.querySelector(".form-status");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "link-arrow auth-resend";
  btn.textContent = "Resend the confirmation email";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const { error } = await sb.auth.resend({ type: "signup", email, options: { emailRedirectTo: location.origin + nextPath() } });
    setStatus(form, error ? friendly(error) : "A new confirmation link is on its way to " + email + ".", !!error);
  });
  status.append(" ", btn);
}

authTabs.forEach((t) => t.addEventListener("click", () => show(t.dataset.target)));
document.querySelectorAll("[data-goto]").forEach((a) =>
  a.addEventListener("click", (e) => { e.preventDefault(); show(a.dataset.goto); })
);

// Sign in
document.querySelector("#signin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  if (!f.reportValidity()) return;
  busy(f, true);
  const email = f.email.value.trim();
  const { error } = await sb.auth.signInWithPassword({ email, password: f.password.value });
  if (error) {
    busy(f, false);
    setStatus(f, friendly(error), true);
    if (/email not confirmed/i.test(error.message)) offerResend(f, email);
    return;
  }
  location.href = nextPath();
});

// Create account
document.querySelector("#signup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  if (!f.reportValidity()) return;
  busy(f, true);
  const { data, error } = await sb.auth.signUp({
    email: f.email.value.trim(),
    password: f.password.value,
    options: { data: { full_name: f.full_name.value.trim() }, emailRedirectTo: location.origin + nextPath() },
  });
  busy(f, false);
  if (error) return setStatus(f, friendly(error), true);
  // Supabase doesn't reveal existing emails as an error: it returns a user with no identities instead
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    return setStatus(f, "An account with this email already exists. Try signing in instead.", true);
  }
  if (!data.session) {
    setStatus(f, "Almost there! We've sent a confirmation link to " + f.email.value.trim() + ". Click it to activate your account.");
    f.reset();
  } else {
    location.href = nextPath();
  }
});

// Forgot password
document.querySelector("#forgot-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  if (!f.reportValidity()) return;
  busy(f, true);
  const { error } = await sb.auth.resetPasswordForEmail(f.email.value.trim(), { redirectTo: pageUrl });
  busy(f, false);
  if (error) return setStatus(f, friendly(error), true);
  setStatus(f, "If an account exists for that email, a reset link is on its way.");
});

// Set a new password (after following the reset link)
document.querySelector("#reset-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  if (!f.reportValidity()) return;
  if (f.password.value !== f.confirm.value) return setStatus(f, "The passwords don't match.", true);
  busy(f, true);
  const { data, error } = await sb.auth.updateUser({ password: f.password.value });
  busy(f, false);
  if (error) return setStatus(f, friendly(error), true);
  recovering = false;
  renderSignedIn(data.user);
});

// Sign out
document.querySelector("#signout").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = "Signing out…";
  // "local" signs out this browser even when the network call to Supabase fails
  await sb.auth.signOut({ scope: "local" });
  btn.disabled = false;
  btn.textContent = "Sign out";
  show("signin");
});

sb.auth.onAuthStateChange((event, session) => {
  if (event === "PASSWORD_RECOVERY") {
    recovering = true;
    return show("reset");
  }
  if (recovering || event === "INITIAL_SESSION") return; // first view is chosen below
  if (session) renderSignedIn(session.user);
  else if (!document.querySelector('[data-view="forgot"]:not([hidden])')) show("signin");
});

// Show the right view straight away, and surface errors from email links (e.g. an expired link).
const wantsSignup = window.location.hash === "#signup";
if (hash.get("error_description")) {
  show("signin");
  const msg = hash.get("error_code") === "otp_expired"
    ? "That email link has expired or was already used. Please sign in, or request a new link."
    : hash.get("error_description").replace(/\+/g, " ");
  setStatus(document.querySelector("#signin-form"), msg, true);
  history.replaceState(null, "", pageUrl + location.search);
} else {
  if (recovering) show("reset");
  // Don't leave people on "Loading…" if Supabase is slow to answer (e.g. a stuck sign-in renewal)
  const fallback = setTimeout(() => {
    if (!recovering && !document.querySelector('[data-view="loading"]').hidden) show(wantsSignup ? "signup" : "signin");
  }, 6000);
  sb.auth.getSession().then(({ data }) => {
    clearTimeout(fallback);
    if (recovering) return;
    if (data.session) renderSignedIn(data.session.user);
    else show(wantsSignup ? "signup" : "signin");
  });
}
})();
