import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useAccount,
  useConnect,
  useDisconnect,
  usePublicClient,
  useReadContract,
  useWriteContract,
  useChainId,
  useSwitchChain,
} from "wagmi";
import type { PublicClient } from "viem";
import {
  isAddress,
  parseAbiItem,
  parseEther,
  formatEther,
  getAddress,
  type Address,
} from "viem";
import { feeRightsFixedSaleAbi } from "./lib/feeRightsFixedSaleAbi";
import { bankrFeeRightsReceiptAbi } from "./lib/bankrFeeRightsReceiptAbi";
import { MVP_CHAIN_ID } from "./chain";
import { walletConnectConfigured } from "./wagmi";
import { EscrowWizard } from "./EscrowWizard";
import { normalizePoolId } from "./lib/escrowArgs";

// ── Constants ────────────────────────────────────────────────────────────────

const GETLOGS_MAX_BLOCK_SPAN = 10_000n;
const MAX_LISTING_IDS_TO_SCAN = 250n;
const DEFAULT_SCAN_BLOCKS = 80_000n;

// ── Helpers ──────────────────────────────────────────────────────────────────

function tryParseAddress(raw: string): Address | undefined {
  const t = raw.trim();
  if (!t || !isAddress(t, { strict: false })) return undefined;
  try { return getAddress(t); } catch { return undefined; }
}

/** Plain hint when pasted `poolId` is not exactly 32 bytes hex. */
function explainPoolIdPasteError(raw: string): string {
  const t = raw.trim();
  if (!t) return "Paste the pool id from your Prepare deposit transaction (see “Where do I find this?”).";
  if (!t.startsWith("0x")) return "Pool id must start with 0x.";
  const body = t.slice(2);
  const hexOnly = body.replace(/[^0-9a-fA-F]/g, "");
  if (hexOnly.length !== body.length) {
    return "Remove spaces, line breaks, or quotes — use only 0x and hex characters.";
  }
  if (hexOnly.length !== 64) {
    return `You have ${hexOnly.length} hex digits after 0x; the pool id must be exactly 64 (66 characters including 0x). On BaseScan decode your Prepare deposit input and copy only the poolId value.`;
  }
  return "That pool id could not be read — try copying it again from BaseScan.";
}

function envAddr(name: string): string {
  const raw = (import.meta as ImportMeta).env[name];
  return typeof raw === "string" ? (tryParseAddress(raw) ?? "") : "";
}

const ESCROW_DEFAULT: Address = "0xFb28D9C636514f8a9D129873750F9b886707d95F";

function escrowAddressFromEnv(): Address {
  const raw = (import.meta as ImportMeta).env.VITE_ESCROW_ADDRESS;
  if (typeof raw === "string") {
    const a = tryParseAddress(raw.trim());
    if (a) return a;
  }
  return ESCROW_DEFAULT;
}

const ESCROW_ADDRESS: Address = escrowAddressFromEnv();

function shortAddr(addr: string) {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

/** Normalize Bankr JSON into table rows (launches[] or creator-fees tokens[]). */
function extractBankrLaunchRows(data: unknown): Record<string, unknown>[] {
  const asArr = (v: unknown) => (Array.isArray(v) ? v : null);
  const walk = (v: unknown): Record<string, unknown>[] | null => {
    const direct = asArr(v);
    if (direct) return direct as Record<string, unknown>[];
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    for (const key of ["tokens", "launches", "results", "items", "data", "rows"]) {
      if (key in o) {
        const inner = walk(o[key]);
        if (inner) return inner;
      }
    }
    return null;
  };
  return walk(data)?.filter((x) => x && typeof x === "object") ?? [];
}

function launchRowLabel(row: Record<string, unknown>): string {
  for (const k of ["tokenSymbol", "symbol", "name", "title", "ticker", "slug", "id", "launchId"]) {
    const v = row[k];
    if (typeof v === "string" && v.trim()) return v;
    if (typeof v === "number") return String(v);
  }
  const ta = row.tokenAddress;
  if (typeof ta === "string" && ta.length > 10) return `${ta.slice(0, 6)}…${ta.slice(-4)}`;
  return "Token";
}

function launchRowHref(row: Record<string, unknown>, wallet: string): string {
  const url = row.url ?? row.href ?? row.link;
  if (typeof url === "string" && url.startsWith("http")) return url;
  const ta = row.tokenAddress;
  if (typeof ta === "string" && ta.startsWith("0x"))
    return `https://bankr.bot/launches/search?q=${encodeURIComponent(ta)}`;
  const id = row.id ?? row.launchId ?? row.slug;
  if (typeof id === "string" && id.length > 0)
    return `https://bankr.bot/launches/${encodeURIComponent(id)}`;
  return `https://bankr.bot/launches/search?q=${encodeURIComponent(wallet)}`;
}

function parseNftImage(tokenUri: unknown): string | null {
  if (!tokenUri || typeof tokenUri !== "string") return null;
  try {
    const b64 = tokenUri.replace("data:application/json;base64,", "");
    const json = JSON.parse(atob(b64)) as { image?: string };
    return json.image ?? null;
  } catch { return null; }
}

// ── ABIs (minimal inline) ────────────────────────────────────────────────────

const erc721Abi = [
  { type: "function", name: "approve", stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "tokenId", type: "uint256" }], outputs: [] },
  { type: "function", name: "getApproved", stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "isApprovedForAll", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "operator", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "ownerOf", stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ type: "address" }] },
] as const;

const escrowAbi = [
  { type: "function", name: "redeemRights", stateMutability: "nonpayable",
    inputs: [{ name: "tokenId", type: "uint256" }], outputs: [] },
] as const;

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
);

// ── Log chunker ──────────────────────────────────────────────────────────────

async function getTransferLogsChunked(
  client: PublicClient,
  { collection, recipient, fromBlock, toBlock }: {
    collection: Address; recipient: Address; fromBlock: bigint; toBlock: bigint;
  },
) {
  const out = [];
  let start = fromBlock;
  while (start <= toBlock) {
    const end = start + GETLOGS_MAX_BLOCK_SPAN - 1n <= toBlock
      ? start + GETLOGS_MAX_BLOCK_SPAN - 1n : toBlock;
    const chunk = await client.getLogs({
      address: collection, event: transferEvent,
      args: { to: recipient }, fromBlock: start, toBlock: end,
    });
    out.push(...chunk);
    start = end + 1n;
  }
  return out;
}

// ── Listing fetcher ──────────────────────────────────────────────────────────

type ActiveListing = {
  listingId: bigint; collection: Address; tokenId: bigint;
  seller: string; priceWei: bigint; active: boolean;
};

async function fetchActiveListings(
  client: PublicClient, marketplace: Address, nextId: bigint,
): Promise<ActiveListing[]> {
  if (nextId <= 1n) return [];
  const maxId = nextId - 1n;
  const limit = maxId > MAX_LISTING_IDS_TO_SCAN ? MAX_LISTING_IDS_TO_SCAN : maxId;
  const out: ActiveListing[] = [];
  const BATCH = 28;
  let start = 1n;
  while (start <= limit) {
    const calls: { address: Address; abi: typeof feeRightsFixedSaleAbi; functionName: "getListing"; args: readonly [bigint] }[] = [];
    let id = start, n = 0;
    while (n < BATCH && id <= limit) { calls.push({ address: marketplace, abi: feeRightsFixedSaleAbi, functionName: "getListing", args: [id] }); id++; n++; }
    const res = await client.multicall({ contracts: calls, allowFailure: true });
    for (let i = 0; i < res.length; i++) {
      const r = res[i]!;
      if (r.status !== "success") continue;
      const li = r.result as { collection: Address; tokenId: bigint; seller: string; priceWei: bigint; active: boolean };
      if (li.active) out.push({ listingId: start + BigInt(i), ...li });
    }
    start += BigInt(calls.length);
  }
  return out;
}

// ── BfrrCard ─────────────────────────────────────────────────────────────────

function BfrrCard({ tokenId: id, collection, selected, wrongNetwork, onClick, staticDisplay }: {
  tokenId: string; collection: Address; selected: boolean;
  wrongNetwork: boolean; onClick?: () => void;
  /** When true, render a non-interactive preview (e.g. next to profile actions). */
  staticDisplay?: boolean;
}) {
  const tid = useMemo(() => { try { return BigInt(id); } catch { return null; } }, [id]);

  const { data: rawUri } = useReadContract({
    address: collection, abi: bankrFeeRightsReceiptAbi, functionName: "tokenURI",
    args: tid !== null ? [tid] : undefined, chainId: MVP_CHAIN_ID,
    query: { enabled: tid !== null && !wrongNetwork },
  });
  const { data: serial } = useReadContract({
    address: collection, abi: bankrFeeRightsReceiptAbi, functionName: "serialOf",
    args: tid !== null ? [tid] : undefined, chainId: MVP_CHAIN_ID,
    query: { enabled: tid !== null && !wrongNetwork },
  });

  const imgSrc = useMemo(() => parseNftImage(rawUri), [rawUri]);

  const body = (
    <>
      {imgSrc ? (
        <img className="bfrr-card__img" src={imgSrc}
          alt={serial !== undefined ? `BFRR #${String(serial)}` : "BFRR"} />
      ) : (
        <div className="bfrr-card__img-placeholder">
          <span className="bfrr-card__badge">BFRR</span>
          {serial !== undefined && <span className="bfrr-card__serial">#{String(serial)}</span>}
        </div>
      )}
      <div className="bfrr-card__footer">
        <div className="bfrr-card__id" title={id}>
          {serial !== undefined ? `#${String(serial)}` : id.slice(0, 6) + "…" + id.slice(-4)}
        </div>
      </div>
    </>
  );

  if (staticDisplay) {
    return (
      <div className={`bfrr-card bfrr-card--static${selected ? " active" : ""}`}>
        {body}
      </div>
    );
  }

  return (
    <button type="button" className={`bfrr-card${selected ? " active" : ""}`} onClick={onClick}>
      {body}
    </button>
  );
}

// ── ListingCard ───────────────────────────────────────────────────────────────

function ListingCard({ li, bfrr, address, txDisabled, isConnected, wrongNetwork, onBuy, onCancel }: {
  li: ActiveListing; bfrr: Address | undefined; address: Address | undefined;
  txDisabled: boolean; isConnected: boolean; wrongNetwork: boolean;
  onBuy: () => void; onCancel: () => void;
}) {
  const isBfrr = bfrr !== undefined && getAddress(li.collection) === getAddress(bfrr);

  const { data: rawUri } = useReadContract({
    address: isBfrr ? li.collection : undefined, abi: bankrFeeRightsReceiptAbi,
    functionName: "tokenURI", args: [li.tokenId], chainId: MVP_CHAIN_ID,
    query: { enabled: isBfrr && !wrongNetwork },
  });
  const { data: serial } = useReadContract({
    address: isBfrr ? li.collection : undefined, abi: bankrFeeRightsReceiptAbi,
    functionName: "serialOf", args: [li.tokenId], chainId: MVP_CHAIN_ID,
    query: { enabled: isBfrr && !wrongNetwork },
  });

  const imgSrc = useMemo(() => parseNftImage(rawUri), [rawUri]);
  const imSeller = address !== undefined && isAddress(li.seller) &&
    getAddress(li.seller) === getAddress(address);

  return (
    <div className="listing-card">
      {imgSrc ? (
        <img className="listing-card__img" src={imgSrc}
          alt={serial !== undefined ? `BFRR #${String(serial)}` : "BFRR"} />
      ) : (
        <div className="listing-card__img-placeholder">
          <span className="bfrr-card__badge">BFRR</span>
          {serial !== undefined && <span className="bfrr-card__serial">#{String(serial)}</span>}
        </div>
      )}
      <div className="listing-card__body">
        <div className="listing-card__price">{formatEther(li.priceWei)} ETH</div>
        <div className="listing-card__meta">
          <div className="listing-card__meta-row">
            <span>From</span>
            <span className="mono">{shortAddr(li.seller)}</span>
          </div>
          <div className="listing-card__meta-row">
            <span>Item</span>
            <span className="mono">{serial !== undefined ? `#${String(serial)}` : shortAddr(li.tokenId.toString())}</span>
          </div>
        </div>
        <div className="listing-card__actions">
          {imSeller ? (
            <button type="button" className="btn btn-danger btn-sm btn-full"
              disabled={txDisabled} onClick={onCancel}>
              Cancel sale
            </button>
          ) : (
            <button type="button" className="btn btn-primary btn-full"
              disabled={!isConnected || txDisabled}
              title={!isConnected ? "Connect wallet to buy" : undefined}
              onClick={onBuy}>
              Buy · {formatEther(li.priceWei)} ETH
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── SellPanel ────────────────────────────────────────────────────────────────

function SellPanel({ tokenIdStr, collection, marketplace, address, txDisabled,
  wrongNetwork, isConnected, onDone }: {
  tokenIdStr: string; collection: Address; marketplace: Address;
  address: Address | undefined; txDisabled: boolean;
  wrongNetwork: boolean; isConnected: boolean; onDone: () => void;
}) {
  const [price, setPrice] = useState("0.01");
  const { writeContractAsync, isPending } = useWriteContract();

  const tokenId = useMemo(() => { try { return BigInt(tokenIdStr); } catch { return null; } }, [tokenIdStr]);
  const enabled = !wrongNetwork && !txDisabled && tokenId !== null;

  const { data: approvedSpender } = useReadContract({
    address: collection, abi: erc721Abi, functionName: "getApproved",
    args: tokenId !== null ? [tokenId] : undefined, chainId: MVP_CHAIN_ID,
    query: { enabled: enabled && isConnected },
  });
  const { data: approvedAll } = useReadContract({
    address: collection, abi: erc721Abi, functionName: "isApprovedForAll",
    args: address ? [address, marketplace] : undefined, chainId: MVP_CHAIN_ID,
    query: { enabled: enabled && Boolean(address) },
  });
  const { data: bfrrOwner } = useReadContract({
    address: collection, abi: erc721Abi, functionName: "ownerOf",
    args: tokenId !== null ? [tokenId] : undefined, chainId: MVP_CHAIN_ID,
    query: { enabled: enabled },
  });

  const canPull = Boolean(
    (typeof approvedSpender === "string" && isAddress(approvedSpender) &&
     getAddress(approvedSpender as Address) === getAddress(marketplace)) ||
    approvedAll === true
  );
  const isBfrrOwner = address !== undefined && typeof bfrrOwner === "string" &&
    isAddress(bfrrOwner) && getAddress(bfrrOwner as Address) === getAddress(address);
  const priceNorm = price.trim().replace(",", ".");
  const priceOk = Number.isFinite(parseFloat(priceNorm)) && parseFloat(priceNorm) > 0;

  const run = async (fn: () => Promise<unknown>) => { try { await fn(); } catch { /* surfaced by writeError */ } };

  return (
    <div className="sell-panel">
      <div className="sell-panel__title">
        List for sale
        <span className="tag mono">{tokenIdStr.slice(0, 6)}…{tokenIdStr.slice(-4)}</span>
        <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: "auto" }}
          onClick={onDone}>✕</button>
      </div>

      <div className="sell-row">
        <label>Asking price</label>
        <div className="price-wrap">
          <input value={price} onChange={e => setPrice(e.target.value)} placeholder="0.01" />
          <span className="price-suffix">ETH</span>
        </div>
      </div>

      <div className="sell-actions">
        {canPull ? (
          <span className="approved-tag">Ready to list</span>
        ) : (
          <button type="button" className="btn btn-ghost"
            disabled={txDisabled || tokenId === null}
            onClick={() => run(async () => {
              await writeContractAsync({
                address: collection, abi: erc721Abi, functionName: "approve",
                args: [marketplace, tokenId!], chainId: MVP_CHAIN_ID,
              });
            })}>
            {isPending ? <><span className="spinner" />Wallet…</> : "Allow marketplace"}
          </button>
        )}
        <button type="button" className="btn btn-primary"
          disabled={txDisabled || !canPull || !priceOk || tokenId === null}
          onClick={() => run(async () => {
            await writeContractAsync({
              address: marketplace, abi: feeRightsFixedSaleAbi, functionName: "list",
              args: [collection, tokenId!, parseEther(priceNorm)], chainId: MVP_CHAIN_ID,
            });
            onDone();
          })}>
          {isPending ? <><span className="spinner" />Wallet…</> : "List"}
        </button>
      </div>

      <div className="redeem-row">
        <div className="redeem-label">
          <span>Leave escrow</span>
          <strong className="muted" style={{ fontWeight: 500, fontSize: "0.78rem" }}>
            Returns creator fees to you and removes the receipt from sale.
          </strong>
        </div>
        <button type="button" className="btn btn-ghost btn-sm"
          disabled={txDisabled || !isBfrrOwner || tokenId === null}
          title={!isBfrrOwner ? "Use the wallet that holds this item" : undefined}
          onClick={() => run(async () => {
            await writeContractAsync({
              address: ESCROW_ADDRESS, abi: escrowAbi, functionName: "redeemRights",
              args: [tokenId!], chainId: MVP_CHAIN_ID,
            });
          })}>
          {isPending ? <><span className="spinner" />…</> : "Cancel escrow"}
        </button>
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const qc = useQueryClient();
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { connect, connectors, isPending: connectPending, variables: connectVars } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switchPending } = useSwitchChain();
  const { writeContractAsync, isPending: writePending, error: writeError } = useWriteContract();
  const publicClient = usePublicClient();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scannedIds, setScannedIds] = useState<string[]>([]);
  const [manualIds, setManualIds] = useState<string[]>([]);
  const [pasteId, setPasteId] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanErr, setScanErr] = useState<string | null>(null);
  const [bankrLoading, setBankrLoading] = useState(false);
  const [bankrErr, setBankrErr] = useState<string | null>(null);
  const [bankrRows, setBankrRows] = useState<Record<string, unknown>[]>([]);
  const [escrowWizardRow, setEscrowWizardRow] = useState<Record<string, unknown> | null>(null);
  const [receiptManualPool, setReceiptManualPool] = useState("");
  const [receiptManualToken, setReceiptManualToken] = useState("");
  const [receiptManualErr, setReceiptManualErr] = useState<string | null>(null);
  const [scanEpoch, setScanEpoch] = useState(0);
  const [mainTab, setMainTab] = useState<"home" | "profile">("home");

  const marketplace = tryParseAddress(envAddr("VITE_MARKETPLACE_ADDRESS"));
  const collection = tryParseAddress(envAddr("VITE_DEFAULT_RECEIPT_COLLECTION"));
  const wrongNetwork = isConnected && chainId !== MVP_CHAIN_ID;
  const txDisabled  = !isConnected || writePending || wrongNetwork;

  const scanBlockSpan = useMemo(() => {
    const raw = (import.meta as ImportMeta).env.VITE_RECEIPT_SCAN_BLOCKS;
    const n = typeof raw === "string" ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? BigInt(Math.min(n, 500_000)) : DEFAULT_SCAN_BLOCKS;
  }, []);

  const allTokenIds = useMemo(() => {
    const set = new Set([...scannedIds, ...manualIds]);
    return [...set].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  }, [scannedIds, manualIds]);

  // Auto-scan when wallet connects (on-chain only — same wallet that holds the BFRR)
  useEffect(() => {
    if (!isConnected || !address || !collection || !publicClient || wrongNetwork) return;
    setScannedIds([]);
    setManualIds([]);
    setSelectedId(null);
    setScanErr(null);
    setScanning(true);
    (async () => {
      try {
        const latest = await publicClient.getBlockNumber();
        const from = latest > scanBlockSpan ? latest - scanBlockSpan : 0n;
        const logs = await getTransferLogsChunked(publicClient, {
          collection, recipient: getAddress(address), fromBlock: from, toBlock: latest,
        });
        const ids = [...new Set(
          logs.map(l => l.args.tokenId).filter((t): t is bigint => typeof t === "bigint")
            .map(x => x.toString())
        )];
        setScannedIds(ids);
      } catch (e) {
        setScanErr(
          e instanceof Error ? e.message : "Could not scan transfers — check RPC or try pasting your token ID below.",
        );
      } finally { setScanning(false); }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, address, collection?.toLowerCase(), wrongNetwork, scanEpoch]);

  // Listings
  const { data: nextListingId } = useReadContract({
    address: marketplace, abi: feeRightsFixedSaleAbi, functionName: "nextListingId",
    chainId: MVP_CHAIN_ID, query: { enabled: Boolean(marketplace && !wrongNetwork) },
  });

  const { data: activeListings = [], isLoading: listingsLoading, refetch: refetchListings } = useQuery({
    queryKey: ["listings", marketplace, (nextListingId ?? 0n).toString()],
    queryFn: async () => {
      if (!publicClient || !marketplace || nextListingId === undefined) return [];
      return fetchActiveListings(publicClient, marketplace, nextListingId as bigint);
    },
    enabled: Boolean(publicClient && marketplace && nextListingId !== undefined && !wrongNetwork),
    staleTime: 12_000,
  });

  const myListings = useMemo(() => {
    if (!address) return [];
    const me = getAddress(address);
    return (activeListings as ActiveListing[]).filter(
      (li) => isAddress(li.seller) && getAddress(li.seller) === me,
    );
  }, [activeListings, address]);

  const myListedTokenIds = useMemo(() => {
    const set = new Set<string>();
    if (!collection) return set;
    const col = getAddress(collection);
    for (const li of myListings) {
      if (getAddress(li.collection) === col) set.add(li.tokenId.toString());
    }
    return set;
  }, [myListings, collection]);

  const unlistedBfrrIds = useMemo(
    () => allTokenIds.filter((id) => !myListedTokenIds.has(id)),
    [allTokenIds, myListedTokenIds],
  );

  const invalidate = () => void qc.invalidateQueries();
  const run = async (fn: () => Promise<unknown>) => {
    try { await fn(); invalidate(); } catch { /* surfaced via writeError */ }
  };

  const loadBankrLaunches = useCallback(async () => {
    if (!address) return;
    setBankrLoading(true);
    setBankrErr(null);
    try {
      const res = await fetch(`/api/bankr-launches?q=${encodeURIComponent(address)}`);
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        hint?: string;
        data?: unknown;
      };
      if (!json.ok) {
        setBankrErr(
          [json.error, json.hint].filter(Boolean).join(" — ") || `HTTP ${res.status}`,
        );
        return;
      }
      setBankrRows(extractBankrLaunchRows(json.data));
    } catch (e) {
      setBankrErr(
        e instanceof Error
          ? e.message
          : "Could not reach /api/bankr-launches (deploy on Vercel or run vercel dev).",
      );
    } finally {
      setBankrLoading(false);
    }
  }, [address]);

  useEffect(() => {
    if (!address) {
      setBankrRows([]);
      setBankrErr(null);
      setBankrLoading(false);
      return;
    }
    setBankrRows([]);
    setBankrErr(null);
  }, [address]);

  useEffect(() => {
    if (!isConnected || !address || wrongNetwork) return;
    void loadBankrLaunches();
  }, [isConnected, address, wrongNetwork, loadBankrLaunches]);

  return (
    <div>
      <nav className="nav">
        <div className="nav-left">
          <div className="nav-logo">Bankr <span>Sale</span></div>
          <div className="app-tabs" role="tablist" aria-label="Main sections">
            <button
              type="button"
              role="tab"
              aria-selected={mainTab === "home"}
              className={`app-tab${mainTab === "home" ? " app-tab--active" : ""}`}
              onClick={() => setMainTab("home")}
            >
              Home
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mainTab === "profile"}
              className={`app-tab${mainTab === "profile" ? " app-tab--active" : ""}`}
              onClick={() => setMainTab("profile")}
            >
              My profile
            </button>
          </div>
        </div>
        <div className="nav-right">
          {isConnected && address ? (
            <div className="wallet-pill">
              <span className="wallet-dot" />
              <span className="wallet-addr">{shortAddr(address)}</span>
              <button className="gear-btn" onClick={() => disconnect()} title="Disconnect">✕</button>
            </div>
          ) : (
            <div className="connect-strip">
              {connectors.map((c, i) => {
                const label = typeof c === "object" && "name" in c ? String((c as { name: string }).name) : "Wallet";
                const uid = typeof c === "object" && "uid" in c ? (c as { uid: string }).uid : null;
                const cvUid = typeof connectVars?.connector === "object" && connectVars.connector !== null && "uid" in connectVars.connector
                  ? (connectVars.connector as { uid: string }).uid : null;
                const busy = connectPending && uid && cvUid && uid === cvUid;
                return (
                  <button key={`${i}-${label}`} type="button" className="btn btn-ghost btn-sm"
                    disabled={connectPending}
                    onClick={() => connect({ connector: c, chainId: MVP_CHAIN_ID })}>
                    {busy ? "…" : label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </nav>

      {wrongNetwork && (
        <div className="network-banner">
          <span>Use Base to trade here</span>
          <button className="btn btn-ghost btn-sm" disabled={switchPending}
            onClick={() => switchChain?.({ chainId: MVP_CHAIN_ID })}>
            {switchPending ? "Switching…" : "Switch to Base"}
          </button>
        </div>
      )}

      {mainTab === "home" && (
        <>
          <div className="hero hero--compact">
            <h1>Tokens for sale</h1>
            <p className="muted">Creator fee rights · Base</p>
          </div>

          <section>
            <div className="section-head">
              <h2>All listings</h2>
              <button type="button" className="btn btn-ghost btn-sm"
                disabled={!marketplace || listingsLoading}
                onClick={() => void refetchListings()}>
                Refresh
              </button>
            </div>

            {listingsLoading && <p className="empty"><span className="spinner" />Loading…</p>}

            {!listingsLoading && (activeListings as ActiveListing[]).length === 0 && (
              <p className="empty">{marketplace ? "Nothing for sale right now." : "Listings are unavailable — this deployment has no marketplace configured."}</p>
            )}

            <div className="listings-grid">
              {(activeListings as ActiveListing[]).map((li) => (
                <ListingCard
                  key={li.listingId.toString()}
                  li={li}
                  bfrr={collection}
                  address={address}
                  txDisabled={txDisabled}
                  isConnected={isConnected}
                  wrongNetwork={wrongNetwork}
                  onBuy={() => run(async () => {
                    if (!marketplace) return;
                    await writeContractAsync({
                      address: marketplace,
                      abi: feeRightsFixedSaleAbi,
                      functionName: "buy",
                      args: [li.listingId],
                      value: li.priceWei,
                      chainId: MVP_CHAIN_ID,
                    });
                  })}
                  onCancel={() => run(async () => {
                    if (!marketplace) return;
                    await writeContractAsync({
                      address: marketplace,
                      abi: feeRightsFixedSaleAbi,
                      functionName: "cancel",
                      args: [li.listingId],
                      chainId: MVP_CHAIN_ID,
                    });
                  })}
                />
              ))}
            </div>
          </section>

          <p className="muted profile-tab-hint">
            Selling something of your own? Open{" "}
            <button type="button" className="link-btn" onClick={() => setMainTab("profile")}>My profile</button>.
          </p>
        </>
      )}

      {mainTab === "profile" && (
        <>
          <div className="hero hero--compact">
            <h1>My profile</h1>
            <p className="muted">Wallet, your listings, and items you can sell.</p>
          </div>

          {!isConnected && (
            <div className="profile-gate">
              <p>Connect a wallet to see your tokens and listings.</p>
              <div className="connect-strip">
                {connectors.map((c, i) => {
                  const label = typeof c === "object" && "name" in c ? String((c as { name: string }).name) : "Wallet";
                  const uid = typeof c === "object" && "uid" in c ? (c as { uid: string }).uid : null;
                  const cvUid = typeof connectVars?.connector === "object" && connectVars?.connector !== null && "uid" in connectVars.connector
                    ? (connectVars.connector as { uid: string }).uid : null;
                  const busy = connectPending && uid && cvUid && uid === cvUid;
                  return (
                    <button key={`${i}-${label}`} type="button" className="btn btn-ghost btn-sm"
                      disabled={connectPending}
                      onClick={() => connect({ connector: c, chainId: MVP_CHAIN_ID })}>
                      {busy ? "…" : label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {isConnected && address && (
            <div className="profile-wallet-card">
              <div className="profile-wallet-card__row">
                <span className="profile-wallet-card__label">Wallet</span>
                <span className="profile-wallet-card__status">Connected</span>
              </div>
              <p className="profile-wallet-card__address mono" title={address}>{address}</p>
              <div className="profile-wallet-card__actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    void navigator.clipboard.writeText(address);
                  }}
                >
                  Copy address
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => disconnect()}>
                  Disconnect
                </button>
              </div>
            </div>
          )}

          {isConnected && address && !wrongNetwork && (
            <>
              <section>
                <div className="section-head">
                  <h2>Your listings</h2>
                  <span className="scan-status">{myListings.length} active</span>
                </div>
                <p className="muted one-liner">Items you have listed for sale. Cancel returns the token to your wallet.</p>
                {myListings.length === 0 ? (
                  <p className="empty">You have no active listings.</p>
                ) : (
                  <div className="listings-grid">
                    {myListings.map((li) => (
                      <ListingCard
                        key={li.listingId.toString()}
                        li={li}
                        bfrr={collection}
                        address={address}
                        txDisabled={txDisabled}
                        isConnected={isConnected}
                        wrongNetwork={wrongNetwork}
                        onBuy={() => {}}
                        onCancel={() => run(async () => {
                          if (!marketplace) return;
                          await writeContractAsync({
                            address: marketplace,
                            abi: feeRightsFixedSaleAbi,
                            functionName: "cancel",
                            args: [li.listingId],
                            chainId: MVP_CHAIN_ID,
                          });
                        })}
                      />
                    ))}
                  </div>
                )}
              </section>

              {collection && marketplace && (
                <section>
                  <div className="section-head">
                    <h2>Ready to list</h2>
                    <span className="scan-status">
                      {scanning ? <><span className="spinner" />Scanning…</> : `${unlistedBfrrIds.length} in wallet`}
                    </span>
                  </div>
                  <p className="muted one-liner">
                    Receipts in your wallet that are not currently listed. Use <strong>Sell</strong> to set a price, or <strong>Cancel escrow</strong> to pull fee rights back from escrow.
                  </p>

                  {scanErr && <p className="err" style={{ marginBottom: "0.75rem" }}>{scanErr}</p>}

                  {!scanning && unlistedBfrrIds.length === 0 && allTokenIds.length === 0 && (
                    <>
                      <p className="empty">No receipts detected from our recent scan.</p>
                      <p className="muted one-liner" style={{ marginTop: "0.4rem" }}>
                        Nothing here does not mean your token “disappeared.” If escrow finished, you should have a BFRR (receipt NFT) on Base — open{" "}
                        <a
                          href={
                            collection
                              ? `https://basescan.org/token/${collection}?a=${address ?? ""}`
                              : `https://basescan.org/address/${address ?? ""}`
                          }
                          target="_blank"
                          rel="noreferrer"
                        >
                          BaseScan
                        </a>
                        {" "}for this wallet, copy the token ID, and paste it above. Use the same wallet and network (Base) you used for escrow.
                      </p>
                    </>
                  )}

                  <div className="profile-paste-row">
                    <input
                      className="mono"
                      placeholder="Paste token ID"
                      value={pasteId}
                      onChange={(e) => setPasteId(e.target.value)}
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => {
                        const t = pasteId.trim();
                        if (!t) return;
                        try {
                          const id = BigInt(t).toString();
                          setManualIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
                          setSelectedId(id);
                          setPasteId("");
                        } catch {
                          /* invalid */
                        }
                      }}
                    >
                      Add
                    </button>
                  </div>

                  <div className="profile-receipt-list">
                    {unlistedBfrrIds.map((id) => (
                      <div key={id} className={`profile-receipt-row${selectedId === id ? " profile-receipt-row--open" : ""}`}>
                        <BfrrCard
                          tokenId={id}
                          collection={collection}
                          selected={selectedId === id}
                          wrongNetwork={wrongNetwork}
                          staticDisplay
                        />
                        <div className="profile-receipt-row__actions">
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            disabled={txDisabled}
                            onClick={() => setSelectedId(id)}
                          >
                            Sell
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={txDisabled}
                            onClick={() => run(async () => {
                              await writeContractAsync({
                                address: ESCROW_ADDRESS,
                                abi: escrowAbi,
                                functionName: "redeemRights",
                                args: [BigInt(id)],
                                chainId: MVP_CHAIN_ID,
                              });
                              setSelectedId(null);
                              setScanEpoch((e) => e + 1);
                              void refetchListings();
                            })}
                          >
                            Cancel escrow
                          </button>
                        </div>
                        {selectedId === id && (
                          <div className="profile-receipt-row__panel">
                            <SellPanel
                              tokenIdStr={id}
                              collection={collection}
                              marketplace={marketplace}
                              address={address}
                              txDisabled={txDisabled}
                              wrongNetwork={wrongNetwork}
                              isConnected={isConnected}
                              onDone={() => {
                                setSelectedId(null);
                                invalidate();
                                void refetchListings();
                              }}
                            />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {(!collection || !marketplace) && (
                <p className="muted one-liner" style={{ marginTop: "1rem" }}>
                  Wallet and receipt features need a configured deployment (marketplace and BFRR addresses). If you expected this to work, contact the site operator.
                </p>
              )}

              <section className="bankr-panel">
                <div className="section-head">
                  <h2>Waiting on a receipt</h2>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={bankrLoading} onClick={() => void loadBankrLaunches()}>
                    {bankrLoading ? <><span className="spinner" />Loading…</> : "Refresh"}
                  </button>
                </div>
                <p className="muted one-liner">
                  Tokens where you earn fees on Bankr but the on-chain receipt is not in your wallet yet. <strong>Get receipt</strong> runs a short setup so you can list here.
                </p>
                {bankrRows.length > 0 ? (
                  <ul className="bankr-panel__list">
                    {bankrRows.map((row, i) => {
                      const ta = row.tokenAddress;
                      const pid = row.poolId;
                      const key =
                        typeof ta === "string" && ta.startsWith("0x")
                          ? ta.toLowerCase()
                          : typeof pid === "string"
                            ? `${pid}-${i}`
                            : `row-${i}`;
                      return (
                        <li key={key}>
                          <div className="bankr-panel__row">
                            <span className="bankr-panel__name">{launchRowLabel(row)}</span>
                            <a
                              className="bankr-panel__row-ext"
                              href={launchRowHref(row, address ?? "")}
                              target="_blank"
                              rel="noreferrer"
                              title="Open on Bankr"
                            >
                              ↗
                            </a>
                            <button
                              type="button"
                              className="bankr-panel__mint btn btn-ghost btn-sm"
                              disabled={wrongNetwork}
                              onClick={() => setEscrowWizardRow(row)}
                            >
                              Get receipt
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  !bankrLoading && (
                    <>
                      {bankrErr ? (
                        <p className="err one-liner">{bankrErr}</p>
                      ) : (
                        <p className="muted one-liner">
                          No Bankr fee rows from our API right now — that is separate from your on-chain balance. Try <strong>Refresh</strong> or check{" "}
                          <a href="https://bankr.bot" target="_blank" rel="noreferrer">bankr.bot</a> with the same wallet.
                        </p>
                      )}
                      <div className="bankr-panel__manual">
                        <p className="muted" style={{ fontSize: "0.82rem", marginTop: "0.85rem", marginBottom: "0.35rem" }}>
                          Bankr did not return your launch in the list above, so this is a <strong>backup path</strong> — normally you would not need it. Two clipboard pastes, then you are back in the same <strong>Get receipt</strong> popup as before.
                        </p>
                        {receiptManualErr && <p className="err" style={{ fontSize: "0.82rem", marginBottom: "0.35rem" }}>{receiptManualErr}</p>}
                        <details className="bfrr-primer" style={{ marginBottom: "0.65rem" }}>
                          <summary>Where do I find this? (2 minutes)</summary>
                          <div className="bfrr-primer__body" style={{ fontSize: "0.82rem" }}>
                            <ol style={{ margin: "0.35rem 0 0 1.1rem", padding: 0 }}>
                              <li style={{ marginBottom: "0.35rem" }}>
                                <strong>Pool ID</strong> — On{" "}
                                <a href={`https://basescan.org/address/${ESCROW_ADDRESS}`} target="_blank" rel="noreferrer">BaseScan</a>, open your wallet’s transaction <strong>Prepare deposit</strong> (method to escrow <span className="mono">{shortAddr(ESCROW_ADDRESS)}</span>). Use <strong>Input data</strong> → <strong>Decode input data</strong>. Copy the argument named like <span className="mono">poolId</span> — it must be <strong>0x</strong> plus <strong>64</strong> hex characters (66 characters total). If you copy the whole input string or a shorter hex, this box will error until it is exactly that length.
                              </li>
                              <li>
                                <strong>Launched token address</strong> — The ERC-20 you launched (the coin contract traders swap), <strong>not</strong> the BFRR receipt contract and <strong>not</strong> the marketplace. Same launch page on Bankr often shows “contract” or “token address”.
                              </li>
                            </ol>
                          </div>
                        </details>
                        <label className="muted" style={{ fontSize: "0.75rem", display: "block", marginBottom: "0.2rem" }}>1. Pool id (bytes32)</label>
                        <div className="profile-paste-row" style={{ marginTop: 0 }}>
                          <input
                            className="mono"
                            placeholder="0x + 64 hex chars (from Prepare deposit → decode)"
                            value={receiptManualPool}
                            onChange={(e) => {
                              setReceiptManualPool(e.target.value);
                              setReceiptManualErr(null);
                            }}
                            spellCheck={false}
                          />
                        </div>
                        <label className="muted" style={{ fontSize: "0.75rem", display: "block", marginTop: "0.5rem", marginBottom: "0.2rem" }}>2. Your launch token contract</label>
                        <div className="profile-paste-row" style={{ marginTop: 0 }}>
                          <input
                            className="mono"
                            placeholder="0x… token address (42 chars)"
                            value={receiptManualToken}
                            onChange={(e) => {
                              setReceiptManualToken(e.target.value);
                              setReceiptManualErr(null);
                            }}
                            spellCheck={false}
                          />
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            disabled={wrongNetwork}
                            onClick={() => {
                              const pid = normalizePoolId(receiptManualPool.trim());
                              const tok = tryParseAddress(receiptManualToken.trim());
                              if (!pid) {
                                setReceiptManualErr(explainPoolIdPasteError(receiptManualPool));
                                return;
                              }
                              if (!tok) {
                                setReceiptManualErr("Enter the launched token as a normal 0x address (40 hex digits).");
                                return;
                              }
                              setReceiptManualErr(null);
                              setEscrowWizardRow({
                                poolId: pid,
                                tokenAddress: tok,
                                tokenSymbol: "Token",
                              });
                            }}
                          >
                            Open Get receipt
                          </button>
                        </div>
                      </div>
                    </>
                  )
                )}
              </section>

              <details className="bfrr-primer bfrr-primer--profile">
                <summary>What is a receipt?</summary>
                <div className="bfrr-primer__body">
                  <p>
                    Only on-chain receipts can be sold here. If you earn fees on Bankr but do not see a token under <strong>Ready to list</strong>, use <strong>Get receipt</strong> or ask on{" "}
                    <a href="https://bankr.bot" target="_blank" rel="noreferrer">bankr.bot</a>.
                    {" "}
                    <a href="https://docs.bankr.bot/token-launching/transferring-fees/" target="_blank" rel="noreferrer">Learn more</a>
                  </p>
                </div>
              </details>
            </>
          )}
        </>
      )}

      {escrowWizardRow && address && (
        <EscrowWizard
          row={escrowWizardRow}
          escrowAddress={ESCROW_ADDRESS}
          userAddress={address}
          onClose={() => setEscrowWizardRow(null)}
          onDone={() => {
            setScanEpoch((e) => e + 1);
            void loadBankrLaunches();
          }}
        />
      )}

      {writeError && (
        <div className="error-bar">{writeError.message.slice(0, 120)}</div>
      )}

      {!isConnected && !walletConnectConfigured && mainTab === "home" && (
        <p className="muted" style={{ textAlign: "center", marginTop: "2rem", fontSize: "0.78rem" }}>
          For mobile wallets add <span className="mono">VITE_REOWN_PROJECT_ID</span> from{" "}
          <a href="https://cloud.reown.com/" target="_blank" rel="noreferrer">Reown Cloud</a>.
        </p>
      )}
    </div>
  );
}
