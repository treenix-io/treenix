## lab — intentional zero-importer surfaces

Experimental APIs kept by owner decision. Zero importers is EXPECTED here —
NOT dead code. Do not flag in dead-code sweeps, do not delete.

- tree-chain.ts — Proxy tree-scripting DSL over Tree, intended server-side
  scripting surface (owner decision 2026-06-10, has plans for it).
  chain.ts stays in src/ — it has a production consumer (server/actions.ts).
