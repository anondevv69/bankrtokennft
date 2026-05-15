/**
 * Registry of known Clanker locker contract addresses mapped to their version.
 *
 * v3 = LpLockerv2 (keyed by lpTokenId / Uniswap V3 NFT position id).
 * v4 = ClankerLpLockerFeeConversion / ClankerLpLocker (keyed by (token, rewardIndex)).
 *
 * All addresses are Base mainnet unless noted.
 */

export type ClankerLockerVersion = "v3" | "v4";

export interface ClankerLockerInfo {
  version: ClankerLockerVersion;
  label: string;
}

/** Lookup table keyed by **lowercase** address. */
export const CLANKER_LOCKER_REGISTRY: Record<string, ClankerLockerInfo> = {
  // ── v4 lockers ───────────────────────────────────────────────────────────
  // ClankerLpLockerFeeConversion (Clanker v4 main deployer) — Base mainnet
  "0x63d2dfea64b3433f4071a98665bcd7ca14d93496": { version: "v4", label: "Clanker v4" },
  // ClankerLpLocker (older Clanker v4 locker) — Base mainnet
  "0x29d17c1a8d851d7d4ca97fae97acadb398d9cce0": { version: "v4", label: "Clanker v4" },

  // ── v3.1 lockers (LpLockerv2) ────────────────────────────────────────────
  // Base mainnet v3.1
  "0x33e2eda238edcf470309b8c6d228986a1204c8f9": { version: "v3", label: "Clanker v3.1" },
  // Base mainnet v3.0
  "0x5ec4f99f342038c67a312a166ff56e6d70383d86": { version: "v3", label: "Clanker v3.0" },
  // Base mainnet v2.x (Clanker 0x732560…)
  "0x618a9840691334ee8d24445a4ada4284bf42417d": { version: "v3", label: "Clanker v2" },
  // SocialDex deployer locker
  "0x515d45f06edd179565aa2796388417ed65e88939": { version: "v3", label: "SocialDex" },
};

/** Returns the version for a locker address, or null if unknown. */
export function clankerLockerVersion(locker: string): ClankerLockerVersion | null {
  return CLANKER_LOCKER_REGISTRY[locker.toLowerCase()]?.version ?? null;
}

/** Returns true when the locker is a known Clanker v4 locker. */
export function isV4Locker(locker: string): boolean {
  return clankerLockerVersion(locker) === "v4";
}

/** Returns true when the locker is a known Clanker v3.x locker. */
export function isV3Locker(locker: string): boolean {
  return clankerLockerVersion(locker) === "v3";
}

/** Well-known default lockers for the manual-input path. */
export const CLANKER_V3_DEFAULT_LOCKER = "0x33e2Eda238edcF470309b8c6D228986A1204c8f9";
export const CLANKER_V4_DEFAULT_LOCKER = "0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496";
