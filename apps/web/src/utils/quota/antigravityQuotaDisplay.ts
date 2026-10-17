import type { AntigravityQuotaGroup } from '@/types';

const ANTIGRAVITY_CLAUDE_GROUP_PATTERN = /(claude|gpt|external)/i;

type AntigravityGroupIdentity = Pick<AntigravityQuotaGroup, 'id' | 'label'>;

export const isAntigravityClaudeQuotaGroup = (group: AntigravityGroupIdentity): boolean =>
  ANTIGRAVITY_CLAUDE_GROUP_PATTERN.test(`${group.id} ${group.label}`);

export const filterAntigravityQuotaGroups = <T extends AntigravityGroupIdentity>(
  groups: T[],
  showClaudeQuota: boolean
): T[] =>
  showClaudeQuota ? groups : groups.filter((group) => !isAntigravityClaudeQuotaGroup(group));
