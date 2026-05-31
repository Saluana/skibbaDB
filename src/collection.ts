import { z } from 'zod/v3';
import type {
    Driver,
    CollectionSchema,
    InferSchema,
    VectorSearchOptions,
    VectorSearchResult,
    DocBindSql,
    QueryCollectionAdapter,
    QueryOptions,
} from './types';
import { DEFAULT_DOC_BIND_SQL } from './types';
import { QueryBuilder, FieldBuilder } from './query-builder';
import { SQLTranslator } from './sql-translator';
import { SchemaSQLGenerator } from './schema-sql-generator.js';
import {
    ValidationError,
    NotFoundError,
    UniqueConstraintError,
    VersionMismatchError,
    PluginError,
    CheckConstraintError,
    DatabaseError,
} from './errors.js';
import {
    parseDoc,
    mergeConstrainedFields,
    reconstructNestedObject,
    stringifyDoc,
} from './json-utils.js';
import type { QueryablePaths, OrderablePaths } from './types/nested-paths';
import type { PluginManager } from './plugin-system';
import { Migrator } from './migrator';
import { 
    fieldPathToColumnName,
    extractConstrainedValues,
    convertValueForStorage,
    inferSQLiteType,
    getZodTypeForPath,
} from './constrained-fields';
import { isVectorExtensionError } from './vector-sql';
import {
    attachPublicId,
    normalizeIncomingDoc,
    resolveInternalId,
} from './document-id';
import {
    prepareInsertDoc,
    mapInsertResult,
    prepareUpdateDoc,
    mapUpdateResult,
    prepareBulkInsertDocs,
    prepareVectorDeletes,
    mapJoinedRow,
} from './collection-ops';
import {
    CollectionAtomic,
    CollectionBulk,
    CollectionIndexes,
    CollectionSync,
    CollectionVector,
} from './collection-namespaces';
import { explainQuery, buildExplainResult, type ExplainResult } from './diagnostics';

export class Collection<T extends z.ZodSchema> {
    private driver: Driver;
    private collectionSchema: CollectionSchema<InferSchema<T>>;
    private pluginManager?: PluginManager;
    private database?: any; // Reference to the Database instance
    private allowSyncWithPlugins: boolean;
    private readonly queryAdapter: QueryCollectionAdapter<InferSchema<T>>;

    readonly bulk: CollectionBulk<T>;
    readonly sync: CollectionSync<T>;
    readonly atomic: CollectionAtomic<T>;
    readonly indexes: CollectionIndexes<T>;
    readonly vector: CollectionVector<T>;

    private isInitialized = false;
    private initializationPromise?: Promise<void>;
    private upgradeError?: Error;
    
    private static migratedCollections = new WeakMap<object, Set<string>>();

    constructor(
        driver: Driver,
        schema: CollectionSchema<InferSchema<T>>,
        pluginManager?: PluginManager,
        database?: any,
        options?: { allowSyncWithPlugins?: boolean }
    ) {
        this.driver = driver;
        this.collectionSchema = schema;
        this.pluginManager = pluginManager;
        this.database = database;
        this.allowSyncWithPlugins = options?.allowSyncWithPlugins ?? false;
        this.queryAdapter = {
            executeQuery: (options) => this.executeQuery(options),
            executeQuerySync: (options) => this.executeQuerySync(options),
            executeQueryIterator: (options) => this.executeQueryIterator(options),
            executeCount: (options) => this.executeCount(options),
            executeCountSync: (options) => this.executeCountSync(options),
            explainQuery: (options) => this.explainAdapterQuery(options),
        };
        this.bulk = new CollectionBulk(this);
        this.sync = new CollectionSync(this);
        this.atomic = new CollectionAtomic(this);
        this.indexes = new CollectionIndexes(this);
        this.vector = new CollectionVector(this);
        this.createTable();
    }

    private get publicIdField(): string {
        return this.collectionSchema.publicIdField ?? 'id';
    }

    private presentDocument(doc: InferSchema<T>): InferSchema<T> {
        return attachPublicId(
            doc as Record<string, unknown>,
            this.publicIdField
        ) as InferSchema<T>;
    }

    private get docBindSql(): DocBindSql {
        try {
            return this.driver.docBindSql ?? DEFAULT_DOC_BIND_SQL;
        } catch {
            return DEFAULT_DOC_BIND_SQL;
        }
    }

    private isDriverClosed(): boolean {
        return (this.driver as { isClosed?: boolean }).isClosed === true;
    }

    private createTable(): void {
        // Try sync table creation first for backward compatibility
        // Fall back to async initialization if sync methods aren't available (shared connections)
        try {
            this.createTableSync();
            this.initializationPromise = this.runMigrationsAsync();
        } catch (error) {
            // If sync methods fail (e.g., shared connection), initialize everything async
            if (
                error instanceof Error &&
                error.message.includes(
                    'not supported when using a shared connection'
                )
            ) {
                this.initializationPromise = this.initializeTableAsync();
            } else {
                console.warn(
                    `Table creation failed for collection '${this.collectionSchema.name}':`,
                    error
                );
                this.initializationPromise = this.runMigrationsAsync();
            }
        }
    }

    private createTableSync(): void {
        const { sql, additionalSQL } =
            SchemaSQLGenerator.buildCreateTableWithConstraints(
                this.collectionSchema.name,
                this.collectionSchema.constraints,
                this.collectionSchema.constrainedFields,
                this.collectionSchema.schema
            );

        try {
            // Use sync methods for initial table creation
            this.driver.execSync(sql);

            // Execute additional SQL for indexes and constraints
            for (const additionalQuery of additionalSQL) {
                try {
                    this.driver.execSync(additionalQuery);
                } catch (error) {
                    if (isVectorExtensionError(error)) {
                        console.warn(
                            `Warning: Vector table creation failed (extension not available): ${(error as Error).message}. Vector search functionality will be disabled.`
                        );
                    } else {
                        throw error;
                    }
                }
            }

            this.isInitialized = true;
        } catch (error) {
            if (
                !(
                    error instanceof Error &&
                    error.message.includes('already exists')
                )
            ) {
                throw error;
            } else {
                this.isInitialized = true;
            }
        }
    }

    private async initializeTableAsync(): Promise<void> {
        if (this.isDriverClosed()) {
            return;
        }

        const migrator = new Migrator(this.driver);

        try {
            await migrator.checkAndRunMigration(
                this.collectionSchema,
                this,
                this.database
            );
        } catch (error) {
            if (
                error instanceof DatabaseError &&
                error.code === 'DRIVER_CLOSED'
            ) {
                return;
            }
            console.warn(
                `Migration check failed for collection '${this.collectionSchema.name}':`,
                error
            );
        }

        const { sql, additionalSQL } =
            SchemaSQLGenerator.buildCreateTableWithConstraints(
                this.collectionSchema.name,
                this.collectionSchema.constraints,
                this.collectionSchema.constrainedFields,
                this.collectionSchema.schema
            );

        try {
            await this.driver.exec(sql);

            for (const additionalQuery of additionalSQL) {
                try {
                    await this.driver.exec(additionalQuery);
                } catch (error) {
                    if (isVectorExtensionError(error)) {
                        console.warn(
                            `Warning: Vector table creation failed (extension not available): ${(error as Error).message}. Vector search functionality will be disabled.`
                        );
                    } else {
                        throw error;
                    }
                }
            }

            this.isInitialized = true;
        } catch (error) {
            if (
                !(
                    error instanceof Error &&
                    error.message.includes('already exists')
                )
            ) {
                console.warn(
                    `Table creation failed for collection '${this.collectionSchema.name}':`,
                    error
                );
            } else {
                this.isInitialized = true;
            }
        }
    }

    private async runMigrationsAsync(): Promise<void> {
        if (this.isDriverClosed()) {
            return;
        }

        // PERF: Skip migration check if already performed for this collection+version
        // Include database instance reference to avoid cross-database caching issues
        const migrationCacheKey = (this.database || this.driver) as object;
        let migrationCache = Collection.migratedCollections.get(migrationCacheKey);
        if (!migrationCache) {
            migrationCache = new Set<string>();
            Collection.migratedCollections.set(migrationCacheKey, migrationCache);
        }
        const migrationKey = `${this.collectionSchema.name}_v${this.collectionSchema.version || 1}`;
        if (migrationCache.has(migrationKey)) {
            return;
        }

        try {
            const migrator = new Migrator(this.driver);
            await migrator.checkAndRunMigration(
                this.collectionSchema,
                this,
                this.database
            );
            
            // Mark as migrated on success
            migrationCache.add(migrationKey);
        } catch (error) {
            // Upgrade failures should not block normal collection operations
            if (
                error instanceof Error &&
                (error.message.includes('Custom upgrade') ||
                    error.message.includes('UPGRADE_FUNCTION_FAILED'))
            ) {
                this.upgradeError = error;
                console.error(
                    `Upgrade function failed for collection '${this.collectionSchema.name}':`,
                    error.message
                );
                return;
            }

            if (
                error instanceof DatabaseError &&
                error.code === 'DRIVER_CLOSED'
            ) {
                return;
            }

            // Migration errors are non-fatal for backwards compatibility
            console.warn(
                `Migration check failed for collection '${this.collectionSchema.name}':`,
                error
            );
        }
    }

    private async ensureInitialized(): Promise<void> {
        if (this.initializationPromise) {
            await this.initializationPromise;
        }
        if (!this.isInitialized) {
            throw new DatabaseError(
                `Collection '${this.collectionSchema.name}' failed to initialize`,
                'COLLECTION_NOT_INITIALIZED'
            );
        }
    }

    // Method for tests to wait for full initialization including migrations
    async waitForInitialization(): Promise<void> {
        if (this.initializationPromise) {
            await this.initializationPromise;
        }
        // If there was an upgrade function failure, throw for explicit test handling
        if (this.upgradeError) {
            throw this.upgradeError;
        }
    }

    private validateDocument(doc: any): InferSchema<T> {
        const systemId = doc._id;
        const systemVersion = doc._version;
        try {
            const validated = this.collectionSchema.schema.parse(doc) as InferSchema<T>;
            if (systemId !== undefined) {
                (validated as any)._id = systemId;
            }
            if (systemVersion !== undefined) {
                (validated as any)._version = systemVersion;
            }
            return validated;
        } catch (error) {
            if (error instanceof z.ZodError) {
                throw new ValidationError(
                    `Validation failed for collection "${this.collectionSchema.name}"`,
                    error
                );
            }
            throw new ValidationError('Document validation failed', error);
        }
    }

    /**
     * Try to start a transaction, detecting if already within one.
     * Returns true if this method started the transaction, false if already in one.
     * 
     * IMPROVED: Check driver state first before attempting BEGIN to avoid errors.
     */
    private async tryBeginTransaction(): Promise<boolean> {
        try {
            await this.driver.exec('BEGIN IMMEDIATE TRANSACTION', []);
            return true;
        } catch (error) {
            if (error instanceof Error && error.message.includes('transaction within a transaction')) {
                return false;
            }
            throw error;
        }
    }

    /**
     * Synchronous version of tryBeginTransaction for sync operations.
     */
    private tryBeginTransactionSync(): boolean {
        try {
            this.driver.execSync('BEGIN IMMEDIATE TRANSACTION', []);
            return true;
        } catch (error) {
            if (error instanceof Error && error.message.includes('transaction within a transaction')) {
                return false;
            }
            throw error instanceof Error ? error : new Error(String(error));
        }
    }

    private getDocumentSelectColumns(): string {
        if (
            !this.collectionSchema.constrainedFields ||
            Object.keys(this.collectionSchema.constrainedFields).length === 0
        ) {
            return 'json(doc) AS doc, _version';
        }

        const constrainedFieldColumns = Object.keys(this.collectionSchema.constrainedFields)
            .map((f) => fieldPathToColumnName(f))
            .join(', ');
        return `json(doc) AS doc, _version, ${constrainedFieldColumns}`;
    }

    private mapRowToDocument(row: any): InferSchema<T> {
        const doc =
            this.collectionSchema.constrainedFields &&
            Object.keys(this.collectionSchema.constrainedFields).length > 0
                ? mergeConstrainedFields(
                      row,
                      this.collectionSchema.constrainedFields,
                      this.collectionSchema.schema
                  )
                : parseDoc(row.doc);
        if (row._version !== undefined) {
            (doc as any)._version = row._version;
        }
        return attachPublicId(doc as Record<string, unknown>, this.publicIdField) as InferSchema<T>;
    }

    private async fetchDocumentsByIds(
        ids: string[]
    ): Promise<Map<string, InferSchema<T>>> {
        const map = new Map<string, InferSchema<T>>();
        if (ids.length === 0) {
            return map;
        }

        const CHUNK_SIZE = 500;
        for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
            const chunk = ids.slice(i, i + CHUNK_SIZE);
            const placeholders = chunk.map(() => '?').join(', ');
            const sql = `SELECT ${this.getDocumentSelectColumns()} FROM ${this.collectionSchema.name} WHERE _id IN (${placeholders})`;
            const rows = await this.driver.query(sql, chunk);
            for (const row of rows) {
                const doc = this.mapRowToDocument(row);
                map.set((doc as any)._id, doc);
            }
        }
        return map;
    }

    private fetchDocumentsByIdsSync(ids: string[]): Map<string, InferSchema<T>> {
        const map = new Map<string, InferSchema<T>>();
        if (ids.length === 0) {
            return map;
        }

        const CHUNK_SIZE = 500;
        for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
            const chunk = ids.slice(i, i + CHUNK_SIZE);
            const placeholders = chunk.map(() => '?').join(', ');
            const sql = `SELECT ${this.getDocumentSelectColumns()} FROM ${this.collectionSchema.name} WHERE _id IN (${placeholders})`;
            const rows = this.driver.querySync(sql, chunk);
            for (const row of rows) {
                const doc = this.mapRowToDocument(row);
                map.set((doc as any)._id, doc);
            }
        }
        return map;
    }

    /**
     * Shared error handler for SQL constraint violations.
     * Converts SQLite error messages into appropriate SkibbaDB error types.
     */
    private handleSQLConstraintError(error: unknown, fallbackId: string = 'unknown'): never {
        if (error && typeof error === 'object') {
            const errorRecord = error as { code?: string | number; errno?: number; message?: string };
            const rawCode = errorRecord.code ?? errorRecord.errno;
            const numericCode = typeof rawCode === 'number' ? rawCode : undefined;
            const stringCode = typeof rawCode === 'string' ? rawCode : undefined;
            const message = errorRecord.message ?? '';

            const fieldMatch = message.match(
                /UNIQUE constraint failed: [^.]+\.([^,\s]+)/
            );
            const field = fieldMatch ? fieldMatch[1] : 'unknown';

            // SECURITY NOTE: Error code handling across different SQLite drivers
            // - better-sqlite3: Uses numeric extended result codes (e.g., 2067, 787, 531)
            // - @libsql/client: Uses string codes (e.g., 'SQLITE_CONSTRAINT_UNIQUE')
            // - Bun's SQLite: Uses numeric codes similar to better-sqlite3
            // We check string codes first (most reliable), then fall back to numeric codes
            
            // UNIQUE/PRIMARY KEY constraint violations (SQLITE_CONSTRAINT_UNIQUE = 2067, SQLITE_CONSTRAINT_PRIMARYKEY = 1555)
            // Also check for base UNIQUE error code (275) for older drivers
            if (
                stringCode?.includes('SQLITE_CONSTRAINT_UNIQUE') ||
                stringCode?.includes('SQLITE_CONSTRAINT_PRIMARYKEY') ||
                numericCode === 2067 ||
                numericCode === 1555 ||
                numericCode === 275
            ) {
                throw new UniqueConstraintError(
                    `Document violates unique constraint on field: ${field}`,
                    fallbackId
                );
            }

            // FOREIGN KEY constraint violations (SQLITE_CONSTRAINT_FOREIGNKEY = 787)
            if (
                stringCode?.includes('SQLITE_CONSTRAINT_FOREIGNKEY') ||
                numericCode === 787
            ) {
                throw new ValidationError(
                    'Document validation failed: Invalid foreign key reference',
                    error
                );
            }

            // CHECK constraint violations (SQLITE_CONSTRAINT_CHECK = 531)
            if (
                stringCode?.includes('SQLITE_CONSTRAINT_CHECK') ||
                numericCode === 531
            ) {
                throw new CheckConstraintError(
                    'Document violates check constraint',
                    error
                );
            }

            if (message.includes('UNIQUE constraint')) {
                throw new UniqueConstraintError(
                    `Document violates unique constraint on field: ${field}`,
                    fallbackId
                );
            }

            if (message.includes('FOREIGN KEY constraint')) {
                throw new ValidationError(
                    'Document validation failed: Invalid foreign key reference',
                    error
                );
            }
        }

        throw error instanceof Error ? error : new Error(String(error));
    }

    /**
     * Create plugin context for operations
     */
    private createPluginContext(operation: string, data?: any) {
        return {
            collectionName: this.collectionSchema.name,
            schema: this.collectionSchema,
            operation,
            data,
        };
    }

    private async executeVectorQueries(
        vectorQueries: { sql: string; params: any[] }[]
    ): Promise<void> {
        for (const vectorQuery of vectorQueries) {
            try {
                await this.driver.exec(vectorQuery.sql, vectorQuery.params);
            } catch (error) {
                if (isVectorExtensionError(error)) {
                    console.warn(
                        `Warning: Vector operation failed (extension not available): ${(error as Error).message}. Vector search functionality will be disabled for this field.`
                    );
                } else {
                    throw error;
                }
            }
        }
    }

    private executeVectorQueriesSync(
        vectorQueries: { sql: string; params: any[] }[]
    ): void {
        for (const vectorQuery of vectorQueries) {
            try {
                this.driver.execSync(vectorQuery.sql, vectorQuery.params);
            } catch (error) {
                if (isVectorExtensionError(error)) {
                    console.warn(
                        `Warning: Vector operation failed (extension not available): ${(error as Error).message}. Vector search functionality will be disabled for this field.`
                    );
                } else {
                    throw error;
                }
            }
        }
    }

    private assertSyncPluginsAllowed(operation: string): void {
        if (!this.pluginManager || !this.pluginManager.hasPlugins()) {
            return;
        }
        if (!this.allowSyncWithPlugins) {
            throw new PluginError(
                'Sync operations are not supported with plugins; use async equivalents.',
                'PluginManager',
                operation
            );
        }
    }

    // ── QueryCollectionAdapter implementation ──

    private async executeQuery<TOut = InferSchema<T>>(options: QueryOptions): Promise<TOut[]> {
        const context = {
            collectionName: this.collectionSchema.name,
            schema: this.collectionSchema,
            operation: 'query',
            data: { filters: options.filters },
        };
        await this.pluginManager?.executeHookSafe('onBeforeQuery', context);

        const { sql, params } = SQLTranslator.buildSelectQuery(
            this.collectionSchema.name,
            options,
            this.collectionSchema.constrainedFields
        );
        const rows = await this.driver.query(sql, params);

        let results: TOut[];
        if (options.aggregates && options.aggregates.length > 0) {
            results = rows as TOut[];
        } else if (options.joins && options.joins.length > 0) {
            results = rows.map((row) => {
                const mergedObject: any = {};
                if (row.doc) {
                    Object.assign(mergedObject, parseDoc(row.doc));
                }
                Object.keys(row).forEach((key) => {
                    if (key !== 'doc' && row[key] !== null && row[key] !== undefined) {
                        const fieldName = key.includes('.') ? key.split('.').pop() : key;
                        if (fieldName) {
                            mergedObject[fieldName] = row[key];
                        }
                    }
                });
                return mergedObject;
            }) as TOut[];
        } else {
            results = rows.map((row) => {
                if (row.doc !== undefined) {
                    return this.mapRowToDocument(row) as TOut;
                }
                const obj: any = {};
                for (const key of Object.keys(row)) {
                    obj[key] = row[key];
                }
                return reconstructNestedObject(obj) as TOut;
            });
        }

        await this.pluginManager?.executeHookSafe('onAfterQuery', { ...context, result: results });
        return results;
    }

    private executeQuerySync<TOut = InferSchema<T>>(options: QueryOptions): TOut[] {
        const { sql, params } = SQLTranslator.buildSelectQuery(
            this.collectionSchema.name,
            options,
            this.collectionSchema.constrainedFields
        );
        const rows = this.driver.querySync(sql, params);

        if (options.aggregates && options.aggregates.length > 0) {
            return rows as TOut[];
        }

        if (options.joins && options.joins.length > 0) {
            return rows.map((row) => {
                const mergedObject: any = {};
                if (row.doc) {
                    Object.assign(mergedObject, parseDoc(row.doc));
                }
                Object.keys(row).forEach((key) => {
                    if (key !== 'doc' && row[key] !== null && row[key] !== undefined) {
                        const fieldName = key.includes('.') ? key.split('.').pop() : key;
                        if (fieldName) {
                            mergedObject[fieldName] = row[key];
                        }
                    }
                });
                return mergedObject;
            }) as TOut[];
        }

        return rows.map((row) => {
            if (row.doc !== undefined) {
                return parseDoc(row.doc) as TOut;
            }
            const obj: any = {};
            for (const key of Object.keys(row)) {
                obj[key] = row[key];
            }
            return reconstructNestedObject(obj) as TOut;
        });
    }

    private async *executeQueryIterator<TOut = InferSchema<T>>(options: QueryOptions): AsyncIterableIterator<TOut> {
        const { sql, params } = SQLTranslator.buildSelectQuery(
            this.collectionSchema.name,
            options,
            this.collectionSchema.constrainedFields
        );

        for await (const row of this.driver.queryIterator(sql, params)) {
            if (options.aggregates && options.aggregates.length > 0) {
                yield row as TOut;
            } else if (options.joins && options.joins.length > 0) {
                const mergedObject: any = {};
                if (row.doc !== undefined) {
                    Object.assign(mergedObject, parseDoc(row.doc));
                }
                Object.keys(row).forEach((key) => {
                    if (key !== 'doc' && row[key] !== null && row[key] !== undefined) {
                        const fieldName = key.includes('.') ? key.split('.').pop() : key;
                        if (fieldName) {
                            mergedObject[fieldName] = row[key];
                        }
                    }
                });
                yield mergedObject as TOut;
            } else if (row.doc !== undefined) {
                yield this.mapRowToDocument(row) as TOut;
            } else {
                const obj: any = {};
                for (const key of Object.keys(row)) {
                    obj[key] = row[key];
                }
                yield reconstructNestedObject(obj) as TOut;
            }
        }
    }

    private async executeCount(options: QueryOptions): Promise<number> {
        let sql = `SELECT COUNT(*) as count FROM ${this.collectionSchema.name}`;
        const params: any[] = [];

        if (options.filters.length > 0) {
            const { whereClause, whereParams } = SQLTranslator.buildWhereClause(
                options.filters,
                'AND',
                this.collectionSchema.constrainedFields
            );
            sql += ` WHERE ${whereClause}`;
            params.push(...whereParams);
        }

        const result = await this.driver.query(sql, params);
        return result[0].count;
    }

    private executeCountSync(options: QueryOptions): number {
        let sql = `SELECT COUNT(*) as count FROM ${this.collectionSchema.name}`;
        const params: any[] = [];

        if (options.filters.length > 0) {
            const { whereClause, whereParams } = SQLTranslator.buildWhereClause(
                options.filters,
                'AND',
                this.collectionSchema.constrainedFields
            );
            sql += ` WHERE ${whereClause}`;
            params.push(...whereParams);
        }

        const result = this.driver.querySync(sql, params);
        return result[0].count;
    }

    private async explainAdapterQuery(options: QueryOptions): Promise<import('./diagnostics').ExplainResult> {
        return buildExplainResult(
            this.collectionSchema.name,
            options,
            this.collectionSchema.constrainedFields
        );
    }

    private generateId(): string {
        return crypto.randomUUID();
    }

    async insert(doc: Omit<InferSchema<T>, '_id'>): Promise<InferSchema<T>> {
        await this.ensureInitialized();

        const context = this.createPluginContext('insert', doc);
        await this.pluginManager?.executeHookSafe('onBeforeInsert', context);

        try {
            const prepared = prepareInsertDoc(
                doc, this.collectionSchema, this.publicIdField,
                () => this.generateId(), (d) => this.validateDocument(d), this.docBindSql
            );
            await this.driver.exec(prepared.sql, prepared.params);
            await this.executeVectorQueries(prepared.vectorQueries);

            const presented = mapInsertResult(prepared.validatedDoc, this.publicIdField);
            await this.pluginManager?.executeHookSafe('onAfterInsert', { ...context, result: presented });
            return presented;
        } catch (error) {
            await this.pluginManager?.executeHookSafe('onError', { ...context, error: error as Error });
            this.handleSQLConstraintError(error, (doc as any)._id || 'unknown');
        }
    }

    /** @internal Use `bulk.insert()` instead */
    async insertBulk(
        docs: Omit<InferSchema<T>, '_id'>[]
    ): Promise<InferSchema<T>[]> {
        await this.ensureInitialized();
        if (docs.length === 0) return [];

        const context = this.createPluginContext('insertBulk', docs);
        await this.pluginManager?.executeHookSafe('onBeforeInsert', context);

        try {
            const validatedDocs = await this.driver.transaction(async () => {
                const explicitIds = docs
                    .map((doc) => (doc as any)._id)
                    .filter(Boolean);

                if (explicitIds.length > 0) {
                    const placeholders = explicitIds.map(() => '?').join(',');
                    const checkSql = `SELECT _id FROM ${this.collectionSchema.name} WHERE _id IN (${placeholders})`;
                    const existing = await this.driver.query(checkSql, explicitIds);
                    if (existing.length > 0) {
                        throw new UniqueConstraintError(
                            `Documents with ids [${existing.map((r) => r._id).join(', ')}] already exist`,
                            existing[0]._id as string
                        );
                    }
                }

                const prepared = prepareBulkInsertDocs(
                    docs, this.collectionSchema, () => this.generateId(),
                    (d) => this.validateDocument(d), this.docBindSql
                );

                // Handle chunked SQL (from batching large inserts)
                const sqlStatements = prepared.sql.split('; ').filter(s => s.trim());
                if (sqlStatements.length <= 1) {
                    await this.driver.exec(prepared.sql, prepared.params);
                } else {
                    // Multi-chunk: split params proportionally
                    let paramOffset = 0;
                    for (const sqlChunk of sqlStatements) {
                        const paramCount = (sqlChunk.match(/\?/g) || []).length;
                        await this.driver.exec(sqlChunk, prepared.params.slice(paramOffset, paramOffset + paramCount));
                        paramOffset += paramCount;
                    }
                }
                await this.executeVectorQueries(prepared.vectorQueries);

                return prepared.validatedDocs.map(doc => this.presentDocument(doc));
            });

            await this.pluginManager?.executeHookSafe('onAfterInsert', { ...context, result: validatedDocs });
            return validatedDocs;
        } catch (error) {
            await this.pluginManager?.executeHookSafe('onError', { ...context, error: error as Error });
            this.handleSQLConstraintError(error);
        }
    }

    /** @internal Use `update()` instead */
    async put(
        _id: string,
        doc: Partial<InferSchema<T>>
    ): Promise<InferSchema<T>> {
        await this.ensureInitialized();
        
        return await this.driver.transaction(async () => {
            const existing = await this.findById(_id);
            if (!existing) {
                throw new NotFoundError('Document not found', _id);
            }

            const currentVersion = (existing as any)._version || 1;
            const prepared = prepareUpdateDoc(
                existing, doc, _id, this.collectionSchema,
                (d) => this.validateDocument(d), this.docBindSql, currentVersion
            );

            const context = this.createPluginContext('update', prepared.validatedDoc);
            await this.pluginManager?.executeHookSafe('onBeforeUpdate', context);

            const updatedRows = await this.driver.query(
                `${prepared.sql} RETURNING _version`,
                prepared.params
            );

            if (updatedRows.length === 0) {
                const latest = await this.findById(_id);
                const latestVersion = (latest as any)?._version || 1;
                throw new VersionMismatchError(
                    `Version mismatch: expected ${currentVersion}, got ${latestVersion}`,
                    _id,
                    currentVersion,
                    latestVersion
                );
            }

            await this.executeVectorQueries(prepared.vectorQueries);

            const result = mapUpdateResult(prepared.validatedDoc, currentVersion);
            await this.pluginManager?.executeHookSafe('onAfterUpdate', { ...context, result });
            return result;
        });
    }

    /**
     * Atomic update using operators like $inc, $set, $push
     * Avoids read-before-write race conditions
     */
    /** @internal Use `atomic.update()` instead */
    async atomicUpdate(
        _id: string,
        operators: import('./types').AtomicUpdateOperators,
        options?: import('./types').UpdateOptions
    ): Promise<InferSchema<T>> {
        await this.ensureInitialized();

        const context = this.createPluginContext('atomicUpdate', { _id, operators, options });
        await this.pluginManager?.executeHookSafe('onBeforeUpdate', context);

        try {
            const { sql, params } = SQLTranslator.buildAtomicUpdateQuery(
                this.collectionSchema.name,
                _id,
                operators,
                options?.expectedVersion,
                this.collectionSchema.constrainedFields,
                this.collectionSchema.schema
            );
            const returningSql = `${sql} RETURNING ${this.getDocumentSelectColumns()}`;

            let updated: InferSchema<T> | undefined;
            await this.driver.transaction(async () => {
                const rows = await this.driver.query(returningSql, params);
                if (rows.length === 0) {
                    const existing = await this.findById(_id);
                    if (!existing) {
                        throw new NotFoundError('Document not found', _id);
                    }
                    if (options?.expectedVersion !== undefined) {
                        const currentVersion = (existing as any)._version || 1;
                        throw new VersionMismatchError(
                            `Version mismatch: expected ${options.expectedVersion}, got ${currentVersion}`,
                            _id,
                            options.expectedVersion,
                            currentVersion
                        );
                    }
                    throw new NotFoundError('Document not found after update', _id);
                }
                updated = this.mapRowToDocument(rows[0]);
            });

            if (!updated) {
                throw new NotFoundError('Document not found after update', _id);
            }

            await this.pluginManager?.executeHookSafe('onAfterUpdate', { ...context, result: updated });
            return updated;
        } catch (error) {
            await this.pluginManager?.executeHookSafe('onError', { ...context, error: error as Error });
            throw error;
        }
    }

    /**
     * Sync version of atomicUpdate
     * @deprecated Sync operations are not supported with plugins; use async methods instead.
     */
    /** @internal Use `atomic.update()` instead */
    atomicUpdateSync(
        _id: string,
        operators: import('./types').AtomicUpdateOperators,
        options?: import('./types').UpdateOptions
    ): InferSchema<T> {
        this.assertSyncPluginsAllowed('atomicUpdate');
        const { sql, params } = SQLTranslator.buildAtomicUpdateQuery(
            this.collectionSchema.name,
            _id,
            operators,
            options?.expectedVersion,
            this.collectionSchema.constrainedFields,
            this.collectionSchema.schema
        );
        const rows = this.driver.querySync(
            `${sql} RETURNING ${this.getDocumentSelectColumns()}`,
            params
        );
        if (rows.length === 0) {
            const existing = this.findByIdSync(_id);
            if (!existing) {
                throw new NotFoundError('Document not found', _id);
            }
            if (options?.expectedVersion !== undefined) {
                const currentVersion = (existing as any)._version || 1;
                throw new VersionMismatchError(
                    `Version mismatch: expected ${options.expectedVersion}, got ${currentVersion}`,
                    _id,
                    options.expectedVersion,
                    currentVersion
                );
            }
            throw new NotFoundError('Document not found after update', _id);
        }

        return this.mapRowToDocument(rows[0]);
    }

    /** @internal Use `bulk.update()` instead */
    async putBulk(
        updates: { _id: string; doc: Partial<InferSchema<T>> }[]
    ): Promise<InferSchema<T>[]> {
        await this.ensureInitialized();
        if (updates.length === 0) return [];

        const context = this.createPluginContext('putBulk', updates);
        await this.pluginManager?.executeHookSafe('onBeforeUpdate', context);

        try {
            // Use driver.transaction for proper nested transaction handling with SAVEPOINTs
            const validatedDocs = await this.driver.transaction(async () => {
                const validatedDocs: InferSchema<T>[] = [];
                const sqlStatements: { sql: string; params: any[] }[] = [];
                const vectorQueries: { sql: string; params: any[] }[] = [];
                const existingById = await this.fetchDocumentsByIds(
                    updates.map((u) => u._id)
                );

                for (const update of updates) {
                    const existing = existingById.get(update._id);
                    if (!existing) {
                        throw new NotFoundError('Document not found', update._id);
                    }

                    const updatedDoc = { ...existing, ...update.doc, _id: update._id };
                    const validatedDoc = this.validateDocument(updatedDoc);
                    validatedDocs.push(validatedDoc);

                    const { sql, params } = SQLTranslator.buildUpdateQuery(
                        this.collectionSchema.name,
                        validatedDoc,
                        update._id,
                        this.collectionSchema.constrainedFields,
                        this.collectionSchema.schema,
                        undefined,
                        this.docBindSql
                    );
                    sqlStatements.push({ sql, params });

                    vectorQueries.push(
                        ...SQLTranslator.buildVectorUpdateQueries(
                            this.collectionSchema.name,
                            validatedDoc,
                            update._id,
                            this.collectionSchema.constrainedFields
                        )
                    );
                }

                for (const statement of sqlStatements) {
                    await this.driver.exec(statement.sql, statement.params);
                }
                for (const vectorQuery of vectorQueries) {
                    await this.driver.exec(vectorQuery.sql, vectorQuery.params);
                }

                return validatedDocs;
            });

            await this.pluginManager?.executeHookSafe('onAfterUpdate', { ...context, result: validatedDocs });
            return validatedDocs;
        } catch (error) {
            await this.pluginManager?.executeHookSafe('onError', { ...context, error: error as Error });
            this.handleSQLConstraintError(error);
        }
    }

    async delete(_id: string): Promise<boolean> {
        await this.ensureInitialized();
        const context = this.createPluginContext('delete', { _id });
        await this.pluginManager?.executeHookSafe('onBeforeDelete', context);

        const { sql, params } = SQLTranslator.buildDeleteQuery(this.collectionSchema.name, _id);
        const deletedRows = await this.driver.query(`${sql} RETURNING _id`, params);
        if (deletedRows.length === 0) {
            return false;
        }

        const vectorQueries = SQLTranslator.buildVectorDeleteQueries(
            this.collectionSchema.name,
            _id,
            this.collectionSchema.constrainedFields
        );
        await this.executeVectorQueries(vectorQueries);

        await this.pluginManager?.executeHookSafe('onAfterDelete', { ...context, result: { _id, deleted: true } });
        return true;
    }

    /** @internal Use `bulk.delete()` instead */
    async deleteBulk(ids: string[]): Promise<number> {
        await this.ensureInitialized();
        if (ids.length === 0) return 0;

        return await this.driver.transaction(async () => {
            // Fire per-document before-delete hooks
            for (const _id of ids) {
                const context = this.createPluginContext('delete', { _id });
                await this.pluginManager?.executeHookSafe('onBeforeDelete', context);
            }

            // Find which IDs actually exist
            const placeholders = ids.map(() => '?').join(',');
            const existingRows = await this.driver.query(
                `SELECT _id FROM ${this.collectionSchema.name} WHERE _id IN (${placeholders})`,
                ids
            );
            const existingIds = new Set(existingRows.map((r: any) => r._id as string));

            if (existingIds.size === 0) return 0;

            // Batched delete; side effects should run once per existing document.
            const existingIdList = Array.from(existingIds);
            const delPlaceholders = existingIdList.map(() => '?').join(',');
            await this.driver.exec(
                `DELETE FROM ${this.collectionSchema.name} WHERE _id IN (${delPlaceholders})`,
                existingIdList
            );

            // Vector cleanup for deleted IDs
            if (this.collectionSchema.constrainedFields) {
                for (const _id of existingIdList) {
                    const vectorQueries = prepareVectorDeletes(
                        this.collectionSchema.name, _id, this.collectionSchema.constrainedFields
                    );
                    await this.executeVectorQueries(vectorQueries);
                }
            }

            // Fire per-document after-delete hooks
            for (const _id of existingIdList) {
                const context = this.createPluginContext('delete', { _id });
                await this.pluginManager?.executeHookSafe('onAfterDelete', { ...context, result: { _id, deleted: true } });
            }

            return existingIds.size;
        });
    }

    /**
     * Upsert a document - insert or update if exists
     * CRITICAL FIX: Use ON CONFLICT to preserve _version counter for optimistic concurrency
     * INSERT OR REPLACE deletes and reinserts, resetting _version to 1
     */
    async upsert(
        _id: string,
        doc: Omit<InferSchema<T>, '_id'>
    ): Promise<InferSchema<T>> {
        await this.ensureInitialized();
        const fullDoc = { ...doc, _id };
        const validatedDoc = this.validateDocument(fullDoc);

        const existing = await this.findById(_id);
        const context = this.createPluginContext('upsert', validatedDoc);
        if (existing) {
            await this.pluginManager?.executeHookSafe('onBeforeUpdate', context);
        } else {
            await this.pluginManager?.executeHookSafe('onBeforeInsert', context);
        }

        try {
            const result = await this.driver.transaction(async () => {
                const { sql, params } = SQLTranslator.buildUpsertQuery(
                    this.collectionSchema.name,
                    validatedDoc,
                    _id,
                    this.collectionSchema.constrainedFields,
                    this.collectionSchema.schema,
                    this.docBindSql
                );
                await this.driver.exec(sql, params);

                const vectorQueries = SQLTranslator.buildVectorInsertQueries(
                    this.collectionSchema.name,
                    validatedDoc,
                    _id,
                    this.collectionSchema.constrainedFields
                );
                await this.executeVectorQueries(vectorQueries);
                const upserted = await this.findById(_id);
                if (!upserted) {
                    throw new NotFoundError('Document not found after upsert', _id);
                }
                return upserted;
            });

            if (existing) {
                await this.pluginManager?.executeHookSafe('onAfterUpdate', {
                    ...context,
                    result,
                });
            } else {
                await this.pluginManager?.executeHookSafe('onAfterInsert', {
                    ...context,
                    result,
                });
            }
            return result;
        } catch (error) {
            await this.pluginManager?.executeHookSafe('onError', {
                ...context,
                error: error as Error,
            });
            this.handleSQLConstraintError(error, _id);
        }
    }

    /**
     * Bulk upsert operation
     * CRITICAL FIX: Use individual upserts to preserve _version counters
     * Note: Plugin hooks are fired per-document by each upsert() call, not at bulk level.
     */
    async upsertBulk(
        updates: { _id: string; doc: Omit<InferSchema<T>, '_id'> }[]
    ): Promise<InferSchema<T>[]> {
        await this.ensureInitialized();
        if (updates.length === 0) return [];

        try {
            const results = await this.driver.transaction(async () => {
                // Fire before hooks per-document
                for (const update of updates) {
                    const fullDoc = { ...update.doc, _id: update._id };
                    const validatedDoc = this.validateDocument(fullDoc);
                    const existing = await this.findById(update._id);
                    const context = this.createPluginContext('upsert', validatedDoc);
                    if (existing) {
                        await this.pluginManager?.executeHookSafe('onBeforeUpdate', context);
                    } else {
                        await this.pluginManager?.executeHookSafe('onBeforeInsert', context);
                    }
                }

                // Validate all docs and build batched upsert
                const validatedItems: { id: string; doc: InferSchema<T> }[] = [];
                for (const update of updates) {
                    const fullDoc = { ...update.doc, _id: update._id };
                    const validatedDoc = this.validateDocument(fullDoc);
                    validatedItems.push({ id: update._id, doc: validatedDoc });
                }

                const { sql, params } = SQLTranslator.buildBulkUpsertQuery(
                    this.collectionSchema.name,
                    validatedItems,
                    this.collectionSchema.constrainedFields,
                    this.collectionSchema.schema,
                    this.docBindSql
                );
                await this.driver.exec(sql, params);

                // Vector inserts for all docs
                for (const item of validatedItems) {
                    const vectorQueries = SQLTranslator.buildVectorInsertQueries(
                        this.collectionSchema.name,
                        item.doc,
                        item.id,
                        this.collectionSchema.constrainedFields
                    );
                    await this.executeVectorQueries(vectorQueries);
                }

                // Fetch all upserted docs
                const upsertedDocs: InferSchema<T>[] = [];
                for (const item of validatedItems) {
                    const upserted = await this.findById(item.id);
                    if (!upserted) {
                        throw new NotFoundError('Document not found after upsert', item.id);
                    }
                    upsertedDocs.push(upserted);
                }

                // Fire after hooks per-document
                for (let i = 0; i < updates.length; i++) {
                    const existing = await this.findById(updates[i]._id);
                    const context = this.createPluginContext('upsert', upsertedDocs[i]);
                    if (existing && (existing as any)._version > 1) {
                        await this.pluginManager?.executeHookSafe('onAfterUpdate', { ...context, result: upsertedDocs[i] });
                    } else {
                        await this.pluginManager?.executeHookSafe('onAfterInsert', { ...context, result: upsertedDocs[i] });
                    }
                }

                return upsertedDocs;
            });
            
            return results;
        } catch (error) {
            this.handleSQLConstraintError(error);
        }
    }

    /** Get a document by id (alias: findById) */
    async get(id: string): Promise<InferSchema<T> | null> {
        return this.findById(id);
    }

    /** @internal Use `get()` instead */
    async findById(_id: string): Promise<InferSchema<T> | null> {
        await this.ensureInitialized();

        const sql = `SELECT ${this.getDocumentSelectColumns()} FROM ${this.collectionSchema.name} WHERE _id = ?`;
        const params = [_id];
        const rows = await this.driver.query(sql, params);
        if (rows.length === 0) return null;
        return this.mapRowToDocument(rows[0]);
    }

    private validateFieldName(fieldName: string): void {
        // For nested field paths (containing dots), validate recursively using Zod schema
        if (fieldName.includes('.')) {
            const zodType = getZodTypeForPath(this.collectionSchema.schema, fieldName);
            if (!zodType) {
                // Split path and find which segment is invalid
                const segments = fieldName.split('.');
                let currentPath = '';
                for (let i = 0; i < segments.length; i++) {
                    currentPath = i === 0 ? segments[i] : `${currentPath}.${segments[i]}`;
                    const checkType = getZodTypeForPath(this.collectionSchema.schema, currentPath);
                    if (!checkType) {
                        throw new ValidationError(
                            `Invalid nested path: '${fieldName}' - segment '${segments[i]}' not found at path '${currentPath}'`
                        );
                    }
                }
                // If we got here, path might be valid but getZodTypeForPath failed for another reason
                throw new ValidationError(
                    `Invalid nested path: '${fieldName}' - path does not exist in schema`
                );
            }
            return;
        }

        // Get field names from Zod schema shape
        const schema = this.collectionSchema.schema as any;
        let validFields: string[] = [];

        // Try to get fields from shape property (for ZodObject)
        if (schema.shape) {
            validFields = Object.keys(schema.shape);
        } else if (schema._def && schema._def.shape) {
            validFields = Object.keys(schema._def.shape);
        } else if (schema._def && typeof schema._def.shape === 'function') {
            validFields = Object.keys(schema._def.shape());
        }

        if (validFields.length === 0) {
            throw new ValidationError(
                `Cannot validate field '${fieldName}' because schema '${this.collectionSchema.name}' does not expose object fields`
            );
        }

        if (!validFields.includes(fieldName)) {
            throw new ValidationError(
                `Field '${fieldName}' does not exist in schema. Valid fields: ${validFields.join(
                    ', '
                )}`
            );
        }
    }

    where<K extends QueryablePaths<InferSchema<T>>>(
        field: K
    ): import('./query-builder.js').FieldBuilder<InferSchema<T>, K> & {
        collection: Collection<T>;
    };
    where(field: string): import('./query-builder.js').FieldBuilder<
        InferSchema<T>,
        any
    > & {
        collection: Collection<T>;
    };
    where<K extends QueryablePaths<InferSchema<T>>>(
        field: K | string
    ): import('./query-builder.js').FieldBuilder<InferSchema<T>, K> & {
        collection: Collection<T>;
    } {
        this.validateFieldName(field as string);
        const builder = new QueryBuilder<InferSchema<T>>(this.queryAdapter);
        const fieldBuilder = builder.where(field as K);
        (fieldBuilder as any).collection = this;
        return fieldBuilder as import('./query-builder.js').FieldBuilder<
            InferSchema<T>,
            K
        > & { collection: Collection<T> };
    }

    query(): QueryBuilder<InferSchema<T>> {
        return new QueryBuilder<InferSchema<T>>(this.queryAdapter);
    }

    /** Partial document update (alias: put) */
    async update(
        id: string,
        patch: Partial<InferSchema<T>>
    ): Promise<InferSchema<T>> {
        return this.put(id, patch);
    }

    /** Delete by id (alias: delete) */
    async remove(id: string): Promise<boolean> {
        return this.delete(id);
    }

    /** All documents (alias: toArray) */
    async all(): Promise<InferSchema<T>[]> {
        return this.toArray();
    }

    /** All documents — same as all() */
    /** @internal Use `all()` instead */
    async find(): Promise<InferSchema<T>[]> {
        return this.toArray();
    }

    /** Explain the base collection scan query */
    async explain(): Promise<ExplainResult> {
        return explainQuery(this, this.query());
    }

    // Direct query methods without conditions
    /** @internal Use `all()` instead */
    async toArray(): Promise<InferSchema<T>[]> {
        // Plugin hook: before query
        const context = {
            collectionName: this.collectionSchema.name,
            schema: this.collectionSchema,
            operation: 'query',
            data: { filters: [] },
        };
        await this.pluginManager?.executeHookSafe('onBeforeQuery', context);

        const { sql, params } = SQLTranslator.buildSelectQuery(
            this.collectionSchema.name,
            { filters: [] },
            this.collectionSchema.constrainedFields
        );
        const rows = await this.driver.query(sql, params);
        const results = rows.map((row) => this.mapRowToDocument(row));

        // Plugin hook: after query
        const resultContext = {
            ...context,
            result: results,
        };
        await this.pluginManager?.executeHookSafe(
            'onAfterQuery',
            resultContext
        );

        return results;
    }

    // MEDIUM-2 FIX: Add iterator method for memory-efficient streaming of large result sets
    async *iterator(): AsyncIterableIterator<InferSchema<T>> {
        const context = {
            collectionName: this.collectionSchema.name,
            schema: this.collectionSchema,
            operation: 'query_stream',
            data: { filters: [] },
        };
        await this.pluginManager?.executeHookSafe('onBeforeQuery', context);

        const { sql, params } = SQLTranslator.buildSelectQuery(
            this.collectionSchema.name,
            { filters: [] },
            this.collectionSchema.constrainedFields
        );
        
        // Stream rows one by one
        for await (const row of this.driver.queryIterator(sql, params)) {
            yield this.mapRowToDocument(row);
        }
    }

    // Add direct sorting and pagination methods to Collection
    orderBy<K extends OrderablePaths<InferSchema<T>>>(
        field: K,
        direction?: 'asc' | 'desc'
    ): QueryBuilder<InferSchema<T>>;
    orderBy(
        field: string,
        direction?: 'asc' | 'desc'
    ): QueryBuilder<InferSchema<T>>;
    orderBy<K extends OrderablePaths<InferSchema<T>>>(
        field: K | string,
        direction: 'asc' | 'desc' = 'asc'
    ): QueryBuilder<InferSchema<T>> {
        this.validateFieldName(field as string);
        return new QueryBuilder<InferSchema<T>>(this.queryAdapter).orderBy(field as K, direction);
    }

    limit(count: number): QueryBuilder<InferSchema<T>> {
        return new QueryBuilder<InferSchema<T>>(this.queryAdapter).limit(count);
    }

    offset(count: number): QueryBuilder<InferSchema<T>> {
        return new QueryBuilder<InferSchema<T>>(this.queryAdapter).offset(count);
    }

    page(pageNumber: number, pageSize: number): QueryBuilder<InferSchema<T>> {
        return new QueryBuilder<InferSchema<T>>(this.queryAdapter).page(pageNumber, pageSize);
    }

    distinct(): QueryBuilder<InferSchema<T>> {
        return new QueryBuilder<InferSchema<T>>(this.queryAdapter).distinct();
    }

    orderByMultiple(
        orders: { field: keyof InferSchema<T>; direction?: 'asc' | 'desc' }[]
    ): QueryBuilder<InferSchema<T>> {
        return new QueryBuilder<InferSchema<T>>(this.queryAdapter).orderByMultiple(orders);
    }

    or(
        builderFn: (
            builder: QueryBuilder<InferSchema<T>>
        ) => QueryBuilder<InferSchema<T>>
    ): QueryBuilder<InferSchema<T>> {
        return new QueryBuilder<InferSchema<T>>(this.queryAdapter).or(builderFn);
    }

    // Async versions of direct collection query methods
    async orderByAsync<K extends OrderablePaths<InferSchema<T>>>(
        field: K | string,
        direction: 'asc' | 'desc' = 'asc'
    ): Promise<QueryBuilder<InferSchema<T>>> {
        return new QueryBuilder<InferSchema<T>>(this.queryAdapter).orderBy(field as K, direction);
    }

    async limitAsync(count: number): Promise<QueryBuilder<InferSchema<T>>> {
        return new QueryBuilder<InferSchema<T>>(this.queryAdapter).limit(count);
    }

    async offsetAsync(count: number): Promise<QueryBuilder<InferSchema<T>>> {
        return new QueryBuilder<InferSchema<T>>(this.queryAdapter).offset(count);
    }

    // Sync versions for backward compatibility
    // LOW-5 TODO: Refactor sync/async duplication
    // Priority: Low - Defer until v2.0 or when adding new methods becomes unwieldy
    // Current duplication is intentional to avoid performance overhead
    // Proposed approach: Extract shared validation/transformation logic into helpers
    // Keep driver calls (execSync vs exec) separate to maintain zero-cost abstraction
    /**
     * @deprecated Sync operations are not supported with plugins; use async methods instead.
     */
    /** @internal Use `sync.insert()` instead */
    insertSync(doc: Omit<InferSchema<T>, '_id'>): InferSchema<T> {
        this.assertSyncPluginsAllowed('insert');
        const context = this.createPluginContext('insert', doc);
        this.pluginManager?.executeHookSync('onBeforeInsert', context);

        try {
            const prepared = prepareInsertDoc(
                doc, this.collectionSchema, this.publicIdField,
                () => this.generateId(), (d) => this.validateDocument(d), this.docBindSql
            );
            this.driver.execSync(prepared.sql, prepared.params);
            this.executeVectorQueriesSync(prepared.vectorQueries);

            const presented = mapInsertResult(prepared.validatedDoc, this.publicIdField);
            this.pluginManager?.executeHookSync('onAfterInsert', { ...context, result: presented });
            return presented;
        } catch (error) {
            this.pluginManager?.executeHookSync('onError', { ...context, error: error as Error });
            this.handleSQLConstraintError(error, (doc as any)._id || 'unknown');
        }
    }

    /**
     * @deprecated Sync operations are not supported with plugins; use async methods instead.
     */
    /** @internal Use `sync.insert()` with bulk docs */
    insertBulkSync(docs: Omit<InferSchema<T>, '_id'>[]): InferSchema<T>[] {
        if (docs.length === 0) return [];

        this.assertSyncPluginsAllowed('insertBulk');
        const context = this.createPluginContext('insertBulk', docs);
        this.pluginManager?.executeHookSync('onBeforeInsert', context);

        try {
            const prepared = prepareBulkInsertDocs(
                docs, this.collectionSchema, () => this.generateId(),
                (d) => this.validateDocument(d), this.docBindSql
            );

            const shouldManageTransaction = this.tryBeginTransactionSync();
            try {
                // Handle chunked SQL (from batching large inserts)
                const sqlStatements = prepared.sql.split('; ').filter(s => s.trim());
                if (sqlStatements.length <= 1) {
                    this.driver.execSync(prepared.sql, prepared.params);
                } else {
                    let paramOffset = 0;
                    for (const sqlChunk of sqlStatements) {
                        const paramCount = (sqlChunk.match(/\?/g) || []).length;
                        this.driver.execSync(sqlChunk, prepared.params.slice(paramOffset, paramOffset + paramCount));
                        paramOffset += paramCount;
                    }
                }
                this.executeVectorQueriesSync(prepared.vectorQueries);
                if (shouldManageTransaction) {
                    this.driver.execSync('COMMIT', []);
                }
            } catch (error) {
                if (shouldManageTransaction) {
                    this.driver.execSync('ROLLBACK', []);
                }
                throw error;
            }

            this.pluginManager?.executeHookSync('onAfterInsert', { ...context, result: prepared.validatedDocs });
            return prepared.validatedDocs.map(doc => this.presentDocument(doc));
        } catch (error) {
            this.pluginManager?.executeHookSync('onError', { ...context, error: error as Error });
            this.handleSQLConstraintError(error);
        }
    }

    /**
     * @deprecated Sync operations are not supported with plugins; use async methods instead.
     */
    /** @internal Use `sync.get()` instead */
    findByIdSync(_id: string): InferSchema<T> | null {
        const sql = `SELECT ${this.getDocumentSelectColumns()} FROM ${this.collectionSchema.name} WHERE _id = ?`;
        const params = [_id];
        const rows = this.driver.querySync(sql, params);
        if (rows.length === 0) return null;
        return this.mapRowToDocument(rows[0]);
    }

    /**
     * @deprecated Sync operations are not supported with plugins; use async methods instead.
     */
    /** @internal Use `sync.all()` instead */
    toArraySync(): InferSchema<T>[] {
        const { sql, params } = SQLTranslator.buildSelectQuery(
            this.collectionSchema.name,
            { filters: [] },
            this.collectionSchema.constrainedFields
        );
        const rows = this.driver.querySync(sql, params);
        return rows.map((row) => this.mapRowToDocument(row));
    }

    /**
     * @deprecated Sync operations are not supported with plugins; use async methods instead.
     */
    /** @internal Use `sync.count()` instead */
    countSync(): number {
        const sql = `SELECT COUNT(*) as count FROM ${this.collectionSchema.name}`;
        const result = this.driver.querySync(sql, []);
        return result[0].count;
    }

    /**
     * @deprecated Sync operations are not supported with plugins; use async methods instead.
     */
    /** @internal Use `sync.first()` instead */
    firstSync(): InferSchema<T> | null {
        const { sql, params } = SQLTranslator.buildSelectQuery(
            this.collectionSchema.name,
            { filters: [], limit: 1 },
            this.collectionSchema.constrainedFields
        );
        const rows = this.driver.querySync(sql, params);
        return rows.length > 0 ? parseDoc(rows[0].doc) : null;
    }

    /**
     * @deprecated Sync operations are not supported with plugins; use async methods instead.
     */
    /** @internal Use `sync.update()` instead */
    putSync(_id: string, doc: Partial<InferSchema<T>>): InferSchema<T> {
        this.assertSyncPluginsAllowed('put');
        const existing = this.findByIdSync(_id);
        if (!existing) {
            throw new NotFoundError('Document not found', _id);
        }

        const currentVersion = (existing as any)._version || 1;
        const prepared = prepareUpdateDoc(
            existing, doc, _id, this.collectionSchema,
            (d) => this.validateDocument(d), this.docBindSql, currentVersion
        );

        const context = this.createPluginContext('update', prepared.validatedDoc);
        this.pluginManager?.executeHookSync('onBeforeUpdate', context);

        const shouldManageTransaction = this.tryBeginTransactionSync();
        try {
            this.driver.execSync(prepared.sql, prepared.params);
            this.executeVectorQueriesSync(prepared.vectorQueries);

            if (shouldManageTransaction) {
                this.driver.execSync('COMMIT', []);
            }

            const result = mapUpdateResult(prepared.validatedDoc, currentVersion);
            this.pluginManager?.executeHookSync('onAfterUpdate', { ...context, result });
            return result;
        } catch (error) {
            if (shouldManageTransaction) {
                this.driver.execSync('ROLLBACK', []);
            }
            this.pluginManager?.executeHookSync('onError', { ...context, error: error as Error });
            this.handleSQLConstraintError(error, _id);
        }
    }

    /**
     * @deprecated Sync operations are not supported with plugins; use async methods instead.
     */
    /** @internal Use `sync.remove()` instead */
    deleteSync(_id: string): boolean {
        this.assertSyncPluginsAllowed('delete');
        const context = this.createPluginContext('delete', { _id });
        this.pluginManager?.executeHookSync('onBeforeDelete', context);

        const shouldManageTransaction = this.tryBeginTransactionSync();
        try {
            const { sql, params } = SQLTranslator.buildDeleteQuery(this.collectionSchema.name, _id);
            this.driver.execSync(sql, params);

            const vectorQueries = SQLTranslator.buildVectorDeleteQueries(
                this.collectionSchema.name,
                _id,
                this.collectionSchema.constrainedFields
            );
            this.executeVectorQueriesSync(vectorQueries);

            if (shouldManageTransaction) {
                this.driver.execSync('COMMIT', []);
            }

            this.pluginManager?.executeHookSync('onAfterDelete', { ...context, result: { _id, deleted: true } });
            return true;
        } catch (error) {
            if (shouldManageTransaction) {
                this.driver.execSync('ROLLBACK', []);
            }
            this.pluginManager?.executeHookSync('onError', { ...context, error: error as Error });
            throw error;
        }
    }

    /**
     * @deprecated Sync operations are not supported with plugins; use async methods instead.
     */
    /** @internal Use `sync.deleteBulk()` or `bulk.delete()` */
    deleteBulkSync(ids: string[]): number {
        if (ids.length === 0) return 0;

        this.assertSyncPluginsAllowed('deleteBulk');
        const context = this.createPluginContext('deleteBulk', ids);
        this.pluginManager?.executeHookSync('onBeforeDelete', context);

        const shouldManageTransaction = this.tryBeginTransactionSync();
        try {
            const uniqueIds = Array.from(new Set(ids));
            const selectPlaceholders = uniqueIds.map(() => '?').join(',');
            const existingRows = this.driver.querySync(
                `SELECT _id FROM ${this.collectionSchema.name} WHERE _id IN (${selectPlaceholders})`,
                uniqueIds
            );
            const existingIdList = existingRows.map((r: any) => r._id as string);

            if (existingIdList.length === 0) {
                if (shouldManageTransaction) {
                    this.driver.execSync('COMMIT', []);
                }
                this.pluginManager?.executeHookSync('onAfterDelete', { ...context, result: { deleted: 0 } });
                return 0;
            }

            // Batched SQL: DELETE ... WHERE _id IN (...)
            const placeholders = existingIdList.map(() => '?').join(',');
            const sql = `DELETE FROM ${this.collectionSchema.name} WHERE _id IN (${placeholders})`;
            this.driver.execSync(sql, existingIdList);

            // Vector cleanup
            if (this.collectionSchema.constrainedFields) {
                for (const _id of existingIdList) {
                    const vectorQueries = prepareVectorDeletes(
                        this.collectionSchema.name, _id, this.collectionSchema.constrainedFields
                    );
                    this.executeVectorQueriesSync(vectorQueries);
                }
            }

            if (shouldManageTransaction) {
                this.driver.execSync('COMMIT', []);
            }
            this.pluginManager?.executeHookSync('onAfterDelete', { ...context, result: { deleted: existingIdList.length } });
            return existingIdList.length;
        } catch (error) {
            if (shouldManageTransaction) {
                this.driver.execSync('ROLLBACK', []);
            }
            this.pluginManager?.executeHookSync('onError', { ...context, error: error as Error });
            throw error;
        }
    }

    /**
     * @deprecated Sync operations are not supported with plugins; use async methods instead.
     */
    /** @internal Use `sync.upsert()` instead */
    upsertSync(_id: string, doc: Omit<InferSchema<T>, '_id'>): InferSchema<T> {
        this.assertSyncPluginsAllowed('upsert');
        try {
            const fullDoc = { ...doc, _id };
            const validatedDoc = this.validateDocument(fullDoc);
            const { sql, params } = SQLTranslator.buildUpsertQuery(
                this.collectionSchema.name,
                validatedDoc,
                _id,
                this.collectionSchema.constrainedFields,
                this.collectionSchema.schema,
                this.docBindSql
            );
            this.driver.execSync(sql, params);
            const result = this.findByIdSync(_id);
            if (!result) {
                throw new NotFoundError('Document not found after upsert', _id);
            }
            return result;
        } catch (error) {
            this.handleSQLConstraintError(error, _id);
        }
    }

    /**
     * @deprecated Sync operations are not supported with plugins; use async methods instead.
     * CRITICAL FIX: Uses individual upserts to preserve _version counters
     */
    /** @internal Use `sync.upsertBulk()` */
    upsertBulkSync(
        docs: { _id: string; doc: Omit<InferSchema<T>, '_id'> }[]
    ): InferSchema<T>[] {
        if (docs.length === 0) return [];

        this.assertSyncPluginsAllowed('upsertBulk');
        const context = this.createPluginContext('upsertBulk', docs);
        this.pluginManager?.executeHookSync('onBeforeInsert', context);

        try {
            // CRITICAL FIX: Use individual upserts to preserve _version counters
            const results: InferSchema<T>[] = [];
            const shouldManageTransaction = this.tryBeginTransactionSync();
            
            try {
                for (const item of docs) {
                    const result = this.upsertSync(item._id, item.doc);
                    results.push(result);
                }
                
                if (shouldManageTransaction) {
                    this.driver.execSync('COMMIT', []);
                }
            } catch (error) {
                if (shouldManageTransaction) {
                    this.driver.execSync('ROLLBACK', []);
                }
                throw error;
            }

            this.pluginManager?.executeHookSync('onAfterInsert', { ...context, result: results });
            return results;
        } catch (error) {
            this.pluginManager?.executeHookSync('onError', { ...context, error: error as Error });
            this.handleSQLConstraintError(error);
        }
    }

    /**
     * @deprecated Sync operations are not supported with plugins; use async methods instead.
     */
    /** @internal Use `sync.putBulk()` */
    putBulkSync(
        updates: { _id: string; doc: Partial<InferSchema<T>> }[]
    ): InferSchema<T>[] {
        if (updates.length === 0) return [];

        this.assertSyncPluginsAllowed('putBulk');
        const context = this.createPluginContext('putBulk', updates);
        this.pluginManager?.executeHookSync('onBeforeUpdate', context);

        try {
            const validatedDocs: InferSchema<T>[] = [];
            const sqlStatements: { sql: string; params: any[] }[] = [];
            const vectorQueries: { sql: string; params: any[] }[] = [];
            const existingById = this.fetchDocumentsByIdsSync(
                updates.map((u) => u._id)
            );

            for (const update of updates) {
                const existing = existingById.get(update._id);
                if (!existing) {
                    throw new NotFoundError('Document not found', update._id);
                }

                const updatedDoc = { ...existing, ...update.doc, _id: update._id };
                const validatedDoc = this.validateDocument(updatedDoc);
                validatedDocs.push(validatedDoc);

                const { sql, params } = SQLTranslator.buildUpdateQuery(
                    this.collectionSchema.name,
                    validatedDoc,
                    update._id,
                    this.collectionSchema.constrainedFields,
                    this.collectionSchema.schema,
                    undefined,
                    this.docBindSql
                );
                sqlStatements.push({ sql, params });

                vectorQueries.push(
                    ...SQLTranslator.buildVectorUpdateQueries(
                        this.collectionSchema.name,
                        validatedDoc,
                        update._id,
                        this.collectionSchema.constrainedFields
                    )
                );
            }

            const shouldManageTransaction = this.tryBeginTransactionSync();
            try {
                for (const statement of sqlStatements) {
                    this.driver.execSync(statement.sql, statement.params);
                }
                this.executeVectorQueriesSync(vectorQueries);
                if (shouldManageTransaction) {
                    this.driver.execSync('COMMIT', []);
                }
            } catch (error) {
                if (shouldManageTransaction) {
                    this.driver.execSync('ROLLBACK', []);
                }
                throw error;
            }

            this.pluginManager?.executeHookSync('onAfterUpdate', { ...context, result: validatedDocs });
            return validatedDocs;
        } catch (error) {
            this.pluginManager?.executeHookSync('onError', { ...context, error: error as Error });
            this.handleSQLConstraintError(error);
        }
    }

    // Add count and first methods to Collection (async by default)
    async count(): Promise<number> {
        const sql = `SELECT COUNT(*) as count FROM ${this.collectionSchema.name}`;
        const result = await this.driver.query(sql, []);
        return result[0].count;
    }

    async first(): Promise<InferSchema<T> | null> {
        const { sql, params } = SQLTranslator.buildSelectQuery(
            this.collectionSchema.name,
            { filters: [], limit: 1 },
            this.collectionSchema.constrainedFields
        );
        const rows = await this.driver.query(sql, params);
        return rows.length > 0 ? parseDoc(rows[0].doc) : null;
    }

    /**
     * Perform vector similarity search
     */
    /** @internal Use `vector.search()` instead */
    async vectorSearch(
        options: VectorSearchOptions
    ): Promise<VectorSearchResult<InferSchema<T>>[]> {
        await this.ensureInitialized();

        // Validate that the field is a vector field
        if (
            !this.collectionSchema.constrainedFields ||
            !this.collectionSchema.constrainedFields[options.field]
        ) {
            throw new ValidationError(
                `Field '${options.field}' is not defined as a constrained field`
            );
        }

        const fieldDef = this.collectionSchema.constrainedFields[options.field];
        if (fieldDef.type !== 'VECTOR') {
            throw new ValidationError(
                `Field '${options.field}' is not a vector field`
            );
        }

        if (
            !fieldDef.vectorDimensions ||
            !Array.isArray(options.vector) ||
            options.vector.length !== fieldDef.vectorDimensions
        ) {
            throw new ValidationError(
                `Query vector must have ${fieldDef.vectorDimensions} dimensions`
            );
        }

        // Plugin hook: before vector search
        const context = {
            collectionName: this.collectionSchema.name,
            schema: this.collectionSchema,
            operation: 'vectorSearch',
            data: options,
        };
        await this.pluginManager?.executeHookSafe('onBeforeQuery', context);

        const vectorTableName = SchemaSQLGenerator.getVectorTableName(
            this.collectionSchema.name,
            options.field
        );
        const columnName = fieldPathToColumnName(options.field);
        const limit = options.limit || 10;
        const distance = options.distance || 'cosine';

        // Build vector search query using sqlite-vec format
        let sql = `
            SELECT 
                ${this.collectionSchema.name}._id,
                ${this.collectionSchema.name}.doc,
                ${vectorTableName}.distance
            FROM ${vectorTableName}
            INNER JOIN ${this.collectionSchema.name} ON ${vectorTableName}.rowid = ${this.collectionSchema.name}.rowid
            WHERE ${vectorTableName}.${columnName} MATCH ?
                AND k = ?
        `;

        // Convert query vector to Float32Array for sqlite-vec, compatible with better-sqlite3
        const queryVectorArray = new Float32Array(options.vector);
        const params: any[] = [
            Buffer.from(
                queryVectorArray.buffer,
                queryVectorArray.byteOffset,
                queryVectorArray.byteLength
            ),
            limit,
        ];

        // Add additional WHERE conditions if provided
        if (options.where && options.where.length > 0) {
            const { whereClause, whereParams } = SQLTranslator.buildWhereClause(
                options.where,
                'AND',
                this.collectionSchema.constrainedFields,
                this.collectionSchema.name
            );
            sql += ` AND ${whereClause}`;
            params.push(...whereParams);
        }

        sql += ` ORDER BY ${vectorTableName}.distance ASC`;

        try {
            const rows = await this.driver.query(sql, params);
            const results: VectorSearchResult<InferSchema<T>>[] = rows.map(
                (row) => ({
                    document: parseDoc(row.doc),
                    distance: row.distance as number,
                    _id: row._id as string,
                })
            );

            // Plugin hook: after vector search
            const resultContext = {
                ...context,
                result: results,
            };
            await this.pluginManager?.executeHookSafe(
                'onAfterQuery',
                resultContext
            );

            return results;
        } catch (error) {
            const errorContext = { ...context, error: error as Error };
            await this.pluginManager?.executeHookSafe('onError', errorContext);

            // If vector search fails due to missing extension, throw a helpful error
            if (isVectorExtensionError(error)) {
                throw new ValidationError(
                    `Vector search functionality is not available. The sqlite-vec extension is not loaded. ` +
                        `Install SQLite with extension support for vector operations.`
                );
            }

            throw error;
        }
    }

    /**
     * Rebuild indexes and repair any inconsistencies between JSON documents and constrained columns
     * Useful for recovering from data corruption or migrating data
     */
    /** @internal Use `indexes.rebuild()` instead */
    async rebuildIndexes(): Promise<{ scanned: number; fixed: number; errors: string[] }> {
        await this.ensureInitialized();

        const errors: string[] = [];
        let scanned = 0;
        let fixed = 0;

        // If no constrained fields, nothing to rebuild
        if (!this.collectionSchema.constrainedFields || Object.keys(this.collectionSchema.constrainedFields).length === 0) {
            return { scanned, fixed, errors: ['No constrained fields to rebuild'] };
        }

        try {
            // Use queryIterator to stream documents and avoid loading all into memory
            // Use json() to convert JSONB to TEXT
            const sql = `SELECT _id, json(doc) AS doc, _version FROM ${this.collectionSchema.name}`;

            // Use transaction for all fixes
            const shouldManageTransaction = await this.tryBeginTransaction();

            try {
                for await (const row of this.driver.queryIterator(sql, [])) {
                    scanned++;
                    try {
                        const doc = parseDoc(row.doc);
                        const _id = row._id;

                        // Extract constrained values from JSON
                        const constrainedValues = extractConstrainedValues(
                            doc,
                            this.collectionSchema.constrainedFields
                        );

                        // Build update query to sync constrained columns
                        const setClauses: string[] = [];
                        const params: any[] = [];

                        let needsUpdate = false;

                        for (const [fieldPath, fieldDef] of Object.entries(this.collectionSchema.constrainedFields)) {
                            const columnName = fieldPathToColumnName(fieldPath);
                            const jsonValue = constrainedValues[fieldPath];

                            // Check current column value
                            const checkSql = `SELECT ${columnName} FROM ${this.collectionSchema.name} WHERE _id = ?`;
                            const checkResult = await this.driver.query(checkSql, [_id]);
                            const currentValue = checkResult[0]?.[columnName];

                            // Convert for comparison
                            const zodType = this.collectionSchema.schema
                                ? getZodTypeForPath(this.collectionSchema.schema, fieldPath)
                                : null;
                            const sqliteType = zodType
                                ? inferSQLiteType(zodType, fieldDef)
                                : 'TEXT';
                            const expectedValue = convertValueForStorage(jsonValue, sqliteType);

                            // Check if values differ
                            const normalizedCurrent =
                                currentValue === null || currentValue === undefined
                                    ? null
                                    : typeof currentValue === 'object'
                                      ? JSON.stringify(currentValue)
                                      : String(currentValue);
                            const normalizedExpected =
                                expectedValue === null || expectedValue === undefined
                                    ? null
                                    : typeof expectedValue === 'object'
                                      ? JSON.stringify(expectedValue)
                                      : String(expectedValue);

                            if (normalizedCurrent !== normalizedExpected) {
                                needsUpdate = true;
                                setClauses.push(`${columnName} = ?`);
                                params.push(expectedValue);
                            }
                        }

                        if (needsUpdate) {
                            params.push(_id);
                            const updateSql = `UPDATE ${this.collectionSchema.name} SET ${setClauses.join(', ')} WHERE _id = ?`;
                            await this.driver.exec(updateSql, params);
                            fixed++;
                        }

                        // Rebuild vector indexes if present
                        const vectorQueries = SQLTranslator.buildVectorUpdateQueries(
                            this.collectionSchema.name,
                            doc,
                            _id,
                            this.collectionSchema.constrainedFields
                        );
                        await this.executeVectorQueries(vectorQueries);

                    } catch (error) {
                        errors.push(`Error rebuilding document ${row._id}: ${error instanceof Error ? error.message : String(error)}`);
                    }
                }

                if (shouldManageTransaction) {
                    await this.driver.exec('COMMIT', []);
                }
            } catch (error) {
                if (shouldManageTransaction) {
                    await this.driver.exec('ROLLBACK', []);
                }
                throw error;
            }

            return { scanned, fixed, errors };
        } catch (error) {
            throw new Error(`Failed to rebuild indexes: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Sync version for rebuildIndexes
     */
    /** @internal Use `sync.rebuildIndexes()` or `indexes.rebuild()` */
    rebuildIndexesSync(): { scanned: number; fixed: number; errors: string[] } {
        const errors: string[] = [];
        let scanned = 0;
        let fixed = 0;

        // If no constrained fields, nothing to rebuild
        if (!this.collectionSchema.constrainedFields || Object.keys(this.collectionSchema.constrainedFields).length === 0) {
            return { scanned, fixed, errors: ['No constrained fields to rebuild'] };
        }

        try {
            // Get all documents
            // Use json() to convert JSONB to TEXT
            const sql = `SELECT _id, json(doc) AS doc, _version FROM ${this.collectionSchema.name}`;
            const rows = this.driver.querySync(sql, []);
            scanned = rows.length;

            // Use transaction for all fixes
            const shouldManageTransaction = this.tryBeginTransactionSync();

            try {
                for (const row of rows) {
                    try {
                        const doc = parseDoc(row.doc);
                        const _id = row._id;

                        // Extract constrained values from JSON
                        const constrainedValues = extractConstrainedValues(
                            doc,
                            this.collectionSchema.constrainedFields
                        );

                        // Build update query to sync constrained columns
                        const setClauses: string[] = [];
                        const params: any[] = [];

                        let needsUpdate = false;

                        for (const [fieldPath, fieldDef] of Object.entries(this.collectionSchema.constrainedFields)) {
                            const columnName = fieldPathToColumnName(fieldPath);
                            const jsonValue = constrainedValues[fieldPath];

                            // Check current column value
                            const checkSql = `SELECT ${columnName} FROM ${this.collectionSchema.name} WHERE _id = ?`;
                            const checkResult = this.driver.querySync(checkSql, [_id]);
                            const currentValue = checkResult[0]?.[columnName];

                            // Convert for comparison
                            const zodType = this.collectionSchema.schema
                                ? getZodTypeForPath(this.collectionSchema.schema, fieldPath)
                                : null;
                            const sqliteType = zodType
                                ? inferSQLiteType(zodType, fieldDef)
                                : 'TEXT';
                            const expectedValue = convertValueForStorage(jsonValue, sqliteType);

                            // Check if values differ (normalized comparison)
                            const normalizedCurrent =
                                currentValue === null || currentValue === undefined
                                    ? null
                                    : typeof currentValue === 'object'
                                      ? JSON.stringify(currentValue)
                                      : String(currentValue);
                            const normalizedExpected =
                                expectedValue === null || expectedValue === undefined
                                    ? null
                                    : typeof expectedValue === 'object'
                                      ? JSON.stringify(expectedValue)
                                      : String(expectedValue);

                            if (normalizedCurrent !== normalizedExpected) {
                                needsUpdate = true;
                                setClauses.push(`${columnName} = ?`);
                                params.push(expectedValue);
                            }
                        }

                        if (needsUpdate) {
                            params.push(_id);
                            const updateSql = `UPDATE ${this.collectionSchema.name} SET ${setClauses.join(', ')} WHERE _id = ?`;
                            this.driver.execSync(updateSql, params);
                            fixed++;
                        }

                        // Rebuild vector indexes if present
                        const vectorQueries = SQLTranslator.buildVectorUpdateQueries(
                            this.collectionSchema.name,
                            doc,
                            _id,
                            this.collectionSchema.constrainedFields
                        );
                        this.executeVectorQueriesSync(vectorQueries);

                    } catch (error) {
                        errors.push(`Error rebuilding document ${row._id}: ${error instanceof Error ? error.message : String(error)}`);
                    }
                }

                if (shouldManageTransaction) {
                    this.driver.execSync('COMMIT', []);
                }
            } catch (error) {
                if (shouldManageTransaction) {
                    this.driver.execSync('ROLLBACK', []);
                }
                throw error;
            }

            return { scanned, fixed, errors };
        } catch (error) {
            throw new Error(`Failed to rebuild indexes: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
