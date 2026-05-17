/**
 * FeeRightsSplit — Solana Program Spike
 *
 * Spike for distributing Pump.fun creator fees to multiple recipients
 * in a way analogous to the EVM GroupBuyEscrow + 0xSplits stack.
 *
 * File: solana/programs/fee_rights_split/src/lib.rs
 *
 * NOTE: This is a design spike / reference implementation, NOT deployed code.
 * Audit and security review required before any mainnet use.
 */

use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("FRS1111111111111111111111111111111111111111");

// ── Constants ──────────────────────────────────────────────────────────────────

/// Maximum number of recipients in a single split.
pub const MAX_RECIPIENTS: usize = 50;

/// Total basis points (10_000 = 100%).
pub const BPS_DENOM: u64 = 10_000;

// ── Program ────────────────────────────────────────────────────────────────────

#[program]
pub mod fee_rights_split {
    use super::*;

    /// Initialize a new FeeRightsSplit.
    ///
    /// The `creator_pda` PDA (seeds = ["fee-rights-split", split.key()]) becomes
    /// the `creator` authority for the Pump.fun bonding curve. Any `collectCreatorFee`
    /// calls must be routed through `collect_and_distribute` below.
    ///
    /// Arguments:
    ///   recipients: Vec<RecipientInit>  — address + basis-point share (must sum to 10_000)
    pub fn initialize(
        ctx: Context<Initialize>,
        recipients: Vec<RecipientInit>,
    ) -> Result<()> {
        require!(recipients.len() <= MAX_RECIPIENTS, FrsError::TooManyRecipients);

        let total_bps: u64 = recipients.iter().map(|r| r.bps as u64).sum();
        require!(total_bps == BPS_DENOM, FrsError::BpsMismatch);

        let split = &mut ctx.accounts.split;
        split.admin = *ctx.accounts.admin.key;
        split.bump = ctx.bumps.split;
        split.creator_vault_bump = ctx.bumps.creator_pda;

        split.recipients = recipients
            .into_iter()
            .map(|r| Recipient { pubkey: r.pubkey, bps: r.bps })
            .collect();

        Ok(())
    }

    /// Collect Pump.fun creator fees from the bonding curve and distribute to
    /// all recipients in a single atomic transaction.
    ///
    /// The `creator_pda` signs the CPI into Pump.fun `collectCreatorFee`.
    /// After collection the lamports in `creator_pda` are pushed proportionally
    /// to each recipient account.
    pub fn collect_and_distribute(ctx: Context<CollectAndDistribute>) -> Result<()> {
        let split_key = ctx.accounts.split.key();

        // ── Step 1: CPI into Pump.fun collectCreatorFee ────────────────────────
        //
        // Pump.fun instruction discriminator: collectCreatorFee
        // Accounts (from pump-public-docs):
        //   creator (signer, writable)  <- creator_pda (PDA, signed with seeds below)
        //   bonding_curve (writable)
        //   system_program
        //
        let cpi_accounts = vec![
            AccountMeta::new(*ctx.accounts.creator_pda.key, true), // signer
            AccountMeta::new(ctx.accounts.bonding_curve.key(), true),
            AccountMeta::new_readonly(system_program::ID, false),
        ];

        let seeds = &[
            b"fee-rights-split",
            split_key.as_ref(),
            &[ctx.accounts.split.creator_vault_bump],
        ];
        let signer_seeds = &[seeds.as_ref()];

        let ix_data: Vec<u8> = {
            // Anchor discriminator for collectCreatorFee (keccak256("global:collect_creator_fee")[..8])
            // Replace with the real 8-byte discriminator from the Pump.fun IDL.
            vec![0xd0, 0x3d, 0xed, 0x6a, 0x2d, 0x42, 0xb5, 0x1f]
        };

        let pump_program_id = ctx.accounts.pump_program.key();
        let ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: pump_program_id,
            accounts: cpi_accounts,
            data: ix_data,
        };

        anchor_lang::solana_program::program::invoke_signed(
            &ix,
            &[
                ctx.accounts.creator_pda.to_account_info(),
                ctx.accounts.bonding_curve.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            signer_seeds,
        )?;

        // ── Step 2: Distribute lamports proportionally ──────────────────────────
        let creator_lamports = ctx.accounts.creator_pda.lamports();
        // Keep rent-exempt minimum in creator_pda.
        let rent = Rent::get()?.minimum_balance(0);
        let distributable = creator_lamports.saturating_sub(rent);
        if distributable == 0 {
            return Ok(());
        }

        let split = &ctx.accounts.split;
        for (i, recipient) in split.recipients.iter().enumerate() {
            let share = (distributable as u128)
                .checked_mul(recipient.bps as u128)
                .unwrap()
                / BPS_DENOM as u128;
            if share == 0 {
                continue;
            }

            // Transfer lamports from creator_pda to recipient.
            // In Anchor, use invoke_signed with system transfer because creator_pda is a PDA.
            let recipient_account = &ctx.remaining_accounts[i];
            require_keys_eq!(
                recipient_account.key(),
                recipient.pubkey,
                FrsError::RecipientMismatch
            );

            let transfer_ix = system_program::Transfer {
                from: ctx.accounts.creator_pda.to_account_info(),
                to: recipient_account.to_account_info(),
            };
            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    transfer_ix,
                    signer_seeds,
                ),
                share as u64,
            )?;
        }

        Ok(())
    }

    /// Update the recipient list (admin only).
    pub fn update_recipients(
        ctx: Context<UpdateRecipients>,
        recipients: Vec<RecipientInit>,
    ) -> Result<()> {
        let total_bps: u64 = recipients.iter().map(|r| r.bps as u64).sum();
        require!(total_bps == BPS_DENOM, FrsError::BpsMismatch);
        require!(recipients.len() <= MAX_RECIPIENTS, FrsError::TooManyRecipients);

        let split = &mut ctx.accounts.split;
        split.recipients = recipients
            .into_iter()
            .map(|r| Recipient { pubkey: r.pubkey, bps: r.bps })
            .collect();
        Ok(())
    }

    /// Transfer admin authority.
    pub fn transfer_admin(ctx: Context<TransferAdmin>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.split.admin = new_admin;
        Ok(())
    }
}

// ── Accounts ───────────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(recipients: Vec<RecipientInit>)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = FeeRightsSplit::space(recipients.len()),
        seeds = [b"split", admin.key().as_ref()],
        bump
    )]
    pub split: Account<'info, FeeRightsSplit>,

    /// PDA that will be registered as the Pump.fun `creator`.
    /// seeds = ["fee-rights-split", split.key()]
    #[account(
        seeds = [b"fee-rights-split", split.key().as_ref()],
        bump
    )]
    /// CHECK: derived PDA — used only as authority; no data stored.
    pub creator_pda: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CollectAndDistribute<'info> {
    /// Can be called by anyone (permissionless distribution).
    pub caller: Signer<'info>,

    pub split: Account<'info, FeeRightsSplit>,

    /// The PDA registered as Pump.fun creator.
    #[account(
        mut,
        seeds = [b"fee-rights-split", split.key().as_ref()],
        bump = split.creator_vault_bump
    )]
    /// CHECK: PDA; signs the Pump.fun CPI.
    pub creator_pda: UncheckedAccount<'info>,

    /// Pump.fun bonding curve PDA for the target token.
    /// CHECK: validated by Pump.fun program.
    #[account(mut)]
    pub bonding_curve: UncheckedAccount<'info>,

    /// Pump.fun program id on mainnet: 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
    /// CHECK: address validated at runtime.
    pub pump_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    // remaining_accounts = [recipient_0, recipient_1, ...] (writable, must match split.recipients order)
}

#[derive(Accounts)]
pub struct UpdateRecipients<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        has_one = admin @ FrsError::Unauthorized,
        realloc = FeeRightsSplit::space(split.recipients.len()),
        realloc::payer = admin,
        realloc::zero = false,
    )]
    pub split: Account<'info, FeeRightsSplit>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TransferAdmin<'info> {
    pub admin: Signer<'info>,

    #[account(mut, has_one = admin @ FrsError::Unauthorized)]
    pub split: Account<'info, FeeRightsSplit>,
}

// ── State ──────────────────────────────────────────────────────────────────────

#[account]
pub struct FeeRightsSplit {
    pub admin: Pubkey,
    pub bump: u8,
    pub creator_vault_bump: u8,
    pub recipients: Vec<Recipient>,
}

impl FeeRightsSplit {
    pub fn space(num_recipients: usize) -> usize {
        8   // discriminator
        + 32  // admin
        + 1   // bump
        + 1   // creator_vault_bump
        + 4   // vec len
        + num_recipients * (32 + 2) // Recipient { pubkey: Pubkey, bps: u16 }
        + 64  // padding
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Recipient {
    pub pubkey: Pubkey,
    pub bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RecipientInit {
    pub pubkey: Pubkey,
    pub bps: u16,
}

// ── Errors ─────────────────────────────────────────────────────────────────────

#[error_code]
pub enum FrsError {
    #[msg("Basis points must sum to 10_000")]
    BpsMismatch,
    #[msg("Recipient count exceeds MAX_RECIPIENTS")]
    TooManyRecipients,
    #[msg("Recipient account does not match split record")]
    RecipientMismatch,
    #[msg("Caller is not the admin")]
    Unauthorized,
}
