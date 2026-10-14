/**
 * CommandCode plugin quota types.
 */

import type { CredentialScopedQuotaState } from './quota';

export interface CommandCodeQuotaWindow {
  id: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetAtMs: number | null;
}

export interface CommandCodeQuotaCredits {
  monthly: number | null;
  purchased: number | null;
  free: number | null;
  used: number | null;
  remaining: number | null;
  total: number | null;
}

export interface CommandCodeQuotaData {
  windows: CommandCodeQuotaWindow[];
  planType: string | null;
  planEndMs: number | null;
  observedAtMs: number | null;
  checkedAtMs: number | null;
  credits: CommandCodeQuotaCredits;
  error?: string;
  providerStatus: string;
}

export interface CommandCodeQuotaState
  extends CommandCodeQuotaData,
    CredentialScopedQuotaState {
  status: 'idle' | 'loading' | 'success' | 'error';
  fetchedAtMs?: number;
  failedAtMs?: number;
  errorStatus?: number;
}
