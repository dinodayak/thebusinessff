// Returns an order for the confirmation page, plus short-lived download links once it's paid.
// Access needs the order id + its private access token (from the checkout redirect or the buyer's account).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "https://the-business-ff.vercel.app,http://localhost:5500,http://127.0.0.1:5500")
  .split(",").map((o) => o.trim()).filter(Boolean);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LINK_SECONDS = 60 * 60;

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

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);

  let body: { id?: string; token?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request" }, 400, origin);
  }
  if (!body.id || !body.token || !UUID_RE.test(body.id) || !UUID_RE.test(body.token)) {
    return json({ error: "Order not found." }, 404, origin);
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: order } = await admin
    .from("orders")
    .select("id, email, status, total_cents, currency, created_at, paid_at, order_items(name, price_cents, products(slug, image_url))")
    .eq("id", body.id)
    .eq("access_token", body.token)
    .maybeSingle();
  if (!order) return json({ error: "Order not found." }, 404, origin);

  const items = [];
  for (const item of order.order_items as any[]) {
    const slug = item.products?.slug;
    const files: { name: string; url: string }[] = [];
    if (order.status === "paid" && slug) {
      // Every file in the product's folder in the private "downloads" bucket
      const { data: list } = await admin.storage.from("downloads").list(slug, { limit: 100 });
      const names = (list ?? []).filter((f) => f.id && !f.name.startsWith(".")).map((f) => f.name);
      if (names.length) {
        const { data: signed } = await admin.storage
          .from("downloads")
          .createSignedUrls(names.map((n) => `${slug}/${n}`), LINK_SECONDS, { download: true });
        (signed ?? []).forEach((s, i) => s.signedUrl && files.push({ name: names[i], url: s.signedUrl }));
      }
    }
    items.push({ name: item.name, price_cents: item.price_cents, slug, image_url: item.products?.image_url, files });
  }

  return json({
    order: {
      id: order.id,
      email: order.email,
      status: order.status,
      total_cents: order.total_cents,
      currency: order.currency,
      created_at: order.created_at,
      paid_at: order.paid_at,
      items,
    },
  }, 200, origin);
});
