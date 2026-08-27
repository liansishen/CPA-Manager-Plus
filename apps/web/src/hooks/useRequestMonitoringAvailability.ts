import { usePanelFeatureAvailability } from '@/hooks/usePanelFeatureAvailability';

export type RequestMonitoringUnavailableReason =
  | 'checking'
  | 'service_not_configured'
  | 'service_unavailable'
  | 'monitoring_disabled';

export interface RequestMonitoringAvailability {
  checking: boolean;
  available: boolean;
  managerServiceAvailable: boolean;
  modelPricesAvailable: boolean;
  serviceBase: string;
  managerConfig: ReturnType<typeof usePanelFeatureAvailability>['managerConfig'];
  reason: RequestMonitoringUnavailableReason | '';
}

export function useRequestMonitoringAvailability(): RequestMonitoringAvailability {
  const availability = usePanelFeatureAvailability();
  return {
    checking: availability.checking,
    available: availability.requestMonitoringAvailable,
    managerServiceAvailable: availability.managerServiceAvailable,
    modelPricesAvailable: availability.modelPricesAvailable,
    serviceBase: availability.managerServiceBase,
    managerConfig: availability.managerConfig,
    reason: availability.reason,
  };
}
