import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  type Hex,
} from "viem";
import { feeRightsFixedSaleAbi } from "./lib/feeRightsFixedSaleAbi";
import { bankrFeeRightsReceiptAbi } from "./lib/bankrFeeRightsReceiptAbi";
import { MVP_CHAIN_ID } from "./chain";
import { walletConnectConfigured } from "./wagmi";
import { EscrowWizard } from "./EscrowWizard";
import { normalizePoolId, rowPoolIdHex, launchRowLabel, launchedTokenFromWethPair } from "./lib/escrowArgs";

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

/** Shorten huge ERC-721 `tokenId` integers for UI (full value stays in `title`). */
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

/** Client-side preview when `tokenURI` has no image — not on-chain metadata. */
function listingCardPlaceholderSvg(line1: string, line2: string): string {
  const a = svgTextSafe(line1, 44) || "Fee rights receipt";
  const b = svgTextSafe(line2, 56);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="260" viewBox="0 0 400 260"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#0a0a0a"/><stop offset="100%" stop-color="#15101f"/></linearGradient></defs><rect width="400" height="260" fill="url(#g)"/><text x="200" y="62" text-anchor="middle" fill="#f97316" font-family="ui-monospace,monospace" font-size="11" font-weight="600" letter-spacing="0.12em">BFRR</text><text x="200" y="128" text-anchor="middle" fill="#fafafa" font-family="system-ui,sans-serif" font-size="15" font-weight="650">${a}</text>${b ? `<text x="200" y="166" text-anchor="middle" fill="#a3a3a3" font-family="ui-monospace,monospace" font-size="12">${b}</text>` : ""}</svg>`;
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

/** On-chain fields used for home search (BFRR listings); non-BFRR rows use listing fields only. */
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
  const imgSrc = meta.image ?? null;

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

  const symbol0 = typeof sym0 === "string" && sym0.trim() ? sym0.trim() : null;
  const symbol1 = typeof sym1 === "string" && sym1.trim() ? sym1.trim() : null;

  const title =
    (position && typeof position.factoryName === "string" && position.factoryName.trim())
      ? position.factoryName.trim()
      : (meta.name?.trim() || "Fee rights receipt");

  const pairLabel =
    position && typeof position.token0 === "string" && typeof position.token1 === "string"
      ? `${shortAddr(getAddress(position.token0))} / ${shortAddr(getAddress(position.token1))}`
      : null;

  const tickerLine =
    symbol0 && symbol1
      ? `${symbol0} / ${symbol1}`
      : (meta.pairTrait?.trim() || pairLabel);

  const basescanNft = `https://basescan.org/nft/${collection}/${id}`;

  const [imgBroken, setImgBroken] = useState(false);
  useEffect(() => {
    setImgBroken(false);
  }, [imgSrc]);

  const body = (
    <>
      {imgSrc && !imgBroken ? (
        <img className="bfrr-card__img" src={imgSrc}
          alt={title} loading="lazy" decoding="async"
          onError={() => setImgBroken(true)} />
      ) : (
        <div className="bfrr-card__img-placeholder">
          <span className="bfrr-card__badge">BFRR</span>
          {meta.remoteLoading && !imgSrc ? (
            <span className="bfrr-card__serial"><span className="spinner" /> Metadata…</span>
          ) : (
            serial !== undefined && <span className="bfrr-card__serial">#{String(serial)}</span>
          )}
        </div>
      )}
      <div className="bfrr-card__footer">
        <div className="bfrr-card__title" title={title}>{title}</div>
        {tickerLine && (
          <div className={`bfrr-card__tickers${symbol0 && symbol1 ? "" : " mono"}`} title={tickerLine}>
            {tickerLine}
          </div>
        )}
        {meta.description && (
          <div className="bfrr-card__desc" title={meta.description}>{meta.description}</div>
        )}
        <div className="bfrr-card__id-row">
          <span className="bfrr-card__id mono" title={`Token ID ${id}`}>
            {serial !== undefined ? `#${String(serial)}` : id.slice(0, 6) + "…" + id.slice(-4)}
          </span>
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

  const pairLabel =
    position && typeof position.token0 === "string" && typeof position.token1 === "string"
      ? `${shortAddr(getAddress(position.token0))} / ${shortAddr(getAddress(position.token1))}`
      : null;

  const bankrPairLine =
    bankrFeesMeta?.token0Label && bankrFeesMeta?.token1Label
      ? `${String(bankrFeesMeta.token0Label).trim()} / ${String(bankrFeesMeta.token1Label).trim()}`
      : null;

  const tickerLine =
    symbol0 && symbol1
      ? `${symbol0} / ${symbol1}`
      : (bankrPairLine || meta.pairTrait?.trim() || pairLabel);

  const pairSymbols = symbol0 && symbol1 ? `${symbol0} / ${symbol1}` : null;
  const headlineText =
    pairSymbols ||
    (receiptTitle?.trim() || null) ||
    meta.name?.trim() ||
    bankrFeesMeta?.symbol?.trim() ||
    (receiptReadsEnabled ? "Fee rights receipt" : "Listing");
  const sublineText =
    pairSymbols && receiptTitle?.trim() && receiptTitle.trim() !== pairSymbols
      ? receiptTitle.trim()
      : (pairSymbols && meta.name?.trim() && meta.name.trim() !== pairSymbols ? meta.name.trim() : null);

  const imSeller = address !== undefined && isAddress(li.seller) &&
    getAddress(li.seller) === getAddress(address);

  const sellerAddr = isAddress(li.seller) ? getAddress(li.seller) : li.seller;
  const sellerScan = isAddress(li.seller) ? `https://basescan.org/address/${getAddress(li.seller)}` : undefined;
  const nftScan = receiptReadsEnabled && listCol
    ? `https://basescan.org/nft/${listCol}/${li.tokenId.toString()}`
    : undefined;

  const [imgBroken, setImgBroken] = useState(false);
  const [bankrImgBroken, setBankrImgBroken] = useState(false);
  useEffect(() => {
    setImgBroken(false);
    setBankrImgBroken(false);
  }, [li.collection, li.tokenId, rawUri, chainImg, bankrImg]);

  const receiptIdLabel =
    serial !== undefined ? `#${String(serial)}` : `#${shortTokenIdDisplay(li.tokenId)}`;

  const rasterChain = chainImg && !imgBroken ? chainImg : null;
  const rasterBankr = bankrImg && !bankrImgBroken ? bankrImg : null;
  const rasterSrc = rasterChain ?? rasterBankr;

  const synthDataUri = useMemo(() => {
    const hasRaster = Boolean(rasterSrc);
    if (hasRaster) return null;
    const l1 = pairSymbols || tickerLine || headlineText;
    const l2 =
      t0addr && t1addr
        ? `${shortAddr(t0addr)} / ${shortAddr(t1addr)}`
        : receiptIdLabel;
    if (!receiptReadsEnabled && !l1) return null;
    return listingCardPlaceholderSvg(String(l1), String(l2));
  }, [
    rasterSrc,
    pairSymbols,
    tickerLine,
    headlineText,
    t0addr,
    t1addr,
    receiptIdLabel,
    receiptReadsEnabled,
  ]);

  return (
    <div className="listing-card">
      {rasterSrc ? (
        <img
          className="listing-card__img"
          src={rasterSrc}
          alt={receiptTitle || meta.name || bankrFeesMeta?.name || "Listing"}
          loading="lazy"
          decoding="async"
          onError={() => {
            if (chainImg && !imgBroken) setImgBroken(true);
            else setBankrImgBroken(true);
          }}
        />
      ) : synthDataUri ? (
        <img
          className="listing-card__img"
          src={synthDataUri}
          alt={headlineText}
          loading="lazy"
          decoding="async"
        />
      ) : (
        <div className="listing-card__img-placeholder">
          <span className="bfrr-card__badge">BFRR</span>
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
        <div className="listing-card__headline" title={[headlineText, t0addr && t1addr ? `${t0addr} · ${t1addr}` : ""].filter(Boolean).join(" · ")}>
          {headlineText}
        </div>
        {sublineText && (
          <div className="listing-card__nft-name" title={sublineText}>{sublineText}</div>
        )}
        {receiptReadsEnabled && tickerLine && tickerLine !== headlineText && (
          <div
            className={`listing-card__tickers${symbol0 && symbol1 ? "" : " mono"}`}
            title={t0addr && t1addr ? `${t0addr} ↔ ${t1addr}` : tickerLine}
          >
            {tickerLine}
          </div>
        )}
        <div className="listing-card__price">{formatEther(li.priceWei)} ETH</div>
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
          {receiptReadsEnabled && t0addr && t1addr && (
            <div className="listing-card__meta-row listing-card__meta-row--stack">
              <span>Pool tokens</span>
              <div className="listing-card__pool-tokens">
                <a
                  className="mono listing-card__meta-link"
                  href={`https://basescan.org/address/${t0addr}`}
                  target="_blank"
                  rel="noreferrer"
                  title={t0addr}
                >
                  {symbol0 ? `${symbol0} · ` : ""}{shortAddr(t0addr)}
                </a>
                <a
                  className="mono listing-card__meta-link"
                  href={`https://basescan.org/address/${t1addr}`}
                  target="_blank"
                  rel="noreferrer"
                  title={t1addr}
                >
                  {symbol1 ? `${symbol1} · ` : ""}{shortAddr(t1addr)}
                </a>
              </div>
            </div>
          )}
          {receiptReadsEnabled && (name0 || name1) && (
            <div className="listing-card__meta-row listing-card__meta-row--stack">
              <span>Token names</span>
              <div className="listing-card__pool-tokens">
                <span className="listing-card__name-line" title={[name0, name1].filter(Boolean).join(" · ")}>
                  {name0}
                  {name0 && name1 && " · "}
                  {name1}
                </span>
              </div>
            </div>
          )}
          <div className="listing-card__meta-row">
            <span>Receipt</span>
            <span className="listing-card__meta-ellipsis">
            {nftScan ? (
              <a
                className="mono listing-card__meta-link"
                href={nftScan}
                target="_blank"
                rel="noreferrer"
                title={`Token ID ${li.tokenId.toString()}${meta.name ? ` · ${meta.name}` : ""}`}
              >
                {receiptIdLabel}
              </a>
            ) : (
              <span className="mono" title={li.tokenId.toString()}>
                {receiptIdLabel}
              </span>
            )}
            </span>
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
  wrongNetwork, isConnected, onDone, onListFlowStart, onListFlowEnd }: {
  tokenIdStr: string; collection: Address; marketplace: Address;
  address: Address | undefined; txDisabled: boolean;
  wrongNetwork: boolean; isConnected: boolean;
  onDone: () => void | Promise<void>;
  onListFlowStart?: () => void;
  onListFlowEnd?: () => void;
}) {
  const [price, setPrice] = useState("0.01");
  const [listStep, setListStep] = useState<null | "approve" | "list">(null);
  const listLock = useRef(false);
  const { writeContractAsync, isPending } = useWriteContract();
  const publicClient = usePublicClient();

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

  const onList = () => run(async () => {
    if (!priceOk || tokenId === null || txDisabled || !publicClient) return;
    if (listLock.current) return;
    listLock.current = true;
    onListFlowStart?.();
    try {
      if (!canPull) {
        setListStep("approve");
        const approveHash = await writeContractAsync({
          address: collection, abi: erc721Abi, functionName: "approve",
          args: [marketplace, tokenId], chainId: MVP_CHAIN_ID,
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash, chainId: MVP_CHAIN_ID });
        setListStep("list");
      } else {
        setListStep("list");
      }
      const listHash = await writeContractAsync({
        address: marketplace, abi: feeRightsFixedSaleAbi, functionName: "list",
        args: [collection, tokenId, parseEther(priceNorm)], chainId: MVP_CHAIN_ID,
      });
      await publicClient.waitForTransactionReceipt({ hash: listHash, chainId: MVP_CHAIN_ID });
      await Promise.resolve(onDone());
    } catch {
      /* wallet / rpc errors */
    } finally {
      listLock.current = false;
      setListStep(null);
      onListFlowEnd?.();
    }
  });

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
        <button type="button" className="btn btn-primary btn-full"
          disabled={txDisabled || !priceOk || tokenId === null || listStep !== null || isPending}
          onClick={onList}>
          {listLabel}
        </button>
        {!canPull && !listBusy && (
          <p className="muted sell-actions__hint">
            First listing: your wallet may prompt twice; this button runs approve then list in order.
          </p>
        )}
      </div>

      <div className="redeem-row">
        <div className="redeem-label redeem-label--row">
          <span>Return to my wallet</span>
          <InfoTip label="What “Return to my wallet” does">
            <p>
              Sends the receipt NFT from escrow back to your wallet. You keep the token; it is no longer held for
              this marketplace flow. Use this if you do not want an active listing.
            </p>
          </InfoTip>
        </div>
        <div className="redeem-row__btn-wrap">
          <button type="button" className="btn btn-ghost btn-sm"
            disabled={txDisabled || !isBfrrOwner || tokenId === null || listBusy}
            title={!isBfrrOwner ? "Use the wallet that holds this item" : undefined}
            onClick={() => run(async () => {
              setRedeemPhase(true);
              try {
                await writeContractAsync({
                  address: ESCROW_ADDRESS, abi: escrowAbi, functionName: "redeemRights",
                  args: [tokenId!], chainId: MVP_CHAIN_ID,
                });
              } finally {
                setRedeemPhase(false);
              }
            })}>
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
  const [receiptManualFeeManager, setReceiptManualFeeManager] = useState("");
  const [receiptManualErr, setReceiptManualErr] = useState<string | null>(null);
  const [scanEpoch, setScanEpoch] = useState(0);
  const [mainTab, setMainTab] = useState<"home" | "profile">("home");
  const [homeListingSearch, setHomeListingSearch] = useState("");
  const walletScanKeyRef = useRef("");
  /** Profile row: which BFRR tokenId is currently executing `redeemRights` (for button + row hint). */
  const [redeemingForId, setRedeemingForId] = useState<string | null>(null);
  /** Profile: approve+list in flight for this receipt (row stays visible until tx confirms + listings refetch). */
  const [listingBusyTokenId, setListingBusyTokenId] = useState<string | null>(null);

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

  const idsForWatch = useMemo(
    () => allTokenIds.filter((id) => id.length > 0 && /^\d+$/.test(id)),
    [allTokenIds],
  );

  // Auto-scan when wallet connects (on-chain only — same wallet that holds the BFRR)
  useEffect(() => {
    if (!isConnected || !address || !collection || !publicClient || wrongNetwork) return;
    const key = `${getAddress(address)}|${getAddress(collection)}`;
    const identityChanged = walletScanKeyRef.current !== key;
    if (identityChanged) {
      walletScanKeyRef.current = key;
      setManualIds([]);
      setSelectedId(null);
      setScannedIds([]);
    }

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

  const myListedTokenIds = useMemo(() => {
    const set = new Set<string>();
    if (!collection) return set;
    const col = getAddress(collection);
    for (const li of myListings) {
      if (getAddress(li.collection) === col) set.add(li.tokenId.toString());
    }
    return set;
  }, [myListings, collection]);

  const ownershipQueries = useQueries({
    queries: (() => {
      if (!publicClient || !collection || !address) return [];
      const me = getAddress(address);
      return idsForWatch.map((id) => ({
        queryKey: ["bfrr-owner", collection, me, id],
        queryFn: async () => {
          if (!publicClient || !collection) return null;
          try {
            return await publicClient.readContract({
              address: collection,
              abi: erc721Abi,
              functionName: "ownerOf",
              args: [BigInt(id)],
            }) as Address;
          } catch {
            return null;
          }
        },
        staleTime: 12_000,
      }));
    })(),
  });

  const ownershipReady =
    idsForWatch.length === 0 ||
    ownershipQueries.length === 0 ||
    ownershipQueries.every((q) => q.status === "success" || q.status === "error");

  const walletOwnedReceiptIds = useMemo(() => {
    if (!address || !ownershipReady) return [];
    const me = getAddress(address);
    const out: string[] = [];
    for (let i = 0; i < idsForWatch.length; i++) {
      const q = ownershipQueries[i];
      if (q.status !== "success" || !q.data) continue;
      const o = q.data as string;
      if (!isAddress(o)) continue;
      try {
        if (getAddress(o) === me) out.push(idsForWatch[i]);
      } catch {
        /* skip */
      }
    }
    return out.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  }, [address, idsForWatch, ownershipQueries, ownershipReady]);

  useEffect(() => {
    if (!ownershipReady || !address) return;
    const me = getAddress(address);
    const keepId = (id: string) => {
      const i = idsForWatch.indexOf(id);
      if (i < 0) return true;
      const q = ownershipQueries[i];
      if (q?.status !== "success" || !q.data) return false;
      try {
        return isAddress(q.data as string) && getAddress(q.data as Address) === me;
      } catch {
        return false;
      }
    };
    setScannedIds((prev) => prev.filter(keepId));
    setManualIds((prev) => prev.filter(keepId));
  }, [ownershipReady, address, idsForWatch, ownershipQueries]);

  const unlistedBfrrIds = useMemo(
    () => walletOwnedReceiptIds.filter((id) => !myListedTokenIds.has(id)),
    [walletOwnedReceiptIds, myListedTokenIds],
  );

  const positionQueries = useQueries({
    queries: (() => {
      if (!publicClient || !collection || wrongNetwork || !ownershipReady) return [];
      return walletOwnedReceiptIds.map((id) => ({
        queryKey: ["bfrr-position-bankr-dedupe", collection, id],
        queryFn: async () => {
          if (!publicClient || !collection) return null;
          try {
            return await publicClient.readContract({
              address: collection,
              abi: bankrFeeRightsReceiptAbi,
              functionName: "positionOf",
              args: [BigInt(id)],
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
      : walletOwnedReceiptIds.length === 0 ||
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
    if (!ownershipReady || !selectedId) return;
    if (!walletOwnedReceiptIds.includes(selectedId)) setSelectedId(null);
  }, [ownershipReady, selectedId, walletOwnedReceiptIds]);

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

  const refreshProfile = useCallback(() => {
    void loadBankrLaunches();
    void refetchListings();
    void qc.invalidateQueries();
    setScanEpoch((e) => e + 1);
  }, [loadBankrLaunches, refetchListings, qc]);

  const refreshBusy = bankrLoading || scanning;

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
              {filteredHomeListings.map((li) => (
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
          <div className="hero hero--compact profile-hero">
            <div className="profile-hero__main">
              <h1>My profile</h1>
              <p className="muted">Your wallet and items on Base.</p>
            </div>
            {isConnected && address && !wrongNetwork && collection && marketplace && (
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

          {isConnected && address && !wrongNetwork && (
            <>
              {collection && marketplace && (
                <p className="muted profile-flow-lead">
                  <strong>1</strong> Eligible token → <strong>2</strong> receipt in your wallet → <strong>3</strong> listed here.
                  <InfoTip label="What each step means">
                    <p>
                      <strong>1</strong> Pick a token row and use <strong>List</strong> to run escrow (several Base confirmations may be needed) until a receipt NFT exists.
                    </p>
                    <p>
                      <strong>2</strong> Open <strong>List</strong> on a receipt to set price; your wallet may approve the marketplace, then confirm the listing.
                    </p>
                    <p>
                      <strong>3</strong> Active offers appear under <strong>Your listings</strong>. <strong>Return to my wallet</strong> moves the receipt out of escrow without listing it for sale.
                    </p>
                  </InfoTip>
                </p>
              )}

              {collection && marketplace && (
                <section className="bankr-panel">
                  <div className="section-head">
                    <h2 className="section-head__title">
                      Tokens that could be listed
                      <InfoTip label="About this list">
                        <p>
                          Rows come from your connected wallet’s fee data. <strong>List</strong> starts the on-chain flow
                          so a receipt can show up under “Receipt in your wallet.”
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
                  <p className="muted one-liner">Tokens we found for your wallet. Use <strong>List</strong> to continue.</p>
                  {idsForWatch.length > 0 && !bfrrDedupeReady && (
                    <p className="muted one-liner" style={{ marginTop: "0.4rem" }}>
                      Matching rows to receipts you already hold…
                    </p>
                  )}
                  {bankrRowsNotYetReceived.length > 0 ? (
                    <ul className="bankr-panel__list">
                      {bankrRowsNotYetReceived.map((row, i) => {
                        const ta = row.tokenAddress;
                        const pid = row.poolId;
                        const poolHex = rowPoolIdHex(row);
                        const key =
                          typeof ta === "string" && ta.startsWith("0x")
                            ? ta.toLowerCase()
                            : typeof pid === "string"
                              ? `${pid}-${i}`
                              : `row-${i}`;
                        return (
                          <li key={key}>
                            <div className="bankr-panel__row">
                              <div className="bankr-panel__col">
                                <span className="bankr-panel__name">{launchRowLabel(row)}</span>
                                {poolHex && (
                                  <div className="bankr-panel__sub mono" title={poolHex}>
                                    Pool {poolHex.slice(0, 10)}…{poolHex.slice(-8)}
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
                                disabled={wrongNetwork}
                                onClick={() => setEscrowWizardRow(row)}
                              >
                                List
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
                        ) : bankrRows.length === 0 ? (
                          <p className="muted one-liner">
                            Nothing loaded — try <strong>Refresh</strong>, or open <strong>advanced</strong> below.
                          </p>
                        ) : !bfrrDedupeReady ? null : (
                          <p className="muted one-liner">
                            Everything here already has a matching receipt below. <strong>Refresh</strong> if that seems wrong.
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
                                    <strong>Launched token</strong> — The ERC-20 traders swap (the coin contract), not the receipt NFT contract and not the marketplace.
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

              {collection && marketplace && (
                <section>
                  <div className="section-head">
                    <h2 className="section-head__title">
                      Receipt in your wallet
                      <InfoTip label="About receipts">
                        <p>
                          BFRR is the fee-rights receipt NFT. This list is receipts you hold that are not listed on this
                          site yet. <strong>List</strong> sets price (approve + list when needed). <strong>Return to my wallet</strong> moves the token from escrow back to your wallet without a sale listing.
                        </p>
                      </InfoTip>
                    </h2>
                    <span className="scan-status">
                      {scanning ? <><span className="spinner" />Scanning…</> : `${unlistedBfrrIds.length} not listed`}
                    </span>
                  </div>
                  <p className="muted one-liner">Receipts in your wallet that are not listed here yet.</p>

                  {scanErr && <p className="err" style={{ marginBottom: "0.75rem" }}>{scanErr}</p>}

                  {!scanning && unlistedBfrrIds.length === 0 && ownershipReady && walletOwnedReceiptIds.length === 0 && idsForWatch.length === 0 && (
                    <p className="empty">No receipt found in our scan.</p>
                  )}

                  <details className="profile-advanced profile-advanced--receipt">
                    <summary>Receipt not showing? Paste token ID (advanced)</summary>
                    <div className="profile-advanced__body">
                      <p className="muted one-liner" style={{ marginBottom: "0.5rem" }}>
                        If our scan missed an NFT you already minted, add its numeric ID from{" "}
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
                        .
                        <InfoTip label="Finding the token ID on BaseScan">
                          <p>
                            Open the receipt contract on BaseScan, use the <strong>ERC-721</strong> tab or your wallet’s
                            token view, and copy the <strong>Token ID</strong> (digits only).
                          </p>
                        </InfoTip>
                      </p>
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
                    </div>
                  </details>

                  <div className="profile-receipt-list">
                    {unlistedBfrrIds.map((id) => (
                      <div
                        key={id}
                        className={`profile-receipt-row${selectedId === id ? " profile-receipt-row--open" : ""}${redeemingForId === id || listingBusyTokenId === id ? " profile-receipt-row--pending" : ""}`}
                      >
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
                            disabled={txDisabled || Boolean(listingBusyTokenId)}
                            onClick={() => setSelectedId(id)}
                          >
                            List
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            disabled={txDisabled || Boolean(listingBusyTokenId)}
                            onClick={() => run(async () => {
                              setRedeemingForId(id);
                              try {
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
                              } finally {
                                setRedeemingForId(null);
                              }
                            })}
                          >
                            {redeemingForId === id ? (
                              <><span className="spinner" /> Returning…</>
                            ) : (
                              "Return to my wallet"
                            )}
                          </button>
                        </div>
                        {redeemingForId === id && (
                          <p className="profile-receipt-row__status muted">
                            Confirm in your wallet, then wait for Base to include the transaction.
                          </p>
                        )}
                        {listingBusyTokenId === id && redeemingForId !== id && (
                          <p className="profile-receipt-row__status muted">
                            <span className="spinner" /> Listing on Base… Your listings update when the transaction is confirmed.
                          </p>
                        )}
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
                              onListFlowStart={() => setListingBusyTokenId(id)}
                              onListFlowEnd={() => setListingBusyTokenId(null)}
                              onDone={async () => {
                                setSelectedId(null);
                                await qc.invalidateQueries();
                                await refetchListings();
                                setScanEpoch((e) => e + 1);
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

              {marketplace && (
              <section>
                <div className="section-head">
                  <h2 className="section-head__title">
                    Your listings
                    <InfoTip label="About listings">
                      <p>Items you have listed for sale on this marketplace. Cancel sale returns the receipt to your wallet.</p>
                    </InfoTip>
                  </h2>
                  <span className="scan-status">{myListings.length} active</span>
                </div>
                <p className="muted one-liner">What you are currently selling here.</p>
                {myListings.length === 0 ? (
                  <p className="empty">
                    {listingBusyTokenId || listingsFetching ? (
                      <><span className="spinner" />{listingBusyTokenId ? "Finishing your listing — syncing with Base…" : "Loading listings…"}</>
                    ) : (
                      "Nothing listed yet."
                    )}
                  </p>
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
                      />
                    ))}
                  </div>
                )}
              </section>
              )}

              <details className="bfrr-primer bfrr-primer--profile">
                <summary>What is a receipt?</summary>
                <div className="bfrr-primer__body">
                  <p>
                    A receipt is the BFRR fee-rights NFT on Base. Use <strong>List</strong> on a token row to complete escrow and mint one, or <strong>List</strong> on a receipt you already hold to set a price.
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
