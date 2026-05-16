/**
 * Thin client for the /api/opensea-listings proxy.
 * Returns null when the server hasn't configured OPENSEA_API_KEY.
 */

export type OpenSeaListing = {
  orderHash: string | null;
  tokenId: string | null;
  priceWei: string | null;
  priceDecimals: number;
  priceCurrency: string;
  /** Human-readable price string, e.g. "0.05" */
  priceEth: string | null;
  /** Full OpenSea listing URL */
  permalink: string | null;
  maker: string | null;
  expiry: number | null;
};

export type OpenSeaListingsResult = {
  ok: true;
  listings: OpenSeaListing[];
} | {
  ok: false;
  error: string;
};

/** Fetch all active listings for the configured TMPR collection. */
export async function fetchOpenSeaCollectionListings(): Promise<OpenSeaListingsResult> {
  const res = await fetch("/api/opensea-listings");
  const json = await res.json() as OpenSeaListingsResult;
  return json;
}

/** Fetch active listings for a specific TMPR token ID. */
export async function fetchOpenSeaTokenListings(tokenId: string): Promise<OpenSeaListingsResult> {
  const res = await fetch(`/api/opensea-listings?tokenId=${encodeURIComponent(tokenId)}`);
  const json = await res.json() as OpenSeaListingsResult;
  return json;
}

/** OpenSea asset URL for a TMPR NFT.
 *  `contract` should be the TMPR receipt contract address. */
export function openSeaAssetUrl(contract: string, tokenId: string | number): string {
  return `https://opensea.io/assets/base/${contract}/${tokenId}`;
}

/** OpenSea collection URL. */
export function openSeaCollectionUrl(slug = "tokenmarketplace"): string {
  return `https://opensea.io/collection/${slug}`;
}

/**
 * Build a map of tokenId → OpenSeaListing from a listings array
 * for O(1) lookup per NFT card.
 */
export function indexListingsByTokenId(listings: OpenSeaListing[]): Map<string, OpenSeaListing> {
  const m = new Map<string, OpenSeaListing>();
  for (const l of listings) {
    if (l.tokenId !== null) m.set(l.tokenId, l);
  }
  return m;
}
