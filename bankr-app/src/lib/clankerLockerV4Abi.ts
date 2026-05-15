/**
 * Clanker v4 locker (`ClankerLpLockerFeeConversion` / `ClankerLpLocker`) —
 * minimal ABI for the escrow wizard.
 *
 * Key difference from v3 `LpLockerv2`: rewards are keyed by
 * `(address token, uint256 rewardIndex)` instead of `uint256 lpTokenId`.
 */
export const clankerLockerV4Abi = [
  {
    type: "function",
    name: "tokenRewards",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "positionId", type: "uint256" },
          { name: "numPositions", type: "uint256" },
          { name: "rewardBps", type: "uint16[]" },
          { name: "rewardAdmins", type: "address[]" },
          { name: "rewardRecipients", type: "address[]" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "updateRewardRecipient",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "rewardIndex", type: "uint256" },
      { name: "newRecipient", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "updateRewardAdmin",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "rewardIndex", type: "uint256" },
      { name: "newAdmin", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "collectRewards",
    stateMutability: "nonpayable",
    inputs: [{ name: "token", type: "address" }],
    outputs: [],
  },
] as const;
