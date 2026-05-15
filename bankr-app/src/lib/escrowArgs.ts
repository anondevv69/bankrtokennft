import { getAddress, isAddress, type Address, type Hex } from "viem";

/** Canonical WETH on Base mainnet. */
export const WETH_BASE = "0x4200000000000000000000000000000000000006" as Address;

/** Uniswap-style sort: lower address is token0. */
export function inferToken0Token1(launchedToken: Address): readonly [Address, Address] {
  const t = launchedToken.toLowerCase();
  const w = WETH_BASE.toLowerCase();
  const a = getAddress(launchedToken);
  const b = getAddress(WETH_BASE);
  return t < w ? [a, b] : [b, a];
}

export function normalizePoolId(raw: unknown): Hex | null {
  if (typeof raw !== "string" || !raw.startsWith("0x")) return null;
  const body = raw.slice(2).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(body)) return null;
  return `0x${body}` as Hex;
}

/** Launched ERC-20 from a Bankr `creator-fees` / launches row (field names vary). */
export function rowLaunchedToken(row: Record<string, unknown>): Address | null {
  for (const k of ["tokenAddress", "contractAddress", "ca", "mint", "contract", "token"]) {
    const v = row[k];
    if (typeof v !== "string" || !v.startsWith("0x") || !isAddress(v, { strict: false })) continue;
    try {
      return getAddress(v);
    } catch {
      continue;
    }
  }
  return null;
}

/** `bytes32` pool id when the API sends a full 66-char hex string. */
export function rowPoolIdHex(row: Record<string, unknown>): Hex | null {
  for (const k of ["poolId", "pool_id", "poolID"]) {
    const n = normalizePoolId(row[k]);
    if (n) return n;
  }
  return null;
}
