import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import type { AuthFileItem, ClinePassQuotaState } from '@/types';
import { CLINE_PASS_CONFIG } from '@/components/quota';
import { getScopedQuotaState } from '@/components/quota/quotaConfigs';
import { parseClinePassQuotaPayload } from '@/utils/quota/clinePassQuota';
import { buildAccountRows, resolveAccountQuota, type AccountQuotaStores } from './accountRows';
import {
  buildAccountQuotaDisplayWindows,
  type TranslateQuotaWindowLabel,
} from './accountQuotaDisplayWindows';
import { buildAccountQuotaWindowDefinitions } from './accountQuotaWindowDefinitions';
import {
  buildAccountQuotaSnapshotQueryAccounts,
  buildAccountQuotaSnapshotWriteEntries,
} from './accountQuotaSnapshots';

const NOW_MS = Date.parse('2026-01-01T00:00:00Z');
const NOW_S = Math.floor(NOW_MS / 1000);
const FIVE_HOUR_RESET_S = NOW_S + 2 * 3600;
const WEEKLY_RESET_S = NOW_S + 3 * 24 * 3600;
const MONTHLY_RESET_S = NOW_S + 20 * 24 * 3600;

const emptyStores = (): AccountQuotaStores => ({
  antigravityQuota: {},
  claudeQuota: {},
  clinePassQuota: {},
  codexQuota: {},
  devinQuota: {},
  kimiQuota: {},
  metaQuota: {},
  xaiQuota: {},
});

const t = ((key: string, options?: Record<string, unknown>) => {
  const translations: Record<string, string> = {
    'cline_pass_quota.five_hour': '5-hour',
    'cline_pass_quota.weekly': 'Weekly',
    'cline_pass_quota.monthly': 'Monthly',
    'cline_pass_quota.shared_credentials': `Shared with ${options?.count ?? ''}`,
    'accounts.col_quota': 'Quota',
  };
  return translations[key] ?? key;
}) as unknown as TFunction;

const translateQuotaWindowLabel: TranslateQuotaWindowLabel = (label, labelKey, labelParams) =>
  labelKey ? t(labelKey, labelParams) : (label ?? 'Quota');

const makeFile = (overrides: Partial<AuthFileItem> = {}): AuthFileItem => ({
  name: 'clinepassbridge-abc.json',
  provider: 'cline-pass',
  ...overrides,
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

const storesFor = (file: AuthFileItem, state: ClinePassQuotaState): AccountQuotaStores => {
  const stores = emptyStores();
  stores.clinePassQuota[CLINE_PASS_CONFIG.getStoreKey!(file)] = state;
  return stores;
};

const buildRow = (file: AuthFileItem, payload: unknown) => {
  const state = buildState(file, payload);
  const stores = storesFor(file, state);
  return { row: buildAccountRows([file], stores)[0], stores, state };
};

const buildDisplayWindows = (
  row: ReturnType<typeof buildAccountRows>[number],
  stores: AccountQuotaStores
) =>
  buildAccountQuotaDisplayWindows(row, {
    stores,
    translateQuotaWindowLabel,
    t,
    nowMs: NOW_MS,
  });

describe('cline pass account quota', () => {
  it('renders official five-hour, weekly, and monthly windows and summarizes the limiting window', () => {
    const file = makeFile();
    const { row, stores } = buildRow(file, {
      id: 'clinepassbridge-abc',
      status: 'ok',
      updated_at: NOW_S - 60,
      plan: { name: 'pro', current_period_end: MONTHLY_RESET_S },
      limits: [
        { type: 'five_hour', percent_used: 25, resets_at: FIVE_HOUR_RESET_S },
        { type: 'weekly', percent_used: 60, resets_at: WEEKLY_RESET_S },
        { type: 'monthly', percent_used: 90, resets_at: MONTHLY_RESET_S },
      ],
    });

    const windows = buildDisplayWindows(row, stores);
    expect(windows.map((w) => [w.key, w.kind, w.label, w.remainingPercent, w.usedPercent])).toEqual(
      [
        ['cline-pass:five_hour', 'five_hour', '5-hour', 75, 25],
        ['cline-pass:weekly', 'weekly', 'Weekly', 40, 60],
        ['cline-pass:monthly', 'monthly', 'Monthly', 10, 90],
      ]
    );
    expect(windows.every((w) => w.source === 'cline-pass')).toBe(true);
    expect(windows.map((w) => w.windowMode)).toEqual(['fixed', 'fixed', 'fixed']);
    expect(windows[0]).toMatchObject({
      limitWindowSeconds: 5 * 3600,
      cycleStartMs: (FIVE_HOUR_RESET_S - 5 * 3600) * 1000,
      cycleEndMs: FIVE_HOUR_RESET_S * 1000,
    });
    expect(windows[1]).toMatchObject({
      limitWindowSeconds: 7 * 86400,
      cycleStartMs: (WEEKLY_RESET_S - 7 * 86400) * 1000,
    });
    expect(windows[2]).toMatchObject({
      limitWindowSeconds: 30 * 86400,
      cycleStartMs: (MONTHLY_RESET_S - 30 * 86400) * 1000,
    });

    expect(resolveAccountQuota(file, stores)).toMatchObject({
      status: 'low',
      remainingPercent: 10,
      usedPercent: 90,
      planType: 'pro',
      resetAtMs: MONTHLY_RESET_S * 1000,
      resetAccuracy: 'exact',
      source: 'cache',
    });
  });

  it('keeps an unknown percent null instead of implying 100% remaining', () => {
    const file = makeFile();
    const payload = {
      id: 'clinepassbridge-abc',
      status: 'ok',
      limits: [{ type: 'weekly', percent_used: null, resets_at: WEEKLY_RESET_S }],
    };

    const parsed = parseClinePassQuotaPayload(payload, { checkedAtMs: NOW_MS });
    expect(parsed?.windows[0]).toMatchObject({ usedPercent: null, remainingPercent: null });

    const { row, stores } = buildRow(file, payload);
    const windows = buildDisplayWindows(row, stores);
    expect(windows[0]).toMatchObject({ remainingPercent: null, usedPercent: null });
    expect(windows[0].remainingPercent).not.toBe(100);

    expect(resolveAccountQuota(file, stores)).toMatchObject({
      status: 'unknown',
      remainingPercent: null,
      usedPercent: null,
    });
  });

  it('preserves error and cached windows without plugin dollar estimates', () => {
    const file = makeFile();
    const { row, stores, state } = buildRow(file, {
      id: 'clinepassbridge-abc',
      status: 'unavailable',
      updated_at: NOW_S - 120,
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
      usedPercent: 40,
      remainingPercent: 60,
      estimatedTotalUsd: 5,
      estimatedRemainingUsd: null,
      historical: true,
    });

    expect(resolveAccountQuota(file, stores)).toMatchObject({
      status: 'error',
      error: 'unavailable',
      remainingPercent: 60,
      usedPercent: 40,
    });

    const windows = buildDisplayWindows(row, stores);
    expect(windows[0].remainingPercent).toBe(60);
    expect(windows[0].amountLabel).toBeUndefined();
    expect(windows[0].description).toBeUndefined();
  });

  it('appends the shared-credential label only when more than one credential shares the window', () => {
    const file = makeFile();
    const shared = buildRow(file, {
      id: 'clinepassbridge-abc',
      status: 'ok',
      shared_credentials: 3,
      limits: [{ type: 'weekly', percent_used: 10, resets_at: WEEKLY_RESET_S }],
    });
    const sharedWindows = buildDisplayWindows(shared.row, shared.stores);
    expect(sharedWindows[0].description).toContain('Shared with 3');

    const single = buildRow(file, {
      id: 'clinepassbridge-abc',
      status: 'ok',
      shared_credentials: 1,
      limits: [{ type: 'weekly', percent_used: 10, resets_at: WEEKLY_RESET_S }],
    });
    const singleWindows = buildDisplayWindows(single.row, single.stores);
    expect(singleWindows[0].description).toBeUndefined();
  });

  it('derives the monthly window start from a 30 day cycle', () => {
    const file = makeFile();
    const { row, stores } = buildRow(file, {
      id: 'clinepassbridge-abc',
      status: 'ok',
      limits: [{ type: 'monthly', percent_used: 10, resets_at: MONTHLY_RESET_S }],
    });

    const windows = buildDisplayWindows(row, stores);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      key: 'cline-pass:monthly',
      kind: 'monthly',
      windowMode: 'fixed',
      limitWindowSeconds: 30 * 86400,
      resetAtMs: MONTHLY_RESET_S * 1000,
      resetAccuracy: 'exact',
      cycleStartMs: (MONTHLY_RESET_S - 30 * 86400) * 1000,
      cycleEndMs: MONTHLY_RESET_S * 1000,
    });
    expect(windows[0].resetLabel).not.toBe('-');
  });

  it('does not leak a scoped state across a replaced credential identity', () => {
    const fileA = makeFile({ authIndex: '1' });
    const fileB = makeFile({ authIndex: '2' });
    const state = buildState(fileA, {
      id: 'clinepassbridge-abc',
      status: 'ok',
      limits: [{ type: 'weekly', percent_used: 10, resets_at: WEEKLY_RESET_S }],
    });

    expect(state.authFileKey).toBe('clinepassbridge-abc.json::1');
    expect(CLINE_PASS_CONFIG.scopeState!(fileA, state)).toBe(state);
    expect(CLINE_PASS_CONFIG.scopeState!(fileB, state)).toBeUndefined();

    const stores = storesFor(fileA, state);
    expect(getScopedQuotaState(CLINE_PASS_CONFIG, stores.clinePassQuota, fileB)).toBeUndefined();
    expect(resolveAccountQuota(fileA, stores)).toMatchObject({
      status: 'ok',
      remainingPercent: 90,
    });
    expect(resolveAccountQuota(fileB, stores)).toMatchObject({
      status: 'unknown',
      remainingPercent: null,
    });
  });

  it('includes cline-pass accounts in snapshot queries and skips partial inventories without windows', () => {
    const file = makeFile();
    const { row, stores } = buildRow(file, {
      id: 'clinepassbridge-abc',
      status: 'ok',
      updated_at: NOW_S - 30,
      limits: [
        { type: 'five_hour', percent_used: 25, resets_at: FIVE_HOUR_RESET_S },
        { type: 'weekly', percent_used: 50, resets_at: WEEKLY_RESET_S },
      ],
    });

    const queryAccounts = buildAccountQuotaSnapshotQueryAccounts([row]);
    expect(queryAccounts).toHaveLength(1);
    expect(queryAccounts[0]).toMatchObject({
      provider: 'cline-pass',
      account: { auth_provider_snapshot: 'cline-pass', auth_file_snapshot: file.name },
    });

    const definitions = buildAccountQuotaWindowDefinitions(
      buildDisplayWindows(row, stores),
      NOW_MS
    );
    const observation = {
      source: 'api_query' as const,
      source_observation_id: 'cline-pass-obs-1',
      observed_at_ms: NOW_MS,
      inventory_scope_key: 'cline-pass:quota-windows',
      inventory_mode: 'complete' as const,
    };
    const entries = buildAccountQuotaSnapshotWriteEntries(
      [row],
      new Map([[row.selectionKey, definitions]]),
      { nowMs: NOW_MS, getObservation: () => observation }
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].windows.map((window) => window.provider_window_id)).toEqual([
      'cline-pass:five_hour',
      'cline-pass:weekly',
    ]);
    expect(entries[0].windows.every((window) => window.source === 'api_query')).toBe(true);

    const partialWithoutWindows = buildAccountQuotaSnapshotWriteEntries(
      [row],
      new Map([[row.selectionKey, []]]),
      {
        nowMs: NOW_MS,
        getObservation: () => ({ ...observation, inventory_mode: 'partial' as const }),
      }
    );
    expect(partialWithoutWindows).toEqual([]);
  });
});
