import { useEffect, useMemo, useState } from "react";
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

// ── Constants ────────────────────────────────────────────────────────────────

const ESCROW_ADDRESS: Address = "0x9CFD0AF884791b7c4BCC77f987bf0fa89b2064cB";
const GETLOGS_MAX_BLOCK_SPAN = 10_000n;
const MAX_LISTING_IDS_TO_SCAN = 250n;
const DEFAULT_SCAN_BLOCKS = 80_000n;

// ── Helpers ──────────────────────────────────────────────────────────────────

function tryParseAddress(raw: string): Address | undefined {
  const t = raw.trim();
  if (!t || !isAddress(t, { strict: false })) return undefined;
  try { return getAddress(t); } catch { return undefined; }
}

function envAddr(name: string): string {
  const raw = (import.meta as ImportMeta).env[name];
  return typeof raw === "string" ? (tryParseAddress(raw) ?? "") : "";
}

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

function BfrrCard({ tokenId: id, collection, selected, wrongNetwork, onClick }: {
  tokenId: string; collection: Address; selected: boolean;
  wrongNetwork: boolean; onClick: () => void;
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

  return (
    <button type="button" className={`bfrr-card${selected ? " active" : ""}`} onClick={onClick}>
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
            <span>Seller</span>
            <span className="mono">{shortAddr(li.seller)}</span>
          </div>
          <div className="listing-card__meta-row">
            <span>Token</span>
            <span className="mono">{serial !== undefined ? `#${String(serial)}` : shortAddr(li.tokenId.toString())}</span>
          </div>
        </div>
        <div className="listing-card__actions">
          {imSeller ? (
            <button type="button" className="btn btn-danger btn-sm btn-full"
              disabled={txDisabled} onClick={onCancel}>
              Cancel listing
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
        Sell
        <span className="tag mono">{tokenIdStr.slice(0, 6)}…{tokenIdStr.slice(-4)}</span>
        <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: "auto" }}
          onClick={onDone}>✕</button>
      </div>

      {/* Price + list */}
      <div className="sell-row">
        <label>Price</label>
        <div className="price-wrap">
          <input value={price} onChange={e => setPrice(e.target.value)} placeholder="0.01" />
          <span className="price-suffix">ETH</span>
        </div>
      </div>

      <div className="sell-actions">
        {canPull ? (
          <span className="approved-tag">✓ Approved</span>
        ) : (
          <button type="button" className="btn btn-ghost"
            disabled={txDisabled || tokenId === null}
            onClick={() => run(async () => {
              await writeContractAsync({
                address: collection, abi: erc721Abi, functionName: "approve",
                args: [marketplace, tokenId!], chainId: MVP_CHAIN_ID,
              });
            })}>
            {isPending ? <><span className="spinner" />Wallet…</> : "1. Approve"}
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
          {isPending ? <><span className="spinner" />Wallet…</> : `${canPull ? "" : "2. "}List`}
        </button>
      </div>

      {/* Redeem rights */}
      <div className="redeem-row">
        <div className="redeem-label">
          <span>Redeem fee rights</span>
          <strong>
            {bfrrOwner ? (isBfrrOwner ? "You hold this BFRR" : `Held by ${shortAddr(bfrrOwner as string)}`) : "…"}
          </strong>
        </div>
        <button type="button" className="btn btn-ghost btn-sm"
          disabled={txDisabled || !isBfrrOwner || tokenId === null}
          title={!isBfrrOwner ? "Connect the wallet that holds this BFRR" : "Burns BFRR → you become fee beneficiary"}
          onClick={() => run(async () => {
            await writeContractAsync({
              address: ESCROW_ADDRESS, abi: escrowAbi, functionName: "redeemRights",
              args: [tokenId!], chainId: MVP_CHAIN_ID,
            });
          })}>
          {isPending ? <><span className="spinner" />…</> : "Redeem"}
        </button>
      </div>
    </div>
  );
}

// ── Settings sheet ───────────────────────────────────────────────────────────

function SettingsSheet({ mpInput, setMpInput, colInput, setColInput, onClose }: {
  mpInput: string; setMpInput: (v: string) => void;
  colInput: string; setColInput: (v: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-sheet" onClick={e => e.stopPropagation()}>
        <div className="settings-sheet__head">
          <h3>Contract addresses</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>
        <div className="settings-field">
          <label>Marketplace (FeeRightsFixedSale)</label>
          <input value={mpInput} onChange={e => setMpInput(e.target.value)}
            placeholder="0xeb8aC71B…" />
        </div>
        <div className="settings-field">
          <label>BFRR receipt NFT</label>
          <input value={colInput} onChange={e => setColInput(e.target.value)}
            placeholder="0x4eC1a255…" />
        </div>
        <p className="muted" style={{ marginTop: "0.5rem" }}>
          Pre-filled from build config. Only change if using a different deployment.
        </p>
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

  const [mpInput, setMpInput]   = useState(envAddr("VITE_MARKETPLACE_ADDRESS"));
  const [colInput, setColInput] = useState(envAddr("VITE_DEFAULT_RECEIPT_COLLECTION"));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [scannedIds, setScannedIds] = useState<string[]>([]);
  const [manualIds, setManualIds] = useState<string[]>([]);
  const [pasteId, setPasteId] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanErr, setScanErr] = useState<string | null>(null);
  const [bankrLoading, setBankrLoading] = useState(false);
  const [bankrErr, setBankrErr] = useState<string | null>(null);
  const [bankrRows, setBankrRows] = useState<Record<string, unknown>[]>([]);

  const marketplace = tryParseAddress(mpInput);
  const collection  = tryParseAddress(colInput);
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
  }, [isConnected, address, collection?.toLowerCase(), wrongNetwork]);

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

  const invalidate = () => void qc.invalidateQueries();
  const run = async (fn: () => Promise<unknown>) => {
    try { await fn(); invalidate(); } catch { /* surfaced via writeError */ }
  };

  const loadBankrLaunches = async () => {
    if (!address) return;
    setBankrLoading(true);
    setBankrErr(null);
    setBankrRows([]);
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
          : "Could not reach /api/bankr-launches (deploy on Vercel with server env, or run `vercel dev`).",
      );
    } finally {
      setBankrLoading(false);
    }
  };

  return (
    <div>
      {/* ── Nav ── */}
      <nav className="nav">
        <div className="nav-logo">Bankr <span>Sale</span></div>
        <div className="nav-right">
          {isConnected && address ? (
            <>
              <div className="wallet-pill">
                <span className="wallet-dot" />
                <span className="wallet-addr">{shortAddr(address)}</span>
                <button className="gear-btn" onClick={() => disconnect()} title="Disconnect">✕</button>
              </div>
            </>
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
          <button className="gear-btn" title="Settings" onClick={() => setShowSettings(v => !v)}>⚙</button>
        </div>
      </nav>

      {/* ── Network warning ── */}
      {wrongNetwork && (
        <div className="network-banner">
          <span>Switch to Base mainnet</span>
          <button className="btn btn-ghost btn-sm" disabled={switchPending}
            onClick={() => switchChain?.({ chainId: MVP_CHAIN_ID })}>
            {switchPending ? "Switching…" : "Switch"}
          </button>
        </div>
      )}

      {/* ── Hero ── */}
      <div className="hero">
        <h1>Fee Rights <span>Marketplace</span></h1>
        <p>Buy and sell Bankr fee rights receipts on Base.</p>
      </div>

      <details className="bfrr-primer">
        <summary>No BFRR to sell? (Fee recipient ≠ receipt)</summary>
        <div className="bfrr-primer__body">
          <p>
            This page only lists <strong>BFRR NFTs</strong> already in your wallet. You cannot pick a launch like{" "}
            <span className="mono">$test</span> here and “convert” fee-recipient status into a BFRR — that step happens
            in <strong>Bankr’s deposit / escrow flow</strong>, which moves your pool share on the fee manager so{" "}
            <a href={`https://basescan.org/address/${ESCROW_ADDRESS}`} target="_blank" rel="noreferrer">
              BankrEscrowV3
            </a>{" "}
            can mint the receipt to your address.
          </p>
          <p style={{ marginTop: "0.5rem" }}>
            Use <a href="https://bankr.bot" target="_blank" rel="noreferrer">bankr.bot</a> (your launch / Bankr support)
            to complete that flow first. Then return here — your BFRR should appear after mint, or paste the token ID
            from BaseScan.
          </p>
        </div>
      </details>

      {/* ── Bankr creator fees (server proxy — optional) ── */}
      {isConnected && address && !wrongNetwork && (
        <section className="bankr-panel">
          <div className="section-head">
            <h2>Your Bankr tokens (fees)</h2>
            <button type="button" className="btn btn-ghost btn-sm" disabled={bankrLoading} onClick={() => void loadBankrLaunches()}>
              {bankrLoading ? <><span className="spinner" />Loading…</> : "Load from Bankr API"}
            </button>
          </div>
          <p className="muted" style={{ margin: "-0.5rem 0 0.75rem", fontSize: "0.8rem", lineHeight: 1.5 }}>
            Default upstream is Bankr’s public{" "}
            <a href="https://docs.bankr.bot/token-launching/reading-fees/" target="_blank" rel="noreferrer">
              creator-fees
            </a>{" "}
            endpoint (all tokens where you’re a creator beneficiary — not capped at 50 recent launches). Override with
            Vercel env <span className="mono">BANKR_LAUNCHES_API_TEMPLATE</span> (e.g.{" "}
            <span className="mono">https://api.bankr.bot/token-launches</span> for the recent list only).{" "}
            <span className="mono">BANKR_API_KEY</span> is optional for public reads. Never use{" "}
            <span className="mono">VITE_*</span> for secrets.
          </p>
          {bankrErr && <p className="err">{bankrErr}</p>}
          {bankrRows.length > 0 && (
            <ul className="bankr-panel__list">
              {bankrRows.map((row, i) => (
                <li key={i}>
                  <a href={launchRowHref(row, address)} target="_blank" rel="noreferrer">
                    {launchRowLabel(row)}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {!bankrLoading && !bankrErr && bankrRows.length === 0 && (
            <p className="muted" style={{ fontSize: "0.8rem" }}>
              Tap <strong>Load from Bankr API</strong> (needs <span className="mono">/api/bankr-launches</span> on
              Vercel or <span className="mono">vercel dev</span>). Each row links to Bankr search for that token
              address when available.
            </p>
          )}
        </section>
      )}

      {/* ── Your BFRRs ── */}
      {isConnected && address && !wrongNetwork && collection && (
        <section>
          <div className="section-head">
            <h2>Your BFRRs</h2>
            <span className="scan-status">
              {scanning ? <><span className="spinner" />Scanning…</> : `${allTokenIds.length} shown`}
            </span>
          </div>

          <p className="muted" style={{ margin: "-0.5rem 0 0.75rem", fontSize: "0.8rem", lineHeight: 1.5 }}>
            This list is only <strong>BFRR NFTs</strong> (receipt tokens) actually held in this MetaMask address on Base —
            not “being a fee recipient” in Bankr’s app by itself. A fee beneficiary and a BFRR in your wallet are
            different: the NFT is minted only when rights go through the <strong>escrow → receipt</strong> flow to your
            address. If Bankr shows you as recipient but you never received that NFT here, there may be nothing to sell
            until Bankr transfers the BFRR to this wallet (or you use the wallet that already holds it).
          </p>
          <p className="muted" style={{ margin: "0 0 1rem", fontSize: "0.8rem", lineHeight: 1.5 }}>
            Wrong BFRR contract in ⚙ settings (old vs new deployment) or a transfer older than the scan window can also
            hide tokens — use{" "}
            <a
              href={`https://basescan.org/token/${collection}?a=${address ?? ""}`}
              target="_blank"
              rel="noreferrer"
            >
              BaseScan → this wallet’s inventory for this contract
            </a>
            . If you see a token ID there, paste it below and click <strong>Add</strong>.
          </p>

          {scanErr && <p className="err" style={{ marginBottom: "0.75rem" }}>{scanErr}</p>}

          {!scanning && allTokenIds.length === 0 && (
            <p className="empty">
              No transfers to this address in the last {(Number(scanBlockSpan) / 1000).toFixed(0)}k blocks for this BFRR
              contract.
            </p>
          )}

          <div style={{ marginBottom: "1rem", display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
            <input
              className="mono"
              style={{ flex: "1 1 200px", minWidth: 0 }}
              placeholder="Paste full token ID (uint256)"
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

          {allTokenIds.length > 0 && (
            <div className="bfrr-grid">
              {allTokenIds.map((id) => (
                <BfrrCard
                  key={id}
                  tokenId={id}
                  collection={collection}
                  selected={selectedId === id}
                  wrongNetwork={wrongNetwork}
                  onClick={() => setSelectedId((prev) => (prev === id ? null : id))}
                />
              ))}
            </div>
          )}

          {selectedId && marketplace && address && (
            <SellPanel
              tokenIdStr={selectedId}
              collection={collection}
              marketplace={marketplace}
              address={address}
              txDisabled={txDisabled}
              wrongNetwork={wrongNetwork}
              isConnected={isConnected}
              onDone={() => {
                setSelectedId(null);
                invalidate();
                refetchListings();
              }}
            />
          )}
        </section>
      )}

      {/* ── Marketplace listings ── */}
      <section>
        <div className="section-head">
          <h2>Listings</h2>
          <button type="button" className="btn btn-ghost btn-sm"
            disabled={!marketplace || listingsLoading}
            onClick={() => void refetchListings()}>
            Refresh
          </button>
        </div>

        {listingsLoading && <p className="empty"><span className="spinner" />Loading…</p>}

        {!listingsLoading && (activeListings as ActiveListing[]).length === 0 && (
          <p className="empty">{marketplace ? "No active listings." : "Configure the marketplace address in settings ⚙"}</p>
        )}

        <div className="listings-grid">
          {(activeListings as ActiveListing[]).map(li => (
            <ListingCard
              key={li.listingId.toString()}
              li={li} bfrr={collection} address={address}
              txDisabled={txDisabled} isConnected={isConnected} wrongNetwork={wrongNetwork}
              onBuy={() => run(async () => {
                if (!marketplace) return;
                await writeContractAsync({
                  address: marketplace, abi: feeRightsFixedSaleAbi, functionName: "buy",
                  args: [li.listingId], value: li.priceWei, chainId: MVP_CHAIN_ID,
                });
              })}
              onCancel={() => run(async () => {
                if (!marketplace) return;
                await writeContractAsync({
                  address: marketplace, abi: feeRightsFixedSaleAbi, functionName: "cancel",
                  args: [li.listingId], chainId: MVP_CHAIN_ID,
                });
              })}
            />
          ))}
        </div>
      </section>

      {/* ── Settings ── */}
      {showSettings && (
        <SettingsSheet mpInput={mpInput} setMpInput={setMpInput}
          colInput={colInput} setColInput={setColInput}
          onClose={() => setShowSettings(false)} />
      )}

      {/* ── Error bar ── */}
      {writeError && (
        <div className="error-bar">{writeError.message.slice(0, 120)}</div>
      )}

      {/* WalletConnect hint when not configured */}
      {!isConnected && !walletConnectConfigured && (
        <p className="muted" style={{ textAlign: "center", marginTop: "2rem", fontSize: "0.78rem" }}>
          For mobile wallets add <span className="mono">VITE_REOWN_PROJECT_ID</span> from{" "}
          <a href="https://cloud.reown.com/" target="_blank" rel="noreferrer">Reown Cloud</a>.
        </p>
      )}
    </div>
  );
}
