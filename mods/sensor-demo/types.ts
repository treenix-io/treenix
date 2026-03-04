import { registerType } from '@treenity/core/comp';

/** @description Fake sensor that generates readings around a base value */
export class SensorDemo {
  baseValue = 20;

  /** @description Set the base value around which readings oscillate */
  async setBase(data: { /** Base temperature */ value: number }) {
    this.baseValue = data.value;
  }
}
registerType('examples.demo.sensor', SensorDemo);
