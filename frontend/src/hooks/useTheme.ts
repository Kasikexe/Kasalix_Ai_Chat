import { useCallback, useEffect, useState } from 'react';

const THEME_KEY = 'ai-chat:theme';

type Theme = 'light' | 'dark';

function getStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {}
  return 'dark';
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'light') {
    root.classList.remove('dark');
    root.classList.add('light');
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#ffffff');
  } else {
    root.classList.remove('light');
    root.classList.add('dark');
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#0a0a0a');
  }
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme);

  // Apply theme on mount and when it changes
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {}
      return next;
    });
  }, []);

  return { theme, toggleTheme, isDark: theme === 'dark' };
}
