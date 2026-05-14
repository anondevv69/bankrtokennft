/**
 * Vercel / Node serverless — proxies Bankr public read APIs (optional server key only).
 *
 * Default (no env): **Creator fees for wallet** — all Doppler + Clanker tokens where the address is a
 * creator beneficiary (not limited to 50 recent deploys). Unauthenticated per Bankr docs:
 *   https://docs.bankr.bot/token-launching/reading-fees/
 *
 * Optional env `BANKR_LAUNCHES_API_TEMPLATE` overrides the GET URL:
 *   - Creator fees (default when unset):
 *       https://api.bankr.bot/public/doppler/creator-fees/{address}?days=30
 *     Use `{address}` for the connected wallet. Optional `BANKR_CREATOR_FEES_DAYS` (default 30, max 90 per docs).
 *   - Recent launches list + server-side filter (feeRecipient / deployer):
 *       https://api.bankr.bot/token-launches
 *     https://docs.bankr.bot/token-launching/api-reference/list-token-launches/
 *
 * Query: GET /api/bankr-launches?q=0x…Wallet
 *
 * Other reads from the same doc family (token-fees, claimable-fees) can be wired later as separate routes.
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
  const daysRaw = (process.env.BANKR_CREATOR_FEES_DAYS || "30").trim();
  const days = Math.min(90, Math.max(1, parseInt(daysRaw, 10) || 30));
  const defaultCreator =
    `https://api.bankr.bot/public/doppler/creator-fees/{address}?days=${days}`;
  const template = rawTemplate || defaultCreator;
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

  const urlNorm = typeof upstreamUrl === "string" ? upstreamUrl.replace(/\/$/, "") : "";
  const isTokenLaunchesList = urlNorm.endsWith("token-launches");

  if (
    body &&
    typeof body === "object" &&
    Array.isArray(/** @type {{ launches?: unknown[] }} */ (body).launches) &&
    isTokenLaunchesList
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
          "Subset where feeRecipient or deployer equals q. List API returns at most 50 recent launches.",
      },
    };
  } else if (
    body &&
    typeof body === "object" &&
    Array.isArray(/** @type {{ tokens?: unknown[] }} */ (body).tokens) &&
    urlNorm.includes("/creator-fees/")
  ) {
    body = {
      ...body,
      __meta: {
        source: upstreamUrl,
        note:
          "From GET /public/doppler/creator-fees/{address} — tokens where this wallet is a creator beneficiary. See Reading Creator Fees docs.",
      },
    };
  }

  res.status(200).json({ ok: true, address, upstreamUrl, data: body });
}
