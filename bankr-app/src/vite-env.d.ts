/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MARKETPLACE_ADDRESS?: string;
  readonly VITE_DEFAULT_RECEIPT_COLLECTION?: string;
  /** Comma-separated receipt NFT contract addresses to scan in addition to VITE_DEFAULT_RECEIPT_COLLECTION (legacy deploys). */
  readonly VITE_RECEIPT_COLLECTION_ALIASES?: string;
  readonly VITE_RPC_URL?: string;
  /** Documented for ops; app is hardcoded to Base mainnet (8453). Other values are ignored with a console warning. */
  readonly VITE_CHAIN_ID?: string;
  /** Optional — enables WalletConnect QR (e.g. mobile wallet). Project id from https://cloud.reown.com/ */
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
  /** Same as VITE_WALLETCONNECT_PROJECT_ID (alias for Reown dashboard id). */
  readonly VITE_REOWN_PROJECT_ID?: string;
  /** Optional — `getLogs` depth when scanning Transfer events to find token IDs (max 500000). */
  readonly VITE_RECEIPT_SCAN_BLOCKS?: string;
  /** Optional — `BankrEscrowV3` for in-app escrow wizard (defaults to project deploy). */
  readonly VITE_ESCROW_ADDRESS?: string;
  /** Optional alias for Bankr escrow (same as `VITE_ESCROW_ADDRESS` if both set — prefer explicit Bankr here). */
  readonly VITE_BANKR_ESCROW_ADDRESS?: string;
  /** `ClankerEscrowV1` — required for listing Clanker tokens end-to-end. */
  readonly VITE_CLANKER_ESCROW_ADDRESS?: string;
  /** Optional — Base v3.x `LpLockerv2` used when `CLANKER_API_KEY` does not supply locker (manual pool paste path). Defaults to v3.1 `0x33e2E…`. */
  readonly VITE_CLANKER_DEFAULT_LOCKER?: string;
  /** Optional — Override for the v4 default locker (`ClankerLpLockerFeeConversion`). Defaults to `0x63D2D…`. */
  readonly VITE_CLANKER_V4_DEFAULT_LOCKER?: string;
  /** `ClankerEscrowV4` — required for listing Clanker v4 tokens end-to-end. */
  readonly VITE_CLANKER_V4_ESCROW_ADDRESS?: string;
  /** OpenSea collection slug for TMPR (defaults to `tokenmarketplace`). */
  readonly VITE_OPENSEA_COLLECTION_SLUG?: string;
  /** GroupBuyEscrow contract address on Base. Required for Group Buy tab. */
  readonly VITE_GROUP_BUY_ESCROW_ADDRESS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
