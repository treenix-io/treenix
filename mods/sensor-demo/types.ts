import { registerType } from '@treenx/core/comp';

/** @description Fake sensor that generates readings around a base value */
export class SensorDemo {
  baseValue = 20;

  /** @description Set the base value around which readings oscillate */
  async setBase(data: { /** Base temperature */ value: number }) {
    this.baseValue = data.value;
  }
}
registerType('examples.demo.sensor', SensorDemo);

/** @description A single sensor reading data point */
export class SensorReading {
  ts = 0;
  value = 0;
  seq = 0;
}
registerType('examples.demo.sensor.reading', SensorReading);
