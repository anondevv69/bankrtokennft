/**
 * Thin wrapper around @0xsplits/splits-sdk SplitV2Client for Base mainnet.
 *
 * Usage:
 *   const client = getSplitsClient(publicClient, walletClient);
 *   await client.distribute({ splitAddress, tokenAddress, distributorAddress });
 *
 * The distribute() call is the "Claim fees" action that pushes accumulated
 * tokens from a PushSplit to all recipients.
 */

import { SplitV2Client } from "@0xsplits/splits-sdk";
import type { PublicClient, WalletClient } from "viem";
import { base } from "viem/chains";

export const PUSH_SPLIT_FACTORY_BASE = "0x80f1B766817D04870f115fEBbcCADF8DBF75E017" as const;

/** Native ETH token address (ETH sentinel used by 0xSplits). */
export const ETH_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as const;

export function getSplitsClient(
  publicClient?: PublicClient,
  walletClient?: WalletClient
): SplitV2Client {
  return new SplitV2Client({
    chainId: base.id,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    publicClient: publicClient as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    walletClient: walletClient as any,
  });
}

/**
 * Trigger a PushSplit distribution.
 * This sends accumulated ETH / ERC-20 tokens directly to all recipients.
 *
 * @param splitAddress   The 0xSplits PushSplit contract address (stored in GroupBuyEscrow.Listing.splitAddress)
 * @param tokenAddress   Token to distribute. Use ETH_TOKEN for native ETH.
 * @param publicClient   Viem public client.
 * @param walletClient   Viem wallet client (tx signer — can be any address, not just a recipient).
 */
export async function distributeSplit(
  splitAddress: `0x${string}`,
  tokenAddress: `0x${string}`,
  publicClient: PublicClient,
  walletClient: WalletClient
): Promise<{ txHash: `0x${string}` }> {
  const client = getSplitsClient(publicClient, walletClient);
  const { event } = await client.distribute({
    splitAddress,
    tokenAddress,
    distributorAddress: walletClient.account?.address,
  });
  return { txHash: event.transactionHash as `0x${string}` };
}

/**
 * Get the ETH and ERC-20 balance held by a split (pending distribution).
 */
export async function getSplitBalance(
  splitAddress: `0x${string}`,
  tokenAddress: `0x${string}`,
  publicClient: PublicClient
): Promise<{ splitBalance: bigint; warehouseBalance: bigint }> {
  const client = getSplitsClient(publicClient);
  return client.getSplitBalance({ splitAddress, tokenAddress });
}
