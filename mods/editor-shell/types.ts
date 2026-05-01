// t.editor.shell — admin route node. Marker type; the React view registered
// for 'react' context renders the tree editor. Mounted at /sys/routes/t with
// a wildcard route component so URLs like /t/foo/bar resolve here.

import { registerType } from '@treenx/core/comp';

/** Admin shell route node. */
export class EditorShell {}

registerType('t.editor.shell', EditorShell);
