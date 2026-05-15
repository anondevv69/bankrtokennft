import type { PublicClient } from "viem";
import { encodeAbiParameters, getAddress, keccak256, parseAbiParameters, type Address, type Hex } from "viem";
import { bankrEscrowAbi } from "./bankrEscrowAbi";
import { bankrFeeRightsReceiptAbi } from "./bankrFeeRightsReceiptAbi";
import { clankerEscrowAbi } from "./clankerEscrowAbi";

export function clankerEscrowKey(locker: Address, lpTokenId: bigint): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("address, uint256"), [getAddress(locker), lpTokenId]),
  );
}

/**
 * Routes `redeemRights` to Bankr or Clanker escrow depending on on-chain receipt position + escrow state.
 */
export async function resolveReceiptRedeemEscrow(
  client: PublicClient,
  params: {
    collection: Address;
    tokenId: bigint;
    bankrEscrow: Address;
    clankerEscrow: Address | null;
  },
): Promise<Address> {
  const { collection, tokenId, bankrEscrow, clankerEscrow } = params;

  let position: {
    feeManager: Address;
    poolId: Hex;
  };
  try {
    position = (await client.readContract({
      address: collection,
      abi: bankrFeeRightsReceiptAbi,
      functionName: "positionOf",
      args: [tokenId],
    })) as { feeManager: Address; poolId: Hex };
  } catch {
    return bankrEscrow;
  }

  const fm = getAddress(position.feeManager as Address);
  const poolId = position.poolId;

  try {
    const escrowed = await client.readContract({
      address: bankrEscrow,
      abi: bankrEscrowAbi,
      functionName: "isEscrowed",
      args: [poolId],
    });
    const mgr = await client.readContract({
      address: bankrEscrow,
      abi: bankrEscrowAbi,
      functionName: "feeManagerForPool",
      args: [poolId],
    });
    if (escrowed && getAddress(mgr as Address) === fm) return bankrEscrow;
  } catch {
    /* feeManagerForPool may revert on unknown pool — try Clanker */
  }

  if (!clankerEscrow) return bankrEscrow;

  try {
    const lpTokenId = BigInt(poolId);
    const key = clankerEscrowKey(fm, lpTokenId);
    const escrowed = await client.readContract({
      address: clankerEscrow,
      abi: clankerEscrowAbi,
      functionName: "isEscrowed",
      args: [key],
    });
    const locker = await client.readContract({
      address: clankerEscrow,
      abi: clankerEscrowAbi,
      functionName: "lockerForKey",
      args: [key],
    });
    if (escrowed && getAddress(locker as Address) === fm) return clankerEscrow;
  } catch {
    /* ignore */
  }

  return bankrEscrow;
}
