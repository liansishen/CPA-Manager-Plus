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

  it('parses Sub2API quota and rate-limit windows with stable labels', () => {
    const windows = buildCustomQuotaAccountWindows(
      {
        data: {
          quota: { used: 20, limit: 100, remaining: 80, unit: 'requests' },
          rate_limits: [{ name: 'five-hour', used_percent: 0.25, reset_after_seconds: 300 }],
          daily: { name: 'daily', used: 40, limit: 50 },
        },
      },
      { kind: 'sub2api', url: 'https://sub2api.example.com' },
      t,
      Date.parse('2026-08-27T12:00:00.000Z')
    );

    expect(windows.map((window) => window.label)).toEqual(['Quota', 'five-hour', 'daily']);
    expect(windows[0]).toMatchObject({ remainingPercent: 80, usageLabel: '20 / 100 requests' });
    expect(windows[1]).toMatchObject({ remainingPercent: 75, resetAccuracy: 'estimated' });
    expect(windows[2]).toMatchObject({ label: 'daily', remainingPercent: 20, usageLabel: '40 / 50' });
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
