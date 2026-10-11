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

/*
 * SENDER: must be a domain this host is allowed to send as.
 *
 * This was bridge-alerts@bridge.subgenius.finance until 2026-09-12. That is a
 * non-sending domain -- SPF -all and DMARC p=reject -- so Gmail refused every
 * alert with 550-5.7.26, and because local sendmail accepts and exits 0 the
 * monitor logged nothing and believed it had delivered. Ten alerts were lost
 * between 2026-08-29 and 2026-09-11, including six consecutive hourly ones.
 *
 * subgenius.vip lists this host in SPF (ip4:159.198.79.74) and its DMARC is
 * p=none, so mail from here authenticates. Do not point this back at a
 * subgenius.finance address to make it look tidier -- that is the bug.
 */
const SENDMAIL_PATH = '/usr/sbin/sendmail';

/**
 * True for a Discord incoming-webhook URL. Discord rejects a payload with no
 * `content`/`embeds` (HTTP 400 "Cannot send an empty message"), which is what
 * the raw Alert JSON is: every alert to the production webhook failed that way
 * until 2026-10-11 (journal: "webhook delivery failed HTTP 400").
 */
export function isDiscordWebhook(url: string): boolean {
  try {
    const u = new URL(url);
    return /(^|\.)discord(app)?\.com$/.test(u.hostname) && u.pathname.startsWith('/api/webhooks/');
  } catch {
    return false;
  }
}

const DISCORD_LIMIT = 2000;
const LEVEL_MARK: Record<Alert['level'], string> = {
  critical: '🚨',
  warning:  '⚠️',
  info:     'ℹ️',
};

/** Discord message text for an alert: one line of type, then the message. */
export function formatDiscordContent(alert: Alert): string {
  const text = `${LEVEL_MARK[alert.level]} **wBOB bridge — ${alert.type}**\n${alert.message}`;
  return text.length > DISCORD_LIMIT ? `${text.slice(0, DISCORD_LIMIT - 1)}…` : text;
}

/** The POST body for a webhook URL: Discord-shaped for Discord, raw Alert JSON otherwise. */
export function webhookBody(url: string, alert: Alert): unknown {
  if (!isDiscordWebhook(url)) return alert;
  // allowed_mentions: none — an alert must never ping @everyone or a role by accident.
  return { content: formatDiscordContent(alert), allowed_mentions: { parse: [] } };
}

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
      this.emailFrom = 'bridge-alerts@subgenius.vip';
    } else {
      this.webhookUrl = options.webhookUrl ?? null;
      this.emailTo = options.emailTo ?? null;
      this.emailFrom = options.emailFrom ?? 'bridge-alerts@subgenius.vip';
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
        body: JSON.stringify(webhookBody(this.webhookUrl, alert)),
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
