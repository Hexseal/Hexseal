'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

type FormShellProps = {
  title?: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  onSubmit?: (e: React.FormEvent<HTMLFormElement>) => void;
  actions?: React.ReactNode;
};

export function FormShell({ 
  title, 
  description, 
  children, 
  className,
  onSubmit,
  actions
}: FormShellProps) {
  return (
    <form onSubmit={onSubmit} className={cn('space-y-6', className)}>
      {(title || description || actions) && (
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            {title && <h2 className="text-lg font-medium">{title}</h2>}
            {description && <p className="text-sm text-muted-foreground">{description}</p>}
          </div>
          {actions && (
            <div className="shrink-0">
              {actions}
            </div>
          )}
        </div>
      )}
      <div className="space-y-4">
        {children}
      </div>
    </form>
  );
}
