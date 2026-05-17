/**
 * GroupBuyEscrow ABI — generated from out/GroupBuyEscrow.sol/GroupBuyEscrow.json
 *
 * Key functions:
 *   createListing(collection, tokenId, priceWei, durationSeconds, minContributionWei, bankrEscrow)
 *   createPartialListing(collection, tokenId, priceWei, durationSeconds, minContributionWei, sellerKeepsBps, bankrEscrow)
 *   contribute(listingId)   [payable]
 *   finalize(listingId)
 *   refundAll(listingId)
 *   claimRefund(listingId)
 *   cancel(listingId)
 *   getListing(listingId)
 *   getContributors(listingId)
 *   getContribution(listingId, contributor)
 *   nextListingId()
 */
export const groupBuyEscrowAbi = [
  {
    type: "constructor",
    inputs: [
      { name: "feeRecipient_", type: "address", internalType: "address" },
      { name: "splitFactory_", type: "address", internalType: "address" },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "FEE_BPS",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "MAX_CONTRIBUTORS",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "MAX_DURATION",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "MIN_DURATION",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "cancel",
    inputs: [{ name: "listingId", type: "uint256", internalType: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "claimRefund",
    inputs: [{ name: "listingId", type: "uint256", internalType: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "contribute",
    inputs: [{ name: "listingId", type: "uint256", internalType: "uint256" }],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "createListing",
    inputs: [
      { name: "collection", type: "address", internalType: "contract IERC721" },
      { name: "tokenId", type: "uint256", internalType: "uint256" },
      { name: "priceWei", type: "uint256", internalType: "uint256" },
      { name: "durationSeconds", type: "uint256", internalType: "uint256" },
      { name: "minContributionWei", type: "uint256", internalType: "uint256" },
      { name: "bankrEscrow", type: "address", internalType: "address" },
    ],
    outputs: [{ name: "listingId", type: "uint256", internalType: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "createPartialListing",
    inputs: [
      { name: "collection", type: "address", internalType: "contract IERC721" },
      { name: "tokenId", type: "uint256", internalType: "uint256" },
      { name: "priceWei", type: "uint256", internalType: "uint256" },
      { name: "durationSeconds", type: "uint256", internalType: "uint256" },
      { name: "minContributionWei", type: "uint256", internalType: "uint256" },
      { name: "sellerKeepsBps", type: "uint16", internalType: "uint16" },
      { name: "bankrEscrow", type: "address", internalType: "address" },
    ],
    outputs: [{ name: "listingId", type: "uint256", internalType: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "feeRecipient",
    inputs: [],
    outputs: [{ name: "", type: "address", internalType: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "finalize",
    inputs: [{ name: "listingId", type: "uint256", internalType: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "forwardAccruedFees",
    inputs: [
      { name: "listingId", type: "uint256", internalType: "uint256" },
      { name: "bankrEscrowAddress", type: "address", internalType: "address" },
      { name: "poolId", type: "bytes32", internalType: "bytes32" },
      { name: "token0", type: "address", internalType: "address" },
      { name: "token1", type: "address", internalType: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "getContribution",
    inputs: [
      { name: "listingId", type: "uint256", internalType: "uint256" },
      { name: "contributor", type: "address", internalType: "address" },
    ],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getContributors",
    inputs: [{ name: "listingId", type: "uint256", internalType: "uint256" }],
    outputs: [{ name: "", type: "address[]", internalType: "address[]" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getListing",
    inputs: [{ name: "listingId", type: "uint256", internalType: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        internalType: "struct GroupBuyEscrow.Listing",
        components: [
          { name: "collection", type: "address", internalType: "contract IERC721" },
          { name: "tokenId", type: "uint256", internalType: "uint256" },
          { name: "seller", type: "address", internalType: "address" },
          { name: "priceWei", type: "uint256", internalType: "uint256" },
          { name: "deadline", type: "uint64", internalType: "uint64" },
          { name: "minContributionWei", type: "uint256", internalType: "uint256" },
          { name: "sellerKeepsBps", type: "uint16", internalType: "uint16" },
          { name: "bankrEscrow", type: "address", internalType: "address" },
          { name: "totalRaised", type: "uint256", internalType: "uint256" },
          { name: "splitAddress", type: "address", internalType: "address" },
          { name: "active", type: "bool", internalType: "bool" },
          { name: "finalized", type: "bool", internalType: "bool" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "nextListingId",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "onERC721Received",
    inputs: [
      { name: "", type: "address", internalType: "address" },
      { name: "", type: "address", internalType: "address" },
      { name: "", type: "uint256", internalType: "uint256" },
      { name: "", type: "bytes", internalType: "bytes" },
    ],
    outputs: [{ name: "", type: "bytes4", internalType: "bytes4" }],
    stateMutability: "pure",
  },
  {
    type: "function",
    name: "refundAll",
    inputs: [{ name: "listingId", type: "uint256", internalType: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "splitFactory",
    inputs: [],
    outputs: [{ name: "", type: "address", internalType: "contract IPushSplitFactory" }],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "AccruedFeesForwarded",
    inputs: [
      { name: "listingId", type: "uint256", indexed: true },
      { name: "split", type: "address", indexed: true },
      { name: "amount0", type: "uint256", indexed: false },
      { name: "amount1", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Cancelled",
    inputs: [
      { name: "listingId", type: "uint256", indexed: true },
      { name: "seller", type: "address", indexed: true },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Contributed",
    inputs: [
      { name: "listingId", type: "uint256", indexed: true },
      { name: "contributor", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "totalRaised", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Finalized",
    inputs: [
      { name: "listingId", type: "uint256", indexed: true },
      { name: "splitAddress", type: "address", indexed: true },
      { name: "totalRaised", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "GroupBuyListed",
    inputs: [
      { name: "listingId", type: "uint256", indexed: true },
      { name: "collection", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
      { name: "seller", type: "address", indexed: false },
      { name: "priceWei", type: "uint256", indexed: false },
      { name: "deadline", type: "uint64", indexed: false },
      { name: "sellerKeepsBps", type: "uint16", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Refunded",
    inputs: [
      { name: "listingId", type: "uint256", indexed: true },
      { name: "contributor", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
] as const;

export type GroupBuyListing = {
  collection: `0x${string}`;
  tokenId: bigint;
  seller: `0x${string}`;
  priceWei: bigint;
  deadline: bigint;
  minContributionWei: bigint;
  sellerKeepsBps: number;
  bankrEscrow: `0x${string}`;
  totalRaised: bigint;
  splitAddress: `0x${string}`;
  active: boolean;
  finalized: boolean;
};
