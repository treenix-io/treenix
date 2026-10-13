import { clientModules as declaredOwner0 } from './types';
import { clientModules as declaredOwner1 } from '../agent/types';
import './types';
import './view';
// Metatron seeds ai.agent nodes — agent mod must be loaded for types/views
import { clientModules as declaredClient0 } from '../agent/view';

export const clientModules = [...declaredOwner0, ...declaredOwner1, ...declaredClient0];
