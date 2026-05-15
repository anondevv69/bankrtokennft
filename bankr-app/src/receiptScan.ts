import type { Address, PublicClient } from "viem";
import { getAddress, parseAbiItem } from "viem";

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
);

/** Hosts with strict `eth_getLogs` rate limits — use a dedicated `VITE_RPC_URL` in production. */
const PUBLIC_RPC_HOSTS = ["mainnet.base.org", "base.llamarpc.com", "base.publicnode.com"];

const DEFAULT_SCAN_BLOCKS = 80_000n;
const PUBLIC_SCAN_BLOCKS_CAP = 18_000n;
const DEFAULT_LOG_CHUNK = 10_000n;
const PUBLIC_LOG_CHUNK = 4_000n;
const CHUNK_DELAY_MS = 180;
const MAX_RETRIES = 4;

export function rpcUrlFromEnv(): string {
  const raw = import.meta.env.VITE_RPC_URL;
  return typeof raw === "string" && raw.trim() ? raw.trim() : "https://mainnet.base.org";
}

export function isPublicRpcUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return PUBLIC_RPC_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return PUBLIC_RPC_HOSTS.some((h) => url.includes(h));
  }
}

/** Reject example / placeholder addresses from env (e.g. `0x1111…1111`). */
export function isPlaceholderCollectionAddress(a: Address): boolean {
  const body = getAddress(a).toLowerCase().slice(2);
  if (body === "0".repeat(40)) return true;
  return /^(.)\1{39}$/.test(body);
}

export function scanBlockSpanFromEnv(): bigint {
  const raw = import.meta.env.VITE_RECEIPT_SCAN_BLOCKS;
  const n = typeof raw === "string" ? parseInt(raw, 10) : NaN;
  const configured = Number.isFinite(n) && n > 0 ? BigInt(Math.min(n, 500_000)) : DEFAULT_SCAN_BLOCKS;
  const rpc = rpcUrlFromEnv();
  if (!isPublicRpcUrl(rpc)) return configured;
  return configured > PUBLIC_SCAN_BLOCKS_CAP ? PUBLIC_SCAN_BLOCKS_CAP : configured;
}

function logChunkSpan(rpc: string, maxBlocks?: bigint): bigint {
  if (maxBlocks !== undefined && maxBlocks <= 10n) return maxBlocks;
  return isPublicRpcUrl(rpc) ? PUBLIC_LOG_CHUNK : DEFAULT_LOG_CHUNK;
}

/** Alchemy free tier allows only 10-block `eth_getLogs` ranges. */
function isGetLogsBlockRangeError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /10 block range|block range should work/i.test(msg);
}

/** API key from `https://base-mainnet.g.alchemy.com/v2/{key}` (or `/nft/v3/{key}/…`). */
export function alchemyApiKeyFromRpcUrl(rpcUrl: string): string | null {
  try {
    const u = new URL(rpcUrl);
    if (!u.hostname.toLowerCase().includes("alchemy.com")) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    const v2 = parts.indexOf("v2");
    if (v2 >= 0 && parts[v2 + 1]) return parts[v2 + 1]!;
    const v3 = parts.indexOf("v3");
    if (v3 >= 0 && parts[v3 + 1]) return parts[v3 + 1]!;
  } catch {
    /* ignore */
  }
  return null;
}

function normalizeAlchemyTokenId(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  try {
    if (typeof raw === "string") {
      const t = raw.trim();
      if (!t) return null;
      return t.startsWith("0x") ? BigInt(t).toString() : t;
    }
    if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
    if (typeof raw === "bigint") return raw.toString();
  } catch {
    return null;
  }
  return null;
}

/** Uses Alchemy `getNFTsForOwner` — no `eth_getLogs` block-range limits (works on free tier). */
export async function scanReceiptsViaAlchemyNftApi(
  owner: Address,
  collections: Address[],
  rpcUrl = rpcUrlFromEnv(),
): Promise<string[]> {
  const apiKey = alchemyApiKeyFromRpcUrl(rpcUrl);
  if (!apiKey) throw new Error("Not an Alchemy RPC URL");

  const me = getAddress(owner);
  const idSet = new Set<string>();
  const base = `https://base-mainnet.g.alchemy.com/nft/v3/${apiKey}`;

  for (const col of collections) {
    const contract = getAddress(col);
    let pageKey: string | undefined;
    do {
      const params = new URLSearchParams({
        owner: me,
        withMetadata: "false",
      });
      params.append("contractAddresses[]", contract);
      if (pageKey) params.set("pageKey", pageKey);

      const res = await fetch(`${base}/getNFTsForOwner?${params}`);
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Alchemy NFT API ${res.status}: ${body.slice(0, 240)}`);
      }
      const json = (await res.json()) as {
        ownedNfts?: {
          tokenId?: unknown;
          contractAddress?: string;
          id?: { tokenId?: unknown };
        }[];
        pageKey?: string;
      };
      for (const nft of json.ownedNfts ?? []) {
        const tid = normalizeAlchemyTokenId(
          nft.tokenId ?? nft.id?.tokenId,
        );
        if (tid) idSet.add(tid);
      }
      pageKey = typeof json.pageKey === "string" && json.pageKey ? json.pageKey : undefined;
    } while (pageKey);
  }

  return [...idSet].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
}

function isRateLimitError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /rate limit|429|too many requests|over rate limit/i.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function getLogsWithRetry(
  client: PublicClient,
  params: Parameters<PublicClient["getLogs"]>[0],
): Promise<Awaited<ReturnType<PublicClient["getLogs"]>>> {
  let last: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await client.getLogs(params);
    } catch (e) {
      last = e;
      if (!isRateLimitError(e) || attempt === MAX_RETRIES - 1) throw e;
      await sleep(400 * 2 ** attempt);
    }
  }
  throw last;
}

export async function getTransferLogsChunked(
  client: PublicClient,
  { collection, recipient, fromBlock, toBlock, maxBlockSpan }: {
    collection: Address;
    recipient: Address;
    fromBlock: bigint;
    toBlock: bigint;
    maxBlockSpan?: bigint;
  },
) {
  const rpc = rpcUrlFromEnv();
  let chunkSpan = logChunkSpan(rpc, maxBlockSpan);
  const out: Awaited<ReturnType<PublicClient["getLogs"]>> = [];
  let start = fromBlock;
  while (start <= toBlock) {
    const end = start + chunkSpan - 1n <= toBlock ? start + chunkSpan - 1n : toBlock;
    try {
      const chunk = await getLogsWithRetry(client, {
        address: collection,
        event: transferEvent,
        args: { to: recipient },
        fromBlock: start,
        toBlock: end,
      });
      out.push(...chunk);
    } catch (e) {
      if (isGetLogsBlockRangeError(e) && chunkSpan > 10n) {
        chunkSpan = 10n;
        continue;
      }
      throw e;
    }
    start = end + 1n;
    if (start <= toBlock) await sleep(CHUNK_DELAY_MS);
  }
  return out;
}

/** Discover BFRR token IDs held by `owner` (Alchemy NFT API when possible, else Transfer logs). */
export async function scanWalletReceiptTokenIds(
  client: PublicClient,
  owner: Address,
  collections: Address[],
): Promise<string[]> {
  const rpc = rpcUrlFromEnv();
  const alchemyKey = alchemyApiKeyFromRpcUrl(rpc);

  // Alchemy free tier blocks large `eth_getLogs` ranges — use NFT API only (no silent fallback).
  if (alchemyKey && collections.length > 0) {
    return scanReceiptsViaAlchemyNftApi(owner, collections, rpc);
  }

  const latest = await client.getBlockNumber();
  const span = scanBlockSpanFromEnv();
  const from = latest > span ? latest - span : 0n;
  const recipient = getAddress(owner);
  const idSet = new Set<string>();

  for (const col of collections) {
    const logs = await getTransferLogsChunked(client, {
      collection: col,
      recipient,
      fromBlock: from,
      toBlock: latest,
      maxBlockSpan: undefined,
    });
    for (const l of logs) {
      const t = l.args.tokenId;
      if (typeof t === "bigint") idSet.add(t.toString());
    }
  }

  return [...idSet].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
}

export function formatReceiptScanError(e: unknown): string {
  const rpc = rpcUrlFromEnv();
  const publicRpc = isPublicRpcUrl(rpc);
  if (isGetLogsBlockRangeError(e)) {
    return "This RPC limits log scans (Alchemy free tier: use VITE_RPC_URL with an Alchemy key so we can use the NFT API). Paste your token ID below (advanced).";
  }
  if (isRateLimitError(e)) {
    return publicRpc
      ? "Base public RPC rate limit — too many NFT scans. Set VITE_RPC_URL to a dedicated Base endpoint (Alchemy, Infura, or Coinbase CDP) in your host env, redeploy, or paste your token ID below (advanced)."
      : "RPC rate limit while scanning NFTs. Wait a moment, retry, or paste your token ID below (advanced).";
  }
  const detail = e instanceof Error ? e.message : "Could not scan transfers.";
  if (publicRpc) {
    return `${detail} Tip: set VITE_RPC_URL to a dedicated Base RPC (not mainnet.base.org) and redeploy.`;
  }
  return `${detail} Try pasting your token ID below or lowering VITE_RECEIPT_SCAN_BLOCKS.`;
}
