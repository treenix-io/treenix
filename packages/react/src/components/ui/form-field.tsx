// Adaptive form field — label left when content is short, label on top when tall
import { cn } from '#components/lib/utils';
import { useLayoutEffect, useRef, useState } from 'react';

const STACK_THRESHOLD = 48; // px — above this, label goes on top

export function FormField({ label, labelClass, className, children }: {
  label: React.ReactNode;
  labelClass?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [stacked, setStacked] = useState(true); // start stacked — safe default, no jump

  // Measure once on mount — switch to inline if content is small
  useLayoutEffect(() => {
    if (contentRef.current) {
      setStacked(contentRef.current.scrollHeight > STACK_THRESHOLD);
    }
  }, []);

  return (
    <div className={cn(stacked ? 'flex flex-col gap-1' : 'flex items-center gap-4', className)}>
      <span className={cn(
        'text-sm text-muted-foreground shrink-0',
        !stacked && 'w-20',
        labelClass,
      )}>
        {label}
      </span>
      <div ref={contentRef} className="flex-1 min-w-0">
        {children}
      </div>
    </div>
  );
}
