// Uncontrolled textarea that preserves cursor position during external re-renders.
// Uses ref + defaultValue so React never touches the DOM value while user is editing.

import { Textarea } from '#components/ui/textarea';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

type Props = Omit<React.ComponentProps<typeof Textarea>, 'value' | 'defaultValue' | 'onChange'> & {
  value: string;
  onChange: (text: string) => void;
};

export const DraftTextarea = forwardRef<HTMLTextAreaElement, Props>(
  ({ value, onChange, ...props }, fwd) => {
    const ref = useRef<HTMLTextAreaElement>(null);
    const editing = useRef(false);

    useImperativeHandle(fwd, () => ref.current!);

    // Sync external value into DOM only when not focused
    useEffect(() => {
      if (!editing.current && ref.current && ref.current.value !== value) {
        ref.current.value = value;
      }
    }, [value]);

    return (
      <Textarea
        ref={ref}
        defaultValue={value}
        onFocus={() => { editing.current = true; }}
        onBlur={() => {
          editing.current = false;
          if (ref.current && ref.current.value !== value) {
            ref.current.value = value;
          }
        }}
        onChange={(e) => onChange(e.target.value)}
        {...props}
      />
    );
  },
);
