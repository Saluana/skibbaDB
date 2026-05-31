# dumb-issues.md

Brutal code review of skibbaDB. One stupidity per section. No participation trophies.

---

## Zod 4 in package.json, Zod 3 in your soul

```26:28:package.json
    "dependencies": {
        "better-sqlite3": "^12.10.0",
        "zod": "^4.4.3"
```

```2:2:src/collection.ts
import { z } from 'zod/v3';
```

**Why this is bad:** You ship Zod 4 as the runtime dependency while every source file imports `zod/v3` and peeks at `_def` internals per AGENTS.md. That is two compatibility layers and one lie in `package.json`.

**Consequences:** Upgrades break silently; consumers install Zod 4 but docs say `zod/v3`; type/runtime drift when Zod changes the v3 shim.

**Fix:** Pin one story: either depend on `zod@3` explicitly or document and test against Zod 4’s v3 export only, with CI matrix on both.  
  
(we had to use zod/v3 because when we tried v4 we were having problems with it not stipping fields automatically.. If we can solve this and use zod/v4 that would be better as it is more performant)

---

## README preaches `zod/v3`, npm installs Zod 4

```58:64:README.md
Important: import Zod from `zod/v3`.

```ts
import { z } from 'zod/v3';
```

The package you install is still `zod`. The `/v3` import is a compatibility path that skibbaDB expects.

```

**Why this is bad:** Beginners follow README, get Zod 4 from npm, and pray the shim never moves. You outsourced your schema layer to an undocumented subpath.

**Consequences:** GitHub issues titled “skibbaDB broken with zod”; library looks amateur next to anything that pins a real peer range.

**Fix:** `peerDependencies: { "zod": "^3.23.0" }` or document exact Zod 4.x tested; add a startup check that validates `_def` access.

---

## `collection.ts` is a 2,400-line monument to “I’ll refactor later”

```66:66:src/collection.ts
export class Collection<T extends z.ZodSchema> {
```

(Entire file: ~2400 lines — CRUD, migrations, queries, sync twins, vectors, plugins, transactions.)

**Why this is bad:** Single class owns table DDL, migration context, plugin hooks, SQL execution, join mapping, sync/async duplicates, and atomic updates. That is not a collection; it is a landfill with types.

**Consequences:** Any change risks regressions across unrelated features; reviews are impossible; onboarding takes days.

**Fix:** Split by responsibility (`CollectionCrud`, `CollectionQuery`, `CollectionLifecycle`) or composition over one `Collection` façade — you already have `collection-ops.ts`; finish the job.

---

## You admitted the sync/async clone army and shipped it anyway

```1605:1610:src/collection.ts
    // Sync versions for backward compatibility
    // LOW-5 TODO: Refactor sync/async duplication
    // Priority: Low - Defer until v2.0 or when adding new methods becomes unwieldy
    // Current duplication is intentional to avoid performance overhead
```

**Why this is bad:** Two copies of every CRUD path diverge. “Intentional duplication” is how bugs become folklore.

**Consequences:** Fix a bug in `insert`, forget `insertSync`; parity tests multiply; v2.0 never comes.

**Fix:** One implementation parameterized by `DriverSyncAdapter` / `DriverAsyncAdapter`; keep only thin sync wrappers.

---

## `database?: any` — type safety cosplay

```70:70:src/collection.ts
    private database?: any; // Reference to the Database instance
```

**Why this is bad:** The migration cache and upgrade runner depend on `Database` behavior but you erased the type to avoid importing a cycle you created.

**Consequences:** Refactor `Database` → silent breakage in migrations; no IDE help; violates your own AGENTS “don’t expose internals” spirit while still coupling to them.

**Fix:** `import type { Database }` and a narrow interface `MigrationHost { getCollection(name: string): Collection<...> }`.

---

## Migration failures are “non-fatal” — aka wrong schema, good luck

```343:347:src/collection.ts
            // Migration errors are non-fatal for backwards compatibility
            console.warn(
                `Migration check failed for collection '${this.collectionSchema.name}':`,
                error
            );
```

**Why this is bad:** Schema drift is a data-corruption event, not a log line. You continue serving CRUD on a table that may not match the Zod schema.

**Consequences:** Documents validate in app code but columns are missing; unique indexes never created; production-only Heisenbugs.

**Fix:** Fail closed: throw `DatabaseError` with `MIGRATION_FAILED` unless `config.lenientMigrations` is explicitly true.

---

## Upgrade failures get buried so operations look fine

```322:333:src/collection.ts
            if (
                error instanceof Error &&
                (error.message.includes('Custom upgrade') ||
                    error.message.includes('UPGRADE_FUNCTION_FAILED'))
            ) {
                this.upgradeError = error;
                console.error(
                    `Upgrade function failed for collection '${this.collectionSchema.name}':`,
                    error.message
                );
                return;
            }
```

**Why this is bad:** Custom upgrades failing only surface in `waitForInitialization()` or `upgradeError` — normal `insert` proceeds against a half-migrated schema.

**Consequences:** Seed data wrong; version counters lie; users blame SQLite.

**Fix:** Set `isInitialized = false` and reject all mutating ops until upgrade succeeds or user runs repair.

---

## Table creation fails → you warn and run migrations on rubble

```160:165:src/collection.ts
                console.warn(
                    `Table creation failed for collection '${this.collectionSchema.name}':`,
                    error
                );
                this.initializationPromise = this.runMigrationsAsync();
```

**Why this is bad:** If `createTableSync` throws for a real reason (permissions, corrupt DB), you still schedule migrations against a non-existent or broken table.

**Consequences:** `ensureInitialized` may throw later with a useless message; first query explodes.

**Fix:** Only swallow `already exists`; rethrow everything else and mark collection dead.

---

## `console.warn` is your observability platform

(Found across `src/collection.ts`, `src/database.ts`, `src/connection-manager.ts`, `src/drivers/`*, `src/migrator.ts`, plugins, etc. — dozens of calls.)

**Why this is bad:** Libraries should not spam stderr in serverless, tests, or CI. No levels, no hooks, no correlation IDs — just noise.

**Consequences:** Real warnings drown; users can’t disable chatter; log aggregators bill you for your sloppiness.

**Fix:** Inject `logger?: { warn, error }` on `DBConfig`; default to no-op in production builds.

---

## `migrator.ts` uses `console.log` like it’s a CLI tool

```351:356:src/migrator.ts
            console.log(`Migration plan for ${name} (v${storedVersion} → v${version}):`);
            ...
                console.log('  BREAKING CHANGES:', diff.breakingReasons.join(', '));
```

**Why this is bad:** Embedding a migration planner that prints to stdout inside a library JAR is how you corrupt JSON logs and break test output matchers.

**Consequences:** Silent mode impossible; structured logging pipelines ingest garbage.

**Fix:** Return `MigrationPlan` objects; let callers log. Gate debug behind `config.debugMigrations`.

---

## Global `DocumentCache` — stale reads as a service

```38:38:src/json-utils.ts
const docCache = new DocumentCache();
```

```91:114:src/json-utils.ts
export function parseDoc(json: string): any {
    const cached = docCache.get(json);
    ...
    docCache.set(json, parsed);
    return parsed;
}
```

**Why this is bad:** Process-wide cache keyed by full JSON string. Same bytes → same object identity forever until LRU evicts. Updates that rewrite `doc` with identical serialization return stale nested objects if anyone mutates in place.

**Consequences:** Subtle mutation bugs; memory held for large documents; tests flake when order of operations changes cache hits.

**Fix:** Cache per `Database` instance with explicit invalidation on write, or delete the cache — `JSON.parse` is not your bottleneck until you prove it.

---

## Module-global column registry never resets

```169:185:src/constrained-fields.ts
const registeredColumnNames = new Map<string, string>();
...
export function fieldPathToColumnName(fieldPath: string): string {
    const columnName = fieldPath.replace(/\./g, '_');
    const existing = registeredColumnNames.get(columnName);
    if (existing && existing !== fieldPath) {
        console.warn(
            `fieldPathToColumnName collision: ...
```

**Why this is bad:** Map lives for process lifetime. Test suite creates collections `a.b` and `a_b` → warning once, wrong column forever in dev. No `clear()` for tests.

**Consequences:** Cross-test pollution; collision detection is warn-only, not fail-fast.

**Fix:** Scope map to `CollectionSchema` instance; `throw new DatabaseError('COLUMN_NAME_COLLISION')` on conflict.

---

## Column collision warning instead of stopping the world

(Same snippet as above.)

**Why this is bad:** `metadata.role` and `metadata_role` both become `metadata_role`. SQLite gets one column; you overwrite data.

**Consequences:** Silent data loss — the worst class of bug.

**Fix:** Reject schema at registration time if normalized column names collide.

---

## `OFFSET` without `LIMIT` → `Number.MAX_SAFE_INTEGER` rows

```147:151:src/sql-translator.ts
        } else if (options.offset) {
            // SQLite requires LIMIT when using OFFSET, so we use a very large limit
            sqlParts.push('LIMIT ? OFFSET ?');
            params.push(Number.MAX_SAFE_INTEGER, options.offset);
```

**Why this is bad:** SQLite will try to honor a limit of 9,007,199,254,740,991. That is not pagination; that is a denial-of-service with extra steps.

**Consequences:** OOM, full table scans, “why is page 2 slow” tickets until someone gets fired.

**Fix:** Require `limit()` when using `offset()`, or use a sane cap (`config.maxPageSize`) and document it.

---

## Empty `in([])` is always false; empty `nin([])` is always true

```1071:1076:src/sql-translator.ts
            case 'in':
            case 'nin': {
                if (!Array.isArray(value) || value.length === 0) {
                    c = operator === 'nin' ? '1=1' : '1=0';
                    break;
                }
```

**Why this is bad:** SQL `IN ()` is invalid; your fix encodes Mongo-ish semantics without documenting them. Dynamic filters that pass `[]` when no IDs selected delete the entire universe or return everything for `nin`.

**Consequences:** “Delete all users” incident when `where('id').in([])` becomes `WHERE 1=0` vs developer expecting no-op or error.

**Fix:** Throw `ValidationError('in() requires a non-empty array')` or match SQL standard behavior explicitly in docs.

---

## `ilike` is `UPPER(LIKE)` — not international, not correct

```1086:1088:src/sql-translator.ts
            case 'ilike':
                c = `UPPER(${col}) LIKE UPPER(?)`;
                p.push(cv(value));
```

**Why this is bad:** Case folding without `COLLATE NOCASE` or Unicode rules. Turkish `I`, German `ß`, emoji — all wrong.

**Consequences:** Users think they have case-insensitive search; compliance demos fail.

**Fix:** Document as ASCII-only helper or use SQLite `COLLATE NOCASE` on constrained TEXT columns; expose real `GLOB`/`LIKE` options.

---

## Join row mapping uses `split('.').pop()` — name collision roulette

```684:689:src/collection.ts
                Object.keys(row).forEach((key) => {
                    if (key !== 'doc' && row[key] !== null && row[key] !== undefined) {
                        const fieldName = key.includes('.') ? key.split('.').pop() : key;
                        if (fieldName) {
                            mergedObject[fieldName] = row[key];
```

**Why this is bad:** `users.name` and `posts.name` both become `name`; last writer wins.

**Consequences:** Join queries return wrong data with no error — the most expensive bug type.

**Fix:** Namespace by table alias (`users_name`) or nested objects per join side.

---

## Plugin “timeout” does not stop the hook

```236:268:src/plugin-system.ts
                timer = setTimeout(() => {
                    abortController.abort();
                    reject(new PluginTimeoutError(plugin.name, hookName, timeout));
                }, timeout);
                ...
                    const result = Promise.resolve(
                        hookFn.call(plugin, context)
                    );
```

**Why this is bad:** You reject the waiter but the plugin’s Promise keeps running. `abortSignal` is optional for plugins — nothing awaits cancellation.

**Consequences:** Runaway audit/cache plugins under load; memory and FD leaks; “timeout” is theater.

**Fix:** Document hooks must respect `abortSignal`; use `AbortSignal.any` + cooperative cancel; for sync hooks, run in worker with hard kill (hard) or don’t claim timeout safety.

---

## `strictMode` defaults false — plugins fail quietly in prod

```82:87:src/plugin-system.ts
        this.options = {
            strictMode: false,
            defaultTimeout: 5000,
            ...options
        };
```

**Why this is bad:** `executeHookSafe` swallows plugin failures to `console.warn` unless strict. Timestamp/audit/validation plugins can fail; data pipeline thinks it ran.

**Consequences:** Missing timestamps, no audit trail, false sense of security.

**Fix:** Default `strictMode: true` for `onBeforeInsert`/`onBeforeUpdate`; or surface `db.plugins.getLastError()`.

---

## First failing plugin aborts the rest of the chain

```293:317:src/plugin-system.ts
        for (const plugin of plugins) {
            try {
                await this.executeHookWithTimeout(plugin, hookName, context);
            } catch (error) {
                ...
                throw pluginError;
            }
        }
```

**Why this is bad:** Plugin order becomes implicit priority. Metrics plugin never runs if audit plugin throws.

**Consequences:** Partial instrumentation; unpredictable behavior when adding plugins.

**Fix:** In `executeHookSafe`, catch per-plugin and continue; reserve abort for `onBefore`* validation hooks only.

---

## `require('./drivers/bun')` in your ESM TypeScript cathedral

```177:181:src/database.ts
                try {
                    const { BunDriver } = require('./drivers/bun');
                    return new BunDriver(config);
```

**Why this is bad:** `"type": "module"` package using `require` for dynamic loading. Bundlers, Deno, and strict ESM Node may choke.

**Consequences:** Broken dual-package consumers; static analysis can’t tree-shake Bun path.

**Fix:** `await import('./drivers/bun.js')` behind async factory or separate entry `skibbadb/bun`.

---

## `Driver` proxy returns `any` and pretends it’s fine

```284:290:src/database.ts
    private getDriverProxy(): Driver {
        return new Proxy({} as Driver, {
            get: (target, prop) => {
                if (this.driver) {
                    return (this.driver as any)[prop];
```

**Why this is bad:** Empty object cast to `Driver`. Sync methods on shared connections may return Promises from lazy wrappers — type lies.

**Consequences:** `collection.sync.`* on shared DB blows up at runtime; TypeScript gives false confidence.

**Fix:** Split `SyncDriver` / `AsyncDriver` types; don’t proxy sync APIs for shared connections.

---

## Global `ConnectionManager` singleton — tests share cooties

```441:446:src/connection-manager.ts
let _globalConnectionManager: ConnectionManager | undefined;

export function getGlobalConnectionManager(): ConnectionManager {
    return _globalConnectionManager ??= new ConnectionManager();
}
```

**Why this is bad:** Every `Database` with default config shares one pool, timers, and health checks.

**Consequences:** Parallel tests fight over connections; closing one DB affects others; timer leaks if `closeAll` skipped.

**Fix:** Pass `connectionManager` in `DBConfig`; no global unless `getGlobalConnectionManager()` is opt-in.

---

## Health check `SELECT 1` on every connection every 30s forever

```65:69:src/connection-manager.ts
        this.healthCheckTimer = setInterval(() => {
            void this.performHealthChecks();
            void this.cleanupIdleConnections();
        }, this.poolConfig.healthCheckInterval);
```

**Why this is bad:** Interval starts on first connection and hits all pooled LibSQL/Node drivers. Remote Turso = billed round-trips for vibes.

**Consequences:** Latency spikes; cost; battery drain on edge — for a library that claims embeddable.

**Fix:** Health checks on checkout only, or configurable `healthCheckInterval: 0` to disable.

---

## `substr` — died in ES2022, still walking here

```64:64:src/database.ts
        this._dbId = `db_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
```

**Why this is bad:** Deprecated API in three files. Linters scream; future runtimes may remove it.

**Consequences:** Noise in CI; copy-paste into consumer code.

**Fix:** `.slice(2, 11)`.

---

## Connection IDs use `Math.random()` not crypto

```432:434:src/connection-manager.ts
    private generateConnectionId(): string {
        return `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
```

**Why this is bad:** IDs are not security boundaries but collisions are possible under burst creation; debugging becomes “which conn_...” hell.

**Consequences:** Rare pool key collisions; unprofessional next to `crypto.randomUUID()` you use elsewhere.

**Fix:** `crypto.randomUUID()` everywhere for IDs.

---

## Composite unique constraints: silently skipped

```28:33:src/registry.ts
                        case 'unique':
                            if (c.fields && c.fields.length > 1) {
                                // For composite constraints, skip for now (needs table-level constraint)
                                continue;
```

**Why this is bad:** User declares composite unique in constraints API; you `continue` with no error. Data model is a lie.

**Consequences:** Duplicate pairs inserted; user trusts docs that mention constraints.

**Fix:** `throw new Error('Composite unique not supported yet')` at register time.

---

## README documents `_id` in bulk API while preaching `id` everywhere else

```390:392:README.md
await users.bulk.update([
    { _id: inserted[0].id, doc: { name: 'Ada Lovelace' } },
]);
```

**Why this is bad:** Golden API says public `id`; bulk wants `_id`. AGENTS.md says don’t expose `_id` to beginners — README exposes it in the hero doc.

**Consequences:** Every app stores `_id` in DTOs; migration pain forever.

**Fix:** Accept `{ id, doc }` in bulk APIs; keep `_id` as deprecated alias only.

---

## `test.ts` showcases `constrainedFields` — the API you told agents to hide

```20:26:test.ts
    const users = db.collection('users', userSchema, {
        constrainedFields: {
            name: { unique: true, nullable: false },
            email: { unique: true, nullable: false },
        },
```

**Why this is bad:** AGENTS.md: “Do not expose constrainedFields in beginner APIs.” Root `test.ts` is the first file greppers open.

**Consequences:** New code copies legacy option; `unique: ['email']` friendly API ignored.

**Fix:** Rewrite example with `unique: ['email']` and delete `constrainedFields` from public examples.

---

## `hello-world-plugin.js` is CommonJS debris in an ESM package

```48:59:hello-world-plugin.js
module.exports = {
    HelloWorldPlugin,
    createHelloWorldPlugin,
    helloWorldInstance,
    default: HelloWorldPlugin
};
```

**Why this is bad:** `"type": "module"` + `module.exports` = importers need `createRequire` or default interop hacks.

**Consequences:** Plugin docs that say “drop in a plugin” fail for ESM users.

**Fix:** Rename to `.cjs` or rewrite as `export class HelloWorldPlugin`.

---

## `AuditLogPlugin` defaults to `console.log` PII hose

```30:38:src/plugins/audit-log.ts
    private defaultLogger(level: string, message: string, context: PluginContext): void {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [${level.toUpperCase()}] [${this.name}] ${message}`);
        if (context.data || context.result) {
            console.log('  Context:', {
```

**Why this is bad:** Audit logs belong in append-only storage, not stdout next to “Server listening on 3000”. You log operation metadata on every insert in dev defaults.

**Consequences:** GDPR nightmares; secrets in terminal history.

**Fix:** No-op default logger; require `customLogger` or `onLog` callback.

---

## `CachePlugin` is not integrated into `get()` — useless for reads

(Cache only updates on plugin hooks `onAfterInsert` etc.; `getCachedDocument` is manual.)

**Why this is bad:** README sells CachePlugin as performance; collection never calls `getCachedDocument` during `get()`.

**Consequences:** Users enable plugin, see zero read speedup, open issues.

**Fix:** Optional read-through cache in `Collection.get` behind `enableDocumentCache`, or delete misleading plugin from “built-in” tier.

---

## `CachePlugin` FIFO eviction pretends to be LRU

```72:77:src/plugins/cache.ts
    private enforceMaxSize(cache: Map<string, CacheEntry>): void {
        if (cache.size > this.options.maxSize) {
            const keysToRemove = Array.from(cache.keys()).slice(0, cache.size - this.options.maxSize);
```

**Why this is bad:** ECMAScript `Map` iteration order is insertion order, not access order. “Oldest” ≠ “least recently used.”

**Consequences:** Hot keys evicted; cold keys stay; cache hit rate trash.

**Fix:** Use the same LRU pattern as `DocumentCache` in `json-utils.ts` or rename honestly to FIFO.

---

## `StatementCache.get` is O(n) per hit via `indexOf`

```14:20:src/drivers/statement-cache.ts
    get(sql: string): any | undefined {
        const stmt = this.cache.get(sql);
        if (stmt) {
            const idx = this.accessOrder.indexOf(sql);
            if (idx > -1) this.accessOrder.splice(idx, 1);
            this.accessOrder.push(sql);
```

**Why this is bad:** You built an LRU then linear-scan an array on every prepared statement hit. At 100 entries it’s cute; at scale it’s embarrassing.

**Consequences:** CPU burn under query-heavy workloads — the exact workload you target.

**Fix:** `Map` for order + doubly-linked list, or use `lru-cache` package.

---

## `better-sqlite3` is a hard dependency — Bun-only users still drag native addons

```26:28:package.json
        "better-sqlite3": "^12.10.0",
```

**Why this is bad:** You auto-detect Bun’s built-in SQLite then still install native bindings for Node. Bun-only CI/docker still compiles better-sqlite3.

**Consequences:** Slower installs; Alpine musl pain; broken deploys on serverless without optional deps.

**Fix:** `optionalDependencies` or `peerDependencies` for `better-sqlite3`; dynamic import only in Node driver.

---

## `validateDatabasePath` forgets `file:` URLs your own README uses

```184:197:src/sql-utils.ts
export function validateDatabasePath(path: string | undefined): string | undefined {
    ...
    if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('libsql://')) {
```

README example: `path: 'file:./data.db'`. Not listed here — falls through file rules; may work by accident, not contract.

**Consequences:** LibSQL file URLs rejected or mishandled depending on branch; user confusion.

**Fix:** Explicitly allow `file:` prefix with same `..` checks.

---

## `checkConstraint` validator allows `|` and `&` — footgun near SQL injection

```130:134:src/sql-utils.ts
    const allowedPattern =
        /^[a-zA-Z0-9_.'"\s<>=!()+\-/*%,|&[\]]+$/;
```

**Why this is bad:** User-supplied `checkConstraint` strings are concatenated into DDL. You block `;` but allow boolean OR/AND tokens. One creative constraint string away from surprise.

**Consequences:** Malicious or sloppy `advanced.constrainedFields` breaks schema or widens attack surface in multi-tenant tools.

**Fix:** Whitelist column references only; parse expression AST; or only allow predefined check templates.

---

## Vector extension failures swallowed — split brain storage

```615:621:src/collection.ts
                if (isVectorExtensionError(error)) {
                    console.warn(
                        `Warning: Vector operation failed (extension not available): ...
                    );
                } else {
                    throw error;
```

**Why this is bad:** Document insert succeeds; vector side table missing. `vector.search` later returns nothing — no hard error at write time.

**Consequences:** RAG apps ship with empty embeddings silently.

**Fix:** Fail insert when `type: 'VECTOR'` configured and extension missing, unless `allowMissingVectorExtension: true`.

---

## Bun driver hardcodes Homebrew paths like a MacBook blog post from 2023

```29:37:src/drivers/bun.ts
                const sqlitePaths = [
                    '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib',
                    '/usr/local/opt/sqlite/lib/libsqlite3.dylib',
                    ...
```

**Why this is bad:** Linux CI, Docker, NixOS — not found. You `require('fs')` in a loop and warn once.

**Consequences:** Vector search “works on my machine”; production Bun on Linux — disabled forever.

**Fix:** Env var `SKIBBA_SQLITE_PATH`; document; don’t guess paths.

---

## `orderByAsync` / `limitAsync` — async theater

```1590:1598:src/collection.ts
    async orderByAsync<K extends OrderablePaths<InferSchema<T>>>(
        field: K | string,
        direction: 'asc' | 'desc' = 'asc'
    ): Promise<QueryBuilder<InferSchema<T>>> {
        return new QueryBuilder<InferSchema<T>>(this.queryAdapter).orderBy(field as K, direction);
    }
```

**Why this is bad:** No await inside; returns immediately. API surface bloat with zero async benefit.

**Consequences:** Confusing docs; users `await collection.orderByAsync('x')` thinking IO happens.

**Fix:** Delete these methods or make them real async only if they touch network driver.

---

## Duplicate transaction starters: `tryBeginTransaction` vs `driver.transaction`

```419:428:src/collection.ts
    private async tryBeginTransaction(): Promise<boolean> {
        try {
            await this.driver.exec('BEGIN IMMEDIATE TRANSACTION', []);
```

```369:376:src/collection.ts
    private async runInTransactionIfNeeded<T>(fn: () => Promise<T>): Promise<T> {
        ...
        return this.driver.transaction(fn);
```

**Why this is bad:** Two code paths manage transactions; savepoint stack in driver vs raw `BEGIN` in collection. Easy to nest wrong.

**Consequences:** SQLITE_BUSY, nested transaction errors, partial commits.

**Fix:** Only use `driver.transaction()`; delete raw BEGIN helpers.

---

## `(result as any)._version` — schema versioning via vandalism

```98:100:src/collection-ops.ts
    const result = { ...validatedDoc };
    (result as any)._version = 1;
    return attachPublicId(result as Record<string, unknown>, publicIdField) as InferSchema<T>;
```

**Why this is bad:** OCC/version field bypasses Zod; leaks into public documents unless stripped.

**Consequences:** Users persist `_version` in API responses; Zod strict schemas fail on read.

**Fix:** Store `_version` only in SQLite column; strip on `presentDocument`.

---

## Boolean merge heuristic: only `0` and `1` flip

```138:147:src/json-utils.ts
            if (schema && (value === 0 || value === 1)) {
                try {
                    const zodType = getZodTypeForPath(schema, fieldPath);
                    if (isZodBoolean(zodType)) {
                        value = value === 1;
```

**Why this is bad:** Legitimate integer fields with values 0/1 get coerced to boolean if schema says bool — OK — but any bool stored as 2 (corrupt) stays 2.

**Consequences:** Edge-case wrong types slip through.

**Fix:** Strict equality on column affinity; use INTEGER CHECK in DDL.

---

## `getDiagnostics()` exports environment variables

```137:147:src/driver-detector.ts
        process: typeof process !== 'undefined'
            ? {
                  versions: process.versions,
                  platform: process.platform,
                  arch: process.arch,
                  env: {
                      NODE_ENV: process.env.NODE_ENV,
                      DATABASE_DRIVER: process.env.DATABASE_DRIVER,
```

**Why this is bad:** Debug helper attached to detection result can leak config into logs/support bundles.

**Consequences:** Accidental exposure of `DATABASE_DRIVER` overrides in support tickets.

**Fix:** Strip `env` from default diagnostics; opt-in `includeEnv: true`.

---

## `db.use(pluginInput: any)` — the any is doing cardio

```474:474:src/database.ts
    use(pluginInput: Plugin | PluginClass | PluginFactory | any, options?: any): this {
```

**Why this is bad:** Plugin registration is a core extensibility point typed as “whatever, we’ll figure it out.”

**Consequences:** Invalid plugins fail at runtime with `'Invalid plugin'` after three branches of duck typing.

**Fix:** Discriminated union only; remove `any` fallthrough.

---

## Plugin hook discovery scans prototype chain every register

```104:122:src/plugin-system.ts
        let currentProto: any = Object.getPrototypeOf(plugin);
        while (currentProto && currentProto !== Object.prototype) {
            for (const key of Object.getOwnPropertyNames(currentProto)) {
```

**Why this is bad:** O(prototype depth × properties) per plugin; duplicate hook registration if class hierarchy is deep.

**Consequences:** Slow startup with many plugins; double-fired hooks if not deduped correctly.

**Fix:** Require explicit `static hooks = ['onBeforeInsert']` or decorators; drop prototype walk.

---

## `Promise` detection via `constructor.name === 'Promise'`

```185:185:src/plugin-system.ts
                if (result && (result instanceof Promise || result?.constructor?.name === 'Promise')) {
```

**Why this is bad:** Thenables from other realms, `async` mocks, and cross-realm promises fail or pass wrongly.

**Consequences:** Sync path accepts disguised async; or rejects legitimate thenables.

**Fix:** Only `instanceof Promise` in same realm; use `util.types.isPromise` in Node.

---

## `FieldBuilder` types operators as `any`

```29:32:src/query-builder.ts
    protected addFilterAndReturn(
        operator: any,
        value: any,
        value2?: any
```

**Why this is bad:** Query builder is the public face; you gave up on typing filters.

**Consequences:** Typos in operator strings fail at SQL gen or runtime, not compile time.

**Fix:** Union type `QueryFilter['operator']` and generic value types per operator.

---

## `in()` / `nin()` accept `any[]` without element validation

```78:80:src/query-builder.ts
    in(values: any[]): QueryBuilder<T> {
        return this.addFilterAndReturn('in', values);
```

**Why this is bad:** Objects, nested arrays, `undefined` flow into SQL params.

**Consequences:** SQLite errors at execute time; weird coercion.

**Fix:** `in(values: readonly (string | number | boolean | null)[])`.

---

## God object `SQLTranslator` — 1,206 lines of string spaghetti

```60:60:src/sql-translator.ts
export class SQLTranslator {
```

**Why this is bad:** Single static class builds SELECT, INSERT, bulk, atomic updates, HAVING, subqueries, vectors. Untestable in isolation.

**Consequences:** One bug in HAVING breaks INSERT; reviews impossible.

**Fix:** Split `SelectTranslator`, `MutationTranslator`, `FilterTranslator`.

---

## “PERF: single allocation” — still does `sqlParts.join(' ')`

```82:83:src/sql-translator.ts
        // PERF: Use array-based building for single allocation instead of string concatenation
        const sqlParts: string[] = [];
```

```153:153:src/sql-translator.ts
        return { sql: sqlParts.join(' '), params };
```

**Why this is bad:** Comment oversells micro-optimization. You still allocate the final string and every part array element.

**Consequences:** Misleading maintainers; premature optimization noise without benchmarks in hot path.

**Fix:** Delete bragging comment or add benchmark proof in `benchmarks/`.

---

## `jsonPathCache` grows without bound per unique path

```33:42:src/sql-translator.ts
const jsonPathCache = new Map<string, string>();
const jsonPath = (field: string) => {
    validateFieldPath(field);
    ...
    jsonPathCache.set(field, cached);
```

**Why this is bad:** Long-running servers with dynamic field names (anti-pattern but happens) leak memory.

**Consequences:** Slow memory creep in multi-tenant SaaS with user-defined fields.

**Fix:** LRU cap or tie cache to collection schema lifetime.

---

## Migration cache keyed on `database || driver` object identity

```300:305:src/collection.ts
        const migrationCacheKey = (this.database || this.driver) as object;
        let migrationCache = Collection.migratedCollections.get(migrationCacheKey);
```

**Why this is bad:** Same driver instance, two `Database` wrappers → shared cache. Bump `version` in one app instance, other instance skips migration.

**Consequences:** Schema version skew across logical DB handles.

**Fix:** Include `database._dbId` in cache key always.

---

## `void initializePlugins().catch(console.warn)` — fire-and-forget init

```75:77:src/database.ts
        void this.initializePlugins().catch((error) => {
            console.warn('Plugin initialization failed:', error);
        });
```

**Why this is bad:** Constructor returns before `onDatabaseInit` completes. First `collection()` may race plugin setup.

**Consequences:** Rare races in tests; plugins miss first collection create.

**Fix:** `await` in async factory `skibbaAsync()` or block first operation on init promise.

---

## `close()` does not clear `collections` Map

```411:434:src/database.ts
    async close(): Promise<void> {
        ...
        } else if (this.driver) {
            await this.driver.close();
        }
    }
```

**Why this is bad:** Closed DB still holds `Collection` references with dead driver proxy.

**Consequences:** Use-after-close if user keeps reference; confusing errors.

**Fix:** Clear `this.collections` and mark collections closed.

---

## Shared connection: `releaseConnection` never closes driver

```340:351:src/connection-manager.ts
    async releaseConnection(
        connectionId: string,
        shared: boolean = false
    ): Promise<void> {
        ...
            connection.isActive = false;
```

**Why this is bad:** `db.close()` on shared mode releases to pool but global timer keeps running; leaked if pool never `closeAll`.

**Consequences:** Process hang on exit; open SQLite files in tests.

**Fix:** Document mandatory `getGlobalConnectionManager().closeAll()` in test teardown; expose in README.

---

## `ValidationError.enhanceMessage` recursion footgun

```29:34:src/errors.ts
        if (message === 'Document validation failed' && details) {
            return ValidationError.enhanceMessage(
                'Document validation failed',
                details
            );
```

**Why this is bad:** If `details` is ZodError but first branch missed, infinite recursion until stack overflow.

**Consequences:** Crash instead of clean validation error on edge types.

**Fix:** Guard with `details instanceof z.ZodError` only once; no recursive call with same message.

---

## `MetricsPlugin` keys include `Math.random()` — why

```102:102:src/plugins/metrics.ts
        return `${context.collectionName}:${context.operation}:${Date.now()}:${Math.random()}`;
```

**Why this is bad:** Every operation gets unique key — metrics map grows unbounded if you store by this key.

**Consequences:** Memory leak in long-running processes with metrics enabled.

**Fix:** Aggregate counters by `collection:operation`; don’t use random per event.

---

## `libsql-pool.ts` types client as `any`

```17:17:src/libsql-pool.ts
    client: any; // LibSQL client
```

**Why this is bad:** Turso integration is production-critical path typed like homework.

**Consequences:** API misuse (wrong execute method) caught only at runtime.

**Fix:** `import type { Client } from '@libsql/client'`.

---

## `vite` `preserveModules: true` with `preserveModulesRoot: '.'`

```33:37:vite.config.ts
            output: {
                preserveModules: true,
                preserveModulesRoot: '.',
                entryFileNames: '[name].js',
```

**Why this is bad:** Can emit unexpected deep paths under `dist/`; consumers importing `skibbadb` expect flat entry.

**Consequences:** Broken deep imports; duplicate modules; larger publish size.

**Fix:** `preserveModulesRoot: 'src'` or single bundle for npm `files: dist`.

---

## Dual test runners: `bun test` vs `vitest` in devDependencies

```59:60:package.json
        "test": "bun test",
```

```40:40:package.json
        "vitest": "^4.1.7"
```

**Why this is bad:** Two frameworks, one truth. AGENTS says bun; vitest config exists unused or divergent.

**Consequences:** CI and local run different suites; false confidence.

**Fix:** Delete vitest or make `npm test` run both explicitly in one script.

---

## Root `index.ts` re-exports vs package only publishing `dist`

```1:1:index.ts
export * from './src/index.js';
```

**Why this is bad:** `"files": ["dist/**/*", "README.md"]` — root `index.ts` not published; local dev may resolve differently than consumers.

**Consequences:** “Works in monorepo, fails when installed from npm” if someone imports non-dist path.

**Fix:** Point `main`/`exports` only; remove duplicate entry or document dev-only.

---

## `createDB` / `skibba` default memory DB when called with no args — footgun for scripts

```39:41:src/skibba.ts
    } else {
        config = { memory: true };
    }
```

**Why this is bad:** `skibba()` silently ephemeral. One deploy without config wipes data on restart.

**Consequences:** Data loss in production “we called skibba() like the example.”

**Fix:** Require explicit `:memory:` or `path`; no silent default in production mode (`NODE_ENV=production` throw).

---

## `handleSQLConstraintError` string-matches SQLite errors

```556:590:src/collection.ts
            if (
                stringCode?.includes('SQLITE_CONSTRAINT_FOREIGNKEY') ||
                numericCode === 787
            ) {
```

**Why this is bad:** Driver-specific messages and codes duplicated; LibSQL vs better-sqlite3 vs Bun may differ.

**Consequences:** Wrong error type thrown; users catch `UniqueConstraintError` and miss FK violations.

**Fix:** Centralize in driver adapter `normalizeError(err): SkibbaError`.

---

## `waitForInitialization` only throws `upgradeError`, not migration warn path

```380:387:src/collection.ts
    async waitForInitialization(): Promise<void> {
        if (this.initializationPromise) {
            await this.initializationPromise;
        }
        if (this.upgradeError) {
            throw this.upgradeError;
        }
    }
```

**Why this is bad:** Tests call this to be safe; migration failures that were only warned don’t throw.

**Consequences:** Tests pass; production broken schema.

**Fix:** Track `initializationError` for any fatal init failure.

---

## `plugin-system` `executeHook` rethrows after `onError` — `executeHookSafe` still only logs once

When using `executeHook` directly (if any), first failure stops chain. Documented safe path swallows — inconsistent contract.

**Fix:** Document two tiers clearly in README; rename to `executeHookStrict` vs `executeHookBestEffort`.

---

## `database.ts` `collection()` hook is `.catch(console.warn)` — errors disappear

```237:244:src/database.ts
            this.plugins
                .executeHookSafe('onCollectionCreate', {
                    ...
                })
                .catch(console.warn);
```

**Why this is bad:** `executeHookSafe` shouldn’t reject; if it does, you warn and continue. Collection exists without plugin invariant.

**Consequences:** Plugins that throw on create break silently.

**Fix:** Await in factory path or propagate to caller.

---

## `getEnvironment()` caches forever — tests can’t simulate runtime switch

```52:58:src/driver-detector.ts
let cachedEnvironment: RuntimeEnvironment | undefined;

export function getEnvironment(): RuntimeEnvironment {
    if (!cachedEnvironment) {
        cachedEnvironment = detectRuntime();
```

**Why this is bad:** Only `clearDriverCache()` clears; easy to forget in tests mocking Bun vs Node.

**Consequences:** Flaky driver detection tests order-dependent.

**Fix:** Auto-clear in vitest/bun test `afterEach` hook in test utils.

---

## `mergeConstrainedFields` comment admits import failure path that does nothing useful

```144:146:src/json-utils.ts
                } catch {
                    // If import fails, keep value as-is
                }
```

**Why this is bad:** Empty catch around `getZodTypeForPath` — if schema is broken, booleans stay 0/1 in API.

**Consequences:** API returns numbers; frontend expects booleans.

**Fix:** Log once or throw in strict mode.

---

## `FieldBuilder` execution stubs throw generic Errors

```146:148:src/query-builder.ts
    toArray(): Promise<T[]> {
        throw new Error('toArray() should not be called on FieldBuilder. Use a comparison operator first.');
```

**Why this is bad:** `users.where('age')` without comparator — runtime error, not compile-time. You have deprecated `toArray` on collection but same name here throws.

**Consequences:** Confusing stack traces; beginners chain wrong.

**Fix:** Return `Never` types via phantom brand on `FieldBuilder` until filter applied.

---

## `sql-translator` `json_extract(doc, '$.${field}')` — dots in path are JSON path, not SQL escape

```39:39:src/sql-translator.ts
        cached = `json_extract(doc, '$.${field}')`;
```

**Why this is bad:** For `profile.city`, SQLite JSON path is `$.profile.city` — correct. If validation ever slips, `'` in field breaks SQL. `validateFieldPath` saves you — but constrained column path uses different code path.

**Consequences:** Security audit flags string interpolation in SQL (even if validated).

**Fix:** Use `json_extract(doc, '$.' || ?)` with bound path parameter if SQLite version allows.

---

## `Collection` constructor calls `createTable()` synchronously in constructor

```114:114:src/collection.ts
        this.createTable();
```

**Why this is bad:** Side effects (DDL, network for shared driver) during construction. `new Collection` isn’t pure.

**Consequences:** Can’t construct metadata without hitting DB; tests need mocks immediately.

**Fix:** Lazy init on first operation only.

---

## `registry.register` throws plain `Error` not `CollectionExistsError`

```86:88:src/registry.ts
        if (this.collections.has(name)) {
            throw new Error(`Collection '${name}' is already registered`);
```

**Why this is bad:** Inconsistent error taxonomy — `database.collection` throws `CollectionExistsError`, internal registry throws generic `Error`.

**Consequences:** Catch blocks miss duplicates on internal paths.

**Fix:** Use `CollectionExistsError` everywhere.

---

## Published package excludes `AGENTS.md` and architecture docs from npm

```72:75:package.json
    "files": [
        "dist/**/*",
        "README.md"
    ]
```

**Why this is bad:** Contributors have AGENTS.md; npm consumers get README only — fine — but README is 800 lines duplicating docs/ inconsistently.

**Consequences:** Drift between docs/src and README; agents lie to humans.

**Fix:** Single doc site; README links out; shorten install quickstart.

---

## `prepublishOnly` runs clean build — good — but no test gate

```58:58:package.json
        "prepublishOnly": "npm run build:clean",
```

**Why this is bad:** You can publish broken types if tests weren’t run locally.

**Consequences:** npm package with compile errors.

**Fix:** `"prepublishOnly": "npm run build:clean && bun test"`.

---

## `dotenv` in devDependencies but not wired in library

**Why this is bad:** Dead dependency or hidden env loading in tests only — smells.

**Consequences:** Bloat; confusion about `DATABASE_DRIVER` source.

**Fix:** Remove if unused or document in test README.

---

## `test/code-review-2.test.ts` exists — meta, but you didn’t run this review in CI

**Why this is bad:** You have tests named for code review yet ship 2400-line files and global caches.

**Consequences:** Review tests rot; become green theater.

**Fix:** Wire `dumb-issues.md` checklist into CI as lint rules over time.

---

## `attachPublicId` spreads entire doc for one field

```31:31:src/document-id.ts
    return { ...doc, [publicIdField]: internalId } as T;
```

**Why this is bad:** Shallow copy on every read path — allocations in hot `mapRowToDocument` loops.

**Consequences:** GC pressure on large result sets.

**Fix:** Define property getter for `id` or mutate once in presenter with frozen doc option.

---

## `normalizeIncomingDoc` deletes public id field but keeps duplicate data in doc JSON column

```42:45:src/document-id.ts
    const next: Record<string, unknown> = { ...doc, _id: internal };
    if (publicIdField !== '_id') {
        delete next[publicIdField];
```

**Why this is bad:** If user passes both `id` and fields, stored JSON may still contain old `id` from prior merge paths.

**Consequences:** Duplicate keys in JSON blob vs column.

**Fix:** Strip public id from `stringifyDoc` payload always.

---

## `Bulk insert` uses `(doc as any)._id` in collection-ops

```170:170:src/collection-ops.ts
        const _id = (doc as any)._id || generateId();
```

**Why this is bad:** Bypasses `resolveInternalId` / `normalizeIncomingDoc` for bulk path inconsistency.

**Consequences:** Bulk and single insert disagree on ID rules.

**Fix:** Same normalization pipeline as `prepareInsertDoc`.

---

## `driver-strategies.ts` `require('better-sqlite3')` at runtime

**Why this is bad:** Same ESM/CJS split as Bun path; bundlers include empty stubs.

**Consequences:** Webpack warnings; edge bundle size.

**Fix:** Dynamic `import()` in async init.

---

## `BaseDriver.withConnectionMutexSync` sets lock depth to 1 with no queue

```113:122:src/drivers/base.ts
    protected withConnectionMutexSync<T>(operation: () => T): T {
        if (this.transactionLockDepth > 0 || this.isInTransaction) {
            return operation();
        }
        this.transactionLockDepth = 1;
        try {
            return operation();
        } finally {
            this.releaseTransactionLock();
        }
    }
```

**Why this is bad:** Async path queues; sync path does not. Concurrent sync calls from Worker threads (Node) can interleave.

**Consequences:** SQLITE_BUSY and corrupted transactions under rare threading.

**Fix:** Document single-threaded only or use proper sync mutex.

---

## `savepointStack` is public on driver per AGENTS “do not expose”

```38:38:src/drivers/base.ts
    public savepointStack: string[] = [];
```

**Why this is bad:** AGENTS.md lists `savepointStack` as internal; it’s public on `BaseDriver`.

**Consequences:** Users depend on it; you can’t refactor.

**Fix:** `protected` or `private` with accessor for tests only.

---

## `isInTransaction` public flag — same leak

```16:16:src/drivers/base.ts
    public isInTransaction = false;
```

**Why this is bad:** Mutable public state; collection checks it for nesting decisions.

**Consequences:** External code sets flag wrong → data corruption.

**Fix:** `isTransactionActive()` method only; hide flag.

---

## `explain()` and `health()` on Database accept unused collection param typing mess

```266:270:src/database.ts
    async explain<T extends z.ZodSchema>(
        _collection: Collection<T>,
        builder: QueryBuilder<InferSchema<T>>
```

**Why this is bad:** `_collection` ignored — API requires passing collection twice (builder already bound).

**Consequences:** Confusing DX.

**Fix:** `collection.explain()` only; deprecate db-level duplicate.

---

## `z.object` schemas strip unknown keys by default — document or fail

**Why this is bad:** Zod default strips unknown keys on parse; users think insert saved extra fields.

**Consequences:** Silent data loss of unlisted fields.

**Fix:** Document loudly in README; offer `strict()` schema helper in examples.

---

## `crypto.randomUUID` for IDs without configurability

```833:834:src/collection.ts
    private generateId(): string {
        return crypto.randomUUID();
```

**Why this is bad:** UUID v4 only; no ULID, no auto-increment, no custom generator hook in friendly API.

**Consequences:** Index fragmentation; users want sortable IDs — fork internals.

**Fix:** `config.idGenerator?: () => string` on collection options.

---

## `package.json` `description` says “NoSQL” — you’re JSON in SQLite columns

```4:4:package.json
    "description": "A developer-friendly, embeddable NoSQL database layer on top of SQLite
```

**Why this is bad:** Marketing != architecture. You’re SQL with JSON document ergonomics.

**Consequences:** Wrong expectations in RFPs; haters on HN correct you.

**Fix:** Honest description: “document-oriented API over SQLite.”

---

## No `engines` field in package.json

**Why this is bad:** Node 18 target in vite but not declared; Bun implied.

**Consequences:** npm installs on Node 16; native module fails cryptically.

**Fix:** `"engines": { "node": ">=18" }`.

---

## `git status` shows only `package.json` modified — review may miss unstaged WIP

**Why this is bad:** Review snapshot at conversation start may not match tree you ship.

**Consequences:** Findings reference lines that shifted.

**Fix:** Re-run review before release; pin commit SHA in review header.

---

*End of report. Fix these or admit skibbaDB is a weekend project with tests. Your call.*