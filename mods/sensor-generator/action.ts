// Sensor generator demo — on-demand scan that streams N readings via generator action

import { registerType } from '@treenx/core/comp';

/** On-demand sensor reading generator — streams N readings via generator action. */
export class DemoGenerator {}
registerType('examples.demo.generator', DemoGenerator);
