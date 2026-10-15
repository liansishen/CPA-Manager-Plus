/**
 * CommandCodeBridge plugin quota types.
 */

import type { CredentialScopedQuotaState } from './quota';

export interface CommandCodeBridgeQuotaWindow {
  id: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetAtMs: number | null;
}

export interface CommandCodeBridgeQuotaCredits {
  monthly: number | null;
  purchased: number | null;
  free: number | null;
  used: number | null;
  remaining: number | null;
  total: number | null;
}

export interface CommandCodeBridgeQuotaData {
  windows: CommandCodeBridgeQuotaWindow[];
  planType: string | null;
  planEndMs: number | null;
  observedAtMs: number | null;
  checkedAtMs: number | null;
  credits: CommandCodeBridgeQuotaCredits;
  error?: string;
  providerStatus: string;
}

export interface CommandCodeBridgeQuotaState
  extends CommandCodeBridgeQuotaData,
    CredentialScopedQuotaState {
  status: 'idle' | 'loading' | 'success' | 'error';
  fetchedAtMs?: number;
  failedAtMs?: number;
  errorStatus?: number;
}
