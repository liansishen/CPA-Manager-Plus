import type { TFunction } from 'i18next';
import type { ClinePassQuotaWindow } from '@/types';

export const getClinePassQuotaWindowLabel = (id: string, t: TFunction): string =>
  ['five_hour', 'weekly', 'monthly'].includes(id) ? t(`cline_pass_quota.${id}`) : id;

export const buildClinePassEstimatePresentation = (
  window: ClinePassQuotaWindow,
  t: TFunction,
  stale = false
): { amountLabel?: string; description?: string } => {
  const amounts: string[] = [];
  if (window.estimatedTotalUsd !== null) {
    amounts.push(
      t('cline_pass_quota.estimated_total', { amount: window.estimatedTotalUsd.toFixed(2) })
    );
  }
  if (!stale && !window.historical && window.estimatedRemainingUsd !== null) {
    amounts.push(
      t('cline_pass_quota.estimated_remaining', { amount: window.estimatedRemainingUsd.toFixed(2) })
    );
  }
  const notes = [
    amounts.length ? t('cline_pass_quota.estimate_notice') : null,
    window.preliminary ? t('cline_pass_quota.preliminary') : null,
    window.historical ? t('cline_pass_quota.historical') : null,
    window.estimateNote,
  ].filter(Boolean);
  return {
    amountLabel: amounts.length ? amounts.join(' · ') : undefined,
    description: notes.length ? notes.join(' · ') : undefined,
  };
};
