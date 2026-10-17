import { describe, expect, it } from 'vitest';
import type { AntigravityQuotaGroup } from '@/types';
import {
  filterAntigravityQuotaGroups,
  isAntigravityClaudeQuotaGroup,
} from './antigravityQuotaDisplay';

const group = (id: string, label: string): AntigravityQuotaGroup => ({
  id,
  label,
  buckets: [{ id: 'weekly', label: 'Weekly limit', remainingFraction: 0.5 }],
});

describe('antigravityQuotaDisplay', () => {
  it('recognizes Claude, GPT and external groups by id or label', () => {
    expect(isAntigravityClaudeQuotaGroup(group('claude-gpt', 'Claude and GPT models'))).toBe(true);
    expect(isAntigravityClaudeQuotaGroup(group('external', 'External models'))).toBe(true);
    expect(isAntigravityClaudeQuotaGroup(group('gemini', 'Gemini models'))).toBe(false);
  });

  it('keeps all groups when Claude quota is shown', () => {
    const groups = [group('gemini', 'Gemini models'), group('claude-gpt', 'Claude models')];
    expect(filterAntigravityQuotaGroups(groups, true)).toEqual(groups);
  });

  it('drops Claude groups when Claude quota is hidden', () => {
    const groups = [group('gemini', 'Gemini models'), group('claude-gpt', 'Claude models')];
    expect(filterAntigravityQuotaGroups(groups, false).map((item) => item.id)).toEqual(['gemini']);
  });
});
