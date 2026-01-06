export { createDB, Database } from './database';
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
    SeedFunction 
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
} from './errors';
export type {
    DBConfig,
    Driver,
    CollectionSchema,
    InferSchema,
    QueryFilter,
    QueryOptions,
    ConstrainedFieldDefinition,
    AtomicUpdateOperators,
    UpdateOptions,
} from './types';

// Security utilities for SQL identifier validation
export { 
    validateIdentifier, 
    validateFieldPath, 
    validateCollectionName,
    validateDatabasePath,
    sanitizeForErrorMessage
} from './sql-utils';

// Plugin system exports
export { PluginManager } from './plugin-system';
export type { Plugin, PluginContext } from './plugin-system';
export * from './plugins';

// Note: All methods are async by default. Sync versions available with 'Sync' suffix:
// Database: exec(), query(), queryIterator(), close() (async) | execSync(), querySync(), closeSync() (sync)
// Collection: insert(), put(), delete(), findById(), toArray(), iterator(), count(), first() (async)
//           insertSync(), findByIdSync(), toArraySync(), countSync(), firstSync() (sync)
// QueryBuilder: toArray(), iterator(), first(), count() (async) | toArraySync(), firstSync(), countSync() (sync)
// For large result sets, use iterator() to stream results and avoid loading everything into memory
