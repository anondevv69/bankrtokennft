import { getAddress, isAddress, type Address } from "viem";

/**
 * Production Token Marketplace deploy (Base mainnet, May 2026).
 * Used only when VITE_* is missing from the build — set env on Vercel/Railway instead.
 */
export const CANONICAL_BANKR_ESCROW = "0x6238698212D91845cD1c004DE85951055bB5b292" as const;
/** TMPR shared by Bankr + Clanker escrows above (OpenSea: token-marketplace). */
export const CANONICAL_TMPR_RECEIPT = "0xCD66340D93E212bEC6Db1b22476e4f1276380C3e" as const;
/** EIP-2981 receipt — mint only after new escrows point here (DeployBankrEscrowSharedReceipt). */
export const UPGRADED_TMPR_RECEIPT = "0xE81a9e8B9eA8cd1a413609d70f42CB844eaC9658" as const;

/** Legacy — do NOT use for new Bankr listings (mints BFRR, separate OpenSea collection). */
export const LEGACY_BANKR_ESCROW = "0x7BD14E540Ac55E229587Bf3Cd0Fc815A7afcf461" as const;
export const LEGACY_BFRR_RECEIPT = "0x02441aDdC542A3a3283c4468780eB876F9ADA8BA" as const;

function addressFromEnv(...keys: readonly string[]): Address | null {
  for (const key of keys) {
    const raw = import.meta.env[key as keyof ImportMetaEnv];
    if (typeof raw === "string") {
      const t = raw.trim();
      if (t.startsWith("0x") && isAddress(t)) return getAddress(t);
    }
  }
  return null;
}

/** Bankr escrow — prefer explicit `VITE_BANKR_ESCROW_ADDRESS`; `VITE_ESCROW_ADDRESS` is legacy alias only. */
export function bankrEscrowAddressFromEnv(): Address {
  return (
    addressFromEnv("VITE_BANKR_ESCROW_ADDRESS", "VITE_ESCROW_ADDRESS") ??
    getAddress(CANONICAL_BANKR_ESCROW)
  );
}

/** Shared TMPR receipt — `VITE_DEFAULT_RECEIPT_COLLECTION`. */
export function defaultReceiptCollectionFromEnv(): Address {
  return (
    addressFromEnv("VITE_DEFAULT_RECEIPT_COLLECTION") ?? getAddress(CANONICAL_TMPR_RECEIPT)
  );
}

/** Clanker escrow — optional until wired / deployed. */
export function clankerEscrowAddressFromEnv(): Address | null {
  return addressFromEnv("VITE_CLANKER_ESCROW_ADDRESS");
}

/** Default Clanker v3.x `LpLockerv2` for manual listing without authenticated token metadata. */
export function clankerDefaultLockerFromEnv(): Address | null {
  const raw = import.meta.env.VITE_CLANKER_DEFAULT_LOCKER?.trim();
  if (raw?.startsWith("0x") && isAddress(raw)) return getAddress(raw);
  return getAddress("0x33e2Eda238edcF470309b8c6D228986A1204c8f9");
}

/** Default Clanker v4 locker for manual listing. */
export function clankerV4DefaultLockerFromEnv(): Address | null {
  const raw = import.meta.env.VITE_CLANKER_V4_DEFAULT_LOCKER?.trim();
  if (raw?.startsWith("0x") && isAddress(raw)) return getAddress(raw);
  return getAddress("0x63D2DfEA64b3433F4071A98665bcD7Ca14d93496");
}

/** Deployed `ClankerEscrowV4` contract address — optional until deployed. */
export function clankerEscrowV4AddressFromEnv(): Address | null {
  return addressFromEnv("VITE_CLANKER_V4_ESCROW_ADDRESS");
}

/** True when this build would send Bankr finalize to the legacy BFRR escrow. */
export function isLegacyBankrEscrow(escrow: Address): boolean {
  return getAddress(escrow).toLowerCase() === LEGACY_BANKR_ESCROW.toLowerCase();
}

/** Always scanned so NFTs minted on legacy BFRR still appear in the wallet UI. */
export const DEFAULT_LEGACY_RECEIPT_ALIASES: readonly Address[] = [
  getAddress(LEGACY_BFRR_RECEIPT),
  getAddress("0xb9E56dA4B83e77657296D7dE694754bd8b7d00db"),
  getAddress("0x4eC1a255740316e88873bAf94d6ee805F0DD0C26"),
];
