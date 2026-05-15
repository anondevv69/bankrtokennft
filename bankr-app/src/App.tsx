import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useAccount,
  useConnect,
  useDisconnect,
  usePublicClient,
  useReadContract,
  useWriteContract,
  useChainId,
  useConfig,
  useSwitchChain,
} from "wagmi";
import type { PublicClient } from "viem";
import {
  isAddress,
  parseEther,
  formatEther,
  getAddress,
  type Address,
  type Hex,
} from "viem";
import { feeRightsFixedSaleAbi } from "./lib/feeRightsFixedSaleAbi";
import { bankrFeeRightsReceiptAbi } from "./lib/bankrFeeRightsReceiptAbi";
import { MVP_CHAIN, MVP_CHAIN_ID } from "./chain";
import { ensureBaseChain, formatTxError, waitForBaseReceipt } from "./ensureBase";
import {
  formatReceiptScanError,
  isPlaceholderCollectionAddress,
  scanWalletReceiptTokenIds,
  isPublicRpcUrl,
  rpcUrlFromEnv,
} from "./receiptScan";
import { walletConnectConfigured } from "./wagmi";
import { EscrowWizard } from "./EscrowWizard";
import {
  formatBankrPoolLabels,
  normalizeLaunchedTicker,
  normalizePoolId,
  rowPoolIdHex,
  rowLaunchedToken,
  launchRowLabel,
  launchedTokenFromWethPair,
  WETH_BASE,
} from "./lib/escrowArgs";
import {
  rowClankerListingReady,
  rowClankerLockerVersion,
  fetchClankerTokenDetail,
  clankerLockerFromDetail,
  clankerPoolFromDetail,
  clankerPairedFromDetail,
  mergeClankerManual,
  isV4Locker,
  type ClankerManualFields,
  type ClankerTokenDetail,
} from "./lib/clankerDetail";
import { clankerLockerV4Abi } from "./lib/clankerLockerV4Abi";
import { CLANKER_V4_DEFAULT_LOCKER } from "./lib/clankerLockers";
import {
  bankrEscrowAddressFromEnv,
  clankerEscrowAddressFromEnv,
  clankerEscrowV4AddressFromEnv,
} from "./lib/deployAddresses";
import { resolveReceiptRedeemEscrow } from "./lib/receiptRedeemEscrow";
import {
  formatListFlowError,
  isMarketplaceApproved,
  readNftOwner,
  waitForMarketplaceApproval,
} from "./listingFlow";
import { bfrrReceiptPreviewDataUri } from "./bfrrPreviewSvg";
import {
  fetchOpenSeaCollectionListings,
  indexListingsByTokenId,
  openSeaAssetUrl,
  openSeaCollectionUrl,
  type OpenSeaListing,
} from "./lib/openSeaListings";

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_LISTING_IDS_TO_SCAN = 250n;

// ── Helpers ──────────────────────────────────────────────────────────────────

function tryParseAddress(raw: string): Address | undefined {
  const t = raw.trim();
  if (!t || !isAddress(t, { strict: false })) return undefined;
  try { return getAddress(t); } catch { return undefined; }
}

/** Plain hint when pasted `poolId` is not exactly 32 bytes hex. */
function explainPoolIdPasteError(raw: string): string {
  const t = raw.trim();
  if (!t) return "Paste the pool id from your Prepare deposit transaction (decode it on BaseScan).";
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

/** Short inline help: opens on click; closes on outside click or toggling again. */
function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  return (
    <span className="info-tip" ref={wrapRef}>
      <button
        type="button"
        className="info-tip__btn"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </button>
      {open && (
        <div className="info-tip__panel" role="tooltip">
          {children}
        </div>
      )}
    </span>
  );
}

function envAddr(name: string): string {
  const raw = (import.meta as ImportMeta).env[name];
  return typeof raw === "string" ? (tryParseAddress(raw) ?? "") : "";
}

/** Comma-separated `0x…` addresses from env (e.g. legacy receipt collections to scan alongside the default). */
function envAddrCsvList(name: string): Address[] {
  const raw = (import.meta as ImportMeta).env[name];
  if (typeof raw !== "string" || !raw.trim()) return [];
  const out: Address[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const a = tryParseAddress(part);
    if (!a) continue;
    const k = a.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

/** Stable row id: `0x…collection|tokenId` (collection lowercased for parsing). */
function receiptRowKey(collection: Address, tokenId: string): string {
  return `${getAddress(collection).toLowerCase()}|${tokenId}`;
}

const ESCROW_ADDRESS: Address = bankrEscrowAddressFromEnv();
const CLANKER_ESCROW_ADDRESS: Address | null = clankerEscrowAddressFromEnv();
const CLANKER_ESCROW_V4_ADDRESS: Address | null = clankerEscrowV4AddressFromEnv();

function shortAddr(addr: string) {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

/** Shorten huge ERC-721 `tokenId` integers for UI (full value stays in `title`). */
function shortPoolId(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const s = String(raw);
  if (s.length < 13) return s;
  return s.slice(0, 6) + "…" + s.slice(-4);
}

function shortTokenIdDisplay(id: bigint): string {
  const s = id.toString();
  if (s.length <= 10) return s;
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/** Strip characters unsafe inside minimal SVG text nodes. */
function svgTextSafe(s: string, maxLen: number): string {
  return [...s.slice(0, maxLen)]
    .filter((c) => {
      const code = c.charCodeAt(0);
      return code >= 32 && c !== "<" && c !== ">" && c !== "&" && c !== '"' && c !== "'";
    })
    .join("");
}

/** Fix common mojibake from on-chain SVG / UTF-8 metadata in the UI. */
function normalizeDisplayText(raw: string): string {
  return raw
    .replace(/\uFFFD/g, "")
    .replace(/â€"/g, "—")
    .replace(/â\x80\x94/g, "—")
    .replace(/â[\u0080-\u009F]?/g, "—")
    .replace(/\s+/g, " ")
    .trim();
}

/** Client-side preview when `tokenURI` has no image — not on-chain metadata. */
function listingCardPlaceholderSvg(line1: string, line2: string): string {
  const a = svgTextSafe(line1, 44) || "Fee rights receipt";
  const b = svgTextSafe(line2, 56);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="260" viewBox="0 0 400 260"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0a0a"/><stop offset="100%" stop-color="#15101f"/></linearGradient></defs><rect width="400" height="260" fill="url(#g)"/><text x="200" y="62" text-anchor="middle" fill="#f97316" font-family="ui-monospace,monospace" font-size="11" font-weight="600" letter-spacing="0.12em">TMPR</text><text x="200" y="128" text-anchor="middle" fill="#fafafa" font-family="system-ui,sans-serif" font-size="15" font-weight="650">${a}</text>${b ? `<text x="200" y="166" text-anchor="middle" fill="#a3a3a3" font-family="ui-monospace,monospace" font-size="12">${b}</text>` : ""}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
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

/** Clanker public `search-creator` — tokens[] only (no Doppler bytes32 pool id). */
function normalizeClankerSearchRows(data: unknown): Record<string, unknown>[] {
  if (!data || typeof data !== "object") return [];
  const tokens = (data as Record<string, unknown>).tokens;
  if (!Array.isArray(tokens)) return [];
  const out: Record<string, unknown>[] = [];
  for (const t of tokens) {
    if (!t || typeof t !== "object") continue;
    const o = t as Record<string, unknown>;
    const ca = o.contract_address;
    if (typeof ca !== "string" || !ca.startsWith("0x")) continue;
    out.push({
      ...o,
      tokenAddress: ca,
      __launchVenue: "Clanker",
    });
  }
  return out;
}

/** Dedupe by launched token; keep Bankr-style rows first (usually carry `poolId`). Append Clanker-only extras. */
function mergeCreatorFeeRows(
  bankr: Record<string, unknown>[],
  clanker: Record<string, unknown>[],
): Record<string, unknown>[] {
  const seen = new Set<string>();
  const merged: Record<string, unknown>[] = [];
  for (const r of bankr) {
    const ta = rowLaunchedToken(r);
    if (ta) seen.add(ta.toLowerCase());
    merged.push(r);
  }
  for (const r of clanker) {
    const ta = rowLaunchedToken(r);
    if (!ta) continue;
    const k = ta.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(r);
  }
  return merged;
}

function launchRowHref(row: Record<string, unknown>, wallet: string): string {
  const venue = row.__launchVenue;
  const taResolved = rowLaunchedToken(row);
  if (venue === "Clanker" && taResolved) {
    return `https://basescan.org/token/${encodeURIComponent(getAddress(taResolved))}`;
  }
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

function parseDataUriJsonMetadata(tokenUri: unknown): {
  name?: string;
  description?: string;
  image?: string | null;
  pairTrait?: string;
} {
  if (!tokenUri || typeof tokenUri !== "string") return {};
  if (tokenUri.startsWith("data:image/")) {
    return { image: tokenUri };
  }
  const jsonFromDataUri = tryParseDataUriJson(tokenUri);
  if (jsonFromDataUri) return jsonFromDataUri;
  return {};
}

/** Normalize `ipfs://…` for `<img src>` (browser cannot load ipfs://). */
function normalizeMediaUrl(s: string | null | undefined): string | null {
  if (!s || typeof s !== "string") return null;
  const t = s.trim();
  if (!t) return null;
  if (t.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${t.slice(7)}`;
  return t;
}

function pairTraitFromAttributes(attributes: unknown): string | undefined {
  if (!Array.isArray(attributes)) return undefined;
  for (const a of attributes) {
    if (!a || typeof a !== "object") continue;
    const o = a as Record<string, unknown>;
    if (o.trait_type === "Pair" && typeof o.value === "string" && o.value.trim()) {
      return o.value.trim();
    }
  }
  return undefined;
}

function metaFromJsonRecord(json: Record<string, unknown>, baseUrl: string): {
  name?: string;
  description?: string;
  image?: string | null;
  pairTrait?: string;
} {
  let imageRaw: string | undefined;
  if (typeof json.image === "string" && json.image.trim()) imageRaw = json.image.trim();
  let resolved: string | null = null;
  if (imageRaw) {
    try {
      if (imageRaw.startsWith("ipfs://") || imageRaw.startsWith("data:") || imageRaw.startsWith("http://") || imageRaw.startsWith("https://")) {
        resolved = normalizeMediaUrl(imageRaw);
      } else {
        resolved = normalizeMediaUrl(new URL(imageRaw, baseUrl).href);
      }
    } catch {
      resolved = normalizeMediaUrl(imageRaw);
    }
  }
  return {
    name: typeof json.name === "string" ? json.name : undefined,
    description: typeof json.description === "string" ? json.description : undefined,
    image: resolved,
    pairTrait: pairTraitFromAttributes(json.attributes),
  };
}

/** `data:application/json;base64,...` (optional charset segment before base64). */
function tryParseDataUriJson(tokenUri: string): ReturnType<typeof parseDataUriJsonMetadata> | null {
  if (!tokenUri.toLowerCase().startsWith("data:application/json")) return null;
  const m = /;base64,(.+)$/i.exec(tokenUri);
  if (!m?.[1]) return null;
  try {
    const json = JSON.parse(atob(m[1])) as Record<string, unknown>;
    return metaFromJsonRecord(json, "");
  } catch {
    return null;
  }
}

function isOffChainMetadataUri(uri: string): boolean {
  const t = uri.trim();
  return (
    t.startsWith("https://") ||
    t.startsWith("http://") ||
    t.startsWith("ipfs://")
  );
}

function toMetadataGatewayUrl(uri: string): string {
  const t = uri.trim();
  if (t.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${t.slice(7)}`;
  return t;
}

function bankrStringField(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/** Optional branding URL on Bankr `token-fees` rows (not always present). */
function bankrRowOptionalImageUrl(row: Record<string, unknown>): string | null {
  const keys = ["image", "imageUrl", "logo", "logoUrl", "icon", "avatar", "thumbnail", "artworkUri", "coverImage"];
  for (const k of keys) {
    const raw = row[k];
    if (typeof raw !== "string" || !raw.trim()) continue;
    const n = normalizeMediaUrl(raw.trim());
    if (n) return n;
  }
  const nested = row.metadata ?? row.token;
  if (nested && typeof nested === "object") {
    return bankrRowOptionalImageUrl(nested as Record<string, unknown>);
  }
  return null;
}

/**
 * Parse Bankr `GET /public/doppler/token-fees/{token}` JSON.
 * When `poolIdWant` is set, prefer the matching `tokens[]` row; else use the first row.
 */
function bankrTokenFeesExtract(data: unknown, poolIdWant: string | null | undefined): {
  name?: string;
  symbol?: string;
  image?: string | null;
  token0Label?: string;
  token1Label?: string;
} {
  if (!data || typeof data !== "object") return {};
  const root = data as Record<string, unknown>;
  const tokens = root.tokens;
  if (!Array.isArray(tokens) || tokens.length === 0) return {};
  const want = poolIdWant ? String(poolIdWant).toLowerCase() : "";
  let row: Record<string, unknown> | undefined;
  if (want) {
    const hit = tokens.find((t) => {
      if (!t || typeof t !== "object") return false;
      const p = (t as Record<string, unknown>).poolId;
      return typeof p === "string" && p.toLowerCase() === want;
    });
    if (hit && typeof hit === "object") row = hit as Record<string, unknown>;
  }
  if (!row) row = tokens[0] as Record<string, unknown>;
  const name = bankrStringField(row, ["name", "tokenName", "title"]);
  const symbol = bankrStringField(row, ["symbol", "tokenSymbol", "ticker"]);
  const token0Label = bankrStringField(row, ["token0Label", "token0Name"]);
  const token1Label = bankrStringField(row, ["token1Label", "token1Name"]);
  const image = bankrRowOptionalImageUrl(row);
  const out: {
    name?: string;
    symbol?: string;
    image?: string | null;
    token0Label?: string;
    token1Label?: string;
  } = {};
  if (name) out.name = name;
  if (symbol) out.symbol = symbol;
  if (token0Label) out.token0Label = token0Label;
  if (token1Label) out.token1Label = token1Label;
  if (image) out.image = image;
  return out;
}

/** Merge `tokenURI` data: JSON with optional HTTP/IPFS metadata document. */
function useResolvedTokenMetadata(rawUri: unknown, enabled: boolean): {
  name?: string;
  description?: string;
  image?: string | null;
  pairTrait?: string;
  remoteLoading: boolean;
} {
  const inline = useMemo(() => parseDataUriJsonMetadata(rawUri), [rawUri]);
  const uriStr = typeof rawUri === "string" ? rawUri.trim() : "";
  const gateway = uriStr && isOffChainMetadataUri(uriStr) ? toMetadataGatewayUrl(uriStr) : null;

  const { data: remote, isLoading: remoteLoading } = useQuery({
    queryKey: ["bfrr-metadata-uri", gateway],
    enabled: Boolean(enabled && gateway),
    staleTime: 300_000,
    retry: 1,
    queryFn: async () => {
      const res = await fetch(gateway!, { mode: "cors" });
      if (!res.ok) throw new Error(`metadata ${res.status}`);
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      if (ct.includes("application/json") || ct.includes("text/json") || gateway!.toLowerCase().endsWith(".json")) {
        const json = (await res.json()) as Record<string, unknown>;
        const base = (() => {
          try {
            return new URL(".", gateway!).href;
          } catch {
            return gateway!;
          }
        })();
        return metaFromJsonRecord(json, base);
      }
      if (ct.startsWith("image/")) {
        return { image: gateway! };
      }
      try {
        const json = (await res.json()) as Record<string, unknown>;
        const base = new URL(".", gateway!).href;
        return metaFromJsonRecord(json, base);
      } catch {
        return {};
      }
    },
  });

  return useMemo(() => {
    if (inline.image || inline.name || inline.description || inline.pairTrait) {
      return { ...inline, remoteLoading: false };
    }
    if (remote) {
      return {
        name: remote.name ?? inline.name,
        description: remote.description ?? inline.description,
        image: remote.image ?? inline.image,
        pairTrait: remote.pairTrait ?? inline.pairTrait,
        remoteLoading: false,
      };
    }
    return { ...inline, remoteLoading: remoteLoading && Boolean(gateway) };
  }, [inline, remote, remoteLoading, gateway]);
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

const erc20SymbolAbi = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

const erc20NameAbi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

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

/** On-chain fields used for home search (fee-rights NFT listings); others use listing fields only. */
type ListingSearchEnrich = {
  factoryName: string;
  poolId: string;
  token0: Address;
  token1: Address;
  feeManager: Address;
  metaName?: string;
  sym0?: string;
  sym1?: string;
  nm0?: string;
  nm1?: string;
};

function buildListingSearchBlob(li: ActiveListing, enrich: ListingSearchEnrich | null): string {
  const parts: string[] = [
    li.seller,
    li.tokenId.toString(),
    li.listingId.toString(),
    formatEther(li.priceWei),
    li.collection,
  ];
  if (isAddress(li.seller)) parts.push(getAddress(li.seller));
  if (isAddress(li.collection)) parts.push(getAddress(li.collection));
  if (enrich) {
    parts.push(
      enrich.factoryName,
      enrich.poolId,
      enrich.token0,
      enrich.token1,
      enrich.feeManager,
      enrich.metaName ?? "",
      enrich.sym0 ?? "",
      enrich.sym1 ?? "",
      enrich.nm0 ?? "",
      enrich.nm1 ?? "",
    );
    if (enrich.sym0 && enrich.sym1) parts.push(`${enrich.sym0}/${enrich.sym1}`, `${enrich.sym0} / ${enrich.sym1}`);
    if (enrich.nm0 && enrich.nm1) parts.push(`${enrich.nm0}/${enrich.nm1}`);
  }
  return parts.filter(Boolean).join(" ").toLowerCase();
}

function listingMatchesSearch(li: ActiveListing, enrich: ListingSearchEnrich | null, qRaw: string): boolean {
  const blob = buildListingSearchBlob(li, enrich);
  const parts = qRaw
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((p) => p.replace(/\s/g, ""))
    .filter(Boolean);
  if (parts.length === 0) return true;
  return parts.every((p) => blob.includes(p));
}

function useActiveListingsSearchEnrichment(
  listings: ActiveListing[],
): (ListingSearchEnrich | null)[] {
  const publicClient = usePublicClient();
  const queries = useQueries({
    queries: listings.map((li) => {
      const col =
        isAddress(li.collection, { strict: false })
          ? (() => {
              try {
                return getAddress(li.collection);
              } catch {
                return null;
              }
            })()
          : null;
      return {
        queryKey: ["listing-search-enrich", li.listingId.toString(), li.tokenId.toString(), col ?? ""] as const,
        enabled: Boolean(publicClient && col),
        staleTime: 20_000,
        queryFn: async (): Promise<ListingSearchEnrich> => {
          if (!publicClient || !col) {
            throw new Error("missing client");
          }
          const [position, rawUri] = await Promise.all([
            publicClient.readContract({
              address: col,
              abi: bankrFeeRightsReceiptAbi,
              functionName: "positionOf",
              args: [li.tokenId],
            }),
            publicClient.readContract({
              address: col,
              abi: bankrFeeRightsReceiptAbi,
              functionName: "tokenURI",
              args: [li.tokenId],
            }),
          ]);
          const t0 = getAddress(position.token0);
          const t1 = getAddress(position.token1);
          const meta = parseDataUriJsonMetadata(rawUri);
          async function safeSymbol(a: Address): Promise<string | undefined> {
            try {
              const s = await publicClient.readContract({
                address: a,
                abi: erc20SymbolAbi,
                functionName: "symbol",
              });
              return typeof s === "string" && s.trim() ? s.trim() : undefined;
            } catch {
              return undefined;
            }
          }
          async function safeName(a: Address): Promise<string | undefined> {
            try {
              const s = await publicClient.readContract({
                address: a,
                abi: erc20NameAbi,
                functionName: "name",
              });
              return typeof s === "string" && s.trim() ? s.trim() : undefined;
            } catch {
              return undefined;
            }
          }
          const [sym0, sym1, nm0, nm1] = await Promise.all([
            safeSymbol(t0),
            safeSymbol(t1),
            safeName(t0),
            safeName(t1),
          ]);
          return {
            factoryName: typeof position.factoryName === "string" ? position.factoryName : "",
            poolId: position.poolId as string,
            token0: t0,
            token1: t1,
            feeManager: getAddress(position.feeManager),
            metaName: meta.name?.trim(),
            sym0,
            sym1,
            nm0,
            nm1,
          };
        },
      };
    }),
  });
  return useMemo(
    () =>
      listings.map((li, i) => {
        const col =
          isAddress(li.collection, { strict: false })
            ? (() => {
                try {
                  return getAddress(li.collection);
                } catch {
                  return null;
                }
              })()
            : null;
        if (!col) return null;
        const d = queries[i]?.data;
        return d ?? null;
      }),
    [listings, queries],
  );
}

// ── BfrrCard ─────────────────────────────────────────────────────────────────

function BfrrPreviewModal({
  open,
  onClose,
  imgSrc,
  imgBroken,
  onImgError,
  headline,
  tickerLine,
  subline,
  detailLines,
  basescanNft,
}: {
  open: boolean;
  onClose: () => void;
  imgSrc: string | null;
  imgBroken: boolean;
  onImgError: () => void;
  headline: string;
  tickerLine: string | null;
  subline: string | null;
  detailLines: string[];
  basescanNft: string;
}) {
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="settings-overlay bfrr-preview-overlay"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        className="settings-sheet bfrr-preview-sheet"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="bfrr-preview-title"
      >
        <div className="settings-sheet__head">
          <h3 id="bfrr-preview-title">NFT preview</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close preview">
            Close
          </button>
        </div>
        {imgSrc && !imgBroken ? (
          <img
            className="bfrr-preview-sheet__img"
            src={imgSrc}
            alt={headline}
            decoding="async"
            onError={onImgError}
          />
        ) : (
          <div className="bfrr-preview-sheet__img-placeholder muted">No image available</div>
        )}
        <p className="bfrr-preview-sheet__headline">{headline}</p>
        {tickerLine && (
          <p className="bfrr-preview-sheet__tickers">{tickerLine}</p>
        )}
        {subline && <p className="bfrr-preview-sheet__sub muted">{subline}</p>}
        {detailLines.length > 0 && (
          <ul className="bfrr-preview-sheet__details">
            {detailLines.map((line) => (
              <li key={line} className="mono muted">
                {line}
              </li>
            ))}
          </ul>
        )}
        <a
          className="btn btn-ghost btn-sm"
          href={basescanNft}
          target="_blank"
          rel="noreferrer"
          style={{ marginTop: "0.75rem" }}
        >
          Open on BaseScan
        </a>
      </div>
    </div>,
    document.body,
  );
}


function BfrrCard({ tokenId: id, collection, selected, onClick, staticDisplay, expandable }: {
  tokenId: string; collection: Address; selected: boolean;
  onClick?: () => void;
  /** When true, render a non-interactive preview (e.g. next to profile actions). */
  staticDisplay?: boolean;
  /** Profile rows: click image / View for full-size preview (default on when static). */
  expandable?: boolean;
}) {
  const tid = useMemo(() => { try { return BigInt(id); } catch { return null; } }, [id]);

  const { data: rawUri } = useReadContract({
    address: collection, abi: bankrFeeRightsReceiptAbi, functionName: "tokenURI",
    args: tid !== null ? [tid] : undefined, chainId: MVP_CHAIN_ID,
    query: { enabled: tid !== null },
  });
  const { data: serial } = useReadContract({
    address: collection, abi: bankrFeeRightsReceiptAbi, functionName: "serialOf",
    args: tid !== null ? [tid] : undefined, chainId: MVP_CHAIN_ID,
    query: { enabled: tid !== null },
  });
  const { data: position } = useReadContract({
    address: collection, abi: bankrFeeRightsReceiptAbi, functionName: "positionOf",
    args: tid !== null ? [tid] : undefined, chainId: MVP_CHAIN_ID,
    query: { enabled: tid !== null },
  });

  const meta = useResolvedTokenMetadata(rawUri, tid !== null);

  const poolIdShort = useMemo(() => {
    if (!position?.poolId) return null;
    return shortPoolId(position.poolId);
  }, [position]);

  const t0addr = useMemo(() => {
    if (!position || typeof position.token0 !== "string") return undefined;
    if (!isAddress(position.token0, { strict: false })) return undefined;
    try {
      return getAddress(position.token0);
    } catch {
      return undefined;
    }
  }, [position]);
  const t1addr = useMemo(() => {
    if (!position || typeof position.token1 !== "string") return undefined;
    if (!isAddress(position.token1, { strict: false })) return undefined;
    try {
      return getAddress(position.token1);
    } catch {
      return undefined;
    }
  }, [position]);

  const { data: sym0 } = useReadContract({
    address: t0addr,
    abi: erc20SymbolAbi,
    functionName: "symbol",
    chainId: MVP_CHAIN_ID,
    query: { enabled: Boolean(t0addr) },
  });
  const { data: sym1 } = useReadContract({
    address: t1addr,
    abi: erc20SymbolAbi,
    functionName: "symbol",
    chainId: MVP_CHAIN_ID,
    query: { enabled: Boolean(t1addr) },
  });
  const { data: nm0 } = useReadContract({
    address: t0addr,
    abi: erc20NameAbi,
    functionName: "name",
    chainId: MVP_CHAIN_ID,
    query: { enabled: Boolean(t0addr) },
  });
  const { data: nm1 } = useReadContract({
    address: t1addr,
    abi: erc20NameAbi,
    functionName: "name",
    chainId: MVP_CHAIN_ID,
    query: { enabled: Boolean(t1addr) },
  });

  const symbol0 = typeof sym0 === "string" && sym0.trim() ? sym0.trim() : null;
  const symbol1 = typeof sym1 === "string" && sym1.trim() ? sym1.trim() : null;
  const name0 = typeof nm0 === "string" && nm0.trim() ? nm0.trim() : null;
  const name1 = typeof nm1 === "string" && nm1.trim() ? nm1.trim() : null;

  const poolLabelsCard = useMemo(
    () => formatBankrPoolLabels(t0addr, t1addr, symbol0, symbol1, name0, name1),
    [t0addr, t1addr, symbol0, symbol1, name0, name1],
  );

  const launchedSymbol = poolLabelsCard?.ticker || poolLabelsCard?.tokenName || null;

  const bfrrPreviewUri = useMemo(() => {
    const ticker =
      poolLabelsCard?.ticker ||
      normalizeLaunchedTicker(meta.pairTrait?.trim() ? normalizeDisplayText(meta.pairTrait.trim()) : null);
    if (!ticker) return null;
    const serialStr = serial !== undefined ? String(serial) : id;
    const factory =
      position && typeof position.factoryName === "string" ? position.factoryName.trim() : null;
    let seller: string | null = null;
    let feeMgr: string | null = null;
    if (position && typeof position.seller === "string" && isAddress(position.seller, { strict: false })) {
      try {
        seller = shortAddr(getAddress(position.seller));
      } catch {
        seller = null;
      }
    }
    if (position && typeof position.feeManager === "string" && isAddress(position.feeManager, { strict: false })) {
      try {
        feeMgr = shortAddr(getAddress(position.feeManager));
      } catch {
        feeMgr = null;
      }
    }
    return bfrrReceiptPreviewDataUri({
      serial: serialStr,
      ticker,
      tokenName: poolLabelsCard?.tokenName || ticker,
      factory,
      poolId: poolIdShort,
      seller,
      feeManager: feeMgr,
    });
  }, [poolLabelsCard, meta.pairTrait, serial, id, position, poolIdShort]);

  const imgSrc = bfrrPreviewUri ?? meta.image ?? null;

  const factoryName =
    position && typeof position.factoryName === "string" && position.factoryName.trim()
      ? normalizeDisplayText(position.factoryName.trim())
      : null;

  const metaName = meta.name?.trim() ? normalizeDisplayText(meta.name.trim()) : null;

  const pairLabel =
    position && typeof position.token0 === "string" && typeof position.token1 === "string"
      ? `${shortAddr(getAddress(position.token0))} / ${shortAddr(getAddress(position.token1))}`
      : null;

  const tickerLine =
    poolLabelsCard?.ticker ||
    normalizeLaunchedTicker(meta.pairTrait?.trim() ? normalizeDisplayText(meta.pairTrait.trim()) : null) ||
    pairLabel;

  const serialLabel = serial !== undefined ? String(serial) : null;
  const headline = launchedSymbol
    ? `${launchedSymbol} · receipt`
    : tickerLine || metaName || "Marketplace receipt";
  const subline = [serialLabel ? `TMPR #${serialLabel}` : null, factoryName]
    .filter(Boolean)
    .join(" · ");

  const descRaw = meta.description?.trim() ? normalizeDisplayText(meta.description.trim()) : null;
  const showCardDesc =
    Boolean(descRaw) &&
    !staticDisplay &&
    descRaw !== headline &&
    descRaw !== tickerLine &&
    !/^(bankr fee rights receipt|creator fee rights|token marketplace)/i.test(descRaw);

  const detailLines = useMemo(() => {
    const lines: string[] = [];
    if (tickerLine) lines.push(`Pair: ${tickerLine}`);
    if (t0addr && t1addr) lines.push(`Pool: ${shortAddr(t0addr)} / ${shortAddr(t1addr)}`);
    if (serialLabel) lines.push(`Serial #${serialLabel}`);
    lines.push(`Token ID: ${id}`);
    if (descRaw && !/^(bankr fee rights receipt|creator fee rights|token marketplace)/i.test(descRaw)) lines.push(descRaw);
    return lines;
  }, [tickerLine, t0addr, t1addr, serialLabel, id, descRaw]);

  const basescanNft = `https://basescan.org/nft/${collection}/${id}`;
  const canExpand = expandable ?? staticDisplay;

  const [imgBroken, setImgBroken] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  useEffect(() => {
    setImgBroken(false);
  }, [imgSrc]);
  useEffect(() => {
    if (selected) setPreviewOpen(false);
  }, [selected]);

  const openPreview = (e?: { stopPropagation?: () => void }) => {
    e?.stopPropagation?.();
    setPreviewOpen(true);
  };

  const imgBlock = imgSrc && !imgBroken ? (
    <img className="bfrr-card__img" src={imgSrc}
      alt={headline} loading="lazy" decoding="async"
      onError={() => setImgBroken(true)} />
  ) : (
    <div className="bfrr-card__img-placeholder">
      <span className="bfrr-card__badge">TMPR</span>
      {meta.remoteLoading && !imgSrc ? (
        <span className="bfrr-card__serial"><span className="spinner" /> Metadata…</span>
      ) : (
        serialLabel !== null && <span className="bfrr-card__serial">#{serialLabel}</span>
      )}
    </div>
  );

  const body = (
    <>
      {canExpand ? (
        <button type="button" className="bfrr-card__preview-hit" onClick={openPreview}
          aria-label={`View NFT for ${headline}`}>
          {imgBlock}
          <span className="bfrr-card__expand-hint">Tap to enlarge</span>
        </button>
      ) : imgBlock}
      <div className="bfrr-card__footer">
        <div className="bfrr-card__headline" title={headline}>{headline}</div>
        {tickerLine && tickerLine !== headline && (
          <div className={`bfrr-card__tickers${symbol0 && symbol1 ? "" : " mono"}`} title={tickerLine}>
            {tickerLine}
          </div>
        )}
        {subline && <div className="bfrr-card__subline muted">{subline}</div>}
        <div className="bfrr-card__id-row">
          <span className="bfrr-card__id mono" title={`Token ID ${id}`}>
            {serialLabel !== null ? `#${serialLabel}` : id.slice(0, 6) + "…" + id.slice(-4)}
          </span>
          <span className="bfrr-card__id-actions">
            {canExpand && (
              <button type="button" className="bfrr-card__view-btn link-btn" onClick={openPreview}>View</button>
            )}
            <span
              className="bfrr-card__scan"
              role="link"
              tabIndex={0}
              title="Open on BaseScan"
              onClick={(e) => {
                e.stopPropagation();
                window.open(basescanNft, "_blank", "noopener,noreferrer");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  window.open(basescanNft, "_blank", "noopener,noreferrer");
                }
              }}
            >
              BaseScan
            </span>
          </span>
        </div>
      </div>
      {canExpand && (
        <BfrrPreviewModal
          open={previewOpen}
          onClose={() => setPreviewOpen(false)}
          imgSrc={imgSrc}
          imgBroken={imgBroken}
          onImgError={() => setImgBroken(true)}
          headline={headline}
          tickerLine={tickerLine}
          subline={subline || null}
          detailLines={detailLines}
          basescanNft={basescanNft}
        />
      )}
    </>
  );

  if (staticDisplay) {
    return (
      <div className={`bfrr-card bfrr-card--static bfrr-card--profile${selected ? " active" : ""}`}>
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

function ListingCard({ li, bfrr, address, txDisabled, isConnected, wrongNetwork, onBuy, onCancel, openSeaListing, openSeaUrl }: {
  li: ActiveListing; bfrr: Address | undefined; address: Address | undefined;
  txDisabled: boolean; isConnected: boolean; wrongNetwork: boolean;
  onBuy: () => void; onCancel: () => void;
  openSeaListing?: OpenSeaListing; openSeaUrl?: string;
}) {
  const listCol = useMemo((): Address | undefined => {
    if (!isAddress(li.collection, { strict: false })) return undefined;
    try {
      return getAddress(li.collection);
    } catch {
      return undefined;
    }
  }, [li.collection]);

  /** Read pool + metadata from the listed NFT on Base (`chainId`), even if the wallet is on another chain. */
  const receiptReadsEnabled = Boolean(listCol);

  const { data: rawUri } = useReadContract({
    address: receiptReadsEnabled ? listCol : undefined, abi: bankrFeeRightsReceiptAbi,
    functionName: "tokenURI", args: [li.tokenId], chainId: MVP_CHAIN_ID,
    query: { enabled: receiptReadsEnabled, staleTime: 20_000 },
  });
  const { data: serial } = useReadContract({
    address: receiptReadsEnabled ? listCol : undefined, abi: bankrFeeRightsReceiptAbi,
    functionName: "serialOf", args: [li.tokenId], chainId: MVP_CHAIN_ID,
    query: { enabled: receiptReadsEnabled, staleTime: 20_000 },
  });
  const { data: position } = useReadContract({
    address: receiptReadsEnabled ? listCol : undefined, abi: bankrFeeRightsReceiptAbi,
    functionName: "positionOf", args: [li.tokenId], chainId: MVP_CHAIN_ID,
    query: { enabled: receiptReadsEnabled, staleTime: 20_000 },
  });

  const poolIdLc = useMemo(() => {
    if (!position) return null;
    const p = position.poolId;
    if (p === undefined || p === null) return null;
    return String(p).toLowerCase();
  }, [position]);

  const bankrLaunched = useMemo(() => {
    if (!position || typeof position.token0 !== "string" || typeof position.token1 !== "string") return undefined;
    if (!isAddress(position.token0, { strict: false }) || !isAddress(position.token1, { strict: false })) return undefined;
    try {
      return launchedTokenFromWethPair(getAddress(position.token0), getAddress(position.token1));
    } catch {
      return undefined;
    }
  }, [position]);

  const { data: bankrFeesMeta } = useQuery({
    queryKey: ["bankr-token-fees", bankrLaunched, poolIdLc],
    enabled: Boolean(receiptReadsEnabled && bankrLaunched),
    staleTime: 120_000,
    retry: 0,
    queryFn: async () => {
      const res = await fetch(`/api/bankr-token-fees?token=${encodeURIComponent(bankrLaunched!)}&days=30`);
      const json = (await res.json()) as { ok?: boolean; data?: unknown };
      if (!res.ok || !json.ok) return {};
      return bankrTokenFeesExtract(json.data, poolIdLc);
    },
  });

  const meta = useResolvedTokenMetadata(rawUri, receiptReadsEnabled);
  const chainImg = meta.image ?? null;
  const bankrImg = bankrFeesMeta?.image ?? null;
  const receiptTitle =
    (position && typeof position.factoryName === "string" && position.factoryName.trim())
      ? position.factoryName.trim()
      : (meta.name?.trim() ||
        bankrFeesMeta?.name?.trim() ||
        bankrFeesMeta?.symbol?.trim() ||
        null);

  const t0addr = useMemo(() => {
    if (!position || typeof position.token0 !== "string") return undefined;
    if (!isAddress(position.token0, { strict: false })) return undefined;
    try {
      return getAddress(position.token0);
    } catch {
      return undefined;
    }
  }, [position]);
  const t1addr = useMemo(() => {
    if (!position || typeof position.token1 !== "string") return undefined;
    if (!isAddress(position.token1, { strict: false })) return undefined;
    try {
      return getAddress(position.token1);
    } catch {
      return undefined;
    }
  }, [position]);

  const { data: sym0 } = useReadContract({
    address: receiptReadsEnabled ? t0addr : undefined,
    abi: erc20SymbolAbi,
    functionName: "symbol",
    chainId: MVP_CHAIN_ID,
    query: { enabled: receiptReadsEnabled && Boolean(t0addr) },
  });
  const { data: sym1 } = useReadContract({
    address: receiptReadsEnabled ? t1addr : undefined,
    abi: erc20SymbolAbi,
    functionName: "symbol",
    chainId: MVP_CHAIN_ID,
    query: { enabled: receiptReadsEnabled && Boolean(t1addr) },
  });
  const { data: nm0 } = useReadContract({
    address: receiptReadsEnabled ? t0addr : undefined,
    abi: erc20NameAbi,
    functionName: "name",
    chainId: MVP_CHAIN_ID,
    query: { enabled: receiptReadsEnabled && Boolean(t0addr) },
  });
  const { data: nm1 } = useReadContract({
    address: receiptReadsEnabled ? t1addr : undefined,
    abi: erc20NameAbi,
    functionName: "name",
    chainId: MVP_CHAIN_ID,
    query: { enabled: receiptReadsEnabled && Boolean(t1addr) },
  });

  const symbol0 = typeof sym0 === "string" && sym0.trim() ? sym0.trim() : null;
  const symbol1 = typeof sym1 === "string" && sym1.trim() ? sym1.trim() : null;
  const name0 = typeof nm0 === "string" && nm0.trim() ? nm0.trim() : null;
  const name1 = typeof nm1 === "string" && nm1.trim() ? nm1.trim() : null;

  const poolLabels = useMemo(
    () => formatBankrPoolLabels(t0addr, t1addr, symbol0, symbol1, name0, name1),
    [t0addr, t1addr, symbol0, symbol1, name0, name1],
  );

  const tickerDisplay =
    poolLabels?.ticker ||
    normalizeLaunchedTicker(meta.pairTrait?.trim()) ||
    (receiptReadsEnabled ? "—" : null);

  const tokenNameDisplay =
    poolLabels?.tokenName ||
    bankrFeesMeta?.symbol?.trim() ||
    bankrFeesMeta?.name?.trim() ||
    null;

  const launchedContract = poolLabels?.launched ?? bankrLaunched;

  const cardAlt =
    tickerDisplay ||
    tokenNameDisplay ||
    receiptTitle ||
    meta.name ||
    bankrFeesMeta?.name ||
    "Listing";

  const imSeller = address !== undefined && isAddress(li.seller) &&
    getAddress(li.seller) === getAddress(address);

  const sellerAddr = isAddress(li.seller) ? getAddress(li.seller) : li.seller;
  const sellerScan = isAddress(li.seller) ? `https://basescan.org/address/${getAddress(li.seller)}` : undefined;

  const [bankrImgBroken, setBankrImgBroken] = useState(false);
  useEffect(() => {
    setBankrImgBroken(false);
  }, [li.collection, li.tokenId, rawUri, bankrImg, tickerDisplay, tokenNameDisplay]);

  const receiptIdLabel =
    serial !== undefined ? `#${String(serial)}` : `#${shortTokenIdDisplay(li.tokenId)}`;

  const bfrrPreviewUri = useMemo(() => {
    if (!tickerDisplay) return null;
    const serialStr = serial !== undefined ? String(serial) : receiptIdLabel.replace(/^#/, "");
    const factory =
      position && typeof position.factoryName === "string" ? position.factoryName.trim() : null;
    let feeMgr: string | null = null;
    if (position && typeof position.feeManager === "string" && isAddress(position.feeManager, { strict: false })) {
      try {
        feeMgr = shortAddr(getAddress(position.feeManager));
      } catch {
        feeMgr = null;
      }
    }
    return bfrrReceiptPreviewDataUri({
      serial: serialStr,
      ticker: tickerDisplay,
      tokenName: tokenNameDisplay || tickerDisplay,
      factory,
      poolId: poolIdLc ? shortPoolId(poolIdLc) : null,
      seller: sellerScan ? shortAddr(sellerAddr) : null,
      feeManager: feeMgr,
    });
  }, [
    tickerDisplay,
    tokenNameDisplay,
    serial,
    receiptIdLabel,
    position,
    poolIdLc,
    sellerScan,
    sellerAddr,
  ]);

  const rasterBankr = bankrImg && !bankrImgBroken ? bankrImg : null;
  const displayImg = bfrrPreviewUri ?? rasterBankr;

  const synthDataUri = useMemo(() => {
    if (displayImg) return null;
    const l1 = tickerDisplay || "Fee rights";
    const l2 = launchedContract ? shortAddr(launchedContract) : receiptIdLabel;
    if (!receiptReadsEnabled && !tickerDisplay) return null;
    return listingCardPlaceholderSvg(String(l1), String(l2));
  }, [displayImg, tickerDisplay, launchedContract, receiptIdLabel, receiptReadsEnabled]);

  return (
    <div className="listing-card">
      {displayImg ? (
        <img
          className="listing-card__img"
          src={displayImg}
          alt={cardAlt}
          loading="lazy"
          decoding="async"
          onError={() => setBankrImgBroken(true)}
        />
      ) : synthDataUri ? (
        <img
          className="listing-card__img"
          src={synthDataUri}
          alt={cardAlt}
          loading="lazy"
          decoding="async"
        />
      ) : (
        <div className="listing-card__img-placeholder">
          <span className="bfrr-card__badge">TMPR</span>
          <span className="bfrr-card__serial">
            {meta.remoteLoading && !chainImg && !bankrImg ? (
              <><span className="spinner" /> Metadata…</>
            ) : (
              receiptIdLabel
            )}
          </span>
        </div>
      )}
      <div className="listing-card__body">
        <div className="listing-card__meta">
          <div className="listing-card__meta-row">
            <span>Seller</span>
            <span className="listing-card__meta-ellipsis">
            {sellerScan ? (
              <a className="mono listing-card__meta-link" href={sellerScan} target="_blank" rel="noreferrer" title={sellerAddr}>
                {shortAddr(sellerAddr)}
              </a>
            ) : (
              <span className="mono" title={sellerAddr}>{shortAddr(sellerAddr)}</span>
            )}
            </span>
          </div>
          {tickerDisplay && (
            <div className="listing-card__meta-row">
              <span>Ticker</span>
              <span className="listing-card__meta-ellipsis" title={t0addr && t1addr ? `${t0addr} / ${t1addr}` : tickerDisplay}>
                {tickerDisplay}
              </span>
            </div>
          )}
          {tokenNameDisplay && (
            <div className="listing-card__meta-row">
              <span>Token name</span>
              <span className="listing-card__meta-ellipsis" title={tokenNameDisplay}>
                {tokenNameDisplay}
              </span>
            </div>
          )}
          {launchedContract && (
            <div className="listing-card__meta-row">
              <span>Contract</span>
              <span className="listing-card__meta-ellipsis">
                <a
                  className="mono listing-card__meta-link"
                  href={`https://basescan.org/address/${launchedContract}`}
                  target="_blank"
                  rel="noreferrer"
                  title={launchedContract}
                >
                  {shortAddr(launchedContract)}
                </a>
              </span>
            </div>
          )}
        </div>
        <div className="listing-card__price">{formatEther(li.priceWei)} ETH</div>
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
        {(openSeaListing || openSeaUrl) && (
          <div className="listing-card__opensea">
            {openSeaListing ? (
              <>
                <span className="badge badge--opensea">Also on OpenSea</span>
                {openSeaListing.priceEth && (
                  <span className="muted" style={{ fontSize: "0.75rem" }}>
                    {openSeaListing.priceEth} {openSeaListing.priceCurrency}
                  </span>
                )}
                {(openSeaListing.permalink ?? openSeaUrl) && (
                  <a
                    href={openSeaListing.permalink ?? openSeaUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="link-btn"
                    style={{ fontSize: "0.75rem" }}
                  >
                    View ↗
                  </a>
                )}
              </>
            ) : openSeaUrl ? (
              <a href={openSeaUrl} target="_blank" rel="noreferrer" className="link-btn" style={{ fontSize: "0.75rem" }}>
                View on OpenSea ↗
              </a>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

// ── SellPanel ────────────────────────────────────────────────────────────────

function SellPanel({ tokenIdStr, collection, marketplace, address, txDisabled,
  isConnected, onDone, onListFlowStart, onListFlowEnd }: {
  tokenIdStr: string; collection: Address; marketplace: Address;
  address: Address | undefined; txDisabled: boolean;
  isConnected: boolean;
  onDone: () => void | Promise<void>;
  onListFlowStart?: () => void;
  onListFlowEnd?: () => void;
}) {
  const [price, setPrice] = useState("0.01");
  const [listStep, setListStep] = useState<null | "approve" | "list">(null);
  const [listErr, setListErr] = useState<string | null>(null);
  const listLock = useRef(false);
  const config = useConfig();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync, isPending } = useWriteContract();
  const publicClient = usePublicClient();

  const tokenId = useMemo(() => { try { return BigInt(tokenIdStr); } catch { return null; } }, [tokenIdStr]);
  /** On-chain reads use Base (`MVP_CHAIN_ID`) even when the wallet is connected to another chain. */
  const readOk = tokenId !== null && Boolean(collection);
  const writeOk = readOk && !txDisabled;

  const { data: approvedSpender } = useReadContract({
    address: collection, abi: erc721Abi, functionName: "getApproved",
    args: tokenId !== null ? [tokenId] : undefined, chainId: MVP_CHAIN_ID,
    query: { enabled: readOk && isConnected },
  });
  const { data: approvedAll } = useReadContract({
    address: collection, abi: erc721Abi, functionName: "isApprovedForAll",
    args: address ? [address, marketplace] : undefined, chainId: MVP_CHAIN_ID,
    query: { enabled: readOk && Boolean(address) },
  });
  const { data: bfrrOwner } = useReadContract({
    address: collection, abi: erc721Abi, functionName: "ownerOf",
    args: tokenId !== null ? [tokenId] : undefined, chainId: MVP_CHAIN_ID,
    query: { enabled: readOk },
  });

  const [redeemEscrowResolved, setRedeemEscrowResolved] = useState<Address>(ESCROW_ADDRESS);

  useEffect(() => {
    if (!publicClient || tokenId === null || !readOk) return;
    let cancelled = false;
    void resolveReceiptRedeemEscrow(publicClient, {
      collection,
      tokenId,
      bankrEscrow: ESCROW_ADDRESS,
      clankerEscrow: CLANKER_ESCROW_ADDRESS,
      clankerEscrowV4: CLANKER_ESCROW_V4_ADDRESS,
    }).then((addr) => {
      if (!cancelled) setRedeemEscrowResolved(addr);
    });
    return () => {
      cancelled = true;
    };
  }, [publicClient, collection, tokenId, readOk, CLANKER_ESCROW_ADDRESS, CLANKER_ESCROW_V4_ADDRESS]);

  const canPull = Boolean(
    (typeof approvedSpender === "string" && isAddress(approvedSpender) &&
     getAddress(approvedSpender as Address) === getAddress(marketplace)) ||
    approvedAll === true
  );
  const isBfrrOwner = address !== undefined && typeof bfrrOwner === "string" &&
    isAddress(bfrrOwner) && getAddress(bfrrOwner as Address) === getAddress(address);
  const priceNorm = price.trim().replace(",", ".");
  const priceOk = Number.isFinite(parseFloat(priceNorm)) && parseFloat(priceNorm) > 0;
  const wrongChain = chainId !== MVP_CHAIN_ID;

  const [redeemPhase, setRedeemPhase] = useState(false);
  const listBusy = listStep !== null || isPending || redeemPhase;
  const listLabel =
    listStep === "approve" ? (
      <><span className="spinner" /> Approve in wallet…</>
    ) : listStep === "list" ? (
      <><span className="spinner" /> Confirm listing…</>
    ) : (
      "List"
    );

  const redeemEscrowAddr = redeemEscrowResolved;

  const onList = async () => {
    if (!priceOk || tokenId === null || txDisabled || !publicClient || !address) return;
    if (listLock.current) return;
    listLock.current = true;
    setListErr(null);
    onListFlowStart?.();
    const me = getAddress(address);
    try {
      await ensureBaseChain(config, switchChainAsync);

      const owner = await readNftOwner(publicClient, collection, tokenId);
      const mkt = getAddress(marketplace);
      if (owner === mkt) {
        throw new Error(
          "This NFT is already listed on the marketplace. Open My profile → Your listings and cancel the sale first.",
        );
      }
      if (owner !== me) {
        throw new Error("This wallet does not hold this NFT on Base. Connect the wallet that owns it.");
      }

      let approved = await isMarketplaceApproved(publicClient, collection, tokenId, me, mkt);
      if (!approved) {
        setListStep("approve");
        const approveHash = await writeContractAsync({
          address: collection,
          abi: erc721Abi,
          functionName: "approve",
          args: [mkt, tokenId],
          chain: MVP_CHAIN,
        });
        await waitForBaseReceipt(publicClient, approveHash);
        await waitForMarketplaceApproval(publicClient, collection, tokenId, me, mkt);
        approved = true;
      }

      setListStep("list");
      const priceWei = parseEther(priceNorm);
      await publicClient.simulateContract({
        address: marketplace,
        abi: feeRightsFixedSaleAbi,
        functionName: "list",
        args: [collection, tokenId, priceWei],
        account: me,
        chain: MVP_CHAIN,
      });

      const listHash = await writeContractAsync({
        address: marketplace,
        abi: feeRightsFixedSaleAbi,
        functionName: "list",
        args: [collection, tokenId, priceWei],
        chain: MVP_CHAIN,
      });
      await waitForBaseReceipt(publicClient, listHash);
      await Promise.resolve(onDone());
    } catch (e) {
      setListErr(formatListFlowError(e));
    } finally {
      listLock.current = false;
      setListStep(null);
      onListFlowEnd?.();
    }
  };

  return (
    <div className="sell-panel">
      <div className="sell-panel__title">
        Set price
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

      <div className="sell-actions sell-actions--single">
        {wrongChain && !listBusy && (
          <p className="muted sell-actions__hint">
            Your wallet is not on Base.{" "}
            {switchChainAsync ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void ensureBaseChain(config, switchChainAsync).catch((e) => setListErr(formatTxError(e)))}>
                Switch to Base
              </button>
            ) : (
              "Open your wallet and select Base mainnet."
            )}
          </p>
        )}
        <button type="button" className="btn btn-primary btn-full"
          disabled={!writeOk || !priceOk || tokenId === null || listStep !== null || isPending || !isBfrrOwner}
          onClick={() => void onList()}>
          {listLabel}
        </button>
        {listBusy && (
          <p className="muted sell-actions__hint">
            {listStep === "approve"
              ? "Step 1 of 2: approve in your wallet — listing continues automatically."
              : "Step 2 of 2: confirm the list transaction in your wallet."}
          </p>
        )}
        {!listBusy && (
          <p className="muted sell-actions__hint">
            One tap: if needed, approve then list (two wallet prompts, same flow).
          </p>
        )}
        {listErr && <p className="sell-actions__error" role="alert">{listErr}</p>}
      </div>

      <div className="redeem-row">
        <div className="redeem-label redeem-label--row">
          <span>Return to my wallet</span>
          <InfoTip label="What “Return to my wallet” does">
            <p>
              Calls the correct fee-rights escrow’s <strong>redeemRights</strong>: it <strong>burns this receipt NFT</strong> and moves Bankr or Clanker fee-admin / recipient roles back to your wallet.
              This is not the same as <strong>Cancel sale</strong> on the marketplace (that only unlists the NFT here). If this button fails, ensure <span className="mono">VITE_CLANKER_V4_ESCROW_ADDRESS</span> is set when the receipt came from Clanker v4.
            </p>
          </InfoTip>
        </div>
        <div className="redeem-row__btn-wrap">
          <button type="button" className="btn btn-ghost btn-sm"
            disabled={!writeOk || !isBfrrOwner || tokenId === null || listBusy}
            title={!isBfrrOwner ? "Use the wallet that holds this item" : undefined}
            onClick={() => void (async () => {
              if (tokenId === null || !publicClient) return;
              setRedeemPhase(true);
              setListErr(null);
              try {
                await ensureBaseChain(config, switchChainAsync);
                const hash = await writeContractAsync({
                  address: redeemEscrowAddr, abi: escrowAbi, functionName: "redeemRights",
                  args: [tokenId], chain: MVP_CHAIN,
                });
                await waitForBaseReceipt(publicClient, hash);
              } catch (e) {
                setListErr(formatTxError(e));
              } finally {
                setRedeemPhase(false);
              }
            })()}>
            {redeemPhase ? (
              <><span className="spinner" /> Returning…</>
            ) : (
              "Return to my wallet"
            )}
          </button>
          {redeemPhase && (
            <p className="muted sell-redeem-status">Confirm in your wallet, then wait for Base to include the transaction.</p>
          )}
        </div>
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

  const [selectedReceiptKey, setSelectedReceiptKey] = useState<string | null>(null);
  const [scannedIds, setScannedIds] = useState<string[]>([]);
  const [manualIds, setManualIds] = useState<string[]>([]);
  const [pasteId, setPasteId] = useState("");
  const [pasteIdErr, setPasteIdErr] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanErr, setScanErr] = useState<string | null>(null);
  const [bankrLoading, setBankrLoading] = useState(false);
  const [bankrErr, setBankrErr] = useState<string | null>(null);
  const [bankrRows, setBankrRows] = useState<Record<string, unknown>[]>([]);
  const [escrowWizardRow, setEscrowWizardRow] = useState<Record<string, unknown> | null>(null);
  /** Manual Clanker metadata keyed by launched token `0x` lowercase — listing without `CLANKER_API_KEY`. */
  const [clankerManualByToken, setClankerManualByToken] = useState<Record<string, ClankerManualFields>>({});
  const [clankerPoolDraft, setClankerPoolDraft] = useState<Record<string, string>>({});
  const [clankerLockerDraft, setClankerLockerDraft] = useState<Record<string, string>>({});
  const [clankerManualErr, setClankerManualErr] = useState<Record<string, string>>({});
  const [receiptManualPool, setReceiptManualPool] = useState("");
  const [receiptManualToken, setReceiptManualToken] = useState("");
  const [receiptManualFeeManager, setReceiptManualFeeManager] = useState("");
  const [receiptManualErr, setReceiptManualErr] = useState<string | null>(null);
  const [scanEpoch, setScanEpoch] = useState(0);
  const [mainTab, setMainTab] = useState<"home" | "profile">("home");

  useEffect(() => {
    const root = document.getElementById("root");
    if (!root) return;
    root.classList.toggle("layout-wide", mainTab === "home");
    return () => root.classList.remove("layout-wide");
  }, [mainTab]);
  const [homeListingSearch, setHomeListingSearch] = useState("");
  const walletScanKeyRef = useRef("");
  /** Profile row: `receiptRowKey(collection, tokenId)` while `redeemRights` is in flight. */
  const [redeemingForReceiptKey, setRedeemingForReceiptKey] = useState<string | null>(null);
  /** Profile: approve+list in flight for this receipt row key. */
  const [listingBusyReceiptKey, setListingBusyReceiptKey] = useState<string | null>(null);

  const marketplace = tryParseAddress(envAddr("VITE_MARKETPLACE_ADDRESS"));
  const collection = tryParseAddress(envAddr("VITE_DEFAULT_RECEIPT_COLLECTION"));
  const openSeaCollectionSlug = import.meta.env.VITE_OPENSEA_COLLECTION_SLUG || "token-marketplace-981215191";
  const receiptCollectionAliases = useMemo(() => envAddrCsvList("VITE_RECEIPT_COLLECTION_ALIASES"), []);

  const receiptScanTargets = useMemo(() => {
    const seen = new Set<string>();
    const out: Address[] = [];
    const push = (a: Address | undefined) => {
      if (!a || isPlaceholderCollectionAddress(a)) return;
      const k = a.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      out.push(a);
    };
    push(collection ?? undefined);
    for (const a of receiptCollectionAliases) push(a);
    return out;
  }, [collection, receiptCollectionAliases]);

  const receiptScanTargetsKey = useMemo(
    () => [...receiptScanTargets].map((a) => a.toLowerCase()).sort().join(","),
    [receiptScanTargets],
  );
  const wrongNetwork = isConnected && chainId !== MVP_CHAIN_ID;
  const txDisabled  = !isConnected || writePending || wrongNetwork;

  const usingPublicRpc = useMemo(() => isPublicRpcUrl(rpcUrlFromEnv()), []);

  const allTokenIds = useMemo(() => {
    const set = new Set([...scannedIds, ...manualIds]);
    return [...set].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  }, [scannedIds, manualIds]);

  const idsForWatch = useMemo(
    () => allTokenIds.filter((id) => id.length > 0 && /^\d+$/.test(id)),
    [allTokenIds],
  );

  // Auto-scan when wallet connects (on-chain only — same wallet that holds the receipts)
  useEffect(() => {
    if (!isConnected || !address || receiptScanTargets.length === 0 || !publicClient) return;
    const key = `${getAddress(address)}|${receiptScanTargetsKey}`;
    const identityChanged = walletScanKeyRef.current !== key;
    if (identityChanged) {
      walletScanKeyRef.current = key;
      setManualIds([]);
      setSelectedReceiptKey(null);
      setScannedIds([]);
    }

    setScanErr(null);
    setScanning(true);
    (async () => {
      try {
        const ids = await scanWalletReceiptTokenIds(
          publicClient,
          getAddress(address),
          receiptScanTargets,
        );
        setScannedIds(ids);
      } catch (e) {
        setScanErr(formatReceiptScanError(e));
      } finally { setScanning(false); }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, address, receiptScanTargetsKey, scanEpoch]);

  // Listings
  const { data: activeListings = [], isLoading: listingsLoading, isFetching: listingsFetching, refetch: refetchListings } = useQuery({
    queryKey: ["listings", marketplace ?? ""],
    queryFn: async () => {
      if (!publicClient || !marketplace) return [];
      const nextId = await publicClient.readContract({
        address: marketplace,
        abi: feeRightsFixedSaleAbi,
        functionName: "nextListingId",
      }) as bigint;
      return fetchActiveListings(publicClient, marketplace, nextId);
    },
    enabled: Boolean(publicClient && marketplace),
    staleTime: 12_000,
  });

  const listingSearchEnrich = useActiveListingsSearchEnrichment(
    activeListings as ActiveListing[],
  );

  const filteredHomeListings = useMemo(() => {
    const list = activeListings as ActiveListing[];
    return list.filter((li, i) =>
      listingMatchesSearch(li, listingSearchEnrich[i] ?? null, homeListingSearch),
    );
  }, [activeListings, listingSearchEnrich, homeListingSearch]);

  const myListings = useMemo(() => {
    if (!address) return [];
    const me = getAddress(address);
    return (activeListings as ActiveListing[]).filter(
      (li) => isAddress(li.seller) && getAddress(li.seller) === me,
    );
  }, [activeListings, address]);

  // ── OpenSea listings ──────────────────────────────────────────────────────────
  const { data: openSeaData } = useQuery({
    queryKey: ["opensea-listings", openSeaCollectionSlug],
    queryFn: fetchOpenSeaCollectionListings,
    staleTime: 60_000,
    retry: false,
  });
  const openSeaListingsByTokenId = useMemo((): Map<string, OpenSeaListing> => {
    if (!openSeaData || !openSeaData.ok) return new Map();
    return indexListingsByTokenId(openSeaData.listings);
  }, [openSeaData]);

  const myListedKeys = useMemo(() => {
    const set = new Set<string>();
    for (const li of myListings) {
      if (!isAddress(li.collection, { strict: false })) continue;
      try {
        set.add(receiptRowKey(getAddress(li.collection), li.tokenId.toString()));
      } catch {
        /* skip */
      }
    }
    return set;
  }, [myListings]);

  const ownershipQueries = useQueries({
    queries: (() => {
      if (!publicClient || !address || receiptScanTargets.length === 0) return [];
      const me = getAddress(address);
      return idsForWatch.map((id) => ({
        queryKey: ["bfrr-owner-resolve", receiptScanTargetsKey, me, id] as const,
        queryFn: async (): Promise<{ collection: Address } | null> => {
          if (!publicClient) return null;
          for (const col of receiptScanTargets) {
            try {
              const o = await publicClient.readContract({
                address: col,
                abi: erc721Abi,
                functionName: "ownerOf",
                args: [BigInt(id)],
              }) as Address;
              if (isAddress(o, { strict: false }) && getAddress(o) === me) {
                return { collection: getAddress(col) };
              }
            } catch {
              /* not minted on this collection or RPC */
            }
          }
          return null;
        },
        staleTime: 12_000,
      }));
    })(),
  });

  const ownershipReady =
    idsForWatch.length === 0 ||
    ownershipQueries.length === 0 ||
    ownershipQueries.every((q) => q.status === "success" || q.status === "error");

  const walletOwnedReceipts = useMemo(() => {
    if (!address || !ownershipReady) return [];
    const out: { tokenId: string; collection: Address }[] = [];
    for (let i = 0; i < idsForWatch.length; i++) {
      const q = ownershipQueries[i];
      if (q.status !== "success" || !q.data) continue;
      const row = q.data as { collection: Address };
      out.push({ tokenId: idsForWatch[i], collection: row.collection });
    }
    return out.sort((a, b) =>
      a.collection.toLowerCase() !== b.collection.toLowerCase()
        ? a.collection.toLowerCase().localeCompare(b.collection.toLowerCase())
        : (BigInt(a.tokenId) < BigInt(b.tokenId) ? -1 : BigInt(a.tokenId) > BigInt(b.tokenId) ? 1 : 0),
    );
  }, [address, idsForWatch, ownershipQueries, ownershipReady]);

  /** Drop scan hits that are no longer owned; keep pasted manual IDs so users see feedback instead of “nothing happened”. */
  useEffect(() => {
    if (!ownershipReady || !address) return;
    const keepScanned = (id: string) => {
      const i = idsForWatch.indexOf(id);
      if (i < 0) return true;
      const q = ownershipQueries[i];
      if (q?.status === "error") return true;
      if (q?.status !== "success") return true;
      return q.data !== null;
    };
    setScannedIds((prev) => prev.filter(keepScanned));
  }, [ownershipReady, address, idsForWatch, ownershipQueries]);

  const manualIdWatchHints = useMemo(() => {
    if (!address || receiptScanTargets.length === 0) return [];
    return manualIds.filter((id) => idsForWatch.includes(id)).map((id) => {
      const i = idsForWatch.indexOf(id);
      const q = i >= 0 ? ownershipQueries[i] : undefined;
      const owned = Boolean(
        ownershipReady &&
          q?.status === "success" &&
          q.data !== null &&
          q.data !== undefined,
      );
      if (owned) return null;
      let label = "Checking on Base…";
      if (q?.status === "error") {
        label = "Could not verify (RPC error). Try Refresh or another RPC.";
      } else if (ownershipReady && q?.status === "success" && (q.data === null || q.data === undefined)) {
        label =
          "This wallet is not ownerOf that id on your configured fee-rights NFT contracts, or the id does not exist there. Add the NFT contract to VITE_RECEIPT_COLLECTION_ALIASES if it is a legacy collection.";
      }
      return { id, label };
    }).filter((x): x is { id: string; label: string } => x !== null);
  }, [address, manualIds, idsForWatch, ownershipQueries, ownershipReady, receiptScanTargets.length]);

  const unlistedBfrrReceipts = useMemo(
    () =>
      walletOwnedReceipts.filter(
        (r) => !myListedKeys.has(receiptRowKey(r.collection, r.tokenId)),
      ),
    [walletOwnedReceipts, myListedKeys],
  );

  const positionQueries = useQueries({
    queries: (() => {
      if (!publicClient || !ownershipReady) return [];
      return walletOwnedReceipts.map((r) => ({
        queryKey: ["bfrr-position-bankr-dedupe", r.collection, r.tokenId],
        queryFn: async () => {
          if (!publicClient) return null;
          try {
            return await publicClient.readContract({
              address: r.collection,
              abi: bankrFeeRightsReceiptAbi,
              functionName: "positionOf",
              args: [BigInt(r.tokenId)],
            }) as {
              feeManager: Address;
              poolId: Hex;
              token0: Address;
              token1: Address;
              seller: Address;
              factoryName: string;
            };
          } catch {
            return null;
          }
        },
        staleTime: 15_000,
      }));
    })(),
  });

  const bfrrDedupeReady =
    idsForWatch.length === 0 ||
    (!ownershipReady
      ? false
      : walletOwnedReceipts.length === 0 ||
        positionQueries.length === 0 ||
        positionQueries.every((q) => q.status === "success" || q.status === "error"));

  const { heldPoolIds } = useMemo(() => {
    const pools = new Set<string>();
    const zeroPool = `0x${"0".repeat(64)}`;
    for (const q of positionQueries) {
      const pos = q.data;
      if (!pos) continue;
      const pid = String(pos.poolId).toLowerCase();
      if (pid && pid !== zeroPool) pools.add(pid);
    }
    return { heldPoolIds: pools };
  }, [positionQueries]);

  const bankrRowsNotYetReceived = useMemo(() => {
    if (idsForWatch.length > 0 && !bfrrDedupeReady) return [];
    if (heldPoolIds.size === 0) return bankrRows;
    return bankrRows.filter((row) => {
      const pid = rowPoolIdHex(row);
      if (pid && heldPoolIds.has(pid.toLowerCase())) return false;
      return true;
    });
  }, [bankrRows, heldPoolIds, idsForWatch.length, bfrrDedupeReady]);

  useEffect(() => {
    if (!ownershipReady || !selectedReceiptKey) return;
    if (
      !walletOwnedReceipts.some(
        (r) => receiptRowKey(r.collection, r.tokenId) === selectedReceiptKey,
      )
    ) {
      setSelectedReceiptKey(null);
    }
  }, [ownershipReady, selectedReceiptKey, walletOwnedReceipts]);

  const invalidate = () => void qc.invalidateQueries();
  const run = async (fn: () => Promise<unknown>) => {
    try { await fn(); invalidate(); } catch { /* surfaced via writeError */ }
  };

  const loadBankrLaunches = useCallback(async () => {
    if (!address) return;
    setBankrLoading(true);
    setBankrErr(null);
    try {
      const [bankrRes, clankerRes] = await Promise.all([
        fetch(`/api/bankr-launches?q=${encodeURIComponent(address)}`),
        fetch(
          `/api/clanker-search-creator?q=${encodeURIComponent(address)}&limit=50&sort=desc`,
        ),
      ]);

      const bankrJson = (await bankrRes.json()) as {
        ok?: boolean;
        error?: string;
        hint?: string;
        data?: unknown;
      };

      if (!bankrJson.ok) {
        setBankrErr(
          [bankrJson.error, bankrJson.hint].filter(Boolean).join(" — ") || `HTTP ${bankrRes.status}`,
        );
        return;
      }

      const bankrRowsLocal = extractBankrLaunchRows(bankrJson.data);

      let clankerRows: Record<string, unknown>[] = [];
      try {
        const clankerJson = (await clankerRes.json()) as {
          ok?: boolean;
          data?: unknown;
        };
        if (clankerJson.ok && clankerJson.data) {
          clankerRows = normalizeClankerSearchRows(clankerJson.data);
        }
      } catch {
        /* Clanker supplement only — ignore parse failures */
      }

      const merged = mergeCreatorFeeRows(bankrRowsLocal, clankerRows);
      // Phase 1: API enrichment — try raw public API fields, then authenticated API
      const phase1 = await Promise.all(
        merged.map(async (row): Promise<Record<string, unknown>> => {
          if (row.__launchVenue !== "Clanker") return row;
          const ta = rowLaunchedToken(row);
          if (!ta) return row;

          // Raw public API response (search-creator) may already include pool_address
          const rawPool = clankerPoolFromDetail(row as unknown as ClankerTokenDetail);
          const rawLocker = clankerLockerFromDetail(row as unknown as ClankerTokenDetail);
          if (rawPool) {
            return {
              ...row,
              ...(rawLocker ? { __clankerLocker: rawLocker } : {}),
              __clankerPool: rawPool,
            };
          }

          // Try authenticated API (requires CLANKER_API_KEY on server)
          try {
            const detail = await fetchClankerTokenDetail(ta);
            if (detail) {
              const locker = clankerLockerFromDetail(detail);
              const pool = clankerPoolFromDetail(detail);
              const paired = clankerPairedFromDetail(detail);
              if (pool) {
                return {
                  ...row,
                  ...(locker ? { __clankerLocker: locker } : {}),
                  __clankerPool: pool,
                  ...(paired ? { __clankerPaired: paired } : {}),
                };
              }
            }
          } catch { /* ignore */ }

          // Mark for on-chain detection
          return { ...row, __clankerNeedsDetect: true };
        }),
      );

      // Show results immediately so the UI isn't blank while on-chain detection runs
      setBankrRows(phase1);

      // Phase 2: batch on-chain detection for tokens still unresolved
      const detectTargets = phase1
        .filter((r) => r.__clankerNeedsDetect)
        .map((r) => rowLaunchedToken(r))
        .filter((ta): ta is Address => ta !== null);

      if (detectTargets.length > 0 && publicClient) {
        try {
          // Detect v4 tokens via tokenRewards() — one multicall for all
          const v4Calls = await publicClient.multicall({
            contracts: detectTargets.map((ta) => ({
              address: CLANKER_V4_DEFAULT_LOCKER as Address,
              abi: clankerLockerV4Abi,
              functionName: "tokenRewards" as const,
              args: [ta] as const,
            })),
            allowFailure: true,
          });

          const v4Set = new Set<string>();
          for (let i = 0; i < detectTargets.length; i++) {
            const r = v4Calls[i];
            if (
              r.status === "success" &&
              r.result &&
              (r.result as { positionId: bigint }).positionId > 0n
            ) {
              v4Set.add(detectTargets[i].toLowerCase());
            }
          }

          // For non-v4 tokens, try Uniswap V3 factory (WETH pair, common fee tiers)
          const v3Targets = detectTargets.filter((ta) => !v4Set.has(ta.toLowerCase()));
          const poolMap = new Map<string, Address>();

          if (v3Targets.length > 0) {
            const UNI_V3_FACTORY = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" as Address;
            const uniV3FactoryAbi = [
              {
                type: "function" as const,
                name: "getPool",
                stateMutability: "view" as const,
                inputs: [
                  { name: "tokenA", type: "address" as const },
                  { name: "tokenB", type: "address" as const },
                  { name: "fee", type: "uint24" as const },
                ],
                outputs: [{ name: "pool", type: "address" as const }],
              },
            ] as const;
            const FEE_TIERS = [10000, 3000, 500] as const;
            const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

            const poolCalls = await publicClient.multicall({
              contracts: v3Targets.flatMap((ta) =>
                FEE_TIERS.map((fee) => ({
                  address: UNI_V3_FACTORY,
                  abi: uniV3FactoryAbi,
                  functionName: "getPool" as const,
                  args: [ta, WETH_BASE as Address, fee] as const,
                })),
              ),
              allowFailure: true,
            });

            for (let i = 0; i < v3Targets.length; i++) {
              for (let j = 0; j < FEE_TIERS.length; j++) {
                const r = poolCalls[i * FEE_TIERS.length + j];
                if (
                  r.status === "success" &&
                  r.result &&
                  (r.result as string) !== ZERO_ADDR
                ) {
                  poolMap.set(v3Targets[i].toLowerCase(), r.result as Address);
                  break;
                }
              }
            }
          }

          // Apply on-chain detection results to rows
          setBankrRows(
            phase1.map((row) => {
              if (!row.__clankerNeedsDetect) return row;
              const ta = rowLaunchedToken(row);
              if (!ta) return { ...row, __clankerDetailFailed: true };
              const { __clankerNeedsDetect: _d, ...rest } = row;
              const taLower = ta.toLowerCase();
              if (v4Set.has(taLower)) return { ...rest, __clankerLocker: CLANKER_V4_DEFAULT_LOCKER };
              const pool = poolMap.get(taLower);
              if (pool) return { ...rest, __clankerPool: pool };
              return { ...rest, __clankerDetailFailed: true };
            }),
          );
        } catch {
          // On-chain detection failed — clear markers and show what we have
          setBankrRows(
            phase1.map((row) => {
              if (!row.__clankerNeedsDetect) return row;
              const { __clankerNeedsDetect: _d, ...rest } = row;
              return { ...rest, __clankerDetailFailed: true };
            }),
          );
        }
      }
    } catch (e) {
      setBankrErr(
        e instanceof Error
          ? e.message
          : "Could not reach launch APIs (deploy on Vercel or run vercel dev).",
      );
    } finally {
      setBankrLoading(false);
    }
  }, [address, publicClient]);

  const refreshProfile = useCallback(() => {
    void loadBankrLaunches();
    void refetchListings();
    void qc.invalidateQueries();
    setScanEpoch((e) => e + 1);
  }, [loadBankrLaunches, refetchListings, qc]);

  const refreshBusy = bankrLoading || scanning;

  const applyClankerManualForToken = useCallback((tokenKey: string) => {
    const poolRaw = clankerPoolDraft[tokenKey]?.trim() ?? "";
    const lockerRaw = clankerLockerDraft[tokenKey]?.trim() ?? "";

    // Validate locker first (if provided).
    if (lockerRaw && (!lockerRaw.startsWith("0x") || !isAddress(lockerRaw, { strict: false }))) {
      setClankerManualErr((prev) => ({ ...prev, [tokenKey]: "Invalid locker address (leave blank to use the default)." }));
      return;
    }

    // v4 lockers don't use a Uniswap V3 pool — pool field is not required.
    const lockerIsV4 = lockerRaw && isAddress(lockerRaw, { strict: false }) && isV4Locker(lockerRaw);

    if (!lockerIsV4) {
      // v3 path: pool is required.
      if (!poolRaw.startsWith("0x") || !isAddress(poolRaw, { strict: false })) {
        setClankerManualErr((prev) => ({
          ...prev,
          [tokenKey]: "Enter the Uniswap V3 pool contract address (0x…), or paste a Clanker v4 locker in the locker field to skip this.",
        }));
        return;
      }
    }

    setClankerManualErr((prev) => {
      const next = { ...prev };
      delete next[tokenKey];
      return next;
    });
    setClankerManualByToken((prev) => ({
      ...prev,
      [tokenKey]: {
        ...(poolRaw && isAddress(poolRaw, { strict: false }) ? { pool: getAddress(poolRaw) } : {}),
        ...(lockerRaw && isAddress(lockerRaw, { strict: false }) ? { locker: getAddress(lockerRaw) } : {}),
      } as ClankerManualFields,
    }));
  }, [clankerPoolDraft, clankerLockerDraft]);

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
    if (!isConnected || !address) return;
    void loadBankrLaunches();
  }, [isConnected, address, loadBankrLaunches]);

  return (
    <div>
      <nav className="nav">
        <div className="nav-left">
          <div className="nav-logo">Token <span>Marketplace</span></div>
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
            <h1>Listings</h1>
            <p className="muted">Token Marketplace · Base</p>
          </div>

          <section>
            <div className="section-head">
              <h2>All listings</h2>
              <button type="button" className="btn btn-ghost btn-sm"
                disabled={!marketplace || listingsLoading}
                onClick={() => {
                  void qc.invalidateQueries();
                  void refetchListings();
                }}>
                Refresh
              </button>
            </div>

            <div className="listings-toolbar">
              <input
                type="search"
                className="listings-search-input"
                placeholder="Search seller, token address, symbol, name, pool id…"
                value={homeListingSearch}
                onChange={(e) => setHomeListingSearch(e.target.value)}
                aria-label="Filter listings"
                disabled={!marketplace || listingsLoading}
              />
              {homeListingSearch.trim() !== "" && !listingsLoading && (
                <span className="listings-toolbar__meta muted">
                  {filteredHomeListings.length} of {(activeListings as ActiveListing[]).length}
                </span>
              )}
            </div>

            {listingsLoading && <p className="empty"><span className="spinner" />Loading…</p>}

            {!listingsLoading && (activeListings as ActiveListing[]).length === 0 && (
              <p className="empty">{marketplace ? "Nothing for sale right now." : "Listings are unavailable — this deployment has no marketplace configured."}</p>
            )}

            {!listingsLoading &&
              (activeListings as ActiveListing[]).length > 0 &&
              filteredHomeListings.length === 0 &&
              homeListingSearch.trim() !== "" && (
                <p className="empty">No listings match your search. Try a wallet address, contract address, ticker, or words from the pool name.</p>
              )}

            <div className="listings-grid">
              {filteredHomeListings.map((li) => {
                const tokenIdStr = li.tokenId.toString();
                const osListing = openSeaListingsByTokenId.get(tokenIdStr);
                return (
                  <ListingCard
                    key={li.listingId.toString()}
                    li={li}
                    bfrr={collection}
                    address={address}
                    txDisabled={txDisabled}
                    isConnected={isConnected}
                    wrongNetwork={wrongNetwork}
                    openSeaListing={osListing}
                    openSeaUrl={openSeaAssetUrl(li.collection, tokenIdStr)}
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
                );
              })}
            </div>
          </section>

          <p className="muted profile-tab-hint">
            Selling something of your own? Open{" "}
            <button type="button" className="link-btn" onClick={() => setMainTab("profile")}>My profile</button>.
          </p>

          {/* ── OpenSea cross-listings ───────────────────────────────────── */}
          {openSeaData?.ok && openSeaData.listings.length > 0 && (
            <section>
              <div className="section-head">
                <h2>
                  Also on OpenSea
                </h2>
                <a
                  href={openSeaCollectionUrl(openSeaCollectionSlug)}
                  target="_blank"
                  rel="noreferrer"
                  className="btn btn-ghost btn-sm"
                >
                  View collection ↗
                </a>
              </div>
              <p className="muted one-liner">
                These Token Marketplace receipts are also listed on{" "}
                <a href={openSeaCollectionUrl(openSeaCollectionSlug)} target="_blank" rel="noreferrer">OpenSea</a>.
                Buy directly on OpenSea or wait for them to appear above.
              </p>
              <div className="listings-grid">
                {openSeaData.listings.map((osl) => (
                  <div key={osl.orderHash ?? osl.tokenId ?? Math.random()} className="listing-card opensea-card">
                    <div className="listing-card__header">
                      <span className="listing-card__title mono">
                        {osl.tokenId ? `TMPR #${osl.tokenId}` : "TMPR NFT"}
                      </span>
                      <span className="badge badge--opensea">OpenSea</span>
                    </div>
                    <div className="listing-card__price">
                      {osl.priceEth
                        ? <><strong>{osl.priceEth}</strong> {osl.priceCurrency}</>
                        : <span className="muted">Price unknown</span>
                      }
                    </div>
                    {osl.maker && (
                      <p className="listing-card__seller muted mono">
                        Seller: {osl.maker.slice(0, 6)}…{osl.maker.slice(-4)}
                      </p>
                    )}
                    {osl.permalink && (
                      <a
                        href={osl.permalink}
                        target="_blank"
                        rel="noreferrer"
                        className="btn btn-ghost btn-sm"
                        style={{ marginTop: "0.5rem", width: "100%", textAlign: "center" }}
                      >
                        Buy on OpenSea ↗
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* quiet link even when no OS listings are live */}
          {(!openSeaData || (openSeaData.ok && openSeaData.listings.length === 0)) && (
            <p className="muted" style={{ textAlign: "center", fontSize: "0.78rem", marginTop: "0.25rem" }}>
              TMPR receipts are also tradable on{" "}
              <a href={openSeaCollectionUrl(openSeaCollectionSlug)} target="_blank" rel="noreferrer">OpenSea ↗</a>
            </p>
          )}
        </>
      )}

      {mainTab === "profile" && (
        <>
          <div className="hero hero--compact profile-hero">
            <div className="profile-hero__main">
              <h1>My profile</h1>
              <p className="muted">Your wallet and items on Base.</p>
            </div>
            {isConnected && address && marketplace && receiptScanTargets.length > 0 && (
              <button
                type="button"
                className="btn btn-primary btn-sm profile-hero__refresh"
                disabled={refreshBusy}
                onClick={() => void refreshProfile()}
              >
                {refreshBusy ? (
                  <><span className="spinner" />Refreshing…</>
                ) : (
                  "Refresh"
                )}
              </button>
            )}
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

          {isConnected && address && (
            <>
              {receiptScanTargets.length > 0 && marketplace && (
                <p className="muted profile-flow-lead">
                  <strong>1</strong> Eligible token → <strong>2</strong> NFT in your wallet → <strong>3</strong> listed here.
                  <InfoTip label="What each step means">
                    <p>
                      <strong>1</strong> Pick a token row and use <strong>List</strong> to run escrow (several Base confirmations may be needed) until the fee-rights NFT is minted.
                    </p>
                    <p>
                      <strong>2</strong> Open <strong>List</strong> on an NFT to set price; your wallet may approve the marketplace, then confirm the listing.
                    </p>
                    <p>
                      <strong>3</strong> Active offers appear under <strong>Your listings</strong>. <strong>Return to my wallet</strong> redeems fee rights (burns the receipt NFT on-chain); use <strong>Cancel sale</strong> first if this NFT is listed on the marketplace.
                    </p>
                  </InfoTip>
                </p>
              )}

              {receiptScanTargets.length > 0 && marketplace && (
                <section className="bankr-panel">
                  <div className="section-head">
                    <h2 className="section-head__title">
                      Tokens that could be listed
                      <InfoTip label="About this list">
                        <p>
                          Rows merge Bankr creator-fees data with{" "}
                          <a
                            href="https://clanker.gitbook.io/documentation/public/get-tokens-by-creator"
                            target="_blank"
                            rel="noreferrer"
                          >
                            Clanker creator search
                          </a>{" "}
                          (public — no key). <strong>List</strong> needs either a Bankr <strong>pool id</strong>, or for Clanker a Uniswap V3{" "}
                          <strong>pool contract</strong> (paste under the row if you do not use authenticated token lookup). Optional{" "}
                          <span className="mono">CLANKER_API_KEY</span> on the server fills pool and locker automatically.
                        </p>
                      </InfoTip>
                    </h2>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={refreshBusy}
                      onClick={() => void refreshProfile()}
                    >
                      {refreshBusy ? <><span className="spinner" />Refreshing…</> : "Refresh"}
                    </button>
                  </div>
                  <p className="muted one-liner">
                    Bankr: list when a <strong>pool id</strong> is present. Clanker: list when we have a <strong>pool contract</strong> (filled automatically when possible, or paste under the row).
                  </p>
                  {idsForWatch.length > 0 && !bfrrDedupeReady && (
                    <p className="muted one-liner" style={{ marginTop: "0.4rem" }}>
                      Matching rows to NFTs you already hold…
                    </p>
                  )}
                  {bankrRowsNotYetReceived.length > 0 ? (
                    <ul className="bankr-panel__list">
                      {bankrRowsNotYetReceived.map((row, i) => {
                        const launched = rowLaunchedToken(row);
                        const manualKey = launched ? launched.toLowerCase() : null;
                        const manual =
                          manualKey !== null ? clankerManualByToken[manualKey] : undefined;
                        const rowEffective =
                          manual !== undefined ? mergeClankerManual(row, manual) : row;
                        const ta = rowEffective.tokenAddress ?? row.tokenAddress;
                        const pid = rowEffective.poolId ?? row.poolId;
                        const poolHex = rowPoolIdHex(rowEffective);
                        const poolReady =
                          Boolean(poolHex) || rowClankerListingReady(rowEffective);
                        const key =
                          typeof ta === "string" && ta.startsWith("0x")
                            ? ta.toLowerCase()
                            : typeof pid === "string"
                              ? `${pid}-${i}`
                              : `row-${i}`;
                        const showClankerManual =
                          row.__launchVenue === "Clanker" &&
                          manualKey !== null &&
                          !rowClankerListingReady(rowEffective);
                        return (
                          <li key={key}>
                            <div className="bankr-panel__row">
                              <div className="bankr-panel__col">
                                <span className="bankr-panel__name">
                                  {launchRowLabel(rowEffective)}
                                  {row.__launchVenue === "Clanker" && !poolReady ? (
                                    <span className="muted" style={{ marginLeft: "0.35rem", fontSize: "0.78rem" }}>
                                      · Clanker
                                    </span>
                                  ) : null}
                                </span>
                                {poolHex && (
                                  <div className="bankr-panel__sub mono" title={poolHex}>
                                    Pool {poolHex.slice(0, 10)}…{poolHex.slice(-8)}
                                  </div>
                                )}
                                {!poolHex &&
                                  row.__launchVenue === "Clanker" &&
                                  typeof rowEffective.__clankerPool === "string" &&
                                  rowEffective.__clankerPool.startsWith("0x") &&
                                  poolReady && (
                                    <div className="bankr-panel__sub mono" title={String(rowEffective.__clankerPool)}>
                                      Pair pool {shortAddr(String(rowEffective.__clankerPool))}
                                    </div>
                                  )}
                              </div>
                              <a
                                className="bankr-panel__row-ext"
                                href={launchRowHref(row, address ?? "")}
                                target="_blank"
                                rel="noreferrer"
                                title="Open launch page"
                              >
                                ↗
                              </a>
                              <button
                                type="button"
                                className="bankr-panel__mint btn btn-ghost btn-sm"
                                disabled={wrongNetwork || !poolReady}
                                title={
                                  poolReady
                                    ? undefined
                                    : row.__launchVenue === "Clanker"
                                      ? "Paste the Uniswap V3 pool contract under this row (or set CLANKER_API_KEY on the server)."
                                      : "Pool id missing — use advanced paste or a Bankr-indexed row with pool id."
                                }
                                onClick={() => setEscrowWizardRow(rowEffective)}
                              >
                                List
                              </button>
                            </div>
                            {showClankerManual && manualKey !== null ? (
                              <div
                                className="bankr-panel__clanker-manual"
                                style={{
                                  marginTop: "0.45rem",
                                  paddingTop: "0.45rem",
                                  borderTop: "1px solid rgba(63, 63, 70, 0.35)",
                                }}
                              >
{(() => {
                                  const lockerDraft = clankerLockerDraft[manualKey]?.trim() ?? "";
                                  const draftIsV4 = lockerDraft.startsWith("0x") &&
                                    isAddress(lockerDraft, { strict: false }) &&
                                    isV4Locker(lockerDraft);
                                  return (
                                    <>
                                      {draftIsV4 ? (
                                        <p className="muted" style={{ fontSize: "0.78rem", marginBottom: "0.4rem", lineHeight: 1.45 }}>
                                          <strong>Clanker v4</strong> locker detected — no pool address needed.
                                          Hit <strong>Apply</strong> to enable List.
                                        </p>
                                      ) : (
                                        <p className="muted" style={{ fontSize: "0.78rem", marginBottom: "0.4rem", lineHeight: 1.45 }}>
                                          <strong>v3 token?</strong> Paste the Uniswap V3 pool contract on Base.{" "}
                                          <strong>v4 token?</strong> Paste the Clanker v4 locker in the locker field — no pool needed.
                                        </p>
                                      )}
                                      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", alignItems: "center" }}>
                                        {!draftIsV4 && (
                                          <input
                                            type="text"
                                            autoComplete="off"
                                            spellCheck={false}
                                            placeholder="Pool contract 0x… (v3 tokens)"
                                            className="mono"
                                            style={{
                                              flex: "1 1 220px",
                                              minWidth: 0,
                                              padding: "0.35rem 0.5rem",
                                              borderRadius: 8,
                                              border: "1px solid rgba(63, 63, 70, 0.55)",
                                              background: "rgba(9, 9, 11, 0.6)",
                                              color: "inherit",
                                            }}
                                            value={clankerPoolDraft[manualKey] ?? ""}
                                            onChange={(e) =>
                                              setClankerPoolDraft((prev) => ({ ...prev, [manualKey]: e.target.value }))
                                            }
                                          />
                                        )}
                                        <input
                                          type="text"
                                          autoComplete="off"
                                          spellCheck={false}
                                          placeholder={draftIsV4 ? "Locker (v4 ✓)" : "Locker 0x… (paste v4 locker, or leave blank for v3 default)"}
                                          className="mono"
                                          style={{
                                            flex: "1 1 200px",
                                            minWidth: 0,
                                            padding: "0.35rem 0.5rem",
                                            borderRadius: 8,
                                            border: `1px solid ${draftIsV4 ? "rgba(249,115,22,0.7)" : "rgba(63, 63, 70, 0.55)"}`,
                                            background: "rgba(9, 9, 11, 0.6)",
                                            color: "inherit",
                                          }}
                                          value={clankerLockerDraft[manualKey] ?? ""}
                                          onChange={(e) =>
                                            setClankerLockerDraft((prev) => ({ ...prev, [manualKey]: e.target.value }))
                                          }
                                        />
                                        <button
                                          type="button"
                                          className="btn btn-ghost btn-sm"
                                          onClick={() => applyClankerManualForToken(manualKey)}
                                        >
                                          Apply
                                        </button>
                                      </div>
                                      {!draftIsV4 && (
                                        <p className="muted" style={{ fontSize: "0.72rem", marginTop: "0.3rem", opacity: 0.65 }}>
                                          v4 locker: <span className="mono">0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496</span>
                                        </p>
                                      )}
                                    </>
                                  );
                                })()}
                                {clankerManualErr[manualKey] ? (
                                  <p className="err" style={{ fontSize: "0.78rem", marginTop: "0.35rem" }}>
                                    {clankerManualErr[manualKey]}
                                  </p>
                                ) : null}
                              </div>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    !bankrLoading && (
                      <>
                        {bankrErr ? (
                          <p className="err one-liner">{bankrErr}</p>
                        ) : bankrRows.length === 0 ? (
                          <p className="muted one-liner">
                            Nothing loaded — try <strong>Refresh</strong>, or open <strong>advanced</strong> below.
                          </p>
                        ) : !bfrrDedupeReady ? null : (
                          <p className="muted one-liner">
                            Everything here already has a matching NFT below. <strong>Refresh</strong> if that seems wrong.
                          </p>
                        )}
                        <details className="profile-advanced">
                          <summary>Can’t find your token? (advanced)</summary>
                          <div className="profile-advanced__body">
                            <p className="muted one-liner" style={{ marginBottom: "0.5rem" }}>
                              Enter pool id and launch token if the list above is empty or wrong.
                              <InfoTip label="Where to find pool id, token, and fee manager">
                                <ol className="info-tip__ol">
                                  <li>
                                    <strong>Pool ID</strong> — On{" "}
                                    <a href={`https://basescan.org/address/${ESCROW_ADDRESS}`} target="_blank" rel="noreferrer">BaseScan</a>, open your wallet’s <strong>Prepare deposit</strong> transaction to escrow <span className="mono">{shortAddr(ESCROW_ADDRESS)}</span>. Use <strong>Input data</strong> → <strong>Decode input data</strong>. Copy <span className="mono">poolId</span>: exactly <strong>0x</strong> + <strong>64</strong> hex characters.
                                  </li>
                                  <li>
                                    <strong>Fee manager (optional)</strong> — From the same decoded call: the first address argument (<span className="mono">feeManager</span>). Paste it if you already transferred fees to escrow and the flow says you are not the current beneficiary; the app can then offer finalize / mint without another lookup.
                                  </li>
                                  <li>
                                    <strong>Launched token</strong> — The ERC-20 traders swap (the coin contract), not the fee-rights NFT contract and not the marketplace.
                                  </li>
                                </ol>
                              </InfoTip>
                            </p>
                            {receiptManualErr && <p className="err" style={{ fontSize: "0.82rem", marginBottom: "0.35rem" }}>{receiptManualErr}</p>}
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
                          </div>
                          <label className="muted" style={{ fontSize: "0.75rem", display: "block", marginTop: "0.5rem", marginBottom: "0.2rem" }}>
                            3. Fee manager (optional)
                          </label>
                          <div className="profile-paste-row" style={{ marginTop: 0 }}>
                            <input
                              className="mono"
                              placeholder="0x… fee manager (optional)"
                              value={receiptManualFeeManager}
                              onChange={(e) => {
                                setReceiptManualFeeManager(e.target.value);
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
                                const fmOpt = tryParseAddress(receiptManualFeeManager.trim());
                                if (!pid) {
                                  setReceiptManualErr(explainPoolIdPasteError(receiptManualPool));
                                  return;
                                }
                                if (!tok) {
                                  setReceiptManualErr("Enter the launched token as a normal 0x address (40 hex digits).");
                                  return;
                                }
                                setReceiptManualErr(null);
                                const row: Record<string, unknown> = {
                                  poolId: pid,
                                  tokenAddress: tok,
                                  tokenSymbol: "Token",
                                };
                                if (fmOpt) row.feeManager = fmOpt;
                                setEscrowWizardRow(row);
                              }}
                            >
                              Open listing setup
                            </button>
                          </div>
                          </div>
                        </details>
                      </>
                    )
                  )}
                </section>
              )}

              {receiptScanTargets.length > 0 && marketplace && (
                <section>
                  <div className="section-head">
                    <h2 className="section-head__title">
                      NFTs in your wallet
                      <InfoTip label="About these NFTs">
                        <p>
                          Each item is a Token Marketplace receipt NFT on Base. This list is NFTs you hold that are not listed on this
                          site yet. <strong>List</strong> sets price (approve + list when needed). <strong>Return to my wallet</strong> calls escrow <strong>redeemRights</strong>: it burns the receipt and restores fee rights to your wallet — not the same as canceling a marketplace listing.
                        </p>
                      </InfoTip>
                    </h2>
                    <span className="scan-status">
                      {scanning ? <><span className="spinner" />Scanning…</> : `${unlistedBfrrReceipts.length} not listed`}
                    </span>
                  </div>
                  <p className="muted one-liner">NFTs in your wallet that are not listed here yet.</p>

                  {usingPublicRpc && !scanErr && (
                    <p className="muted one-liner" style={{ marginBottom: "0.5rem" }}>
                      Using the public Base RPC — NFT scan is limited. For reliable discovery, set{" "}
                      <span className="mono">VITE_RPC_URL</span> to Alchemy/Infura and redeploy.
                    </p>
                  )}

                  {scanErr && <p className="err" style={{ marginBottom: "0.75rem" }}>{scanErr}</p>}

                  {!scanning && unlistedBfrrReceipts.length === 0 && ownershipReady && walletOwnedReceipts.length === 0 && idsForWatch.length === 0 && (
                    <p className="empty">No NFTs found in our scan.</p>
                  )}

                  <details className="profile-advanced profile-advanced--receipt">
                    <summary>NFT not showing? Paste token ID (advanced)</summary>
                    <div className="profile-advanced__body">
                      <p className="muted one-liner" style={{ marginBottom: "0.5rem" }}>
                        If our scan missed an NFT you already minted, add its numeric ID from{" "}
                        <a
                          href={
                            (collection ?? receiptScanTargets[0])
                              ? `https://basescan.org/token/${collection ?? receiptScanTargets[0]}?a=${address ?? ""}`
                              : `https://basescan.org/address/${address ?? ""}`
                          }
                          target="_blank"
                          rel="noreferrer"
                        >
                          BaseScan
                        </a>
                        .
                        <InfoTip label="Finding the token ID on BaseScan">
                          <p>
                            Open the NFT contract on BaseScan, use the <strong>ERC-721</strong> tab or your wallet’s
                            token view, and copy the <strong>Token ID</strong> (digits only).
                          </p>
                        </InfoTip>
                      </p>
                      <div className="profile-paste-row">
                        <input
                          className="mono"
                          placeholder="Paste token ID"
                          value={pasteId}
                          onChange={(e) => {
                            setPasteId(e.target.value);
                            setPasteIdErr(null);
                          }}
                          spellCheck={false}
                        />
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => {
                            const raw = pasteId.trim().replace(/\s+/g, "").replace(/,/g, "");
                            if (!raw) return;
                            setPasteIdErr(null);
                            if (!/^\d+$/.test(raw)) {
                              setPasteIdErr("Use decimal digits only (no 0x, no scientific notation).");
                              return;
                            }
                            try {
                              const id = BigInt(raw).toString();
                              setManualIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
                              setSelectedReceiptKey(null);
                              setPasteId("");
                            } catch {
                              setPasteIdErr("That value is not a valid integer token id.");
                            }
                          }}
                        >
                          Add
                        </button>
                      </div>
                      {pasteIdErr && (
                        <p className="err" style={{ fontSize: "0.78rem", marginTop: "0.4rem" }}>
                          {pasteIdErr}
                        </p>
                      )}
                      {manualIdWatchHints.length > 0 && (
                        <ul className="muted" style={{ fontSize: "0.78rem", marginTop: "0.5rem", lineHeight: 1.45, paddingLeft: "1.1rem" }}>
                          {manualIdWatchHints.map(({ id, label }) => (
                            <li key={id} style={{ marginBottom: "0.35rem" }}>
                              <span className="mono" title={id}>
                                {id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id}
                              </span>
                              {" — "}
                              {label}
                              {" "}
                              <button
                                type="button"
                                className="link-btn"
                                style={{ fontSize: "inherit" }}
                                onClick={() => {
                                  setManualIds((prev) => prev.filter((x) => x !== id));
                                  setPasteIdErr(null);
                                }}
                              >
                                Forget
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </details>

                  <div className="profile-receipt-list">
                    {unlistedBfrrReceipts.map((r) => {
                      const rk = receiptRowKey(r.collection, r.tokenId);
                      const osListing = openSeaListingsByTokenId.get(r.tokenId);
                      return (
                      <div
                        key={rk}
                        className={`profile-receipt-row${selectedReceiptKey === rk ? " profile-receipt-row--open" : ""}${redeemingForReceiptKey === rk || listingBusyReceiptKey === rk ? " profile-receipt-row--pending" : ""}`}
                      >
                        <BfrrCard
                          tokenId={r.tokenId}
                          collection={r.collection}
                          selected={selectedReceiptKey === rk}
                          staticDisplay
                        />
                        {osListing && (
                          <div className="os-badge-row">
                            <span className="badge badge--opensea">On OpenSea</span>
                            {osListing.priceEth && (
                              <span className="muted" style={{ fontSize: "0.78rem" }}>
                                {osListing.priceEth} {osListing.priceCurrency}
                              </span>
                            )}
                            {osListing.permalink && (
                              <a href={osListing.permalink} target="_blank" rel="noreferrer" className="link-btn" style={{ fontSize: "0.78rem" }}>
                                View ↗
                              </a>
                            )}
                          </div>
                        )}
                        {!osListing && (
                          <div className="os-badge-row">
                            <a
                              href={openSeaAssetUrl(r.collection, r.tokenId)}
                              target="_blank"
                              rel="noreferrer"
                              className="link-btn"
                              style={{ fontSize: "0.78rem" }}
                            >
                              View on OpenSea ↗
                            </a>
                          </div>
                        )}
                        <div className="profile-receipt-row__actions">
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            disabled={txDisabled || Boolean(listingBusyReceiptKey)}
                            onClick={() => setSelectedReceiptKey(rk)}
                          >
                            List
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={txDisabled || Boolean(listingBusyReceiptKey)}
                            onClick={() => run(async () => {
                              setRedeemingForReceiptKey(rk);
                              try {
                                if (!publicClient) return;
                                const redeemEscrow = await resolveReceiptRedeemEscrow(publicClient, {
                                  collection: r.collection,
                                  tokenId: BigInt(r.tokenId),
                                  bankrEscrow: ESCROW_ADDRESS,
                                  clankerEscrow: CLANKER_ESCROW_ADDRESS,
                                  clankerEscrowV4: CLANKER_ESCROW_V4_ADDRESS,
                                });
                                await writeContractAsync({
                                  address: redeemEscrow,
                                  abi: escrowAbi,
                                  functionName: "redeemRights",
                                  args: [BigInt(r.tokenId)],
                                  chainId: MVP_CHAIN_ID,
                                });
                                setSelectedReceiptKey(null);
                                setScanEpoch((e) => e + 1);
                                void refetchListings();
                              } finally {
                                setRedeemingForReceiptKey(null);
                              }
                            })}
                          >
                            {redeemingForReceiptKey === rk ? (
                              <><span className="spinner" /> Returning…</>
                            ) : (
                              "Return to my wallet"
                            )}
                          </button>
                        </div>
                        {redeemingForReceiptKey === rk && (
                          <p className="profile-receipt-row__status muted">
                            Confirm in your wallet, then wait for Base to include the transaction.
                          </p>
                        )}
                        {listingBusyReceiptKey === rk && redeemingForReceiptKey !== rk && (
                          <p className="profile-receipt-row__status muted">
                            <span className="spinner" /> Listing on Base… Your listings update when the transaction is confirmed.
                          </p>
                        )}
                        {selectedReceiptKey === rk && (
                          <div className="profile-receipt-row__panel">
                            <SellPanel
                              tokenIdStr={r.tokenId}
                              collection={r.collection}
                              marketplace={marketplace}
                              address={address}
                              txDisabled={txDisabled}
                              isConnected={isConnected}
                              onListFlowStart={() => setListingBusyReceiptKey(rk)}
                              onListFlowEnd={() => setListingBusyReceiptKey(null)}
                              onDone={async () => {
                                setSelectedReceiptKey(null);
                                await qc.invalidateQueries();
                                await refetchListings();
                                setScanEpoch((e) => e + 1);
                              }}
                            />
                          </div>
                        )}
                      </div>
                    );
                    })}
                  </div>
                </section>
              )}

              {(!marketplace || receiptScanTargets.length === 0) && (
                <p className="muted one-liner" style={{ marginTop: "1rem" }}>
                  Wallet and NFT features need a configured deployment (marketplace and receipt collection addresses). If you expected this to work, contact the site operator.
                </p>
              )}

              {marketplace && (
              <section>
                <div className="section-head">
                  <h2 className="section-head__title">
                    Your listings
                    <InfoTip label="About listings">
                      <p>Items you have listed for sale on this marketplace. Cancel sale returns the NFT to your wallet.</p>
                    </InfoTip>
                  </h2>
                  <span className="scan-status">{myListings.length} active</span>
                </div>
                <p className="muted one-liner">What you are currently selling here.</p>
                {myListings.length === 0 ? (
                  <p className="empty">
                    {listingBusyReceiptKey || listingsFetching ? (
                      <><span className="spinner" />{listingBusyReceiptKey ? "Finishing your listing — syncing with Base…" : "Loading listings…"}</>
                    ) : (
                      "Nothing listed yet."
                    )}
                  </p>
                ) : (
                  <div className="listings-grid">
                    {myListings.map((li) => {
                      const tokenIdStr = li.tokenId.toString();
                      const osListing = openSeaListingsByTokenId.get(tokenIdStr);
                      return (
                        <div key={li.listingId.toString()} style={{ display: "contents" }}>
                          <ListingCard
                            li={li}
                            bfrr={collection}
                            address={address}
                            txDisabled={txDisabled}
                            isConnected={isConnected}
                            wrongNetwork={wrongNetwork}
                            onBuy={() => {}}
                            onCancel={() => run(async () => {
                              if (!marketplace || !publicClient) return;
                              const hash = await writeContractAsync({
                                address: marketplace,
                                abi: feeRightsFixedSaleAbi,
                                functionName: "cancel",
                                args: [li.listingId],
                                chainId: MVP_CHAIN_ID,
                              });
                              await publicClient.waitForTransactionReceipt({ hash, chainId: MVP_CHAIN_ID });
                              await refetchListings();
                              setScanEpoch((e) => e + 1);
                            })}
                            openSeaListing={osListing}
                            openSeaUrl={openSeaAssetUrl(li.collection, tokenIdStr)}
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
              )}

              <details className="bfrr-primer bfrr-primer--profile">
                <summary>What is this NFT?</summary>
                <div className="bfrr-primer__body">
                  <p>
                    It is a marketplace receipt NFT on Base — proof you escrowed fee rights for a token pair. Use <strong>List</strong> on a token row to complete escrow and mint one, or <strong>List</strong> on an NFT you already hold to set a price.
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
          clankerEscrowAddress={CLANKER_ESCROW_ADDRESS}
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
