import './types';
import './view';
// Metatron seeds ai.agent nodes — agent mod must be loaded for types/views
import { clientModules as declaredClient0 } from '../agent/view';

export const clientModules = [...declaredClient0];
