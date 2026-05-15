/** `ClankerEscrowV4` — subset for in-app escrow wizard + redeem routing. */
export const clankerEscrowV4Abi = [
  {
    type: "function",
    name: "prepareDeposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "locker", type: "address" },
      { name: "token", type: "address" },
      { name: "rewardIndex", type: "uint256" },
      { name: "token0", type: "address" },
      { name: "token1", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "finalizeDeposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "locker", type: "address" },
      { name: "token", type: "address" },
      { name: "rewardIndex", type: "uint256" },
    ],
    outputs: [{ name: "tokenId", type: "uint256" }],
  },
  {
    type: "function",
    name: "cancelPendingDeposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "locker", type: "address" },
      { name: "token", type: "address" },
      { name: "rewardIndex", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "redeemRights",
    stateMutability: "nonpayable",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "allowedLocker",
    stateMutability: "view",
    inputs: [{ name: "locker", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "pendingSeller",
    stateMutability: "view",
    inputs: [{ name: "key", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "isEscrowed",
    stateMutability: "view",
    inputs: [{ name: "key", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "keyFor",
    stateMutability: "pure",
    inputs: [
      { name: "locker", type: "address" },
      { name: "token", type: "address" },
      { name: "rewardIndex", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;
