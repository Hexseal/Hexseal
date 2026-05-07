'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

type FormSectionProps = {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  defaultOpen?: boolean;
};

export function FormSection({ 
  title, 
  description, 
  children, 
  className,
  defaultOpen
}: FormSectionProps) {
  return (
    <div className={cn('space-y-4 rounded-lg border p-6', className)}>
      <div className="space-y-1">
        <h3 className="font-medium">{title}</h3>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="space-y-4">
        {children}
      </div>
    </div>
  );
}
