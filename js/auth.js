// Supabase auth, shared by every page. Needs the supabase-js script loaded first.
// The URL and publishable key are public by design: what users can do is enforced by Supabase.
(() => {
const SUPABASE_URL = "https://kjzrbqijoorighnwiygz.supabase.co";
const SUPABASE_KEY = "sb_publishable_I8pDAo61z7O8R_V3Tlnbsg_xSxBbbRI";

// Email links (confirm sign-up, reset password) can land on any page. Errors (e.g. an expired link)
// and password resets need the account page, so hand those over before Supabase reads the link.
const linkHash = new URLSearchParams(location.hash.slice(1));
const onAccountPage = /^\/account(\.html)?$/.test(location.pathname);
if (!onAccountPage && (linkHash.get("error_description") || linkHash.get("type") === "recovery")) {
  location.replace("/account" + location.search + location.hash);
  return;
}

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
window.bffAuth = sb;

// Separate signed-out connection for public data (the product catalogue). It never waits on a
// sign-in renewal, so an expired or stuck session can't stop the shop from loading.
window.bffPublic = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: "bff-public" },
});

function displayName(user) {
  return (user.user_metadata && user.user_metadata.full_name) || user.email.split("@")[0];
}

// Header user icon: links to the account page; shows the person's initial when signed in.
function renderAccountIcon(user) {
  document.querySelectorAll("[data-account]").forEach((a) => {
    a.classList.toggle("is-signed-in", !!user);
    const avatar = a.querySelector(".avatar");
    if (user) {
      const name = displayName(user);
      a.setAttribute("aria-label", "Your account (" + user.email + ")");
      a.title = "Signed in as " + name;
      if (avatar) avatar.textContent = name.charAt(0).toUpperCase();
    } else {
      a.setAttribute("aria-label", "Sign in");
      a.title = "Sign in";
    }
  });
}

sb.auth.getSession().then(({ data }) => renderAccountIcon(data.session && data.session.user));
sb.auth.onAuthStateChange((_event, session) => renderAccountIcon(session && session.user));
})();
