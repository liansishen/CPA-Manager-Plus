import type { TFunction } from 'i18next';

export const getCommandCodeQuotaWindowLabel = (id: string, t: TFunction): string =>
  ['five_hour', 'weekly', 'monthly'].includes(id) ? t(`commandcode_quota.${id}`) : id;
