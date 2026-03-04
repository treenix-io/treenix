// TString editor — tabbed multilingual text input
// Used by message, question, and menu button editors

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
          <button
            key={lang}
            type="button"
            onClick={() => setActiveLang(lang)}
            className={`px-2.5 py-1 text-xs font-medium uppercase rounded-t transition-colors ${
              activeLang === lang
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {lang}
            {value[lang] ? '' : ' *'}
          </button>
        ))}
      </div>

      <textarea
        className="w-full px-3 py-2 text-sm bg-background border border-border rounded-md resize-none outline-none focus:border-primary transition-colors"
        rows={rows}
        placeholder={placeholder ?? `Text (${activeLang})`}
        value={value[activeLang] ?? ''}
        onChange={e => onChange({ ...value, [activeLang]: e.target.value })}
      />
    </div>
  );
}

/** Single-line TString input */
export function TStringLineInput({ value = {}, onChange, langs = ['ru', 'en'], placeholder }: Omit<Props, 'rows'>) {
  const [activeLang, setActiveLang] = useState(langs[0] ?? 'ru');

  return (
    <div className="flex items-center gap-1 border border-border rounded-md overflow-hidden bg-background">
      {langs.map(lang => (
        <button
          key={lang}
          type="button"
          onClick={() => setActiveLang(lang)}
          className={`px-2 py-1 text-[10px] font-medium uppercase shrink-0 ${
            activeLang === lang ? 'text-primary' : 'text-muted-foreground'
          }`}
        >
          {lang}
        </button>
      ))}

      <input
        type="text"
        className="flex-1 px-2 py-1.5 text-sm outline-none bg-transparent"
        placeholder={placeholder ?? `Text (${activeLang})`}
        value={value[activeLang] ?? ''}
        onChange={e => onChange({ ...value, [activeLang]: e.target.value })}
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
