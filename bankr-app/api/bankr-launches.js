/**
 * Vercel Serverless — proxies Bankr with a **server-only** API key.
 *
 * Env (set in Vercel → Settings → Environment Variables, **not** prefixed with VITE_):
 *   BANKR_LAUNCHES_API_TEMPLATE — **Required.** Full URL to a GET endpoint; put literal `{address}` where the
 *       wallet (checksummed or not) should go. We substitute it with the query `q` lowercased.
 *       You must use the **exact** URL Bankr or Clanker documents — we do not know their production host.
 *       Clanker-style example (verify host + path with Clanker before relying on it):
 *         https://<CLANKER_API_HOST>/api/tokens/user/{address}
 *   BANKR_API_KEY              — **Optional.** Omit for public JSON APIs. If set, sent as auth (see below).
 *
 * Optional:
 *   BANKR_AUTH_HEADER  — default "Authorization"
 *   BANKR_AUTH_SCHEME  — default "Bearer" (set to "" to send raw key, or "Token", etc.)
 */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const rawQ = Array.isArray(req.query.q) ? req.query.q[0] : req.query.q;
  const q = typeof rawQ === "string" ? rawQ.trim() : "";
  if (!q || !/^0x[a-fA-F0-9]{40}$/.test(q)) {
    res.status(400).json({ ok: false, error: "Query q must be a 40-hex-prefixed address" });
    return;
  }

  const address = q.toLowerCase();
  const template = process.env.BANKR_LAUNCHES_API_TEMPLATE;
  const apiKey = (process.env.BANKR_API_KEY || "").trim();

  if (!template) {
    res.status(503).json({
      ok: false,
      error: "Bankr API proxy is not configured",
      hint:
        "Set BANKR_LAUNCHES_API_TEMPLATE on Vercel to the real GET URL (include literal {address}). Example shape from Bankr agent notes: https://<clanker-host>/api/tokens/user/{address} — confirm host with Clanker/Bankr docs. BANKR_API_KEY is optional for public APIs.",
    });
    return;
  }

  const upstreamUrl = template.replace(/\{address\}/gi, address);
  const authHeader = process.env.BANKR_AUTH_HEADER || "Authorization";
  const scheme = process.env.BANKR_AUTH_SCHEME;
  /** @type {Record<string, string>} */
  const headers = {
    Accept: "application/json",
    "User-Agent": "BankrSale/1.0",
  };
  if (apiKey) {
    headers[authHeader] = scheme === "" ? apiKey : `${scheme || "Bearer"} ${apiKey}`;
  }

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      headers,
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: "Upstream fetch failed", detail: String(e) });
    return;
  }

  const ct = upstream.headers.get("content-type") || "";
  let body;
  try {
    body = ct.includes("application/json") ? await upstream.json() : await upstream.text();
  } catch {
    body = null;
  }

  if (!upstream.ok) {
    res.status(upstream.status).json({
      ok: false,
      error: "Bankr upstream returned an error",
      status: upstream.status,
      body: typeof body === "string" ? body.slice(0, 2000) : body,
    });
    return;
  }

  res.status(200).json({ ok: true, address, upstreamUrl, data: body });
}
