// Contact / booking form: validates the submission, saves it (shown in /admin → Submissions)
// and emails a notification through Resend when RESEND_API_KEY is set.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "https://the-business-ff.vercel.app,http://localhost:5500,http://127.0.0.1:5500")
  .split(",").map((o) => o.trim()).filter(Boolean);
const NOTIFY_EMAIL = Deno.env.get("NOTIFY_EMAIL") ?? "thebusiness.ff@outlook.com";
// Without a verified domain, Resend only sends from its shared address (to the account owner's email)
const FROM_EMAIL = Deno.env.get("NOTIFY_FROM") ?? "The Business FF <onboarding@resend.dev>";
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
      ? new Date(preferredAt).toLocaleString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium", timeStyle: "short" }) + " (Dubai time)"
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
  }

  return json({ ok: true, emailed }, 200, origin);
});
