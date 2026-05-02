// Server-safe site views for landing.* — render to plain divs/headings.
// .ts (no JSX) so the Node-side mod loader can pick this up via tsx.

import { createElement } from 'react';
import { register } from '@treenx/core';
import { useChildren } from '@treenx/react/hooks';
import { Render } from '@treenx/react/context';
import {
  LandingPage,
  LandingHeader,
  LandingHero,
  LandingDivider,
  LandingFeatures,
  LandingText,
  LandingCta,
} from './types';

const LandingPageView = ({ value, ctx }: { value: { title?: string }; ctx: { path: string } }) => {
  const { data: kids } = useChildren(ctx.path);
  return createElement('main', { className: 'landing' },
    createElement('h1', null, value.title ?? ''),
    createElement('div', { className: 'landing-blocks' },
      ...kids.map(child => createElement(Render, { key: child.$path, value: child })),
    ),
  );
};
register(LandingPage, 'site', LandingPageView);

const LandingHeaderView = ({ value }: { value: { title?: string } }) =>
  createElement('header', { className: 'landing-header' },
    createElement('h2', null, value.title ?? ''));
register(LandingHeader, 'site', LandingHeaderView);

const LandingHeroView = ({ value }: { value: { title?: string; subtitle?: string; ctaLabel?: string; ctaUrl?: string } }) =>
  createElement('section', { className: 'landing-hero' },
    createElement('h1', null, value.title ?? ''),
    createElement('p', null, value.subtitle ?? ''),
    value.ctaUrl ? createElement('a', { href: value.ctaUrl }, value.ctaLabel ?? '') : null,
  );
register(LandingHero, 'site', LandingHeroView);

const LandingDividerView = () => createElement('hr', { className: 'landing-divider' });
register(LandingDivider, 'site', LandingDividerView);

const LandingFeaturesView = ({ value }: { value: { items?: { title: string; body: string }[] } }) =>
  createElement('section', { className: 'landing-features' },
    ...(value.items ?? []).map((it, i) => createElement('div', { key: i, className: 'feature' },
      createElement('h3', null, it.title),
      createElement('p', null, it.body),
    )),
  );
register(LandingFeatures, 'site', LandingFeaturesView);

const LandingTextView = ({ value }: { value: { body?: string } }) =>
  createElement('section', { className: 'landing-text' },
    createElement('p', null, value.body ?? ''));
register(LandingText, 'site', LandingTextView);

const LandingCtaView = ({ value }: { value: { label?: string; url?: string } }) =>
  createElement('section', { className: 'landing-cta' },
    value.url ? createElement('a', { href: value.url, className: 'cta-button' }, value.label ?? '') : null,
  );
register(LandingCta, 'site', LandingCtaView);
