import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useThemeStore } from './useThemeStore';

describe('useThemeStore', () => {
  const attrs = new Map<string, string>();

  beforeEach(() => {
    attrs.clear();
    const docMock = {
      documentElement: {
        setAttribute: (key: string, val: string) => {
          attrs.set(key, val);
        },
        removeAttribute: (key: string) => {
          attrs.delete(key);
        },
        getAttribute: (key: string) => attrs.get(key) ?? null,
      },
    };
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      writable: true,
      value: docMock,
    });
    useThemeStore.setState({ theme: 'auto', resolvedTheme: 'light' });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'document');
  });

  it('cycles through auto -> white -> dark -> claude -> auto', () => {
    const { cycleTheme } = useThemeStore.getState();

    expect(useThemeStore.getState().theme).toBe('auto');

    cycleTheme();
    expect(useThemeStore.getState().theme).toBe('white');
    expect(attrs.get('data-theme')).toBe('white');

    cycleTheme();
    expect(useThemeStore.getState().theme).toBe('dark');
    expect(attrs.get('data-theme')).toBe('dark');

    cycleTheme();
    expect(useThemeStore.getState().theme).toBe('claude');
    expect(attrs.get('data-theme')).toBe('claude');
    expect(useThemeStore.getState().resolvedTheme).toBe('light');

    cycleTheme();
    expect(useThemeStore.getState().theme).toBe('auto');
    expect(attrs.get('data-theme')).toBe('white');
  });

  it('sets theme directly to claude', () => {
    const { setTheme } = useThemeStore.getState();

    setTheme('claude');
    expect(useThemeStore.getState().theme).toBe('claude');
    expect(useThemeStore.getState().resolvedTheme).toBe('light');
    expect(attrs.get('data-theme')).toBe('claude');
  });
});
