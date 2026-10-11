import { describe, expect, it } from 'vitest';
import type { MonitoringEventRow } from './types';
import { applyClinePassUpstreamHits, parseClinePassUpstreamIndex } from './clinePassUpstreamLogs';

const makeRow = (overrides: Partial<MonitoringEventRow> = {}): MonitoringEventRow =>
  ({
    id: 'event-1',
    provider: 'cline-pass',
    model: 'deepseek-flash',
    requestedModel: 'deepseek-flash',
    headerTraceId: 'trace-1',
    ...overrides,
  }) as MonitoringEventRow;

describe('cline pass upstream log index', () => {
  it('indexes entries by upstream request id', () => {
    const index = parseClinePassUpstreamIndex({
      items: [
        {
          upstream_request_id: 'trace-1',
          upstream_model: 'cline-pass/deepseek-v4.1-flash',
          provider: 'deepseek',
        },
        {
          upstream_request_id: 'trace-2',
          upstream_model: 'cline-pass/deepseek-v4.1-flash',
          provider: 'parasail',
        },
      ],
    });

    expect(index.get('trace-1')).toEqual({
      upstreamModel: 'cline-pass/deepseek-v4.1-flash',
      provider: 'deepseek',
    });
    expect(index.get('trace-2')?.provider).toBe('parasail');
  });

  it('skips entries without an upstream request id or upstream model', () => {
    const index = parseClinePassUpstreamIndex({
      items: [
        { upstream_request_id: 'trace-1', provider: 'deepseek' },
        { upstream_model: 'cline-pass/deepseek-v4.1-flash' },
        { upstream_request_id: '   ', upstream_model: '   ' },
        { upstream_request_id: 'trace-3', upstream_model: 'cline-pass/glm-5.3-flash' },
      ],
    });

    expect(Array.from(index.keys())).toEqual(['trace-3']);
    expect(index.get('trace-3')?.provider).toBe('');
  });

  it('returns an empty index for payloads that carry no usable list', () => {
    expect(parseClinePassUpstreamIndex(null).size).toBe(0);
    expect(parseClinePassUpstreamIndex({ items: 'nope' }).size).toBe(0);
    expect(parseClinePassUpstreamIndex({ items: [] }).size).toBe(0);
  });
});

describe('cline pass upstream row enrichment', () => {
  it('attaches the upstream identity to matching cline pass rows only', () => {
    const index = parseClinePassUpstreamIndex({
      items: [
        {
          upstream_request_id: 'trace-1',
          upstream_model: 'cline-pass/deepseek-v4.1-flash',
          provider: 'deepseek',
        },
      ],
    });
    const rows = [
      makeRow(),
      makeRow({ id: 'event-2', provider: 'codex', headerTraceId: 'trace-1' }),
      makeRow({ id: 'event-3', headerTraceId: 'unknown-trace' }),
    ];

    const enriched = applyClinePassUpstreamHits(rows, index);

    expect(enriched[0].upstreamModel).toBe('cline-pass/deepseek-v4.1-flash');
    expect(enriched[0].upstreamProvider).toBe('deepseek');
    expect(enriched[1].upstreamModel).toBeUndefined();
    expect(enriched[2].upstreamModel).toBeUndefined();
    expect(rows[0].upstreamModel).toBeUndefined();
  });

  it('keeps the original rows when nothing matches', () => {
    const index = parseClinePassUpstreamIndex({
      items: [{ upstream_request_id: 'trace-9', upstream_model: 'cline-pass/kimi-k3' }],
    });
    const rows = [makeRow()];

    expect(applyClinePassUpstreamHits(rows, index)).toBe(rows);
    expect(applyClinePassUpstreamHits(rows, new Map())).toBe(rows);
  });
});
