import { clientModules as siteDeclarations } from '@treenx/ssr/types/site';
import { clientModules as seoDeclarations } from '@treenx/ssr/types/seo';
// The SSR ref renderer is declared independently of browser editor widgets.
import refViews from './treenix/ref-view';

export const clientModules = [...siteDeclarations, ...seoDeclarations, refViews];
