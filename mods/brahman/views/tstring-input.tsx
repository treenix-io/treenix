// TString editor — tabbed multilingual text input
// Used by message, question, and menu button editors

import { Button } from '@treenx/react/components/ui/button';
import { Input } from '@treenx/react/components/ui/input';
import { Textarea } from '@treenx/react/components/ui/textarea';
import { cn } from '@treenx/react';
import { useState } from 'react';
import type { TString } from '../types';

type Props = {
  value: TString;
  onChange: (next: TString) => void;
  langs?: string[];
  rows?: number;
  placeholder?: string;
};

export function TStringInput({ value = {}, onChange, langs = ['ru', 'en'], rows = 3, placeholder }: Props) {
  const [activeLang, setActiveLang] = useState(langs[0] ?? 'ru');

  return (
    <div>
      <div className="flex gap-0.5 mb-1">
        {langs.map(lang => (
          <Button
            key={lang}
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setActiveLang(lang)}
            className={cn(
              'px-2.5 py-1 h-auto text-xs font-medium uppercase rounded-t',
              activeLang === lang
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {lang}
            {value[lang] ? '' : ' *'}
          </Button>
        ))}
      </div>

      <Textarea
        rows={rows}
        placeholder={placeholder ?? `Text (${activeLang})`}
        value={value[activeLang] ?? ''}
        onChange={e => onChange({ [activeLang]: e.target.value })}
        className="resize-none"
      />
    </div>
  );
}

/** Single-line TString input */
export function TStringLineInput({ value = {}, onChange, langs = ['ru', 'en'], placeholder }: Omit<Props, 'rows'>) {
  const [activeLang, setActiveLang] = useState(langs[0] ?? 'ru');

  return (
    <div className="flex items-center gap-1 border border-input rounded-md overflow-hidden bg-background">
      {langs.map(lang => (
        <Button
          key={lang}
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setActiveLang(lang)}
          className={cn(
            'px-2 py-1 h-auto text-[10px] font-medium uppercase shrink-0',
            activeLang === lang ? 'text-primary' : 'text-muted-foreground',
          )}
        >
          {lang}
        </Button>
      ))}

      <Input
        type="text"
        className="flex-1 border-0 shadow-none focus-visible:ring-0"
        placeholder={placeholder ?? `Text (${activeLang})`}
        value={value[activeLang] ?? ''}
        onChange={e => onChange({ [activeLang]: e.target.value })}
      />
    </div>
  );
}

/** Get first non-empty TString value for display */
export function tstringPreview(ts: TString | undefined, maxLen = 40): string {
  if (!ts) return '';
  const text = ts.ru || ts.en || Object.values(ts).find(v => v) || '';
  return text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
}
