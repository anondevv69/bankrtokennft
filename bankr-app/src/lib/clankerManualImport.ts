import type { PublicClient } from "viem";
import { getAddress, isAddress, type Address } from "viem";
import {
  clankerLockerFromDetail,
  clankerPairedFromDetail,
  clankerPoolFromDetail,
  fetchClankerTokenDetail,
  rowClankerListingReady,
  rowClankerLockerVersion,
} from "./clankerDetail";
import { clankerLockerV4Abi } from "./clankerLockerV4Abi";
import { CLANKER_V4_DEFAULT_LOCKER } from "./clankerLockers";
import {
  clankerV4AdminIndicesFor,
  enrichClankerRowsWithV4Snapshots,
  type ClankerV4RewardsSnapshot,
} from "./clankerV4Rewards";
import { rowLaunchedToken, WETH_BASE } from "./escrowArgs";

const erc20MetaAbi = [
  {
    type: "function" as const,
    name: "symbol",
    stateMutability: "view" as const,
    inputs: [],
    outputs: [{ type: "string" as const }],
  },
  {
    type: "function" as const,
    name: "name",
    stateMutability: "view" as const,
    inputs: [],
    outputs: [{ type: "string" as const }],
  },
] as const;

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

const UNI_V3_FACTORY = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" as Address;
const FEE_TIERS = [10000, 3000, 500] as const;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

export type ImportedClankerResult =
  | { ok: true; row: Record<string, unknown> }
  | { ok: false; message: string };

/**
 * Resolve a Clanker launch row from a token contract alone (API + on-chain),
 * for when creator search / Clanker metadata lags or is wrong.
 *
 * v4: requires `wallet` to be **reward admin** on at least one index (recipient-only is not enough to list).
 */
export async function resolveImportedClankerRow(
  publicClient: PublicClient,
  wallet: Address,
  token: Address,
): Promise<ImportedClankerResult> {
  let row: Record<string, unknown> = {
    tokenAddress: token,
    __launchVenue: "Clanker",
    __importedClanker: true,
  };

  try {
    const meta = await publicClient.multicall({
      contracts: [
        { address: token, abi: erc20MetaAbi, functionName: "symbol" },
        { address: token, abi: erc20MetaAbi, functionName: "name" },
      ],
      allowFailure: true,
    });
    const sym = meta[0].status === "success" && typeof meta[0].result === "string" ? meta[0].result : null;
    const nm = meta[1].status === "success" && typeof meta[1].result === "string" ? meta[1].result : null;
    if (sym?.trim()) row = { ...row, symbol: sym.trim() };
    if (nm?.trim()) row = { ...row, name: nm.trim() };
  } catch {
    /* optional */
  }

  const detail = await fetchClankerTokenDetail(token);
  if (detail) {
    const locker = clankerLockerFromDetail(detail);
    const pool = clankerPoolFromDetail(detail);
    const paired = clankerPairedFromDetail(detail);
    if (pool) {
      row = {
        ...row,
        ...(locker ? { __clankerLocker: locker } : {}),
        __clankerPool: pool,
        ...(paired ? { __clankerPaired: paired } : {}),
      };
      const enriched = await enrichClankerRowsWithV4Snapshots(publicClient, [row]);
      return finalizeImportRow(publicClient, wallet, enriched[0] ?? row, false);
    }
  }

  row = { ...row, __clankerNeedsDetect: true };

  let v4Hit = false;
  try {
    const tr = await publicClient.readContract({
      address: CLANKER_V4_DEFAULT_LOCKER,
      abi: clankerLockerV4Abi,
      functionName: "tokenRewards",
      args: [token],
    });
    const posId = (tr as { positionId?: bigint }).positionId;
    if (posId !== undefined && posId > 0n) {
      v4Hit = true;
      const { __clankerNeedsDetect: _d, ...rest } = row;
      row = { ...rest, __clankerLocker: CLANKER_V4_DEFAULT_LOCKER };
    }
  } catch {
    /* not v4 on default locker */
  }

  if (!v4Hit) {
    const poolCalls = await publicClient.multicall({
      contracts: FEE_TIERS.map((fee) => ({
        address: UNI_V3_FACTORY,
        abi: uniV3FactoryAbi,
        functionName: "getPool" as const,
        args: [token, WETH_BASE, fee] as const,
      })),
      allowFailure: true,
    });
    let pool: Address | null = null;
    for (const r of poolCalls) {
      if (r.status === "success" && r.result && (r.result as string).toLowerCase() !== ZERO.toLowerCase()) {
        pool = getAddress(r.result as string);
        break;
      }
    }
    const { __clankerNeedsDetect: _d, ...rest } = row;
    row = pool ? { ...rest, __clankerPool: pool } : { ...rest, __clankerDetailFailed: true };
  } else {
    const { __clankerNeedsDetect: _d, ...rest } = row;
    row = rest;
  }

  const enriched = await enrichClankerRowsWithV4Snapshots(publicClient, [row]);
  return finalizeImportRow(publicClient, wallet, enriched[0] ?? row, true);
}

async function finalizeImportRow(
  publicClient: PublicClient,
  wallet: Address,
  row: Record<string, unknown>,
  triedDetect: boolean,
): Promise<ImportedClankerResult> {
  if (!rowClankerListingReady(row)) {
    const msg = triedDetect
      ? "Could not find a Clanker v4 position on the default locker or a Uniswap V3 WETH pool for this token. Paste pool + locker under a search row instead, or set CLANKER_API_KEY for automatic metadata."
      : "Missing pool / locker — could not list this import.";
    return { ok: false, message: msg };
  }

  if (rowClankerLockerVersion(row) === "v4") {
    const snap = row.__clankerV4Rewards as ClankerV4RewardsSnapshot | undefined;
    if (!snap) {
      const again = await enrichClankerRowsWithV4Snapshots(publicClient, [row]);
      row = again[0] ?? row;
    }
    const snap2 = row.__clankerV4Rewards as ClankerV4RewardsSnapshot | undefined;
    if (!snap2) {
      return {
        ok: false,
        message:
          "Could not read Clanker v4 reward splits on-chain for this token. Check the locker address or try again.",
      };
    }
    const admins = clankerV4AdminIndicesFor(snap2, wallet);
    if (admins.length === 0) {
      return {
        ok: false,
        message:
          "On-chain v4 rewards show you are not reward admin on any index for this token. Fee recipient alone cannot run escrow here — on Clanker, transfer reward admin for each split you sell (WETH and token legs are often separate indices).",
      };
    }
  }

  return { ok: true, row };
}

/** @internal tests / dedupe */
export function importedRowTokenKey(row: Record<string, unknown>): string | null {
  const t = rowLaunchedToken(row);
  return t ? t.toLowerCase() : null;
}
