// Normative obligations map to exact authored cases in their owning package.
// Execution results belong to the source-bound acceptance run, not to this index.

export interface ContractCase {
  readonly file: string;
  readonly test: string;
}

/** Bind exact case names to their real owner, relative to this directory. */
function cases(file: string, ...tests: string[]): readonly ContractCase[] {
  return tests.map(test => ({ file, test }));
}

const identity = cases("d9-changeset.test.ts",
  "issues identity, canonicalizes every component and stamps current versions",
  "rejects supplied kernel metadata even when its value is undefined",
  "rejects an occupied type change and accepts explicit removal before a new identity",
  "applies repeated members in order and journals one net update per identity",
);

const positions = cases("a0-writer.test.ts",
  "uses one position for every write and its journal record",
  "waits for previous writes in every read domain, including rights inputs",
  "applies independent domains in parallel but publishes them in position order",
  "passes its fencing epoch to the Store",
);

const ownership = cases("../registry.test.ts",
  "requires accepted ownership and rejects a conflicting publication atomically",
  "keeps kernel instances independent",
  "resolves aliases to the same type and rejects unknown names",
  "rejects foreign security registrations for all five contexts",
  "replaces all entries of an owner generation together",
  "hashes content independently of publication, registration and object key order",
  "never falls back by type or context suffix",
);

const migrations = cases("t11-migrations.test.ts",
  "gives each step only its own component, preserving node metadata and other components",
  "chooses steps by each stored version while bare type-bearing values stay data",
  "keeps converged objects checked when an unrelated type changes and invalidates only a changed ladder",
  "stamps current input without executing migrations and rejects stale input atomically",
  "rejects unavailable, future, fractional and ambiguous migration paths loudly",
);

const projection = cases("../reader.test.ts",
  "prunes hidden children before payload budgets and makes hidden nodes indistinguishable from absence",
  "projects before filtering and sorting, then applies selector-bound exclusive windows",
  "applies recorded type restrictions to deleted images and refuses exhausted journal work",
  "reads journal images with cursor paging and removes history access when A is revoked",
  "enumerates logical children and reference includes across registered memory targets",
  "keeps visible malformed nodes as error copies with stored filter and sort values",
);

const rights = cases("a2-rights.test.ts",
  "denies by default and combines grants from different claims per bit",
  "keeps a deny sticky across descendants and other granting groups",
  "ANDs the main and every named component rule, including for admin",
  "narrows root A before passing the final admin flag to descendant rules",
  "masks R, W and A outside scope, including the admin bit at root",
);

const actors = cases("a3-one-door.test.ts",
  "reads credential and account in one ordered span before a concurrent authorization change",
  "keeps account identity and semantic sources stable across rename and move",
  "rejects blocked, pending, revoked, expired and deleted account credentials without anonymous fallback",
  "persists anonymous signing state per instance across reopening without sharing other instances",
  "creates node actors only from exact native declarations and gives groups only to privileged capabilities",
);

const auth = cases("../auth-factory.test.ts",
  "closes only the credential whose authorization changed and preserves rename-only dependencies",
  "registers lifetime dependencies before the resolution read barrier releases",
  "expires idle admissions at the boundary and preserves a signed anonymous identity on reconnect",
  "opens local declared node principals and closes them after actual registry publication",
);

const mounts = cases("d6-mounts.test.ts",
  "compiles relative wildcard roots and their descendants without claiming the declaring node",
  "rejects overlapping templates atomically and retains the preceding topology",
  "opens one actual target for concurrent first access and every wildcard match",
  "invokes the exact owner handler with the genuine declaring-node grants",
  "rejects trusted memory mounts before activation because they cannot report external edits",
  "rejects writes across two actual memory targets without accepting either half",
  "removes the root-owned parent subtree while retaining a mounted child in its actual Store",
);

const views = cases("t4-views.test.ts",
  "publishes a reader View through the native Session",
  "publishes a run dirtied by a write to its first source, then reads the new state",
  "publishes a run started before revoke, then reads with the revoked source rights",
  "rejects writes to a View and reads of another View through its Reader",
  "wakes a privileged node View from actual writes in its declared source range",
  "shares one node-executor run across three independently filtered subscriptions",
  "evicts computed window members and resumes using the View cursor",
);

const changes = cases("d9-changeset.test.ts",
  "removes descendants but stops below mount nodes and leaves unrelated siblings",
  "allows the exact transition limit and rejects the next descendant without partial deletion",
  "leaves every earlier member unchanged when a later patch is absent or invalid",
  "serializes concurrent increments against the shared process copy",
);

const preconditions = cases("d9-preconditions.test.ts",
  "lets exactly one concurrent booking commit against the same empty selector",
  "checks node revisions and visible absences in the executor projection",
  "ignores ordinary ancestor fields but notices ACL, owner and rule-bearing type inputs",
  "rejects a read type migration change while unrelated module publication stays valid",
  "rejects changed target, actor and domain continuity tokens before checking selectors",
);

const lanes = cases("../lane.test.ts",
  "delivers the real welcome, snapshot and one projected patch",
  "merges several pending writes into one current put and one position",
  "flushes an existing copy before a second subscription snapshot",
  "delivers a covering position before done and settles the original Pending",
  "uses a put after ACL changes and removes a newly hidden node",
  "reports hidden and absent initial subscriptions with the same NOT_FOUND",
  "closes outstanding delivery on actual actor revocation",
  "enforces the actual heartbeat deadline and releases pending delivery without sleeps",
  "bounds unfinished direct reads and closes on excess request intake",
);

const gates = cases("t3-forms.test.ts",
  "judges caller and executor gates with the original network origin before any effect",
  "aborts a held executor admission on group revocation and releases its lane quota",
  "replays the original caller outcome once after the executor node is deleted",
  "switches a nested form to its own node while preserving the immediate caller and both gates",
);

const capabilities = cases("a6-capability.test.ts",
  "denies privileged main and named types on creation, mutation, removal and relocation",
  "requires A on every direct grant target before its executor node can change",
  "requires a matching named executor version for a new grant, even from an administrator",
  "requires A on the executor node as well as the grant target",
  "rejects grants to path identities and to nodes with no declared executor behavior",
  "does not admit an open contextual fallback as declared executor behavior",
);

const journal = cases("a7-journal.test.ts",
  "stores owned full images for creation, deletion and reconciliation",
  "reconstructs moves and deletion without changing identity or losing the prior position",
  "preserves every retained before and after through edits, moves, deletions and reconciliation",
  "anchors each identity independently and keeps empty commits and idempotency decisions",
);

const idempotency = cases("a4-idempotency.test.ts",
  "commits data and its decision together and replays without executing",
  "refuses reuse with a different request, claims or scope without returning the outcome",
  "keeps keys of different callers independent",
  "opens a fresh intake after domain loss while replaying surviving old decisions",
  "expires strictly below the durable boundary and limits future time at first intake",
  "keeps expiry durable across clock rollback and restart",
);

const guard = cases("a5-guard.test.ts",
  "rejects writes and owner forgery by a reader without changing data or journal",
  "preserves hidden ACL and owner on a full replacement and keeps ordinary nested data",
  "denies explicit ACL and owner changes, nested edits and unsets without A",
  "denies an entire subtree removal when a descendant denies W, including behind absent parents",
  "checks old subtree rights and destination placement separately for relocation",
  "uses rights before the whole batch when an earlier owner change would make a child writable",
);

const actionGuard = cases("a5-action-guard.test.ts",
  "denies direct changes to actions-only types, including subtree removal, move and new copies",
  "accepts the exact post result and keeps unrelated fields unchanged",
  "rejects extra field or metadata changes even for an administrator",
  "checks every resolved need and refuses missing, undeclared or extra writes",
);

const actions = cases("a9-actions.test.ts",
  "binds a write handler to its component draft and records its value in the atomic outcome",
  "lets an unkeyed read handler use the executor Reader without changes or I/O",
  "rejects write calls without rights or valid arguments before the handler",
  "keeps nested changes as a saga and never shows the inner call the outer draft",
  "replays stable named inner calls after an earlier call is skipped on a changed branch",
  "requires stable unique keys for nested writes and rejects nested opId and anchor fields",
  "keeps simultaneous native contexts distinct across awaits",
);

const posts = cases("a9-post-actions.test.ts",
  "executes a declared post through real actor provenance and denies direct writes to its protected type",
  "validates arguments and refuses a false precondition without changing accepted data",
  "requires read and write and never falls back to another action",
  "reads relative declared needs and applies both targets atomically",
  "persists the post and replays its original decision after a filesystem reopen",
);

const streams = cases("stream-actions.test.ts",
  "commits each yielded step with fresh captured context and an ordered direct chunk",
  "checks only the current frame reads and preserves an earlier accepted step on conflict",
  "finishes a continued stream and its original key atomically while deduplicating its inner charge",
  "keeps a read stream free of writing surfaces and durable mutation decisions",
  "includes the wait for an unread piece in the original whole-stream deadline",
  "checks a read stream input again before publishing its first piece after rights revocation",
);

const forms = cases("t3-forms.test.ts",
  "uses a W-only node executor for child writes while its caller has only R",
  "denies missing executor grants, invalid arguments, failed preconditions and caller invisibility atomically",
  "uses the form executor as both actors of a nested ordinary action and checks its own target rights",
  "refuses a real Fs path identity and replays an issued form outcome after persistent reopen",
);

const blob = cases("d13-blobs.test.ts",
  "issues secret references, gates transfers and downloads only through a visible field",
  "rejects mismatched, unknown and embedded binary references atomically",
  "shares the unfinished-request quota and cancels a stalled upload when its lane closes",
  "releases the binary source when the download consumer pauses and its lane closes",
  "refuses an overflowing chunk and a gate denial without publishing binary content",
);

const blobHolds = cases("../blob-holds.test.ts",
  "counts duplicate fields once and retains deletion history after live removal",
  "publishes Memory Store data, canonical history and blob holds atomically",
  "persists Fs history holds and the accepted release timestamp through compaction and reopen",
);

const fs = cases("../store/fs-external.test.ts",
  "accepts real watched file edits as full globally positioned external records",
  "reconciles stopped physical edits before returning the reopened runtime",
  "uses current ancestor authority while real reconciliation is paused before acceptance",
);

const undo = cases("t12-undo.test.ts",
  "reverses update, deletion and creation using raw images and issued identities",
  "refuses later descendants and modified images without changing data or journal",
  "rejects reconciliation and missing records and keeps current history A mandatory",
  "restores a legitimately deleted150-node subtree in two parent-first bounded commits",
);

const protocol = cases("../../protocol/twp.test.ts",
  "validates all members and canonical paths without dropping invalid input",
  "keeps mutation and actor identity inputs exact",
  "carries renewed intake only on ordinary position frames",
  "serializes native errors in failures, subscriptions and nested read copies",
);

const http = cases("../../server/http-twp.test.ts",
  "orders subscription positions before outcomes and reopens durable writes and replay after restart",
  "rejects malformed or unsupported batches before the first effect",
  "binds attachment to the original credential and refuses invalid auth without an anonymous downgrade",
  "stops pulling native output until the real socket drains",
);

const shard = cases("shard.test.ts",
  "continues actual origin rights in a module-matched native shard lane",
  "opens the declared shard through an actual native origin Session without copying remote cache bodies",
  "charges actual filtered shard scans cumulatively to the native action allowance",
);

const federation = cases("federation.test.ts",
  "activates real federation reads with mount-owned identities and rejects public secret and foreign blob access",
  "forwards one atomic commit with mapped preconditions and refuses mixed owners",
  "forwards native actions with an immutable accepted key and foreign lane progression",
);

const prefab = cases("../../../../mods/prefab/propagation.test.ts",
  "propagates a native variant chain and reverts or applies one field with its own base",
  "pulls a subtree while retaining local edits and removed-child marks",
);

const seeds = cases("../../../../mods/prefab/install.test.ts",
  "installs accepted prefab data through bounded requests and preserves it on repeat",
  "uses the ordinary caller rights for every deployment destination and refuses the whole decision",
  "links seeded copies to an editable source and propagates fields through native actions",
);

const convergence = cases("t1-convergence.test.ts",
  "converges to independently projected current state for 500 deterministic mixed schedules",
);

const expr = cases("../expr.test.ts",
  "a 17 KiB expression is refused with BUDGET before a tester exists",
  "the counter belongs to the operation: nodes add up, and the node crossing the limit is refused",
  "a test stops the moment the counter passes the limit: it has read no more than the limit allows",
);

const store = cases("../store/memory.test.ts",
  "owns the staged commit before a failure hook can change its caller input",
  "fences a staged writer if a newer writer commits during staging",
);

export const coverage: Readonly<Record<string, readonly ContractCase[]>> = {
  D2: [...identity, ...positions],
  D3: [...migrations, ...guard],
  D4: [...ownership],
  D5: [...store, ...journal, ...preconditions],
  D6: [...mounts, ...views, ...shard, ...federation],
  D7: [...actors, ...auth],
  D8: [...projection, ...views],
  D9: [...identity, ...changes, ...preconditions, ...undo],
  D10: [...lanes, ...streams, ...protocol],
  D11: [...gates, ...auth],
  D12: [...forms, ...capabilities, ...actors],
  D13: [...blob, ...blobHolds],
  A0: [...positions],
  A1: [...identity, ...capabilities, ...federation],
  A2: [...rights, ...projection, ...lanes],
  A3: [...actors, ...auth, ...gates, ...seeds],
  A4: [...idempotency, ...mounts, ...preconditions],
  A5: [...guard, ...actionGuard],
  A6: [...capabilities, ...ownership],
  A7: [...journal, ...fs],
  A8: [...convergence, ...lanes, ...views],
  A9: [...actions, ...forms, ...posts, ...streams],
  A10: [...expr, ...changes, ...blob, ...views, ...lanes],
  T1: [...convergence],
  T2: [...rights, ...projection, ...views],
  T3: [...forms, ...gates, ...capabilities],
  T4: [...views],
  T5: [...prefab, ...seeds],
  T6: [...mounts, ...projection],
  T7: [...mounts, ...positions],
  T8: [...journal, ...fs],
  T9: [...shard, ...federation],
  T10: [...positions],
  T11: [...migrations, ...ownership, ...cases('backfill.test.ts',
    'resumes accepted migration backfill while projected field queries remain budgeted')],
  T12: [...undo],
  T13: [...posts, ...actionGuard],
  T14: [...protocol, ...http, ...lanes],
  'incident: a user mount of fs, mongo or trpc read the server disk and opened SSRF': [...capabilities, ...mounts],
  'incident: a list filter was an oracle over hidden fields': [...projection],
  'incident: $acl and $owner reached readers without A in events': [...lanes, ...projection],
  'incident: a hidden node answered forbidden, an absent one not found': [...projection, ...lanes],
  'incident: the account owner saw the password hash': [...auth],
  'incident: with / mounted, deletions went to an in-memory trash and were lost on restart': [...undo, ...journal],
  'incident: trash collection deleted live tasks through a query mount': [...changes, ...mounts],
  'incident: an anonymous call started a service with system rights': [...forms, ...actors],
  'incident: MCP ignored the narrowed agent scope': [...rights, ...auth],
  'incident: sessions kept working after the account was blocked': [...auth, ...lanes],
  'incident: snapshot and event races — registration inside the read, ordering on the client': [...convergence, ...lanes],
  "incident: a public form's anonymous W on the subscriber folder deleted others' entries": [...forms, ...capabilities],
  'incident: a client chose the $id of a new node': [...identity],
  "incident: the type ACL skipped the node's main type": [...rights],
};

// T10 specifies current writer-local reads; horizontal replicas remain explicitly deferred.
export const unresolvedCoverage: Readonly<Record<string, readonly string[]>> = {};
