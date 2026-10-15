import type { TFunction } from 'i18next';

export const getCommandCodeBridgeQuotaWindowLabel = (id: string, t: TFunction): string =>
  ['five_hour', 'weekly', 'monthly'].includes(id) ? t(`commandcodebridge_quota.${id}`) : id;
