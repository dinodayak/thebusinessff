// Contact / booking form: validates the submission, saves it (shown in /admin → Submissions)
// and emails a notification through Resend when RESEND_API_KEY is set.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "https://thebusinessff.com,https://www.thebusinessff.com,https://the-business-ff.vercel.app,http://localhost:5500,http://127.0.0.1:5500")
  .split(",").map((o) => o.trim()).filter(Boolean);
const NOTIFY_EMAIL = Deno.env.get("NOTIFY_EMAIL") ?? "thebusiness.ff@outlook.com";
// thebusinessff.com is verified in Resend, so mail can go to anyone (customers included)
const FROM_EMAIL = Deno.env.get("NOTIFY_FROM") ?? "The Business FF <hello@thebusinessff.com>";
const SITE_URL = "https://thebusinessff.com";
const SERVICES = ["Document Preparation", "Admin Support", "Data & Inventory Management", "A mix of services", "Not sure yet"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cors(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function emailHtml(i: Record<string, string>, when: string) {
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 16px 6px 0;color:#4d4d4d;vertical-align:top;white-space:nowrap">${label}</td><td style="padding:6px 0;color:#000">${value}</td></tr>`;
  return `
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;max-width:560px">
    <div style="background:#f1cacd;padding:18px 22px"><strong style="font-size:18px">New Form Submission</strong></div>
    <div style="padding:20px 22px;border:1px solid #e2b9bd;border-top:0">
      <table style="border-collapse:collapse">
        ${row("Name", esc(i.name))}
        ${row("Business", esc(i.business))}
        ${row("Email", `<a href="mailto:${esc(i.email)}">${esc(i.email)}</a>`)}
        ${row("Phone", esc(i.phone))}
        ${row("Service", esc(i.service))}
        ${row("Preferred time", esc(when))}
      </table>
      ${i.notes ? `<p style="margin:16px 0 0;padding:12px 14px;background:#fcf1f2;white-space:pre-wrap">${esc(i.notes)}</p>` : ""}
      <p style="margin:20px 0 0;color:#4d4d4d;font-size:13px">Reply to this email to answer ${esc(i.name)} directly. All submissions are also in the admin dashboard: https://the-business-ff.vercel.app/admin</p>
    </div>
  </div>`;
}

const PLANS: [string, string, string][] = [
  ["Hourly Support", "AED 60 / hour", "For one-time tasks and occasional administrative assistance."],
  ["Daily Support", "AED 330 / day", "Up to 6 hours of administrative support."],
  ["Weekly Support", "AED 1,500 / week", "Up to 30 hours, Monday–Friday."],
  ["Monthly Support — Basic", "AED 2,500 / month", "Up to 60 hours per month, averaging 3 hours per working day over 20 days."],
  ["Monthly Support — Dedicated", "AED 4,500 / month", "Up to 120 hours per month, with up to 6 hours per scheduled working day, subject to the monthly limit."],
];
const INCLUDES = [
  "Data Entry & Organization",
  "Business & Employee Record Management",
  "Excel Spreadsheets & Trackers",
  "Database Updates",
  "File & Document Organization",
  "Administrative Support",
];

// Confirmation sent to the person who submitted the form (table layout + inline styles for email clients)
function confirmationHtml(i: Record<string, string>, when: string) {
  const font = "Inter,'Helvetica Neue',Arial,sans-serif";
  const plan = ([name, price, desc]: [string, string, string]) => `
    <tr><td style="padding:0 0 12px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2b9bd;border-radius:6px">
        <tr><td style="padding:14px 18px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="font-family:${font};font-size:15px;font-weight:600;color:#000">${name}</td>
            <td align="right" style="font-family:${font};font-size:15px;font-weight:600;color:#7a2f3a;white-space:nowrap">${price}</td>
          </tr></table>
          <p style="margin:6px 0 0;font-family:${font};font-size:14px;line-height:1.5;color:#4d4d4d">${desc}</p>
        </td></tr>
      </table>
    </td></tr>`;
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f7eaec">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7eaec"><tr><td align="center" style="padding:28px 12px">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff">
      <tr><td style="background:#000000;padding:22px 32px">
        <span style="font-family:${font};font-size:20px;font-weight:700;letter-spacing:0.02em;color:#ffffff">The Business FF</span>
      </td></tr>
      <tr><td style="background:#f1cacd;padding:30px 32px">
        <h1 style="margin:0 0 8px;font-family:${font};font-size:26px;line-height:1.25;font-weight:700;color:#000">Thank you, ${esc(i.name.split(" ")[0])}.</h1>
        <p style="margin:0;font-family:${font};font-size:16px;line-height:1.5;color:#333">We've received your inquiry and our team will be in touch shortly to confirm your consultation.</p>
      </td></tr>
      <tr><td style="padding:28px 32px 8px">
        <p style="margin:0 0 12px;font-family:${font};font-size:12px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:#7a2f3a">Your request</p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="font-family:${font};font-size:15px;line-height:1.5">
          <tr><td style="padding:4px 18px 4px 0;color:#4d4d4d">Business</td><td style="padding:4px 0;color:#000">${esc(i.business)}</td></tr>
          <tr><td style="padding:4px 18px 4px 0;color:#4d4d4d">Service</td><td style="padding:4px 0;color:#000">${esc(i.service)}</td></tr>
          <tr><td style="padding:4px 18px 4px 0;color:#4d4d4d">Preferred time</td><td style="padding:4px 0;color:#000">${esc(when)}</td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:24px 32px 0"><div style="border-top:1px solid #e2b9bd"></div></td></tr>
      <tr><td style="padding:24px 32px 4px">
        <h2 style="margin:0 0 4px;font-family:${font};font-size:20px;font-weight:700;color:#000">Business Support &amp; Administrative Services</h2>
        <p style="margin:0 0 4px;font-family:${font};font-size:15px;font-style:italic;color:#7a2f3a">Flexible Support. Clear Pricing. Better Organization.</p>
        <p style="margin:0 0 18px;font-family:${font};font-size:14px;color:#4d4d4d">All prices are in AED. Remote services available Monday–Friday.</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${PLANS.map(plan).join("")}</table>
      </td></tr>
      <tr><td style="padding:12px 32px 0">
        <p style="margin:0 0 10px;font-family:${font};font-size:12px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:#7a2f3a">Services include</p>
        <table role="presentation" cellpadding="0" cellspacing="0">${INCLUDES.map((s) => `<tr><td style="padding:3px 10px 3px 0;font-family:${font};font-size:15px;color:#7a2f3a">&bull;</td><td style="padding:3px 0;font-family:${font};font-size:15px;color:#000">${s}</td></tr>`).join("")}</table>
      </td></tr>
      <tr><td style="padding:28px 32px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fcf1f2;border-radius:6px"><tr><td style="padding:20px 22px">
          <p style="margin:0 0 14px;font-family:${font};font-size:15px;line-height:1.5;color:#000">For more information or to discuss a package tailored to your business, contact BFF.</p>
          <a href="mailto:${NOTIFY_EMAIL}" style="display:inline-block;background:#000000;color:#ffffff;font-family:${font};font-size:14px;font-weight:600;text-decoration:none;padding:12px 22px;border-radius:4px">Email Us</a>
        </td></tr></table>
      </td></tr>
      <tr><td style="background:#000000;padding:22px 32px">
        <p style="margin:0 0 6px;font-family:${font};font-size:12px;line-height:1.6;color:#d9d9d9">Additional hours are charged separately with prior approval. All bookings are subject to confirmation and agreed terms.</p>
        <p style="margin:0;font-family:${font};font-size:12px;color:#f1cacd"><a href="${SITE_URL}" style="color:#f1cacd;text-decoration:none">thebusinessff.com</a> &nbsp;·&nbsp; <a href="mailto:${NOTIFY_EMAIL}" style="color:#f1cacd;text-decoration:none">${NOTIFY_EMAIL}</a></p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return json({ error: "Origin not allowed" }, 403, origin);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request" }, 400, origin);
  }

  // Spam trap: a hidden field people never see; bots fill it in. Pretend it worked.
  if (text(body.website, 200)) return json({ ok: true }, 200, origin);

  const inquiry = {
    name: text(body.name, 120),
    business: text(body.business, 160),
    email: text(body.email, 254).toLowerCase(),
    phone: text(body.phone, 40),
    service: text(body.service, 80),
    notes: text(body.notes, 4000),
  };
  const preferred = typeof body.preferred_at === "string" ? new Date(body.preferred_at) : null;
  const preferredAt = preferred && !isNaN(preferred.getTime()) ? preferred.toISOString() : null;

  if (!inquiry.name || !inquiry.business || !inquiry.phone || inquiry.phone.length < 3) {
    return json({ error: "Please fill in the required fields." }, 400, origin);
  }
  if (!EMAIL_RE.test(inquiry.email)) return json({ error: "Please enter a valid email address." }, 400, origin);
  if (!SERVICES.includes(inquiry.service)) return json({ error: "Please choose a service." }, 400, origin);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Light flood protection: at most 5 inquiries per email address per hour
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await admin
    .from("inquiries")
    .select("id", { count: "exact", head: true })
    .eq("email", inquiry.email)
    .gte("created_at", since);
  if ((count ?? 0) >= 5) {
    return json({ error: "We've already received several inquiries from this email. We'll be in touch soon!" }, 429, origin);
  }

  const { error } = await admin.from("inquiries").insert({ ...inquiry, preferred_at: preferredAt });
  if (error) {
    console.error("Insert failed:", error.message);
    return json({ error: "Your inquiry couldn't be sent. Please try again." }, 500, origin);
  }

  // Email notification (the inquiry is already saved, so a failed email doesn't fail the request)
  const apiKey = Deno.env.get("RESEND_API_KEY");
  let emailed = false;
  if (apiKey) {
    const when = preferredAt
      ? new Date(preferredAt).toLocaleString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium", timeStyle: "short" }) + " (UAE time)"
      : "Not given";
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [NOTIFY_EMAIL],
        reply_to: inquiry.email,
        subject: `New Form Submission: ${inquiry.name} (${inquiry.business})`,
        html: emailHtml(inquiry, when),
      }),
    });
    emailed = res.ok;
    if (!res.ok) console.error("Resend failed:", res.status, await res.text());

    // Confirmation to the customer; replies go to the business inbox
    const confirm = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [inquiry.email],
        reply_to: NOTIFY_EMAIL,
        subject: "We've received your inquiry | The Business FF",
        html: confirmationHtml(inquiry, when),
      }),
    });
    if (!confirm.ok) console.error("Confirmation email failed:", confirm.status, await confirm.text());
  }

  return json({ ok: true, emailed }, 200, origin);
});
