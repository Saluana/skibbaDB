# Neckbeard Code Review: skibbaDB

Concrete, line-level bugs, footguns, and dumb issues found across the codebase.

---

## `$inc`/`$push` on same field silently loses operations

`src/sql-translator.ts:557-574`

```ts
docExpr = `json_set(${docExpr}, '$.${update.field}', CAST(json_extract(doc, '$.${update.field}') AS REAL) + ?)`;
docExpr = `json_set(${docExpr}, '$.${update.field}', json_insert(COALESCE(json_extract(doc, '$.${update.field}'), json_array()), '$[#]', json(?)))`;
```

`json_extract(doc, ...)` always reads from the **original** `doc` column, not the progressively-built `docExpr`. Two `$inc` ops on the same field: second reads pre-increment value. Two `$push` ops: second overwrites first.

**Consequence:** `{ $inc: { count: 1 }, $inc: { count: 2 } }` results in `count + 2`, not `count + 3`. Silent data corruption.

**Fix:** Replace `doc` with `docExpr` in the `json_extract` calls so each operation reads from the result of the previous one.

---

## `$inc` on non-existent JSON field silently produces NULL

`src/sql-translator.ts:565`

```ts
CAST(json_extract(doc, '$.${update.field}') AS REAL) + ?
```

If the field doesn't exist, `json_extract` returns `NULL`. `CAST(NULL AS REAL)` is `NULL`. `NULL + 5` is `NULL`. Field gets set to `null`.

**Consequence:** `$inc` on a missing field silently writes `null`. No error, no warning.

**Fix:** `COALESCE(CAST(json_extract(doc, '$.${update.field}') AS REAL), 0) + ?`

---

## Hash collision in DocumentCache causes silent data corruption

`src/json-utils.ts:48-74`

```ts
get(json: string): any | undefined {
    const key = hashString(json);
    const cached = this.cache.get(key);
```

FNV-1a produces a 32-bit hash. With 1000 cache slots, birthday paradox means collisions are likely around ~37 entries. Two different JSON strings hashing to the same value return each other's cached data.

**Consequence:** User A's data returned for User B's query. Undetectable in tests.

**Fix:** Use the full JSON string as the Map key, or use a 64-bit hash, or verify the cached key matches the input.

---

## `require()` in ESM module — will crash at runtime

`src/json-utils.ts:155`

```ts
const { getZodTypeForPath, isZodBoolean } = require('./constrained-fields');
```

`package.json` declares `"type": "module"`. `require()` is not available in ESM. Throws `ReferenceError: require is not defined` whenever a constrained field with a boolean schema is read.

**Consequence:** Every boolean constrained field read crashes in production.

**Fix:** Use top-level `import` or `await import()`. Restructure to avoid the circular dependency.

---

## `vite.config.ts` mangles `_`-prefixed properties

`vite.config.ts:52-53`

```ts
mangle: {
    properties: {
        regex: /^_/,
    },
```

Renames all properties starting with `_` in the output. Zod uses `_def` extensively. `_id` is the primary key field. This breaks the entire library.

**Consequence:** Production build is broken. `_id`, `_version`, `_def` all get mangled to random names.

**Fix:** Remove property mangling entirely, or scope it to private class fields only.

---

## Migrator `generateSchemaDiff` compares new schema against itself

`src/migrator.ts:278-283`

```ts
let oldSchema: z.ZodSchema | null = null;
if (storedVersion > 0) {
    oldSchema = schema;  // BUG: sets old schema to the NEW schema
}
const diff = this.generateSchemaDiff(oldSchema, schema, name);
```

When `storedVersion > 0`, `oldSchema` is set to the current `schema` — same as `newSchema`. Diff is always empty.

**Consequence:** Auto-migration is completely non-functional for existing collections. Adding a field and bumping version does nothing.

**Fix:** Store/retrieve the old schema, or remove auto-diff and rely on upgrade functions.

---

## `delete()` always returns `true` — even when nothing is deleted

`src/collection.ts:864-880`

```ts
async delete(_id: string): Promise<boolean> {
    await this.driver.exec(sql, params);
    return true;
}
```

Never checks `changes()`. If `_id` doesn't exist, still returns `true`.

**Consequence:** `deleteBulk` (line 889) does `if (await this.delete(_id)) count++` — count always equals `ids.length` regardless of how many documents existed. The returned count is a lie. Tests at `integration.test.ts:332` and `:340` codify this wrong behavior.

**Fix:** Check `changes()` after DELETE and return `false` if 0 rows affected.

---

## `isInTransaction` stuck `true` if `BEGIN` fails

`src/drivers/base.ts:444-453`

```ts
this.isInTransaction = true;
try {
    await this.exec('BEGIN');
} finally {
    this.releaseTransactionLock();
}
```

`isInTransaction` set to `true` **before** `BEGIN` executes. If `BEGIN` throws, `isInTransaction` is never reset. All subsequent transactions see `isNested = true` and use savepoints on a non-existent transaction.

**Consequence:** Every transaction after a failed `BEGIN` silently becomes a savepoint that never gets a parent `BEGIN`. Database is effectively broken until restart.

**Fix:** Set `isInTransaction = true` only **after** `BEGIN` succeeds.

---

## SQL injection via aggregate alias

`src/sql-translator.ts:695`

```ts
const alias = agg.alias ? ` AS ${agg.alias}` : '';
return `${agg.function}(${distinctPrefix}${fieldAccess})${alias}`;
```

`agg.alias` interpolated directly into SQL with zero validation. A user-controlled alias like `"; DROP TABLE users; --` gets injected verbatim.

**Fix:** Validate with `validateIdentifier(agg.alias, 'aggregate alias')`.

---

## SQL injection via `checkConstraint`

`src/schema-sql-generator.ts:110`

```ts
columnDef += ` CHECK (${fieldDef.checkConstraint.replace(new RegExp(`\\b${fieldPath}\\b`, 'g'), columnName)})`;
```

`checkConstraint` is an arbitrary user-provided string interpolated directly into SQL. The `.replace()` only swaps field names for column names.

**Fix:** Validate against a strict whitelist, or document as trusted-input-only and enforce with runtime validation.

---

## Empty `IN` array produces SQL syntax error

`src/sql-translator.ts:1149`

```ts
const placeholders = filter.value.map(() => '?').join(', ');
c = `${col}${filter.operator === 'nin' ? ' NOT' : ''} IN (${placeholders})`;
```

If `filter.value` is `[]`, produces `col IN ()` — SQL syntax error.

**Fix:** Short-circuit: `filter.operator === 'nin' ? '1=1' : '1=0'`.

---

## `or()` with no prior filters produces AND, not OR

`src/query-builder.ts:275-279`

```ts
} else if (orConditions.length > 0) {
    for (let i = 0; i < orConditions.length; i++) {
        cloned.options.filters.push(orConditions[i]);
    }
}
```

When no existing filters, OR conditions pushed individually into flat filter array. Default join is `AND`.

**Consequence:** `builder.or(fn)` with no prior `.where()` produces AND semantics. Silent logic bug.

**Fix:** Wrap in an OR group: `cloned.options.filters = [{ type: 'or', filters: orConditions }]`.

---

## `exec()`/`_query()` silently return on closed database

`src/drivers/node.ts:319-322, 371-374`

```ts
async exec(sql: string, params: any[] = []): Promise<void> {
    if (this.isClosed) {
        return;  // silent success
    }
```

Writes to a closed database silently "succeed." Inside a transaction, if the database closes mid-transaction, subsequent writes return success but nothing is persisted.

**Consequence:** Silent data loss. Caller has no way to know the write was dropped.

**Fix:** Throw `DatabaseError('Cannot execute on closed database')`.

---

## LibSQL pool transactions are fundamentally broken

`src/drivers/node.ts:327-335`

```ts
const connection = await this.libsqlPool.acquire();
try {
    await connection.client.execute({ sql, args: params });
} finally {
    await this.libsqlPool.release(connection);
}
```

Each statement acquires and releases a **different** connection. `BEGIN` runs on connection A, queries on B/C/D, `COMMIT` on E.

**Consequence:** Transactions over pooled LibSQL provide zero atomicity. Data can be partially committed.

**Fix:** Pin a single connection for the entire transaction duration.

---

## `SELECT changes()` is fragile and race-prone with async drivers

`src/collection.ts:654-656`

```ts
const checkSql = `SELECT changes() as affected`;
const checkResult = await this.driver.query(checkSql, []);
const affected = checkResult[0]?.affected || 0;
```

`changes()` returns count from the **last** statement on that connection. With async drivers (libsql), another query could execute between the UPDATE and `SELECT changes()`.

**Consequence:** `put()` can incorrectly throw `VersionMismatchError` when the update succeeded, or silently succeed when it should have thrown.

**Fix:** Use `driver.exec()` return value or `RETURNING` clause.

---

## TOCTOU race in `insert()` existence check

`src/collection.ts:487-495`

```ts
if (docWithPossibleId._id) {
    _id = docWithPossibleId._id;
    const existing = await this.findById(_id);
    if (existing) {
        throw new UniqueConstraintError(...);
    }
}
```

Between `findById` and the actual `INSERT`, another concurrent insert can insert the same `_id`.

**Fix:** Remove the pre-check. Let SQLite's UNIQUE constraint handle it, translate in catch block.

---

## `upsertSync` is a read-then-write race condition

`src/collection.ts:1597-1607`

```ts
upsertSync(_id: string, doc: Omit<InferSchema<T>, '_id'>): InferSchema<T> {
    const existing = this.findByIdSync(_id);
    return existing
        ? this.putSync(_id, doc as Partial<InferSchema<T>>)
        : this.insertSync({ ...doc, _id } as any);
}
```

Async `upsert` uses `ON CONFLICT` (atomic). Sync version does separate read then write.

**Consequence:** `insertSync` can fail with unique constraint violation. `putSync` can fail with NotFoundError.

**Fix:** Use `INSERT ... ON CONFLICT DO UPDATE` in the sync version too.

---

## `Buffer.from(queryVectorArray.buffer)` sends wrong data for subarray views

`src/collection.ts:1804`

```ts
const queryVectorArray = new Float32Array(options.vector);
const params: any[] = [Buffer.from(queryVectorArray.buffer), limit];
```

If `options.vector` is a typed array subarray, `.buffer` returns the **underlying** ArrayBuffer which may be larger than the view.

**Consequence:** Vector search returns wrong results or crashes with dimension mismatch.

**Fix:** `Buffer.from(queryVectorArray.buffer, queryVectorArray.byteOffset, queryVectorArray.byteLength)`

---

## `convertSQLiteValue` converts NULL to `undefined` — silently drops data

`src/json-utils.ts:193-194`

```ts
if (value === null) {
    return undefined;
}
```

`null` and `undefined` have different semantics. A field explicitly set to NULL becomes `undefined`, which `JSON.stringify` drops entirely.

**Consequence:** Field that was explicitly set to null vanishes from serialized output. Silent data loss.

**Fix:** Return `null`, not `undefined`.

---

## `ensureInitialized()` silently proceeds if initialization failed

`src/collection.ts:246-250`

```ts
private async ensureInitialized(): Promise<void> {
    if (!this.isInitialized && this.initializationPromise) {
        await this.initializationPromise;
    }
}
```

If `initializationPromise` resolves but `isInitialized` is still `false` (because init caught an error), subsequent calls skip the await and proceed.

**Consequence:** Every operation proceeds against a non-existent table, producing cryptic errors.

**Fix:** Check `this.isInitialized` after await and throw if still false.

---

## Missing `ensureInitialized()` in 5 public methods

`src/collection.ts:802, 864, 882, 900, 965` — `putBulk`, `delete`, `deleteBulk`, `upsert`, `upsertBulk` don't call `ensureInitialized()`.

**Consequence:** Race condition on startup. These methods can fail with cryptic SQLite errors if called before table creation.

**Fix:** Add `await this.ensureInitialized()` at the top of each method.

---

## `toArray()` and `iterator()` don't merge constrained fields

`src/collection.ts:1131-1132`

```ts
const rows = await this.driver.query(sql, params);
const results = rows.map((row) => parseDoc(row.doc));
```

`findById` has special logic to SELECT and merge constrained field columns. `toArray` and `iterator` don't.

**Consequence:** Data inconsistency. Constrained fields updated via atomic operations have correct values in `findById` but stale values in `toArray`.

**Fix:** Replicate the constrained-field SELECT and `mergeConstrainedFields` logic.

---

## Connection manager health timer prevents process exit

`src/connection-manager.ts:62-65`

```ts
this.healthCheckTimer = setInterval(() => {
    this.performHealthChecks();
    this.cleanupIdleConnections();
}, this.poolConfig.healthCheckInterval);
```

`setInterval` keeps the Node.js event loop alive. Process won't exit even after all work is done.

**Consequence:** Node.js processes hang indefinitely. Tests never finish. CLI tools don't return.

**Fix:** `this.healthCheckTimer.unref()`.

---

## `cleanupIdleConnections` fire-and-forgets async `removeConnection`

`src/connection-manager.ts:126`

```ts
connectionsToRemove.forEach((id) => this.removeConnection(id));
```

`removeConnection` is `async`. `forEach` doesn't await — creates dangling promises. If `close()` throws, unhandled promise rejection.

**Fix:** `await Promise.allSettled(connectionsToRemove.map((id) => this.removeConnection(id)))`.

---

## `lastError` used uninitialized when `retryAttempts` is 0

`src/connection-manager.ts:177, 213`

```ts
let lastError: Error;
// loop might not execute if retryAttempts is 0
throw new DatabaseError(
    `Failed after ${this.poolConfig.retryAttempts} attempts: ${lastError!.message}`,
```

If `retryAttempts` is `0`, `lastError` is `undefined`, `lastError!.message` throws `TypeError`.

**Fix:** `let lastError: Error = new Error('No connection attempts were made');`

---

## Useless ternary — both branches identical

`src/database.ts:46-48`

```ts
this.connectionManager = config.connectionPool
    ? globalConnectionManager
    : globalConnectionManager;
```

`connectionPool` config option does nothing.

**Fix:** Remove the ternary or implement the intended behavior.

---

## `initializePlugins()` is fire-and-forget in constructor

`src/database.ts:58, 96-102`

```ts
this.initializePlugins();  // returns Promise<void>, not awaited
```

If `onDatabaseInit` hook throws, becomes an unhandled promise rejection.

**Fix:** `.catch(err => console.warn('Plugin initialization failed:', err))`.

---

## `transaction()` override is completely dead code

`src/drivers/node.ts:598-618`

```ts
async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.libsqlPool) {
        return await super.transaction(fn);
    } else if (this.dbType === 'libsql') {
        return await super.transaction(fn);
    } else {
        return await super.transaction(fn);
    }
}
```

All three branches do the exact same thing. Pure dead copy-paste code.

**Fix:** Delete the entire override.

---

## LibSQL error message swallows real error

`src/drivers/node.ts:241-245`

```ts
} catch (error) {
    throw new Error('libsql client not found. Install with: npm install @libsql/client');
}
```

Any error during LibSQL initialization (network failure, auth error, bad URL) is caught and replaced with "libsql client not found." Original error is lost.

**Fix:** Check if error is actually a module-not-found error before replacing the message.

---

## `isMixedEnvironment()` always returns `true` in Bun

`src/driver-detector.ts:410-422`

```ts
const hasNodeVersions =
    typeof process !== 'undefined' &&
    process.versions &&
    !!process.versions.node &&
    !!process.versions.bun;
return hasBun && hasNodeVersions;
```

Bun sets both `process.versions.node` (for compat) and `process.versions.bun`. Result: always `true` in Bun.

**Consequence:** Every Bun user sees a false "Mixed runtime environment detected" warning.

**Fix:** Remove the check or change to detect actually contradictory signals.

---

## `exec()` doesn't use prepared statement cache

`src/drivers/node.ts:347-349`

```ts
if (this.db.prepare) {
    const stmt = this.db.prepare(sql);
    stmt.run(params);
}
```

`_query()` uses `this.prepareStatement(sql, ...)` to cache. `exec()` calls `this.db.prepare(sql)` directly every time.

**Consequence:** Every `exec()` call (including `BEGIN`, `COMMIT`, `ROLLBACK`, PRAGMA setup) creates and discards a prepared statement.

**Fix:** Use `this.prepareStatement(sql, () => this.db!.prepare(sql))`.

---

## `configureSQLite` cache calculation always uses 50% multiplier

`src/drivers/base.ts:304-308`

```ts
if (this.queryCount < 100) {
    baseCacheBytes *= 0.5;
} else if (this.queryCount >= 1000) {
    baseCacheBytes *= 1.5;
}
```

`configureSQLite` runs during driver initialization, before any queries. `this.queryCount` is always `0`. The `>= 1000` branch is dead code. Cache is always at 50%.

**Fix:** Remove the query-count-based adjustment or re-apply PRAGMAs periodically.

---

## `PRAGMA auto_vacuum` set after table creation has no effect

`src/drivers/base.ts:350`

```ts
this.execSync(`PRAGMA auto_vacuum = ${sqliteConfig.autoVacuum}`);
```

`PRAGMA auto_vacuum` only takes effect on a completely empty database or after `VACUUM`. If run after any `CREATE TABLE`, silently ignored.

**Fix:** Document this limitation, or run `VACUUM` after setting.

---

## `validateIdentifier` regex doesn't match its documentation

`src/sql-utils.ts:9-13`

```ts
// SQLite identifiers must:
// - Contain only alphanumeric characters, underscores, and dots (for schema.table)
const VALID_IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
```

Comment says dots are allowed. Regex does not allow dots.

**Fix:** Fix the comment or update the regex.

---

## Subquery correlation regex breaks on multiline SQL

`src/sql-translator.ts:952-963`

```ts
subquerySql = originalBuild.sql.replace(
    /WHERE (.+?)( GROUP BY| HAVING| ORDER BY| LIMIT|$)/,
    `WHERE $1 AND ${correlationCondition}$2`
);
```

`.` doesn't match newlines by default. `buildSelectQuery` produces multi-line SQL. If WHERE clause contains `LIMIT` or `ORDER` as part of a string literal, regex breaks.

**Fix:** Use the `s` flag or build correlation into the query builder.

---

## Foreign key heuristic produces garbage names for irregular plurals

`src/sql-translator.ts:946-948`

```ts
const foreignKeyField = tableName!.endsWith('s') 
    ? tableName!.slice(0, -1) + 'Id'
    : tableName! + 'Id';
```

`categories` → `categorieId`. `people` → `peopleId`. `buses` → `buseId`. All wrong.

**Fix:** Require the foreign key field to be specified explicitly, or use a proper pluralization library.

---

## `buildCreateTableQuery` doesn't include `_version` column

`src/sql-translator.ts:606-609`

```ts
return `CREATE TABLE IF NOT EXISTS ${tableName} (
    _id TEXT PRIMARY KEY,
    doc BLOB NOT NULL
)`;
```

`buildUpdateQuery` and `buildUpsertQuery` reference `_version`, but this doesn't create the column.

**Consequence:** If this table creation path is used, every update/upsert crashes with "no such column: _version".

**Fix:** Add `_version INTEGER NOT NULL DEFAULT 1`.

---

## `sanitizeForErrorMessage` replaces semicolons with lookalike Unicode char

`src/sql-utils.ts:237`

```ts
.replace(/;/g, '\u037e');   // Greek Question Mark — looks like semicolon
```

Copy-pasting error messages into code introduces invisible character bugs.

**Fix:** Use a clearly different replacement like `[semi]`.

---

## `static migratedCollections` is an unbounded memory leak

`src/collection.ts:48`

```ts
private static migratedCollections = new Set<string>();
```

Entries added but never removed. In a long-running server with dynamic databases, grows forever.

**Fix:** Use a `WeakSet` keyed on database instance, or scope per-database.

---

## LRU cache `accessOrder` array is O(n) per access

`src/json-utils.ts:53-56`

```ts
const idx = this.accessOrder.indexOf(key);
if (idx > -1) {
    this.accessOrder.splice(idx, 1);
}
this.accessOrder.push(key);
```

`indexOf` + `splice` on up to 1000 elements is O(n). Every cache hit does a linear scan. Defeats the purpose of a performance cache.

**Fix:** Use a `Map` (preserves insertion order) and delete/re-insert to move to end.

---

## LRU cache duplicates keys in `accessOrder`

`src/json-utils.ts:64-74`

```ts
set(json: string, value: any): void {
    // ...
    this.cache.set(key, value);
    this.accessOrder.push(key);  // Always pushes, even if key already exists
}
```

If `set` called for existing key, pushed again without removing old entry. `accessOrder` grows unboundedly.

**Fix:** Remove existing key from `accessOrder` before pushing.

---

## `cacheStatement` can have duplicate entries in `cacheAccessOrder`

`src/drivers/base.ts:118-119`

```ts
this.statementCache.set(sql, stmt);
this.cacheAccessOrder.push(sql);
```

Same bug as above. If `cacheStatement` called with already-cached SQL, duplicates accumulate.

**Fix:** Remove existing entry before pushing.

---

## Plugin `executeHookSafe` logs wrong timeout value

`src/plugin-system.ts:277`

```ts
console.warn(
    `Plugin '${error.pluginName}' hook '${hookName}' timed out after ${error.hookName} - ` +
    'consider increasing timeout or optimizing plugin performance'
);
```

`${error.hookName}` printed where timeout duration should be. Reads: `"timed out after onBeforeInsert"` instead of `"timed out after 5000ms"`. Copy-paste bug.

**Fix:** Use the actual timeout value.

---

## Plugin timeout doesn't cancel the running hook

`src/plugin-system.ts:190-227`

```ts
timer = setTimeout(() => {
    reject(new PluginTimeoutError(plugin.name, hookName, timeout));
}, timeout);
```

When timeout fires, Promise rejects but hook keeps running in background. If hook is doing database writes, it continues executing after caller has moved on.

**Fix:** Use `AbortController` or cancellation token pattern.

---

## `executeHookSync` doesn't respect `strictMode`

`src/plugin-system.ts:134-173`

`executeHookSafe` respects `strictMode` (swallows errors when not strict), but `executeHookSync` always throws. Inconsistent.

**Fix:** Check `strictMode` in `executeHookSync`.

---

## Migrator silently swallows errors in `setStoredVersion`

`src/migrator.ts:89-95`

```ts
if (error instanceof Error && error.message.includes('cannot start a transaction within a transaction')) {
    console.warn(`Could not update migration version for '${collectionName}'`);
    return;
}
```

If version can't be recorded, migration will re-run on next startup. Silently breaks idempotency.

**Fix:** Throw. Let the caller decide.

---

## `checkAndRunMigration` skips all migrations in test environment

`src/migrator.ts:251-258`

```ts
if (process.env.NODE_ENV === 'test') {
    if (upgrade || seed) {
        // ...
    } else {
        return;
    }
}
```

Production code branches on `NODE_ENV === 'test'`. If a user runs their app with `NODE_ENV=test` in CI, migrations silently don't run.

**Fix:** Remove this. Tests should configure their own behavior.

---

## `ZodInt` doesn't exist in Zod

`src/migrator.ts:170`

```ts
case 'ZodInt':
    return 'INTEGER';
```

There is no `ZodInt` type in Zod. `z.number().int()` produces `ZodNumber` with a check. Dead code.

**Fix:** Remove it.

---

## LibSQL pool: `createConnection` timer leak

`src/libsql-pool.ts:138-145`

```ts
const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
        reject(new DatabaseError(...));
    }, this.config.createTimeout);
});
```

Timeout timer never cleared on success. If `createLibSQLClient()` resolves quickly, timer keeps running and keeps event loop alive.

**Fix:** `clearTimeout` when the race resolves.

---

## LibSQL pool: `acquire()` race condition on connection creation

`src/libsql-pool.ts:96-103`

```ts
if (this.connections.length < this.config.maxConnections) {
    const connection = await this.createConnection();
```

Between checking `this.connections.length` and `await createConnection()` completing, other concurrent `acquire()` calls can also pass the check and exceed `maxConnections`.

**Fix:** Increment a counter before `await`, or use a semaphore.

---

## LibSQL pool: `process.once('exit', cleanup)` can't be async

`src/libsql-pool.ts:61`

```ts
process.once('exit', cleanup);
```

`exit` event does not support async operations. Node.js terminates before the promise resolves.

**Fix:** Remove the `exit` handler. Only `beforeExit`, `SIGINT`, `SIGTERM` support async cleanup.

---

## `insertBulk` builds SQL by string concatenation — fragile

`src/collection.ts:580-593`

```ts
sqlParts.push(sql.substring(sql.indexOf('VALUES ') + 7));
const baseSQL = firstQuery.sql.substring(0, firstQuery.sql.indexOf('VALUES ') + 7);
await this.driver.exec(baseSQL + sqlParts.join(', '), allParams);
```

If `buildInsertQuery` ever changes format (lowercase `values`, comment containing "VALUES"), this breaks. If `indexOf('VALUES ')` returns `-1`, `substring(6)` returns garbage.

**Fix:** Have `SQLTranslator` expose a `buildBulkInsertQuery` method.

---

## `upsert()` manual transaction management can leak transactions

`src/collection.ts:908-955`

If `COMMIT` fails (line 946), caught by outer catch which tries `ROLLBACK` — but the outer catch is the *same* try/catch, so the ROLLBACK error is swallowed.

**Consequence:** Leaked open transactions under failure conditions, blocking all subsequent writes.

**Fix:** Use `this.driver.transaction()` like `put()` does.

---

## `tryBeginTransaction` mutates driver internals

`src/collection.ts:289, 312`

```ts
(this.driver as any).isInTransaction = true;
```

Bypasses driver's own transaction state management.

**Fix:** Use the driver's public transaction API.

---

## `upsertBulk` fires insert hooks — but upserts can be updates

`src/collection.ts:971, 985`

If all documents already exist, fires `onBeforeInsert`/`onAfterInsert` for what are actually updates.

**Fix:** Fire both hooks, or introduce `onBeforeUpsert`/`onAfterUpsert`.

---

## `getOptions()` called per-row in iterator

`src/collection.ts:2173-2174`

```ts
for await (const row of this.collection['driver'].queryIterator(sql, params)) {
    const options = this.getOptions();
```

Called on every row. For a million-row result set, that's a million unnecessary calls.

**Fix:** Move `const options = this.getOptions()` before the loop.

---

## `validateFieldName` silently accepts any field for complex schemas

`src/collection.ts:1067-1077`

If schema is not a `ZodObject` (e.g., `ZodIntersection`, `ZodUnion`), `validFields` stays empty, and any field name is accepted.

**Consequence:** Typos in field names produce empty results instead of errors.

**Fix:** Throw if schema type can't be introspected.

---

## `rebuildIndexes` comparison doesn't handle type coercion

`src/collection.ts:1924`

```ts
if (currentValue !== expectedValue) {
```

SQLite may return `0` (number) while `convertValueForStorage` returns `'0'` (string). `0 !== '0'` is `true`.

**Consequence:** Unnecessary writes and false `fixed > 0` reports.

**Fix:** Normalize both values before comparison.

---

## `insertBulkSync` existence check outside transaction

`src/collection.ts:1330-1334`

Existence checks happen before the transaction begins. Between check and insert, another operation could insert the same ID.

**Fix:** Move the existence check inside the transaction block.

---

## `BunDriver` spread params can blow the call stack

`src/drivers/bun.ts:148, 170, 191, 212`

```ts
stmt.run(...params);
stmt.all(...params);
```

JavaScript has max ~65K-130K arguments. Large bulk inserts throw `RangeError: Maximum call stack size exceeded`.

**Fix:** Bun's `stmt.run()` accepts arrays directly: `stmt.run(params)`.

---

## `qualifyFieldAccess` COALESCE in JOINs returns wrong value when field is legitimately NULL

`src/sql-translator.ts:754-762`

```ts
return `COALESCE(${attempts.join(', ')})`;
```

If a field legitimately contains `null` in the first table, COALESCE skips it and returns the value from a different table.

**Consequence:** Silent data corruption in JOIN query results.

**Fix:** Use explicit table prefixes instead of COALESCE.

---

## `closeDatabaseSync` calls potentially async `close()` without awaiting

`src/drivers/node.ts:655-659`

```ts
} else if (this.db.close) {
    this.db.close();
    console.warn('Warning: Called a potentially asynchronous close()...');
}
```

If `close()` returns a promise, calling it without `await` means fire-and-forget. `this.db = undefined` runs immediately but actual close is still in flight.

**Consequence:** Database file might still be locked after `closeSync()` returns.

---

## `handleSQLConstraintError` re-throws raw non-object errors

`src/collection.ts:327-399`

```ts
if (error && typeof error === 'object') {
    // all the checks
}
throw error;  // raw string/number re-thrown
```

If `error` is a string, bypasses all checks and is re-thrown. Callers expecting `Error` instance break.

**Fix:** `throw error instanceof Error ? error : new Error(String(error));`

---

## `stringifyDoc` doesn't handle circular refs, `Map`, `Set`, `undefined`

`src/json-utils.ts:85-106`

`JSON.stringify` throws on circular references, silently drops `undefined`, converts `Map`/`Set` to `{}`.

**Fix:** Add circular reference detection. Document limitations.

---

## `fieldPathToColumnName` collision

`src/constrained-fields.ts:169-171`

```ts
export function fieldPathToColumnName(fieldPath: string): string {
    return fieldPath.replace(/\./g, '_');
}
```

`user.name` and `user_name` both map to `user_name`. Schema with both fields collides.

---

## `UpgradeRunner.runUpgrades` passes wrong `fromVersion`

`src/upgrade-runner.ts:31-35`

Every upgrade step receives the same `fromVersion` (original stored version). If upgrading v1→v3, both v2 and v3 upgrades see `fromVersion: 1`. v3 should see `fromVersion: 2`.

---

## `@types/better-sqlite3` in `dependencies` instead of `devDependencies`

`package.json:28`

Type packages belong in `devDependencies`. Bloats install size and causes version conflicts.

---

## `@libsql/client` and `sqlite-vec` should be `peerDependencies`

`package.json:27,30`

Optional drivers shouldn't be forced on all users.

---

## `vite.config.ts` `drop_console: true` strips intentional warnings

`vite.config.ts` terser config strips all `console.log`/`console.warn` from the build — including intentional warnings in `migrator.ts` and `plugin-system.ts`.

---

## `vite.config.ts` entry point is wrong

`vite.config.ts:7`

```ts
entry: resolve(__dirname, 'index.ts'),
```

Entry is `index.ts` at root, but `src/index.ts` is the actual entry.

---

## Tests use `setTimeout(100)` for async coordination

`test/upgrade-functions.test.ts:46,96,127,170,222,265,300,365` and `test/migrations.test.ts:157`

```ts
await new Promise((resolve) => setTimeout(resolve, 100));
```

Textbook flaky test pattern. On slow CI, 100ms may not be enough.

**Fix:** Use `await collection.waitForInitialization()`.

---

## `Registry.get()` unsafe cast

`src/registry.ts:117-121`

```ts
get<T extends z.ZodTypeAny = any>(name: string): CollectionSchema<T> | undefined {
    return this.collections.get(name) as CollectionSchema<T>;
}
```

Caller can specify any `T` and get back `CollectionSchema<T>` regardless of what was registered.

---

## `CollectionSchema` generic default is `any`

`src/types.ts:87`

```ts
export interface CollectionSchema<T extends z.ZodTypeAny = any> {
```

Any code using `CollectionSchema` without a type parameter silently opts out of type safety.

---

## `Driver` interface uses `any[]` for params

`src/types.ts:52-53`

```ts
exec(sql: string, params?: any[]): Promise<void>;
query(sql: string, params?: any[]): Promise<Row[]>;
```

Should be `unknown[]` or a union of valid SQLite types.

---

## `Row` interface is `Record<string, any>`

`src/types.ts:69-71`

`any` leaks through every query result. `unknown` would force callers to narrow types.
