import { clientModules as editor } from './editor-ui/client';
import { clientModules as treenix } from './treenix/client';
import { clientModules as uix } from './uix/client';

export const clientModules = [...editor, ...treenix, ...uix];
