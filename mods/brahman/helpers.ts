// Brahman templates, formatting and keyboards shared by native actions and editors

import { InlineKeyboard, Keyboard } from 'grammy';
import type { MenuRow, MenuType, TString } from './types';

// ── TString formatting ──

export function formatTString(ts: TString | undefined, lang: string): string {
  if (!ts) return '';
  return ts[lang] || ts.ru || ts.en || Object.values(ts).find(v => v) || '';
}

// ── Template engine (Handlebars-compatible) ──
// Supports: {field}, {data.nested}, {{#ifEquals a b}}...{{else}}...{{/ifEquals}},
// {{#tag name}}...{{else}}...{{/tag}}, {{shortDate d}}, {{toFixed n f}},
// {{switch v c1 v1 c2 v2}}, {{#and v1 v2}}...{{else}}...{{/and}}, {{eval expr}}

export function resolveVar(path: string, data: Record<string, unknown>): unknown {
  let val: unknown = data;
  for (const key of path.split('.')) {
    if (val == null || typeof val !== 'object') return undefined;
    val = (val as Record<string, unknown>)[key];
  }
  return val;
}

export function renderTemplate(template: string, data: Record<string, unknown>): string {
  let result = template;

  // Block helpers: {{#helper args}}...{{else}}...{{/helper}}
  result = result.replace(
    /\{\{#ifEquals\s+(\S+)\s+['"]?([^'"}\s]+)['"]?\}\}([\s\S]*?)\{\{\/ifEquals\}\}/g,
    (_, varPath, compareVal, body) => {
      const val = String(resolveVar(varPath, data) ?? '');
      const [truePart, falsePart = ''] = body.split('{{else}}');
      return val === compareVal ? truePart : falsePart;
    },
  );

  result = result.replace(
    /\{\{#tag\s+(\S+)\}\}([\s\S]*?)\{\{\/tag\}\}/g,
    (_, tagName, body) => {
      const tags = (data.userTags ?? data.tags ?? []) as string[];
      const [truePart, falsePart = ''] = body.split('{{else}}');
      return tags.includes(tagName) ? truePart : falsePart;
    },
  );

  result = result.replace(
    /\{\{#and\s+([\s\S]*?)\}\}([\s\S]*?)\{\{\/and\}\}/g,
    (_, varsStr, body) => {
      const vars = varsStr.trim().split(/\s+/);
      const allTrue = vars.every((v: string) => !!resolveVar(v, data));
      const [truePart, falsePart = ''] = body.split('{{else}}');
      return allTrue ? truePart : falsePart;
    },
  );

  // Inline helpers: {{helperName args}}
  result = result.replace(/\{\{shortDate\s+(\S+)\}\}/g, (_, varPath) => {
    const val = resolveVar(varPath, data);
    if (!val) return '';
    const d = new Date(val as string | number);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(-2);
    return `${dd}.${mm}.${yy}`;
  });

  result = result.replace(/\{\{toFixed\s+(\S+)\s+(\d+)\}\}/g, (_, varPath, fraction) => {
    const val = resolveVar(varPath, data);
    return val != null ? Number(val).toFixed(Number(fraction)) : '';
  });

  result = result.replace(/\{\{is\s+(\S+)\}\}/g, (_, varPath) => {
    return resolveVar(varPath, data) ? 'true' : '';
  });

  result = result.replace(/\{\{switch\s+([\s\S]*?)\}\}/g, (_, argsStr) => {
    const args = argsStr.trim().split(/\s+/);
    const val = String(resolveVar(args[0], data) ?? '');
    for (let i = 1; i < args.length - 1; i += 2) {
      if (args[i] === val) return args[i + 1] ?? '';
    }
    return '';
  });

  result = result.replace(/\{\{eval\s+([\s\S]*?)\}\}/g, (_, expr) => {
    try {
      const fn = new Function('data', 'session', 'user', `return (${expr})`);
      return String(fn(data, data, data.user) ?? '');
    } catch { return ''; }
  });

  // Simple variable interpolation: {field} and {data.nested} and {{field}}
  result = result.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, path: string) => {
    const val = resolveVar(path, data);
    return val != null ? String(val) : '';
  });

  result = result.replace(/\{(\w+(?:\.\w+)*)\}/g, (_, path: string) => {
    const val = resolveVar(path, data);
    return val != null ? String(val) : '';
  });

  return result;
}

// ── Tag checking (from old brahman) ──
// Tags with ! prefix = exclude, without = include (at least one match)

export function checkTags(userTags: string[], buttonTags: string[]): boolean {
  if (!buttonTags.length) return true;

  const includes = buttonTags.filter(t => !t.startsWith('!'));
  const excludes = buttonTags.filter(t => t.startsWith('!')).map(t => t.slice(1));

  if (excludes.some(t => userTags.includes(t))) return false;
  if (includes.length === 0) return true;
  return includes.some(t => userTags.includes(t));
}

// ── Keyboard building ──

export function buildReplyMarkup(rows: MenuRow[], type: MenuType, lang: string, userTags: string[] = []) {
  if (type === 'none') return undefined;
  if (type === 'remove') return { reply_markup: { remove_keyboard: true as const } };
  if (type === 'force_reply') return { reply_markup: { force_reply: true as const } };

  if (type === 'keyboard') {
    const kb = new Keyboard();
    for (const row of rows) {
      for (const btn of row.buttons) {
        if (!checkTags(userTags, btn.tags ?? [])) continue;
        const text = formatTString(btn.title, lang);
        if (!text) continue; // Telegram rejects empty button text
        kb.text(text);
      }
      kb.row();
    }
    return { reply_markup: kb.resized() };
  }

  // Inline keyboards (inline, inline_new, inline_close)
  const kb = new InlineKeyboard();
  for (const row of rows) {
    for (const btn of row.buttons) {
      if (!checkTags(userTags, btn.tags ?? [])) continue;
      const text = formatTString(btn.title, lang);
      if (!text) continue; // Telegram rejects empty button text
      if (btn.url) {
        kb.url(text, btn.url);
      } else {
        const cbData = btn.action?.type === 'brahman.action.page'
          ? `page:${btn.action.target ?? ''}`
          : `btn:${btn.id}`;
        kb.text(text, cbData);
      }
    }
    kb.row();
  }
  return { reply_markup: kb };
}

// ── Language flags ──

export const LANG_FLAGS: Record<string, string> = {
  ru: '\u{1F1F7}\u{1F1FA}', en: '\u{1F1EC}\u{1F1E7}', de: '\u{1F1E9}\u{1F1EA}',
  uz: '\u{1F1FA}\u{1F1FF}', fr: '\u{1F1EB}\u{1F1F7}', es: '\u{1F1EA}\u{1F1F8}',
  it: '\u{1F1EE}\u{1F1F9}', pt: '\u{1F1F5}\u{1F1F9}', tr: '\u{1F1F9}\u{1F1F7}',
};

// ── Language keyboard builder ──

export function buildLangKeyboard(langs: string[]) {
  const kb = new InlineKeyboard();
  for (const l of langs) {
    const flag = LANG_FLAGS[l] || l.toUpperCase();
    kb.text(`${flag} ${l}`, `lang:${l}`);
  }
  return kb;
}
