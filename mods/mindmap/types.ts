import { declareClientType } from '@treenx/core/comp/client-declaration';
import { declareOpenModule } from '@treenx/core/kernel/module-declaration';


/** @description Mind map visualization — radial tree of Treenix nodes */
export class MindMapConfig {
  /** Root path to visualize (empty = this node's path) */
  root = '';
  /** Max children per expanded level */
  maxChildren = 50;
}
const declaredMindmapMap = declareClientType('mindmap.map', MindMapConfig);

export const clientModules = [declareOpenModule('@treenx/mods/mindmap/types', [], [
  declaredMindmapMap,
])];
