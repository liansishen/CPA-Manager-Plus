import { MemoryRouter } from 'react-router-dom';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelPriceAttentionLink } from './ModelPriceAttentionLink';
import * as attentionHook from './useModelPriceAttention';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: { count?: number; defaultValue?: string }) => {
        if (key === 'usage_stats.model_price_attention_tooltip') {
          return `发现 ${options?.count} 个新模型待同步价格`;
        }
        if (key === 'usage_stats.model_price_settings_short') {
          return '模型价格';
        }
        if (key === 'usage_stats.model_price_settings') {
          return '模型价格设置';
        }
        return options?.defaultValue || key;
      },
    }),
  };
});

describe('ModelPriceAttentionLink', () => {
  let mockAttentionState: ReturnType<typeof attentionHook.useModelPriceAttention>;

  beforeEach(() => {
    mockAttentionState = {
      runtimeModels: [],
      unpricedModels: [],
      acknowledgedModels: [],
      pendingModels: [],
      pendingCount: 0,
      hasAttention: false,
      modelPricesAvailable: true,
      loading: false,
      lastCheckedAtMs: null,
      check: vi.fn(),
      capturePendingSnapshot: vi.fn(),
      acknowledgeSnapshot: vi.fn(),
    };

    vi.spyOn(attentionHook, 'useModelPriceAttention').mockImplementation(
      () => mockAttentionState
    );
  });

  it('renders nothing if modelPricesAvailable is false', () => {
    mockAttentionState.modelPricesAvailable = false;
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(
        <MemoryRouter>
          <ModelPriceAttentionLink variant="action-bar" />
          <ModelPriceAttentionLink variant="inline" />
        </MemoryRouter>
      );
    });
    expect(renderer!.toJSON()).toBeNull();
  });

  describe('action-bar variant', () => {
    it('renders normal link without dot when pendingCount = 0', () => {
      mockAttentionState.pendingCount = 0;
      mockAttentionState.hasAttention = false;

      let renderer: ReactTestRenderer;
      act(() => {
        renderer = create(
          <MemoryRouter>
            <ModelPriceAttentionLink variant="action-bar" className="custom-btn" />
          </MemoryRouter>
        );
      });

      const root = renderer!.root;
      const link = root.findByProps({ 'data-testid': 'monitoring-model-prices-link' });
      expect(link.props.to).toBe('/model-prices');
      expect(link.props.title).toBe('模型价格设置');
      expect(link.props['data-has-attention']).toBe(false);

      // No attention dot
      expect(root.findAllByProps({ 'data-testid': 'model-price-attention-dot' })).toHaveLength(0);
    });

    it('renders link with amber dot and filter=missing when pendingCount > 0', () => {
      mockAttentionState.pendingModels = ['gpt-6-sol', 'claude-4'];
      mockAttentionState.pendingCount = 2;
      mockAttentionState.hasAttention = true;

      let renderer: ReactTestRenderer;
      act(() => {
        renderer = create(
          <MemoryRouter>
            <ModelPriceAttentionLink variant="action-bar" />
          </MemoryRouter>
        );
      });

      const root = renderer!.root;
      const link = root.findByProps({ 'data-testid': 'monitoring-model-prices-link' });
      expect(link.props.to).toBe('/model-prices?filter=missing');
      expect(link.props.title).toBe('发现 2 个新模型待同步价格');
      expect(link.props['data-has-attention']).toBe(true);

      // Has attention dot
      const dot = root.findByProps({ 'data-testid': 'model-price-attention-dot' });
      expect(dot).toBeDefined();
    });
  });

  describe('inline variant', () => {
    it('renders null when pendingCount = 0', () => {
      mockAttentionState.pendingCount = 0;
      mockAttentionState.hasAttention = false;

      let renderer: ReactTestRenderer;
      act(() => {
        renderer = create(
          <MemoryRouter>
            <ModelPriceAttentionLink variant="inline" />
          </MemoryRouter>
        );
      });

      expect(renderer!.toJSON()).toBeNull();
    });

    it('renders clickable link when pendingCount > 0', () => {
      mockAttentionState.pendingModels = ['gpt-6-sol'];
      mockAttentionState.pendingCount = 1;
      mockAttentionState.hasAttention = true;

      let renderer: ReactTestRenderer;
      act(() => {
        renderer = create(
          <MemoryRouter>
            <ModelPriceAttentionLink variant="inline" />
          </MemoryRouter>
        );
      });

      const root = renderer!.root;
      const link = root.findByProps({ 'data-testid': 'inline-model-price-attention-link' });
      expect(link.props.to).toBe('/model-prices?filter=missing');
      expect(link.props.title).toBe('发现 1 个新模型待同步价格');

      const dot = root.findByProps({ 'data-testid': 'model-price-attention-dot' });
      expect(dot).toBeDefined();
    });
  });
});
