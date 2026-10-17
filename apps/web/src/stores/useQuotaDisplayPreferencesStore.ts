import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { STORAGE_KEY_QUOTA_DISPLAY_PREFERENCES } from '@/utils/constants';

interface QuotaDisplayPreferencesState {
  showAntigravityClaudeQuota: boolean;
  setShowAntigravityClaudeQuota: (value: boolean) => void;
}

const normalizeShowAntigravityClaudeQuota = (value: unknown): boolean =>
  typeof value === 'boolean' ? value : true;

export const useQuotaDisplayPreferencesStore = create<QuotaDisplayPreferencesState>()(
  persist(
    (set) => ({
      showAntigravityClaudeQuota: true,
      setShowAntigravityClaudeQuota: (value) => set({ showAntigravityClaudeQuota: value }),
    }),
    {
      name: STORAGE_KEY_QUOTA_DISPLAY_PREFERENCES,
      partialize: (state) => ({
        showAntigravityClaudeQuota: state.showAntigravityClaudeQuota,
      }),
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<QuotaDisplayPreferencesState> | undefined;
        return {
          ...currentState,
          showAntigravityClaudeQuota: normalizeShowAntigravityClaudeQuota(
            persisted?.showAntigravityClaudeQuota
          ),
        };
      },
    }
  )
);
