// Where the contact form's messages go
const CONFIG = {
  email: "thebusiness.ff@outlook.com",
};

// Mobile nav toggle
const toggle = document.querySelector(".nav-toggle");
const nav = document.querySelector(".nav");
if (toggle && nav) {
  toggle.addEventListener("click", () => {
    const open = nav.classList.toggle("is-open");
    toggle.setAttribute("aria-expanded", String(open));
  });
  nav.querySelectorAll("a").forEach((a) =>
    a.addEventListener("click", () => {
      nav.classList.remove("is-open");
      toggle.setAttribute("aria-expanded", "false");
    })
  );
}

// Header: slimmer, frosted style once the page is scrolled
const header = document.querySelector(".site-header");
if (header) {
  const onScroll = () => header.classList.toggle("is-scrolled", window.scrollY > 24);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
}

// Footer: click-to-copy email, live Dubai time, back to top
document.querySelectorAll("[data-copy-email]").forEach((btn) => {
  const hint = btn.parentElement.querySelector("[data-copy-hint]");
  btn.addEventListener("click", async () => {
    const email = btn.dataset.copyEmail;
    try {
      await navigator.clipboard.writeText(email);
      if (hint) {
        hint.textContent = "Copied ✓";
        hint.classList.add("is-copied");
        setTimeout(() => { hint.textContent = "Click to copy"; hint.classList.remove("is-copied"); }, 2000);
      }
    } catch {
      location.href = "mailto:" + email; // clipboard blocked: open the email app instead
    }
  });
});

const dubaiTime = document.querySelectorAll("[data-dubai-time]");
if (dubaiTime.length) {
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit" });
  const tick = () => dubaiTime.forEach((el) => (el.textContent = fmt.format(new Date()) + " GST"));
  tick();
  setInterval(tick, 30000);
}

document.querySelectorAll("[data-back-to-top]").forEach((a) =>
  a.addEventListener("click", (e) => {
    e.preventDefault();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  })
);

// Footer wordmark: size the text so it spans exactly the container width
const wordmarks = document.querySelectorAll(".ft__wordmark");
if (wordmarks.length) {
  const fit = () =>
    wordmarks.forEach((el) => {
      el.style.fontSize = "100px";
      const range = document.createRange();
      range.selectNodeContents(el);
      const textWidth = range.getBoundingClientRect().width;
      if (textWidth) el.style.fontSize = (100 * el.clientWidth) / textWidth + "px";
    });
  fit();
  if (document.fonts) document.fonts.ready.then(fit);
  let resizeTimer;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(fit, 100); });
}

// Fade-in on scroll
const revealEls = document.querySelectorAll(".reveal");
if ("IntersectionObserver" in window) {
  const io = new IntersectionObserver(
    (entries) =>
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add("is-visible");
          io.unobserve(e.target);
        }
      }),
    { threshold: 0.12 }
  );
  revealEls.forEach((el) => io.observe(el));
} else {
  revealEls.forEach((el) => el.classList.add("is-visible"));
}

// Inquiry form: validate, then send to the submit-inquiry function (saves it for /admin and emails a notification)
const form = document.querySelector("#inquiry-form");
if (form) {
  const status = form.querySelector(".form-status");
  const button = form.querySelector("button[type=submit]");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    let ok = true;
    form.querySelectorAll("[required]").forEach((input) => {
      const valid = input.value.trim() !== "" && input.checkValidity();
      input.closest(".field").classList.toggle("is-invalid", !valid);
      if (!valid) ok = false;
    });
    status.classList.remove("is-error", "is-success");
    if (!ok) {
      status.textContent = "Please fill in the required fields.";
      status.classList.add("is-error");
      return;
    }

    const d = new FormData(form);
    const when = d.get("datetime") ? new Date(d.get("datetime")) : null;
    const row = {
      name: d.get("name").trim(),
      business: d.get("business").trim(),
      email: d.get("email").trim().toLowerCase(),
      phone: d.get("phone").trim(),
      preferred_at: when && !isNaN(when) ? when.toISOString() : null,
      service: d.get("service"),
      notes: (d.get("notes") || "").trim(),
    };

    button.disabled = true;
    const label = button.textContent;
    button.textContent = "Sending…";
    let error = null;
    try {
      // Saved + emailed by the submit-inquiry function; "website" is the hidden spam trap
      await window.bffShop.callFunction("submit-inquiry", { ...row, website: d.get("website") || "" });
    } catch (err) {
      error = err;
    }
    button.disabled = false;
    button.textContent = label;

    if (error) {
      console.error("Inquiry failed:", error);
      const msg = error.message && !/something went wrong/i.test(error.message) ? error.message + " " : "Sorry, your inquiry couldn't be sent. ";
      status.innerHTML = `${msg}You can also email us at <a href="mailto:${CONFIG.email}">${CONFIG.email}</a>.`;
      status.classList.add("is-error");
      return;
    }
    status.textContent = "Thank you! Your inquiry has been sent — we usually reply within one business day.";
    status.classList.add("is-success");
    form.reset();
  });
}
