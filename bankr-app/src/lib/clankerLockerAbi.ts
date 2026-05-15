/** Clanker `LpLockerv2` — subset for creator-admin transfer + LP discovery. */
export const clankerLockerAbi = [
  {
    type: "function",
    name: "tokenRewards",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "lpTokenId", type: "uint256" },
      { name: "creatorReward", type: "uint256" },
      {
        name: "creator",
        type: "tuple",
        components: [
          { name: "admin", type: "address" },
          { name: "recipient", type: "address" },
        ],
      },
      {
        name: "interfacer",
        type: "tuple",
        components: [
          { name: "admin", type: "address" },
          { name: "recipient", type: "address" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "updateCreatorRewardAdmin",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenId", type: "uint256" },
      { name: "newAdmin", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getLpTokenIdsForCreator",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ type: "uint256[]" }],
  },
  {
    type: "function",
    name: "positionManager",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;
