import type { Address } from "viem";
import type { OpenSeaListing } from "./lib/openSeaListings";
import { useReceiptListingMeta } from "./lib/useReceiptListingMeta";

function shortAddr(addr: string) {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

type Props = {
  listing: OpenSeaListing;
  collection: Address;
};

/** OpenSea listing card with on-chain TMPR metadata. */
export function OpenSeaListingCard({ listing, collection }: Props) {
  const meta = useReceiptListingMeta(collection, listing.tokenId);

  const title =
    meta.ticker && meta.serialLabel
      ? `${meta.ticker} · TMPR ${meta.serialLabel}`
      : meta.ticker
        ? meta.ticker
        : meta.serialLabel
          ? `TMPR ${meta.serialLabel}`
          : listing.tokenId
            ? `TMPR …${listing.tokenId.slice(-8)}`
            : "TMPR NFT";

  return (
    <div className="listing-card opensea-card">
      <div className="listing-card__header">
        <span className="listing-card__title" title={title}>
          {title}
        </span>
        <span className="badge badge--opensea">OpenSea</span>
      </div>

      <div className="listing-card__meta" style={{ marginTop: "0.35rem" }}>
        {meta.loading ? (
          <p className="muted" style={{ fontSize: "0.78rem" }}>
            <span className="spinner" /> Loading token details…
          </p>
        ) : (
          <>
            {meta.launchFactory && (
              <div className="listing-card__meta-row">
                <span>Launch factory</span>
                <span className="listing-card__meta-ellipsis" title={meta.launchFactory}>
                  {meta.launchFactory}
                </span>
              </div>
            )}
            {meta.ticker && (
              <div className="listing-card__meta-row">
                <span>Ticker</span>
                <span className="listing-card__meta-ellipsis">{meta.ticker}</span>
              </div>
            )}
            {meta.tokenName && meta.tokenName !== meta.ticker && (
              <div className="listing-card__meta-row">
                <span>Token name</span>
                <span className="listing-card__meta-ellipsis" title={meta.tokenName}>
                  {meta.tokenName}
                </span>
              </div>
            )}
            {meta.launchedToken && (
              <div className="listing-card__meta-row">
                <span>Token contract</span>
                <span className="listing-card__meta-ellipsis">
                  <a
                    className="mono listing-card__meta-link"
                    href={`https://basescan.org/token/${meta.launchedToken}`}
                    target="_blank"
                    rel="noreferrer"
                    title={meta.launchedToken}
                  >
                    {shortAddr(meta.launchedToken)}
                  </a>
                </span>
              </div>
            )}
          </>
        )}
      </div>

      <div className="listing-card__price" style={{ marginTop: "0.5rem" }}>
        {listing.priceEth ? (
          <>
            <strong>{listing.priceEth}</strong> {listing.priceCurrency}
          </>
        ) : (
          <span className="muted">Price unknown</span>
        )}
      </div>

      {listing.maker && (
        <p className="listing-card__seller muted mono">
          Seller: {shortAddr(listing.maker)}
        </p>
      )}

      {listing.permalink && (
        <a
          href={listing.permalink}
          target="_blank"
          rel="noreferrer"
          className="btn btn-ghost btn-sm"
          style={{ marginTop: "0.5rem", width: "100%", textAlign: "center" }}
        >
          Buy on OpenSea ↗
        </a>
      )}
    </div>
  );
}
