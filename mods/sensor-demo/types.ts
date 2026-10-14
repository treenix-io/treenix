import { declareClientType } from '@treenx/core/comp/client-declaration';
import { declareOpenModule } from '@treenx/core/kernel/module-declaration';

/** @description Fake sensor that generates readings around a base value */
export class SensorDemo {
  baseValue = 20;

  /** @description Set the base value around which readings oscillate */
  async setBase(data: { /** Base temperature */ value: number }) {
    this.baseValue = data.value;
  }
}
const declaredExamplesDemoSensor = declareClientType('examples.demo.sensor', SensorDemo);

/** @description A single sensor reading data point */
export class SensorReading {
  ts = 0;
  value = 0;
  seq = 0;
}
const declaredExamplesDemoSensorReading = declareClientType(
  'examples.demo.sensor.reading',
  SensorReading,
);

export const clientModules = [
  declareOpenModule(
    '@treenx/mods/sensor-demo/types',
    [],
    [declaredExamplesDemoSensor, declaredExamplesDemoSensorReading],
  ),
];
