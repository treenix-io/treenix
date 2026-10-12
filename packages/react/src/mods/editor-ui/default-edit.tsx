import { NativeSchemaFields } from '#editor/NativeSchemaFields';
import { type ComponentData, register } from '@treenx/core';
import type { View } from '#context';

/** Native forms obtain schema through the actual selected caller instead of the legacy registry. */
const DefaultEditForm: View<ComponentData> = props => {
  return <NativeSchemaFields value={props.value} onChange={(name, value) => props.onChange?.({ [name]: value })} />;
};

register('default', 'react:edit', DefaultEditForm);
// Inspector props drawer renders under 'react:edit:props' (ComponentSection). Without this exact
// default, resolve strips ':props' and full-page react:edit views (kanban, canvas) leak into the drawer.
register('default', 'react:edit:props', DefaultEditForm);
