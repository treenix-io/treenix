import { declareClientType } from '@treenx/core/comp/client-declaration';
import { declareOpenModule } from '@treenx/core/kernel/module-declaration';
import { registerType } from '@treenx/core/comp';

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

registerType('canary.item', CanaryItem);

export const clientModules = [declareOpenModule('@treenx/mods/canary/types', [], [
  declareClientType('canary.item', CanaryItem),
])];
