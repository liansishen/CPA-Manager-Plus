import type { ManagerConfig, ManagerCustomQuotaBinding } from '@/services/api/usageService';
import { headersToEntries, buildHeaderObject } from '@/utils/headers';
import { sha256Hex } from '@/utils/apiKeyHash';
import type { ProviderQuotaFormState } from '@/components/providers/types';

export type ProviderQuotaKind = 'openai' | 'gemini' | 'interactions' | 'codex' | 'xai' | 'claude' | 'vertex';

export const CUSTOM_QUOTA_MAPPING_FIELDS = [
  ['windows', 'Windows path'],
  ['label', 'Window label path'],
  ['used', 'Used path'],
  ['limit', 'Limit path'],
  ['remaining', 'Remaining path'],
  ['usedPercent', 'Used percent path'],
  ['resetAt', 'Reset timestamp path'],
  ['resetAfterSeconds', 'Reset countdown path'],
  ['unit', 'Unit path'],
] as const;

export const buildEmptyProviderQuota = (): ProviderQuotaFormState => ({
  enabled: false,
  kind: 'custom_get',
  url: '',
  authMode: 'bearer',
  quotaApiKey: '',
  apiKeyHeader: 'Authorization',
  proxyUrl: '',
  headers: [],
  mapping: {},
  hasBinding: false,
});

const normalizeMapping = (mapping: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(mapping)
      .map(([key, value]) => [key.trim(), String(value ?? '').trim()] as const)
      .filter(([key, value]) => key && value)
      .sort(([left], [right]) => left.localeCompare(right))
  );

export const normalizeProviderQuotaForComparison = (quota?: ProviderQuotaFormState) => {
  if (!quota) return null;
  const url = String(quota.url ?? '').trim();
  const quotaApiKey = String(quota.quotaApiKey ?? '').trim();
  const hasValues =
    Boolean(quota.hasBinding) ||
    Boolean(quota.enabled) ||
    Boolean(url) ||
    Boolean(quotaApiKey) ||
    Boolean(quota.quotaApiKeyConfigured) ||
    Boolean(quota.proxyUrl?.trim()) ||
    quota.headers.length > 0 ||
    Object.keys(quota.mapping).length > 0;
  if (!hasValues) return null;
  return {
    enabled: Boolean(quota.enabled),
    kind: quota.kind,
    url,
    authMode: quota.authMode,
    quotaApiKey,
    quotaApiKeyConfigured: Boolean(quota.quotaApiKeyConfigured),
    apiKeyHeader: quota.apiKeyHeader.trim(),
    proxyUrl: quota.proxyUrl.trim(),
    headers: Object.entries(buildHeaderObject(quota.headers))
      .map(([key, value]) => [key.trim(), String(value ?? '').trim()] as const)
      .filter(([key, value]) => key || value)
      .sort(([left], [right]) => left.localeCompare(right)),
    mapping: normalizeMapping(quota.mapping),
  };
};

export const quotaBindingToForm = (binding?: ManagerCustomQuotaBinding): ProviderQuotaFormState => {
  if (!binding) return buildEmptyProviderQuota();
  return {
    enabled: binding.enabled !== false,
    kind: binding.kind === 'sub2api' ? 'sub2api' : 'custom_get',
    url: binding.url ?? '',
    authMode: binding.authMode === 'header' || binding.authMode === 'none' ? binding.authMode : 'bearer',
    quotaApiKey: '',
    quotaApiKeyConfigured: Boolean(binding.quotaApiKeyConfigured),
    apiKeyHeader: binding.apiKeyHeader ?? 'Authorization',
    proxyUrl: binding.proxyUrl ?? '',
    headers: headersToEntries(binding.headers),
    mapping: { ...(binding.mapping ?? {}) },
    hasBinding: true,
  };
};

export const buildProviderQuotaBindingKey = (
  providerKind: ProviderQuotaKind,
  providerName: string,
  apiKey: string
) => {
  const provider = providerName.trim();
  const key = apiKey.trim();
  return provider && key ? `${providerKind}:${sha256Hex(`${provider}\u0000${key}`)}` : '';
};

export const findProviderQuotaBinding = (
  managerConfig: ManagerConfig | null,
  providerKind: ProviderQuotaKind,
  providerName: string,
  apiKey: string
): ManagerCustomQuotaBinding | undefined => {
  const bindings = managerConfig?.customQuota?.bindings;
  if (!bindings) return undefined;
  const bindingKey = buildProviderQuotaBindingKey(providerKind, providerName, apiKey);
  if (bindingKey && bindings[bindingKey]) return bindings[bindingKey];
  const apiKeyHash = sha256Hex(apiKey);
  const providerPrefix = `${providerKind}:`;
  return Object.entries(bindings).find(
    ([key, binding]) =>
      key.startsWith(providerPrefix) &&
      binding.providerName?.trim() === providerName.trim() &&
      binding.apiKeyHash === apiKeyHash
  )?.[1];
};

export const buildProviderQuotaBindings = (
  providerKind: ProviderQuotaKind,
  providerName: string,
  apiKey: string,
  quota?: ProviderQuotaFormState
): Record<string, ManagerCustomQuotaBinding> => {
  const bindingKey = buildProviderQuotaBindingKey(providerKind, providerName, apiKey);
  if (!quota || !bindingKey) return {};
  const url = quota.url.trim();
  const hasValues =
    Boolean(quota.hasBinding) ||
    Boolean(quota.enabled) ||
    Boolean(url) ||
    Boolean(quota.quotaApiKey.trim()) ||
    Boolean(quota.quotaApiKeyConfigured) ||
    Boolean(quota.proxyUrl.trim()) ||
    quota.headers.length > 0 ||
    Object.keys(quota.mapping).length > 0;
  if (!hasValues || !url) return {};
  const headers = buildHeaderObject(quota.headers);
  const mapping = normalizeMapping(quota.mapping);
  return {
    [bindingKey]: {
      kind: quota.kind,
      url,
      authMode: quota.authMode,
      quotaApiKey: quota.quotaApiKey.trim(),
      quotaApiKeyConfigured: Boolean(quota.quotaApiKeyConfigured || quota.quotaApiKey.trim()),
      apiKeyHeader: quota.apiKeyHeader.trim() || undefined,
      headers: Object.keys(headers).length ? headers : undefined,
      proxyUrl: quota.proxyUrl.trim() || undefined,
      mapping: Object.keys(mapping).length ? mapping : undefined,
      providerName: providerName.trim(),
      apiKeyHash: sha256Hex(apiKey),
      enabled: quota.enabled,
    },
  };
};

export const isProviderQuotaInvalid = (quota?: ProviderQuotaFormState) =>
  Boolean(
    quota?.enabled &&
      (!quota.url.trim() ||
        (quota.authMode !== 'none' && !quota.quotaApiKey.trim() && !quota.quotaApiKeyConfigured))
  );
