import { clientModules as siteDeclarations } from '@treenx/ssr/types/site';
import { clientModules as seoDeclarations } from '@treenx/ssr/types/seo';
import { clientModules as editor } from './editor-ui/client';
import { clientModules as treenix } from './treenix/client';
import { clientModules as uix } from './uix/client';

export const clientModules = [
  ...siteDeclarations,
  ...seoDeclarations,
  ...editor,
  ...treenix,
  ...uix,
];
