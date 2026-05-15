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

/** For Bankr Doppler-style pools, the “launch” token is usually the non-WETH leg. */
export function launchedTokenFromWethPair(token0: Address, token1: Address): Address | undefined {
  const w = WETH_BASE.toLowerCase();
  const a0 = token0.toLowerCase() === w;
  const a1 = token1.toLowerCase() === w;
  if (a0 && !a1) return getAddress(token1);
  if (a1 && !a0) return getAddress(token0);
  return undefined;
}

export function normalizePoolId(raw: unknown): Hex | null {
  if (typeof raw !== "string" || !raw.startsWith("0x")) return null;
  const body = raw.slice(2).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(body)) return null;
  return `0x${body}` as Hex;
}

/** Launched ERC-20 from a Bankr `creator-fees` / launches row (field names vary). */
export function rowLaunchedToken(row: Record<string, unknown>): Address | null {
  for (const k of ["tokenAddress", "contract_address", "contractAddress", "ca", "mint", "contract", "token"]) {
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

function shortAddr(addr: string) {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

function isWethHumanLabel(s: string | null | undefined): boolean {
  if (!s?.trim()) return false;
  const t = s.trim().toLowerCase();
  return t === "weth" || t === "wrapped ether" || t.startsWith("wrapped ether ");
}

export type BankrPoolLabels = {
  /** Launched token symbol only (no WETH prefix). */
  ticker: string;
  /** Launched token name when available — never “Wrapped Ether”. */
  tokenName: string | null;
  launched: Address;
};

/** Strip `WETH / …` (or `… / WETH`) down to the launched leg for display/search. */
export function normalizeLaunchedTicker(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const t = raw.trim();
  const sep = " / ";
  const i = t.indexOf(sep);
  if (i >= 0) {
    const left = t.slice(0, i).trim();
    const right = t.slice(i + sep.length).trim();
    if (isWethHumanLabel(left)) return right || null;
    if (isWethHumanLabel(right)) return left || null;
    return t;
  }
  return isWethHumanLabel(t) ? null : t;
}

/** Pool labels for listings and receipt NFT cards (launched ticker/name only). */
export function formatBankrPoolLabels(
  token0: Address | undefined,
  token1: Address | undefined,
  symbol0: string | null | undefined,
  symbol1: string | null | undefined,
  name0?: string | null,
  name1?: string | null,
): BankrPoolLabels | null {
  if (!token0 || !token1) return null;
  const w = WETH_BASE.toLowerCase();
  const t0 = getAddress(token0).toLowerCase();
  const t1 = getAddress(token1).toLowerCase();
  const s0 = symbol0?.trim() || null;
  const s1 = symbol1?.trim() || null;
  const n0 = name0?.trim() || null;
  const n1 = name1?.trim() || null;

  if (t0 === w && t1 !== w) {
    const launched = getAddress(token1);
    const launchedSym = s1 || shortAddr(launched);
    const launchedName = n1 && !isWethHumanLabel(n1) ? n1 : null;
    return {
      ticker: launchedSym,
      tokenName: launchedName || s1,
      launched,
    };
  }
  if (t1 === w && t0 !== w) {
    const launched = getAddress(token0);
    const launchedSym = s0 || shortAddr(launched);
    const launchedName = n0 && !isWethHumanLabel(n0) ? n0 : null;
    return {
      ticker: launchedSym,
      tokenName: launchedName || s0,
      launched,
    };
  }

  const ticker =
    s0 && s1
      ? normalizeLaunchedTicker(`${s0} / ${s1}`) ??
        `${s0} / ${s1}`
      : `${shortAddr(getAddress(token0))} / ${shortAddr(getAddress(token1))}`;
  const tokenName =
    (n0 && !isWethHumanLabel(n0) ? n0 : null) ||
    (n1 && !isWethHumanLabel(n1) ? n1 : null) ||
    s0 ||
    s1;
  return { ticker, tokenName, launched: getAddress(token0) };
}

/** Primary label for a fee / launch row in the UI (symbol + contract, never bare numeric ids alone). */
export function launchRowLabel(row: Record<string, unknown>): string {
  const ta = rowLaunchedToken(row);
  const shortTa = ta ? shortAddr(ta) : null;
  const pid = rowPoolIdHex(row);
  const shortPool = pid ? `${pid.slice(0, 8)}…${pid.slice(-6)}` : null;
  for (const k of ["tokenSymbol", "symbol", "name", "title", "ticker", "slug"]) {
    const v = row[k];
    if (typeof v === "string" && v.trim()) {
      const s = v.trim();
      if (shortTa) {
        const n = s.toLowerCase();
        const a = shortTa.toLowerCase();
        if (!n.startsWith("0x") && !n.includes(a.slice(0, 8))) return `${s} · ${shortTa}`;
      }
      return s;
    }
  }
  if (shortTa) return shortTa;
  if (shortPool) return `Pool ${shortPool}`;
  for (const k of ["id", "launchId"]) {
    const v = row[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  const rawTa = row.tokenAddress;
  if (typeof rawTa === "string" && rawTa.length > 10) return `${rawTa.slice(0, 6)}…${rawTa.slice(-4)}`;
  return "Token";
}
