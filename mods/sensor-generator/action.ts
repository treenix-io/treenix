// Sensor generator demo — on-demand scan that streams N readings via generator action

import { declareClientType } from '@treenx/core/comp/client-declaration';
import { declareOpenModule } from '@treenx/core/kernel/module-declaration';

/** On-demand sensor reading generator — streams N readings via generator action. */
export class DemoGenerator {}
export const clientModules = [
  declareOpenModule(
    '@treenx/mods/sensor-generator/types',
    [],
    [declareClientType('examples.demo.generator', DemoGenerator)],
  ),
];
