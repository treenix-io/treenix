import { registerType } from '@treenx/core/comp';

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

registerType('metatron.template', MetatronTemplate);
registerType('metatron.skill', MetatronSkill);
