import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import { CLINE_PASS_CONFIG } from '@/components/quota';
import type { AuthFileItem, ClinePassQuotaState } from '@/types';
import { parseClinePassQuotaPayload } from '@/utils/quota/clinePassQuota';
import type { MonitoringAccountAuthState } from '@/features/monitoring/accountOverviewState';
import {
  buildMonitoringAccountQuotaTargetsByRowId,
  type MonitoringAccountQuotaTarget,
} from '@/features/monitoring/accountOverviewQuotaTargets';
import type { MonitoringAccountRow } from '@/features/monitoring/hooks/useMonitoringData';
import {
  buildAccountQuotaEntryFromProviderState,
  buildCachedAccountQuotaEntry,
  buildClinePassAccountQuotaWindows,
  getAccountQuotaProviderLabel,
  type MonitoringQuotaStores,
} from './monitoringCenterPageModel';

const NOW_MS = Date.parse('2026-01-01T00:00:00Z');
const NOW_S = Math.floor(NOW_MS / 1000);
const FIVE_HOUR_RESET_S = NOW_S + 2 * 3600;
const WEEKLY_RESET_S = NOW_S + 3 * 24 * 3600;
const MONTHLY_RESET_S = NOW_S + 20 * 24 * 3600;

const t = ((key: string, options?: Record<string, unknown>) => {
  const copy: Record<string, string> = {
    'plans.label': 'Plan',
    'cline_pass_quota.title': 'Cline Pass Quota',
    'cline_pass_quota.empty': 'No Cline Pass quota data',
    'cline_pass_quota.five_hour': '5-hour',
    'cline_pass_quota.weekly': 'Weekly',
    'cline_pass_quota.monthly': 'Monthly',
    'cline_pass_quota.shared_credentials': `Shared with ${options?.count ?? ''}`,
    'claude_quota.title': 'Claude Quota',
    'codex_quota.title': 'Codex Quota',
  };
  return copy[key] ?? key;
}) as unknown as TFunction;

const makeFile = (overrides: Partial<AuthFileItem> = {}): AuthFileItem => ({
  name: 'clinepassbridge-abc.json',
  provider: 'cline-pass',
  authIndex: '1',
  ...overrides,
});

const makeTarget = (
  overrides: Partial<MonitoringAccountQuotaTarget> = {}
): MonitoringAccountQuotaTarget => {
  const file = overrides.file ?? makeFile();
  return {
    key: overrides.key ?? `cline-pass::${file.authIndex}::${file.name}`,
    provider: 'cline-pass',
    authIndex: String(file.authIndex ?? ''),
    authLabel: overrides.authLabel ?? 'Cline Pass',
    fileName: file.name,
    file,
    accountId: null,
    planType: null,
    ...overrides,
  };
};

const emptyStores = (): MonitoringQuotaStores => ({
  antigravityQuota: {},
  claudeQuota: {},
  clinePassQuota: {},
  commandcodeQuota: {},
  codexQuota: {},
  devinQuota: {},
  kimiQuota: {},
  xaiQuota: {},
});

const buildState = (
  file: AuthFileItem,
  payload: unknown,
  checkedAtMs = NOW_MS
): ClinePassQuotaState => {
  const parsed = parseClinePassQuotaPayload(payload, { checkedAtMs });
  if (!parsed) throw new Error('Cline Pass payload did not parse');
  return CLINE_PASS_CONFIG.buildSuccessState(parsed, file);
};

const storesFor = (file: AuthFileItem, state: ClinePassQuotaState): MonitoringQuotaStores => {
  const stores = emptyStores();
  stores.clinePassQuota[CLINE_PASS_CONFIG.getStoreKey!(file)] = state;
  return stores;
};

describe('monitoring cline pass quota entry', () => {
  it('builds success windows with estimate amounts and shared-credential meta', () => {
    const file = makeFile();
    const state = buildState(file, {
      id: 'clinepassbridge-abc',
      status: 'ok',
      updated_at: NOW_S - 60,
      plan: { name: 'pro', current_period_end: MONTHLY_RESET_S },
      shared_credentials: 3,
      limits: [
        { type: 'five_hour', percent_used: 25, resets_at: FIVE_HOUR_RESET_S },
        { type: 'weekly', percent_used: 60, resets_at: WEEKLY_RESET_S },
        { type: 'monthly', percent_used: 90, resets_at: MONTHLY_RESET_S },
      ],
      estimate: {
        windows: [
          {
            type: 'weekly',
            total: { low: 5, high: 5 },
            remaining: { low: 2, high: 2 },
            note: 'from plugin',
          },
        ],
      },
    });

    const entry = buildAccountQuotaEntryFromProviderState(makeTarget({ file }), state, t);
    expect(entry).not.toBeNull();
    expect(entry).toMatchObject({
      key: 'cline-pass::1::clinepassbridge-abc.json',
      provider: 'cline-pass',
      providerLabel: 'Cline Pass Quota',
      planType: 'pro',
      fileName: 'clinepassbridge-abc.json',
      observedAtMs: (NOW_S - 60) * 1000,
      fetchedAtMs: (NOW_S - 60) * 1000,
    });
    expect(entry!.metaLabels).toEqual(['Cline Pass Quota', 'Plan: pro', 'Shared with 3']);
    expect(entry!.windows.map((w) => [w.id, w.label, w.remainingPercent, w.resetAccuracy])).toEqual(
      [
        ['cline-pass:five_hour', '5-hour', 75, 'exact'],
        ['cline-pass:weekly', 'Weekly', 40, 'exact'],
        ['cline-pass:monthly', 'Monthly', 10, 'exact'],
      ]
    );

    const weekly = entry!.windows[1];
    expect(weekly.usageLabel).toBe('Shared with 3');

    expect(buildClinePassAccountQuotaWindows(state.windows, t, state.sharedCredentials)).toEqual(
      entry!.windows
    );
  });

  it('keeps cached windows on a non-ok response with an error', () => {
    const file = makeFile();
    const state = buildState(file, {
      id: 'clinepassbridge-abc',
      status: 'unavailable',
      updated_at: NOW_S - 120,
      checked_at: NOW_S - 30,
      limits: [{ type: 'weekly', percent_used: 40, resets_at: WEEKLY_RESET_S }],
      estimate: {
        windows: [
          {
            type: 'weekly',
            total: { low: 5, high: 5 },
            remaining: { low: 2, high: 2 },
            historical: true,
          },
        ],
      },
    });

    expect(state.status).toBe('error');
    expect(state.error).toBe('unavailable');
    expect(state.windows[0]).toMatchObject({
      remainingPercent: 60,
      estimatedTotalUsd: 5,
      estimatedRemainingUsd: null,
      historical: true,
    });

    const entry = buildAccountQuotaEntryFromProviderState(makeTarget({ file }), state, t)!;
    expect(entry.error).toBe('unavailable');
    expect(entry.failedAtMs).toBe((NOW_S - 30) * 1000);
    expect(entry.windows[0].remainingPercent).toBe(60);
    expect(entry.windows[0].usageLabel).toBeNull();
  });

  it('renders empty and unknown data without inventing windows or remaining percent', () => {
    const file = makeFile();
    const emptyEntry = buildAccountQuotaEntryFromProviderState(
      makeTarget({ file }),
      buildState(file, { id: 'clinepassbridge-abc', status: 'ok', limits: [] }),
      t
    )!;
    expect(emptyEntry.windows).toEqual([]);
    expect(emptyEntry.planType).toBeNull();
    expect(emptyEntry.emptyMessage).toBe('No Cline Pass quota data');
    expect(buildClinePassAccountQuotaWindows([], t)).toEqual([]);

    const unknownEntry = buildAccountQuotaEntryFromProviderState(
      makeTarget({ file }),
      buildState(file, {
        id: 'clinepassbridge-abc',
        status: 'ok',
        limits: [{ type: 'weekly', percent_used: null, resets_at: WEEKLY_RESET_S }],
      }),
      t
    )!;
    expect(unknownEntry.windows[0]).toMatchObject({
      id: 'cline-pass:weekly',
      remainingPercent: null,
      resetAtMs: WEEKLY_RESET_S * 1000,
      resetAccuracy: 'exact',
      usageLabel: null,
    });

    const idleState = {
      ...buildState(file, { id: 'clinepassbridge-abc', status: 'ok', limits: [] }),
      status: 'loading' as const,
    };
    expect(buildAccountQuotaEntryFromProviderState(makeTarget({ file }), idleState, t)).toBeNull();
    expect(buildAccountQuotaEntryFromProviderState(makeTarget({ file }), undefined, t)).toBeNull();
  });

  it('isolates a cached cline-pass state by credential identity', () => {
    const fileA = makeFile({ authIndex: '1' });
    const fileB = makeFile({ authIndex: '2' });
    const state = buildState(fileA, {
      id: 'clinepassbridge-abc',
      status: 'ok',
      limits: [{ type: 'weekly', percent_used: 10, resets_at: WEEKLY_RESET_S }],
    });
    const stores = storesFor(fileA, state);

    const entryA = buildCachedAccountQuotaEntry(makeTarget({ file: fileA }), stores, t);
    expect(entryA).not.toBeNull();
    expect(entryA!.windows[0].remainingPercent).toBe(90);

    expect(buildCachedAccountQuotaEntry(makeTarget({ file: fileB }), stores, t)).toBeNull();
  });

  it('resolves a cline-pass provider target and reads its cached entry', () => {
    const file = makeFile({ label: 'Cline', account: 'account@example.com' });
    const authStateByRowId = new Map<string, MonitoringAccountAuthState>([
      ['account@example.com', { files: [file], enabledState: 'enabled' }],
    ]);
    const row: MonitoringAccountRow = {
      id: 'account@example.com',
      account: 'account@example.com',
      provider: 'cline-pass',
      displayAccount: 'account@example.com',
      accountMasked: 'acc***@example.com',
      authIndices: ['1'],
      authLabels: ['Cline'],
      sourceKeys: [],
      channels: [],
      totalCalls: 0,
      successCalls: 0,
      failureCalls: 0,
      successRate: 1,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      totalCost: 0,
      averageLatencyMs: null,
      lastSeenAt: 0,
      recentPattern: [],
      models: [],
    };

    const targets =
      buildMonitoringAccountQuotaTargetsByRowId([row], authStateByRowId).get(
        'account@example.com'
      ) ?? [];
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      provider: 'cline-pass',
      authIndex: '1',
      fileName: 'clinepassbridge-abc.json',
      authLabel: 'Cline',
    });

    const stores = storesFor(
      file,
      buildState(file, {
        id: 'clinepassbridge-abc',
        status: 'ok',
        limits: [{ type: 'weekly', percent_used: 20, resets_at: WEEKLY_RESET_S }],
      })
    );
    const entry = buildCachedAccountQuotaEntry(targets[0], stores, t);
    expect(entry?.providerLabel).toBe('Cline Pass Quota');
    expect(entry?.windows[0].remainingPercent).toBe(80);
  });

  it('labels the cline-pass provider', () => {
    expect(getAccountQuotaProviderLabel('cline-pass', t)).toBe('Cline Pass Quota');
    expect(getAccountQuotaProviderLabel('codex', t)).toBe('Codex Quota');
  });
});
