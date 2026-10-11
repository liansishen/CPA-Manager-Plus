/**
 * Parser and request handling for the Cline Pass bridge credential usage API.
 *
 * The bridge is addressed by credential file identity, never by authIndex.
 */

import type { TFunction } from 'i18next';
import type { AuthFileItem, ClinePassQuotaData, ClinePassQuotaWindow } from '@/types';
import type { ApiClientRequestScope } from '@/services/api/client';
import { apiClient, createScopedApiRequestConfig } from '@/services/api/client';
import { isDisabledAuthFile } from './validators';

export const CLINE_PASS_USAGE_PATH = '/clinepassbridge/credentials/usage';

export type ClinePassQuotaErrorCode =
  | 'missing_identity'
  | 'disabled'
  | 'request_failed'
  | 'invalid_response';

export class ClinePassQuotaError extends Error {
  readonly status?: number;

  constructor(code: ClinePassQuotaErrorCode, status?: number, message?: string) {
    super(message ?? code);
    this.name = 'ClinePassQuotaError';
    this.status = status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface ParseClinePassQuotaOptions {
  requestedId?: string;
  checkedAtMs?: number;
}

const BRIDGE_FILE_PATTERN = /^clinepassbridge-[A-Za-z0-9_-]+\.json$/;
const BRIDGE_ID_PATTERN = /^clinepassbridge-[A-Za-z0-9_-]+$/;

const stripJson = (value: string): string => value.trim().replace(/\.json$/i, '');

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const readString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const readNonNegativeNumber = (value: unknown): number | null => {
  let num: number;
  if (typeof value === 'number') {
    num = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || !/^\d+(\.\d+)?$/.test(trimmed)) return null;
    num = Number(trimmed);
  } else {
    return null;
  }
  return Number.isFinite(num) && num >= 0 ? num : null;
};

/** Missing/null/invalid percent stays null; valid values are >= 0 and clamped to 100. */
const normalizePercent = (value: unknown): number | null => {
  let num: number;
  if (typeof value === 'number') {
    num = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || !/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
    num = Number(trimmed);
  } else {
    return null;
  }
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.min(100, num);
};

/** Accepts ISO timestamps or epoch seconds/milliseconds; non-positive values are rejected. */
const normalizeTimestampMs = (value: unknown): number | null => {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value > 1e11 ? value : value * 1000;
  }
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (!Number.isFinite(num) || num <= 0) return null;
    return num > 1e11 ? num : num * 1000;
  }

  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
};

const normalizeCount = (value: unknown): number | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const num = Number(trimmed);
    return Number.isFinite(num) && num >= 0 ? num : null;
  }
  return null;
};

/** Only a plugin-supplied point amount (`low === high`, finite, non-negative) is trusted. */
const readPointUsd = (value: unknown): number | null => {
  const record = asRecord(value);
  if (!record) return null;
  const low = readNonNegativeNumber(record.low);
  const high = readNonNegativeNumber(record.high);
  return low !== null && high !== null && low === high ? low : null;
};

interface EstimateWindow {
  totalUsd: number | null;
  remainingUsd: number | null;
  note: string | null;
  preliminary: boolean;
  historical: boolean;
}

const parseEstimateWindow = (value: unknown): EstimateWindow | null => {
  const record = asRecord(value);
  if (!record) return null;

  return {
    totalUsd: readPointUsd(record.total),
    remainingUsd: readPointUsd(record.remaining),
    note: readString(record.note),
    preliminary: record.preliminary === true,
    historical: record.historical === true,
  };
};

/**
 * Strict parser for Cline Pass bridge usage payloads. Returns `null` for malformed
 * input (non-object, bad JSON, missing id, missing limits on a success response).
 * Non-ok statuses still surface data, using the root error string and preserving any
 * cached windows and `updated_at`.
 */
export function parseClinePassQuotaPayload(
  payload: unknown,
  options: ParseClinePassQuotaOptions = {}
): ClinePassQuotaData | null {
  let body = payload;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return null;
    }
  }

  const root = asRecord(body);
  if (!root) return null;

  const rawId = readString(root.id);
  if (!rawId) return null;
  if (options.requestedId && stripJson(rawId) !== stripJson(options.requestedId)) return null;

  const providerStatus = readString(root.status) ?? 'ok';
  const ok = providerStatus.toLowerCase() === 'ok';

  const limits = Array.isArray(root.limits) ? root.limits : null;
  if (ok && !limits) return null;

  const estimate = asRecord(root.estimate);
  const estimateNote = readString(estimate?.note);
  const estimateWindows = new Map<string, EstimateWindow>();
  if (estimate && Array.isArray(estimate.windows)) {
    for (const entry of estimate.windows) {
      const type = readString(asRecord(entry)?.type);
      if (!type) continue;
      const parsed = parseEstimateWindow(entry);
      if (parsed) estimateWindows.set(type, parsed);
    }
  }

  const plan = asRecord(root.plan);
  const windows: ClinePassQuotaWindow[] = [];
  if (limits) {
    for (const entry of limits) {
      const record = asRecord(entry);
      const type = readString(record?.type);
      if (!record || !type) continue;

      const usedPercent = normalizePercent(record.percent_used);
      const remainingPercent =
        usedPercent === null ? null : Math.max(0, Math.min(100, 100 - usedPercent));
      const estimateWindow = estimateWindows.get(type);
      const historical = estimateWindow?.historical ?? false;
      // Estimated remaining is plugin-supplied only; suppress it for non-ok or stale data.
      const estimatedRemainingUsd =
        ok && !historical ? (estimateWindow?.remainingUsd ?? null) : null;

      windows.push({
        id: type,
        usedPercent,
        remainingPercent,
        resetAtMs: normalizeTimestampMs(record.resets_at),
        estimatedTotalUsd: estimateWindow?.totalUsd ?? null,
        estimatedRemainingUsd,
        estimateNote: estimateWindow?.note ?? estimateNote ?? null,
        preliminary: estimateWindow?.preliminary ?? false,
        historical,
      });
    }
  }

  return {
    windows,
    planType: readString(plan?.name),
    planEndMs: normalizeTimestampMs(plan?.current_period_end),
    observedAtMs: normalizeTimestampMs(root.updated_at),
    checkedAtMs: normalizeTimestampMs(root.checked_at) ?? options.checkedAtMs ?? Date.now(),
    sharedCredentials: normalizeCount(estimate?.shared_credentials ?? root.shared_credentials),
    providerStatus,
    ...(ok ? {} : { error: readString(root.error) ?? providerStatus }),
  };
}

const readErrorStatus = (error: unknown): number | undefined => {
  if (
    error !== null &&
    typeof error === 'object' &&
    typeof (error as { status?: unknown }).status === 'number'
  ) {
    return (error as { status: number }).status;
  }
  return undefined;
};

/** Resolve the bridge id from a standard file name or an explicit, consistent bridge id. */
const resolveRequestedId = (file: AuthFileItem): string | null => {
  const name = typeof file.name === 'string' ? file.name.trim() : '';
  if (BRIDGE_FILE_PATTERN.test(name)) return stripJson(name);

  const explicitId = typeof file.id === 'string' ? file.id.trim() : '';
  if (BRIDGE_ID_PATTERN.test(explicitId)) return explicitId;
  return null;
};

export const fetchClinePassQuota = async (
  file: AuthFileItem,
  t: TFunction,
  requestScope?: ApiClientRequestScope
): Promise<ClinePassQuotaData> => {
  const resolveMsg = (code: string, fallback: string): string => {
    if (!t) return fallback;
    const key = `cline_pass_quota.${code}`;
    const translated = t(key);
    return translated && translated !== key ? translated : fallback;
  };

  const requestedId = resolveRequestedId(file);
  if (!requestedId) {
    throw new ClinePassQuotaError(
      'missing_identity',
      undefined,
      resolveMsg('missing_identity', 'Missing Cline Pass credential identity.')
    );
  }

  if (isDisabledAuthFile(file)) {
    throw new ClinePassQuotaError(
      'disabled',
      undefined,
      resolveMsg('disabled', 'Cline Pass credential is disabled.')
    );
  }

  const config = {
    ...(requestScope ? createScopedApiRequestConfig(requestScope) : {}),
    params: { id: requestedId },
  };

  let payload: unknown;
  try {
    payload = await apiClient.get(CLINE_PASS_USAGE_PATH, config);
  } catch (error) {
    throw new ClinePassQuotaError(
      'request_failed',
      readErrorStatus(error),
      resolveMsg('request_failed', 'Cline Pass usage request failed.')
    );
  }

  const data = parseClinePassQuotaPayload(payload, { requestedId });
  if (!data) {
    throw new ClinePassQuotaError(
      'invalid_response',
      undefined,
      resolveMsg('invalid_response', 'Cline Pass usage response was invalid.')
    );
  }

  return data;
};
