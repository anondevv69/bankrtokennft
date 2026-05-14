/**
 * Vercel / Node serverless — proxies Bankr token-launch APIs (secrets stay server-side).
 *
 * Docs (list launches — unauthenticated):
 *   https://docs.bankr.bot/token-launching/api-reference/list-token-launches/
 *
 * Env (Vercel / Railway **server** env — never `VITE_*`):
 *   BANKR_LAUNCHES_API_TEMPLATE — Optional. Defaults to:
 *       https://api.bankr.bot/token-launches
 *     Use another GET URL if needed; include `{address}` only if the upstream path needs it
 *     (e.g. Clanker). If the URL has no `{address}`, we still require query `q` to filter results for the wallet.
 *   BANKR_API_KEY — Optional. List endpoint is public; use for other upstreams that need auth.
 *   BANKR_AUTH_HEADER / BANKR_AUTH_SCHEME — Optional auth shape (see previous handler logic).
 *
 * Query: GET /api/bankr-launches?q=0x…Wallet
 * For https://api.bankr.bot/token-launches we fetch the global list then return only launches where
 * feeRecipient.walletAddress or deployer.walletAddress matches `q` (case-insensitive).
 * Limitation: only the **50 most recent** launches exist in that API — older launches won’t appear.
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
  const rawTemplate = (process.env.BANKR_LAUNCHES_API_TEMPLATE || "").trim();
  const template =
    rawTemplate || "https://api.bankr.bot/token-launches";
  const apiKey = (process.env.BANKR_API_KEY || "").trim();

  const upstreamUrl = template.includes("{address}")
    ? template.replace(/\{address\}/gi, address)
    : template;

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

  /** @param {unknown} w */
  const walletMatches = (w) => {
    if (!w || typeof w !== "object") return false;
    const a = /** @type {{ walletAddress?: string }} */ (w).walletAddress;
    return typeof a === "string" && a.toLowerCase() === address;
  };

  const isBankrList =
    typeof upstreamUrl === "string" &&
    upstreamUrl.replace(/\/$/, "").endsWith("token-launches");

  if (
    body &&
    typeof body === "object" &&
    Array.isArray(/** @type {{ launches?: unknown[] }} */ (body).launches) &&
    (isBankrList || rawTemplate === "")
  ) {
    const all = /** @type {{ launches: Record<string, unknown>[] }} */ (body).launches;
    const filtered = all.filter(
      (L) =>
        walletMatches(L.feeRecipient) || walletMatches(L.deployer),
    );
    body = {
      launches: filtered,
      __meta: {
        source: upstreamUrl,
        totalFromApi: all.length,
        matchedForWallet: address,
        note:
          "Subset where feeRecipient or deployer equals q. Bankr list API returns at most 50 recent launches — older tokens are not included.",
      },
    };
  }

  res.status(200).json({ ok: true, address, upstreamUrl, data: body });
}
