import { useEffect, useRef } from 'react';

/**
 * Ref-based mount flag for guarding setState in async callbacks. Unlike
 * useIsMounted.ts (useState-backed, correct for JSX conditionals only), a
 * handler's closure reads `.current` fresh at call time regardless of which
 * render created the closure — so it still reports the real mount state
 * after the component has unmounted mid-await.
 */
export function useMountedRef() {
  const ref = useRef(true);
  useEffect(() => () => { ref.current = false; }, []);
  return ref;
}
