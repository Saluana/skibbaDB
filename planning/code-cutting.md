# skibbaDB Lightweight Refactor Plan

## Goal

Make skibbaDB lighter internally without removing useful features or making the developer experience worse.

The main rule is:

Keep the API nice. Cut internal duplication, hidden startup cost, and optional feature overhead.

Do not shrink the QueryBuilder feature set. Do not force users into multiple imports like `skibbadb/core`, `skibbadb/vector`, or `skibbadb/plugins`. The default experience should stay:

```ts
import { skibba } from 'skibbadb';
```

## Current Problems To Fix

### 1. QueryBuilder has good features but messy internals

The QueryBuilder supports useful things like:

```ts
where()
or()
groupBy()
having()
join()
aggregate()
sum()
avg()
min()
max()
arrayContains()
arrayLength()
subquery filters
pagination
sync execution
async execution
```

Do not remove these.

The problem is implementation weight:

* Execution methods are added later through prototype patching.
* `Collection` manually attaches itself to new builders using `(builder as any).collection = this`.
* `FieldBuilder` and `HavingFieldBuilder` are mostly the same class with different filter targets.
* Aliases and compatibility methods risk duplicating logic.
* Query result mapping is partly mixed into prototype methods.

### 2. Collection has too much sync/async duplication

`src/collection.ts` has many async methods and matching sync versions:

```ts
insert / insertSync
insertBulk / insertBulkSync
put / putSync
putBulk / putBulkSync
delete / deleteSync
deleteBulk / deleteBulkSync
upsert / upsertSync
upsertBulk / upsertBulkSync
atomicUpdate / atomicUpdateSync
findById / findByIdSync
toArray / toArraySync
count / countSync
first / firstSync
```

The code already notes that sync/async duplication should eventually be refactored.

Do not remove the sync API right now. Instead, extract shared preparation and mapping helpers so async and sync only differ at the driver call.

### 3. Vector support loads too eagerly

`src/drivers/driver-strategies.ts` statically imports `sqlite-vec` and tries to load it during normal `better-sqlite3` startup.

This is not ideal for a lightweight DB because most users will not use vector search.

Vector support should be loaded only when vector functionality is actually needed.

### 4. Optional systems should not create startup cost

These systems should cost almost nothing until used:

```ts
sqlite-vec
LibSQL pooling
connection manager health checks
metrics timers
migrations
upgrade runner
built-in plugins
```

The user should still be able to import them from the main package, but normal database startup should not eagerly initialize them.

## Non-Goals

Do not do these:

* Do not remove QueryBuilder features.
* Do not remove joins, aggregates, groupBy, having, subqueries, JSON array helpers, or pagination.
* Do not force package splitting on users.
* Do not break the main import path.
* Do not remove sync APIs in this refactor.
* Do not do a v2 breaking cleanup yet.
* Do not change public behavior unless tests prove the old behavior was broken.

## ~~Phase 1: Refactor QueryBuilder Without Removing Features~~ ✅

### ~~Task 1: Add real collection binding to QueryBuilder~~ ✅

Current bad pattern:

```ts
const builder = new QueryBuilder<InferSchema<T>>();
(builder as any).collection = this;
return builder.limit(count);
```

Replace with:

```ts
const builder = new QueryBuilder<InferSchema<T>>(this);
return builder.limit(count);
```

Update `QueryBuilder` constructor to accept an optional collection reference.

Expected shape:

```ts
export class QueryBuilder<T> {
  constructor(
    private readonly collection?: QueryCollectionAdapter<T>,
    private readonly options: QueryOptions = { filters: [] }
  ) {}
}
```

Avoid importing the full `Collection` type if it causes circular import pain. Use a small adapter interface instead.

Example:

```ts
interface QueryCollectionAdapter<T> {
  executeQuery(options: QueryOptions): Promise<T[]>;
  executeQuerySync(options: QueryOptions): T[];
  executeCount(options: QueryOptions): Promise<number>;
  executeCountSync(options: QueryOptions): number;
  explainQuery(options: QueryOptions): Promise<ExplainResult>;
}
```

### ~~Task 2: Remove QueryBuilder prototype patching~~ ✅

Move methods like these directly into the `QueryBuilder` class:

```ts
toArray()
all()
exec()
iterator()
first()
executeCount()
explain()
toArraySync()
allSync()
firstSync()
countSync()
```

Do not attach them later with:

```ts
QueryBuilder.prototype.toArray = ...
QueryBuilder.prototype.all = ...
```

Expected result:

```ts
async all(): Promise<T[]> {
  if (!this.collection) {
    throw new Error('Collection not bound to query builder');
  }

  return this.collection.executeQuery(this.options);
}
```

### ~~Task 3: Move query execution into Collection~~ ✅

QueryBuilder should build query options. Collection should execute them.

Add internal methods to `Collection`:

```ts
executeQuery<TOut>(options: QueryOptions): Promise<TOut[]>
executeQuerySync<TOut>(options: QueryOptions): TOut[]
executeQueryIterator<TOut>(options: QueryOptions): AsyncIterableIterator<TOut>
executeCount(options: QueryOptions): Promise<number>
executeCountSync(options: QueryOptions): number
explainQuery(options: QueryOptions): Promise<ExplainResult>
```

This keeps SQL translation and row mapping closer to the collection schema and driver.

### ~~Task 4: Merge FieldBuilder and HavingFieldBuilder~~ ✅

Current structure has `HavingFieldBuilder` extending `FieldBuilder` just to route filters to `having`.

Replace with one class:

```ts
type FilterTarget = 'where' | 'having';

class FieldBuilder<T, K extends QueryablePaths<T> | string> {
  constructor(
    private readonly field: K,
    private readonly builder: QueryBuilder<T>,
    private readonly target: FilterTarget = 'where'
  ) {}
}
```

Then:

```ts
where(field) {
  return new FieldBuilder(field, this, 'where');
}

having(field) {
  return new FieldBuilder(field, this, 'having');
}
```

All operator methods stay the same.

### ~~Task 5: Keep aliases, but make them one-line wrappers~~ ✅

For compatibility methods, do not duplicate logic.

Example:

```ts
orderByBatch(orders) {
  // real implementation
}

/** @deprecated Use orderByBatch instead. */
orderByMultiple(orders) {
  return this.orderByBatch(orders);
}
```

Do this for all legacy or duplicate query helpers.

## ~~Phase 2: Refactor Collection Duplication~~ ✅

### ~~Task 6: Extract shared document preparation helpers~~ ✅

Create helpers for logic currently repeated between async and sync methods.

Suggested file:

```txt
src/collection-ops.ts
```

Suggested helpers:

```ts
prepareInsertDoc()
prepareUpdateDoc()
prepareUpsertDoc()
prepareBulkInsertDocs()
prepareBulkUpdateDocs()
normalizeAndResolveId()
validateAndSerializeDoc()
prepareVectorWrites()
prepareVectorDeletes()
mapWriteResult()
```

These helpers should be pure where possible.

Async and sync methods should look like:

```ts
const prepared = this.prepareInsert(doc);
await this.driver.exec(prepared.sql, prepared.params);
return this.mapInsertedRow(prepared);
```

Sync version:

```ts
const prepared = this.prepareInsert(doc);
this.driver.execSync(prepared.sql, prepared.params);
return this.mapInsertedRow(prepared);
```

The only difference should be `exec` vs `execSync`, and hook execution.

### ~~Task 7: Keep grouped APIs as the preferred DX~~ ✅

Keep these:

```ts
users.bulk.insert()
users.sync.insert()
users.atomic.update()
users.vector.search()
```

Keep old methods for now, but convert them to aliases.

Example:

```ts
/** @deprecated Use users.bulk.insert() instead. */
insertBulk(docs) {
  return this.bulk.insert(docs);
}
```

Do not keep two real implementations.

### ~~Task 8: Add tests before refactoring Collection~~ ✅

Before changing `Collection`, add tests for:

```ts
insert and insertSync produce the same document shape
put and putSync increment version the same way
upsert and upsertSync behave the same way
bulk insert preserves ids
bulk delete deletes the same rows
atomic update works async and sync
public id field maps correctly
_id still works
plugins still run in async mode
sync methods still reject plugins if that is current behavior
vector cleanup still happens where applicable
```

Then refactor.

## ~~Phase 3: Improve Bulk Operations~~ ✅

### ~~Task 9: Replace deleteBulk loop with one SQL query~~ ✅

Current behavior likely loops through IDs and calls delete repeatedly.

Replace with a batched statement:

```sql
DELETE FROM table_name
WHERE _id IN (?, ?, ?)
RETURNING _id
```

Then clean vector rows for returned IDs if needed.

Preserve plugin behavior as much as possible. If per-document plugin hooks are currently expected, either:

1. Keep per-document hooks but batch the SQL, or
2. Document that bulk hooks run once per bulk operation.

For now, safest path is to preserve current behavior unless tests show no one depends on per-document hooks.

### ~~Task 10: Replace upsertBulk loop with batched upsert~~ ✅

Use SQLite:

```sql
INSERT INTO table_name (_id, doc)
VALUES (?, json(?)), (?, json(?))
ON CONFLICT(_id) DO UPDATE SET
  doc = excluded.doc,
  _version = table_name._version + 1
```

Then fetch affected rows once.

Must preserve:

```ts
_id
public id field
_version incrementing
schema validation
constrained fields
vector fields
```

Add tests before and after.

## ~~Phase 4: Lazy-Load Vector Support~~ ✅

### ~~Task 11: Remove static sqlite-vec import from driver-strategies~~ ✅

Current pattern:

```ts
import * as sqliteVec from 'sqlite-vec';
```

Replace with dynamic loading.

Suggested helper:

```ts
async function tryLoadSqliteVec(db: unknown): Promise<boolean> {
  try {
    const sqliteVec = await import('sqlite-vec');
    sqliteVec.load(db as any);
    return true;
  } catch {
    return false;
  }
}
```

For sync drivers where `await import()` is awkward, use `createRequire` inside the function:

```ts
function tryLoadSqliteVecSync(db: unknown): boolean {
  try {
    const sqliteVec = require('sqlite-vec');
    sqliteVec.load(db as any);
    return true;
  } catch {
    return false;
  }
}
```

### ~~Task 12: Only load vector extension when needed~~ ✅

Add a flag based on collection schemas:

```ts
databaseNeedsVectorSupport()
collectionHasVectorFields()
```

Only load sqlite-vec when:

```ts
collection has vector fields
or vectorSearch is called
or config.vector === true
```

Normal `skibba('app.db')` should not load vector support.

### ~~Task 13: Improve vector error messages~~ ✅

If user calls vector search without the optional dependency installed, show a clear message:

```txt
Vector search requires sqlite-vec. Install it with:
npm install sqlite-vec
```

Do not show this warning during normal DB startup.

## ~~Phase 5: Make Optional Systems Lazy~~ ✅

### ~~Task 14: Make connection manager lazy~~ ✅

If there is a global connection manager, do not instantiate it at module import time.

Use:

```ts
let globalConnectionManager: ConnectionManager | undefined;

export function getGlobalConnectionManager(): ConnectionManager {
  return globalConnectionManager ??= new ConnectionManager();
}
```

Only call this when shared connections are explicitly needed.

### ~~Task 15: Avoid startup timers unless the feature is used~~ ✅

Check these areas:

```txt
connection-manager.ts
libsql-pool.ts
plugins/metrics.ts
```

Rules:

* Importing skibbaDB should not start timers.
* Opening a basic local DB should not start health checks.
* Metrics timers should start only when MetricsPlugin is instantiated and registered.
* Pool health checks should start only when pooling is explicitly enabled.

### ~~Task 16: Keep root exports, but avoid eager initialization~~ ✅

Keep this simple for users:

```ts
import { skibba, TimestampPlugin, MetricsPlugin } from 'skibbadb';
```

But make sure exporting these symbols does not initialize optional runtime behavior.

Do not require users to import from subpaths unless they want to.

## ~~Phase 6: Simplify Plugin Internals~~ ✅

### ~~Task 17: Keep plugin system, reduce hook discovery magic~~ ✅

The plugin system has known hook names:

```ts
onBeforeInsert
onAfterInsert
onBeforeUpdate
onAfterUpdate
onBeforeDelete
onAfterDelete
onBeforeQuery
onAfterQuery
onBeforeTransaction
onAfterTransaction
onTransactionError
onDatabaseInit
onDatabaseClose
onCollectionCreate
onCollectionDrop
onError
```

Use a constant list of known hook names.

Avoid prototype walking or arbitrary `on*` discovery if present.

### ~~Task 18: Keep built-in plugins but make them cheap~~ ✅

Keep:

```ts
TimestampPlugin
ValidationPlugin
CachePlugin
MetricsPlugin
AuditLogPlugin
```

But they should do nothing unless explicitly registered with `db.use()` or similar.

## ~~Phase 7: Clean Legacy Constraints Carefully~~ ✅

### ~~Task 19: Do not remove deprecated constraints yet~~ ✅

`schema-constraints.ts` is deprecated but should not be removed in this pass.

For now:

* Keep compatibility.
* Make deprecated helpers thin wrappers.
* Prefer the newer friendly collection options.

Preferred user API:

```ts
db.collection('users', userSchema, {
  id: 'id',
  unique: ['email'],
  index: ['createdAt'],
  references: {
    teamId: 'teams.id'
  }
});
```

Future v2 can remove deprecated constraint helpers.

## ~~Phase 8: Validation and Benchmarking~~ ✅

### ~~Task 20: Add startup behavior tests~~ ✅

Add tests that prove:

```txt
importing skibbaDB does not load sqlite-vec
creating a normal DB does not load sqlite-vec
creating a normal DB does not start connection health timers
metrics timer starts only when MetricsPlugin is used
LibSQL pool starts only when pooling is configured
```

### ~~Task 21: Add API compatibility tests~~ ✅

Make sure these still work:

```ts
import { skibba } from 'skibbadb';

const db = skibba('app.db');
const users = db.collection('users', schema);

await users.insert(...)
await users.where('name').eq('Bob').first()
await users.groupBy('status').count()
await users.where('tags').arrayContains('admin').all()
await users.join('teams', 'teamId', 'id').all()
await users.bulk.insert([...])
users.sync.insert(...)
```

### ~~Task 22: Add microbenchmarks~~ ✅

Benchmark before and after:

```txt
cold import time
basic DB open time
insert 1 row
insert 1,000 rows
upsert 1,000 rows
delete 1,000 rows
simple query
QueryBuilder chained query
vector disabled startup
vector enabled startup
```

Success means:

* No public API break.
* Cold startup improves or stays the same.
* Basic DB open does not load vector or pooling systems.
* Bulk operations improve.
* QueryBuilder remains fully featured.
* Collection file gets smaller or easier to maintain.
* TypeScript type quality does not regress.

## Final Target

The user-facing API should stay this simple:

```ts
import { skibba } from 'skibbadb';

const db = skibba('app.db');

const users = db.collection('users', userSchema, {
  id: 'id',
  unique: ['email'],
  index: ['createdAt']
});

await users.insert({
  name: 'Brendon',
  email: 'brendon@example.com'
});

const result = await users
  .where('email').eq('brendon@example.com')
  .first();
```

Internally, skibbaDB should become:

```txt
less duplicated
less eager
less timer-heavy
less optional-dependency-heavy
easier to maintain
same or better DX
```
