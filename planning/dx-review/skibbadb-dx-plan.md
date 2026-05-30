# skibbaDB Developer Experience Cleanup Plan

## Purpose

This plan turns skibbaDB into a smaller, clearer TypeScript document database API without throwing away the current implementation. The goal is not to add more features. The goal is to make the first 30 minutes feel obvious, make autocomplete less noisy, and make the public API match the mental model developers already have.

Target mental model:

```ts
import { z } from "zod"
import { skibba } from "skibbadb"

const db = skibba("app.db")

const users = db.collection("users", z.object({
  id: z.string().uuid().optional(),
  email: z.string().email(),
  name: z.string(),
  age: z.number().optional(),
}), {
  unique: ["email"],
  index: ["age"],
})

const ada = await users.insert({
  email: "ada@example.com",
  name: "Ada",
  age: 36,
})

const adults = await users
  .where("age").gte(18)
  .orderBy("name")
  .all()

await users.update(ada.id, { age: 37 })
await db.close()
```

## Current Findings

The Copilot review is mostly correct, but the uploaded codebase shows a few extra implementation details that should shape the run.

### 1. Some DX helper code already exists but is not wired in

The repository already contains `src/collection-options.ts` with `FriendlyCollectionOptions`, `unique`, `index`, `references`, `advanced`, and `publicIdField` normalization. It also contains `src/document-id.ts` with helpers for mapping public `id` to internal `_id`.

The problem is that `Database.collection()` and `Registry.register()` still accept the older options shape directly. `src/index.ts` also does not export `CollectionOptions`, `normalizeCollectionOptions`, or a `skibba()` creator.

Implementation direction: finish and wire the existing files instead of creating a second option system.

### 2. The Zod import strategy is a hidden P0 DX issue

The source imports `zod/v3` throughout the library, while `package.json` depends on `zod` version 4. If docs tell users to import from `zod`, but public types expect `zod/v3`, TypeScript can become confusing or incompatible.

Implementation direction: choose one of these paths before editing docs.

Recommended path:

- Move the library to `import { z } from "zod"` unless there is a specific blocker.
- Keep tests for Zod v4 schemas.
- If v3 compatibility is required, document `import { z } from "zod/v3"` clearly and do not show `import { z } from "zod"` in the quickstart.

### 3. The public creator is not brandable yet

The public export is currently `createDB`. That works, but the API will be easier to remember if the docs teach `skibba()` and keep `createDB()` as an alias.

Recommended public creation API:

```ts
skibba()
skibba(":memory:")
skibba("app.db")
skibba({ path: "app.db" })
```

### 4. The public ID model is still `_id` first

`insert()`, `findById()`, `put()`, `upsert()`, and bulk operations are still built around `_id`. The uploaded source already has `document-id.ts`, so this run should standardize public use around `id` while mapping to `_id` internally.

Recommended transition:

- Default public ID field: `id`
- Internal storage field: `_id`
- Keep `_id` as a compatibility field for now
- Teach only `id` in docs
- Allow legacy opt-in with `{ id: "_id" }`

### 5. Collection autocomplete is doing too much

The collection currently exposes simple CRUD, sync methods, bulk methods, direct query shortcuts, atomic update, vector search, and index repair as top-level methods. This is capable, but mentally noisy.

Recommended target surface:

```ts
users.insert(doc)
users.get(id)
users.update(id, patch)
users.upsert(id, doc)
users.delete(id)
users.all()
users.first()
users.count()
users.where(field)
users.query()
```

Advanced features should be grouped:

```ts
users.bulk.insert(docs)
users.bulk.update(updates)
users.bulk.upsert(updates)
users.bulk.delete(ids)

users.sync.insert(doc)
users.sync.get(id)
users.sync.all()

users.atomic.update(id, operators)
users.indexes.rebuild()
users.vector.search(options)
```

Keep the existing methods as compatibility aliases during this run.

### 6. Query count is ambiguous

`Collection.count()` executes a count. `QueryBuilder.executeCount()` executes a filtered count. But `QueryBuilder.count(field, alias, distinct)` currently builds an aggregate query instead of executing a count.

That means this natural call is not what a user will expect:

```ts
await users.where("active").eq(true).count()
```

Implementation direction:

- Preferred breaking cleanup for v0.2: make `query.count()` execute and move aggregate count under `query.aggregate.count()` or `query.aggregate("COUNT", ...)`.
- Safer compatibility path: keep aggregate `count()` for now, add `query.resultCount()` as the clean execution alias, document that `count()` will change in v0.3.

Because the package is still early, the recommended path is to make the DX-breaking cleanup now and document it in a migration note.

### 7. Upsert plugin hooks should reflect actual behavior

`upsert()` checks whether the document exists but currently calls both insert and update hooks regardless. That can cause duplicate side effects in plugins such as audit logging, metrics, timestamps, or future sync hooks.

Implementation direction:

- If the record exists, fire update hooks.
- If the record does not exist, fire insert hooks.
- Add tests for plugin hook order.

### 8. Error messages need actionable fixes

The error classes exist, but user-facing messages are still too generic in common cases, especially validation errors, collection already exists, collection not found, duplicate unique field, invalid foreign key, and missing vector extension.

Implementation direction:

- Preserve existing error classes.
- Add `code`, `collection`, `field`, and `hint` where possible.
- Improve messages without changing catch behavior.

### 9. Diagnostics would make support much easier

The code already has driver health checks under the driver layer, but there is no friendly public `db.health()` or query-level `explain()`.

Implementation direction:

```ts
await db.health()
await users.where("email").eq("ada@example.com").explain()
await users.indexes.check()
```

These should return plain objects, not formatted strings.

## Implementation Strategy

### Phase 0: Baseline and compatibility safety

Before changing the API, add tests for the current behavior that must remain compatible.

Required baseline checks:

- `createDB()` still works.
- `collection.insert()` still works.
- `findById()`, `put()`, `toArray()`, `insertBulk()`, `putBulk()`, `deleteBulk()` still work.
- Sync methods still work when plugins are not registered and shared connections are not used.
- Plugin behavior is covered for insert, update, delete, query, and upsert.
- Existing constrained fields still work.

### Phase 1: Public creator and exports

Add:

```ts
export function skibba(input?: string | DBConfig, options?: DBConfig): Database
```

Behavior:

- No argument means memory DB or current default behavior.
- `":memory:"` maps to `{ memory: true }` or `{ path: ":memory:" }`, based on current driver expectations.
- A string maps to `{ path: input }`.
- Object input passes through to `createDB()`.

Keep:

```ts
export function createDB(config?: DBConfig): Database
```

Also export:

```ts
CollectionOptions
FriendlyCollectionOptions
normalizeCollectionOptions
```

### Phase 2: Wire friendly collection options

Use `normalizeCollectionOptions()` in `Database.collection()` before calling `Registry.register()`.

Extend the internal schema with:

```ts
publicIdField: string
```

Then use this value in `Collection` when reading and writing documents.

Important rule:

- Friendly options are the public API.
- `constrainedFields` remains supported, but moves under `advanced` in docs.
- Existing `constrainedFields` at the top level remains as a deprecated compatibility path.

### Phase 3: Public ID cleanup

Use the existing helpers in `src/document-id.ts`.

Required behavior:

```ts
const user = await users.insert({ name: "Ada" })
user.id // works
user._id // still present for compatibility during this version

await users.get(user.id)
await users.update(user.id, { name: "Ada Lovelace" })
await users.delete(user.id)
```

Input rules:

- If a document has `id`, map it to `_id` before storage.
- If a document has `_id`, keep supporting it.
- If both exist and differ, throw a clear validation error.
- If neither exists, generate an ID.

### Phase 4: Add clean aliases before reorganizing advanced APIs

Add aliases first:

```ts
get -> findById
update -> put
all -> toArray
remove -> delete
```

Recommended docs should teach:

```ts
get
update
all
delete
```

`remove` can exist for users who dislike `delete`, but docs should not need both.

### Phase 5: Add advanced namespaces

Add namespace getters on `Collection`:

```ts
get bulk() { ... }
get sync() { ... }
get atomic() { ... }
get indexes() { ... }
get vector() { ... }
```

These should call existing methods internally. Do not duplicate logic.

Example:

```ts
get bulk() {
  return {
    insert: this.insertBulk.bind(this),
    update: this.putBulk.bind(this),
    upsert: this.upsertBulk.bind(this),
    delete: this.deleteBulk.bind(this),
  }
}
```

Keep old methods for compatibility, but mark them deprecated in JSDoc.

### Phase 6: Query execution cleanup

Add `all()` as an alias for query `toArray()`.

Then resolve count in one of two ways.

Recommended early-version path:

```ts
await users.where("active").eq(true).count()
```

This should execute the count.

Aggregate usage becomes:

```ts
await users.query().aggregate("COUNT", "*").groupBy("departmentId").all()
```

or:

```ts
await users.query().aggregateCount("*", "total").all()
```

### Phase 7: Diagnostics

Add:

```ts
await db.health()
await query.explain()
await users.indexes.check()
```

Minimum `db.health()` output:

```ts
{
  ok: true,
  driver: "node",
  path: "app.db",
  collections: ["users"],
  plugins: ["timestamp"],
  sqlite: {
    journalMode: "wal",
    foreignKeys: true
  }
}
```

Minimum `query.explain()` output:

```ts
{
  collection: "users",
  sql: "SELECT ...",
  params: ["ada@example.com"],
  filters: 1,
  usesConstrainedField: true
}
```

Do not expose internal secrets, auth tokens, or full remote URLs.

### Phase 8: Documentation cleanup

Rewrite docs around the golden path first.

Recommended README order:

1. What it is
2. Install
3. 30-second example
4. CRUD
5. Queries
6. Indexes and constraints
7. Advanced APIs
8. Sync API
9. Plugins
10. Diagnostics
11. Migration notes

Docs should teach only the new names:

- `skibba()` not `createDB()`
- `get()` not `findById()`
- `update()` not `put()`
- `all()` not `toArray()`
- `bulk.*` not `insertBulk()`
- `indexes.rebuild()` not `rebuildIndexes()`
- `vector.search()` not `vectorSearch()`

Old names belong in a compatibility table, not the quickstart.

## Non-goals for this run

Do not rewrite the storage engine.
Do not remove existing public methods yet.
Do not replace the query builder.
Do not redesign migrations.
Do not build a new ORM layer.
Do not make users learn SQL before their first insert.

## Acceptance Criteria

The run is complete when all of this is true:

- A new user can copy the quickstart and it works with `await` everywhere.
- Public docs use `id`, not `_id`.
- `skibba("app.db")` works.
- Friendly collection options work: `unique`, `index`, and `references`.
- Existing constrained fields still work.
- Clean aliases work: `get`, `update`, `all`.
- Advanced namespaces exist: `bulk`, `sync`, `atomic`, `indexes`, `vector`.
- Old API names still pass compatibility tests.
- Query count semantics are either fixed now or clearly staged with tests and migration notes.
- Upsert plugin hooks only fire the correct insert or update path.
- README teaches the small API first.
- The package exports all types needed for the public API.
