import type { TFunction } from 'i18next';
import type { OpenAIProviderConfig } from '@/types';
import type { AccountQuotaWindow } from '@/features/monitoring/components/accountOverviewPresentation';
import type {
  ManagerConfig,
  ManagerCustomQuotaBinding,
} from '@/services/api/usageService';
import { buildSourceInfoMap } from '@/utils/sourceResolver';
import { sha256Hex } from '@/utils/apiKeyHash';
import {
  formatQuotaResetTime,
  resolveAbsoluteQuotaReset,
  resolveRelativeQuotaReset,
} from './formatters';

type CustomQuotaWindowValues = {
  label?: unknown;
  used?: unknown;
  limit?: unknown;
  remaining?: unknown;
  usedPercent?: unknown;
  resetAt?: unknown;
  resetAfterSeconds?: unknown;
  unit?: unknown;
};

export type MonitoringCustomQuotaSource = {
  sourceKey: string;
  bindingKey: string;
  providerName: string;
  displayName: string;
  binding: ManagerCustomQuotaBinding;
  enabled: boolean;
};

const readRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const readString = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  return '';
};

const readNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/,/g, '');
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

const readPercent = (value: unknown): number | null => {
  if (typeof value === 'string' && value.trim().endsWith('%')) {
    const parsed = readNumber(value.trim().slice(0, -1));
    return parsed === null ? null : Math.max(0, Math.min(100, parsed));
  }
  const parsed = readNumber(value);
  if (parsed === null) return null;
  const percent = parsed >= 0 && parsed <= 1 ? parsed * 100 : parsed;
  return Math.max(0, Math.min(100, percent));
};

const readPath = (value: unknown, path: string): unknown => {
  const normalizedPath = path.trim();
  if (!normalizedPath || normalizedPath === '$') return value;

  const segments = normalizedPath
    .replace(/^\$\.?/, '')
    .replace(/\[\s*(['"]?)([^'"\]]+)\1\s*\]/g, '.$2')
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);
  let current: unknown = value;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0) return undefined;
      current = current[index];
    } else {
      const record = readRecord(current);
      if (!record || !(segment in record)) return undefined;
      current = record[segment];
    }
  }
  return current;
};

const readFirstPath = (value: unknown, paths: string[]): unknown => {
  for (const path of paths) {
    const result = readPath(value, path);
    if (result !== undefined && result !== null) return result;
  }
  return undefined;
};

const toWindowItems = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  const record = readRecord(value);
  if (!record) return [];
  return Object.entries(record).map(([key, item]) => {
    if (readRecord(item)) return { ...(item as Record<string, unknown>), __windowKey: key };
    return { __windowKey: key, value: item };
  });
};

const getField = (
  item: unknown,
  root: unknown,
  mapping: Record<string, string>,
  field: keyof CustomQuotaWindowValues,
  aliases: string[]
): unknown => {
  const mappedPath = mapping[field];
  if (mappedPath?.trim()) {
    const local = readPath(item, mappedPath);
    if (local !== undefined) return local;
    return readPath(root, mappedPath);
  }
  return readFirstPath(item, aliases);
};

const hasWindowValue = (values: CustomQuotaWindowValues) =>
  [values.used, values.limit, values.remaining, values.usedPercent, values.resetAt, values.resetAfterSeconds].some(
    (value) => readNumber(value) !== null || Boolean(readString(value))
  );

const toQuotaWindow = (
  item: unknown,
  root: unknown,
  index: number,
  mapping: Record<string, string>,
  t: TFunction,
  observedAtMs: number
): AccountQuotaWindow | null => {
  const values: CustomQuotaWindowValues = {
    label: getField(item, root, mapping, 'label', ['label', 'name', 'window', 'period', '__windowKey']),
    used: getField(item, root, mapping, 'used', ['used', 'usage', 'used_amount', 'usedAmount']),
    limit: getField(item, root, mapping, 'limit', ['limit', 'quota', 'quota_limit', 'quotaLimit']),
    remaining: getField(item, root, mapping, 'remaining', [
      'remaining',
      'remaining_amount',
      'remainingAmount',
    ]),
    usedPercent: getField(item, root, mapping, 'usedPercent', [
      'used_percent',
      'usedPercent',
      'usage_percent',
      'usagePercent',
    ]),
    resetAt: getField(item, root, mapping, 'resetAt', ['reset_at', 'resetAt', 'expires_at', 'expiresAt']),
    resetAfterSeconds: getField(item, root, mapping, 'resetAfterSeconds', [
      'reset_after_seconds',
      'resetAfterSeconds',
      'reset_in_seconds',
      'resetInSeconds',
    ]),
    unit: getField(item, root, mapping, 'unit', ['unit', 'currency']),
  };
  if (!hasWindowValue(values)) return null;

  const used = readNumber(values.used);
  const limit = readNumber(values.limit);
  const remaining = readNumber(values.remaining);
  const explicitUsedPercent = readPercent(values.usedPercent);
  const usedPercent =
    explicitUsedPercent ??
    (used !== null && limit !== null && limit > 0 ? Math.max(0, Math.min(100, (used / limit) * 100)) : null);
  const remainingPercent =
    usedPercent !== null
      ? Math.max(0, Math.min(100, 100 - usedPercent))
      : remaining !== null && limit !== null && limit > 0
        ? Math.max(0, Math.min(100, (remaining / limit) * 100))
        : remaining !== null && remaining >= 0 && remaining <= 1
          ? remaining * 100
          : null;

  const absoluteReset = resolveAbsoluteQuotaReset(values.resetAt);
  const relativeReset =
    absoluteReset.resetAtMs === null
      ? resolveRelativeQuotaReset(values.resetAfterSeconds, observedAtMs)
      : { resetAtMs: null, resetAccuracy: 'unknown' as const };
  const resetAtMs = absoluteReset.resetAtMs ?? relativeReset.resetAtMs;
  const resetAccuracy =
    absoluteReset.resetAtMs !== null ? absoluteReset.resetAccuracy : relativeReset.resetAccuracy;
  const resetAfterSeconds = readNumber(values.resetAfterSeconds);
  const label = readString(values.label) || t('monitoring.custom_quota_window', {
    defaultValue: `Window ${index + 1}`,
  });
  const unit = readString(values.unit);
  const usageLabel =
    used !== null || limit !== null || remaining !== null
      ? `${used === null ? '--' : used} / ${limit === null ? '--' : limit}${unit ? ` ${unit}` : ''}`
      : null;
  const resetLabel =
    resetAtMs !== null
      ? formatQuotaResetTime(resetAtMs)
      : resetAfterSeconds !== null && resetAfterSeconds > 0
        ? `${Math.round(resetAfterSeconds)}s`
        : '-';
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'window';

  return {
    id: `custom-${slug}-${index}`,
    label,
    remainingPercent,
    resetLabel,
    resetAtMs,
    resetAccuracy,
    usageLabel,
  };
};

const parseCustomGetWindows = (
  body: unknown,
  binding: ManagerCustomQuotaBinding,
  t: TFunction,
  observedAtMs: number
): AccountQuotaWindow[] => {
  const mapping = binding.mapping ?? {};
  const mappedWindows = mapping.windows ? readPath(body, mapping.windows) : undefined;
  const windowsValue =
    mappedWindows ??
    readFirstPath(body, ['windows', 'rate_limits', 'rateLimits', 'quotas', 'quota_windows', 'quotaWindows']);
  const items = windowsValue === undefined ? [body] : toWindowItems(windowsValue);
  return items
    .map((item, index) => toQuotaWindow(item, body, index, mapping, t, observedAtMs))
    .filter((window): window is AccountQuotaWindow => Boolean(window));
};

const readWindowLabel = (value: unknown, fallback: string) =>
  readString(readFirstPath(value, ['label', 'name', 'window', 'period', '__windowKey'])) || fallback;

const parseSub2ApiWindows = (
  body: unknown,
  t: TFunction,
  observedAtMs: number
): AccountQuotaWindow[] => {
  const root = readRecord(body);
  if (!root) return [];
  const data = readRecord(root.data) ?? root;
  const windows: AccountQuotaWindow[] = [];
  const quota = readFirstPath(data, ['quota', 'quota_info', 'quotaInfo']);
  const quotaValue = quota ?? data;
  const quotaWindow = toQuotaWindow(quotaValue, data, 0, {}, t, observedAtMs);
  if (quotaWindow) {
    windows.push({ ...quotaWindow, id: 'sub2api-quota', label: readWindowLabel(quotaValue, 'Quota') });
  }

  const rateLimits = readFirstPath(data, ['rate_limits', 'rateLimits', 'limits']);
  toWindowItems(rateLimits).forEach((item, index) => {
    const window = toQuotaWindow(item, data, index, {}, t, observedAtMs);
    if (window) {
      windows.push({
        ...window,
        id: `sub2api-rate-limit-${index}`,
        label: readWindowLabel(item, `Window ${index + 1}`),
      });
    }
  });

  ['daily', 'weekly', 'monthly', 'five_hour', 'fiveHour'].forEach((key) => {
    const value = data[key];
    if (!readRecord(value)) return;
    const window = toQuotaWindow(value, data, windows.length, {}, t, observedAtMs);
    if (window) windows.push({ ...window, id: `sub2api-${key}`, label: readWindowLabel(value, key) });
  });
  return windows;
};

export const buildCustomQuotaAccountWindows = (
  body: unknown,
  binding: ManagerCustomQuotaBinding,
  t: TFunction,
  observedAtMs = Date.now()
): AccountQuotaWindow[] => {
  const windows = String(binding.kind).trim().toLowerCase() === 'sub2api'
    ? parseSub2ApiWindows(body, t, observedAtMs)
    : parseCustomGetWindows(body, binding, t, observedAtMs);
  if (windows.length === 0) {
    throw new Error(
      t('monitoring.custom_quota_empty_response', {
        defaultValue: 'The quota response did not contain any recognized quota windows.',
      })
    );
  }
  return windows;
};

const findBinding = (
  bindings: Record<string, ManagerCustomQuotaBinding> | undefined,
  providerName: string,
  apiKey: string
): [string, ManagerCustomQuotaBinding] | undefined => {
  if (!bindings) return undefined;
  const bindingKey = buildCustomQuotaBindingKey(providerName, apiKey);
  const direct = bindings[bindingKey];
  if (direct) return [bindingKey, direct];
  const apiKeyHash = sha256Hex(apiKey);
  const fallback = Object.entries(bindings).find(
    ([, binding]) =>
      binding.providerName?.trim() === providerName.trim() && binding.apiKeyHash === apiKeyHash
  );
  return fallback;
};

export const buildCustomQuotaBindingKey = (providerName: string, apiKey: string) => {
  const provider = providerName.trim();
  const key = apiKey.trim();
  return provider && key ? `openai:${sha256Hex(`${provider}\u0000${key}`)}` : '';
};

export const buildMonitoringCustomQuotaSources = (
  providers: OpenAIProviderConfig[],
  managerConfig: ManagerConfig | null
): MonitoringCustomQuotaSource[] => {
  const bindings = managerConfig?.customQuota?.bindings;
  if (!bindings) return [];
  const sourceInfoMap = buildSourceInfoMap({ openaiCompatibility: providers });
  const sources: MonitoringCustomQuotaSource[] = [];
  providers.forEach((provider, providerIndex) => {
    (provider.apiKeyEntries || []).forEach((entry, entryIndex) => {
      const apiKey = entry.apiKey?.trim() ?? '';
      const providerName = provider.name?.trim() ?? '';
      if (!apiKey || !providerName) return;
      const matchedBinding = findBinding(bindings, providerName, apiKey);
      if (!matchedBinding) return;
      const [bindingKey, binding] = matchedBinding;
      if (binding.enabled === false || !binding.url?.trim()) return;
      const sourceKey = `openai:${providerIndex}:${entryIndex}`;
      const sourceInfo = sourceInfoMap.byIdentityKey.get(sourceKey);
      sources.push({
        sourceKey,
        bindingKey,
        providerName,
        displayName: sourceInfo?.displayName || providerName,
        binding,
        enabled: provider.disabled !== true,
      });
    });
  });
  return sources;
};
