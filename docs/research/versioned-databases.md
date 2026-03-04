# Versioned/Tree-Structured Database Research

_Research date: March 2026_

## Executive Summary

Researched Dolt, Noms, TerminusDB, XTDB, Irmin, and lakeFS for the use case of "millions of experiments" — branching entire tree state, running variations, comparing results.

**Key finding:** Dolt's Prolly Tree architecture (content-addressed B-trees with structural sharing) is the most mature and relevant technology. Branch creation is O(1) — just a pointer to a commit hash. Millions of branches confirmed by DoltHub. Performance now matches MySQL on Sysbench (Dec 2025). However, embedding requires Go — for TypeScript/Node.js, Dolt runs as a MySQL-compatible server.

**Recommendation:** Short-term, use Dolt as a MySQL server behind a `createDoltTree` adapter. Medium-term, implement a lightweight content-addressable store in TypeScript inspired by Prolly Trees, tailored to Treenity's node/component model.

---

## 1. Dolt

**"Git for Data" — SQL database with version control.**

| Property | Value |
|---|---|
| License | Apache 2.0 |
| Language | Go |
| Query | MySQL-compatible SQL |
| Storage | Prolly Trees (content-addressed Merkle B-trees) |
| Max tested size | 1 TB |
| Performance vs MySQL | 1.0x (parity, Dec 2025) |
| Embedding | Go driver (`github.com/dolthub/driver`), or MySQL server |

### How Branching Works

A branch is a **named pointer to a commit hash**. Creating a branch = writing a pointer. O(1), microseconds, zero data copying. No storage overhead until changes are made on the branch.

When data is modified on a branch, only changed Prolly Tree chunks get new content hashes. Unchanged chunks are shared across all branches via structural sharing. This means millions of branches with minimal storage.

**Not copy-on-write** in the traditional sense — it's content-addressed structural sharing. The entire database state is a Merkle DAG of Prolly Tree chunks. A commit captures the root hash. Branches point to commits.

### Prolly Trees

Invented by the Noms team. Key properties:
- **History-independent**: Same data always produces same tree, regardless of insertion order
- **Content-addressed**: Each node referenced by hash of its contents (Merkle tree)
- **B-tree seek performance**: O(log n) lookups, range scans
- **Fast diff**: Compare two trees by walking from roots, skipping subtrees with matching hashes
- **Chunking**: Rolling hash determines node boundaries probabilistically (hence "Prolly" = probabilistic)

### Three-Way Merge

1. Find closest common ancestor (merge base) in commit graph
2. Compute cell-wise diffs from base to each branch
3. Apply non-conflicting changes automatically
4. Cell-level conflict detection: conflict only when same (row, column) modified to different values
5. JSON fields: different keys merged, same keys conflict
6. Conflicts stored in `dolt_conflicts_*` SQL tables — resolve via SQL queries

### Performance Numbers (Dec 2025)

- Sysbench read_write_mean_multiplier: **0.99** (was 1.16 before optimizations)
- Drop-in MySQL replacement — wire protocol compatible
- Uses LESS disk than MySQL for single HEAD (better compression)
- But stores full history, so long-lived databases grow larger
- Memory: 10-20% of disk size as RAM recommendation

### Embedded Mode

```go
import (
    "database/sql"
    _ "github.com/dolthub/driver"
)

db, _ := sql.Open("dolt", "file:///path/to/dolt/db?commitname=user&commitemail=user@example.com")
db.Exec("CREATE TABLE t (id INT PRIMARY KEY, name VARCHAR(100))")
db.Exec("CALL DOLT_COMMIT('-Am', 'initial commit')")
db.Exec("CALL DOLT_BRANCH('experiment-1')")
db.Exec("CALL DOLT_CHECKOUT('experiment-1')")
// ... modify data ...
db.Exec("CALL DOLT_COMMIT('-Am', 'experiment result')")
db.Exec("CALL DOLT_CHECKOUT('main')")
db.Exec("CALL DOLT_MERGE('experiment-1')")
```

Requires cgo (zstd compression). Go-only — no Node.js/TypeScript embedded driver.

### Limitations
- Go-only embedding (no JS/TS)
- cgo dependency (C toolchain needed)
- No multiple merge bases
- Max 2 parents per merge
- Periodic garbage collection needed (10x disk garbage from single-row inserts)

---

## 2. Noms (Dolt's Predecessor)

**Content-addressable, decentralized database. Archived Aug 2021.**

- Invented Prolly Trees. Dolt evolved from Noms.
- Schemaless (unlike Dolt which adds SQL)
- Rich type system: Boolean, Number, String, Blob, Set<T>, List<T>, Map<K,V>, Struct, Ref<T>, Unions
- Type Accretion: schema evolves via union types as new data shapes are committed
- Decentralized: any peer's state is valid, reconcile later
- Apache 2.0, Go
- **Status**: Archived, not maintained. Dolt is the successor.

---

## 3. TerminusDB

**Graph database with Git-like versioning.**

| Property | Value |
|---|---|
| License | Apache 2.0 |
| Language | Prolog (69%), Rust storage (8%) |
| Query | WOQL, GraphQL, REST |
| Storage | Rust backend (v11) |
| Model | Document/graph with JSON-LD |

- Full versioning: branch, merge, diff, clone
- Rust storage backend reduces latency (v11)
- Schema constraints for data quality
- **Not a good fit for Treenity**: Prolog-based, graph model is overkill, small community (3.2k stars)

---

## 4. XTDB (formerly Crux)

**Bitemporal immutable SQL database.**

| Property | Value |
|---|---|
| License | MIT (v2) |
| Language | Clojure/Java (JVM) |
| Query | SQL (SQL:2011 temporal extensions) |
| Storage | LSM tree on object storage (S3) |
| Architecture | Columnar (Apache Arrow) |

- Tracks system time + valid time (bitemporal)
- All history retained automatically
- Strictly serial transactions (single-thread write — hard throughput ceiling)
- **No branching concept** — it's about temporal queries and compliance, not experimentation
- **Not a fit for the "millions of experiments" use case**

---

## 5. Irmin

**OCaml library for mergeable, branchable data stores.**

- Git-compatible on-disk format (can use git CLI on Irmin data)
- Storage-agnostic (plug your own backend)
- Custom merge functions per data type
- Built-in snapshotting
- Used in MirageOS unikernels
- **Not practical for Treenity**: OCaml ecosystem, library-level only, no JS/TS bindings

---

## 6. lakeFS

**Git-like versioning for object storage (S3, Azure, GCS).**

- Zero-copy branching: branch a 200PB data lake instantly
- Iceberg catalog integration
- Atomic commits, merging, conflict detection
- ML experiment reproducibility
- **Not a database** — versioning layer on object storage
- Interesting model but wrong abstraction level for Treenity

---

## Treenity Integration Analysis

### The Use Case
Branch the entire tree state → run experiment variations → compare/merge results. Potentially millions of concurrent branches.

### Option A: Dolt as MySQL Server + Storage Adapter

```
Treenity Server → createDoltTree(mysqlConnection) → Dolt Server (MySQL protocol)
```

**Schema mapping:**
```sql
CREATE TABLE nodes (
    path VARCHAR(512) PRIMARY KEY,
    type VARCHAR(255) NOT NULL,
    data JSON NOT NULL,
    rev INT NOT NULL DEFAULT 1
);
CREATE INDEX idx_parent ON nodes (path(256));
```

**Branching via SQL:**
```sql
CALL DOLT_BRANCH('experiment-42');
CALL DOLT_CHECKOUT('experiment-42');
-- Treenity operations run against this branch
CALL DOLT_COMMIT('-Am', 'experiment result');
CALL DOLT_DIFF('main', 'experiment-42', 'nodes');  -- see what changed
CALL DOLT_MERGE('experiment-42');  -- merge back if successful
```

**Pros:** Mature, proven, free branching, cell-wise merge, MySQL ecosystem.
**Cons:** Extra process (Dolt server), SQL mapping overhead, Go-only embedding.

### Option B: Native Content-Addressable Store in TypeScript

Implement Prolly Tree concepts directly, tailored to Treenity's model:

- Content-address each node: `hash(path + JSON.stringify(sortedComponents))`
- Store chunks in a key-value store (could be backed by SQLite, files, or MongoDB)
- Branch = pointer to root hash. O(1) creation.
- Diff two branches: compare root hashes, walk down where hashes differ
- Merge at component level (Treenity already understands component boundaries)
- Structural sharing: unchanged subtrees share storage

**Pros:** Native TypeScript, perfect fit for Treenity's tree model, no external dependencies.
**Cons:** Significant implementation effort, need to handle chunking/gc/persistence.

### Option C: Hybrid — MongoDB + Lightweight Branching

Extend current MongoDB adapter with a branching layer:
- Each branch = a collection prefix or database
- Copy-on-write at node level (not chunk level)
- Diff by comparing node revisions
- Simpler than full content-addressable store, but worse scaling

**Pros:** Builds on existing adapter, simpler.
**Cons:** Not true structural sharing, storage scales linearly with branches × changed nodes.

### Recommendation

**Phase 1 (quick win):** Option A — Dolt as MySQL server. Write `createDoltTree` adapter using mysql2 driver. Get branching/merge/diff for free via `CALL DOLT_*()` SQL procedures. Test with experiment workflows.

**Phase 2 (if needed):** Option B — Native CAS store. Only if Dolt's SQL mapping becomes a bottleneck or the Go server dependency is unacceptable. The Prolly Tree paper and Noms/Dolt source code provide a solid blueprint.

---

## Key Sources

- [How Dolt Scales to Millions of Versions, Branches, and Rows (May 2025)](https://www.dolthub.com/blog/2025-05-16-millions-of-versions/)
- [How Dolt Got as Fast as MySQL (Dec 2025)](https://www.dolthub.com/blog/2025-12-12-how-dolt-got-as-fast-as-mysql/)
- [Dolt Architecture Overview](https://docs.dolthub.com/architecture/architecture)
- [Dolt Storage Engine](https://docs.dolthub.com/architecture/storage-engine)
- [How to Chunk Your Database into a Merkle Tree (Prolly Trees)](https://www.dolthub.com/blog/2022-06-27-prolly-chunker/)
- [Cell-level Three-way Merge in Dolt](https://www.dolthub.com/blog/2020-07-15-three-way-merge/)
- [Three-way Merge in a SQL Database (2024)](https://www.dolthub.com/blog/2024-06-19-threeway-merge/)
- [Embedding Dolt in Go](https://www.dolthub.com/blog/2022-07-25-embedded/)
- [Dolt Storage Review (2024)](https://www.dolthub.com/blog/2024-04-17-dolt-storage-review/)
- [Noms Technical Overview](https://github.com/attic-labs/noms/blob/master/doc/intro.md)
- [TerminusDB GitHub](https://github.com/terminusdb/terminusdb)
- [What is XTDB?](https://docs.xtdb.com/intro/what-is-xtdb.html)
- [Irmin](https://irmin.org/)
- [lakeFS](https://lakefs.io/)
- [Sizing Your Dolt Instance](https://www.dolthub.com/blog/2023-12-06-sizing-your-dolt-instance/)
