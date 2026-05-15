import type { PublicClient } from "viem";
import { getAddress, type Address } from "viem";
import { MVP_CHAIN_ID } from "./chain";

const erc721ApprovalAbi = [
  {
    type: "function",
    name: "getApproved",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "isApprovedForAll",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "operator", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
] as const;

export async function readNftOwner(
  client: PublicClient,
  collection: Address,
  tokenId: bigint,
): Promise<Address> {
  return getAddress(
    await client.readContract({
      address: collection,
      abi: erc721ApprovalAbi,
      functionName: "ownerOf",
      args: [tokenId],
      chainId: MVP_CHAIN_ID,
    }) as Address,
  );
}

export async function isMarketplaceApproved(
  client: PublicClient,
  collection: Address,
  tokenId: bigint,
  owner: Address,
  marketplace: Address,
): Promise<boolean> {
  const mkt = getAddress(marketplace);
  const [spender, approvedAll] = await Promise.all([
    client.readContract({
      address: collection,
      abi: erc721ApprovalAbi,
      functionName: "getApproved",
      args: [tokenId],
      chainId: MVP_CHAIN_ID,
    }),
    client.readContract({
      address: collection,
      abi: erc721ApprovalAbi,
      functionName: "isApprovedForAll",
      args: [getAddress(owner), mkt],
      chainId: MVP_CHAIN_ID,
    }),
  ]);
  if (approvedAll === true) return true;
  if (typeof spender === "string" && spender.startsWith("0x")) {
    try {
      return getAddress(spender as Address) === mkt;
    } catch {
      return false;
    }
  }
  return false;
}

/** After approve tx, RPC can lag — poll until marketplace can pull the NFT. */
export async function waitForMarketplaceApproval(
  client: PublicClient,
  collection: Address,
  tokenId: bigint,
  owner: Address,
  marketplace: Address,
  timeoutMs = 45_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isMarketplaceApproved(client, collection, tokenId, owner, marketplace)) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(
    "Approval confirmed on Base but the marketplace still cannot pull this NFT. Wait a few seconds and tap List again.",
  );
}

const REVERT_HINTS: { match: RegExp; message: string }[] = [
  {
    match: /0x177e802f|ERC721InsufficientApproval|insufficient approval/i,
    message:
      "The marketplace is not approved to move this NFT yet. Tap List once — we will request approval, then list automatically in the same flow.",
  },
  {
    match: /0xa3d582ec|AlreadyListed/i,
    message: "This NFT is already listed. Cancel the sale under Your listings, then set a new price.",
  },
  {
    match: /0xb53091df|NotAuthorizedForToken/i,
    message: "You are not allowed to list this token from the connected wallet.",
  },
  {
    match: /0xfa6128e1|ERC721IncorrectOwner/i,
    message: "This wallet does not own the NFT on Base (it may already be listed or in escrow).",
  },
];

export function formatListFlowError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  for (const { match, message } of REVERT_HINTS) {
    if (match.test(msg)) return message;
  }
  if (/user rejected|denied|cancelled|canceled/i.test(msg)) {
    return "Transaction cancelled in your wallet.";
  }
  return msg.length > 320 ? `${msg.slice(0, 320)}…` : msg;
}
