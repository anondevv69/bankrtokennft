import { getAddress, isAddress, type Address } from "viem";
import { rowLaunchedToken } from "./escrowArgs";
import { clankerDefaultLockerFromEnv, clankerV4DefaultLockerFromEnv } from "./deployAddresses";
import { clankerLockerVersion, isV4Locker, type ClankerLockerVersion } from "./clankerLockers";

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
 * `pool` is optional — v4 tokens don't have a Uniswap V3 pool contract.
 */
export type ClankerManualFields = { pool?: Address; locker?: Address };

export function mergeClankerManual(
  row: Record<string, unknown>,
  manual: ClankerManualFields | undefined,
): Record<string, unknown> {
  if (!manual || row.__launchVenue !== "Clanker") return row;
  const next = { ...row };
  if (manual.pool) next.__clankerPool = manual.pool;
  if (manual.locker) next.__clankerLocker = manual.locker;
  return next;
}

/**
 * Resolves the effective locker address for a Clanker row.
 * Returns the row's explicit locker if set, otherwise the env default for the detected version.
 */
export function rowClankerEffectiveLocker(row: Record<string, unknown>): Address | null {
  const locker = row.__clankerLocker;
  if (typeof locker === "string" && isAddress(locker, { strict: false })) {
    return getAddress(locker);
  }
  return clankerDefaultLockerFromEnv();
}

/**
 * Returns the Clanker locker version for a row ("v3" | "v4" | null).
 * Uses the locker registry; falls back to "v3" for unknown addresses so
 * existing tokens continue to work.
 */
export function rowClankerLockerVersion(row: Record<string, unknown>): ClankerLockerVersion {
  const locker = rowClankerEffectiveLocker(row);
  if (!locker) return "v3";
  // Check registry first, then check if the default v4 env locker is configured.
  const fromRegistry = clankerLockerVersion(locker);
  if (fromRegistry) return fromRegistry;
  // Unknown locker: if the v4 env default is explicitly configured and matches, treat as v4.
  const v4Default = clankerV4DefaultLockerFromEnv();
  if (v4Default && getAddress(v4Default) === getAddress(locker)) return "v4";
  return "v3";
}

/**
 * Whether **List** can open for a Clanker row.
 *
 * v4 tokens: no pool contract required — the wizard reads token/pair info directly
 * from `tokenRewards(token)` on the v4 locker. Only a valid locker is needed.
 *
 * v3 tokens: need a Uniswap V3 pool contract address (`pool_address` from API or
 * pasted manually). Locker defaults from `VITE_CLANKER_DEFAULT_LOCKER` when unset.
 */
export function rowClankerListingReady(row: Record<string, unknown>): boolean {
  if (row.__launchVenue !== "Clanker") return false;
  if (!rowLaunchedToken(row)) return false;

  const version = rowClankerLockerVersion(row);

  if (version === "v4") {
    // v4: just need a resolvable locker address (explicit on row or env default).
    return Boolean(rowClankerEffectiveLocker(row));
  }

  // v3: need pool contract address.
  const pool = row.__clankerPool;
  const poolOk = typeof pool === "string" && isAddress(pool, { strict: false });
  if (!poolOk) return false;
  const locker = row.__clankerLocker;
  if (typeof locker === "string" && isAddress(locker, { strict: false })) return true;
  return Boolean(clankerDefaultLockerFromEnv());
}

// Re-export for convenience.
export { isV4Locker, clankerLockerVersion };

export async function fetchClankerTokenDetail(tokenAddress: Address): Promise<ClankerTokenDetail | null> {
  const res = await fetch(`/api/clanker-get-token?address=${encodeURIComponent(tokenAddress)}`);
  const json = (await res.json()) as { ok?: boolean; data?: unknown };
  if (!json.ok || json.data === undefined) return null;
  return extractClankerTokenRecord(json.data);
}
