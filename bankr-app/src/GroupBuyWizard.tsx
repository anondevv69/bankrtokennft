/**
 * GroupBuyWizard — UI for timed group purchases and partial sales of TMPR receipts.
 *
 * Two modes:
 *   "list"        — seller lists a TMPR NFT for a group buy or partial sale
 *   "contribute"  — contributor puts ETH toward an open listing
 *
 * After finalize() the resulting 0xSplits PushSplit is shown with a "Distribute & Claim"
 * button so each recipient can pull their share of accumulated Bankr fees.
 */

import { useCallback, useState } from "react";
import { formatEther, parseEther } from "viem";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useWalletClient,
  useWriteContract,
  useWaitForTransactionReceipt,
  useReadContract,
  useConfig,
} from "wagmi";
import { base } from "viem/chains";
import { groupBuyEscrowAbi, type GroupBuyListing } from "./lib/groupBuyEscrowAbi";
import { distributeSplit, ETH_TOKEN } from "./lib/splitsClient";
import { ensureBaseChain } from "./ensureBase";
import { bankrFeeRightsReceiptAbi } from "./lib/bankrFeeRightsReceiptAbi";
import { CANONICAL_BANKR_ESCROW } from "./lib/deployAddresses";

// ── Config ────────────────────────────────────────────────────────────────────

const GROUP_BUY_ESCROW_ADDRESS = (
  import.meta.env.VITE_GROUP_BUY_ESCROW_ADDRESS ?? ""
) as `0x${string}`;

// ── Types ─────────────────────────────────────────────────────────────────────

type Mode = "list" | "contribute" | "view";

interface Props {
  /** Optional pre-selected TMPR token ID (e.g. from profile page "Group Buy" button). */
  preselectedTokenId?: bigint;
  /** Collection address — defaults to canonical TMPR receipt. */
  collectionAddress?: `0x${string}`;
  /** Called when the user wants to close / go back. */
  onClose?: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatCountdown(deadlineSeconds: bigint) {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const remaining = deadlineSeconds > now ? deadlineSeconds - now : 0n;
  if (remaining === 0n) return "Expired";
  const h = remaining / 3600n;
  const m = (remaining % 3600n) / 60n;
  return h > 0n ? `${h}h ${m}m remaining` : `${m}m remaining`;
}

function pctFilled(listing: GroupBuyListing) {
  if (listing.priceWei === 0n) return 0;
  return Number((listing.totalRaised * 100n) / listing.priceWei);
}

// ── Subcomponent: Listing form ────────────────────────────────────────────────

function ListForm({
  preselectedTokenId,
  collectionAddress,
  onClose,
}: {
  preselectedTokenId?: bigint;
  collectionAddress?: `0x${string}`;
  onClose?: () => void;
}) {
  const { address } = useAccount();
  const chainId = useChainId();
  const config = useConfig();

  const [mode, setMode] = useState<"group" | "partial">("group");
  const [tokenId, setTokenId] = useState(preselectedTokenId?.toString() ?? "");
  const [price, setPrice] = useState("");
  const [hours, setHours] = useState("24");
  const [minContrib, setMinContrib] = useState("0");
  const [sellerKeepPct, setSellerKeepPct] = useState("80");
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<"form" | "approve" | "list" | "done">("form");

  const collection = (collectionAddress ?? import.meta.env.VITE_DEFAULT_RECEIPT_COLLECTION ?? "") as `0x${string}`;

  const { writeContractAsync: approveNft } = useWriteContract();
  const { writeContractAsync: createListing, data: listTxHash } = useWriteContract();
  const { isSuccess: listConfirmed } = useWaitForTransactionReceipt({ hash: listTxHash });

  const handleApprove = useCallback(async () => {
    if (!address || !tokenId || !GROUP_BUY_ESCROW_ADDRESS) return;
    setError(null);
    try {
      await ensureBaseChain(config);
      await approveNft({
        address: collection,
        abi: bankrFeeRightsReceiptAbi,
        functionName: "approve",
        args: [GROUP_BUY_ESCROW_ADDRESS, BigInt(tokenId)],
      });
      setApproved(true);
      setStep("list");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [address, tokenId, chainId, config, approveNft, collection]);

  const handleList = useCallback(async () => {
    if (!address || !tokenId || !price || !GROUP_BUY_ESCROW_ADDRESS) return;
    setError(null);
    try {
      await ensureBaseChain(config);
      const priceWei = parseEther(price);
      const durationSecs = BigInt(Math.round(parseFloat(hours) * 3600));
      const minContribWei = parseEther(minContrib || "0");
      const bankrEscrow = CANONICAL_BANKR_ESCROW as `0x${string}`;

      if (mode === "partial") {
        const keepBps = Math.round(parseFloat(sellerKeepPct) * 100);
        await createListing({
          address: GROUP_BUY_ESCROW_ADDRESS,
          abi: groupBuyEscrowAbi,
          functionName: "createPartialListing",
          args: [collection, BigInt(tokenId), priceWei, durationSecs, minContribWei, keepBps, bankrEscrow],
        });
      } else {
        await createListing({
          address: GROUP_BUY_ESCROW_ADDRESS,
          abi: groupBuyEscrowAbi,
          functionName: "createListing",
          args: [collection, BigInt(tokenId), priceWei, durationSecs, minContribWei, bankrEscrow],
        });
      }
      setStep("done");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [address, tokenId, price, hours, minContrib, mode, sellerKeepPct, chainId, config, createListing, collection]);

  if (!GROUP_BUY_ESCROW_ADDRESS) {
    return (
      <div className="error-bar">
        VITE_GROUP_BUY_ESCROW_ADDRESS not set. Deploy GroupBuyEscrow and add the address to .env.
      </div>
    );
  }

  if (step === "done" && listConfirmed) {
    return (
      <div className="wizard-step wizard-step--success">
        <p>Group buy listed! Contributors can now add ETH.</p>
        <button className="btn" onClick={onClose}>Close</button>
      </div>
    );
  }

  const soldPct = mode === "partial" ? (100 - parseFloat(sellerKeepPct || "0")).toFixed(1) : "100";
  const soldEth = mode === "partial" && price
    ? ((100 - parseFloat(sellerKeepPct || "0")) / 100 * parseFloat(price)).toFixed(4)
    : price;

  return (
    <div className="wizard-step">
      <h3 className="wizard-step__title">
        {mode === "group" ? "Group Buy Listing" : "Partial Sale Listing"}
      </h3>
      <p className="muted one-liner">
        {mode === "group"
          ? "Contributors pool ETH. When fully funded, each contributor gets a proportional share of the fee rights."
          : "Keep a share of fee rights forever, sell the rest. Contributors split the sold portion."}
      </p>

      <div className="wizard-step__tabs" style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <button
          className={`btn btn--sm ${mode === "group" ? "" : "btn--ghost"}`}
          onClick={() => setMode("group")}
        >
          Group Buy
        </button>
        <button
          className={`btn btn--sm ${mode === "partial" ? "" : "btn--ghost"}`}
          onClick={() => setMode("partial")}
        >
          Partial Sale
        </button>
      </div>

      <label className="wizard-step__label">TMPR Token ID</label>
      <input
        className="wizard-step__input"
        placeholder="e.g. 12345678..."
        value={tokenId}
        onChange={e => setTokenId(e.target.value)}
        disabled={!!preselectedTokenId}
      />

      <label className="wizard-step__label">
        {mode === "partial" ? `Sale price (ETH) for ${soldPct}% of rights` : "Target raise (ETH)"}
      </label>
      <input
        className="wizard-step__input"
        placeholder="e.g. 0.1"
        value={price}
        type="number"
        min="0"
        step="0.001"
        onChange={e => setPrice(e.target.value)}
      />

      {mode === "partial" && (
        <>
          <label className="wizard-step__label">You keep (% of fee rights)</label>
          <input
            className="wizard-step__input"
            placeholder="80"
            value={sellerKeepPct}
            type="number"
            min="1"
            max="99"
            step="1"
            onChange={e => setSellerKeepPct(e.target.value)}
          />
          {price && (
            <p className="muted one-liner">
              Buyers pay <strong>{soldEth} ETH</strong> total for <strong>{soldPct}%</strong> of future fees.
              You keep <strong>{sellerKeepPct}%</strong> of future fees + receive the ETH.
            </p>
          )}
        </>
      )}

      <label className="wizard-step__label">Duration (hours)</label>
      <input
        className="wizard-step__input"
        placeholder="24"
        value={hours}
        type="number"
        min="0.1"
        max={String(30 * 24)}
        step="1"
        onChange={e => setHours(e.target.value)}
      />

      <label className="wizard-step__label">Min contribution (ETH, 0 = any)</label>
      <input
        className="wizard-step__input"
        placeholder="0"
        value={minContrib}
        type="number"
        min="0"
        step="0.001"
        onChange={e => setMinContrib(e.target.value)}
      />

      {error && <div className="error-bar">{error.slice(0, 160)}</div>}

      <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
        {!approved && step === "form" && (
          <button
            className="btn"
            disabled={!tokenId || !price}
            onClick={() => setStep("approve")}
          >
            Continue →
          </button>
        )}
        {step === "approve" && (
          <button className="btn" onClick={handleApprove}>
            Approve NFT Transfer
          </button>
        )}
        {step === "list" && (
          <button className="btn btn--accent" onClick={handleList}>
            List for Group Buy
          </button>
        )}
        {onClose && (
          <button className="btn btn--ghost" onClick={onClose}>Cancel</button>
        )}
      </div>
    </div>
  );
}

// ── Subcomponent: Open listing card ──────────────────────────────────────────

function GroupBuyCard({
  listingId,
  listing,
  onFinalized,
}: {
  listingId: bigint;
  listing: GroupBuyListing;
  onFinalized?: () => void;
}) {
  const { address } = useAccount();
  const chainId = useChainId();
  const config = useConfig();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  const [contribution, setContribution] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [distributing, setDistributing] = useState(false);
  const [distributeTxHash, setDistributeTxHash] = useState<string | null>(null);

  const pct = pctFilled(listing);
  const isExpired = BigInt(Math.floor(Date.now() / 1000)) > listing.deadline;
  const isFullyFunded = listing.totalRaised >= listing.priceWei;
  const canFinalize = isFullyFunded && !listing.finalized;
  const canRefund = isExpired && !isFullyFunded && !listing.finalized && listing.active;
  const isPartial = listing.sellerKeepsBps > 0;

  const { writeContractAsync: contributeWrite, data: contribTxHash } = useWriteContract();
  const { writeContractAsync: finalizeWrite, data: finalizeTxHash } = useWriteContract();
  const { writeContractAsync: refundWrite } = useWriteContract();
  const { isSuccess: contribConfirmed } = useWaitForTransactionReceipt({ hash: contribTxHash });
  const { isSuccess: finalizeConfirmed } = useWaitForTransactionReceipt({ hash: finalizeTxHash });

  const handleContribute = useCallback(async () => {
    if (!address || !contribution) return;
    setError(null);
    try {
      await ensureBaseChain(config);
      await contributeWrite({
        address: GROUP_BUY_ESCROW_ADDRESS,
        abi: groupBuyEscrowAbi,
        functionName: "contribute",
        args: [listingId],
        value: parseEther(contribution),
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [address, contribution, listingId, chainId, config, contributeWrite]);

  const handleFinalize = useCallback(async () => {
    setError(null);
    try {
      await ensureBaseChain(config);
      await finalizeWrite({
        address: GROUP_BUY_ESCROW_ADDRESS,
        abi: groupBuyEscrowAbi,
        functionName: "finalize",
        args: [listingId],
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [listingId, chainId, config, finalizeWrite]);

  const handleRefund = useCallback(async () => {
    setError(null);
    try {
      await ensureBaseChain(config);
      await refundWrite({
        address: GROUP_BUY_ESCROW_ADDRESS,
        abi: groupBuyEscrowAbi,
        functionName: "refundAll",
        args: [listingId],
      });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [listingId, chainId, config, refundWrite]);

  const handleDistribute = useCallback(async () => {
    if (!publicClient || !walletClient || !listing.splitAddress || listing.splitAddress === "0x0000000000000000000000000000000000000000") return;
    setError(null);
    setDistributing(true);
    try {
      const { txHash } = await distributeSplit(
        listing.splitAddress,
        ETH_TOKEN,
        publicClient,
        walletClient,
      );
      setDistributeTxHash(txHash);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDistributing(false);
    }
  }, [publicClient, walletClient, listing.splitAddress]);

  if (finalizeConfirmed) onFinalized?.();

  const soldBps = 10000 - listing.sellerKeepsBps;

  return (
    <div className="bankr-panel" style={{ marginBottom: "1rem" }}>
      <div className="bankr-panel__row">
        <span className="bankr-panel__name">
          TMPR #{listing.tokenId.toString().slice(0, 10)}…
        </span>
        <span style={{ fontSize: "0.75rem" }}>
          {isPartial
            ? `Partial Sale — ${(soldBps / 100).toFixed(0)}% for sale`
            : "Group Buy"}
        </span>
      </div>

      <div className="bankr-panel__list">
        <li>Seller: <span className="mono">{shortAddr(listing.seller)}</span></li>
        <li>
          Price: <strong>{formatEther(listing.priceWei)} ETH</strong>
          {isPartial && ` for ${(soldBps / 100).toFixed(1)}% of rights`}
        </li>
        <li>Raised: <strong>{formatEther(listing.totalRaised)} ETH</strong> ({pct}%)</li>
        <li>Deadline: {formatCountdown(listing.deadline)}</li>
        {listing.minContributionWei > 0n && (
          <li>Min contribution: {formatEther(listing.minContributionWei)} ETH</li>
        )}
      </div>

      {/* Progress bar */}
      <div style={{
        background: "var(--border)", borderRadius: "2px", height: "4px",
        margin: "0.5rem 0", overflow: "hidden",
      }}>
        <div style={{
          background: "var(--accent)", height: "100%",
          width: `${Math.min(pct, 100)}%`, transition: "width 0.3s",
        }} />
      </div>

      {/* Finalized: show split + distribute */}
      {listing.finalized && listing.splitAddress !== "0x0000000000000000000000000000000000000000" && (
        <div style={{ marginTop: "0.5rem" }}>
          <p className="muted one-liner">
            Finalized — split:{" "}
            <a
              href={`https://app.splits.org/accounts/${listing.splitAddress}/?chainId=${base.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mono"
            >
              {shortAddr(listing.splitAddress)}
            </a>
          </p>
          <button
            className="btn btn--sm btn--accent"
            disabled={distributing}
            onClick={handleDistribute}
          >
            {distributing ? "Distributing…" : "Distribute & Claim Fees"}
          </button>
          {distributeTxHash && (
            <p className="muted one-liner">
              Distributed!{" "}
              <a href={`https://basescan.org/tx/${distributeTxHash}`} target="_blank" rel="noopener noreferrer">
                View tx ↗
              </a>
            </p>
          )}
        </div>
      )}

      {/* Active: contribute + finalize + refund */}
      {listing.active && !listing.finalized && (
        <div style={{ marginTop: "0.75rem" }}>
          {canFinalize ? (
            <button className="btn btn--accent btn--sm" onClick={handleFinalize}>
              Finalize (Fully Funded)
            </button>
          ) : canRefund ? (
            <button className="btn btn--sm" onClick={handleRefund}>
              Trigger Refund (Expired)
            </button>
          ) : (
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
              <input
                className="wizard-step__input"
                style={{ maxWidth: "120px", margin: 0 }}
                placeholder="0.01"
                value={contribution}
                type="number"
                min="0"
                step="0.001"
                onChange={e => setContribution(e.target.value)}
              />
              <button
                className="btn btn--sm btn--accent"
                disabled={!contribution}
                onClick={handleContribute}
              >
                Contribute ETH
              </button>
            </div>
          )}
          {contribConfirmed && <p className="muted one-liner">Contribution confirmed!</p>}
        </div>
      )}

      {error && <div className="error-bar" style={{ marginTop: "0.5rem" }}>{error.slice(0, 160)}</div>}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function GroupBuyWizard({ preselectedTokenId, collectionAddress, onClose }: Props) {
  const [view, setView] = useState<Mode>(preselectedTokenId ? "list" : "view");
  const [refreshKey, setRefreshKey] = useState(0);

  const { data: nextId } = useReadContract({
    address: GROUP_BUY_ESCROW_ADDRESS,
    abi: groupBuyEscrowAbi,
    functionName: "nextListingId",
    query: { enabled: !!GROUP_BUY_ESCROW_ADDRESS, refetchInterval: 10_000 },
  });

  // Fetch all listings (1..nextId-1)
  const listingIds: bigint[] = nextId
    ? Array.from({ length: Number(nextId) - 1 }, (_, i) => BigInt(i + 1))
    : [];

  if (!GROUP_BUY_ESCROW_ADDRESS) {
    return (
      <div className="bankr-panel">
        <p className="muted">Group buy not configured. Set VITE_GROUP_BUY_ESCROW_ADDRESS in .env.</p>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem", alignItems: "center" }}>
        <button
          className={`btn btn--sm ${view === "view" ? "" : "btn--ghost"}`}
          onClick={() => setView("view")}
        >
          All Group Buys
        </button>
        <button
          className={`btn btn--sm ${view === "list" ? "" : "btn--ghost"}`}
          onClick={() => setView("list")}
        >
          + List for Group Buy
        </button>
      </div>

      {view === "list" && (
        <ListForm
          preselectedTokenId={preselectedTokenId}
          collectionAddress={collectionAddress}
          onClose={() => { setView("view"); onClose?.(); }}
        />
      )}

      {view === "view" && (
        <>
          {listingIds.length === 0 ? (
            <p className="muted" style={{ textAlign: "center", padding: "2rem 0" }}>
              No group buys yet.{" "}
              <button className="btn btn--ghost btn--sm" onClick={() => setView("list")}>
                Create the first one
              </button>
            </p>
          ) : (
            <GroupBuyListingsFetcher
              key={refreshKey}
              listingIds={listingIds}
              onFinalized={() => setRefreshKey(k => k + 1)}
            />
          )}
        </>
      )}
    </div>
  );
}

/** Fetches and renders each listing individually. */
function GroupBuyListingsFetcher({
  listingIds,
  onFinalized,
}: {
  listingIds: bigint[];
  onFinalized?: () => void;
}) {
  return (
    <>
      {listingIds.map(id => (
        <SingleListingFetcher key={id.toString()} listingId={id} onFinalized={onFinalized} />
      ))}
    </>
  );
}

function SingleListingFetcher({
  listingId,
  onFinalized,
}: {
  listingId: bigint;
  onFinalized?: () => void;
}) {
  const { data: listing } = useReadContract({
    address: GROUP_BUY_ESCROW_ADDRESS,
    abi: groupBuyEscrowAbi,
    functionName: "getListing",
    args: [listingId],
    query: { enabled: !!GROUP_BUY_ESCROW_ADDRESS, refetchInterval: 8_000 },
  });

  if (!listing) return null;

  // Hide cancelled/inactive non-finalized listings (no contributors)
  if (!listing.active && !listing.finalized) return null;

  const typedListing: GroupBuyListing = {
    collection: listing.collection as `0x${string}`,
    tokenId: listing.tokenId,
    seller: listing.seller as `0x${string}`,
    priceWei: listing.priceWei,
    deadline: listing.deadline,
    minContributionWei: listing.minContributionWei,
    sellerKeepsBps: listing.sellerKeepsBps,
    bankrEscrow: listing.bankrEscrow as `0x${string}`,
    totalRaised: listing.totalRaised,
    splitAddress: listing.splitAddress as `0x${string}`,
    active: listing.active,
    finalized: listing.finalized,
  };

  return (
    <GroupBuyCard
      listingId={listingId}
      listing={typedListing}
      onFinalized={onFinalized}
    />
  );
}
