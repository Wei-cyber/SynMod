import * as React from 'react';

const MOBILE_BREAKPOINT = 768;

export function useIsMobile() {
  return React.useSyncExternalStore(
    (onStoreChange) => {
      const query = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
      query.addEventListener('change', onStoreChange);
      return () => query.removeEventListener('change', onStoreChange);
    },
    () => window.innerWidth < MOBILE_BREAKPOINT,
    () => false,
  );
}
