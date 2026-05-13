/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MARKETPLACE_ADDRESS?: string;
  readonly VITE_DEFAULT_RECEIPT_COLLECTION?: string;
  readonly VITE_RPC_URL?: string;
  /** Documented for ops; app is hardcoded to Base mainnet (8453). Other values are ignored with a console warning. */
  readonly VITE_CHAIN_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
