import type { ComponentData, NodeData } from '@treenx/core';
import type { Component, ComputedNode, Node } from '@treenx/core/kernel/types';

/** Present each source's exact metadata without translating permissions or revisions. */
export type PresentationNode = NodeData | Node | ComputedNode;
export type PresentationComponent = ComponentData | Component | PresentationNode;
