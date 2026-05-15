/**
 * Vercel / Node serverless — authenticated Clanker token detail by ERC-20 address.
 *
 * Requires server env CLANKER_API_KEY (header x-api-key per docs).
 * GET https://www.clanker.world/api/get-clanker-by-address?address=0x…
 *
 * Docs: https://clanker.gitbook.io/documentation/authenticated/get-token-by-address
 *
 * Query: GET /api/clanker-get-token?address=0x…
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

  const apiKey = (process.env.CLANKER_API_KEY || "").trim();
  if (!apiKey) {
    res.status(503).json({
      ok: false,
      error: "CLANKER_API_KEY is not configured on the server",
      hint: "Add CLANKER_API_KEY in Vercel env for authenticated Clanker reads (factory_address, pool_address, etc.).",
    });
    return;
  }

  const rawAddr = Array.isArray(req.query.address) ? req.query.address[0] : req.query.address;
  const addr = typeof rawAddr === "string" ? rawAddr.trim().toLowerCase() : "";
  if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
    res.status(400).json({ ok: false, error: "Query address must be a 40-hex-prefixed ERC-20 contract" });
    return;
  }

  const base =
    (process.env.CLANKER_GET_TOKEN_URL || "https://www.clanker.world/api/get-clanker-by-address").replace(/\/$/, "");
  const upstreamUrl = `${base}?${new URLSearchParams({ address: addr }).toString()}`;

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      headers: {
        Accept: "application/json",
        "x-api-key": apiKey,
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
      note:
        "Fee beneficiary / admin can change on-chain — treat pool_address + fee manager reads as source of truth for escrow.",
    },
  });
}
