// landing.* — minimal types for SSR-able marketing pages.
// Bare types, no behavior; views render the data.

import { registerType } from '@treenx/core/comp';

export class LandingPage {
  title = '';
  description = '';
}
registerType('landing.page', LandingPage);

export class LandingHeader {
  title = '';
}
registerType('landing.header', LandingHeader);

export class LandingHero {
  title = '';
  subtitle = '';
  ctaLabel = '';
  ctaUrl = '';
}
registerType('landing.hero', LandingHero);

export class LandingDivider {}
registerType('landing.divider', LandingDivider);

export class LandingFeatures {
  items: { title: string; body: string }[] = [];
}
registerType('landing.features', LandingFeatures);

export class LandingText {
  body = '';
}
registerType('landing.text', LandingText);

export class LandingCta {
  label = '';
  url = '';
}
registerType('landing.cta', LandingCta);
