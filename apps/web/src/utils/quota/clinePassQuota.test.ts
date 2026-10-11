import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import type { AuthFileItem } from '@/types';
import {
  CLINE_PASS_USAGE_PATH,
  ClinePassQuotaError,
  fetchClinePassQuota,
  parseClinePassQuotaPayload,
} from './clinePassQuota';

vi.mock('@/services/api/client', () => ({
  apiClient: { get: vi.fn() },
  createScopedApiRequestConfig: vi.fn((scope: { apiBase: string; managementKey: string }) => ({
    baseURL: `scoped:${scope.apiBase}`,
    headers: { Authorization: `Bearer ${scope.managementKey}` },
    cpampScopedRequest: true,
  })),
}));

import { apiClient, createScopedApiRequestConfig } from '@/services/api/client';

const getMock = vi.mocked(apiClient.get);
const scopedConfigMock = vi.mocked(createScopedApiRequestConfig);

const t = ((key: string) => `tr:${key}`) as unknown as TFunction;

type CapturedConfig = {
  baseURL?: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
};

const lastConfig = (): CapturedConfig => {
  const call = getMock.mock.calls[getMock.mock.calls.length - 1];
  return (call?.[1] ?? {}) as CapturedConfig;
};

const baseFile = (overrides: Partial<AuthFileItem> = {}): AuthFileItem => ({
  name: 'clinepassbridge-abc.json',
  provider: 'cline-pass',
  ...overrides,
});

/** Verified v0.2.15 bridge response shape. */
const realPayload = {
  id: 'clinepassbridge-aaf123',
  limits: [
    { type: 'five_hour', percent_used: 5, resets_at: '2026-10-11T09:02:14.260701588Z' },
    { type: 'weekly', percent_used: 2, resets_at: '2026-10-18T04:02:14.265343595Z' },
    { type: 'monthly', percent_used: 1, resets_at: '2026-11-10T04:02:14.268382176Z' },
  ],
  plan: { name: 'Cline Pass (Monthly)', current_period_end: '2026-11-11T03:58:36Z' },
  updated_at: '2026-10-11T07:33:09.293116625Z',
  checked_at: '2026-10-11T07:33:09.293118849Z',
  status: 'ok',
  estimate: {
    status: 'estimated',
    note: 'estimate',
    shared_credentials: 2,
    windows: [
      {
        type: 'five_hour',
        total: { low: 20.14, high: 20.14 },
        remaining: { low: 19.13, high: 19.13 },
        preliminary: false,
        historical: false,
        note: 'sample note',
      },
      { type: 'weekly', total: { low: 50, high: 50 }, remaining: { low: 49, high: 49 } },
      {
        type: 'monthly',
        derived_from: 'weekly',
        total: { low: 100, high: 100 },
        remaining: { low: 99, high: 99 },
      },
    ],
  },
};

beforeEach(() => {
  getMock.mockReset();
  scopedConfigMock.mockClear();
});

describe('parseClinePassQuotaPayload', () => {
  it('parses the verified v0.2.15 bridge response', () => {
    const parsed = parseClinePassQuotaPayload(realPayload);

    expect(parsed).not.toBeNull();
    expect(parsed?.providerStatus).toBe('ok');
    expect(parsed?.error).toBeUndefined();
    expect(parsed?.planType).toBe('Cline Pass (Monthly)');
    expect(parsed?.planEndMs).toBe(Date.parse('2026-11-11T03:58:36Z'));
    expect(parsed?.observedAtMs).toBe(Date.parse('2026-10-11T07:33:09.293116625Z'));
    expect(parsed?.checkedAtMs).toBe(Date.parse('2026-10-11T07:33:09.293118849Z'));
    expect(parsed?.sharedCredentials).toBe(2);

    expect(parsed?.windows).toEqual([
      {
        id: 'five_hour',
        usedPercent: 5,
        remainingPercent: 95,
        resetAtMs: Date.parse('2026-10-11T09:02:14.260701588Z'),
        estimatedTotalUsd: 20.14,
        estimatedRemainingUsd: 19.13,
        estimateNote: 'sample note',
        preliminary: false,
        historical: false,
      },
      {
        id: 'weekly',
        usedPercent: 2,
        remainingPercent: 98,
        resetAtMs: Date.parse('2026-10-18T04:02:14.265343595Z'),
        estimatedTotalUsd: 50,
        estimatedRemainingUsd: 49,
        estimateNote: 'estimate',
        preliminary: false,
        historical: false,
      },
      {
        id: 'monthly',
        usedPercent: 1,
        remainingPercent: 99,
        resetAtMs: Date.parse('2026-11-10T04:02:14.268382176Z'),
        estimatedTotalUsd: 100,
        estimatedRemainingUsd: 99,
        estimateNote: 'estimate',
        preliminary: false,
        historical: false,
      },
    ]);
  });

  it('preserves an unknown limit type', () => {
    const parsed = parseClinePassQuotaPayload({
      id: 'clinepassbridge-abc',
      status: 'ok',
      limits: [{ type: 'daily', percent_used: 7, resets_at: '2026-10-11T09:02:14Z' }],
    });

    expect(parsed?.windows).toHaveLength(1);
    expect(parsed?.windows[0].id).toBe('daily');
    expect(parsed?.windows[0].usedPercent).toBe(7);
  });

  it('keeps missing/null/invalid percent null and clamps valid values', () => {
    const parsed = parseClinePassQuotaPayload({
      id: 'clinepassbridge-abc',
      status: 'ok',
      limits: [
        { type: 'five_hour', percent_used: 'NaN', resets_at: 'not-a-date' },
        { type: 'weekly', percent_used: -5 },
        { type: 'monthly', percent_used: 150 },
      ],
    });

    const [fiveHour, weekly, monthly] = parsed?.windows ?? [];
    expect(fiveHour.usedPercent).toBeNull();
    expect(fiveHour.remainingPercent).toBeNull();
    expect(fiveHour.resetAtMs).toBeNull();
    expect(weekly.usedPercent).toBeNull();
    expect(monthly.usedPercent).toBe(100);
    expect(monthly.remainingPercent).toBe(0);
  });

  it('only trusts plugin-supplied point estimates (low === high)', () => {
    const parsed = parseClinePassQuotaPayload({
      id: 'clinepassbridge-abc',
      status: 'ok',
      limits: [{ type: 'weekly', percent_used: 10, resets_at: '2026-10-18T04:02:14Z' }],
      estimate: {
        windows: [
          {
            type: 'weekly',
            total: { low: 10, high: 12 },
            remaining: { low: 1, high: 2 },
          },
        ],
      },
    });

    expect(parsed?.windows[0].estimatedTotalUsd).toBeNull();
    expect(parsed?.windows[0].estimatedRemainingUsd).toBeNull();
  });

  it('suppresses estimated remaining for non-ok status or historical data', () => {
    const parsed = parseClinePassQuotaPayload({
      id: 'clinepassbridge-abc',
      status: 'error',
      error: 'bridge unreachable',
      updated_at: '2026-10-11T07:33:09Z',
      limits: [{ type: 'weekly', percent_used: 40, resets_at: '2026-10-18T04:02:14Z' }],
      estimate: {
        windows: [
          {
            type: 'weekly',
            total: { low: 5, high: 5 },
            remaining: { low: 4, high: 4 },
            historical: true,
          },
        ],
      },
    });

    expect(parsed?.providerStatus).toBe('error');
    expect(parsed?.error).toBe('bridge unreachable');
    expect(parsed?.observedAtMs).toBe(Date.parse('2026-10-11T07:33:09Z'));
    expect(parsed?.windows[0].usedPercent).toBe(40);
    expect(parsed?.windows[0].estimatedTotalUsd).toBe(5);
    expect(parsed?.windows[0].estimatedRemainingUsd).toBeNull();
    expect(parsed?.windows[0].historical).toBe(true);
  });

  it('uses the root error string on non-ok and falls back to status', () => {
    const withError = parseClinePassQuotaPayload({
      id: 'clinepassbridge-abc',
      status: 'unavailable',
      error: 'token expired',
      limits: [],
    });
    expect(withError?.error).toBe('token expired');

    const withoutError = parseClinePassQuotaPayload({ id: 'clinepassbridge-abc', status: 'error' });
    expect(withoutError).not.toBeNull();
    expect(withoutError?.error).toBe('error');
    expect(withoutError?.windows).toEqual([]);
    expect(withoutError?.observedAtMs).toBeNull();
  });

  it('rejects malformed payloads missing id or limits', () => {
    expect(parseClinePassQuotaPayload(null)).toBeNull();
    expect(parseClinePassQuotaPayload(undefined)).toBeNull();
    expect(parseClinePassQuotaPayload('not json')).toBeNull();
    expect(parseClinePassQuotaPayload({ status: 'ok', limits: [] })).toBeNull();
    expect(parseClinePassQuotaPayload({ id: 'clinepassbridge-abc', status: 'ok' })).toBeNull();
  });

  it('rejects a response id that does not match the requested id', () => {
    expect(
      parseClinePassQuotaPayload(realPayload, { requestedId: 'clinepassbridge-other' })
    ).toBeNull();
  });
});

describe('fetchClinePassQuota', () => {
  it('requests the bridge path with scoped config and the file-derived id', async () => {
    getMock.mockResolvedValue({ ...realPayload, id: 'clinepassbridge-abc' });

    await fetchClinePassQuota(baseFile({ authIndex: '999' }), t, {
      apiBase: 'https://mgmt.example',
      managementKey: 'key-123',
    });

    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getMock.mock.calls[0][0]).toBe(CLINE_PASS_USAGE_PATH);
    expect(scopedConfigMock).toHaveBeenCalledWith({
      apiBase: 'https://mgmt.example',
      managementKey: 'key-123',
    });

    const config = lastConfig();
    expect(config.baseURL).toBe('scoped:https://mgmt.example');
    expect(config.headers?.Authorization).toBe('Bearer key-123');
    // Identity comes from the file name, never from authIndex.
    expect(config.params).toEqual({ id: 'clinepassbridge-abc' });
  });

  it('omits scoped config when no request scope is provided', async () => {
    getMock.mockResolvedValue({ ...realPayload, id: 'clinepassbridge-abc' });

    await fetchClinePassQuota(baseFile(), t);

    expect(scopedConfigMock).not.toHaveBeenCalled();
    const config = lastConfig();
    expect(config.baseURL).toBeUndefined();
    expect(config.params).toEqual({ id: 'clinepassbridge-abc' });
  });

  it('accepts an explicit, consistent bridge id when the file name is not standard', async () => {
    getMock.mockResolvedValue({ ...realPayload, id: 'clinepassbridge-xyz' });

    await fetchClinePassQuota(baseFile({ name: 'unrelated.json', id: 'clinepassbridge-xyz' }), t);

    expect(lastConfig().params).toEqual({ id: 'clinepassbridge-xyz' });
  });

  it('rejects an arbitrary file name without an explicit bridge id', async () => {
    await expect(fetchClinePassQuota(baseFile({ name: 'random.json' }), t)).rejects.toBeInstanceOf(
      ClinePassQuotaError
    );
    expect(getMock).not.toHaveBeenCalled();
  });

  it('rejects when the response id does not match the requested id', async () => {
    getMock.mockResolvedValue({ ...realPayload, id: 'clinepassbridge-other' });

    await expect(fetchClinePassQuota(baseFile(), t)).rejects.toBeInstanceOf(ClinePassQuotaError);
  });

  it('does not issue a GET for a disabled credential', async () => {
    await expect(fetchClinePassQuota(baseFile({ disabled: true }), t)).rejects.toBeInstanceOf(
      ClinePassQuotaError
    );
    expect(getMock).not.toHaveBeenCalled();
  });

  it('surfaces the upstream status on request failure', async () => {
    getMock.mockRejectedValue({ status: 503 });
    await expect(fetchClinePassQuota(baseFile(), t)).rejects.toMatchObject({ status: 503 });
  });
});
