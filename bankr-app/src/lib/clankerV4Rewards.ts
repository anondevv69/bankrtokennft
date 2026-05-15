import type { PublicClient } from "viem";
import { getAddress, isAddress, type Address } from "viem";
import { rowLaunchedToken, WETH_BASE } from "./escrowArgs";
import { rowClankerEffectiveLocker, rowClankerLockerVersion } from "./clankerDetail";
import { clankerLockerV4Abi } from "./clankerLockerV4Abi";

/** Serialized `tokenRewards` snapshot for UI (from on-chain multicall). */
export type ClankerV4RewardsSnapshot = {
  poolCurrency0: Address;
  poolCurrency1: Address;
  rewardBps: readonly number[];
  rewardAdmins: readonly string[];
  rewardRecipients: readonly string[];
};

export function parseClankerV4TokenRewardsResult(raw: unknown): ClankerV4RewardsSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const pk = o.poolKey as Record<string, unknown> | undefined;
  const c0 = pk?.currency0;
  const c1 = pk?.currency1;
  if (typeof c0 !== "string" || typeof c1 !== "string" || !isAddress(c0) || !isAddress(c1)) return null;
  const bpsRaw = o.rewardBps;
  const adminsRaw = o.rewardAdmins;
  const recRaw = o.rewardRecipients;
  if (!Array.isArray(bpsRaw) || !Array.isArray(adminsRaw) || !Array.isArray(recRaw)) return null;
  const rewardBps = bpsRaw.map((x) => (typeof x === "bigint" ? Number(x) : Number(x)));
  const rewardAdmins = adminsRaw.map((a) => (typeof a === "string" && a.startsWith("0x") ? getAddress(a) : ""));
  const rewardRecipients = recRaw.map((a) => (typeof a === "string" && a.startsWith("0x") ? getAddress(a) : ""));
  if (rewardAdmins.length !== rewardRecipients.length || rewardBps.length !== rewardAdmins.length) return null;
  return {
    poolCurrency0: getAddress(c0),
    poolCurrency1: getAddress(c1),
    rewardBps,
    rewardAdmins,
    rewardRecipients,
  };
}

function isWeth(a: Address): boolean {
  return a.toLowerCase() === WETH_BASE.toLowerCase();
}

/** Short label for a pool leg (WETH vs “token”). */
export function clankerV4LegLabel(addr: Address): string {
  if (isWeth(addr)) return "WETH";
  return `token ${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** One-line summary for a reward index (bps + legs hint). */
export function clankerV4IndexSummary(snap: ClankerV4RewardsSnapshot, index: number): string {
  const bps = snap.rewardBps[index] ?? 0;
  const pct = (bps / 100).toFixed(2);
  const a0 = snap.poolCurrency0;
  const a1 = snap.poolCurrency1;
  const legs = `${clankerV4LegLabel(a0)} / ${clankerV4LegLabel(a1)}`;
  return `#${index} · ${pct}% · ${legs}`;
}

/** Indices where `who` is reward admin (can start escrow for that split). */
export function clankerV4AdminIndicesFor(snap: ClankerV4RewardsSnapshot, who: Address): number[] {
  const me = who.toLowerCase();
  const out: number[] = [];
  for (let i = 0; i < snap.rewardAdmins.length; i++) {
    if (snap.rewardAdmins[i]?.toLowerCase() === me) out.push(i);
  }
  return out;
}

/** Indices where `who` is recipient (informational). */
export function clankerV4RecipientIndicesFor(snap: ClankerV4RewardsSnapshot, who: Address): number[] {
  const me = who.toLowerCase();
  const out: number[] = [];
  for (let i = 0; i < snap.rewardRecipients.length; i++) {
    if (snap.rewardRecipients[i]?.toLowerCase() === me) out.push(i);
  }
  return out;
}

/** Attach `__clankerV4Rewards` to each Clanker v4 row (multicall `tokenRewards` on the row’s locker). */
export async function enrichClankerRowsWithV4Snapshots(
  client: PublicClient,
  rows: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const pairs: { locker: Address; token: Address }[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.__launchVenue !== "Clanker") continue;
    if (rowClankerLockerVersion(row) !== "v4") continue;
    const token = rowLaunchedToken(row);
    const locker = rowClankerEffectiveLocker(row);
    if (!token || !locker) continue;
    const k = `${locker.toLowerCase()}|${token.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    pairs.push({ locker, token });
  }
  if (pairs.length === 0) return rows;

  const res = await client.multicall({
    contracts: pairs.map(({ locker, token }) => ({
      address: locker,
      abi: clankerLockerV4Abi,
      functionName: "tokenRewards" as const,
      args: [token] as const,
    })),
    allowFailure: true,
  });

  const snapByKey = new Map<string, ClankerV4RewardsSnapshot>();
  for (let i = 0; i < pairs.length; i++) {
    const { locker, token } = pairs[i];
    const k = `${locker.toLowerCase()}|${token.toLowerCase()}`;
    const r = res[i];
    if (r.status !== "success" || !r.result) continue;
    const snap = parseClankerV4TokenRewardsResult(r.result);
    if (snap) snapByKey.set(k, snap);
  }

  return rows.map((row) => {
    if (row.__launchVenue !== "Clanker" || rowClankerLockerVersion(row) !== "v4") return row;
    const token = rowLaunchedToken(row);
    const locker = rowClankerEffectiveLocker(row);
    if (!token || !locker) return row;
    const snap = snapByKey.get(`${locker.toLowerCase()}|${token.toLowerCase()}`);
    if (!snap) return row;
    return { ...row, __clankerV4Rewards: snap };
  });
}
