import type { TFunction } from 'i18next';

export const getClinePassQuotaWindowLabel = (id: string, t: TFunction): string =>
  ['five_hour', 'weekly', 'monthly'].includes(id) ? t(`cline_pass_quota.${id}`) : id;
