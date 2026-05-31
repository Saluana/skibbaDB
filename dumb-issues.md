# Dumb Issues — Resolved

All items from the original audit have been addressed in code, tests, or docs. This file is kept as a checklist; see git history for the original write-up.

| Issue | Resolution |
|-------|------------|
| Published entrypoint `dist/index.js` missing | Vite `preserveModulesRoot: 'src'` emits `dist/index.js`; package.json paths unchanged |
| Node-hostile bundle (`bun:sqlite` static import) | Bun driver externalized; `createRequire` / dynamic `import()` in `database.ts` |
| Raw query field SQL injection | `validateFieldPath` on all `qualifyFieldAccess` paths; safe `quoteIdentifier` aliases |
| Foreign key DDL injection | `validateForeignKeyReference` for `references` and `foreignKey` config |
| Atomic `$set` parameter order | JSON params before column params in `buildAtomicUpdateQuery` |
| Atomic updates bypass Zod | `validateAtomicOperators` + post-update `validateDocument` |
| `update()` drops public `id` | `mapUpdateResult` calls `attachPublicId` |
| `first()` raw JSON / missing `id` | Uses `presentDocument` (async + sync) |
| System metadata in `doc` JSON | `omitStorageMetadata` in `stringifyDoc` on update |
| Bulk insert ignores public `id` | `normalizeIncomingDoc` in `prepareBulkInsertDocs` |
| `deleteSync()` true for missing rows | Checks existence first; returns `false` |
| Shared connection proxy throws | Safe defaults for `isInTransaction` / `isTransactionActive` |
| Validation plugin swallowed | Before-hooks use `executeHook` |
| `onDatabaseInit` before `use()` | Deferred until `ensureDriver` / `use()` via `ensureDatabaseInit` |
| Audit log `[undefined]` | `defaultLogger.bind(this)` |
| Cache/Metrics timer leak | `timer.unref()` + listener cleanup in `destroy()` |
| `QueryBuilder.clone()` shallow | Deep-copies mutable option arrays |
| `limit(0)` returns all rows | `options.limit !== undefined` in SQL builder |
| Column name collisions warning only | `validateConstrainedColumnNames` throws at schema build |
| Reserved SQL keywords on columns | `validateColumnName` |
| Node transaction mutex unused | `exec` / `_query` routed through `withConnectionMutex` |
| Legacy docs vs golden API | Banners + updated examples in `docs/src/vector_search.md` and `collection.md` |

Regression coverage: `test/di-issues-fixes.test.ts`, `test/migrations.test.ts`, `test/integration.test.ts`.
