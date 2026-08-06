import { useEffect, useState } from 'react';

/** Read-only observer of the `dark` class toggled by useDarkMode, for
 * components (like Monaco) that need the current mode but shouldn't own it. */
export function useDarkModeValue(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setDark(document.documentElement.classList.contains('dark'));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return dark;
}
