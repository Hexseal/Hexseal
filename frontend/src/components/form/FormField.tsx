'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

type FormFieldProps = {
  label: string;
  description?: string;
  error?: string;
  children: React.ReactNode;
  className?: string;
};

export function FormField({ 
  label, 
  description, 
  error, 
  children, 
  className 
}: FormFieldProps) {
  return (
    <div className={cn('space-y-2', className)}>
      <div className="space-y-1">
        <label className="text-sm font-medium leading-none">
          {label}
          {error && <span className="text-destructive ml-2 text-xs">{error}</span>}
        </label>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </div>
  );
}

type MonoInputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  error?: boolean;
};

export function MonoInput({ className, error, ...props }: MonoInputProps) {
  return (
    <input
      className={cn(
        'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background',
        'font-mono text-sm',
        'file:border-0 file:bg-transparent file:text-sm file:font-medium',
        'placeholder:text-muted-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-50',
        error && 'border-destructive text-destructive',
        className
      )}
      {...props}
    />
  );
}

type MonoTextAreaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  error?: boolean;
};

export function MonoTextArea({ className, error, ...props }: MonoTextAreaProps) {
  return (
    <textarea
      className={cn(
        'flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background',
        'font-mono text-sm min-h-[100px] resize-y',
        'placeholder:text-muted-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-50',
        error && 'border-destructive text-destructive',
        className
      )}
      {...props}
    />
  );
}
