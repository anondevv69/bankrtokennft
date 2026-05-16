/**
 * Vercel / Node serverless — OpenSea API proxy for TMPR collection listings.
 *
 * GET /api/opensea-listings
 *   → all active listings for the configured collection (OPENSEA_COLLECTION_SLUG)
 *
 * GET /api/opensea-listings?tokenId=123
 *   → active listings for a specific TMPR token ID
 *
 * Requires server env vars:
 *   OPENSEA_API_KEY          — your OpenSea API key
 *   OPENSEA_COLLECTION_SLUG  — e.g. "token-marketplace-981215191" (optional, has default)
 *
 * Docs: https://docs.opensea.io/reference/get_listings
 */

const OPENSEA_BASE = "https://api.opensea.io/api/v2";
const DEFAULT_COLLECTION_SLUG = "tokenmarketplace";
const BASE_CHAIN = "base";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET") { res.status(405).json({ ok: false, error: "Method not allowed" }); return; }

  const apiKey = process.env.OPENSEA_API_KEY;
  if (!apiKey) {
    res.status(503).json({ ok: false, error: "OPENSEA_API_KEY not configured on server." });
    return;
  }

  const collectionSlug = process.env.OPENSEA_COLLECTION_SLUG || DEFAULT_COLLECTION_SLUG;
  const tokenIdRaw = Array.isArray(req.query.tokenId) ? req.query.tokenId[0] : req.query.tokenId;
  const contractRaw = Array.isArray(req.query.contract) ? req.query.contract[0] : req.query.contract;

  const headers = { "X-API-KEY": apiKey, Accept: "application/json" };

  try {
    let upstreamUrl;
    let data;

    if (tokenIdRaw) {
      // Listings for a specific token ID
      const params = new URLSearchParams({ token_ids: tokenIdRaw, limit: "10" });
      if (contractRaw) params.set("asset_contract_address", contractRaw);
      upstreamUrl = `${OPENSEA_BASE}/orders/${BASE_CHAIN}/seaport/listings?${params}`;
      const r = await fetch(upstreamUrl, { headers });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        res.status(r.status).json({ ok: false, error: "OpenSea upstream error", status: r.status, body: body.slice(0, 500) });
        return;
      }
      const json = await r.json();
      // Normalise to { listings: [] }
      data = { listings: (json.orders ?? []).map(normalizeOrder) };
    } else {
      // All listings for the collection
      upstreamUrl = `${OPENSEA_BASE}/listings/collection/${encodeURIComponent(collectionSlug)}/all?limit=50`;
      const r = await fetch(upstreamUrl, { headers });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        res.status(r.status).json({ ok: false, error: "OpenSea upstream error", status: r.status, body: body.slice(0, 500) });
        return;
      }
      const json = await r.json();
      data = { listings: (json.listings ?? []).map(normalizeListing) };
    }

    res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=60");
    res.status(200).json({ ok: true, ...data });
  } catch (e) {
    res.status(502).json({ ok: false, error: "Upstream fetch failed", detail: String(e) });
  }
}

/** Normalise a /listings/collection/ entry into our thin shape. */
function normalizeListing(raw) {
  const price = raw?.price?.current?.value;
  const decimals = raw?.price?.current?.decimals ?? 18;
  const currency = raw?.price?.current?.currency ?? "ETH";
  const tokenId = extractTokenId(raw?.protocol_data?.parameters?.offer?.[0]);
  return {
    orderHash: raw?.order_hash ?? null,
    tokenId: tokenId ?? null,
    priceWei: price ? String(price) : null,
    priceDecimals: decimals,
    priceCurrency: currency,
    priceEth: price ? formatEth(price, decimals) : null,
    permalink: tokenId ? `https://opensea.io/assets/base/${contractFromConsideration(raw)}/` + tokenId : null,
    maker: raw?.maker?.address ?? null,
    expiry: raw?.protocol_data?.parameters?.endTime ?? null,
  };
}

/** Normalise a /orders/{chain}/seaport/listings entry. */
function normalizeOrder(raw) {
  const price = raw?.current_price;
  const tokenId = extractTokenId(raw?.maker_asset_bundle?.assets?.[0]) ??
    raw?.maker_asset_bundle?.assets?.[0]?.token_id ?? null;
  const contractAddr = raw?.maker_asset_bundle?.assets?.[0]?.asset_contract?.address ?? null;
  return {
    orderHash: raw?.order_hash ?? null,
    tokenId: tokenId ? String(tokenId) : null,
    priceWei: price ? String(price) : null,
    priceDecimals: 18,
    priceCurrency: "ETH",
    priceEth: price ? formatEth(price, 18) : null,
    permalink: tokenId && contractAddr
      ? `https://opensea.io/assets/base/${contractAddr}/${tokenId}`
      : null,
    maker: raw?.maker?.address ?? null,
    expiry: raw?.expiration_time ?? null,
  };
}

function extractTokenId(offer) {
  if (!offer) return null;
  return offer.identifier_or_criteria ?? offer.identifierOrCriteria ?? null;
}

function contractFromConsideration(raw) {
  return raw?.protocol_data?.parameters?.consideration?.[0]?.token ?? "";
}

function formatEth(weiStr, decimals) {
  try {
    const wei = BigInt(String(weiStr));
    const divisor = BigInt(10 ** decimals);
    const whole = wei / divisor;
    const frac = wei % divisor;
    const fracStr = frac.toString().padStart(decimals, "0").slice(0, 6).replace(/0+$/, "");
    return fracStr ? `${whole}.${fracStr}` : String(whole);
  } catch {
    return null;
  }
}
