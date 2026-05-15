/**
 * Vercel / Node serverless — proxies Bankr public token fee read (per launched ERC-20).
 *
 * Upstream: GET https://api.bankr.bot/public/doppler/token-fees/{tokenAddress}?days=N
 * Docs: https://docs.bankr.bot/token-launching/reading-fees/ ("Fee data for a token")
 *
 * Query: GET /api/bankr-token-fees?token=0x…Token&days=30
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

  const rawT = Array.isArray(req.query.token) ? req.query.token[0] : req.query.token;
  const token = typeof rawT === "string" ? rawT.trim().toLowerCase() : "";
  if (!token || !/^0x[a-f0-9]{40}$/.test(token)) {
    res.status(400).json({ ok: false, error: "Query token must be a 40-hex-prefixed address" });
    return;
  }

  const daysRaw = Array.isArray(req.query.days) ? req.query.days[0] : req.query.days;
  const days = Math.min(90, Math.max(1, parseInt(String(daysRaw || "30"), 10) || 30));
  const upstreamUrl = `https://api.bankr.bot/public/doppler/token-fees/${token}?days=${days}`;

  const apiKey = (process.env.BANKR_API_KEY || "").trim();
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
    upstream = await fetch(upstreamUrl, { headers });
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
    /** Bankr returns 404 + JSON error for tokens that have no Doppler fee profile. */
    if (upstream.status === 404) {
      res.status(200).json({
        ok: true,
        token,
        upstreamUrl,
        data: { tokens: [] },
        empty: true,
      });
      return;
    }
    res.status(upstream.status).json({
      ok: false,
      error: "Bankr upstream returned an error",
      status: upstream.status,
      body: typeof body === "string" ? body.slice(0, 2000) : body,
    });
    return;
  }

  res.status(200).json({
    ok: true,
    token,
    upstreamUrl,
    data: body,
    __meta: {
      note: "From GET /public/doppler/token-fees/{token} — name/symbol/poolId/labels; optional image fields if present.",
    },
  });
}
