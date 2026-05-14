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

export function rowLaunchedToken(row: Record<string, unknown>): Address | null {
  const ta = row.tokenAddress;
  if (typeof ta !== "string" || !ta.startsWith("0x") || !isAddress(ta, { strict: false })) return null;
  try {
    return getAddress(ta);
  } catch {
    return null;
  }
}
