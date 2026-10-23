// Called after the buyer approves in the PayPal / card window. Captures the payment with PayPal
// and, only if PayPal confirms the full amount was taken, marks our order paid.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "https://the-business-ff.vercel.app,http://localhost:5500,http://127.0.0.1:5500")
  .split(",").map((o) => o.trim()).filter(Boolean);
const PAYPAL_API = Deno.env.get("PAYPAL_ENV") === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

async function paypalToken() {
  const id = Deno.env.get("PAYPAL_CLIENT_ID")!;
  const secret = Deno.env.get("PAYPAL_CLIENT_SECRET")!;
  const res = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${id}:${secret}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal auth failed (${res.status})`);
  return (await res.json()).access_token as string;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return json({ error: "Origin not allowed" }, 403, origin);

  let body: { order_id?: string; paypal_order_id?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request" }, 400, origin);
  }
  const ppId = typeof body.paypal_order_id === "string" ? body.paypal_order_id : "";
  if (!body.order_id || !UUID_RE.test(body.order_id) || !/^[A-Z0-9]{5,40}$/.test(ppId)) {
    return json({ error: "Order not found." }, 404, origin);
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: order } = await admin
    .from("orders")
    .select("id, status, total_cents, access_token")
    .eq("id", body.order_id)
    .eq("paypal_order_id", ppId)
    .maybeSingle();
  if (!order) return json({ error: "Order not found." }, 404, origin);

  const orderUrl = `${origin}/order?id=${order.id}&token=${order.access_token}`;

  // Buyer closed the PayPal window (or PayPal errored): retire the unpaid order so it doesn't
  // linger as "pending". Only if PayPal confirms nothing was approved or paid.
  if (body.action === "cancel") {
    if (order.status !== "pending") return json({ ok: true }, 200, origin);
    try {
      const accessToken = await paypalToken();
      const res = await fetch(`${PAYPAL_API}/v2/checkout/orders/${ppId}`, { headers: { Authorization: `Bearer ${accessToken}` } });
      const pp = await res.json();
      if (res.ok && (pp.status === "APPROVED" || pp.status === "COMPLETED")) return json({ ok: true, kept: true }, 200, origin);
    } catch {
      return json({ ok: true, kept: true }, 200, origin); // can't confirm with PayPal: leave it as is
    }
    await admin.from("orders").update({ status: "failed" }).eq("id", order.id).eq("status", "pending");
    return json({ ok: true }, 200, origin);
  }

  if (order.status === "paid") return json({ url: orderUrl }, 200, origin);
  if (order.status !== "pending") return json({ error: "This order can no longer be paid. Please start again from your cart." }, 409, origin);

  try {
    const accessToken = await paypalToken();
    let res = await fetch(`${PAYPAL_API}/v2/checkout/orders/${ppId}/capture`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": `capture-${order.id}`,
      },
    });
    let result = await res.json();

    // Card declined / funding problem: let the buyer pick another way to pay
    const issue = result?.details?.[0]?.issue;
    if (issue === "INSTRUMENT_DECLINED" || issue === "PAYER_ACTION_REQUIRED") {
      return json({ error: "That payment method was declined. Please try another card or PayPal.", restart: true }, 402, origin);
    }
    // PayPal hasn't approved this payment (window closed early, or approval didn't finish)
    if (issue === "ORDER_NOT_APPROVED") {
      return json({ error: "The payment wasn't completed in PayPal, so you haven't been charged. Please try again." }, 409, origin);
    }
    // Already captured (e.g. a retried request): read the order instead
    if (issue === "ORDER_ALREADY_CAPTURED") {
      res = await fetch(`${PAYPAL_API}/v2/checkout/orders/${ppId}`, { headers: { Authorization: `Bearer ${accessToken}` } });
      result = await res.json();
    }
    if (!res.ok) throw new Error(result?.message ?? `PayPal error ${res.status}`);

    const capture = result?.purchase_units?.[0]?.payments?.captures?.[0];
    const expected = (order.total_cents / 100).toFixed(2);
    const fullyPaid =
      result.status === "COMPLETED" &&
      capture?.status === "COMPLETED" &&
      capture.amount?.currency_code === "USD" &&
      capture.amount?.value === expected;

    if (!fullyPaid) {
      // e.g. PENDING review by PayPal: leave the order pending so it isn't fulfilled yet
      console.warn("Capture not completed", order.id, result.status, capture?.status, capture?.amount);
      return json({ url: orderUrl }, 200, origin);
    }

    // The money has been taken: make sure the order is recorded as paid (retry briefly if the database hiccups)
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { error: updErr } = await admin
        .from("orders")
        .update({ status: "paid", paid_at: new Date().toISOString(), paypal_capture_id: capture.id })
        .eq("id", order.id)
        .eq("status", "pending");
      if (!updErr) return json({ url: orderUrl }, 200, origin);
      console.error(`PAID BUT NOT RECORDED (attempt ${attempt}): order ${order.id}, capture ${capture.id}:`, updErr.message);
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
    return json({
      error: "Your payment went through, but we couldn't finish your order automatically. Please contact us with this reference and we'll send your files right away: " + order.id.slice(0, 8).toUpperCase(),
    }, 500, origin);
  } catch (err) {
    console.error("PayPal capture failed:", (err as Error).message);
    return json({ error: "We couldn't confirm your payment. If you were charged, please contact us and we'll send your files right away — otherwise, please try again." }, 502, origin);
  }
});
