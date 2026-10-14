import { declareClientType } from '@treenx/core/comp/client-declaration';
import { declareOpenModule } from '@treenx/core/kernel/module-declaration';

export class CanaryItem {
  value = 0;
  label = 'canary';

  increment() {
    this.value += 1;
  }

  setLabel(data: { label: string }) {
    this.label = data.label;
  }
}

const declaredCanaryItem = declareClientType('canary.item', CanaryItem);

export const clientModules = [
  declareOpenModule('@treenx/mods/canary/types', [], [declaredCanaryItem]),
];
