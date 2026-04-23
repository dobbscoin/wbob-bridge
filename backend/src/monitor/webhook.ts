/**
 * Alert dispatcher — sends solvency alerts to a webhook URL and/or stderr.
 */

import type { Alert } from './types.js';

export class AlertDispatcher {
  constructor(private readonly webhookUrl: string | null) {}

  async dispatch(alert: Alert): Promise<void> {
    // Always write to stderr so alerts appear in container logs.
    const prefix = `[solvency-monitor] ${alert.level.toUpperCase()} ${alert.type}`;
    if (alert.level === 'critical' || alert.level === 'warning') {
      console.error(`${prefix}: ${alert.message}`);
    } else {
      console.log(`${prefix}: ${alert.message}`);
    }

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
}
