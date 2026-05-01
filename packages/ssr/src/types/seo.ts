// t.seo — page metadata for SSR-rendered nodes (title, description, OG, JSON-LD).
// Route-node seo wins over target-node seo — see SSR design spec §SEO Precedence.

import { registerType } from '@treenx/core/comp';

/** Page metadata for SSR. Title required; everything else optional. */
export class Seo {
  /** Page title. Required — empty title produces blank crawler results. */
  title = '';
  /** Meta description, ~160 chars max. */
  description?: string;
  /** Absolute or root-relative URL. https? or /... only — validated at SSR boundary. */
  image?: string;
  /** Alt text for og:image. */
  imageAlt?: string;
  /** Canonical URL. Same protocol allow-list as `image`. */
  canonical?: string;
  /** Robots directive. */
  robots?: 'index,follow' | 'noindex,follow' | 'noindex,nofollow';
  /** OpenGraph type. */
  type?: 'website' | 'article';
  /** BCP-47 language tag, e.g. 'en', 'en-US'. */
  locale?: string;
  /** JSON-LD structured data, embedded as <script type="application/ld+json">. */
  jsonLd?: Record<string, unknown>;
}

registerType('t.seo', Seo);
