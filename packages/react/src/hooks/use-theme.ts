// Theme switcher — toggles `.dark` class on <html>, persists to localStorage.
// Initial `.dark` is applied by the inline FOUC script in index.html to avoid flash;
// this hook reads/writes the same storage key (`treenix-theme`).
//
// Custom themes (Layer B): setCustomTheme({ name, tokens }) injects an inline
// <style id="treenix-theme-<name>"> with the overrides and applies `.theme-<name>`
// on <html>. Customs stack on top of dark/light via CSS specificity.

import { useCallback, useState } from 'react';

const STORAGE_KEY = 'treenix-theme';
const DEFAULT_THEME: Theme = 'dark';

export type Theme = 'dark' | 'light';

export type CustomThemeSpec = {
  name: string;
  tokens: Record<string, string>;
};

export type UseThemeResult = {
  theme: Theme;
  setTheme: (next: Theme) => void;
  setCustomTheme: (spec: CustomThemeSpec) => void;
  clearCustomTheme: (name: string) => void;
};

function readTheme(): Theme {
  if (typeof document === 'undefined') return DEFAULT_THEME;
  return localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark';
}

export function useTheme(): UseThemeResult {
  const [theme, setThemeState] = useState<Theme>(readTheme);

  const setTheme = useCallback((next: Theme) => {
    localStorage.setItem(STORAGE_KEY, next);
    document.documentElement.classList.toggle('dark', next === 'dark');
    setThemeState(next);
  }, []);

  const setCustomTheme = useCallback(({ name, tokens }: CustomThemeSpec) => {
    const styleId = `treenix-theme-${name}`;
    const className = `theme-${name}`;
    let style = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement('style');
      style.id = styleId;
      document.head.appendChild(style);
    }
    const decls = Object.entries(tokens).map(([k, v]) => `  ${k}: ${v};`).join('\n');
    style.textContent = `.${className} {\n${decls}\n}\n`;
    document.documentElement.classList.add(className);
  }, []);

  const clearCustomTheme = useCallback((name: string) => {
    document.getElementById(`treenix-theme-${name}`)?.remove();
    document.documentElement.classList.remove(`theme-${name}`);
  }, []);

  return { theme, setTheme, setCustomTheme, clearCustomTheme };
}
