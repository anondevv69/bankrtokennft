/** `BankrEscrowV3` — subset for in-app escrow wizard. */
export const bankrEscrowAbi = [
  {
    type: "function",
    name: "prepareDeposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "feeManager", type: "address" },
      { name: "poolId", type: "bytes32" },
      { name: "token0", type: "address" },
      { name: "token1", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "finalizeDeposit",
    stateMutability: "nonpayable",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "tokenId", type: "uint256" }],
  },
  {
    type: "function",
    name: "cancelPendingDeposit",
    stateMutability: "nonpayable",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "pendingSeller",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "allowedFeeManager",
    stateMutability: "view",
    inputs: [{ name: "feeManager", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "isEscrowed",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "tokenIdFor",
    stateMutability: "pure",
    inputs: [
      { name: "feeManager", type: "address" },
      { name: "poolId", type: "bytes32" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;
