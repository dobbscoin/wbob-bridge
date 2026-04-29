/**
 * Alert dispatcher — fans out alerts to:
 *   1. stderr (always)
 *   2. webhook URL (if configured)
 *   3. Email via local /usr/sbin/sendmail (if configured)
 *
 * Email path uses the system's local MTA — no SMTP creds, no third-party
 * dependency. Useful for ops-level alerts (drip wallet low, etc.) that
 * should reach a human inbox.
 */

import { spawn } from 'node:child_process';
import type { Alert } from './types.js';

const SENDMAIL_PATH = '/usr/sbin/sendmail';

export interface AlertDispatcherOptions {
  webhookUrl?: string | null;
  emailTo?: string | null;
  emailFrom?: string;
}

export class AlertDispatcher {
  private readonly webhookUrl: string | null;
  private readonly emailTo: string | null;
  private readonly emailFrom: string;

  constructor(options: AlertDispatcherOptions | string | null = {}) {
    // Backwards-compat: a bare string/null arg is treated as webhookUrl only.
    if (options === null || typeof options === 'string') {
      this.webhookUrl = options ?? null;
      this.emailTo = null;
      this.emailFrom = 'bridge-alerts@bridge.subgenius.finance';
    } else {
      this.webhookUrl = options.webhookUrl ?? null;
      this.emailTo = options.emailTo ?? null;
      this.emailFrom = options.emailFrom ?? 'bridge-alerts@bridge.subgenius.finance';
    }
  }

  async dispatch(alert: Alert): Promise<void> {
    // Always write to stderr so alerts appear in container logs.
    const prefix = `[solvency-monitor] ${alert.level.toUpperCase()} ${alert.type}`;
    if (alert.level === 'critical' || alert.level === 'warning') {
      console.error(`${prefix}: ${alert.message}`);
    } else {
      console.log(`${prefix}: ${alert.message}`);
    }

    await Promise.allSettled([
      this._dispatchWebhook(alert),
      this._dispatchEmail(alert),
    ]);
  }

  private async _dispatchWebhook(alert: Alert): Promise<void> {
    if (!this.webhookUrl) return;
    try {
      const res = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(alert),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        console.error(
          `[solvency-monitor] webhook delivery failed HTTP ${res.status}: ${res.statusText}`,
        );
      }
    } catch (err) {
      console.error('[solvency-monitor] webhook delivery error:', err);
    }
  }

  private async _dispatchEmail(alert: Alert): Promise<void> {
    if (!this.emailTo) return;

    // Only escalate warnings + criticals via email; info-level stays in logs.
    if (alert.level === 'info') return;

    const subject = `[wBOB Bridge ${alert.level.toUpperCase()}] ${alert.type}`;
    const body = [
      `Alert:    ${alert.type}`,
      `Level:    ${alert.level}`,
      `Time:     ${alert.timestamp}`,
      ``,
      alert.message,
      ``,
      `Data:`,
      JSON.stringify(alert.data, null, 2),
      ``,
      `-- `,
      `wBOB Bridge solvency monitor`,
    ].join('\n');

    const mime = [
      `From: ${this.emailFrom}`,
      `To: ${this.emailTo}`,
      `Subject: ${subject}`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      body,
    ].join('\n');

    return new Promise<void>((resolve) => {
      const proc = spawn(SENDMAIL_PATH, ['-t', '-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (chunk) => { stderr += String(chunk); });
      proc.on('error', (err) => {
        console.error('[solvency-monitor] sendmail spawn error:', err);
        resolve();
      });
      proc.on('close', (code) => {
        if (code !== 0) {
          console.error(`[solvency-monitor] sendmail exit ${code}: ${stderr.trim()}`);
        }
        resolve();
      });
      proc.stdin.write(mime);
      proc.stdin.end();
    });
  }
}
