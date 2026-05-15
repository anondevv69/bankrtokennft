/**
 * Vercel / Node serverless — public Clanker “tokens by creator” search (no API key).
 *
 * Upstream: GET https://clanker.world/api/search-creator
 * Docs: https://clanker.gitbook.io/documentation/public/get-tokens-by-creator
 *
 * Query: GET /api/clanker-search-creator?q=0x…|farcasterName&limit=&offset=&sort=&trustedOnly=
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
  if (!q) {
    res.status(400).json({ ok: false, error: 'Query "q" is required (wallet 0x… or Farcaster username)' });
    return;
  }

  const isAddr = /^0x[a-fA-F0-9]{40}$/.test(q);
  if (!isAddr && q.length < 2) {
    res.status(400).json({ ok: false, error: "Invalid search query" });
    return;
  }

  const base =
    (process.env.CLANKER_SEARCH_CREATOR_URL || "https://clanker.world/api/search-creator").replace(/\/$/, "");
  const params = new URLSearchParams({ q: isAddr ? q.toLowerCase() : q });

  const limitRaw = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
  const offsetRaw = Array.isArray(req.query.offset) ? req.query.offset[0] : req.query.offset;
  const sortRaw = Array.isArray(req.query.sort) ? req.query.sort[0] : req.query.sort;
  const trustedRaw = Array.isArray(req.query.trustedOnly) ? req.query.trustedOnly[0] : req.query.trustedOnly;

  if (limitRaw !== undefined) params.set("limit", String(limitRaw));
  if (offsetRaw !== undefined) params.set("offset", String(offsetRaw));
  if (sortRaw !== undefined) params.set("sort", String(sortRaw));
  if (trustedRaw !== undefined) params.set("trustedOnly", String(trustedRaw));

  const upstreamUrl = `${base}?${params.toString()}`;

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent": "BankrSale/1.0",
      },
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
      error: "Clanker upstream returned an error",
      status: upstream.status,
      body: typeof body === "string" ? body.slice(0, 2000) : body,
    });
    return;
  }

  res.status(200).json({
    ok: true,
    upstreamUrl,
    data: body,
    __meta: {
      note: "Public search-creator — use pool_address / factory from authenticated get-token when wiring escrow.",
    },
  });
}
