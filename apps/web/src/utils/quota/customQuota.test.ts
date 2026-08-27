import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import type { ManagerCustomQuotaBinding } from '@/services/api/usageService';
import { buildCustomQuotaAccountWindows } from './customQuota';

const t = ((key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key) as TFunction;

const buildBinding = (mapping: Record<string, string> = {}): ManagerCustomQuotaBinding => ({
  kind: 'custom_get',
  url: 'https://quota.example.com/usage',
  mapping,
});

describe('buildCustomQuotaAccountWindows', () => {
  it('reads mapped nested windows and derives percentages and relative resets', () => {
    const observedAtMs = Date.parse('2026-08-27T12:00:00.000Z');
    const windows = buildCustomQuotaAccountWindows(
      {
        payload: {
          windows: [
            {
              meta: { label: 'daily' },
              stats: { used: '25', limit: '100', remaining: '75' },
              reset: { seconds: 60 },
              unit: 'requests',
            },
          ],
        },
      },
      buildBinding({
        windows: '$.payload.windows',
        label: 'meta.label',
        used: 'stats.used',
        limit: 'stats.limit',
        remaining: 'stats.remaining',
        resetAfterSeconds: 'reset.seconds',
        unit: 'unit',
      }),
      t,
      observedAtMs
    );

    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      label: 'daily',
      remainingPercent: 75,
      resetAtMs: observedAtMs + 60_000,
      resetAccuracy: 'estimated',
      usageLabel: '25 / 100 requests',
    });
  });

  it('parses only the Sub2API weekly subscription window', () => {
    const windows = buildCustomQuotaAccountWindows(
      {
        data: {
          weekly_usage_usd: 20,
          group: { weekly_limit_usd: 100 },
          rate_limits: [{ name: 'five-hour', used_percent: 0.25, reset_after_seconds: 300 }],
          daily: { name: 'daily', used: 40, limit: 50 },
          monthly: { name: 'monthly', used: 80, limit: 100 },
        },
      },
      { kind: 'sub2api', url: 'https://sub2api.example.com' },
      t,
      Date.parse('2026-08-27T12:00:00.000Z')
    );

    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      id: 'sub2api-weekly',
      label: 'Weekly',
      remainingPercent: 80,
      usageLabel: '20 / 100 USD',
    });
  });

  it('parses a Sub2API subscriptions array envelope', () => {
    const windows = buildCustomQuotaAccountWindows(
      {
        data: [
          {
            status: 'active',
            weekly_usage_usd: 12.5,
            weekly_window_start: '2026-08-25T22:17:49.148799+08:00',
            group: { weekly_limit_usd: 50 },
          },
        ],
      },
      { kind: 'sub2api', url: 'https://sub2api.example.com' },
      t,
      Date.parse('2026-08-27T12:00:00.000Z')
    );

    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      id: 'sub2api-weekly',
      label: 'Weekly',
      resetAtMs: Date.parse('2026-09-01T14:17:49.148Z'),
      remainingPercent: 75,
      usageLabel: '12.5 / 50 USD',
    });
  });

  it('rejects responses without recognized quota windows', () => {
    expect(() =>
      buildCustomQuotaAccountWindows(
        { status: 'ok', message: 'no quota here' },
        buildBinding(),
        t,
        Date.parse('2026-08-27T12:00:00.000Z')
      )
    ).toThrow('The quota response did not contain any recognized quota windows.');
  });
});
