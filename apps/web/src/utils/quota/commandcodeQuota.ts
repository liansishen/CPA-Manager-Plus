/**
 * Parser and request handling for the CommandCode plugin credential usage API.
 *
 * The plugin is addressed by credential file identity, never by authIndex.
 */

import type { TFunction } from 'i18next';
import type {
  AuthFileItem,
  CommandCodeQuotaCredits,
  CommandCodeQuotaData,
  CommandCodeQuotaWindow,
} from '@/types';
import type { ApiClientRequestScope } from '@/services/api/client';
import { apiClient, createScopedApiRequestConfig } from '@/services/api/client';
import { isDisabledAuthFile } from './validators';

export const COMMANDCODE_USAGE_PATH = '/commandcode/credentials/usage';

export type CommandCodeQuotaErrorCode =
  | 'missing_identity'
  | 'disabled'
  | 'request_failed'
  | 'invalid_response';

export class CommandCodeQuotaError extends Error {
  readonly status?: number;

  constructor(code: CommandCodeQuotaErrorCode, status?: number, message?: string) {
    super(message ?? code);
    this.name = 'CommandCodeQuotaError';
    this.status = status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface ParseCommandCodeQuotaOptions {
  requestedId?: string;
  checkedAtMs?: number;
}

const COMMANDCODE_FILE_PATTERN = /^commandcode-[A-Za-z0-9_-]+\.json$/;
const COMMANDCODE_ID_PATTERN = /^commandcode-[A-Za-z0-9_-]+$/;

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

export const emptyCommandCodeCredits = (): CommandCodeQuotaCredits => ({
  monthly: null,
  purchased: null,
  free: null,
  used: null,
  remaining: null,
  total: null,
});

const parseCredits = (value: unknown): CommandCodeQuotaCredits => {
  const record = asRecord(value);
  if (!record) return emptyCommandCodeCredits();
  return {
    monthly: readNonNegativeNumber(record.monthly),
    purchased: readNonNegativeNumber(record.purchased),
    free: readNonNegativeNumber(record.free),
    used: readNonNegativeNumber(record.used),
    remaining: readNonNegativeNumber(record.remaining),
    total: readNonNegativeNumber(record.total),
  };
};

/**
 * Strict parser for CommandCode plugin usage payloads. Returns `null` for malformed
 * input (non-object, bad JSON, missing id, missing limits on a success response).
 * Non-ok statuses still surface data, using the root error string and preserving any
 * cached windows and `updated_at`.
 */
export function parseCommandCodeQuotaPayload(
  payload: unknown,
  options: ParseCommandCodeQuotaOptions = {}
): CommandCodeQuotaData | null {
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

  const plan = asRecord(root.plan);
  const windows: CommandCodeQuotaWindow[] = [];
  if (limits) {
    for (const entry of limits) {
      const record = asRecord(entry);
      const type = readString(record?.type);
      if (!record || !type) continue;

      const usedPercent = normalizePercent(record.percent_used);
      const remainingPercent =
        usedPercent === null ? null : Math.max(0, Math.min(100, 100 - usedPercent));

      windows.push({
        id: type,
        usedPercent,
        remainingPercent,
        resetAtMs: normalizeTimestampMs(record.resets_at),
      });
    }
  }

  return {
    windows,
    planType: readString(plan?.name),
    planEndMs: normalizeTimestampMs(plan?.current_period_end),
    observedAtMs: normalizeTimestampMs(root.updated_at),
    checkedAtMs: normalizeTimestampMs(root.checked_at) ?? options.checkedAtMs ?? Date.now(),
    credits: parseCredits(root.credits),
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

/** Resolve the plugin id from a standard file name or an explicit, consistent id. */
const resolveRequestedId = (file: AuthFileItem): string | null => {
  const name = typeof file.name === 'string' ? file.name.trim() : '';
  if (COMMANDCODE_FILE_PATTERN.test(name)) return stripJson(name);

  const explicitId = typeof file.id === 'string' ? file.id.trim() : '';
  if (COMMANDCODE_ID_PATTERN.test(explicitId)) return explicitId;
  return null;
};

export const fetchCommandCodeQuota = async (
  file: AuthFileItem,
  t: TFunction,
  requestScope?: ApiClientRequestScope
): Promise<CommandCodeQuotaData> => {
  const resolveMsg = (code: string, fallback: string): string => {
    if (!t) return fallback;
    const key = `commandcode_quota.${code}`;
    const translated = t(key);
    return translated && translated !== key ? translated : fallback;
  };

  const requestedId = resolveRequestedId(file);
  if (!requestedId) {
    throw new CommandCodeQuotaError(
      'missing_identity',
      undefined,
      resolveMsg('missing_identity', 'Missing CommandCode credential identity.')
    );
  }

  if (isDisabledAuthFile(file)) {
    throw new CommandCodeQuotaError(
      'disabled',
      undefined,
      resolveMsg('disabled', 'CommandCode credential is disabled.')
    );
  }

  const config = {
    ...(requestScope ? createScopedApiRequestConfig(requestScope) : {}),
    params: { id: requestedId },
  };

  let payload: unknown;
  try {
    payload = await apiClient.get(COMMANDCODE_USAGE_PATH, config);
  } catch (error) {
    throw new CommandCodeQuotaError(
      'request_failed',
      readErrorStatus(error),
      resolveMsg('request_failed', 'CommandCode usage request failed.')
    );
  }

  const data = parseCommandCodeQuotaPayload(payload, { requestedId });
  if (!data) {
    throw new CommandCodeQuotaError(
      'invalid_response',
      undefined,
      resolveMsg('invalid_response', 'CommandCode usage response was invalid.')
    );
  }

  return data;
};
