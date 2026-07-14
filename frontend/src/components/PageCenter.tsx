'use client';

import { type ReactNode } from 'react';

/**
 * Centers content in the page viewport (below the header).
 * Use for loading, empty, error, and success inline states.
 */
export function PageCenter({ children }: { children: ReactNode }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center px-4">
      {children}
    </div>
  );
}
