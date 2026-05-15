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
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
