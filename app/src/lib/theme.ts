// Colours needed outside className (navigation headers, status bar, icons
// passed as props, the reader page). Mirrors src/global.css.

import { useColorScheme } from 'react-native';

import { type ReaderTheme, useStore } from './store';

const light = {
  background: '#fafafa',
  card: '#ffffff',
  foreground: '#18181b',
  muted: '#71717a',
  border: '#e4e4e7',
  primary: '#4f46e5',
  success: '#16a34a',
  warning: '#d97706',
  destructive: '#dc2626',
};

const dark: typeof light = {
  background: '#09090b',
  card: '#18181b',
  foreground: '#f4f4f5',
  muted: '#a1a1aa',
  border: '#27272a',
  primary: '#818cf8',
  success: '#4ade80',
  warning: '#fbbf24',
  destructive: '#f87171',
};

export type Colors = typeof light;

export function useScheme(): 'light' | 'dark' {
  const system = useColorScheme();
  const appearance = useStore((s) => s.prefs.appearance);
  if (appearance !== 'system') return appearance;
  return system === 'dark' ? 'dark' : 'light';
}

export function useColors(): Colors {
  return useScheme() === 'dark' ? dark : light;
}

/** The reader page's own palette (reader/src/reader.css). */
export const READER_BACKGROUND: Record<Exclude<ReaderTheme, 'auto'>, string> = {
  light: '#ffffff',
  sepia: '#f6efe2',
  dark: '#0d1117',
  black: '#000000',
};

/** Colours for the reader's top bar, so it matches the page below it. */
export const READER_CHROME: Record<
  Exclude<ReaderTheme, 'auto'>,
  { bg: string; fg: string; muted: string; border: string; dark: boolean }
> = {
  light: { bg: '#ffffff', fg: '#1f2328', muted: '#59636e', border: '#d8dee4', dark: false },
  sepia: { bg: '#f6efe2', fg: '#3b3226', muted: '#6f604c', border: '#ddd0b8', dark: false },
  dark: { bg: '#0d1117', fg: '#e6edf3', muted: '#9198a1', border: '#30363d', dark: true },
  black: { bg: '#000000', fg: '#e6edf3', muted: '#9198a1', border: '#262a30', dark: true },
};

export function useReaderTheme(): Exclude<ReaderTheme, 'auto'> {
  const scheme = useScheme();
  const theme = useStore((s) => s.prefs.readerTheme);
  return theme === 'auto' ? scheme : theme;
}
