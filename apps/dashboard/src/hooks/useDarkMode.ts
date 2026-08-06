import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'vyzus.theme';

// Default is light, full stop — we deliberately don't fall back to the OS's
// prefers-color-scheme. Mirrors the blocking script in index.html so both
// agree on the initial class before/after React mounts.
function initial(): boolean {
  return localStorage.getItem(STORAGE_KEY) === 'dark';
}

export function useDarkMode(): [boolean, () => void] {
  const [dark, setDark] = useState<boolean>(initial);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', dark ? 'dark' : 'light');
  }, [dark]);

  const toggle = useCallback(() => {
    setDark((d) => {
      const next = !d;
      localStorage.setItem(STORAGE_KEY, next ? 'dark' : 'light');
      return next;
    });
  }, []);

  return [dark, toggle];
}
