import { registerType } from '@treenx/core/comp';

/** Treenix tree and type-catalog tools exposed through the generic MCP adapter. */
export class TreenixMcpTools {
  /** @description Read a node by path. Returns full untruncated values. */
  get_node(_data: {
    /** @description Node path to read. */
    path: string;
  }) {}

  /** @description List children of a node. Long string values may be truncated; use get_node for full data. */
  list_children(_data: {
    /** @description Parent node path. */
    path: string;
    /** @description Recursive depth for child traversal. */
    depth?: number;
    /** @description Include first-level fields and component types. */
    detail?: boolean;
    /** @description Return complete YAML for each child node. */
    full?: boolean;
  }) {}

  /** @write @description Create or update a node. May require Guardian approval. */
  set_node(_data: {
    /** @description Node path to create or update. */
    path: string;
    /** @description Primary node type. */
    type: string;
    /** @description Fields and named components to merge into the node. */
    components?: Record<string, unknown>;
    /** @description Access-control entries for the node. */
    acl?: Array<{
      /** @description Group or subject id. */
      g: string;
      /** @description Permission bitmask. */
      p: number;
    }>;
    /** @description Owner user id for owner ACL rules. */
    owner?: string;
  }) {}

  /** @write @description Execute an action on a node or component. Actions are methods registered on types. May require Guardian approval. */
  execute(_data: {
    /** @description Node path that owns the action target. */
    path: string;
    /** @description Registered action method name. */
    action: string;
    /** @description Component type override when executing a component action. */
    type?: string;
    /** @description Named component key when the node stores multiple components of a type. */
    key?: string;
    /** @description Action input payload. */
    data?: Record<string, unknown>;
  }) {}

  /** @write @description Deploy a module prefab to a target path. Idempotent: skips existing nodes. */
  deploy_prefab(_data: {
    /** @description Prefab source path or module-prefab id. */
    source: string;
    /** @description Destination path where prefab nodes are deployed. */
    target: string;
    /** @description Allow absolute source paths. */
    allowAbsolute?: boolean;
  }) {}

  /** @description Verify that a UIX view source compiles correctly. */
  compile_view(_data: {
    /** @description View node path to compile when source is omitted. */
    path?: string;
    /** @description Raw UIX source to compile directly. */
    source?: string;
  }) {}

  /** @write @description Remove a node by path. May be denied by Guardian. */
  remove_node(_data: {
    /** @description Node path to remove. */
    path: string;
  }) {}

  /** @description List all registered types with compact descriptions plus property/action docs. */
  catalog() {}

  /** @description Get full schema of a type: properties, actions, and cross-references. */
  describe_type(_data: {
    /** @description Type id to describe. */
    type: string;
  }) {}

  /** @description Search types by keyword across names, titles, property names, and action names. */
  search_types(_data: {
    /** @description Search query text. */
    query: string;
  }) {}
}
registerType('mcp.treenix', TreenixMcpTools);
