/** Fee manager (`initializer`) — `getShares` for escrow wizard gates. */
export const bankrFeesMinimalAbi = [
  {
    type: "function",
    name: "getShares",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "beneficiary", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;
