import { declareClientType } from '@treenx/core/comp/client-declaration';
import { declareOpenModule } from '@treenx/core/kernel/module-declaration';

// Legacy types — kept for schema compatibility, no active code references.
// TODO: remove once existing data is migrated.

/** Reusable prompt template for quick task creation */
export class MetatronTemplate {
  name = '';
  /** @format textarea */
  prompt = '';
  category = '';
}

/** Modular prompt fragment — learned skill or injected capability */
export class MetatronSkill {
  name = '';
  /** @format textarea */
  prompt = '';
  enabled = true;
  category = '';
  updatedAt = 0;
}

const declaredMetatronTemplate = declareClientType('metatron.template', MetatronTemplate);
const declaredMetatronSkill = declareClientType('metatron.skill', MetatronSkill);

export const clientModules = [
  declareOpenModule(
    '@treenx/mods/metatron/types',
    [],
    [declaredMetatronTemplate, declaredMetatronSkill],
  ),
];
