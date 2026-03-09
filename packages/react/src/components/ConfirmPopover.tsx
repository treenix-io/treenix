import { Button } from '#components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '#components/ui/popover';
import { type ReactNode, useState } from 'react';

export function ConfirmPopover({
  title,
  onConfirm,
  variant = 'default',
  children,
}: {
  title: string;
  onConfirm: () => void;
  variant?: 'default' | 'destructive';
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {children}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        className="w-auto p-3 flex flex-col gap-2"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-xs text-muted-foreground">{title}</p>
        <div className="flex gap-1.5 justify-end">
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button variant={variant} size="sm" className="h-7 text-xs" onClick={() => { onConfirm(); setOpen(false); }}>
            Confirm
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
