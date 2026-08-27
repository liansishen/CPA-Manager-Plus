import { useEffect, useState } from 'react';
import { usageServiceApi, type ManagerConfig } from '@/services/api/usageService';
import { useAuthStore } from '@/stores/useAuthStore';
import { useUsageServiceStore } from '@/stores/useUsageServiceStore';
import {
  buildProviderQuotaBindings,
  findProviderQuotaBinding,
  normalizeProviderQuotaForComparison,
  type ProviderQuotaKind,
} from '@/utils/quota/providerQuota';
import type { ProviderQuotaFormState } from '../types';

export function useProviderQuotaManagerConfig(open: boolean) {
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const serviceBase = useUsageServiceStore((state) => state.serviceBase);
  const quotaServiceBase = serviceBase || apiBase;
  const [managerConfig, setManagerConfig] = useState<ManagerConfig | null>(null);
  const [managerConfigLoaded, setManagerConfigLoaded] = useState(false);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setManagerConfigLoaded(false);
    });
    if (!quotaServiceBase || !managementKey) {
      queueMicrotask(() => {
        if (cancelled) return;
        setManagerConfig(null);
        setManagerConfigLoaded(true);
      });
      return () => {
        cancelled = true;
      };
    }
    usageServiceApi
      .getManagerConfig(quotaServiceBase, managementKey)
      .then((response) => {
        if (cancelled) return;
        setManagerConfig(response.config);
        setManagerConfigLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setManagerConfig(null);
        setManagerConfigLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [managementKey, open, quotaServiceBase]);

  return { managerConfig, managerConfigLoaded, managementKey, quotaServiceBase, setManagerConfig };
}

export const hasProviderQuotaBinding = (
  managerConfig: ManagerConfig | null,
  providerName: string
) =>
  Object.values(managerConfig?.customQuota?.bindings ?? {}).some(
    (binding) => binding.providerName?.trim() === providerName.trim()
  );

export const buildProviderQuotaManagerConfig = (
  managerConfig: ManagerConfig,
  providerKind: ProviderQuotaKind,
  providerName: string,
  apiKey: string,
  quota?: ProviderQuotaFormState
): ManagerConfig => {
  const existingBindings = Object.entries(managerConfig.customQuota?.bindings ?? {}).filter(
    ([, binding]) => binding.providerName?.trim() !== providerName.trim()
  );
  return {
    ...managerConfig,
    customQuota: {
      ...managerConfig.customQuota,
      bindings: {
        ...Object.fromEntries(existingBindings),
        ...buildProviderQuotaBindings(providerKind, providerName, apiKey, quota),
      },
    },
  };
};

export const hasProviderQuotaState = (quota?: ProviderQuotaFormState) =>
  Boolean(normalizeProviderQuotaForComparison(quota));

export { findProviderQuotaBinding };
