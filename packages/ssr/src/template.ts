// HTML shell + escape utilities for the SSR pipeline.
//
// Why each escape exists:
//   escape       — text inside an element. Blocks <script>alert</script> in titles.
//   escapeAttr   — value inside double-quoted attribute. Same set + " escape.
//   escapeUrl    — href/src/og:image. Allow-lists protocols (https?, root-rel).
//   escapeJson   — JSON inside <script type="application/json"|application/ld+json>.
//                  Escapes the closing-tag-and-paragraph-separator triplet so a
//                  hostile JSON value can't break out.

import type { SiteMode } from './types/site';
import type { Seo } from './types/seo';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escape(s: string): string {
  return s.replace(/[&<>"']/g, c => HTML_ESCAPES[c]);
}

/** Same as escape — kept as a separate name to make intent explicit at callsites. */
export function escapeAttr(s: string): string {
  return escape(s);
}

/** Allow only https?: and root-relative URLs (`/...`). Anything else → empty
 *  string, which collapses the meta/link tag to a harmless empty value. */
export function escapeUrl(s: string | undefined | null): string {
  if (!s) return '';
  const trimmed = String(s).trim();
  if (trimmed.startsWith('https://') || trimmed.startsWith('http://') || trimmed.startsWith('/')) {
    return escape(trimmed);
  }
  return '';
}

/** Escape JSON for embedding inside a `<script>` tag.
 *  - `</` → `<\/` (avoid premature `</script>` close).
 *  - U+2028 / U+2029 → `\u2028` / `\u2029` (JSON allows them; JS parsers don't). */
export function escapeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/<\//g, '<\\/')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// ── HTML shell ──

type ShellInput = {
  /** rendered body markup (already a HTML fragment, no <html>/<head>). */
  html: string;
  /** Tailwind CSS for this page (inlined under <style id="tnx-tw-jit">). */
  css: string;
  /** SEO metadata. May be undefined for nodes without t.seo. */
  seo: Seo | undefined;
  mode: SiteMode;
  /** JSON snapshot for hydrate mode; ignored for static. */
  initialState?: unknown;
  /** When true, append @tailwindcss/browser CDN for runtime classes. */
  tailwindRuntime: boolean;
  /** Banner shown only when ?preview=1 + admin. */
  isPreview: boolean;
  /** URL of the hydrate entry script (only used when mode='hydrate'). */
  hydrateScriptUrl?: string;
};

const TAILWIND_CDN = 'https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4';
const BODY_HEAD_HINT =
  /<link\b(?=[^>]*\brel=(["']?)(?:preload|preconnect|dns-prefetch|modulepreload)\1)[^>]*>/gi;

export function extractBodyHeadHints(html: string): { body: string; headHints: string[] } {
  const headHints: string[] = [];
  const body = html.replace(BODY_HEAD_HINT, (tag) => {
    headHints.push(tag);
    return '';
  });
  return { body, headHints };
}

export function buildHtmlShell({
  html,
  css,
  seo,
  mode,
  initialState,
  tailwindRuntime,
  isPreview,
  hydrateScriptUrl,
}: ShellInput): string {
  const rendered = extractBodyHeadHints(html);
  const title = escape(seo?.title ?? '');
  const description = seo?.description ? `<meta name="description" content="${escapeAttr(seo.description)}" />` : '';
  const canonical = seo?.canonical ? `<link rel="canonical" href="${escapeUrl(seo.canonical)}" />` : '';
  // Preview always forces noindex regardless of seo.robots.
  const robots = isPreview
    ? '<meta name="robots" content="noindex,nofollow" />'
    : (seo?.robots ? `<meta name="robots" content="${seo.robots}" />` : '');
  const ogTitle = title ? `<meta property="og:title" content="${escapeAttr(seo!.title)}" />` : '';
  const ogImage = seo?.image ? `<meta property="og:image" content="${escapeUrl(seo.image)}" />` : '';
  const ogImageAlt = seo?.imageAlt ? `<meta property="og:image:alt" content="${escapeAttr(seo.imageAlt)}" />` : '';
  const ogType = seo?.type ? `<meta property="og:type" content="${seo.type}" />` : '';
  const jsonLd = seo?.jsonLd ? `<script type="application/ld+json">${escapeJson(seo.jsonLd)}</script>` : '';
  const lang = seo?.locale ? escapeAttr(seo.locale) : 'en';
  const tailwindCdn = tailwindRuntime ? `<script src="${TAILWIND_CDN}"></script>` : '';
  const headHints = rendered.headHints.join('\n');
  const initialJson = mode === 'hydrate' && initialState !== undefined
    ? `<script type="application/json" id="treenix-initial">${escapeJson(initialState)}</script>`
    : '';
  const hydrateScript = mode === 'hydrate' && hydrateScriptUrl
    ? `<script type="module" src="${escapeUrl(hydrateScriptUrl)}"></script>`
    : '';
  const previewBanner = isPreview
    ? '<div data-treenix-preview style="position:fixed;top:0;left:0;right:0;background:#facc15;color:#000;padding:4px 12px;font:12px monospace;z-index:9999">Preview (draft)</div>'
    : '';

  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1.0" />
<title>${title}</title>
${description}
${canonical}
${robots}
${ogTitle}
${ogImage}
${ogImageAlt}
${ogType}
${jsonLd}
<style id="tnx-tw-jit">${css}</style>
${tailwindCdn}
${headHints}
</head>
<body>
${previewBanner}
<div id="root" data-treenix-mode="${mode}">${rendered.body}</div>
${initialJson}
${hydrateScript}
</body>
</html>`;
}
