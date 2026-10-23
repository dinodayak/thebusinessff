// Checkout for the cart page.
//   { action: "config" }            -> PayPal client id for the browser buttons
//   { items: [ids], email }         -> creates our order; free orders complete immediately,
//                                      paid orders also get a PayPal order the buttons can approve
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "https://the-business-ff.vercel.app,http://localhost:5500,http://127.0.0.1:5500")
  .split(",").map((o) => o.trim()).filter(Boolean);
const PAYPAL_API = Deno.env.get("PAYPAL_ENV") === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
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

const dollars = (cents: number) => (cents / 100).toFixed(2);

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return json({ error: "Origin not allowed" }, 403, origin);

  let body: { action?: unknown; items?: unknown; email?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request" }, 400, origin);
  }

  const paypalReady = Boolean(Deno.env.get("PAYPAL_CLIENT_ID") && Deno.env.get("PAYPAL_CLIENT_SECRET"));
  if (body.action === "config") {
    return json({ paypal_client_id: paypalReady ? Deno.env.get("PAYPAL_CLIENT_ID") : null, currency: "USD" }, 200, origin);
  }

  const ids = Array.isArray(body.items) ? [...new Set(body.items.filter((i) => typeof i === "string"))] : [];
  if (ids.length === 0 || ids.length > 50) return json({ error: "Your cart is empty." }, 400, origin);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Signed-in buyers: link the order to their account and use their verified email
  let userId: string | null = null;
  let email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (token && token.split(".").length === 3) {
    const { data } = await admin.auth.getUser(token);
    if (data.user) {
      userId = data.user.id;
      email = (data.user.email ?? email).toLowerCase();
    }
  }
  if (!EMAIL_RE.test(email)) return json({ error: "Please enter a valid email address." }, 400, origin);

  // Prices always come from the database, never from the browser
  const { data: products, error: productsError } = await admin
    .from("products")
    .select("id, name, price_cents")
    .in("id", ids)
    .eq("active", true);
  if (productsError) return json({ error: "Could not load products." }, 500, origin);
  if (!products || products.length !== ids.length) {
    return json({ error: "Some items in your cart are no longer available. Please refresh and try again." }, 409, origin);
  }

  // Housekeeping: unpaid checkouts older than 24 hours are abandoned (PayPal orders expire sooner)
  await admin.from("orders").update({ status: "failed" })
    .eq("status", "pending").lt("created_at", new Date(Date.now() - 24 * 3600e3).toISOString());

  const total = products.reduce((sum, p) => sum + p.price_cents, 0);
  const isFree = total === 0;
  if (!isFree && !paypalReady) {
    return json({ error: "Card payments aren't switched on yet. Please check back soon." }, 503, origin);
  }

  const { data: order, error: orderError } = await admin
    .from("orders")
    .insert({
      email,
      user_id: userId,
      total_cents: total,
      currency: "usd",
      status: isFree ? "paid" : "pending",
      paid_at: isFree ? new Date().toISOString() : null,
    })
    .select("id, access_token")
    .single();
  if (orderError || !order) return json({ error: "Could not create your order." }, 500, origin);

  const { error: itemsError } = await admin.from("order_items").insert(
    products.map((p) => ({ order_id: order.id, product_id: p.id, name: p.name, price_cents: p.price_cents })),
  );
  if (itemsError) {
    await admin.from("orders").delete().eq("id", order.id);
    return json({ error: "Could not create your order." }, 500, origin);
  }

  if (isFree) return json({ url: `${origin}/order?id=${order.id}&token=${order.access_token}` }, 200, origin);

  // PayPal order (paid items only — free items in a mixed cart are included at $0 on our side)
  const paid = products.filter((p) => p.price_cents > 0);
  try {
    const accessToken = await paypalToken();
    const res = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": `create-${order.id}`,
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{
          reference_id: order.id,
          custom_id: order.id,
          description: "The Business FF digital templates",
          amount: {
            currency_code: "USD",
            value: dollars(total),
            breakdown: { item_total: { currency_code: "USD", value: dollars(total) } },
          },
          items: paid.map((p) => ({
            name: p.name.slice(0, 127),
            quantity: "1",
            category: "DIGITAL_GOODS",
            unit_amount: { currency_code: "USD", value: dollars(p.price_cents) },
          })),
        }],
        application_context: { brand_name: "The Business FF", shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW" },
      }),
    });
    const ppOrder = await res.json();
    if (!res.ok || !ppOrder.id) throw new Error(ppOrder?.message ?? `PayPal error ${res.status}`);

    // The capture step finds our order by this id, so it must be saved before the buyer can pay
    const { error: linkErr } = await admin.from("orders").update({ paypal_order_id: ppOrder.id }).eq("id", order.id);
    if (linkErr) throw new Error("Could not link PayPal order: " + linkErr.message);
    return json({ order_id: order.id, paypal_order_id: ppOrder.id }, 200, origin);
  } catch (err) {
    console.error("PayPal create order failed:", (err as Error).message);
    await admin.from("orders").update({ status: "failed" }).eq("id", order.id);
    return json({ error: "Could not start checkout. Please try again." }, 502, origin);
  }
});
