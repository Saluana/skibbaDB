# skibbaDB DX Cleanup Task List

## Working Rules for the Intern

- Do not remove existing public methods in this run.
- Add aliases first, update docs second, deprecate later.
- Do not add more top-level collection methods unless they are part of the golden API.
- Do not create a second friendly-options system. Use `src/collection-options.ts`.
- Do not create a second ID mapping system. Use `src/document-id.ts`.
- Keep tests close to the public behavior developers will copy from the README.
- Every API change must include at least one test and one docs update.

## P0 Tasks

### DX-00: Create a baseline safety branch

Priority: P0

Files:

- No source files required

Steps:

1. Create a branch such as `dx-api-cleanup`.
2. Run the current test suite.
3. Record failing tests before making changes.
4. Add a short note to the PR with current known failures, if any.

Acceptance criteria:

- The intern knows whether failures are new or pre-existing.
- No API work starts before baseline status is known.

### DX-01: Decide and fix the Zod import strategy

Priority: P0

Files:

- `src/database.ts`
- `src/collection.ts`
- `src/types.ts`
- `src/registry.ts`
- `src/constrained-fields.ts`
- `src/plugin-system.ts`
- `src/migrator.ts`
- `src/upgrade-runner.ts`
- `src/upgrade-types.ts`
- `src/collection-options.ts`
- `package.json`
- tests

Problem:

The source imports `zod/v3`, but the package depends on Zod v4. This can hurt copy-paste DX if docs show `import { z } from "zod"`.

Recommended implementation:

1. Switch source imports to `zod` if tests pass cleanly.
2. Add a test that uses `import { z } from "zod"` exactly like the README.
3. If switching to `zod` is not safe, keep `zod/v3` but make docs show `zod/v3` consistently.

Acceptance criteria:

- Quickstart schema import matches the actual library type expectations.
- TypeScript users do not need to guess whether to import from `zod` or `zod/v3`.

### DX-02: Add `skibba()` as the main creator

Priority: P0

Files:

- `src/database.ts`
- `src/index.ts`
- tests

Implementation:

Add:

```ts
export function skibba(input?: string | DBConfig, options: DBConfig = {}): Database {
  if (typeof input === "string") {
    if (input === ":memory:") return createDB({ ...options, memory: true, path: ":memory:" })
    return createDB({ ...options, path: input })
  }

  return createDB(input ?? options)
}
```

Adjust as needed to match existing driver behavior.

Acceptance criteria:

- `skibba()` works.
- `skibba(":memory:")` works.
- `skibba("app.db")` works.
- `createDB()` still works.
- `src/index.ts` exports both `skibba` and `createDB`.

### DX-03: Export public collection option types

Priority: P0

Files:

- `src/index.ts`
- `src/collection-options.ts`

Implementation:

Export:

```ts
export type {
  CollectionOptions,
  FriendlyCollectionOptions,
  NormalizedCollectionOptions,
} from "./collection-options"

export { normalizeCollectionOptions } from "./collection-options"
```

Acceptance criteria:

- Consumers can import `CollectionOptions` from `skibbadb`.
- No internal-only types leak unless they are intentionally public.

## P1 Tasks

### DX-04: Wire friendly collection options into `Database.collection()`

Priority: P1

Files:

- `src/database.ts`
- `src/registry.ts`
- `src/types.ts`
- `src/collection-options.ts`
- tests

Implementation:

1. Change the third argument of `Database.collection()` to use `CollectionOptions<T>`.
2. Call `normalizeCollectionOptions(options)` before registering the collection.
3. Pass normalized options into `Registry.register()`.
4. Add `publicIdField` to `CollectionSchema`.
5. Store `publicIdField` in the registry result.

Acceptance criteria:

- This works:

```ts
const users = db.collection("users", schema, {
  unique: ["email"],
  index: ["age"],
  references: {
    departmentId: "departments.id",
  },
})
```

- Existing `constrainedFields` still works.
- Existing `constraints` still works if it worked before.
- TypeScript autocomplete shows friendly options.

### DX-05: Standardize public IDs around `id`

Priority: P1

Files:

- `src/types.ts`
- `src/collection.ts`
- `src/document-id.ts`
- tests

Implementation:

1. Use `normalizeIncomingDoc()` before validation and storage.
2. Use `attachPublicId()` before returning documents from insert, get, update, upsert, query, and bulk operations.
3. Keep `_id` in returned docs for compatibility during this version.
4. Throw a `ValidationError` if both `id` and `_id` exist and do not match.
5. Support `{ id: "_id" }` for legacy public API behavior.

Acceptance criteria:

- `await users.insert({ id: "u1", name: "Ada" })` stores the document under internal `_id = "u1"`.
- `await users.get("u1")` returns a document with `id = "u1"`.
- Generated IDs are returned as `id`.
- Old `_id` inputs still work.
- Bulk insert, bulk update, and upsert are covered.

### DX-06: Add golden-path method aliases

Priority: P1

Files:

- `src/collection.ts`
- `src/query-builder.ts`
- tests

Implementation:

Add collection aliases:

```ts
get(id) -> findById(id)
update(id, patch) -> put(id, patch)
all() -> toArray()
remove(id) -> delete(id)
```

Add query aliases:

```ts
all() -> toArray()
run() -> exec()
```

Acceptance criteria:

- New names work.
- Old names still work.
- README and examples use new names only.

### DX-07: Add advanced namespaces on `Collection`

Priority: P1

Files:

- `src/collection.ts`
- tests

Implementation:

Add getters that call existing methods:

```ts
users.bulk.insert([...])
users.bulk.update([...])
users.bulk.upsert([...])
users.bulk.delete([...])

users.sync.insert(doc)
users.sync.get(id)
users.sync.all()
users.sync.count()
users.sync.first()

users.atomic.update(id, operators, options)
users.indexes.rebuild()
users.vector.search(options)
```

Do not duplicate logic. Bind to existing methods.

Acceptance criteria:

- Namespaced methods pass the same tests as old top-level methods.
- Existing top-level methods remain available.
- Deprecated JSDoc is added to old advanced top-level methods.

### DX-08: Fix query count semantics

Priority: P1

Files:

- `src/query-builder.ts`
- `src/collection.ts`
- `src/sql-translator.ts`, only if needed
- tests
- README

Recommended implementation for early package stage:

1. Make `QueryBuilder.count()` execute a count when called with no arguments.
2. Move aggregate count to `aggregate("COUNT", field, alias, distinct)` and, optionally, `aggregateCount(field, alias, distinct)`.
3. Add `all()` as the recommended query execution method.

Compatibility fallback:

If breaking `count()` is too risky, add `resultCount()` now, document it, and create a migration note that `count()` will execute in the next breaking release.

Acceptance criteria:

- This works or is intentionally staged:

```ts
await users.where("active").eq(true).count()
```

- Aggregate count still has a documented path.
- Tests cover filtered count, unfiltered count, grouped aggregate count, and old behavior if compatibility is kept.

### DX-09: Fix upsert plugin hook behavior

Priority: P1

Files:

- `src/collection.ts`
- plugin tests

Problem:

`upsert()` currently detects `existing` but fires both insert and update hooks either way.

Implementation:

1. If the document exists, run update hooks only.
2. If it does not exist, run insert hooks only.
3. For `upsertBulk()`, avoid double-calling hooks through nested `upsert()` unless the current behavior is explicitly intended and tested.

Acceptance criteria:

- Insert path fires insert hooks once.
- Update path fires update hooks once.
- Audit and metrics plugins do not double-count upserts.

## P2 Tasks

### DX-10: Add `db.health()`

Priority: P2

Files:

- `src/database.ts`
- driver files if needed
- tests

Implementation:

Return a plain object:

```ts
{
  ok: boolean,
  driver: string,
  collections: string[],
  plugins: string[],
  sqlite?: {
    journalMode?: string,
    foreignKeys?: boolean,
  },
  warnings: string[],
}
```

Rules:

- Do not expose auth tokens.
- Do not expose full remote URLs if they contain credentials.
- Include actionable warnings.

Acceptance criteria:

- `await db.health()` works on local SQLite.
- It fails gracefully when the driver cannot connect.
- It includes collection and plugin names.

### DX-11: Add `query.explain()`

Priority: P2

Files:

- `src/query-builder.ts`
- `src/sql-translator.ts`, only if needed
- tests

Implementation:

Return the SQL plan object without executing the query by default:

```ts
{
  collection: "users",
  sql: "SELECT ...",
  params: [],
  filters: 1,
  orderBy: 1,
  limit: 10,
  usesConstrainedFields: true,
}
```

Optional:

- Add `{ analyze: true }` later to run SQLite `EXPLAIN QUERY PLAN`.

Acceptance criteria:

- `users.where("email").eq("a@b.com").explain()` returns SQL and params.
- Params are not string-concatenated into SQL.
- Snapshot tests cover simple and filtered queries.

### DX-12: Improve common error messages

Priority: P2

Files:

- `src/errors.ts`
- `src/collection.ts`
- `src/database.ts`
- `src/registry.ts`
- tests

Implementation:

Improve messages for:

- Validation failed
- Duplicate unique field
- Invalid foreign key
- Collection already exists
- Collection not found
- Invalid field path
- Missing vector extension
- Sync method used with plugins
- Sync method used with shared connection

Preferred shape:

```ts
throw new ValidationError(
  'Validation failed for collection "users".',
  {
    collection: 'users',
    field: 'email',
    hint: 'Check the Zod schema and the value passed to users.insert().',
    cause: error,
  }
)
```

Acceptance criteria:

- Errors still use existing error classes.
- Messages include what failed and how to fix it.
- Tests assert error class and important message fragments.

### DX-13: Add index namespace checks

Priority: P2

Files:

- `src/collection.ts`
- tests

Implementation:

Add:

```ts
users.indexes.rebuild()
users.indexes.check()
```

`check()` can start simple:

- Compare constrained fields to table columns.
- Return missing columns or index mismatches.
- Do not auto-repair unless `rebuild()` is called.

Acceptance criteria:

- `indexes.rebuild()` wraps existing `rebuildIndexes()`.
- `indexes.check()` returns a plain object with `ok`, `missing`, and `warnings`.

## P3 Documentation Tasks

### DX-14: Rewrite README quickstart

Priority: P3

Files:

- `README.md`

Required changes:

1. Use `await` in every async example.
2. Teach `skibba()` first.
3. Teach `id`, not `_id`.
4. Teach `get`, `update`, `all`, and `delete`.
5. Move sync API out of the first page.
6. Move storage internals below the first working example.
7. Add a compatibility table for old names.

Acceptance criteria:

- A new user can copy the first example into a TypeScript file and run it.
- No first-page example uses `constrainedFields`, `_id`, `put`, `findById`, or `toArray`.

### DX-15: Add migration notes

Priority: P3

Files:

- `README.md` or `docs/migration.md`

Include:

| Old | New |
| --- | --- |
| `createDB()` | `skibba()` or keep `createDB()` |
| `findById(id)` | `get(id)` |
| `put(id, patch)` | `update(id, patch)` |
| `toArray()` | `all()` |
| `insertBulk(docs)` | `bulk.insert(docs)` |
| `putBulk(updates)` | `bulk.update(updates)` |
| `deleteBulk(ids)` | `bulk.delete(ids)` |
| `atomicUpdate(id, ops)` | `atomic.update(id, ops)` |
| `rebuildIndexes()` | `indexes.rebuild()` |
| `vectorSearch(options)` | `vector.search(options)` |

Acceptance criteria:

- Users can migrate without reading source.
- Old methods are described as compatibility aliases, not the preferred API.

### DX-16: Add agent instructions

Priority: P3

Files:

- `AGENTS.md` or `docs/agents.md`

Include:

- File map
- Test commands
- Public API rules
- Naming rules
- Deprecation rules
- Safe edit zones
- Things not to expose in beginner APIs

Acceptance criteria:

- Future coding agents know where collection behavior, query behavior, SQL generation, and exports live.
- Future agents are told not to add random top-level collection methods.

## Final Verification Checklist

Run these before calling the task done:

- `bun test`
- `npm run test:node`, if supported locally
- `npm run build`
- A new quickstart smoke test using the README code
- A compatibility smoke test using old method names
- A TypeScript compile check for public imports

Manual API smoke test:

```ts
import { z } from "zod"
import { skibba } from "skibbadb"

const db = skibba(":memory:")
const users = db.collection("users", z.object({
  id: z.string().optional(),
  email: z.string().email(),
  name: z.string(),
}), {
  unique: ["email"],
})

const user = await users.insert({ email: "ada@example.com", name: "Ada" })
await users.get(user.id)
await users.update(user.id, { name: "Ada Lovelace" })
await users.where("email").eq("ada@example.com").first()
await users.all()
await users.bulk.insert([{ email: "grace@example.com", name: "Grace" }])
await db.health()
await db.close()
```
