# Neckbeard Code Review: skibbaDB (Pass 3)

Additional concrete issues found across tests, edge cases, documentation, and cross-cutting concerns.

---

## `$inc` uses `CAST(... AS REAL)` — destroys integer precision

`src/sql-translator.ts:565`

```ts
docExpr = `json_set(${docExpr}, '$.${update.field}', CAST(json_extract(doc, '$.${update.field}') AS REAL) + ?)`;
```

`CAST(... AS REAL)` converts to 64-bit float. Integer `9007199254740993` becomes `9007199254740992`. `$inc` on `{balance: 9007199254740993}` with `$inc: {balance: 1}` produces `9007199254740992` instead of `9007199254740994`.

**Consequence:** Financial counters and large ID sequences get silently corrupted.

**Fix:** Use `CAST(... AS INTEGER)` or let SQLite handle integer arithmetic natively without CAST.

---

## `$push` to non-array field silently creates nested array

`src/sql-translator.ts:570`

```ts
docExpr = `json_set(${docExpr}, '$.${update.field}', json_insert(COALESCE(json_extract(doc, '$.${update.field}'), json_array()), '$[#]', json(?)))`;
```

If the field holds a non-array value (string, number), `json_insert` with `$[#]` wraps or corrupts the structure depending on SQLite version.

**Consequence:** Data structure changes unexpectedly. Subsequent reads expecting a string get an array.

**Fix:** Add `json_type()` check: `CASE WHEN json_type(...) = 'array' THEN ... ELSE json_array(json(?)) END`.

---

## `insertBulk` generates SQL exceeding SQLite's `MAX_SQL_LENGTH`

`src/collection.ts:593`

```ts
await this.driver.exec(baseSQL + sqlParts.join(', '), allParams);
```

SQLite's default `SQLITE_MAX_SQL_LENGTH` is 1,000,000 bytes. With ~2000+ documents, the concatenated SQL exceeds this limit.

**Consequence:** Bulk insert fails with cryptic "string or blob too big" error. No chunking is performed.

**Fix:** Chunk into batches of ~500 documents.

---

## `insertBulk` parameter count exceeds `SQLITE_MAX_VARIABLE_NUMBER`

`src/collection.ts:581-593`

Each document may have 2+ params. SQLite's default is 32766 (newer) or 999 (older). With constrained fields, even 100 docs could exceed 999 params.

**Consequence:** "too many SQL variables" error on moderate batch sizes.

**Fix:** Chunk based on parameter count.

---

## `upsert()` returns document without `_version`

`src/collection.ts:949`

```ts
return validatedDoc;
```

Unlike `insert()` (sets `_version = 1`) and `put()` (sets `_version = currentVersion + 1`), `upsert()` returns the doc without `_version`.

**Consequence:** Callers using the returned document for subsequent `put()` calls pass `undefined` as `_version`, breaking optimistic concurrency.

**Fix:** Fetch the document after upsert to get the correct version.

---

## `page()` overflow check happens after precision is already lost

`src/query-builder.ts:420-422`

```ts
const calculatedOffset = (pageNumber - 1) * pageSize;
if (calculatedOffset > Number.MAX_SAFE_INTEGER) {
    throw new Error('Page calculation results in offset too large');
}
```

The multiplication silently loses precision *before* the check runs. `calculatedOffset` might be a rounded number that passes the check with a wrong value.

**Fix:** Check before multiplying: `if ((pageNumber - 1) > Number.MAX_SAFE_INTEGER / pageSize)`.

---

## `buildWhereClause` recursion can stack overflow on deeply nested groups

`src/sql-translator.ts:839-892`

Each nesting level adds a stack frame. Node.js allows ~10K-15K frames. A sufficiently deep `QueryGroup` tree causes `RangeError: Maximum call stack size exceeded`.

`flattenFilters` at line 815 is also recursive and will stack overflow first.

**Fix:** Convert to iterative with explicit stack, or add max depth check.

---

## `LIKE` operators don't escape `%` and `_` in user input

`src/sql-translator.ts:1163-1173`

```ts
case 'startswith':
    c = `${col} LIKE ?`;
    p.push(`${SQLTranslator.convertValue(filter.value)}%`);
    break;
case 'contains':
    c = `${col} LIKE ?`;
    p.push(`%${SQLTranslator.convertValue(filter.value)}%`);
    break;
```

Searching for "50%" becomes `LIKE '50%%'` which matches "50" followed by anything. User's literal `%` becomes a wildcard.

**Fix:** Escape `%` and `_` in user input, add `ESCAPE '\'` to the SQL.

---

## `ilike` uses `UPPER()` which doesn't handle non-ASCII Unicode

`src/sql-translator.ts:1159`

```ts
case 'ilike':
    c = `UPPER(${col}) LIKE UPPER(?)`;
```

SQLite's `UPPER()` only handles ASCII. `UPPER('ß')` returns `'ß'`, not `'SS'`. Case-insensitive search misses matches for non-ASCII text.

**Fix:** Document limitation or use ICU extension.

---

## Transaction lock queue has no timeout — deadlock on stuck transaction

`src/drivers/base.ts:59-69`

```ts
private async acquireTransactionLock(): Promise<void> {
    if (!this.transactionLockHeld) {
        this.transactionLockHeld = true;
        return;
    }
    return new Promise((resolve) => {
        this.transactionLockQueue.push(resolve);
    });
}
```

If a transaction callback never resolves (hung HTTP call, infinite loop), the lock is held forever. All subsequent `transaction()` calls queue up and wait indefinitely.

**Consequence:** Complete database deadlock. All write operations hang forever. No error, no timeout.

**Fix:** Add configurable timeout that rejects the promise and removes it from the queue.

---

## `savepointStack` not reset on rollback failure

`src/drivers/base.ts:432-441`

If `ROLLBACK TO SAVEPOINT` itself fails, `savepointStack.pop()` still runs, but the savepoint may still exist in SQLite. Stack is out of sync with actual savepoint state.

**Consequence:** Subsequent nested transactions may fail with "no such savepoint" errors.

**Fix:** If rollback fails, clear the entire savepoint stack and mark connection for reconnection.

---

## SQL injection via `buildFromClause` join collection names

`src/sql-translator.ts:663-686`

```ts
fromClause += ` ${joinType} JOIN ${join.collection} ON ...`;
```

`join.collection` is interpolated directly into SQL without `validateIdentifier()`. Unlike `tableName` which is validated.

**Fix:** Add `validateIdentifier(join.collection, 'join collection name')`.

---

## SQL injection via `buildHavingFilterClause` field names

`src/sql-translator.ts:1008`

```ts
const col = filter.field;
```

HAVING uses raw `filter.field` directly in SQL. No `validateFieldPath` or `validateIdentifier` is called. `buildFilterClause` goes through `qualifyFieldAccess` but HAVING doesn't.

**Fix:** Validate with `validateFieldPath(filter.field)`.

---

## `reconstructNestedObject` overwrites intermediate objects with non-object values

`src/json-utils.ts:220-244`

```ts
for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current)) {
        current[part] = {};
    }
    current = current[part];
}
```

Flat object with keys `{ "a": 5, "a.b": 10 }` — when processing `"a.b"`, `current['a']` is `5` (a number), and `current['b'] = 10` tries to set a property on a number.

**Fix:** Check `typeof current[part] !== 'object' || current[part] === null` and overwrite with `{}`.

---

## `mergeConstrainedFields` sets flat key instead of nested path

`src/json-utils.ts:166`

```ts
mergedObject[fieldPath] = value;
```

For constrained field `"metadata.role"`, this sets `mergedObject["metadata.role"] = "senior"` instead of `mergedObject.metadata.role = "senior"`. The dotted string is used as a literal key.

**Consequence:** The authoritative constrained column value is placed at the wrong path. The stale JSON value remains at the correct nested path.

**Fix:** Use `setNestedValue(mergedObject, fieldPath, value)`.

---

## `putSync` doesn't check `changes()` for version mismatch

`src/collection.ts:1468-1519`

Unlike async `put()` which passes `currentVersion` to `buildUpdateQuery` for optimistic concurrency, `putSync()` doesn't pass `expectedVersion`. The update always succeeds regardless of version.

**Consequence:** Lost updates in concurrent scenarios. The sync path has weaker consistency guarantees than async.

**Fix:** Pass `currentVersion` as `expectedVersion` and check `changes()`.

---

## `json_array_contains` operator crashes on non-array field values

`src/sql-translator.ts:1178`

```ts
case 'json_array_contains':
    c = `EXISTS (SELECT 1 FROM json_each(${col}) WHERE value = ?)`;
```

`json_each` on a non-array JSON value (string, number) throws: "json_each() requires an array or object."

**Fix:** Add type guard: `json_type(${col}) = 'array' AND EXISTS (...)`.

---

## `qualifyFieldAccess` ambiguity: nested path vs table-prefixed field

`src/sql-translator.ts:707-738`

If you join `orders` with `users`, and `orders` has a JSON field `users.rating` (a nested path), the code interprets `users` as a table prefix and generates `json_extract(users.doc, '$.rating')` instead of `json_extract(orders.doc, '$.users.rating')`.

**Consequence:** Incorrect query results when nested field names collide with table names in JOINs.

**Fix:** Check `constrainedFields` for the full dotted path first before splitting on dots.

---

## `DocumentCache.set()` stores mutable reference, not clone

`src/json-utils.ts:64-75`

```ts
this.cache.set(key, value);  // stores the original reference
```

`get()` returns a `deepClone`, but `set()` stores the original. If the caller mutates the object between `parseDoc` returning and the next `get()`, the cached copy is already mutated.

**Fix:** Deep clone on `set()` as well.

---

## `stringifyDoc` crashes on `BigInt`

`src/json-utils.ts:85-106`

`JSON.stringify` throws `TypeError: Do not know how to serialize a BigInt`. No handling for `BigInt`, `Symbol`, or function values. `undefined` fields are silently dropped.

**Fix:** Add explicit handling in `transformDates` for `BigInt` (tag as `{__type: 'BigInt', value: '...'}`) and throw clear errors for functions/symbols.

---

## `VectorBufferPool` never shrinks — unbounded memory for unique dimension sizes

`src/sql-translator.ts:42-67`

Each unique dimension size creates a new pool entry that's never cleaned up. The Map grows without bound across dimension sizes.

**Fix:** Add periodic cleanup of empty pools or a global max pool count.

---

## `VectorBufferPool` never actually reused in practice

`src/sql-translator.ts:333-341`

The pool acquires a buffer, immediately creates a copy (`new Float32Array(vectorArray)`), then releases the original. `release()` zeros the buffer, so the next `acquire()` returns a zeroed buffer that gets overwritten anyway. The overhead likely exceeds the cost of just allocating.

**Fix:** Remove the pool and just allocate `new Float32Array(vectorValue)`.

---

## Stale "BusNDB" / "busndb" references throughout docs

`README.md:728,755`, `docs/src/vector_search.md:3,42,85,135,389,392`, `docs/src/pagination.md:3,7,140,215`, `docs/src/plugins.md:1107`

```ts
import { ValidationError, NotFoundError, UniqueConstraintError } from 'busndb';
```

The package is named `skibbadb`. These imports reference a completely different (old?) package name.

**Consequence:** Users copy-pasting examples get `Cannot find module 'busndb'`.

**Fix:** Replace all `busndb` / `BusNDB` references with `skibbadb` / `skibbaDB`.

---

## `ForeignKeyError` documented but doesn't exist

`docs/constrained-fields.md:381`

```ts
import { UniqueConstraintError, ForeignKeyError } from 'skibbaDB/errors';
```

`ForeignKeyError` is never defined in `src/errors.ts`. Also, `skibbaDB/errors` subpath import doesn't exist — `package.json` `exports` only defines `"."`.

**Fix:** Either create the error class and subpath export, or change docs to use `ValidationError`.

---

## `docs/src/schema.md` shows `foreignKey` as object, code uses string

`docs/src/schema.md:188-189,379,394-395`

```ts
foreignKey: { table: 'users', column: 'id' },
```

Actual code (`src/types.ts:77`): `foreignKey?: string; // 'table.column'`

**Consequence:** Every constrained field with a foreign key defined per the docs will crash.

**Fix:** Change all doc examples to string format: `foreignKey: 'users._id'`.

---

## `docs/src/schema.md` shows `type: 'string'` instead of `'TEXT'`

`docs/src/schema.md:177,394,398,399`

```ts
email: {
    type: 'string',    // Wrong! Not a valid value
    unique: true,
},
```

Valid values are `'TEXT' | 'INTEGER' | 'REAL' | 'BLOB' | 'VECTOR'`.

**Fix:** Replace all `type: 'string'` with `type: 'TEXT'`.

---

## `docs/src/schema.md` shows `onDelete: 'cascade'` (lowercase) but code expects `'CASCADE'`

`docs/src/schema.md:189,395`

```ts
onDelete: 'cascade',
onUpdate: 'cascade'
```

Actual code (`src/types.ts:78-79`): `onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT'`

**Fix:** Use uppercase values in all docs.

---

## `docs/src/collection.md` and `database.md` show `type: 'unique'` in constrainedFields

`docs/src/collection.md:1122-1125`, `docs/src/database.md:1229-1231,1437,1474`

```ts
email: { type: 'unique' },
```

`'unique'` is not a valid `type` value. The correct way is `{ unique: true }`. `type` expects SQL types like `'TEXT'`.

**Fix:** Change to `email: { unique: true, nullable: false }`.

---

## `docs/src/database.md` uses `filename` config key, code uses `path`

`docs/src/database.md:1163,1171,1178,1185,1223,1466`

```ts
const db1 = createDB({
    filename: path.resolve(__dirname, 'mydb.sqlite'),
});
```

`DBConfig` has no `filename` property. It uses `path`.

**Consequence:** Database created with `undefined` path (in-memory), not at the specified file. Silent data loss on restart.

**Fix:** Replace all `filename:` with `path:`.

---

## `docs/src/plugins.md` references `db.getPluginManager()` which doesn't exist

`docs/src/plugins.md:897`

```ts
db.getPluginManager().setStrictMode(true);
```

The property is `db.plugins`. No `getPluginManager()` method exists.

**Fix:** Change to `db.plugins.setStrictMode(true)`.

---

## `docs/ATOMIC_UPDATES_OCC.md` references `users.query()` method that doesn't exist

`docs/ATOMIC_UPDATES_OCC.md:222-225,275-279,456-460`

```ts
const results = await users.query().select('name', 'email').toArray();
```

No `.query()` method on `Collection`. Query builder is accessed via `.where()`, `.orderBy()`, etc.

**Fix:** Remove `.query()` calls.

---

## `docs/src/vector_search.md` shows `result.id` but actual type has `result._id`

`docs/src/vector_search.md:103`

```ts
console.log(`ID: ${result.id}`);
```

The property is `_id`, not `id`. `result.id` will be `undefined`.

**Fix:** Change to `result._id`.

---

## `docs/src/vector_search.md` shows `manhattan` distance but type only allows `l1`

`docs/src/vector_search.md:238`

`'manhattan'` is not a valid value. The type uses `'l1'` for Manhattan distance.

**Fix:** Change to `'l1'`.

---

## README Quick Start shows sync API but claims "Async by Default"

`README.md:66-76`

```ts
const user = users.insert({ ... });  // No await!
```

But README line 16 and 90 claim "Async by Default". `insert()` returns a `Promise`.

**Consequence:** Users get `Promise` objects instead of data, leading to `undefined` access errors.

**Fix:** Add `await` to all Quick Start examples.

---

## README transaction example mixes sync and async incorrectly

`README.md:689-722`

```ts
await db.transaction(async () => {
    const newDept = departments.insert({ ... });  // Missing await!
    for (const member of teamMembers) {
        users.insert(member);  // Missing await!
    }
});
```

Inside an `async` transaction callback, `insert()` calls are not awaited. Operations fire-and-forget, not part of the transaction.

**Consequence:** Transactions provide zero atomicity in this example.

**Fix:** Add `await` before all `insert()` calls.

---

## `.gitignore` has broken glob patterns

`.gitignore:6-7,19,24-25`

```
_.log
npm-debug.log_
report.[0-9]_.[0-9]_.[0-9]_.[0-9]_.json
_.pid
_.seed
```

These use `_` where they should use `*`. `_.log` only matches a file literally named `_.log`.

**Consequence:** Log files, pid files, and diagnostic reports are NOT being ignored.

**Fix:** Replace `_` with `*`.

---

## `tsconfig.json` includes `"DOM"` in `lib` for a server-side database library

`tsconfig.json:4`

```json
"lib": ["ESNext", "DOM"],
```

Including `"DOM"` means TypeScript won't catch accidental usage of browser APIs (`document`, `window`, `fetch`).

**Fix:** Remove `"DOM"` from `lib`.

---

## `tsconfig.build.json` uses `moduleResolution: "node"` conflicting with ESM output

`tsconfig.build.json:7`

Node module resolution doesn't properly handle ESM imports (mandatory `.js` extensions). Source files use mixed extension/extensionless imports.

**Fix:** Use `"moduleResolution": "node16"` or `"bundler"`.

---

## `zod` in `dependencies` instead of `peerDependencies`

`package.json:31`

Consumers already use Zod. Hard dependency means two copies may be installed.

**Fix:** Move to `peerDependencies`.

---

## `test` script uses `bun test` but `vitest.config.ts` exists

`package.json:48`

```json
"test": "bun test",
```

`bun test` ignores vitest config entirely. The vitest config (aliases, timeouts, pool settings) is dead configuration.

**Fix:** Change to `"test": "vitest run"` or remove `vitest.config.ts`.

---

## Missing `require` export condition for CJS consumers

`package.json:9-14`

No `"require"` condition. CJS consumers using `require('skibbadb')` get `ERR_REQUIRE_ESM`. The `main` field pointing to `./dist/index.js` implies CJS compatibility.

**Fix:** Remove `main` field or add CJS build.

---

## `schema-constraints.ts` uses `snake_case` vs `UPPER_CASE` in `ConstrainedFieldDefinition`

`src/schema-constraints.ts:24-25` vs `src/types.ts:78-79`

```ts
// deprecated API:
onDelete?: 'cascade' | 'set_null' | 'restrict' | 'no_action'
// new API:
onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT'
```

`registry.ts:52` converts with `.toUpperCase()`, but `'set_null'.toUpperCase()` = `'SET_NULL'` which does NOT match `'SET NULL'` (space vs underscore).

**Consequence:** Migrating from old constraints API silently produces invalid `onDelete` values, causing SQL syntax errors.

**Fix:** Map `'set_null'` -> `'SET NULL'` explicitly instead of `.toUpperCase()`.

---

## `DatabaseError` error code inconsistency — SQL string used as error code

`src/drivers/base.ts:399`, `src/drivers/node.ts:362-368,423-429`

```ts
throw new DatabaseError(`Failed to execute: ${error.message}`, sql);
```

The second parameter is `code?: string`, but the Node driver passes the SQL query string as the "code". Meanwhile `database.ts` passes proper codes like `'DRIVER_CREATION_FAILED'`. Bun driver passes no code at all.

**Fix:** Always pass proper error codes. Use a separate field for SQL context.

---

## Inconsistent import extensions (`.js` vs no extension)

Mixed across the codebase:
- `src/collection.ts:11` — `from './schema-sql-generator.js'`
- `src/collection.ts:9` — `from './query-builder'` (no `.js`)
- `src/drivers/node.ts:4` — `from './base.js'`
- `src/drivers/bun.ts:4` — `from './base'` (no `.js`)

In ESM, `.js` extensions are required for Node.js resolution. Missing extensions may work in Bun but fail in Node.js ESM.

**Fix:** Use `.js` extensions consistently.

---

## `atomicUpdate()` doesn't validate the resulting document

`src/collection.ts:692-748`

`insert()` and `put()` validate via Zod schema. `atomicUpdate()` with `$set` can set fields to values that violate the schema because it never validates the final document state.

**Consequence:** Data integrity violations: `atomicUpdate()` can write invalid data that would be rejected by `put()`.

**Fix:** Validate at least the `$set` values against the schema.

---

## `QueryBuilder.where()` doesn't validate field names

`src/query-builder.ts:166-171`

`Collection.where()` validates field names (line 1096), but `QueryBuilder.where()` accepts any field name. Queries silently build against nonexistent fields, returning empty results instead of failing fast.

**Fix:** Validate field names when a collection is bound.

---

## `insertBulkSync` has no SAVEPOINT support (vs async which uses `driver.transaction()`)

`src/collection.ts:1317-1389`

Async `insertBulk()` uses `driver.transaction()` which handles nested transactions via SAVEPOINTs. Sync version uses raw `BEGIN/COMMIT/ROLLBACK` which fails if already in a transaction.

**Consequence:** Calling `insertBulkSync()` inside an existing transaction throws "cannot start a transaction within a transaction".

---

## `isPluginFactory` detection is unreliable

`src/database.ts:446-453`

```ts
private isPluginClass(obj: any): obj is new (options?: any) => Plugin {
    return typeof obj === 'function' && obj.prototype && 
            (obj.prototype.name !== undefined || obj.prototype.constructor === obj);
}
```

`obj.prototype.constructor === obj` is true for ALL ES6 classes AND regular functions. Regular non-arrow functions have prototypes and would be misidentified as classes.

**Fix:** Require plugins to be explicitly tagged or check `Plugin` interface compliance after calling/constructing.

---

## Missing integration: Vector search + transactions

`src/collection.ts:413-458`

Vector data is stored in separate `vec0` virtual tables. If the main document insert succeeds but the vector insert fails (logged as warning), the document exists without its vector data. Vector operations are not part of the same transaction.

**Consequence:** Documents exist without corresponding vector index entries. `vectorSearch()` returns incomplete results.

**Fix:** Execute vector operations within the same transaction as the main document operation.

---

## `rebuildIndexesSync()` doesn't rebuild vector indexes

`src/collection.ts:1971-2060`

Async `rebuildIndexes()` (line 1939-1945) rebuilds vector indexes. Sync version does NOT.

**Consequence:** Running `rebuildIndexesSync()` leaves vector indexes inconsistent while constrained columns are fixed.

---

## Inconsistent plugin hook firing: gaps in audit trail

- `delete()` fires `onBeforeDelete`/`onAfterDelete` but NOT `onError`
- `iterator()` fires `onBeforeQuery` but NOT `onAfterQuery`
- `count()` fires NO hooks
- `first()` fires NO hooks
- `atomicUpdateSync()` fires NO hooks (but async `atomicUpdate()` does)
- `deleteBulk()` fires NO bulk-level hooks (delegates to individual `delete()`)

**Consequence:** Security-critical audit trails have gaps. Plugins can't reliably track all operations.

**Fix:** Every public operation should fire consistent `onBefore*`/`onAfter*`/`onError` hooks.

---

## `as any` abuse in tests: 98 instances

Worst offenders: `optimistic-concurrency.test.ts` (25), `plugin-system.test.ts` (19), `integration.test.ts` (14), `critical-fixes.test.ts` (14).

```ts
expect((user as any)._version).toBe(1);
const docId = (doc as any)._id;
const driver = await (db as any).ensureDriver();
```

Every `as any` is a bug report about the types. If `_version` gets renamed, all 25 OCC tests still compile but fail at runtime.

**Fix:** Add `_version` to the document type. Expose `ensureDriver()` on the public type or test differently.

---

## Benchmark tests disguised as unit tests

`upsert.test.ts:64-298`, `update-performance-analysis.test.ts`, `upsert-benchmark.test.ts`, `index-benchmark.test.ts`, `bun-driver-benchmark.test.ts`, `benchmark.test.ts`, `benchmark-jsonb.test.ts`

```ts
expect(simpleUpsertResult!.opsPerSecond).toBeGreaterThan(100);
```

These aren't tests — they're benchmarks with `expect()` duct-taped on. `opsPerSecond > 100` passes on any modern machine. 30s timeouts waste CI time.

**Fix:** Move to `bench/` directory. Use a real benchmarking tool.

---

## `console.log` spam: 206 instances across test files

`select.test.ts:407,704,731`, `upsert-benchmark.test.ts` (43 occurrences), `update-performance-analysis.test.ts` (30+), `query-builder-bugs.test.ts` (12).

```ts
console.log('nested', results);
console.log('3-level deep results:', JSON.stringify(results, null, 2));
```

Debug logging left in test files. Pollutes CI output.

**Fix:** Delete all `console.log` statements.

---

## Tests that assert nothing meaningful

`integration.test.ts:196-198`:
```ts
expect(users.where('age').notExists().toArraySync().length).toBeGreaterThanOrEqual(0);
```

Array lengths are never negative. This passes regardless of implementation.

`critical-fixes.test.ts:121`:
```ts
expect(duration).toBeGreaterThan(0);
```

Always true.

`integration.test.ts:237-250` — `distinct()` test:
```ts
expect(res.length).toBeGreaterThan(1);
```

`distinct()` without a field returns all docs (since `_id` makes each unique). Trivially true.

**Fix:** Assert exact counts or specific expected values.

---

## Skipped tests for core features

`schema-constraints.test.ts:211,257,305`

```ts
it.skip('should validate foreign key references on insert', () => { ... });
it.skip('should validate foreign key references on update', () => { ... });
it.skip('should enforce check constraints', async () => { ... });
```

FK validation and check constraints are core features. Skipping them means these paths are untested.

---

## Composite unique constraint test lies about what it verifies

`schema-constraints.test.ts:158-207`

Test titled "should enforce composite unique constraints" actually tests that duplicates ARE allowed (line 200-207). The test name is the opposite of what it verifies.

---

## Vector search tests require external OpenAI API key

`vector-search.test.ts:8-27`

```ts
const response = await fetch('https://api.openai.com/v1/embeddings', {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ input: text, model: 'text-embedding-3-small' }),
});
```

Tests call a live external API with real money costs. Require `OPENAI_API_KEY`. Impossible to run in most CI setups.

**Fix:** Mock the embedding function or use pre-computed embeddings.

---

## Missing `afterEach` cleanup in 7+ test files

`migrations.test.ts`, `nested-field-validation.test.ts`, `non-unique-index.test.ts`, `or-queries.test.ts`, `query-builder.test.ts`, `schema-constraints.test.ts`, `sql-injection.test.ts`

Create `db` instances in `beforeEach` but never close them.

**Consequence:** Memory pressure and potential file descriptor exhaustion in long test runs.

**Fix:** Add `afterEach(() => { if (db) db.close(); })`.

---

## Stress tests accept 20-30% failure rate

`connection-management.test.ts:521,582`

```ts
expect(successes.length).toBeGreaterThan(numRequests * 0.8);  // 80% success
expect(successes.length).toBeGreaterThan(numOperations * 0.7);  // 70% success
```

"At least 80% success" means 20% of operations can silently fail and the test still passes. This accepts data loss as normal.

**Fix:** Assert 100% success or explicitly test degradation behavior.

---

## `process.env` mutation without isolation in tests

`migrations.test.ts:164-185`

```ts
process.env.SKIBBADB_MIGRATE = 'print';
```

Mutating `process.env` affects all concurrent tests. If another test reads `SKIBBADB_MIGRATE` during this test, it gets the wrong value.

**Fix:** Use `vi.stubEnv()` which auto-restores.

---

## `bug.todo.txt` documents known bugs with no timeline

`bug.todo.txt`

```
- Bulk operations are inefficient and should be optimized.
- validateFieldName might not validate all field names.
- Synchronous methods don't fully support the plugin system.
```

Known bugs shipped in the repo. The sync+plugins issue contradicts documentation.

---

## `ConstrainedFieldDefinition` in README missing `VECTOR` type and vector properties

`README.md:441`

```ts
interface ConstrainedFieldDefinition {
    type?: 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB';
}
```

Actual code (`src/types.ts:74`): includes `'VECTOR'`, `index`, `vectorDimensions`, `vectorType`.

**Fix:** Sync the interface with source.

---

## `docs/src/database.md` references non-existent `poolSize`, `verbose`, `mode` config options

`docs/src/database.md:1188,1469,199-200`

```ts
poolSize: 10,
// verbose, mode, etc.
```

None of these exist in `DBConfig`. `poolSize` should be `connectionPool: { maxConnections: 10 }`.

**Fix:** Use actual config properties.

---

## `vite.config.ts` `preserveModules` with root entry produces unexpected output

`vite.config.ts:33-36`

```ts
output: {
    preserveModules: true,
    preserveModulesRoot: '.',
    entryFileNames: '[name].js',
},
```

With entry `index.ts` (which re-exports from `src/index.js`), output will have `dist/index.js` and `dist/src/*.js`. The `package.json` exports point to `./dist/index.js` which must correctly resolve.

**Fix:** Verify build output matches exports. Consider `preserveModulesRoot: 'src'`.
