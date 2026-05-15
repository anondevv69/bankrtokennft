import type { Address } from "viem";

export type EscrowWizardProps = {
  row: Record<string, unknown>;
  /** Bankr — `BankrEscrowV3`. */
  escrowAddress: Address;
  /** Clanker — `ClankerEscrowV1` (optional; required when listing enriched Clanker rows). */
  clankerEscrowAddress?: Address | null;
  userAddress: Address;
  onClose: () => void;
  /** After successful finalize — parent should rescan receipt NFTs. */
  onDone: () => void;
};
