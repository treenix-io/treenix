// Kernel interfaces derived from docs/engine/axioms.md.
// Every export follows from a definition, axiom or theorem there; the mapping table
// closes that document. Types and limit constants only — no behaviour lives here.

// ---- Paths, identity, positions ----

/** Absolute address, '/'-separated; '/' is the root. The tree is the prefix order on paths. */
export type Path = string

/**
 * Kernel-issued identity: never reused and unique across instances of one trust zone — the lane's id set
 * and the client cache hold nodes of different mount targets, shard nodes included, by id; federation ids
 * are mapped into the mount point's namespace. Files without an id inside have path identity `p:<logical path>`, never written into the file.
 */
export type NodeId = string

export type TypeName = string
/** `''` is the main component (node-level fields); other names are `#name` keys. */
export type ComponentName = string
export type ActionName = string
export type ModuleId = string
/** Transaction domain: a DB cluster, an fs directory, process memory. */
export type DomainId = string
export type InstanceId = string

/**
 * The position of the commit that wrote this state (`$pos`), serialized; compared for equality only. Equal
 * `$rev` for one `$id` means equal accepted content: an undetected external edit enters the order when detected.
 */
export type Rev = string

/**
 * Fractional index: allows insertion between neighbours without renumbering. Keys compare bytewise — Mongo sorts
 * `$order` under the simple collation, Postgres under COLLATE "C"; a locale collation breaks the order.
 */
export type OrderKey = string

/** Total order of commits inside one instance; positions of different instances are incomparable. */
export interface Position {
  readonly instance: InstanceId
  /** New and never used whenever the writer cannot confirm the counter survived (restore from backup). */
  readonly epoch: number
  readonly seq: number
}

// ---- Rights and actors ----

export const R = 1
export const W = 2
export const A = 4
/** Bitmask of R, W, A. R: read and subscribe. W: write and ordinary actions. A: `$acl` and `$owner`. */
export type Bits = number

/** Principal kinds are reserved groups: each is assigned only to its own principal. */
export type Principal = `u:${NodeId}` | `n:${NodeId}` | `anon:${string}`
export type Group = string
/** Kernel operations and accepted external edits are journaled under these; neither is an ACL subject. */
export type Executor = Principal | 'kernel' | `external:${string}`

/** A group from the actor's claims, or the owner: the nearest `$owner` at the entry's node or above. */
export type Subject = { readonly group: Group } | { readonly owner: true }

/**
 * A right exists only with an applicable grant and no applicable deny. Denies are sticky
 * downwards and do not bind an actor holding A on a strict ancestor of the entry's node.
 */
export type AclEntry =
  | { readonly subject: Subject; readonly grant: Bits }
  | { readonly subject: Subject; readonly deny: Bits }

/** Fixed for the life of a lane: any change of account or credential closes the lane. */
export interface Actor {
  readonly principal: Principal
  /** Always contains the principal itself. */
  readonly claims: readonly Group[]
  /** Mask on every bit: outside these subtrees the actor has no R, W or A. Carried by the credential. */
  readonly scope?: readonly Path[]
}

/** Server-issued and opaque. An anonymous credential carries its stable `anon:` id. */
export interface Credential {
  readonly token: string
}

// ---- Nodes and components ----

export interface Component {
  readonly $type: TypeName
  readonly $order?: OrderKey
  /** Schema version of the component's type; absent means 0. Migrations are chosen by it. */
  readonly $v?: number
  readonly [field: string]: unknown
}

export interface NodeMeta {
  readonly $path: Path
  readonly $id: NodeId
  /** Immutable: another type is another object (delete + create). */
  readonly $type: TypeName
  readonly $rev: Rev
  readonly $order?: OrderKey
  /** Visible only to A-holders. */
  readonly $acl?: readonly AclEntry[]
  /** Visible only to A-holders; the kernel never assigns it. */
  readonly $owner?: Principal
  /** Schema version of the main component. */
  readonly $v?: number
}

type Fields = { readonly [field: string]: unknown } & { readonly [name: `#${string}`]: Component }

/** Main component = node-level fields without `$`/`#` keys; named components live under `#name`. */
export type Node = NodeMeta & Fields

/**
 * Write input, always the current shape: `$id` and `$rev` are assigned by the kernel. `$v`, on the
 * node or a component, is stamped by the kernel; a value other than the current version is rejected.
 */
export type NodeInput = Omit<NodeMeta, '$id' | '$rev'> & { readonly $id?: never; readonly $rev?: never } & Fields

/** Changes with `$rev`, bits, `$acl`/`$owner` visibility, and rule or migration versions. */
export type ProjectionVersion = string

/** Node of a View computed by a node executor: the content is declassified, the rights are not. */
export type ComputedNode = Omit<NodeMeta, '$acl' | '$owner'> & { readonly $acl?: never; readonly $owner?: never } & Fields

/** A node as one executor sees it: without `$acl`/`$owner` unless A, with the executor's bits. */
export type NodeCopy =
  | { readonly node: Node; readonly bits: Bits; readonly ver: ProjectionVersion }
  /**
   * A visible node breaking its schema: only it fails, loudly, and admin is alerted; a valid state later
   * arrives as `put`. Filters, sorts and windows see its stored fields without migration; `sort` carries the
   * stored values of the sort fields, so the client can place it.
   */
  | {
      readonly id: NodeId
      readonly path: Path
      readonly error: KernelError
      readonly sort?: { readonly [field: string]: unknown }
      readonly ver: ProjectionVersion
    }

// ---- Selectors ----

/**
 * sift query without `$regex` and code, with primitive comparison operands (`$elemMatch` reaches objects in
 * arrays); its work is counted per operation (A10). Hidden fields are not addressable.
 */
export type Where = { readonly [key: string]: unknown }
export type Sort = readonly (readonly [field: string, direction: 1 | -1])[]
export type Cursor = string

export interface Window {
  readonly after?: Cursor
  readonly limit: number
  /**
   * Subscriptions only: while the range holds more than `limit` nodes or a lane coverage overflow is charged
   * to this window (it covers a node that entered or grew), the last by sort order that no other subscription
   * of the lane covers leaves the list, and the range boundary moves to the new last. Growth of other
   * subscriptions never narrows it; the window never widens back. Without it, a charged overflow ends the
   * subscription.
   */
  readonly evict?: true
}

/** Delivered with the result; chains are bounded by the include depth. */
export type IncludeSpec =
  | { readonly path: Path }
  | { readonly ref: string; readonly then?: readonly IncludeSpec[] }

/**
 * Default order of children and components: (`$order`, name). Anything richer is a View; a query in
 * the mount target's own language is a `@read` action of its module, not a selector.
 */
export type Selector =
  | { readonly node: Path; readonly include?: readonly IncludeSpec[] }
  /**
   * In a subscription the window becomes a (sort key, path) range at snapshot, up to the key of its last
   * element, which the kernel keeps; the client sorts and slices, and fetches the next page with a cursor.
   */
  | {
      readonly children: Path
      readonly where?: Where
      readonly sort?: Sort
      readonly window?: Window
      readonly include?: readonly IncludeSpec[]
    }
  /** Journal records touching the path or its descendants; visible only to current A-holders. Read-only: a live history is a View. */
  | { readonly history: Path; readonly after?: Position; readonly window?: Window }

export type SubSelector = Exclude<Selector, { readonly history: Path }>

export interface JournalAddress {
  readonly pos: Position
  readonly id: NodeId
}

export interface HistoryEntry {
  readonly address: JournalAddress
  readonly path: Path
  readonly executor: Executor
  readonly caller: Executor
  readonly opId?: OpId
  /** A reconciliation may not know the previous state. */
  readonly before: Node | null | 'unknown'
  readonly after: Node | null
}

/** Synthetic element of a View result, such as an aggregate: not a node, so no `$id`. The key is stable within a result. */
export interface Row {
  readonly key: string
  readonly [field: string]: unknown
}

export interface ReadResult {
  /** Members; the client orders them by the sort key. */
  readonly list: readonly NodeId[]
  /** Members and included nodes. */
  readonly copies: readonly NodeCopy[]
  /** Nodes of a View computed by a node executor, outside the lane. */
  readonly computed?: readonly ComputedNode[]
  readonly rows?: readonly Row[]
  readonly history?: readonly HistoryEntry[]
  /** One per instance whose domains were read: every commit of those domains up to it is reflected. */
  readonly at: readonly Position[]
  readonly next?: Cursor
}

// ---- ChangeSet ----

/** Update operators of pre/post and of `patch`. */
export interface UpdateOps {
  readonly $set?: { readonly [field: string]: unknown }
  readonly $unset?: { readonly [field: string]: true }
  readonly $inc?: { readonly [field: string]: number }
  readonly $push?: { readonly [field: string]: unknown }
}

/**
 * Applied in order. `remove` and `move` act on a whole subtree inside its own Store and stop at
 * mount points; every affected descendant counts toward the ChangeSet budget, so a larger subtree
 * goes by a loop of commits or as a mount. `move` onto an occupied address is rejected — replacing
 * is an explicit `remove` first. `restore` recreates one record's before-image with its `$id`.
 */
export type ChangeMember =
  /** Hidden `$acl`/`$owner` survive a full write by an executor without A. Another type on an occupied address is rejected. */
  | { readonly op: 'put'; readonly node: NodeInput }
  | { readonly op: 'patch'; readonly path: Path; readonly ops: UpdateOps }
  | { readonly op: 'remove'; readonly path: Path }
  | { readonly op: 'move'; readonly from: Path; readonly to: Path }
  | { readonly op: 'restore'; readonly record: JournalAddress }

/**
 * What the caller read; the commit fails with CONFLICT if any of it changed. Evaluated in the
 * executor's projection: an invisible node counts as absent.
 */
export interface Preconditions {
  readonly nodes?: readonly { readonly path: Path; readonly rev: Rev }[]
  readonly absent?: readonly Path[]
  readonly selectors?: readonly { readonly selector: Selector; readonly at: readonly Position[] }[]
}

/** Idempotency key part. The key is (caller, opId); a replay with the same request returns the original outcome. */
export interface OpId {
  /**
   * Mutation-intake epoch announced by the instance; it includes the intake epochs of the instance's shards,
   * and a new one opens on any loss of decisions there or here.
   */
  readonly epoch: string
  /** Client time, ms: at first intake at most the clock tolerance ahead of server time. */
  readonly time: number
  readonly nonce: string
}

// ---- Errors ----

export type ErrorCode =
  /** Absent, or invisible to the executor — the two are indistinguishable. */
  | 'NOT_FOUND'
  /** The node is visible, the right is missing. */
  | 'FORBIDDEN'
  /** Preconditions changed, or the name is taken. */
  | 'CONFLICT'
  /** Schema or argument validation failed. */
  | 'INVALID'
  | 'UNKNOWN_TYPE'
  /** A ChangeSet touches two transaction domains. */
  | 'CROSS_DOMAIN'
  /** A View: writes address its sources. */
  | 'READ_ONLY'
  | 'BUDGET'
  /** A gate refused. */
  | 'REFUSED'
  /**
   * The key's outcome is unknown: its intake epoch's decisions are lost, or a stream started under it has
   * not finished. Re-execution is forbidden.
   */
  | 'UNKNOWN_OUTCOME'
  /** The key is older than the expiry boundary, or its time is too far ahead. */
  | 'EXPIRED'
  /** The key was used by a different request or actor; the original executed, its outcome is withheld. */
  | 'KEY_REUSED'
  /** An unreachable Authority. */
  | 'UNAVAILABLE'
  /** Shard runs another module set (digest differs). */
  | 'GENERATION'
  | 'CANCELLED'
  /** The credential is invalid or expired: sign in again. */
  | 'UNAUTHENTICATED'

export interface KernelError {
  readonly code: ErrorCode
  readonly message: string
}

// ---- Wire protocol (TWP); bindings only translate the format ----

export type SubId = string
export type RequestId = string
export type Generation = number

export interface CacheClaim {
  readonly id: NodeId
  readonly ver: ProjectionVersion
}

export type Request =
  /**
   * Opens a lane — a reconnect is a new lane; claims let the new snapshots skip visible nodes with an
   * unchanged version, except nodes of `trusted` Stores, which are always sent whole. Without a credential
   * the server issues an anonymous one in `welcome`.
   */
  | {
      readonly t: 'hi'
      readonly credential?: Credential
      readonly cache?: readonly CacheClaim[]
    }
  | { readonly t: 'read'; readonly req: RequestId; readonly selector: Selector }
  /** Answered by `snap`; a refusal, now or later, arrives as `end`. */
  | { readonly t: 'sub'; readonly sub: SubId; readonly selector: SubSelector }
  | { readonly t: 'unsub'; readonly sub: SubId }
  /** `opId` is required for `write` and `setuid` actions. */
  | {
      readonly t: 'act'
      readonly req: RequestId
      readonly path: Path
      readonly component?: ComponentName
      readonly action: ActionName
      readonly args: unknown
      readonly opId?: OpId
    }
  | {
      readonly t: 'commit'
      readonly req: RequestId
      readonly changes: readonly ChangeMember[]
      readonly expect?: Preconditions
      readonly opId: OpId
    }
  /** Stops an unfinished request; an accepted mutation stays and its outcome is still reported. */
  | { readonly t: 'cancel'; readonly req: RequestId }

/**
 * Plain-JSON difference of two projected images. Keys of `set` and entries of `unset` are dot-paths into
 * the node; no path in one delta is a prefix of another.
 */
export interface Delta {
  readonly set?: { readonly [field: string]: unknown }
  readonly unset?: readonly string[]
}

/** Members entering and leaving; the client keeps the order by the sort key itself. */
export type ListDiff = readonly ({ readonly add: NodeId } | { readonly remove: NodeId })[]

/** One copy of a node per lane, shared by all its subscriptions. */
export type LaneChange =
  | { readonly op: 'put'; readonly copy: NodeCopy }
  /**
   * Changed paths only, on top of the record's before, which the client holds while the node is not lagging —
   * also for Stores with external edits: a kernel commit takes its before from the process cache and writes the whole node.
   */
  | {
      readonly op: 'patch'
      readonly id: NodeId
      readonly base: ProjectionVersion
      readonly delta: Delta
      readonly ver: ProjectionVersion
      readonly bits: Bits
    }
  /** Deleted, invisible, or no longer covered by any subscription of the lane. */
  | { readonly op: 'del'; readonly id: NodeId }
  /** Membership of one subscription changed; membership never touches the node copies. */
  | { readonly op: 'list'; readonly sub: SubId; readonly gen: Generation; readonly diff: ListDiff }

export type Frame =
  | {
      readonly t: 'welcome'
      readonly principal: Principal
      /** Mutation-intake epoch for new `opId`s. */
      readonly intake: string
      /** Issued when `hi` came without one; the client keeps it to stay the same anonymous principal. */
      readonly credential?: Credential
    }
  /** First result of a generation. */
  | {
      readonly t: 'snap'
      readonly sub: SubId
      readonly gen: Generation
      readonly list: readonly NodeId[]
      readonly copies: readonly NodeCopy[]
      readonly computed?: readonly ComputedNode[]
      readonly rows?: readonly Row[]
      readonly at: readonly Position[]
    }
  /** Every change of one position in one frame, in position order; a lagging client gets one merged frame up to `pos`. */
  | { readonly t: 'pos'; readonly pos: Position; readonly changes: readonly LaneChange[] }
  /** A View run as a difference; `rows`, when present, replace all rows of the subscription. */
  | {
      readonly t: 'result'
      readonly sub: SubId
      readonly gen: Generation
      readonly diff: ListDiff
      readonly copies: readonly NodeCopy[]
      readonly computed?: readonly ComputedNode[]
      readonly rows?: readonly Row[]
      readonly at: readonly Position[]
    }
  /** The subscription's state is void; a new generation's `snap` follows. */
  | { readonly t: 'reset'; readonly sub: SubId; readonly gen: Generation }
  /** The subscription is over: refused at start, or the lane's coverage outgrew its limit and the window does not evict. */
  | { readonly t: 'end'; readonly sub: SubId; readonly error: KernelError }
  /** A piece of a streaming response, after a frame covering its step's records. */
  | { readonly t: 'chunk'; readonly req: RequestId; readonly data: unknown }
  /**
   * A mutation's `done` follows a frame covering its position — for a lagging client a merged frame up to
   * a later position, so its own intermediate version may be skipped.
   */
  | { readonly t: 'done'; readonly req: RequestId; readonly pos?: Position; readonly value?: unknown }
  /** Without `req`: the `hi` was refused (UNAUTHENTICATED: sign in again) and the lane closes. */
  | { readonly t: 'fail'; readonly req?: RequestId; readonly error: KernelError }

// ---- Session: the only door ----

/** Reads through the executor's rights; inside an operation they become its preconditions. */
export interface Reader {
  read(selector: Selector): Promise<ReadResult>
}

export interface ActRequest {
  readonly path: Path
  readonly component?: ComponentName
  readonly action: ActionName
  readonly args: unknown
  readonly opId?: OpId
}

export interface CommitRequest {
  readonly changes: readonly ChangeMember[]
  readonly expect?: Preconditions
  readonly opId: OpId
}

export interface Outcome {
  readonly pos?: Position
  readonly value?: unknown
}

/** A pending request: rejects with a KernelError, never resolves to a fallback. */
export interface Pending {
  readonly id: RequestId
  /** Pieces of a streaming response, each after its step's records; empty for other actions. */
  readonly chunks: AsyncIterable<unknown>
  readonly outcome: Promise<Outcome>
}

/** Reference to binary content kept outside nodes; a node field holds it. */
export interface BlobRef {
  /**
   * Random (at least 128 bits), issued by the kernel at upload, so it cannot be guessed; a secret, never
   * logged. A commit with a reference differing from the stored blob is INVALID.
   */
  readonly $blob: string
  readonly size: number
  readonly type: string
}

export interface Session extends Reader {
  readonly actor: Actor
  sub(selector: SubSelector): SubId
  unsub(sub: SubId): void
  act(request: ActRequest): Pending
  commit(request: CommitRequest): Pending
  cancel(id: RequestId): void
  /** Ordered delivery channel owned by this session. */
  readonly lane: AsyncIterable<Frame>
  /**
   * A session request on a separate channel, in parts with backpressure: gates judge it and it counts toward
   * the unfinished-request limit. The blob is reachable once a committed node references it.
   */
  upload(parts: AsyncIterable<Uint8Array>, type: string): Promise<BlobRef>
  /**
   * Needs R on the node whose field holds the reference. Each instance has its own blob store: a node of an
   * Authority target is INVALID. Bindings serve it as an attachment with `nosniff`, or from a separate origin.
   */
  download(path: Path, field: string): AsyncIterable<Uint8Array>
}

/** Everything a gate may judge: approval of one concrete transfer needs its arguments. */
export type Operation = {
  /** The session's network address (`openSession`): limits on anonymous callers are not counted per principal. */
  readonly origin?: string
} & (
  | { readonly kind: 'read' | 'sub'; readonly selector: Selector }
  | {
      readonly kind: 'act'
      readonly path: Path
      readonly component?: ComponentName
      readonly action: ActionName
      readonly args: unknown
    }
  | { readonly kind: 'commit'; readonly changes: readonly ChangeMember[] }
  | { readonly kind: 'upload'; readonly type: string }
  | { readonly kind: 'download'; readonly path: Path; readonly field: string }
)

/**
 * May only refuse, and only with codes that do not steer the client's retry logic; a gate that
 * throws refuses. For `setuid` it runs for the caller and for the node executor. A replay of an
 * executed key is not a new operation and never reaches gates. Approval never waits inside an
 * operation: the gate refuses until the approval exists, then the client retries.
 */
export type Gate = (operation: Operation, actor: Actor) => Promise<'pass' | { readonly refuse: 'REFUSED' | 'BUDGET' }>

// ---- Types, actions, registry ----

export type JsonSchema = { readonly [keyword: string]: unknown }

/** Kernel I/O for handlers, extended by the deployment; present only where external effects are allowed. */
export interface Io {}

export interface ChangeBuilder {
  put(node: NodeInput): void
  patch(path: Path, ops: UpdateOps): void
  remove(path: Path): void
  move(from: Path, to: Path): void
  restore(record: JournalAddress): void
}

export interface ReadActionContext {
  /** The target node as the executor sees it. */
  readonly node: Node
  readonly needs: { readonly [name: string]: ReadResult }
  readonly read: Reader
  readonly caller: Actor
  readonly executor: Actor
}

/**
 * The built changes become one ChangeSet, committed after the handler returns. A streaming handler
 * commits the changes built before each yielded piece as one step instead.
 */
export interface WriteActionContext extends ReadActionContext {
  readonly change: ChangeBuilder
  readonly io?: Io
}

/** Keys are `''` (own node) or `needs` names: writes outside the own node only where declared. */
export type Post = { readonly [target: string]: UpdateOps }

interface ActionBase {
  readonly args: JsonSchema
  /** Declared reads with paths relative to the target node, injected into `pre` and the handler; they become preconditions. */
  readonly needs?: { readonly [name: string]: Selector }
  /** sift query over `{ node, needs }`, checked before the handler. */
  readonly pre?: Where
}

/**
 * Plain result, or a stream: every yielded value is a `chunk`, the return value is `done`.
 * Each step of a writing stream is atomic and judged at its own position; the stream as a whole is not.
 */
export type ActionResult = Promise<unknown> | AsyncGenerator<unknown, unknown, undefined>

/** Call: R. Executor: the caller. No writes, no external effects. */
export interface ReadAction extends ActionBase {
  readonly kind: 'read'
  readonly handler: (ctx: ReadActionContext, args: unknown) => ActionResult
}

/** `write` — call: W and R, executor: the caller. `setuid` — call: R, executor: the node principal `n:<$id>`. */
interface WriteActionBase extends ActionBase {
  readonly kind: 'write' | 'setuid'
  /** External effects (API, LLM, network); the kernel does not deduplicate them. */
  readonly io?: boolean
}

/** One atomic ChangeSet per call: the frame keeps every other field unchanged, and the planner relies on it. */
export interface PostAction extends WriteActionBase {
  readonly post: Post
  /** Absent: pre + post is the implementation. Never a stream: steps would apply post more than once. */
  readonly handler?: (ctx: WriteActionContext, args: unknown) => Promise<unknown>
}

export interface WriteAction extends WriteActionBase {
  readonly post?: undefined
  readonly handler: (ctx: WriteActionContext, args: unknown) => ActionResult
}

export type ActionDef = ReadAction | PostAction | WriteAction

/** Fixed at the type's first registration and never changed. */
export type SecurityClass = 'ordinary' | 'user-capability' | 'privileged-capability'

/** `module` and `security` must match the type's node in `/sys/types`, written only by admin, or publication fails. */
export interface TypeDef {
  readonly name: TypeName
  /** The only module that registers the type's security contexts. */
  readonly module: ModuleId
  readonly security: SecurityClass
  readonly schema: JsonSchema
  /** Written as `$v` with every component of this type. */
  readonly version: number
  readonly actions: { readonly [name: ActionName]: ActionDef }
  /**
   * Its nodes change only through its own actions; a direct commit into them only from admin —
   * per transition, so removing, moving or copying a subtree holding them directly is admin-only too.
   */
  readonly actionsOnly?: boolean
  /** Earlier names resolving to this type. */
  readonly aliases?: readonly TypeName[]
}

/**
 * Only rights inputs and immutable identity: a rule reading node fields or the address would make every
 * field, or a move, a rights input. Conditions on the place in the tree belong to the subtree's ACL.
 */
export interface RuleInput {
  readonly id: NodeId
  /** The nearest `$owner` at the node or above. */
  readonly owner?: Principal
  readonly actor: Actor
  readonly admin: boolean
}

/** Narrows only: ANDed with the ACL result; applies to everyone, admin included. An error denies. */
export type RightsRule = (input: RuleInput) => Bits

export interface Migration {
  readonly from: number
  readonly to: number
  readonly up: (component: Component) => Component
}

/** The subscription's parameters; empty for a node executor, whose one run serves every subscription. */
export interface DeriveRequest {
  readonly where?: Where
  readonly sort?: Sort
  readonly window?: Window
}

export interface DerivedResult {
  /**
   * Members read through the given reader. Their order is the subscription's sort by their fields, then by
   * path; a computed rank (relevance, score) goes in `rows`.
   */
  readonly members: readonly Path[]
  readonly rows?: readonly Row[]
}

/**
 * Settings come only from the View's own node and the request. Every read through `read` is registered as a
 * dependency before it happens, so a source read for the first time is never missed; the reader never serves
 * another View. For a node executor the kernel applies each subscription's filter, sort and window to the
 * result; lists, window boundaries and generations stay per subscription.
 */
export type DeriveHandler = (view: Node, request: DeriveRequest, read: Reader) => Promise<DerivedResult>

export interface ServiceRun {
  stop(): Promise<void>
}

/** Runs with the session of its own node principal; settings come only from its node. */
export type ServiceHandler = (node: Node, session: Session) => Promise<ServiceRun>

/** Declaration component on the mounting node. */
export interface MountDecl extends Component {
  /** Path template relative to the declaring node; a declaration creating an overlap is rejected. */
  readonly pattern: string
  /**
   * Whether a Store target admits edits outside the kernel; absent is `none`. `trusted` is rejected for a
   * Store that does not report them (`Store.external`).
   */
  readonly external?: ExternalEdits
}

/** One declaration yields exactly one target instance. */
export type MountHandler = (decl: Node, session: Session) => Promise<MountTarget>

export interface SecurityHandlers {
  readonly acl: RightsRule
  readonly migrate: readonly Migration[]
  readonly mount: MountHandler
  readonly service: ServiceHandler
  readonly derive: DeriveHandler
}

/** Contexts that decide rights, capabilities and stored shape: owner module only, exact lookup. */
export type SecurityContext = keyof SecurityHandlers

/** Allowed only for types the publishing module owns. */
export type SecurityRegistration = {
  [C in SecurityContext]: { readonly type: TypeName; readonly context: C; readonly handler: SecurityHandlers[C] }
}[SecurityContext]

/** Open contexts such as `react`, on any type; a security context name here is rejected. */
export interface OpenRegistration {
  readonly type: TypeName
  readonly context: string
  readonly handler: unknown
}

export interface ModuleManifest {
  readonly id: ModuleId
  readonly types: readonly TypeDef[]
  readonly security: readonly SecurityRegistration[]
  readonly open: readonly OpenRegistration[]
}

/** Content digest of the published module set — the generation: equal counters could hide different rules. */
export type ModuleDigest = string

export interface Registry {
  /** Atomic: the module's types and handlers appear together in a new generation, or not at all. */
  publish(manifest: ModuleManifest): ModuleDigest
  /** Resolves aliases; an unknown type throws UNKNOWN_TYPE. */
  type(name: TypeName): TypeDef
  /** Exact lookup only: security decisions never fall back. */
  security<C extends SecurityContext>(type: TypeName, context: C): SecurityHandlers[C] | undefined
  /** Open contexts, exact lookup; any fallback belongs to the binding that uses the context. */
  handler(type: TypeName, context: string): unknown
  readonly digest: ModuleDigest
}

// ---- Store ----

export type ScanRange =
  | { readonly node: Path }
  | { readonly children: Path }
  | { readonly subtree: Path }

/**
 * Kernel work is counted, not timed: expression size is judged at parse; scanned nodes, loaded bytes and
 * expression work are counted at run time.
 */
export interface Budget {
  readonly nodes: number
  /** Bytes of loaded nodes. */
  readonly bytes: number
  /** Expression work of `where`, counted by in-process Stores as the kernel's evaluator tests each node. */
  readonly exprWork: number
  /** Absolute time, ms, for work the storage engine does itself (filters, sorts, aggregations). */
  readonly deadline: number
}

/** No snapshot tokens: a write is made consistent by its preconditions at commit, a subscription by rerunning. */
export interface ScanQuery<Range> {
  readonly range: Range
  readonly where?: Where
  readonly sort?: Sort
  readonly after?: Cursor
  readonly limit?: number
  readonly budget: Budget
}

export interface ScanResult<Item> {
  readonly items: readonly Item[]
  readonly next?: Cursor
}

/**
 * As stored. `$pos` — the commit that wrote it — is its `$rev` and decides which records arriving during a
 * cache fill still apply.
 */
export type StoredNode = Omit<NodeMeta, '$rev'> & { readonly $pos: Position } & Fields

/** Changed fields by dot-path, with previous and new values: enough to go both ways. */
export type FieldDeltas = { readonly [field: string]: { readonly from?: unknown; readonly to?: unknown } }

/**
 * The side of a full image is explicit. Full images: creation, deletion, reconciliation, an update after
 * which the fields changed since the last full image exceed the node size, and the oldest record kept by
 * compaction.
 */
export type NodeTransition =
  | { readonly t: 'create'; readonly after: StoredNode }
  | { readonly t: 'update'; readonly delta: FieldDeltas; readonly after?: StoredNode }
  | { readonly t: 'delete'; readonly before: StoredNode }
  /** External edit: the full new state; the previous one may be unknown. */
  | { readonly t: 'reconcile'; readonly after: StoredNode | null }

export interface JournalEntry {
  readonly id: NodeId
  readonly path: Path
  /** Previous path of a moved node. */
  readonly from?: Path
  readonly change: NodeTransition
}

/** Idempotency decision, stored in the commit's own record: the journal outlives the opId window. */
export interface OpDecision {
  readonly opId: OpId
  /** Hash of the normalized request together with the original actor, claims and scope included. */
  readonly requestHash: string
  /** Absent: a stream started under this key and has not finished — a replay gets UNKNOWN_OUTCOME. */
  readonly outcome?: Outcome
}

/** One commit in one Store's journal, written atomically with the commit itself. */
export interface JournalCommit {
  readonly pos: Position
  /**
   * `transfer`: copying a subtree into its new Store and deleting it from the old one (A4) — no change of the
   * accepted state; the instance stream does not emit it.
   */
  readonly kind: 'commit' | 'reconcile' | 'kernel' | 'transfer'
  readonly executor: Executor
  readonly caller: Executor
  /**
   * Present for an applied client mutation; a failed request leaves no effect and may be retried.
   * A `write`/`setuid` action without writes still leaves a commit with only this decision, in the target node's domain.
   */
  readonly decision?: OpDecision
  readonly entries: readonly JournalEntry[]
}

/** Journal commits touching the path or its descendants, in position order. */
export interface JournalRange {
  readonly journal: Path
  readonly after?: Position
}

/**
 * The latest commit in this Store that recorded this key, if its decision survives. A stream records the key
 * at its first and last step, possibly in different domains.
 */
export interface DecisionRange {
  readonly decision: { readonly caller: Principal; readonly opId: OpId }
}

export type StoredWrite =
  | { readonly path: Path; readonly node: StoredNode }
  | { readonly path: Path; readonly node: null }

/** Applied atomically inside the Store's domain. */
export interface StoreCommit {
  readonly pos: Position
  /** Fencing: the Store rejects a commit of an older writer epoch. */
  readonly writerEpoch: number
  readonly writes: readonly StoredWrite[]
  readonly record: JournalCommit
}

export interface Store {
  readonly domain: DomainId
  scan(query: ScanQuery<ScanRange>): Promise<ScanResult<StoredNode>>
  /** The journal is Store data, read by the same operation. */
  scan(query: ScanQuery<JournalRange | DecisionRange>): Promise<ScanResult<JournalCommit>>
  commit(commit: StoreCommit): Promise<void>
  /** Stores admitting external edits report addresses changed outside the kernel. */
  external?(): AsyncIterable<readonly Path[]>
}

// ---- Mount targets ----

/**
 * External edits are trusted: accepted, sent out, and reads may see them before reconciliation, under the
 * previous `$rev` — a node read by an operation is the process-cache copy, the same one a commit takes as its
 * before. A visible node breaking its schema arrives as an error copy — only it fails — and admin is alerted;
 * an edit leaving rights uncomputable hides the node, or with a broken `$acl`/`$owner` its subtree, and alerts
 * admin too. Only those admin trusts as itself may write a Store directly; outsiders' uploads go through
 * actions. Blob references in such edits are not checked and hold a blob only from detection.
 */
export type ExternalEdits = 'none' | 'trusted'

/** State of the A2 computation for one actor at the mount point. */
export interface RightsPrefix {
  readonly granted: Bits
  readonly denied: Bits
  readonly owner?: Principal
  /** A at the mount point or above: denies inside the shard do not bind the actor. */
  readonly aboveA: boolean
  /** A on the origin root: "admin only" checks inside the shard use it. */
  readonly admin: boolean
}

/** Sent once, when the origin's writer opens the shard lane of one client lane. */
export interface ShardEnvelope {
  /** Fixed for the lane, as every lane's actor. */
  readonly actor: Actor
  /** The shard refuses a different module set with GENERATION. */
  readonly modules: ModuleDigest
  readonly prefix: RightsPrefix
}

export interface Connection {
  send(request: Request): void
  readonly frames: AsyncIterable<Frame>
}

export type Authority =
  /**
   * A foreign instance: the executor there is the mount credential — a declassification. Its identity
   * is not trusted: the origin maps its `$id`s into the mount point's namespace, rejects nodes whose
   * `$path` leaves the mounted range, and keeps its positions in the mount point's own space.
   */
  | { readonly kind: 'federation'; connect(credential: Credential): Promise<Connection> }
  /**
   * Same trust zone and module set. Only the origin's writer connects: one authenticated ordered shard lane
   * per client lane, so the prefix needs no signature or version, and the shard projects per actor. Shard
   * frames go to the client's lane past the origin's process cache; the writer pulls them only while the
   * client lane is ready, so the shard lane does the merging. The shard lane's `welcome` carries the shard's
   * intake epoch, part of the origin's composite epoch. Nodes under a shard cannot be executors.
   */
  | { readonly kind: 'shard'; connect(envelope: ShardEnvelope): Promise<ShardConnection> }

export interface ShardConnection {
  send(request: Request): void
  /**
   * A changed chain above the mount point, sent to every shard lane of the actor: the shard checks every
   * later commit of the lane, running streams included, against the new prefix.
   */
  update(prefix: RightsPrefix): void
  readonly frames: AsyncIterable<Frame>
}

export type MountTarget =
  | { readonly kind: 'store'; readonly store: Store }
  /**
   * Read-only; writes address the sources. A View of one selector (query mount) may be kept like a
   * subscription to that selector, without runs.
   */
  | { readonly kind: 'view'; readonly derive: DeriveHandler; readonly executor: 'reader' }
  /** Executed by the View node's principal — a declassification; one run serves all its subscriptions. */
  | {
      readonly kind: 'view'
      readonly derive: DeriveHandler
      readonly executor: 'node'
      /**
       * Only for a View reading past the kernel (the target's own language): no rights apply there, so such a
       * View is always executed by its node and only a privileged-capability type may return it — from a
       * user-capability mount handler it is rejected. Writes in these ranges wake it.
       */
      readonly sources?: readonly Path[]
    }
  | { readonly kind: 'authority'; readonly authority: Authority }

// ---- Instance stream (replicas) ----

export interface StreamCursor {
  readonly pos: Position
  readonly epochs: { readonly [domain: DomainId]: string }
}

export type StreamEvent =
  | { readonly t: 'commit'; readonly domain: DomainId; readonly record: JournalCommit }
  /** Position of a failed commit. */
  | { readonly t: 'gap'; readonly pos: Position }
  /** Continuity of one domain is lost; only subscriptions depending on it reset. */
  | { readonly t: 'reset'; readonly domain: DomainId; readonly epoch: string }

export interface InstanceStream {
  follow(from: StreamCursor): AsyncIterable<StreamEvent>
}

// ---- Instance ----

/** Kept in the admin-written node `/sys/limits` and applied live; a missing field takes its DEFAULT_LIMITS value. */
export interface Limits {
  /** Nodes scanned per operation, counted after pruning ACL-hidden subtrees. */
  readonly readNodes: number
  /** Bytes of loaded nodes per operation. */
  readonly readBytes: number
  /**
   * Bytes of the nodes, View rows and computed nodes all subscriptions of one lane hold. An overflow is charged
   * to the subscriptions covering what entered or grew: an evicting window among them releases nodes no other
   * subscription covers; otherwise they end.
   */
  readonly laneCoverageBytes: number
  /** Size of one stored node; a larger write is rejected. Binary content goes to blobs. */
  readonly nodeBytes: number
  /** Size of one structured request — selector, ChangeSet, action args; a larger one is rejected before parsing. */
  readonly requestBytes: number
  /** Size of one `sift` expression, judged at parse. */
  readonly exprBytes: number
  /**
   * Expression work per operation, counted by the kernel's evaluator as it tests: every field read, array element
   * visited and value tested is one step (a string the evaluator compares unit by unit, one per 8 units it walks),
   * and the step past the limit stops the test. One operation: a query, a subscription snapshot, a View run, one
   * subscription updated by one write, a commit's precondition check.
   */
  readonly exprWork: number
  /** Size of one blob. */
  readonly blobBytes: number
  /** A blob referenced by no node and no journal record within retention is deleted after this. */
  readonly blobOrphanMs: number
  /** One query executed by the storage engine itself. */
  readonly queryMs: number
  /** Wall time of an action, including `io` waits and its stream. */
  readonly actionMs: number
  /** Nesting of action calls made through an action context; a deeper call is refused. */
  readonly actionDepth: number
  /** Actual node transitions per ChangeSet, descendants of `remove` and `move` included. */
  readonly changeSet: number
  readonly subsPerLane: number
  /** Minimum time between runs of one View; changes arriving meanwhile coalesce. */
  readonly recomputeIntervalMs: number
  readonly includeDepth: number
  readonly journalRetentionMs: number
  readonly opIdWindowMs: number
  readonly clockToleranceMs: number
  /** Unfinished requests a client may have; sending more closes the connection, so input is always read. */
  readonly laneRequests: number
  /** A client silent this long is disconnected. */
  readonly heartbeatMs: number
  /** Connection limit. */
  readonly maxLanes: number
  /** Live lanes per anonymous network address (IPv6: /64) or per credentialed principal; a `hi` beyond it is refused. */
  readonly lanesPerOrigin: number
  readonly writerLeaseMs: number
}

const HOUR = 3_600_000
const KIB = 1024
const MIB = 1024 * KIB

export const DEFAULT_LIMITS: Limits = {
  readNodes: 1_000,
  readBytes: 8 * MIB,
  laneCoverageBytes: 32 * MIB,
  nodeBytes: 256 * KIB,
  requestBytes: 512 * KIB,
  exprBytes: 16 * KIB,
  exprWork: 10_000_000,
  blobBytes: 100 * MIB,
  blobOrphanMs: 24 * HOUR,
  queryMs: 1_000,
  actionMs: 600_000,
  actionDepth: 8,
  changeSet: 100,
  subsPerLane: 100,
  recomputeIntervalMs: 100,
  includeDepth: 3,
  journalRetentionMs: 30 * 24 * HOUR,
  opIdWindowMs: 24 * HOUR,
  clockToleranceMs: 5 * 60_000,
  laneRequests: 8,
  heartbeatMs: 30_000,
  maxLanes: 1_000,
  lanesPerOrigin: 16,
  writerLeaseMs: 10_000,
}

/** One instance's blob storage, written in parts; the kernel issues the ids. */
export interface BlobStore {
  put(id: string, parts: AsyncIterable<Uint8Array>, type: string): Promise<BlobRef>
  /** Rejects with NOT_FOUND for an absent blob. */
  stat(id: string): Promise<BlobRef>
  get(id: string): AsyncIterable<Uint8Array>
  delete(id: string): Promise<void>
}

export interface InstanceConfig {
  readonly id: InstanceId
  readonly root: MountTarget
  /** Whether a Store root admits edits outside the kernel, as `MountDecl.external` does for mounts; absent is `none`. */
  readonly rootExternal?: ExternalEdits
  readonly blobs: BlobStore
  /** Applied in order to every operation of every session. */
  readonly gates?: readonly Gate[]
}

export interface Instance {
  readonly registry: Registry
  /**
   * The only door for callers; `origin` is the network address the binding saw, passed to gates. Without a
   * credential the session gets a new `anon:` principal, and its lane opens with `welcome` carrying the issued
   * credential. Node-principal sessions are opened by the kernel from capability nodes.
   */
  openSession(credential?: Credential, origin?: string): Promise<Session>
  /** For stream consumers; replicas come later. */
  readonly stream: InstanceStream
}

export type CreateInstance = (config: InstanceConfig) => Promise<Instance>
