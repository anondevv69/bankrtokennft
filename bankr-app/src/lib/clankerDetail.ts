import { getAddress, isAddress, type Address } from "viem";
import { rowLaunchedToken } from "./escrowArgs";
import { clankerDefaultLockerFromEnv } from "./deployAddresses";

/** Shape returned by Clanker authenticated “token by address” (nested under `data`). */
export type ClankerTokenDetail = {
  locker?: string;
  locker_address?: string;
  pool_address?: string;
  poolAddress?: string;
  contract_address?: string;
  pairedToken?: string;
  pool_config?: { pairedToken?: string };
};

export function extractClankerTokenRecord(upstream: unknown): ClankerTokenDetail | null {
  if (!upstream || typeof upstream !== "object") return null;
  const root = upstream as Record<string, unknown>;
  const inner = root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : root;
  if (!inner || typeof inner !== "object") return null;
  return inner as unknown as ClankerTokenDetail;
}

export function clankerLockerFromDetail(d: ClankerTokenDetail | null): Address | null {
  const raw = d?.locker_address ?? d?.locker;
  if (typeof raw !== "string" || !raw.startsWith("0x")) return null;
  try {
    return getAddress(raw.trim());
  } catch {
    return null;
  }
}

export function clankerPoolFromDetail(d: ClankerTokenDetail | null): Address | null {
  const raw = d?.pool_address ?? d?.poolAddress;
  if (typeof raw !== "string" || !raw.startsWith("0x")) return null;
  try {
    return getAddress(raw.trim());
  } catch {
    return null;
  }
}

export function clankerPairedFromDetail(d: ClankerTokenDetail | null): Address | null {
  const pc = d?.pool_config;
  const raw =
    (pc && typeof pc === "object" && typeof (pc as { pairedToken?: string }).pairedToken === "string"
      ? (pc as { pairedToken: string }).pairedToken
      : undefined) ?? d?.pairedToken;
  if (typeof raw !== "string" || !raw.startsWith("0x")) return null;
  try {
    return getAddress(raw.trim());
  } catch {
    return null;
  }
}

/**
 * Merge manual Clanker pool / locker (no API) onto a profile row.
 * Key by launched token address (lowercase).
 */
export type ClankerManualFields = { pool: Address; locker?: Address };

export function mergeClankerManual(
  row: Record<string, unknown>,
  manual: ClankerManualFields | undefined,
): Record<string, unknown> {
  if (!manual || row.__launchVenue !== "Clanker") return row;
  const next = { ...row, __clankerPool: manual.pool };
  if (manual.locker) next.__clankerLocker = manual.locker;
  return next;
}

/**
 * Whether **List** can open for a Clanker row.
 * Needs Uniswap V3 **pool contract** (`pool_address` from API or pasted manually).
 * Locker defaults from `VITE_CLANKER_DEFAULT_LOCKER` (Base v3.1 `LpLockerv2`) when unset on row.
 */
export function rowClankerListingReady(row: Record<string, unknown>): boolean {
  if (row.__launchVenue !== "Clanker") return false;
  const ta = rowLaunchedToken(row);
  if (!ta) return false;
  const pool = row.__clankerPool;
  const poolOk = typeof pool === "string" && isAddress(pool, { strict: false });
  if (!poolOk) return false;
  const locker = row.__clankerLocker;
  if (typeof locker === "string" && isAddress(locker, { strict: false })) return true;
  return Boolean(clankerDefaultLockerFromEnv());
}

export async function fetchClankerTokenDetail(tokenAddress: Address): Promise<ClankerTokenDetail | null> {
  const res = await fetch(`/api/clanker-get-token?address=${encodeURIComponent(tokenAddress)}`);
  const json = (await res.json()) as { ok?: boolean; data?: unknown };
  if (!json.ok || json.data === undefined) return null;
  return extractClankerTokenRecord(json.data);
}
