# Agent Instructions for skibbaDB

## File Map

| Area | File(s) |
|------|---------|
| Public exports | `src/index.ts` |
| Database creation | `src/database.ts`, `src/skibba.ts` |
| Collection CRUD + query shortcuts | `src/collection.ts` |
| Shared collection helpers | `src/collection-ops.ts` |
| Namespaced APIs (bulk, sync, atomic, indexes, vector) | `src/collection-namespaces.ts` |
| Query builder (chaining, execution) | `src/query-builder.ts` |
| SQL generation | `src/sql-translator.ts` |
| Schema → constrained fields | `src/constrained-fields.ts` |
| Friendly collection options | `src/collection-options.ts` |
| Document ID mapping (id ↔ _id) | `src/document-id.ts` |
| Error classes | `src/errors.ts` |
| Plugin system | `src/plugin-system.ts` |
| Built-in plugins | `src/plugins/*.ts` |
| Migrations | `src/migrator.ts` |
| Driver detection | `src/driver-detector.ts` |
| Node.js driver | `src/drivers/node.ts`, `src/drivers/base.ts` |
| Driver strategies | `src/drivers/driver-strategies.ts` |
| Lazy vector loader | `src/vector-loader.ts` |
| Connection manager (lazy singleton) | `src/connection-manager.ts` |
| Diagnostics | `src/diagnostics.ts` |
| Vector SQL helpers | `src/vector-sql.ts` |
| Public types | `src/types.ts` |

## Test Commands

```bash
bun test                # Primary test runner
npm run test:node       # Node.js-specific tests (if available)
npm run build           # Build + type check
```

## Public API Rules

- The golden API: `insert`, `get`, `update`, `upsert`, `remove`, `all`, `count`, `first`, `where`, `query`
- Grouped APIs: `bulk.*`, `sync.*`, `atomic.*`, `indexes.*`, `vector.*`
- `db.sync.*` for synchronous database operations
- Old method names (`findById`, `put`, `toArray`, `insertBulk`, etc.) are compatibility aliases — do not remove them
- Do not add new top-level collection methods unless they belong in the golden API
- Always `await` async methods in examples

## Naming Rules

- Public document ID is `id` (maps to internal `_id`)
- Import Zod as `import { z } from 'zod/v3'`
- Entry point is `skibba()` — `createDB()` is the compatibility alias
- Collection options use friendly names: `unique`, `index`, `references`, `advanced`

## Deprecation Rules

- Add alias first, update docs second, deprecate later
- Keep old names working for at least one release cycle
- Mark deprecated methods with `@deprecated` JSDoc

## Safe Edit Zones

- `src/collection.ts` — CRUD methods, plugin hook calls
- `src/query-builder.ts` — query chaining, execution methods
- `src/sql-translator.ts` — SQL generation (no side effects)
- `src/collection-options.ts` — option normalization
- `src/errors.ts` — error classes and messages

## Do Not Expose in Beginner APIs

- `_id` (internal storage field)
- `constrainedFields` (use `advanced.constrainedFields` or friendly options)
- `docBindSql` (internal SQL binding)
- `savepointStack`, `isInTransaction` (internal transaction state)
- Driver internals (`BaseDriver`, `StatementCache`, etc.)

## Architecture Notes

- Documents are stored as JSON in a `doc` column
- Constrained fields get dedicated SQLite columns for indexes and constraints
- The `_id` column is the primary key; `id` is the public-facing alias
- Zod v3 compatibility layer is required for `_def` internal API access
- Plugin hooks: `onBeforeInsert`, `onAfterInsert`, `onBeforeUpdate`, `onAfterUpdate`, `onBeforeDelete`, `onAfterDelete`, `onError`
- Upsert fires insert hooks OR update hooks (not both)
