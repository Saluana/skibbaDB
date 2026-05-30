Thermo-Nuclear Code Quality Review: skibbaDB
Verdict: Not Approved. This codebase has serious structural problems that need to be addressed before merging.
1. Structural Code-Quality Regressions (P0)
collection.ts is 2395 lines — this is unacceptable
This file conflates 5+ distinct responsibilities: CRUD operations, sync/async duplication, QueryBuilder prototype monkey-patching, table initialization/migrations, and index rebuilding. The sync/async duplication alone accounts for ~500 lines of near-identical code. The QueryBuilder prototype patches (lines 2063-2395) are 333 lines that don't belong here at all.
Required decomposition:
Extract to	Lines saved	Contents
query-builder.ts	~333	All QueryBuilder.prototype.* / FieldBuilder.prototype.* monkey-patches
Delete deprecated sync methods	~500	Every *Sync method (all @deprecated)
collection-init.ts	~250	createTable, runMigrations, ensureInitialized
collection-maintenance.ts	~200	rebuildIndexes, vectorSearch
Target: Collection class should be ~500 lines, not 2395.
sql-translator.ts is 1188 lines — also over the threshold
Contains vector SQL building, WHERE/HAVING clause builders, atomic update query generation, and filter dispatch — all in one class. Should be split into sql-translator.ts (~400), sql-where-builder.ts (250), vector-sql-builder.ts (150).
driver-detector.ts is 490 lines for a 2-line problem
The entire DriverDetector class with its 5-method scoring system, confidence aggregation, diagnostics, and singleton pattern solves a problem that doesn't exist. typeof globalThis.Bun !== 'undefined' is definitive. Delete the class, replace with a function.
require() in ESM package (json-utils.ts:155)
This is a runtime crash in strict ESM environments. The package declares "type": "module" but uses require(). This must be fixed by restructuring the dependency graph.
migrator.ts:280 — schema diffs against itself
oldSchema = schema when storedVersion > 0 means generateSchemaDiff always finds zero changes for existing collections. Migrations silently do nothing.
2. Missed Opportunities for Dramatic Simplification
Code Judo #1: Delete the sync API entirely
Every sync method is @deprecated. Deleting them removes ~500 lines from collection.ts and eliminates the single biggest source of duplication. If they can't be deleted, create a strategy/adapter pattern so each operation is written once.
Code Judo #2: NodeDriver should be 3 classes, not 1 class with 3 modes
Every method in node.ts has the same 3-way branch: libsqlPool → libsql client → better-sqlite3. This is the Strategy pattern screaming to exist. Split into LibSQLPoolDriver, LibSQLClientDriver, BetterSQLite3Driver. The any-typed db field is a direct consequence of this design failure.
Code Judo #3: Operator dispatch table kills both filter switch statements
buildFilterClause and buildHavingFilterClause are ~80 lines of near-duplicate switch statements. Replace with a single OPERATOR_SQL dispatch table. One function, one table, one-line operator additions.
Code Judo #4: Collapse BaseDriver via composition
The base class is a god object: connection lifecycle, transaction locking, statement caching, SQLite PRAGMA configuration (including cgroup memory detection!), health checks, and reconnection. Extract TransactionManager, StatementCache, ConnectionHealthMonitor, SQLitePragmaConfigurator as standalone modules.
Code Judo #5: Eliminate the Proxy in database.ts
getDriverProxy() (60 lines) creates a Proxy with hardcoded method name checks and (driver as any)[prop] everywhere. Replace with a simple () => Promise<Driver> getter.
3. Spaghetti / Branching Complexity
- Transaction management in collection.ts uses 3 different patterns inconsistently: driver.transaction(), tryBeginTransaction() + manual COMMIT/ROLLBACK, and tryBeginTransactionSync() + manual execSync('COMMIT'). The tryBeginTransaction method mutates (this.driver as any).isInTransaction = true — bypassing the abstraction entirely.
- Vector error handling is repeated 5 times with the same vec0 / no such module string matching. Should be a single isVectorExtensionError() helper.
- node.ts:93-185 — initializeDatabase() is 92 lines of nested try/catch with 4 levels of indentation. Spaghetti.
- base.ts:249-291 — cgroup v1/v2 memory limit detection with nested try/catch reading Linux-specific filesystem paths. This is container infrastructure inside a SQLite PRAGMA configurator inside a database driver base class. The layering violations are staggering.
- migrator.ts matches on error.message.includes('cannot start a transaction within a transaction') in 4 separate places. Brittle string matching on SQLite error messages that vary by driver and version.
- Subquery correlation via regex (sql-translator.ts:953-963): subquerySql = originalBuild.sql.replace(/WHERE (.+?)( GROUP BY|...)/, ...) — regex surgery on generated SQL strings. This will break when any clause contains WHERE in a string literal.
4. Abstraction / Type Problems
any is pervasive across the entire codebase
Counted any occurrences by area:
- Driver layer: Map<string, any>, db?: any, currentConnection?: any, clientConfig: any, row: any[]
- SQL layer: convertValue(value: any): any, doc: any, schema?: any, params: any[]
- Collection: 25+ (as any) casts for _id, _version, collection property smuggling
- Types: Row = { [key: string]: any }, QueryFilter.value: any, AtomicUpdateOperators.$set: { [field: string]: any }
- JSON utils: mergeConstrainedFields(row: any, constrainedFields?: any, schema?: any) — all three parameters are any
The entire data layer is untyped at the boundary. The _version field is set via (result as any)._version everywhere because the schema type doesn't include it — this should be InferSchema<T> & { _version: number }.
Filter union type lacks a proper discriminant
QueryFilter | QueryGroup | SubqueryFilter is narrowed via 'type' in f, 'subquery' in f checks and as casts. TypeScript can't narrow properly. Needs a discriminant field.
Monkey-patching QueryBuilder.prototype from collection.ts
The collection property is attached via (builder as any).collection = this and accessed via this.collection['collectionSchema'] — private field access through string indexing. Brittle and type-unsafe.
Public mutable state on drivers
base.ts:16 — public isInTransaction. base.ts:35 — public savepointStack. Any external code can corrupt transaction tracking.
5. File-Size and Decomposition Concerns
File	Lines	Status
collection.ts	2395	Extreme. Must decompose.
sql-translator.ts	1188	Over threshold. Must decompose.
query-builder.ts	805	Large but manageable.
drivers/node.ts	680	Should be 3 separate driver classes.
database.ts	550	Contains dead code and Proxy magic.
drivers/base.ts	530	God object. Needs composition.
driver-detector.ts	490	Should be ~10 lines.
connection-manager.ts	432	Duplicates driver factory.
6. Modularity and Architecture Issues
- Driver creation logic duplicated in 3 places: database.ts:152-178, connection-manager.ts:310-324, node.ts:93-185. Fallback ordering and error messages will drift.
- QueryBuilder execution lives in collection.ts, not query-builder.ts. The builder defines the API but not execution. The boundary is split in the wrong direction.
- JOIN result merging duplicated 3 times in collection.ts (toArray, iterator, toArraySync). This belongs in a result-mapper module.
- Constrained-field column loop duplicated 3 times in sql-translator.ts (insert, upsert, update). ~30 lines of pure duplication.
- zodTypeToSQL duplicated in constrained-fields.ts and migrator.ts with slightly different switch cases. One will drift.
- schema-constraints.ts is entirely deprecated but still imported in 4 files with a conversion bridge in registry.ts. ~250 lines of dead weight.
- process.env.NODE_ENV === 'test' in migrator.ts:251. Production library code must never branch on test environment variables.
- database.ts:46-48 — this.connectionManager = config.connectionPool ? globalConnectionManager : globalConnectionManager; — tautological assignment. The connectionPool flag is meaningless.
- node.ts:598-619 — transaction() override calls super.transaction() in ALL branches. Dead code, delete it.
7. Orchestration Issues
- Non-atomic insert (collection.ts:489): Checks for existing _id via findById, then inserts separately. Race condition. Should use ON CONFLICT.
- upsert vs upsertSync are behaviorally different: Async uses ON CONFLICT SQL (1 query). Sync does findByIdSync then dispatches to putSync or insertSync (2-3 queries). Correctness bug waiting to happen.
- deleteBulk loops through IDs calling this.delete(_id) one at a time. A single DELETE WHERE _id IN (...) would be atomic and efficient.
- rebuildIndexes issues a separate SELECT per constrained field per document. For N docs with M fields, that's N*M+1 queries. A single SELECT _id, <all constrained columns> would suffice.
- putBulk sequentially calls findById for each document inside a transaction. Existence checks should be batched.
- Vector operations are non-atomic: The SQL layer returns arrays of queries with no atomicity guarantee. If the main insert succeeds but a vector insert fails, the database is inconsistent unless the caller wraps everything.
8. Package / Dependency Concerns
- @types/better-sqlite3 is in dependencies instead of devDependencies
- @libsql/client, better-sqlite3, sqlite-vec are all hard dependencies — should be peer/optional
- tsconfig.json has noUnusedLocals: false and noUnusedParameters: false — allows dead code to accumulate silently
- No engines field despite structuredClone requiring Node 17+
- Public API (index.ts) exports internal utilities (validateIdentifier, etc.) and uses wildcard export * from './plugins'
Priority Action Plan
#	Action
1	Fix require() in ESM (json-utils.ts:155)
2	Fix migrator.ts:280 self-diffing schema
3	Move QueryBuilder patches to query-builder.ts
4	Delete deprecated sync methods
5	Replace driver-detector.ts with a function
6	Split NodeDriver into 3 strategy classes
7	Unify filter clause builders via operator table
8	Delete schema-constraints.ts + bridge
9	Remove process.env.NODE_ENV from migrator
10	Decompose BaseDriver via composition
11	Extract vector SQL to dedicated module
12	Fix upsert/upsertSync behavioral divergence
13	Fix tautological assignment + dead transaction() override
14	Move @types/better-sqlite3 to devDeps
15	Clean public API surface
