# Security Manifesto

> All eggs in one basket? Guard the basket.

Treenity = single address space, single tree, all data visible to the system.
This is **by design** — addressability, ACL, subscriptions, AI visibility require unified namespace.
The tradeoff: a leak of the tree is a leak of everything. Defense must be architectural, not perimeter-only.

## Threat Model

| Threat | Vector | Impact |
|--------|--------|--------|
| **Tree leak** | Compromised frontend, XSS, stolen token | Full subtree exfiltration |
| **Privilege escalation** | Service impersonation, ACL misconfiguration | Write to forbidden paths |
| **Enumeration** | Crawling paths, prefix queries | Map the entire tree structure |
| **Bulk extraction** | getChildren with large depth, no rate limit | Dump database via API |
| **Side-channel** | Direct store access bypassing ACL | Read without permission check |
| **Token theft** | XSS → localStorage read | Full session hijack |
| **Service compromise** | Bug in service code | Service's elevated groups abused |
| **Prompt injection** | Malicious content in tree nodes read by AI agent | Agent executes unintended actions with user's permissions |
| **Agent privilege escalation** | Compromised/hallucinating agent with broad execute access | Full system compromise via chained actions |
| **Context leakage** | Multi-user agent without session isolation | Cross-user data exposure via shared agent state |

## Defense Layers

### L0: ACL (exists, battle-tested)

- GroupPerm `{ g, p }` with sticky deny (p=0 deny-all, p<0 deny-bits)
- Ancestor walk: root → target, accumulating per-group permissions
- `stripComponents`: response filtering — forbidden components never leave the server
- Component-level ACL: type-registered + instance-level
- `$owner` pseudo-group: identity-aware permission resolution

### L1: Identity Propagation (exists)

- Every action carries `$owner` — the **user** who initiated, not the service
- Services act **on behalf of** users: `service+user` identity pair
- ACL checks run against the user's claims, not the service's
- Transparent audit: WHO (user) initiated THROUGH WHOM (service)
- Like `sudo` — elevation is visible, not hidden

### L2: Frontend Proxy (NEW — the critical gap)

**Problem:** Frontend has direct tRPC access to the full tree. A compromised client (XSS, malicious browser extension, stolen token) can crawl everything the user's ACL allows.

**Solution: View Isolation via Proxy Process**

```
Browser ←→ [Frontend Proxy] ←→ [Tree Service]
              ↓
         scope: ['/app/orders', '/users/{self}']
         budget: 100 reads/min
         no recursive getChildren
```

The proxy is a separate process (or middleware layer) that:

1. **Scoped paths** — whitelist of path prefixes the frontend can access. Everything outside → 403. Configured per-app, not per-user (ACL handles per-user)
2. **Query budget** — rate limit per session: max reads/min, max children per query, max depth
3. **No recursive enumeration** — `getChildren(path, {depth: N})` capped at depth=1 from proxy. Deep reads require explicit paths
4. **Response size cap** — max bytes per response, max nodes per getChildren
5. **Action whitelist** — only allowed actions pass through. No arbitrary `execute`

**Implementation path:** middleware in tRPC, not a separate process initially. Evolve to separate process when needed.

```typescript
// Scope definition per app
interface AppScope {
  paths: string[]           // allowed path prefixes
  actions: string[]         // allowed action patterns
  maxChildrenDepth: number  // 1 by default
  maxChildrenLimit: number  // 50 by default
  readBudget: number        // reads per minute
  writeBudget: number       // writes per minute
}
```

### L3: Token Security (done)

- HttpOnly + SameSite=Lax + Secure (prod) cookies. `src/server/cookies.ts`
- Token extraction: Bearer header → cookie → SSE connectionParams
- API keys for MCP/agents: `treenity_<hex>`, scrypt hash, permanent until revoked
- localStorage removed from frontend entirely

### L4: Audit Trail (not yet)

Every mutation → audit node:

```
/sys/audit/{timestamp}-{seq}
  $type: audit.entry
  who: userId
  through: serviceId (if elevated)
  action: 'set' | 'remove' | 'execute:actionName'
  path: target path
  patches: JSON patches (from Immer)
  timestamp: ISO
```

- Append-only (W denied to all except system)
- Queryable via query mounts: "show me all writes by user X to /orders/*"
- AI-visible: AI agent can audit, detect anomalies
- Rotation: archive to cold storage after N days

### L5: Service Elevation (design)

Services need extra permissions (bot writes to user's feed, cron moves orders).
But service identity must never hide user identity.

```
Claims resolution:
  base = user's claims (groups + u:{id} + authenticated)
  elevated = base ∪ service.extraGroups
  audit = { who: userId, through: serviceId }
```

- Service declares `extraGroups` at registration
- Elevation is **always audited** — audit entry shows both identities
- Service can't escalate beyond its declared groups
- If user is denied (sticky p=0), service elevation **cannot override** — sticky deny wins

### L6: Overlay Isolation (future — multiverse)

For untrusted agents (AI, third-party scripts):

```
Agent works in: overlay(agentBranch, mainTree)
  - Reads see main tree (filtered by ACL)
  - Writes go to agentBranch only
  - Human review → merge agentBranch → main
```

- Agent can't corrupt main tree directly
- All changes are inspectable before merge
- Existing overlay store mechanism — no new primitives needed

### L7: Capabilities (future — Fuchsia/seL4 model)

Evolution of ACL. Groups = ambient authority (admin everywhere). Capabilities = scoped token for specific action on specific resource.

```
API key with scope:
  paths: ['/orders/*']
  actions: ['read', 'execute:cook']

effectivePerms = groupACL ∩ capabilityScope
```

- Capabilities **narrow**, never widen. Sticky deny still wins
- Delegation: service can derive sub-capability with smaller scope
- Compatible with existing ACL — additional constraint, not replacement

### L8: Agent Containment (critical — 2026 imperative)

**Problem:** Uncontrolled scaling of agents with `execute` permissions creates unprecedented attack vectors. A compromised or hallucinating agent with broad tree access = full system compromise via prompt injection and privilege escalation.

**Trust model:** One user — one gateway (personal assistant). No multi-user agent environments without strict isolation.

**Containment requirements:**

| Control | Implementation | Treenity mapping |
|---------|---------------|-----------------|
| **Sandboxing** | Docker containers for tool execution. Agent never runs on host directly | Overlay isolation (L6) + process boundary |
| **Blast radius** | Disable high-risk actions (`exec`, `cron`) without explicit confirmation. Minimal access profiles | Action whitelist in AppScope (L2), `ask: "always"` for destructive actions |
| **Network shielding** | Bind gateway to loopback. Remote access only via Tailscale or equivalent with identity headers | Already: server binds localhost. Prod: reverse proxy + auth |
| **Channel isolation** | Per-channel-peer session scope. Prevent context leakage between users. Require explicit mentions in group contexts | `$owner` propagation (L1) + session-scoped overlays (L6) |
| **Continuous audit** | Regular security audit commands. Detect: open management interfaces, missing IP allowlists, overprivileged agents | Audit trail (L4) + AI-visible anomaly detection |

**How this maps to existing layers:**
- L1 (Identity) ensures agent actions carry the originating user's identity
- L2 (Frontend Proxy) restricts agent's visible tree surface
- L4 (Audit) logs everything the agent touches
- L5 (Service Elevation) prevents agent from exceeding declared permissions
- L6 (Overlay) isolates agent writes for human review before merge
- L7 (Capabilities) scopes agent's API key to minimum required paths/actions

**Without these controls**, integrating agents into production (corporate network, smart home, supply chains) leads to inevitable compromise via prompt injection and privilege escalation.

## Security Invariants

1. **No data leaves without ACL check.** Every `get`, `getChildren` goes through `withAcl`. No shortcuts.
2. **Sticky deny is absolute.** Once denied at ancestor, no child path can re-grant. Not even services.
3. **Identity is immutable per request.** `$owner` set at creation, travels with every action in the chain.
4. **Components are independently protected.** `stripComponents` removes what you can't see. You don't know it exists.
5. **Side-channels are bugs.** If data reaches a consumer without passing through `withAcl` → that's a vulnerability, not a feature.
6. **Agents are untrusted by default.** Every agent action must pass through the same ACL + audit + capability pipeline as any external request.

## What This Is NOT

- **Not a blockchain.** No consensus, no gas, no distributed ledger. But: immutable audit trail + identity propagation + sticky deny = blockchain-grade auditability at in-memory speed.
- **Not zero-trust.** Services inside the process boundary are trusted code. The boundary is ACL + proxy, not process isolation (yet).
- **Not encryption at rest.** Nodes are plaintext in store. Encrypt at storage layer if needed (Mongo encryption, FS-level).

## Priority Order

1. **Frontend proxy / scope middleware** — biggest gap, highest impact
2. ~~HttpOnly cookies~~ done
3. **Rate limiting on all endpoints** — prevent enumeration
4. **Audit trail** — can't investigate what you don't log
5. **Service elevation formalization** — document and enforce the pattern
6. **Agent containment** — sandboxing + blast radius + channel isolation
7. **Overlay isolation for agents** — write isolation with human review gate
8. **Capabilities** — minimum privilege by design

