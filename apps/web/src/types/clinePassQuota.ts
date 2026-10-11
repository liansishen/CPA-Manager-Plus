/**
 * Cline Pass bridge quota types.
 */

import type { CredentialScopedQuotaState } from './quota';

export interface ClinePassQuotaWindow {
  id: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetAtMs: number | null;
  estimatedTotalUsd: number | null;
  estimatedRemainingUsd: number | null;
  estimateNote: string | null;
  preliminary: boolean;
  historical: boolean;
}

export interface ClinePassQuotaData {
  windows: ClinePassQuotaWindow[];
  planType: string | null;
  planEndMs: number | null;
  observedAtMs: number | null;
  checkedAtMs: number | null;
  sharedCredentials: number | null;
  error?: string;
  providerStatus: string;
}

export interface ClinePassQuotaState extends ClinePassQuotaData, CredentialScopedQuotaState {
  status: 'idle' | 'loading' | 'success' | 'error';
  fetchedAtMs?: number;
  failedAtMs?: number;
  errorStatus?: number;
}
