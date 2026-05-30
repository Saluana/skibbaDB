export { createDB, Database, skibba, applyDBPreset } from './database';
export { Collection } from './collection';
export { QueryBuilder, FieldBuilder } from './query-builder';
export { Migrator } from './migrator';
export { UpgradeRunner } from './upgrade-runner';
export type { MigrationInfo, SchemaDiff, MigrationContext } from './migrator';
export type {
    UpgradeContext,
    UpgradeFunction,
    ConditionalUpgrade,
    UpgradeDefinition,
    UpgradeMap,
    SeedFunction,
} from './upgrade-types';
export {
    ValidationError,
    UniqueConstraintError,
    CheckConstraintError,
    NotFoundError,
    DatabaseError,
    PluginError,
    PluginTimeoutError,
    VersionMismatchError,
    CollectionExistsError,
    CollectionNotFoundError,
} from './errors';
export type {
    DBConfig,
    DBPreset,
    Driver,
    CollectionSchema,
    InferSchema,
    QueryFilter,
    QueryOptions,
    ConstrainedFieldDefinition,
    AtomicUpdateOperators,
    UpdateOptions,
} from './types';
export type {
    CollectionOptions,
    FriendlyCollectionOptions,
} from './collection-options';
export { normalizeCollectionOptions } from './collection-options';
export type { ExplainResult, HealthResult } from './diagnostics';

// Plugin system exports
export { PluginManager } from './plugin-system';
export type { Plugin, PluginContext } from './plugin-system';

// Built-in plugins
export { AuditLogPlugin } from './plugins/audit-log';
export { ValidationPlugin, validators } from './plugins/validation';
export { CachePlugin } from './plugins/cache';
export { TimestampPlugin } from './plugins/timestamp';
export { MetricsPlugin } from './plugins/metrics';

/**
 * Golden path (async):
 * - `skibba()` / `createDB()` → `db.collection()` → `insert`, `get`, `update`, `where().all()`
 *
 * Grouped APIs:
 * - `collection.bulk.*` — batch writes
 * - `collection.sync.*` — synchronous operations
 * - `collection.atomic.*` — `$inc` / `$set` / `$push`
 * - `collection.indexes.*` — index maintenance
 * - `collection.vector.*` — similarity search
 * - `db.sync.*` — synchronous exec/query/close
 *
 * Legacy names (`put`, `findById`, `toArray`, `*Sync` on collection) remain available.
 */
