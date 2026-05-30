import { z } from 'zod/v3';
import type { SchemaConstraints } from './schema-constraints';
import type { UpgradeMap, SeedFunction } from './upgrade-types';

export type DBPreset = 'memory' | 'local' | 'server' | 'test' | 'turso';

export interface DBConfig {
    /** Applies sensible defaults for common deployment targets */
    preset?: DBPreset;
    path?: string;
    memory?: boolean;
    driver?: 'bun' | 'node';
    // LibSQL-specific options
    authToken?: string;
    syncUrl?: string;
    libsql?: boolean;
    // SQLite optimization options
    sqlite?: {
        journalMode?: 'DELETE' | 'TRUNCATE' | 'PERSIST' | 'MEMORY' | 'WAL';
        synchronous?: 'OFF' | 'NORMAL' | 'FULL' | 'EXTRA';
        busyTimeout?: number; // milliseconds
        cacheSize?: number; // pages (negative = KB)
        tempStore?: 'DEFAULT' | 'FILE' | 'MEMORY';
        lockingMode?: 'NORMAL' | 'EXCLUSIVE';
        autoVacuum?: 'NONE' | 'FULL' | 'INCREMENTAL';
        walCheckpoint?: number; // pages before auto-checkpoint
    };
    // Connection management options
    autoReconnect?: boolean;
    maxReconnectAttempts?: number;
    reconnectDelay?: number;
    allowSyncWithPlugins?: boolean;
    sharedConnection?: boolean;
    connectionPool?: {
        maxConnections?: number;
        maxIdleTime?: number;
        healthCheckInterval?: number;
        retryAttempts?: number;
        retryDelay?: number;
    };
    // LibSQL specific pool options
    libsqlPool?: {
        maxConnections?: number;
        minConnections?: number;
        acquireTimeout?: number;
        createTimeout?: number;
        destroyTimeout?: number;
        idleTimeout?: number;
        reapInterval?: number;
        maxRetries?: number;
    };
}

export type DocBindSql = 'json(?)' | 'jsonb(?)';

export const DEFAULT_DOC_BIND_SQL: DocBindSql = 'json(?)';

/** Valid SQLite parameter types */
export type SqliteParam = string | number | boolean | null | Uint8Array | Buffer;

export interface Driver {
    // Default async methods
    exec(sql: string, params?: SqliteParam[]): Promise<void>;
    query(sql: string, params?: SqliteParam[]): Promise<Row[]>;
    // MEDIUM-2 FIX: Add cursor/iterator support for streaming large result sets
    queryIterator(sql: string, params?: SqliteParam[]): AsyncIterableIterator<Row>;
    transaction<T>(fn: () => Promise<T>): Promise<T>;
    close(): Promise<void>;

    // Sync methods (for backward compatibility)
    execSync(sql: string, params?: SqliteParam[]): void;
    querySync(sql: string, params?: SqliteParam[]): Row[];
    closeSync(): void;
    
    // Transaction state tracking (implemented by BaseDriver)
    isInTransaction?: boolean;
    savepointStack?: string[];

    /** SQL placeholder for binding document JSON on write (probed once at driver init) */
    docBindSql?: DocBindSql;
}

export interface Row {
    [key: string]: any;
}

export interface ConstrainedFieldDefinition {
    type?: 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB' | 'VECTOR';
    unique?: boolean;
    index?: boolean; // Create a non-unique index for performance
    foreignKey?: string; // 'table.column'
    onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT';
    onUpdate?: 'CASCADE' | 'SET NULL' | 'RESTRICT';
    nullable?: boolean;
    checkConstraint?: string;
    // Vector-specific properties
    vectorDimensions?: number; // Required when type is 'VECTOR'
    vectorType?: 'float' | 'int8' | 'binary'; // Default: 'float'
}

export interface CollectionSchema<T extends z.ZodTypeAny = z.ZodTypeAny> {
    name: string;
    schema: z.ZodSchema<T>;
    primaryKey: string;
    /** Public ID field exposed on documents (default `id`, maps to `_id` in storage) */
    publicIdField?: string;
    version?: number;
    indexes?: string[];
    /** @deprecated Use constrainedFields instead. Will be removed in v2.0.0 */
    constraints?: SchemaConstraints;
    constrainedFields?: { [fieldPath: string]: ConstrainedFieldDefinition };
    upgrade?: UpgradeMap<T>;
    seed?: SeedFunction<T>;
}

export type InferSchema<T> = T extends z.ZodSchema<infer U> ? U : never;

export interface QueryFilter {
    field: string;
    operator:
        | 'eq'
        | 'neq'
        | 'gt'
        | 'gte'
        | 'lt'
        | 'lte'
        | 'in'
        | 'nin'
        | 'like'
        | 'ilike'
        | 'startswith'
        | 'endswith'
        | 'contains'
        | 'exists'
        | 'between'
        | 'json_array_contains'
        | 'json_array_not_contains'
        | 'vector_match'; // For vector similarity searches
    value: any;
    value2?: any; // For between operator
    vectorDistance?: 'cosine' | 'euclidean' | 'l1' | 'l2'; // For vector searches, default: cosine
}

export interface QueryGroup {
    type: 'and' | 'or';
    filters: (QueryFilter | QueryGroup | SubqueryFilter)[];
}

// Aggregate function definitions
export interface AggregateField {
    function: 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX';
    field: string;
    alias?: string;
    distinct?: boolean;
}

// Join definitions
export interface JoinCondition {
    left: string; // field from current collection
    right: string; // field from joined collection
    operator?: '=' | '!=' | '>' | '<' | '>=' | '<=';
}

export interface JoinClause {
    type: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL';
    collection: string;
    condition: JoinCondition;
}

// Subquery support
export interface SubqueryFilter {
    field: string;
    operator: 'exists' | 'not_exists' | 'in' | 'not_in';
    subquery: QueryOptions;
    subqueryCollection: string;
    /** Override the auto-generated foreign key field name for correlation (e.g., 'userId' instead of guessing from table name) */
    foreignKeyField?: string;
}

export interface QueryOptions {
    filters: (QueryFilter | QueryGroup | SubqueryFilter)[];
    orderBy?: { field: string; direction: 'asc' | 'desc' }[];
    limit?: number;
    offset?: number;
    groupBy?: string[];
    having?: (QueryFilter | QueryGroup)[];
    distinct?: boolean;
    aggregates?: AggregateField[];
    joins?: JoinClause[];
    selectFields?: string[]; // For custom field selection (projections)
}

// Atomic update operators
export interface AtomicUpdateOperators {
    $inc?: { [field: string]: number }; // Increment numeric field
    $set?: { [field: string]: any }; // Set field value
    $push?: { [field: string]: any }; // Append to array field
}

export interface UpdateOptions {
    expectedVersion?: number; // For optimistic concurrency control
}

// Plugin system types
export interface PluginClass {
    new (options?: any): Plugin;
}

export interface PluginFactory {
    (options?: any): Plugin;
}

// Vector search specific types
export interface VectorSearchOptions {
    field: string; // The vector field to search
    vector: number[]; // Query vector
    limit?: number; // Number of results to return (default: 10)
    where?: QueryFilter[]; // Additional filters to apply
    distance?: 'cosine' | 'euclidean' | 'l1' | 'l2'; // Distance function (default: cosine)
}

export interface VectorSearchResult<T = any> {
    document: T;
    distance: number;
    _id: string;
}

// Re-export Plugin from plugin-system for convenience
export type { Plugin } from './plugin-system';
