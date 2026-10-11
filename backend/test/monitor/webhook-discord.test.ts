/**
 * Discord webhooks reject the raw Alert JSON (HTTP 400, no `content`). Every
 * production alert failed that way until the dispatcher learned the shape.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { AlertDispatcher, formatDiscordContent, isDiscordWebhook, webhookBody } from '../../src/monitor/webhook.js';
import type { Alert } from '../../src/monitor/types.js';

const alert: Alert = {
  level: 'info',
  type: 'MINT_CAP_SPLIT',
  timestamp: '2026-10-11T00:00:00.000Z',
  message: 'Deposit of 1,200,000 (BOB) is over today’s wBOB mint cap; refunding 200,000 (BOB) to 1A2it4ZpSr4GPFifF9GEoLfgbmbxVGKCcK.',
  data: {},
};

describe('isDiscordWebhook', () => {
  it.each([
    ['https://discord.com/api/webhooks/1/abc', true],
    ['https://discordapp.com/api/webhooks/1/abc', true],
    ['https://ptb.discord.com/api/webhooks/1/abc', true],
    ['https://example.com/api/webhooks/1/abc', false],
    ['https://discord.com.evil.example/api/webhooks/1', false],
    ['not a url', false],
  ])('%s → %s', (url, want) => {
    expect(isDiscordWebhook(url)).toBe(want);
  });
});

describe('webhookBody', () => {
  it('Discord gets content + no mentions', () => {
    const body = webhookBody('https://discord.com/api/webhooks/1/abc', alert) as { content: string; allowed_mentions: unknown };
    expect(body.content).toContain('MINT_CAP_SPLIT');
    expect(body.content).toContain(alert.message);
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });

  it('other endpoints still get the raw alert', () => {
    expect(webhookBody('https://hooks.example.com/x', alert)).toBe(alert);
  });

  it('long messages are cut to Discord’s 2000-character limit', () => {
    const text = formatDiscordContent({ ...alert, message: 'x'.repeat(5000) });
    expect(text.length).toBe(2000);
  });
});

describe('AlertDispatcher → Discord', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs a Discord-shaped body', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const d = new AlertDispatcher({ webhookUrl: 'https://discord.com/api/webhooks/1/abc' });
    await d.dispatch(alert);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body))).toHaveProperty('content');
  });
});
