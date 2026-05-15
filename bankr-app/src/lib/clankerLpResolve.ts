import type { PublicClient } from "viem";
import { getAddress, type Address } from "viem";
import { clankerLockerAbi } from "./clankerLockerAbi";
import { uniswapV3PoolAbi, uniswapV3PositionManagerAbi } from "./uniswapV3MinimalAbi";

/**
 * Finds the Uniswap V3 position NFT id registered with Clanker’s locker for `user`
 * whose pair matches `poolAddress`’s token0/token1 (Clanker-launched token must be one leg).
 */
export async function resolveClankerLpTokenIdForPool(
  client: PublicClient,
  params: {
    locker: Address;
    poolAddress: Address;
    launchedToken: Address;
    user: Address;
  },
): Promise<{ lpTokenId: bigint; token0: Address; token1: Address } | null> {
  const poolToken0 = (await client.readContract({
    address: params.poolAddress,
    abi: uniswapV3PoolAbi,
    functionName: "token0",
  })) as Address;
  const poolToken1 = (await client.readContract({
    address: params.poolAddress,
    abi: uniswapV3PoolAbi,
    functionName: "token1",
  })) as Address;

  const lt = getAddress(params.launchedToken).toLowerCase();
  const pt0 = getAddress(poolToken0).toLowerCase();
  const pt1 = getAddress(poolToken1).toLowerCase();
  if (lt !== pt0 && lt !== pt1) return null;

  const npm = (await client.readContract({
    address: params.locker,
    abi: clankerLockerAbi,
    functionName: "positionManager",
  })) as Address;

  const ids = (await client.readContract({
    address: params.locker,
    abi: clankerLockerAbi,
    functionName: "getLpTokenIdsForCreator",
    args: [params.user],
  })) as readonly bigint[];

  const canon0 = getAddress(poolToken0);
  const canon1 = getAddress(poolToken1);

  for (const id of ids) {
    const pos = (await client.readContract({
      address: npm,
      abi: uniswapV3PositionManagerAbi,
      functionName: "positions",
      args: [id],
    })) as readonly unknown[];

    const t0 = getAddress(pos[2] as Address);
    const t1 = getAddress(pos[3] as Address);

    const match =
      (t0 === canon0 && t1 === canon1) ||
      (t0 === canon1 && t1 === canon0);
    if (match) return { lpTokenId: id, token0: canon0, token1: canon1 };
  }

  return null;
}
