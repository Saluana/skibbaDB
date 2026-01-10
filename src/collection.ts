import { z } from 'zod';
import type {
    Driver,
    CollectionSchema,
    InferSchema,
    VectorSearchOptions,
    VectorSearchResult,
} from './types';
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
} from './errors.js';
import {
    parseDoc,
    mergeConstrainedFields,
    reconstructNestedObject,
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

export class Collection<T extends z.ZodSchema> {
    private driver: Driver;
    private collectionSchema: CollectionSchema<InferSchema<T>>;
    private pluginManager?: PluginManager;
    private database?: any; // Reference to the Database instance
    private allowSyncWithPlugins: boolean;

    private isInitialized = false;
    private initializationPromise?: Promise<void>;
    private initializationError?: Error; // Store initialization errors for explicit propagation
    
    // PERF: Cache migrated collections to skip redundant migration checks
    private static migratedCollections = new Set<string>();

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
        this.createTable();
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
                    // If vector table creation fails, log warning but continue
                    if (
                        error instanceof Error &&
                        (error.message.includes('vec0') ||
                            error.message.includes('no such module'))
                    ) {
                        console.warn(
                            `Warning: Vector table creation failed (extension not available): ${error.message}. Vector search functionality will be disabled.`
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
        const migrator = new Migrator(this.driver);

        try {
            await migrator.checkAndRunMigration(
                this.collectionSchema,
                this,
                this.database
            );
        } catch (error) {
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
                    // If vector table creation fails, log warning but continue
                    if (
                        error instanceof Error &&
                        (error.message.includes('vec0') ||
                            error.message.includes('no such module'))
                    ) {
                        console.warn(
                            `Warning: Vector table creation failed (extension not available): ${error.message}. Vector search functionality will be disabled.`
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
        // PERF: Skip migration check if already performed for this collection+version
        // Include database instance reference to avoid cross-database caching issues
        const dbId = this.database?._dbId || 'default';
        const migrationKey = `${dbId}_${this.collectionSchema.name}_v${this.collectionSchema.version || 1}`;
        if (Collection.migratedCollections.has(migrationKey)) {
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
            Collection.migratedCollections.add(migrationKey);
        } catch (error) {
            // Check if this is an upgrade function error that should be handled gracefully
            if (
                error instanceof Error &&
                (error.message.includes('Custom upgrade') ||
                    error.message.includes('UPGRADE_FUNCTION_FAILED'))
            ) {
                // Store upgrade function error for explicit propagation via waitForInitialization()
                // but don't throw to avoid unhandled rejections during background initialization
                this.initializationError = error;
                console.error(
                    `Upgrade function failed for collection '${this.collectionSchema.name}':`,
                    error.message
                );
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
        if (!this.isInitialized && this.initializationPromise) {
            await this.initializationPromise;
        }
    }

    // Method for tests to wait for full initialization including migrations
    async waitForInitialization(): Promise<void> {
        if (this.initializationPromise) {
            await this.initializationPromise;
        }
        // If there was an initialization error (e.g., upgrade function failure),
        // throw it now for explicit error handling in tests
        if (this.initializationError) {
            throw this.initializationError;
        }
    }

    private validateDocument(doc: any): InferSchema<T> {
        try {
            return this.collectionSchema.schema.parse(doc);
        } catch (error) {
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
        // Check if driver is already in a transaction (more reliable than catching errors)
        if (this.driver.isInTransaction || this.driver.savepointStack?.length) {
            return false;  // Already in transaction, don't start a new one
        }
        
        try {
            await this.driver.exec('BEGIN IMMEDIATE TRANSACTION', []);
            return true;
        } catch (error) {
            // Fallback: If we're already in a transaction, proceed without starting a new one
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
        // Check if driver is already in a transaction (more reliable than catching errors)
        if (this.driver.isInTransaction || this.driver.savepointStack?.length) {
            return false;  // Already in transaction, don't start a new one
        }
        
        try {
            this.driver.execSync('BEGIN IMMEDIATE TRANSACTION', []);
            return true;
        } catch (error) {
            // Fallback: If we're already in a transaction, proceed without starting a new one
            if (error instanceof Error && error.message.includes('transaction within a transaction')) {
                return false;
            }
            throw error;
        }
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

        throw error;
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
                // If vector operations fail, log warning but continue
                if (
                    error instanceof Error &&
                    (error.message.includes('vec0') ||
                        error.message.includes('no such module') ||
                        error.message.includes('no such table'))
                ) {
                    console.warn(
                        `Warning: Vector operation failed (extension not available): ${error.message}. Vector search functionality will be disabled for this field.`
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
                if (
                    error instanceof Error &&
                    (error.message.includes('vec0') ||
                        error.message.includes('no such module') ||
                        error.message.includes('no such table'))
                ) {
                    console.warn(
                        `Warning: Vector operation failed (extension not available): ${error.message}. Vector search functionality will be disabled for this field.`
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

    private generateId(): string {
        return crypto.randomUUID();
    }

    async insert(doc: Omit<InferSchema<T>, '_id'>): Promise<InferSchema<T>> {
        await this.ensureInitialized();

        const context = this.createPluginContext('insert', doc);
        await this.pluginManager?.executeHookSafe('onBeforeInsert', context);

        try {
            const docWithPossibleId = doc as any;
            let _id: string;

            if (docWithPossibleId._id) {
                _id = docWithPossibleId._id;
                const existing = await this.findById(_id);
                if (existing) {
                    throw new UniqueConstraintError(
                        `Document with _id '${_id}' already exists`,
                        '_id'
                    );
                }
            } else {
                _id = this.generateId();
            }

            const fullDoc = { ...doc, _id };
            const validatedDoc = this.validateDocument(fullDoc);

            const { sql, params } = SQLTranslator.buildInsertQuery(
                this.collectionSchema.name,
                validatedDoc,
                _id,
                this.collectionSchema.constrainedFields,
                this.collectionSchema.schema
            );
            await this.driver.exec(sql, params);

            const vectorQueries = SQLTranslator.buildVectorInsertQueries(
                this.collectionSchema.name,
                validatedDoc,
                _id,
                this.collectionSchema.constrainedFields
            );
            await this.executeVectorQueries(vectorQueries);

            // PERF: Set _version directly instead of fetching from DB
            // New documents always start at version 1 (set by DEFAULT in schema)
            const result = { ...validatedDoc };
            (result as any)._version = 1;

            await this.pluginManager?.executeHookSafe('onAfterInsert', { ...context, result });
            return result;
        } catch (error) {
            await this.pluginManager?.executeHookSafe('onError', { ...context, error: error as Error });
            this.handleSQLConstraintError(error, (doc as any)._id || 'unknown');
        }
    }

    async insertBulk(
        docs: Omit<InferSchema<T>, '_id'>[]
    ): Promise<InferSchema<T>[]> {
        await this.ensureInitialized();
        if (docs.length === 0) return [];

        const context = this.createPluginContext('insertBulk', docs);
        await this.pluginManager?.executeHookSafe('onBeforeInsert', context);

        try {
            // Use driver.transaction for proper nested transaction handling with SAVEPOINTs
            const validatedDocs = await this.driver.transaction(async () => {
                // Batch existence check for explicit IDs
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

                const validatedDocs: InferSchema<T>[] = [];
                const sqlParts: string[] = [];
                const allParams: any[] = [];

                for (const doc of docs) {
                    const _id = (doc as any)._id || this.generateId();
                    const fullDoc = { ...doc, _id };
                    const validatedDoc = this.validateDocument(fullDoc);
                    validatedDocs.push(validatedDoc);

                    const { sql, params } = SQLTranslator.buildInsertQuery(
                        this.collectionSchema.name,
                        validatedDoc,
                        _id,
                        this.collectionSchema.constrainedFields,
                        this.collectionSchema.schema
                    );

                    sqlParts.push(sql.substring(sql.indexOf('VALUES ') + 7));
                    allParams.push(...params);
                }

                const firstQuery = SQLTranslator.buildInsertQuery(
                    this.collectionSchema.name,
                    validatedDocs[0],
                    (validatedDocs[0] as any)._id,
                    this.collectionSchema.constrainedFields,
                    this.collectionSchema.schema
                );
                const baseSQL = firstQuery.sql.substring(0, firstQuery.sql.indexOf('VALUES ') + 7);
                
                await this.driver.exec(baseSQL + sqlParts.join(', '), allParams);

                // Handle vector insertions within the same transaction
                for (const validatedDoc of validatedDocs) {
                    const vectorQueries = SQLTranslator.buildVectorInsertQueries(
                        this.collectionSchema.name,
                        validatedDoc,
                        (validatedDoc as any)._id,
                        this.collectionSchema.constrainedFields
                    );
                    await this.executeVectorQueries(vectorQueries);
                }
                
                return validatedDocs;
            });

            await this.pluginManager?.executeHookSafe('onAfterInsert', { ...context, result: validatedDocs });
            return validatedDocs;
        } catch (error) {
            await this.pluginManager?.executeHookSafe('onError', { ...context, error: error as Error });
            this.handleSQLConstraintError(error);
        }
    }

    async put(
        _id: string,
        doc: Partial<InferSchema<T>>
    ): Promise<InferSchema<T>> {
        await this.ensureInitialized();
        
        // CRITICAL FIX: Wrap read-modify-write in BEGIN IMMEDIATE transaction
        // to prevent race conditions where concurrent updates overwrite each other
        const shouldManageTransaction = await this.tryBeginTransaction();
        
        try {
            const existing = await this.findById(_id);
            if (!existing) {
                if (shouldManageTransaction) {
                    await this.driver.exec('ROLLBACK', []);
                }
                throw new NotFoundError('Document not found', _id);
            }

            const currentVersion = (existing as any)._version || 1;

            const updatedDoc = { ...existing, ...doc, _id };
            const validatedDoc = this.validateDocument(updatedDoc);

            const context = this.createPluginContext('update', validatedDoc);
            await this.pluginManager?.executeHookSafe('onBeforeUpdate', context);

            // Pass expectedVersion for optimistic concurrency check
            const { sql, params } = SQLTranslator.buildUpdateQuery(
                this.collectionSchema.name,
                validatedDoc,
                _id,
                this.collectionSchema.constrainedFields,
                this.collectionSchema.schema,
                currentVersion
            );
            
            await this.driver.exec(sql, params);

            // Check if update actually happened (version matched)
            // Note: Safe to use changes() here because we're in a transaction (BEGIN IMMEDIATE),
            // so no other statements can execute between UPDATE and this SELECT
            const checkSql = `SELECT changes() as affected`;
            const checkResult = await this.driver.query(checkSql, []);
            const affected = checkResult[0]?.affected || 0;

            if (affected === 0) {
                if (shouldManageTransaction) {
                    await this.driver.exec('ROLLBACK', []);
                }
                // Document was modified by another transaction
                const latest = await this.findById(_id);
                const latestVersion = (latest as any)?._version || 1;
                throw new VersionMismatchError(
                    `Version mismatch: expected ${currentVersion}, got ${latestVersion}`,
                    _id,
                    currentVersion,
                    latestVersion
                );
            }

            const vectorQueries = SQLTranslator.buildVectorUpdateQueries(
                this.collectionSchema.name,
                validatedDoc,
                _id,
                this.collectionSchema.constrainedFields
            );
            await this.executeVectorQueries(vectorQueries);

            if (shouldManageTransaction) {
                await this.driver.exec('COMMIT', []);
            }

            // PERF: Set _version directly instead of fetching from DB
            // We know it will be incremented by 1 from the UPDATE query
            const result = { ...validatedDoc };
            (result as any)._version = currentVersion + 1;

            await this.pluginManager?.executeHookSafe('onAfterUpdate', { ...context, result });
            return result;
        } catch (error) {
            if (shouldManageTransaction) {
                await this.driver.exec('ROLLBACK', []);
            }
            throw error;
        }
    }

    /**
     * Atomic update using operators like $inc, $set, $push
     * Avoids read-before-write race conditions
     */
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

            await this.driver.exec(sql, params);

            // Check if any rows were affected (for version mismatch detection)
            const checkSql = `SELECT changes() as affected`;
            const checkResult = await this.driver.query(checkSql, []);
            const affected = checkResult[0]?.affected || 0;

            if (affected === 0) {
                // Either document doesn't exist or version mismatch
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
            }

            // Fetch updated document
            const updated = await this.findById(_id);
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

        this.driver.execSync(sql, params);

        // Check if any rows were affected (for version mismatch detection)
        const checkSql = `SELECT changes() as affected`;
        const checkResult = this.driver.querySync(checkSql, []);
        const affected = checkResult[0]?.affected || 0;

        if (affected === 0) {
            // Either document doesn't exist or version mismatch
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
        }

        // Fetch updated document
        const updated = this.findByIdSync(_id);
        if (!updated) {
            throw new NotFoundError('Document not found after update', _id);
        }

        return updated;
    }

    async putBulk(
        updates: { _id: string; doc: Partial<InferSchema<T>> }[]
    ): Promise<InferSchema<T>[]> {
        if (updates.length === 0) return [];

        const context = this.createPluginContext('putBulk', updates);
        await this.pluginManager?.executeHookSafe('onBeforeUpdate', context);

        try {
            // Use driver.transaction for proper nested transaction handling with SAVEPOINTs
            const validatedDocs = await this.driver.transaction(async () => {
                const validatedDocs: InferSchema<T>[] = [];
                const sqlStatements: { sql: string; params: any[] }[] = [];
                const vectorQueries: { sql: string; params: any[] }[] = [];

                for (const update of updates) {
                    const existing = await this.findById(update._id);
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
                        this.collectionSchema.schema
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
        const context = this.createPluginContext('delete', { _id });
        await this.pluginManager?.executeHookSafe('onBeforeDelete', context);

        const { sql, params } = SQLTranslator.buildDeleteQuery(this.collectionSchema.name, _id);
        await this.driver.exec(sql, params);

        const vectorQueries = SQLTranslator.buildVectorDeleteQueries(
            this.collectionSchema.name,
            _id,
            this.collectionSchema.constrainedFields
        );
        await this.executeVectorQueries(vectorQueries);

        await this.pluginManager?.executeHookSafe('onAfterDelete', { ...context, result: { _id, deleted: true } });
        return true;
    }

    async deleteBulk(ids: string[]): Promise<number> {
        if (ids.length === 0) return 0;

        // Use driver.transaction for proper nested transaction handling with SAVEPOINTs
        return await this.driver.transaction(async () => {
            let count = 0;
            for (const _id of ids) {
                if (await this.delete(_id)) count++;
            }
            return count;
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
        const fullDoc = { ...doc, _id };
        const validatedDoc = this.validateDocument(fullDoc);

        try {
            const shouldManageTransaction = await this.tryBeginTransaction();
            const hasConstrainedFields =
                this.collectionSchema.constrainedFields &&
                Object.keys(this.collectionSchema.constrainedFields).length > 0;

            try {
                if (!hasConstrainedFields) {
                    // CRITICAL FIX: Use ON CONFLICT instead of INSERT OR REPLACE
                    // This preserves _version counter for optimistic concurrency control
                    const sql = `
                        INSERT INTO ${this.collectionSchema.name} (_id, doc, _version)
                        VALUES (?, ?, 1)
                        ON CONFLICT(_id) DO UPDATE SET
                            doc = excluded.doc,
                            _version = _version + 1
                    `;
                    await this.driver.exec(sql, [_id, JSON.stringify(validatedDoc)]);
                } else {
                    // For constrained fields, build proper ON CONFLICT with all columns
                    const { sql, params } = SQLTranslator.buildUpsertQuery(
                        this.collectionSchema.name,
                        validatedDoc,
                        _id,
                        this.collectionSchema.constrainedFields,
                        this.collectionSchema.schema
                    );
                    await this.driver.exec(sql, params);
                }

                const vectorQueries = SQLTranslator.buildVectorInsertQueries(
                    this.collectionSchema.name,
                    validatedDoc,
                    _id,
                    this.collectionSchema.constrainedFields
                );
                await this.executeVectorQueries(vectorQueries);

                if (shouldManageTransaction) {
                    await this.driver.exec('COMMIT', []);
                }

                return validatedDoc;
            } catch (error) {
                if (shouldManageTransaction) {
                    await this.driver.exec('ROLLBACK', []);
                }
                throw error;
            }
        } catch (error) {
            this.handleSQLConstraintError(error, _id);
        }
    }

    /**
     * Bulk upsert operation
     * CRITICAL FIX: Use individual upserts to preserve _version counters
     */
    async upsertBulk(
        updates: { _id: string; doc: Omit<InferSchema<T>, '_id'> }[]
    ): Promise<InferSchema<T>[]> {
        if (updates.length === 0) return [];

        const context = this.createPluginContext('upsertBulk', updates);
        await this.pluginManager?.executeHookSafe('onBeforeInsert', context);

        try {
            // CRITICAL FIX: Use individual upserts instead of batch INSERT OR REPLACE
            // to preserve _version counters for optimistic concurrency control
            const results = await this.driver.transaction(async () => {
                const upsertedDocs: InferSchema<T>[] = [];
                for (const update of updates) {
                    const result = await this.upsert(update._id, update.doc);
                    upsertedDocs.push(result);
                }
                return upsertedDocs;
            });
            
            await this.pluginManager?.executeHookSafe('onAfterInsert', { ...context, result: results });
            return results;
        } catch (error) {
            await this.pluginManager?.executeHookSafe('onError', { ...context, error: error as Error });
            this.handleSQLConstraintError(error);
        }
    }

    async findById(_id: string): Promise<InferSchema<T> | null> {
        await this.ensureInitialized();

        if (
            !this.collectionSchema.constrainedFields ||
            Object.keys(this.collectionSchema.constrainedFields).length === 0
        ) {
            // Use json() to convert JSONB to TEXT
            const sql = `SELECT json(doc) AS doc, _version FROM ${this.collectionSchema.name} WHERE _id = ?`;
            const params = [_id];
            const rows = await this.driver.query(sql, params);
            if (rows.length === 0) return null;
            const doc = parseDoc(rows[0].doc);
            (doc as any)._version = rows[0]._version;
            return doc;
        }

        const constrainedFieldColumns = Object.keys(
            this.collectionSchema.constrainedFields
        )
            .map((f) => fieldPathToColumnName(f))
            .join(', ');
        // Use json() to convert JSONB to TEXT
        const sql = `SELECT json(doc) AS doc, _version, ${constrainedFieldColumns} FROM ${this.collectionSchema.name} WHERE _id = ?`;
        const params = [_id];
        const rows = await this.driver.query(sql, params);
        if (rows.length === 0) return null;
        const doc = mergeConstrainedFields(
            rows[0],
            this.collectionSchema.constrainedFields
        );
        (doc as any)._version = rows[0]._version;
        return doc;
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

        // Only validate if we successfully extracted field names
        if (validFields.length > 0 && !validFields.includes(fieldName)) {
            throw new ValidationError(
                `Field '${fieldName}' does not exist in schema. Valid fields: ${validFields.join(
                    ', '
                )}`
            );
        }

        // If we can't determine valid fields, don't validate (backward compatibility)
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
        // Validate field name exists in schema
        this.validateFieldName(field as string);

        const builder = new QueryBuilder<InferSchema<T>>();
        (builder as any).collection = this;
        const fieldBuilder = builder.where(field as K);
        (fieldBuilder as any).collection = this;
        return fieldBuilder as import('./query-builder.js').FieldBuilder<
            InferSchema<T>,
            K
        > & { collection: Collection<T> };
    }

    // Query method that returns a QueryBuilder for complex queries
    query(): QueryBuilder<InferSchema<T>> {
        const builder = new QueryBuilder<InferSchema<T>>();
        (builder as any).collection = this;
        return builder;
    }

    // Direct query methods without conditions
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
        const results = rows.map((row) => parseDoc(row.doc));

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
            yield parseDoc(row.doc);
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
        // Validate field name exists in schema
        this.validateFieldName(field as string);

        const builder = new QueryBuilder<InferSchema<T>>();
        (builder as any).collection = this;
        return builder.orderBy(field as K, direction);
    }

    limit(count: number): QueryBuilder<InferSchema<T>> {
        const builder = new QueryBuilder<InferSchema<T>>();
        (builder as any).collection = this;
        return builder.limit(count);
    }

    offset(count: number): QueryBuilder<InferSchema<T>> {
        const builder = new QueryBuilder<InferSchema<T>>();
        (builder as any).collection = this;
        return builder.offset(count);
    }

    page(pageNumber: number, pageSize: number): QueryBuilder<InferSchema<T>> {
        const builder = new QueryBuilder<InferSchema<T>>();
        (builder as any).collection = this;
        return builder.page(pageNumber, pageSize);
    }

    distinct(): QueryBuilder<InferSchema<T>> {
        const builder = new QueryBuilder<InferSchema<T>>();
        (builder as any).collection = this;
        return builder.distinct();
    }

    orderByMultiple(
        orders: { field: keyof InferSchema<T>; direction?: 'asc' | 'desc' }[]
    ): QueryBuilder<InferSchema<T>> {
        const builder = new QueryBuilder<InferSchema<T>>();
        (builder as any).collection = this;
        return builder.orderByMultiple(orders);
    }

    or(
        builderFn: (
            builder: QueryBuilder<InferSchema<T>>
        ) => QueryBuilder<InferSchema<T>>
    ): QueryBuilder<InferSchema<T>> {
        const builder = new QueryBuilder<InferSchema<T>>();
        (builder as any).collection = this;
        return builder.or(builderFn);
    }

    // Async versions of direct collection query methods
    async orderByAsync<K extends OrderablePaths<InferSchema<T>>>(
        field: K | string,
        direction: 'asc' | 'desc' = 'asc'
    ): Promise<QueryBuilder<InferSchema<T>>> {
        const builder = new QueryBuilder<InferSchema<T>>();
        (builder as any).collection = this;
        return builder.orderBy(field as K, direction);
    }

    async limitAsync(count: number): Promise<QueryBuilder<InferSchema<T>>> {
        const builder = new QueryBuilder<InferSchema<T>>();
        (builder as any).collection = this;
        return builder.limit(count);
    }

    async offsetAsync(count: number): Promise<QueryBuilder<InferSchema<T>>> {
        const builder = new QueryBuilder<InferSchema<T>>();
        (builder as any).collection = this;
        return builder.offset(count);
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
    insertSync(doc: Omit<InferSchema<T>, '_id'>): InferSchema<T> {
        this.assertSyncPluginsAllowed('insert');
        const context = this.createPluginContext('insert', doc);
        this.pluginManager?.executeHookSync('onBeforeInsert', context);

        try {
            const docWithPossibleId = doc as any;
            let _id: string;

            if (docWithPossibleId._id) {
                _id = docWithPossibleId._id;
                if (this.findByIdSync(_id)) {
                    throw new UniqueConstraintError(`Document with _id '${_id}' already exists`, '_id');
                }
            } else {
                _id = this.generateId();
            }

            const fullDoc = { ...doc, _id };
            const validatedDoc = this.validateDocument(fullDoc);

            const { sql, params } = SQLTranslator.buildInsertQuery(
                this.collectionSchema.name,
                validatedDoc,
                _id,
                this.collectionSchema.constrainedFields,
                this.collectionSchema.schema
            );
            this.driver.execSync(sql, params);

            const vectorQueries = SQLTranslator.buildVectorInsertQueries(
                this.collectionSchema.name,
                validatedDoc,
                _id,
                this.collectionSchema.constrainedFields
            );
            this.executeVectorQueriesSync(vectorQueries);

            // PERF: Set _version directly instead of fetching from DB
            // New documents always start at version 1 (set by DEFAULT in schema)
            const result = { ...validatedDoc };
            (result as any)._version = 1;

            this.pluginManager?.executeHookSync('onAfterInsert', { ...context, result });
            return result;
        } catch (error) {
            this.pluginManager?.executeHookSync('onError', { ...context, error: error as Error });
            this.handleSQLConstraintError(error, (doc as any)._id || 'unknown');
        }
    }

    /**
     * @deprecated Sync operations are not supported with plugins; use async methods instead.
     */
    insertBulkSync(docs: Omit<InferSchema<T>, '_id'>[]): InferSchema<T>[] {
        if (docs.length === 0) return [];

        this.assertSyncPluginsAllowed('insertBulk');
        const context = this.createPluginContext('insertBulk', docs);
        this.pluginManager?.executeHookSync('onBeforeInsert', context);

        try {
            const validatedDocs: InferSchema<T>[] = [];
            const sqlParts: string[] = [];
            const allParams: any[] = [];
            const vectorQueries: { sql: string; params: any[] }[] = [];

            for (const doc of docs) {
                const _id = (doc as any)._id || this.generateId();
                if ((doc as any)._id && this.findByIdSync(_id)) {
                    throw new UniqueConstraintError(`Document with _id '${_id}' already exists`, '_id');
                }

                const fullDoc = { ...doc, _id };
                const validatedDoc = this.validateDocument(fullDoc);
                validatedDocs.push(validatedDoc);

                const { sql, params } = SQLTranslator.buildInsertQuery(
                    this.collectionSchema.name,
                    validatedDoc,
                    _id,
                    this.collectionSchema.constrainedFields,
                    this.collectionSchema.schema
                );
                sqlParts.push(sql.substring(sql.indexOf('VALUES ') + 7));
                allParams.push(...params);

                vectorQueries.push(
                    ...SQLTranslator.buildVectorInsertQueries(
                        this.collectionSchema.name,
                        validatedDoc,
                        _id,
                        this.collectionSchema.constrainedFields
                    )
                );
            }

            const firstQuery = SQLTranslator.buildInsertQuery(
                this.collectionSchema.name,
                validatedDocs[0],
                (validatedDocs[0] as any)._id,
                this.collectionSchema.constrainedFields,
                this.collectionSchema.schema
            );
            const baseSQL = firstQuery.sql.substring(0, firstQuery.sql.indexOf('VALUES ') + 7);

            const shouldManageTransaction = this.tryBeginTransactionSync();
            try {
                this.driver.execSync(baseSQL + sqlParts.join(', '), allParams);
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

            this.pluginManager?.executeHookSync('onAfterInsert', { ...context, result: validatedDocs });
            return validatedDocs;
        } catch (error) {
            this.pluginManager?.executeHookSync('onError', { ...context, error: error as Error });
            this.handleSQLConstraintError(error);
        }
    }

    /**
     * @deprecated Sync operations are not supported with plugins; use async methods instead.
     */
    findByIdSync(_id: string): InferSchema<T> | null {
        if (
            !this.collectionSchema.constrainedFields ||
            Object.keys(this.collectionSchema.constrainedFields).length === 0
        ) {
            // Original behavior for collections without constrained fields
            // Use json() to convert JSONB to TEXT
            const sql = `SELECT json(doc) AS doc, _version FROM ${this.collectionSchema.name} WHERE _id = ?`;
            const params = [_id];
            const rows = this.driver.querySync(sql, params);
            if (rows.length === 0) return null;
            const doc = parseDoc(rows[0].doc);
            (doc as any)._version = rows[0]._version;
            return doc;
        }

        // For collections with constrained fields, select both doc and constrained columns
        const constrainedFieldColumns = Object.keys(
            this.collectionSchema.constrainedFields
        )
            .map((f) => fieldPathToColumnName(f))
            .join(', ');
        // Use json() to convert JSONB to TEXT
        const sql = `SELECT json(doc) AS doc, _version, ${constrainedFieldColumns} FROM ${this.collectionSchema.name} WHERE _id = ?`;
        const params = [_id];
        const rows = this.driver.querySync(sql, params);
        if (rows.length === 0) return null;
        const doc = mergeConstrainedFields(
            rows[0],
            this.collectionSchema.constrainedFields
        );
        (doc as any)._version = rows[0]._version;
        return doc;
    }

    /**
     * @deprecated Sync operations are not supported with plugins; use async methods instead.
     */
    toArraySync(): InferSchema<T>[] {
        const { sql, params } = SQLTranslator.buildSelectQuery(
            this.collectionSchema.name,
            { filters: [] },
            this.collectionSchema.constrainedFields
        );
        const rows = this.driver.querySync(sql, params);
        return rows.map((row) => parseDoc(row.doc));
    }

    /**
     * @deprecated Sync operations are not supported with plugins; use async methods instead.
     */
    countSync(): number {
        const sql = `SELECT COUNT(*) as count FROM ${this.collectionSchema.name}`;
        const result = this.driver.querySync(sql, []);
        return result[0].count;
    }

    /**
     * @deprecated Sync operations are not supported with plugins; use async methods instead.
     */
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
    putSync(_id: string, doc: Partial<InferSchema<T>>): InferSchema<T> {
        this.assertSyncPluginsAllowed('put');
        const existing = this.findByIdSync(_id);
        if (!existing) {
            throw new NotFoundError('Document not found', _id);
        }

        const currentVersion = (existing as any)._version || 1;

        const updatedDoc = { ...existing, ...doc, _id };
        const validatedDoc = this.validateDocument(updatedDoc);

        const context = this.createPluginContext('update', validatedDoc);
        this.pluginManager?.executeHookSync('onBeforeUpdate', context);

        const shouldManageTransaction = this.tryBeginTransactionSync();
        try {
            const { sql, params } = SQLTranslator.buildUpdateQuery(
                this.collectionSchema.name,
                validatedDoc,
                _id,
                this.collectionSchema.constrainedFields,
                this.collectionSchema.schema
            );
            this.driver.execSync(sql, params);

            const vectorQueries = SQLTranslator.buildVectorUpdateQueries(
                this.collectionSchema.name,
                validatedDoc,
                _id,
                this.collectionSchema.constrainedFields
            );
            this.executeVectorQueriesSync(vectorQueries);

            if (shouldManageTransaction) {
                this.driver.execSync('COMMIT', []);
            }

            // PERF: Set _version directly instead of fetching from DB
            // We know it will be incremented by 1 from the UPDATE query
            const result = { ...validatedDoc };
            (result as any)._version = currentVersion + 1;
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
    deleteBulkSync(ids: string[]): number {
        if (ids.length === 0) return 0;

        this.assertSyncPluginsAllowed('deleteBulk');
        const context = this.createPluginContext('deleteBulk', ids);
        this.pluginManager?.executeHookSync('onBeforeDelete', context);

        const shouldManageTransaction = this.tryBeginTransactionSync();
        try {
            let count = 0;
            for (const _id of ids) {
                const { sql, params } = SQLTranslator.buildDeleteQuery(this.collectionSchema.name, _id);
                this.driver.execSync(sql, params);
                const vectorQueries = SQLTranslator.buildVectorDeleteQueries(
                    this.collectionSchema.name,
                    _id,
                    this.collectionSchema.constrainedFields
                );
                this.executeVectorQueriesSync(vectorQueries);
                count++;
            }
            if (shouldManageTransaction) {
                this.driver.execSync('COMMIT', []);
            }
            this.pluginManager?.executeHookSync('onAfterDelete', { ...context, result: { deleted: count } });
            return count;
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
    upsertSync(_id: string, doc: Omit<InferSchema<T>, '_id'>): InferSchema<T> {
        this.assertSyncPluginsAllowed('upsert');
        try {
            const existing = this.findByIdSync(_id);
            return existing
                ? this.putSync(_id, doc as Partial<InferSchema<T>>)
                : this.insertSync({ ...doc, _id } as any);
        } catch (error) {
            this.handleSQLConstraintError(error, _id);
        }
    }

    /**
     * @deprecated Sync operations are not supported with plugins; use async methods instead.
     * CRITICAL FIX: Uses individual upserts to preserve _version counters
     */
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

            for (const update of updates) {
                const existing = this.findByIdSync(update._id);
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
                    this.collectionSchema.schema
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
        const params: any[] = [Buffer.from(queryVectorArray.buffer), limit];

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
            if (
                error instanceof Error &&
                (error.message.includes('vec0') ||
                    error.message.includes('no such module') ||
                    error.message.includes('no such table'))
            ) {
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
                            if (currentValue !== expectedValue) {
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

                            // Check if values differ
                            if (currentValue !== expectedValue) {
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

// Extend QueryBuilder to support collection operations
declare module './query-builder.js' {
    interface QueryBuilder<T> {
        // Default async methods
        toArray(): Promise<T[]>;
        exec(): Promise<T[]>; // Alias for toArray
        first(): Promise<T | null>;
        executeCount(): Promise<number>; // Renamed to avoid conflict with count aggregate method
        // Sync versions for backward compatibility
        toArraySync(): T[];
        firstSync(): T | null;
        countSync(): number;
    }

    interface FieldBuilder<T, K extends QueryablePaths<T> | string> {
        // Default async methods
        toArray(): Promise<T[]>;
        exec(): Promise<T[]>; // Alias for toArray
        first(): Promise<T | null>;
        executeCount(): Promise<number>;
        // Sync versions for backward compatibility
        toArraySync(): T[];
        firstSync(): T | null;
        countSync(): number;
    }
}

QueryBuilder.prototype.toArray = async function <T>(
    this: QueryBuilder<T> & { collection?: Collection<any> }
): Promise<T[]> {
    if (!this.collection)
        throw new Error('Collection not bound to query builder');

    const { sql, params } = SQLTranslator.buildSelectQuery(
        this.collection['collectionSchema'].name,
        this.getOptions(),
        this.collection['collectionSchema'].constrainedFields
    );
    const rows = await this.collection['driver'].query(sql, params);

    // Check if this is an aggregate query
    const options = this.getOptions();
    if (options.aggregates && options.aggregates.length > 0) {
        // For aggregate queries, return the raw results without parsing doc
        return rows as T[];
    }

    // Check if this is a JOIN query
    if (options.joins && options.joins.length > 0) {
        // For JOIN queries, merge data from multiple tables into JSON objects
        return rows.map((row) => {
            const mergedObject: any = {};

            // Parse the main table's doc if it exists
            if (row.doc) {
                Object.assign(mergedObject, parseDoc(row.doc));
            }

            // Add any direct column values (non-JSON fields) from SELECT
            Object.keys(row).forEach((key) => {
                if (
                    key !== 'doc' &&
                    row[key] !== null &&
                    row[key] !== undefined
                ) {
                    // Handle table-prefixed field names like "users.name" -> "name"
                    const fieldName = key.includes('.')
                        ? key.split('.').pop()
                        : key;
                    if (fieldName) {
                        mergedObject[fieldName] = row[key];
                    }
                }
            });

            return mergedObject;
        }) as T[];
    }

    return rows.map((row) => {
        if (row.doc !== undefined) {
            return parseDoc(row.doc);
        }
        const obj: any = {};
        for (const key of Object.keys(row)) {
            obj[key] = row[key];
        }
        // If we have field selections with nested paths, reconstruct the nested structure
        return reconstructNestedObject(obj) as T;
    });
};

// Add exec as alias for toArray
QueryBuilder.prototype.exec = QueryBuilder.prototype.toArray;

// MEDIUM-2 FIX: Add iterator method for memory-efficient streaming
QueryBuilder.prototype.iterator = async function* <T>(
    this: QueryBuilder<T> & { collection?: Collection<any> }
): AsyncIterableIterator<T> {
    if (!this.collection)
        throw new Error('Collection not bound to query builder');

    const { sql, params } = SQLTranslator.buildSelectQuery(
        this.collection['collectionSchema'].name,
        this.getOptions(),
        this.collection['collectionSchema'].constrainedFields
    );

    // Stream rows one by one using driver's queryIterator
    for await (const row of this.collection['driver'].queryIterator(sql, params)) {
        // Check if this is an aggregate query
        const options = this.getOptions();
        if (options.aggregates && options.aggregates.length > 0) {
            yield row as T;
        } else if (options.joins && options.joins.length > 0) {
            // For JOIN queries, merge data from multiple tables
            const mergedObject: any = {};
            if (row.doc !== undefined) {
                Object.assign(mergedObject, parseDoc(row.doc));
            }
            Object.keys(row).forEach((key) => {
                if (
                    key !== 'doc' &&
                    row[key] !== null &&
                    row[key] !== undefined
                ) {
                    const fieldName = key.includes('.')
                        ? key.split('.').pop()
                        : key;
                    if (fieldName) {
                        mergedObject[fieldName] = row[key];
                    }
                }
            });
            yield mergedObject as T;
        } else if (row.doc !== undefined) {
            yield parseDoc(row.doc) as T;
        } else {
            const obj: any = {};
            for (const key of Object.keys(row)) {
                obj[key] = row[key];
            }
            yield reconstructNestedObject(obj) as T;
        }
    }
};


QueryBuilder.prototype.first = async function <T>(
    this: QueryBuilder<T>
): Promise<T | null> {
    const results = await this.limit(1).toArray();
    return results[0] || null;
};

QueryBuilder.prototype.executeCount = async function <T>(
    this: QueryBuilder<T> & { collection?: Collection<any> }
): Promise<number> {
    if (!this.collection)
        throw new Error('Collection not bound to query builder');

    const options = this.getOptions();
    let sql = `SELECT COUNT(*) as count FROM ${this.collection['collectionSchema'].name}`;
    const params: any[] = [];

    if (options.filters.length > 0) {
        const { whereClause, whereParams } = SQLTranslator.buildWhereClause(
            options.filters,
            'AND',
            this.collection['collectionSchema'].constrainedFields
        );
        sql += ` WHERE ${whereClause}`;
        params.push(...whereParams);
    }

    const result = await this.collection['driver'].query(sql, params);
    return result[0].count;
};

// Add sync versions for backward compatibility
QueryBuilder.prototype.toArraySync = function <T>(
    this: QueryBuilder<T> & { collection?: Collection<any> }
): T[] {
    if (!this.collection)
        throw new Error('Collection not bound to query builder');

    const { sql, params } = SQLTranslator.buildSelectQuery(
        this.collection['collectionSchema'].name,
        this.getOptions(),
        this.collection['collectionSchema'].constrainedFields
    );
    const rows = this.collection['driver'].querySync(sql, params);

    // Check if this is an aggregate query
    const options = this.getOptions();
    if (options.aggregates && options.aggregates.length > 0) {
        // For aggregate queries, return the raw results without parsing doc
        return rows as T[];
    }

    // Check if this is a JOIN query
    if (options.joins && options.joins.length > 0) {
        // For JOIN queries, merge data from multiple tables into JSON objects
        return rows.map((row) => {
            const mergedObject: any = {};

            // Parse the main table's doc if it exists
            if (row.doc) {
                Object.assign(mergedObject, parseDoc(row.doc));
            }

            // Add any direct column values (non-JSON fields) from SELECT
            Object.keys(row).forEach((key) => {
                if (
                    key !== 'doc' &&
                    row[key] !== null &&
                    row[key] !== undefined
                ) {
                    // Handle table-prefixed field names like "users.name" -> "name"
                    const fieldName = key.includes('.')
                        ? key.split('.').pop()
                        : key;
                    if (fieldName) {
                        mergedObject[fieldName] = row[key];
                    }
                }
            });

            return mergedObject;
        }) as T[];
    }

    return rows.map((row) => {
        if (row.doc !== undefined) {
            return parseDoc(row.doc);
        }
        const obj: any = {};
        for (const key of Object.keys(row)) {
            obj[key] = row[key];
        }
        // If we have field selections with nested paths, reconstruct the nested structure
        return reconstructNestedObject(obj) as T;
    });
};

QueryBuilder.prototype.firstSync = function <T>(
    this: QueryBuilder<T>
): T | null {
    const results = this.limit(1).toArraySync();
    return results[0] || null;
};

QueryBuilder.prototype.countSync = function <T>(
    this: QueryBuilder<T> & { collection?: Collection<any> }
): number {
    if (!this.collection)
        throw new Error('Collection not bound to query builder');

    const options = this.getOptions();
    let sql = `SELECT COUNT(*) as count FROM ${this.collection['collectionSchema'].name}`;
    const params: any[] = [];

    if (options.filters.length > 0) {
        const { whereClause, whereParams } = SQLTranslator.buildWhereClause(
            options.filters,
            'AND',
            this.collection['collectionSchema'].constrainedFields
        );
        sql += ` WHERE ${whereClause}`;
        params.push(...whereParams);
    }

    const result = this.collection['driver'].querySync(sql, params);
    return result[0].count;
};

// FieldBuilder methods (async by default)
FieldBuilder.prototype.toArray = async function <T>(
    this: FieldBuilder<T, any> & { collection?: Collection<any> }
): Promise<T[]> {
    throw new Error(
        'toArray() should not be called on FieldBuilder. Use a comparison operator first.'
    );
};

FieldBuilder.prototype.exec = async function <T>(
    this: FieldBuilder<T, any> & { collection?: Collection<any> }
): Promise<T[]> {
    throw new Error(
        'exec() should not be called on FieldBuilder. Use a comparison operator first.'
    );
};

FieldBuilder.prototype.first = async function <T>(
    this: FieldBuilder<T, any>
): Promise<T | null> {
    throw new Error(
        'first() should not be called on FieldBuilder. Use a comparison operator first.'
    );
};

FieldBuilder.prototype.executeCount = async function <T>(
    this: FieldBuilder<T, any> & { collection?: Collection<any> }
): Promise<number> {
    throw new Error(
        'executeCount() should not be called on FieldBuilder. Use a comparison operator first.'
    );
};

// FieldBuilder sync methods
FieldBuilder.prototype.toArraySync = function <T>(
    this: FieldBuilder<T, any> & { collection?: Collection<any> }
): T[] {
    throw new Error(
        'toArraySync() should not be called on FieldBuilder. Use a comparison operator first.'
    );
};

FieldBuilder.prototype.firstSync = function <T>(
    this: FieldBuilder<T, any>
): T | null {
    throw new Error(
        'firstSync() should not be called on FieldBuilder. Use a comparison operator first.'
    );
};

FieldBuilder.prototype.countSync = function <T>(
    this: FieldBuilder<T, any> & { collection?: Collection<any> }
): number {
    throw new Error(
        'countSync() should not be called on FieldBuilder. Use a comparison operator first.'
    );
};
