import { declareClientType } from '@treenx/core/comp/client-declaration';
import { declareOpenModule } from '@treenx/core/kernel/module-declaration';
// t.editor.shell — admin route node. Marker type; the React view registered
// for 'react' context renders the tree editor. Mounted at /sys/routes/t with
// a wildcard route component so URLs like /t/foo/bar resolve here.



/** Admin shell route node. */
export class EditorShell {}

const declaredTEditorShell = declareClientType('t.editor.shell', EditorShell);

export const clientModules = [declareOpenModule('@treenx/mods/editor-shell/types', [], [
  declaredTEditorShell,
])];
