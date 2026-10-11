/**
 * Recover the upstream model that actually served a request from the Cline Pass
 * bridge request log.
 *
 * The bridge is the only component that knows the resolved upstream identity,
 * and the gateway never copies it onto the usage event. The bridge records one
 * entry per request together with the upstream request id, which the gateway
 * also stores on the usage event as its trace id, so the two records can be
 * joined exactly.
 */

import type { ApiClientRequestScope } from '@/services/api/client';
import { apiClient, createScopedApiRequestConfig } from '@/services/api/client';
import type { MonitoringEventRow } from './types';

export const CLINE_PASS_LOGS_PATH = '/clinepassbridge/logs';
export const CLINE_PASS_LOGS_LIMIT = 200;

export type ClinePassUpstreamHit = {
  upstreamModel: string;
  provider: string;
};

export type ClinePassUpstreamIndex = ReadonlyMap<string, ClinePassUpstreamHit>;

const EMPTY_INDEX: ClinePassUpstreamIndex = new Map();

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const readString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

/** Missing fields drop the entry instead of inventing an upstream identity. */
export const parseClinePassUpstreamIndex = (payload: unknown): ClinePassUpstreamIndex => {
  const items = asRecord(payload)?.items;
  if (!Array.isArray(items)) return EMPTY_INDEX;

  const index = new Map<string, ClinePassUpstreamHit>();
  items.forEach((raw) => {
    const entry = asRecord(raw);
    if (!entry) return;
    const requestId = readString(entry.upstream_request_id);
    const upstreamModel = readString(entry.upstream_model);
    if (!requestId || !upstreamModel) return;
    index.set(requestId, { upstreamModel, provider: readString(entry.provider) ?? '' });
  });
  return index;
};

/** The bridge log is optional enrichment, so a failure leaves the rows untouched. */
export const fetchClinePassUpstreamIndex = async (
  requestScope?: ApiClientRequestScope
): Promise<ClinePassUpstreamIndex> => {
  try {
    const payload = await apiClient.get(CLINE_PASS_LOGS_PATH, {
      ...(requestScope ? createScopedApiRequestConfig(requestScope) : {}),
      params: { limit: CLINE_PASS_LOGS_LIMIT },
    });
    return parseClinePassUpstreamIndex(payload);
  } catch {
    return EMPTY_INDEX;
  }
};

export const applyClinePassUpstreamHits = (
  rows: MonitoringEventRow[],
  index: ClinePassUpstreamIndex
): MonitoringEventRow[] => {
  if (index.size === 0 || rows.length === 0) return rows;

  let matched = false;
  const next = rows.map((row) => {
    if (row.provider !== 'cline-pass') return row;
    const traceId = row.headerTraceId?.trim();
    if (!traceId) return row;
    const hit = index.get(traceId);
    if (!hit) return row;
    matched = true;
    return {
      ...row,
      upstreamModel: hit.upstreamModel,
      upstreamProvider: hit.provider || undefined,
    };
  });
  return matched ? next : rows;
};
