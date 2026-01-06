import { z } from 'zod';
import type { SchemaConstraints } from './schema-constraints';
import type { UpgradeMap, SeedFunction } from './upgrade-types';

export interface DBConfig {
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

export interface Driver {
    // Default async methods
    exec(sql: string, params?: any[]): Promise<void>;
    query(sql: string, params?: any[]): Promise<Row[]>;
    // MEDIUM-2 FIX: Add cursor/iterator support for streaming large result sets
    queryIterator(sql: string, params?: any[]): AsyncIterableIterator<Row>;
    transaction<T>(fn: () => Promise<T>): Promise<T>;
    close(): Promise<void>;

    // Sync methods (for backward compatibility)
    execSync(sql: string, params?: any[]): void;
    querySync(sql: string, params?: any[]): Row[];
    closeSync(): void;
}

export interface Row {
    [key: string]: any;
}

export interface ConstrainedFieldDefinition {
    type?: 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB' | 'VECTOR';
    unique?: boolean;
    foreignKey?: string; // 'table.column'
    onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT';
    onUpdate?: 'CASCADE' | 'SET NULL' | 'RESTRICT';
    nullable?: boolean;
    checkConstraint?: string;
    // Vector-specific properties
    vectorDimensions?: number; // Required when type is 'VECTOR'
    vectorType?: 'float' | 'int8' | 'binary'; // Default: 'float'
}

export interface CollectionSchema<T extends z.ZodTypeAny = any> {
    name: string;
    schema: z.ZodSchema<T>;
    primaryKey: string;
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
    selectFields?: string[]; // For custom field selection
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
