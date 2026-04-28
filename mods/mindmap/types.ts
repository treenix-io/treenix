import { registerType } from '@treenx/core/comp';

/** @description Mind map visualization — radial tree of Treenix nodes */
export class MindMapConfig {
  /** Root path to visualize (empty = this node's path) */
  root = '';
  /** Max children per expanded level */
  maxChildren = 50;
}
registerType('mindmap.map', MindMapConfig);
