// Test data for OXC schema extraction — covers all AST patterns
import { registerType } from '#comp';

type HistoryEntry = {
  action: string;
  actor: string;
  ts: number;
};

// Numeric enum (auto-incrementing) + explicit start
enum Level {
  Low,
  Medium,
  High,
}
enum Rank {
  First = 1,
  Second,
  Third,
}

// String enum where member names match values (enumNames should be omitted)
enum Color {
  red = 'red',
  green = 'green',
  blue = 'blue',
}

// String enum where names differ from values (enumNames emitted for UI labels)
enum Direction {
  North = 'N',
  South = 'S',
  East = 'E',
  West = 'W',
}

/**
 * A complex widget for testing schema extraction.
 * Covers class, property, and method metadata used by the catalog.
 */
class SchemaTestWidget {
  // Primitives (inferred from initializer)
  title = '';
  count = 0;
  enabled = true;

  // Primitives (explicit annotation)
  label: string = 'default';
  size: number = 42;
  visible: boolean = false;

  // Union enum
  status: 'draft' | 'active' | 'archived' = 'draft';
  priority: 'low' | 'medium' | 'high' = 'medium';

  // Numeric literal union — should collapse to { type: 'number', enum: [...] }
  trustLevel: 0 | 1 | 2 | 3 | 4 = 2;

  // TS enum declarations
  level: Level = Level.Medium;
  rank: Rank = Rank.First;
  color: Color = Color.red;
  direction: Direction = Direction.North;

  // Arrays
  tags: string[] = [];
  scores: number[] = [];
  items: { name: string; value: number }[] = [];

  // Optional
  description?: string;
  metadata?: { key: string; data: unknown };

  // Inline object
  config: { color: string; opacity: number; nested: { x: number; y: number } } = {
    color: 'blue',
    opacity: 1,
    nested: { x: 0, y: 0 },
  };

  // Default values
  defaultArr: string[] = ['a', 'b'];
  defaultObj: { x: number } = { x: 10 };

  // Generic array syntax
  history: Array<string> = [];

  // Record type
  attrs: Record<string, unknown> = {};

  // Boolean union (should collapse to { type: 'boolean' })
  flag: true | false = true;

  // Nullable (string | undefined → string)
  nickname: string | undefined;

  // Mixed union (anyOf)
  value: string | number = '';

  // bigint
  bigId: bigint = 0n;

  // Date types
  /** @format date-time */
  createdAt: string = '';
  /** @format date */
  birthday: string = '';
  dueDate?: Date;

  /** @format email */
  email = '';

  /** Contact phone number
   * @format tel */
  phone = '';

  /** @title Display Name @description The human-readable name shown in UI */
  displayName = 'Widget';

  /** @hidden */
  internalSecret = 'x';

  /** @refType test.schema-widget */
  linkedWidget?: string;

  /** @format textarea */
  notes = '';

  /** @format path */
  targetPath = '';

  /** @format tags */
  categories: string[] = [];

  /** @format color */
  accentColor = '#ff0000';

  /** @format uri */
  homepage = '';

  /** @format password */
  apiKey = '';

  // Array of type alias — tests that local `type X = {...}` gets resolved
  changelog: HistoryEntry[] = [];

  /**
   * Widget action — increment the counter.
   * Adds one vote to the current count.
   * @pre count
   * @post count
   */
  increment() {}

  /**
   * Set the title.
   * Validates that the new title is non-empty
   * and updates the display name accordingly.
   */
  rename(newTitle: string) {}

  /**
   * Add a tag with optional priority.
   * Duplicates are silently ignored.
   * @description Appends tag to the list
   */
  addTag(tag: string, prio: number) {}

  /** Bulk update configuration */
  configure(opts: { /** CSS color value */ color?: string; /** 0-1 range */ opacity?: number }) {}

  /**
   * Stream live updates.
   * Returns an async generator that yields
   * serialized event strings.
   */
  async *watch(filter: string): AsyncGenerator<string> {
    yield '';
  }

  /**
   * Reset all counters to zero.
   * @pre count scores
   * @post count scores tags
   * @description Clears all accumulated data
   */
  reset() {}

  /**
   * Archive the widget.
   * @pre status
   * @post status
   */
  archive() {}

  /** @description Internal method, hidden from schema */
  _cleanup() {}
}

registerType('test.schema-widget', SchemaTestWidget);

/** Exported class fixture for JSDoc extraction. */
export class ExportedSchemaTestWidget {
  name = '';
}

registerType('test.exported-schema-widget', ExportedSchemaTestWidget);
