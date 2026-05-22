/**
 * Gas drip sender — Option 2 onboarding.
 *
 * After a mint completes, if the recipient has opted in (gas_drips.status =
 * 'opted_in'), send a fixed-amount native xDAI transfer from the drip
 * hot wallet to bootstrap the user's gas balance.
 *
 * Hard rules enforced here, not at call sites:
 *   - One drip per recipient address, ever (PK constraint on gas_drips).
 *   - The mint flow MUST NOT be blocked by anything that happens here.
 *   - Drip wallet balance < amount → mark `wallet_dry`, fire alert, do not
 *     mark drip as sent (so a refill makes the user eligible again).
 *   - Drip wallet key never logged.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  fallback,
  type Hex as ViemHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import type { Sql } from 'postgres';
import type { BackendConfig } from '../config.js';
import type { GasDripStatus } from '../db/schema.js';

export interface DripDecision {
  recipient: string;
  outcome:
    | 'sent'           // tx confirmed
    | 'opted_out'      // user unchecked the box
    | 'no_record'      // no gas_drips row — recipient never opted in
    | 'already_done'   // status was already 'sent' or 'failed'
    | 'below_min'      // amount_sat < dripMinDepositSat
    | 'wallet_dry'     // drip wallet balance < drip amount
    | 'tx_reverted'    // sent but on-chain reverted
    | 'error';         // unexpected throw — see message
  txHash?: string;
  message?: string;
}

export class DripSender {
  private readonly account;
  private readonly publicClient;
  private readonly walletClient;

  constructor(
    private readonly sql: Sql,
    private readonly config: BackendConfig,
  ) {
    if (!config.dripEnabled) {
      throw new Error('DripSender constructed with dripEnabled=false');
    }
    if (!config.dripHotWalletPrivateKey) {
      throw new Error('DRIP_HOT_WALLET_PRIVATE_KEY is required when DRIP_ENABLED=true');
    }
    this.account = privateKeyToAccount(config.dripHotWalletPrivateKey as ViemHex);
    this.publicClient = createPublicClient({
      chain: gnosis,
      // READ path: fallback() across the ordered RPC list so reads survive the
      // node going down. Writers stay pinned to gnosisRpcUrl — see config.ts.
      transport: fallback(config.gnosisRpcUrls.map((u) => http(u))),
    });
    this.walletClient = createWalletClient({
      account: this.account,
      chain: gnosis,
      transport: http(config.gnosisRpcUrl),
    });
  }

  /** The drip hot wallet's address — used by the monitor for balance checks. */
  get walletAddress(): string {
    return this.account.address;
  }

  /** Read drip hot wallet's native xDAI balance (wei). */
  async getWalletBalanceWei(): Promise<bigint> {
    return this.publicClient.getBalance({ address: this.account.address });
  }

  /**
   * Attempt a drip after a mint completed for `orderId`.  Returns a structured
   * decision so the caller (mint executor) can log without inspecting DB state.
   *
   * NEVER throws — all errors are returned in DripDecision.outcome.
   */
  async sendDripIfEligible(
    recipient: string,
    orderId: string,
    amountSat: bigint,
  ): Promise<DripDecision> {
    try {
      // 1. Read current gas_drips row.
      const rows = await this.sql<{ status: GasDripStatus }[]>`
        SELECT status FROM gas_drips
        WHERE recipient_gnosis_address = ${recipient}
      `;
      const existing = rows[0];

      if (!existing) {
        return { recipient, outcome: 'no_record' };
      }
      if (existing.status === 'opted_out') {
        return { recipient, outcome: 'opted_out' };
      }
      if (existing.status === 'sent' || existing.status === 'failed') {
        return { recipient, outcome: 'already_done' };
      }
      // status is now opted_in or wallet_dry — both eligible for a (re)try.

      // 2. Min-deposit gate.
      if (amountSat < this.config.dripMinDepositSat) {
        return { recipient, outcome: 'below_min' };
      }

      // 3. Balance check.
      const balance = await this.getWalletBalanceWei();
      if (balance < this.config.dripAmountWei) {
        await this.sql`
          UPDATE gas_drips
          SET status = 'wallet_dry',
              error  = ${`balance=${balance} < drip=${this.config.dripAmountWei}`},
              updated_at = now()
          WHERE recipient_gnosis_address = ${recipient}
        `;
        return {
          recipient,
          outcome: 'wallet_dry',
          message: `drip wallet balance ${balance} wei < drip amount ${this.config.dripAmountWei} wei`,
        };
      }

      // 4. Send the tx.
      const txHash = await this.walletClient.sendTransaction({
        to: recipient as ViemHex,
        value: this.config.dripAmountWei,
      });

      // 5. Record attempt with order_id + tx hash.  Status stays 'opted_in'
      //    until receipt confirms — promotes to 'sent' or 'failed' below.
      await this.sql`
        UPDATE gas_drips
        SET order_id       = ${orderId},
            amount_wei     = ${this.config.dripAmountWei.toString()},
            gnosis_tx_hash = ${txHash},
            updated_at     = now()
        WHERE recipient_gnosis_address = ${recipient}
      `;

      // 6. Wait for receipt (up to 60s — Gnosis ~5s blocks).
      const receipt = await this.publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 60_000,
      });

      if (receipt.status === 'reverted') {
        await this.sql`
          UPDATE gas_drips
          SET status     = 'failed',
              error      = 'tx reverted on-chain',
              updated_at = now()
          WHERE recipient_gnosis_address = ${recipient}
        `;
        return { recipient, outcome: 'tx_reverted', txHash };
      }

      await this.sql`
        UPDATE gas_drips
        SET status     = 'sent',
            sent_at    = now(),
            updated_at = now()
        WHERE recipient_gnosis_address = ${recipient}
      `;
      return { recipient, outcome: 'sent', txHash };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Best-effort: record the failure but don't let DB write throw out of
      // this function.
      try {
        await this.sql`
          UPDATE gas_drips
          SET error      = ${message.slice(0, 500)},
              updated_at = now()
          WHERE recipient_gnosis_address = ${recipient}
        `;
      } catch {
        /* swallow — we already failed once */
      }
      return { recipient, outcome: 'error', message };
    }
  }
}
