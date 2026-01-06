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
} from './errors.js';
import {
    parseDoc,
    mergeConstrainedFields,
    reconstructNestedObject,
} from './json-utils.js';
import type { QueryablePaths, OrderablePaths } from './types/nested-paths';
import type { PluginManager } from './plugin-system';
import { Migrator } from './migrator';
import { fieldPathToColumnName } from './constrained-fields';

export class Collection<T extends z.ZodSchema> {
    private driver: Driver;
    private collectionSchema: CollectionSchema<InferSchema<T>>;
    private pluginManager?: PluginManager;
    private database?: any; // Reference to the Database instance

    private isInitialized = false;
    private initializationPromise?: Promise<void>;
    private initializationError?: Error; // Store initialization errors for explicit propagation
    
    // PERF: Cache migrated collections to skip redundant migration checks
    private static migratedCollections = new Set<string>();

    constructor(
        driver: Driver,
        schema: CollectionSchema<InferSchema<T>>,
        pluginManager?: PluginManager,
        database?: any
    ) {
        this.driver = driver;
        this.collectionSchema = schema;
        this.pluginManager = pluginManager;
        this.database = database;
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
        const migrationKey = `${this.collectionSchema.name}_v${this.collectionSchema.version || 1}`;
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

    private generateId(): string {
        return crypto.randomUUID();
    }

    async insert(doc: Omit<InferSchema<T>, '_id'>): Promise<InferSchema<T>> {
        await this.ensureInitialized();

        const context = {
            collectionName: this.collectionSchema.name,
            schema: this.collectionSchema,
            operation: 'insert',
            data: doc,
        };

        // Execute before hook (now properly awaited)
        await this.pluginManager?.executeHookSafe('onBeforeInsert', context);

        try {
            // Check if _id is provided in doc (via type assertion)
            const docWithPossibleId = doc as any;
            let _id: string;

            if (docWithPossibleId._id) {
                // If _id is provided, validate it and check for duplicates
                _id = docWithPossibleId._id;

                // Check if this _id already exists
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

            // Constraints are now enforced at the SQL level via constrainedFields

            const { sql, params } = SQLTranslator.buildInsertQuery(
                this.collectionSchema.name,
                validatedDoc,
                _id,
                this.collectionSchema.constrainedFields,
                this.collectionSchema.schema
            );
            await this.driver.exec(sql, params);

            // Handle vector insertions
            const vectorQueries = SQLTranslator.buildVectorInsertQueries(
                this.collectionSchema.name,
                validatedDoc,
                _id,
                this.collectionSchema.constrainedFields
            );
            await this.executeVectorQueries(vectorQueries);

            // Execute after hook (now properly awaited)
            const resultContext = { ...context, result: validatedDoc };
            await this.pluginManager?.executeHookSafe(
                'onAfterInsert',
                resultContext
            );

            return validatedDoc;
        } catch (error) {
            // Execute error hook (now properly awaited)
            const errorContext = { ...context, error: error as Error };
            await this.pluginManager?.executeHookSafe('onError', errorContext);

            if (error instanceof Error) {
                if (error.message.includes('UNIQUE constraint')) {
                    // Extract field name from SQLite error message
                    const fieldMatch = error.message.match(
                        /UNIQUE constraint failed: [^.]+\.([^,\s]+)/
                    );
                    const field = fieldMatch ? fieldMatch[1] : 'unknown';
                    throw new UniqueConstraintError(
                        `Document violates unique constraint on field: ${field}`,
                        (doc as any)._id || 'unknown'
                    );
                } else if (error.message.includes('FOREIGN KEY constraint')) {
                    throw new ValidationError(
                        'Document validation failed: Invalid foreign key reference',
                        error
                    );
                }
            }
            throw error;
        }
    }

    async insertBulk(
        docs: Omit<InferSchema<T>, '_id'>[]
    ): Promise<InferSchema<T>[]> {
        await this.ensureInitialized();
        if (docs.length === 0) return [];

        const context = {
            collectionName: this.collectionSchema.name,
            schema: this.collectionSchema,
            operation: 'insertBulk',
            data: docs,
        };

        await this.pluginManager?.executeHookSafe('onBeforeInsert', context);

        try {
            // HIGH-4 FIX: Collect all explicit IDs for batch existence check
            const explicitIds: string[] = [];
            for (const doc of docs) {
                const docWithPossibleId = doc as any;
                if (docWithPossibleId._id) {
                    explicitIds.push(docWithPossibleId._id);
                }
            }

            // HIGH-4 FIX: Batch existence check - O(1) query instead of O(n)
            if (explicitIds.length > 0) {
                const placeholders = explicitIds.map(() => '?').join(',');
                const checkSql = `SELECT _id FROM ${this.collectionSchema.name} WHERE _id IN (${placeholders})`;
                const existing = await this.driver.query(checkSql, explicitIds);
                if (existing.length > 0) {
                    throw new UniqueConstraintError(
                        `Documents with ids [${existing.map(r => r._id).join(', ')}] already exist`,
                        existing[0]._id as string
                    );
                }
            }

            const validatedDocs: InferSchema<T>[] = [];
            const sqlParts: string[] = [];
            const allParams: any[] = [];

            for (const doc of docs) {
                const docWithPossibleId = doc as any;
                // ID is either explicit or generated, no need for findById check anymore
                const _id = docWithPossibleId._id || this.generateId();

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

                const valuePart = sql.substring(sql.indexOf('VALUES ') + 7);
                sqlParts.push(valuePart);
                allParams.push(...params);
            }

            const firstQuery = SQLTranslator.buildInsertQuery(
                this.collectionSchema.name,
                validatedDocs[0],
                (validatedDocs[0] as any)._id,
                this.collectionSchema.constrainedFields,
                this.collectionSchema.schema
            );
            const baseSQL = firstQuery.sql.substring(
                0,
                firstQuery.sql.indexOf('VALUES ') + 7
            );
            const batchSQL = baseSQL + sqlParts.join(', ');

            await this.driver.exec(batchSQL, allParams);

            // Handle vector insertions for all documents
            for (const validatedDoc of validatedDocs) {
                const vectorQueries = SQLTranslator.buildVectorInsertQueries(
                    this.collectionSchema.name,
                    validatedDoc,
                    (validatedDoc as any)._id,
                    this.collectionSchema.constrainedFields
                );
                await this.executeVectorQueries(vectorQueries);
            }

            const resultContext = { ...context, result: validatedDocs };
            await this.pluginManager?.executeHookSafe(
                'onAfterInsert',
                resultContext
            );

            return validatedDocs;
        } catch (error) {
            const errorContext = { ...context, error: error as Error };
            await this.pluginManager?.executeHookSafe('onError', errorContext);

            if (error instanceof Error) {
                if (error.message.includes('UNIQUE constraint')) {
                    const fieldMatch = error.message.match(
                        /UNIQUE constraint failed: [^.]+\.([^,\s]+)/
                    );
                    const field = fieldMatch ? fieldMatch[1] : 'unknown';
                    throw new UniqueConstraintError(
                        `Document violates unique constraint on field: ${field}`,
                        'unknown'
                    );
                } else if (error.message.includes('FOREIGN KEY constraint')) {
                    throw new ValidationError(
                        'Document validation failed: Invalid foreign key reference',
                        error
                    );
                }
            }
            throw error;
        }
    }

    async put(
        _id: string,
        doc: Partial<InferSchema<T>>
    ): Promise<InferSchema<T>> {
        await this.ensureInitialized();
        const existing = await this.findById(_id);
        if (!existing) {
            throw new NotFoundError('Document not found', _id);
        }

        const updatedDoc = { ...existing, ...doc, _id };
        const validatedDoc = this.validateDocument(updatedDoc);

        // Plugin hook: before update
        const context = {
            collectionName: this.collectionSchema.name,
            schema: this.collectionSchema,
            operation: 'update',
            data: validatedDoc,
        };
        await this.pluginManager?.executeHookSafe('onBeforeUpdate', context);

        // Constraints are now enforced at the SQL level via constrainedFields
        const { sql, params } = SQLTranslator.buildUpdateQuery(
            this.collectionSchema.name,
            validatedDoc,
            _id,
            this.collectionSchema.constrainedFields,
            this.collectionSchema.schema
        );
        await this.driver.exec(sql, params);

        // Handle vector updates
        const vectorQueries = SQLTranslator.buildVectorUpdateQueries(
            this.collectionSchema.name,
            validatedDoc,
            _id,
            this.collectionSchema.constrainedFields
        );
        await this.executeVectorQueries(vectorQueries);

        // Plugin hook: after update
        const resultContext = {
            ...context,
            result: validatedDoc,
        };
        await this.pluginManager?.executeHookSafe(
            'onAfterUpdate',
            resultContext
        );

        return validatedDoc;
    }

    async putBulk(
        updates: { _id: string; doc: Partial<InferSchema<T>> }[]
    ): Promise<InferSchema<T>[]> {
        if (updates.length === 0) return [];

        const context = {
            collectionName: this.collectionSchema.name,
            schema: this.collectionSchema,
            operation: 'putBulk',
            data: updates,
        };

        await this.pluginManager?.executeHookSafe('onBeforeUpdate', context);

        try {
            const validatedDocs: InferSchema<T>[] = [];
            const sqlStatements: { sql: string; params: any[] }[] = [];
            const vectorQueries: { sql: string; params: any[] }[] = [];

            for (const update of updates) {
                const existing = await this.findById(update._id);
                if (!existing) {
                    throw new NotFoundError('Document not found', update._id);
                }

                const updatedDoc = {
                    ...existing,
                    ...update.doc,
                    _id: update._id,
                };
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
                
                // HIGH-2 FIX: Collect vector updates to execute within transaction boundary
                const vQueries = SQLTranslator.buildVectorUpdateQueries(
                    this.collectionSchema.name,
                    validatedDoc,
                    update._id,
                    this.collectionSchema.constrainedFields
                );
                vectorQueries.push(...vQueries);
            }

            // HIGH-2 FIX: Use BEGIN IMMEDIATE to lock database upfront and prevent "database is locked" errors
            await this.driver.exec('BEGIN IMMEDIATE TRANSACTION', []);
            try {
                for (const statement of sqlStatements) {
                    await this.driver.exec(statement.sql, statement.params);
                }
                // HIGH-2 FIX: Execute vector updates within the same transaction for atomicity
                for (const vectorQuery of vectorQueries) {
                    await this.driver.exec(vectorQuery.sql, vectorQuery.params);
                }
                await this.driver.exec('COMMIT', []);
            } catch (error) {
                await this.driver.exec('ROLLBACK', []);
                throw error;
            }

            const resultContext = { ...context, result: validatedDocs };
            await this.pluginManager?.executeHookSafe(
                'onAfterUpdate',
                resultContext
            );

            return validatedDocs;
        } catch (error) {
            const errorContext = { ...context, error: error as Error };
            await this.pluginManager?.executeHookSafe('onError', errorContext);

            if (error instanceof Error) {
                if (error.message.includes('UNIQUE constraint')) {
                    const fieldMatch = error.message.match(
                        /UNIQUE constraint failed: [^.]+\.([^,\s]+)/
                    );
                    const field = fieldMatch ? fieldMatch[1] : 'unknown';
                    throw new UniqueConstraintError(
                        `Document violates unique constraint on field: ${field}`,
                        'unknown'
                    );
                } else if (error.message.includes('FOREIGN KEY constraint')) {
                    throw new ValidationError(
                        'Document validation failed: Invalid foreign key reference',
                        error
                    );
                }
            }
            throw error;
        }
    }

    async delete(_id: string): Promise<boolean> {
        // Plugin hook: before delete
        const context = {
            collectionName: this.collectionSchema.name,
            schema: this.collectionSchema,
            operation: 'delete',
            data: { _id },
        };
        await this.pluginManager?.executeHookSafe('onBeforeDelete', context);

        const { sql, params } = SQLTranslator.buildDeleteQuery(
            this.collectionSchema.name,
            _id
        );
        await this.driver.exec(sql, params);

        // Handle vector deletions
        const vectorQueries = SQLTranslator.buildVectorDeleteQueries(
            this.collectionSchema.name,
            _id,
            this.collectionSchema.constrainedFields
        );
        await this.executeVectorQueries(vectorQueries);

        // Plugin hook: after delete
        const resultContext = {
            ...context,
            result: { _id, deleted: true },
        };
        await this.pluginManager?.executeHookSafe(
            'onAfterDelete',
            resultContext
        );

        return true;
    }

    async deleteBulk(ids: string[]): Promise<number> {
        let count = 0;
        for (const _id of ids) {
            if (await this.delete(_id)) count++;
        }
        return count;
    }
    async upsert(
        _id: string,
        doc: Omit<InferSchema<T>, '_id'>
    ): Promise<InferSchema<T>> {
        // Use the optimized SQL-level upsert for best performance
        return this.upsertOptimized(_id, doc);
    }

    // Add an even more optimized version using SQL UPSERT
    async upsertOptimized(
        _id: string,
        doc: Omit<InferSchema<T>, '_id'>
    ): Promise<InferSchema<T>> {
        const fullDoc = { ...doc, _id };
        const validatedDoc = this.validateDocument(fullDoc);

        // For maximum performance, use SQL-level UPSERT (INSERT OR REPLACE)
        // This eliminates the need for existence checks entirely
        try {
            // Constraints are now enforced at the SQL level via constrainedFields

            // Use INSERT OR REPLACE for atomic upsert
            if (
                !this.collectionSchema.constrainedFields ||
                Object.keys(this.collectionSchema.constrainedFields).length ===
                    0
            ) {
                // Original behavior for collections without constrained fields
                const sql = `INSERT OR REPLACE INTO ${this.collectionSchema.name} (_id, doc) VALUES (?, ?)`;
                const params = [_id, JSON.stringify(validatedDoc)];
                await this.driver.exec(sql, params);
            } else {
                // Build upsert with constrained field columns
                const { sql, params } = SQLTranslator.buildInsertQuery(
                    this.collectionSchema.name,
                    validatedDoc,
                    _id,
                    this.collectionSchema.constrainedFields,
                    this.collectionSchema.schema
                );
                // Convert INSERT to INSERT OR REPLACE
                const upsertSQL = sql.replace(
                    'INSERT INTO',
                    'INSERT OR REPLACE INTO'
                );
                await this.driver.exec(upsertSQL, params);
            }

            return validatedDoc;
        } catch (error) {
            if (error instanceof Error) {
                if (error.message.includes('UNIQUE constraint')) {
                    // Extract field name from SQLite error message
                    const fieldMatch = error.message.match(
                        /UNIQUE constraint failed: [^.]+\.([^,\s]+)/
                    );
                    const field = fieldMatch ? fieldMatch[1] : 'unknown';
                    throw new UniqueConstraintError(
                        `Document violates unique constraint on field: ${field}`,
                        _id
                    );
                } else if (error.message.includes('FOREIGN KEY constraint')) {
                    throw new ValidationError(
                        'Document validation failed: Invalid foreign key reference',
                        error
                    );
                }
            }
            throw error;
        }
    }

    async upsertBulk(
        updates: { _id: string; doc: Omit<InferSchema<T>, '_id'> }[]
    ): Promise<InferSchema<T>[]> {
        if (updates.length === 0) return [];

        const context = {
            collectionName: this.collectionSchema.name,
            schema: this.collectionSchema,
            operation: 'upsertBulk',
            data: updates,
        };

        await this.pluginManager?.executeHookSafe('onBeforeInsert', context);

        try {
            const validatedDocs: InferSchema<T>[] = [];
            const sqlParts: string[] = [];
            const allParams: any[] = [];

            for (const update of updates) {
                const fullDoc = { ...update.doc, _id: update._id };
                const validatedDoc = this.validateDocument(fullDoc);
                validatedDocs.push(validatedDoc);

                if (
                    !this.collectionSchema.constrainedFields ||
                    Object.keys(this.collectionSchema.constrainedFields)
                        .length === 0
                ) {
                    const valuePart = `(?, ?)`;
                    sqlParts.push(valuePart);
                    allParams.push(update._id, JSON.stringify(validatedDoc));
                } else {
                    const { sql, params } = SQLTranslator.buildInsertQuery(
                        this.collectionSchema.name,
                        validatedDoc,
                        update._id,
                        this.collectionSchema.constrainedFields,
                        this.collectionSchema.schema
                    );

                    const valuePart = sql.substring(sql.indexOf('VALUES ') + 7);
                    sqlParts.push(valuePart);
                    allParams.push(...params);
                }
            }

            let batchSQL: string;
            if (
                !this.collectionSchema.constrainedFields ||
                Object.keys(this.collectionSchema.constrainedFields).length ===
                    0
            ) {
                batchSQL = `INSERT OR REPLACE INTO ${
                    this.collectionSchema.name
                } (_id, doc) VALUES ${sqlParts.join(', ')}`;
            } else {
                const firstQuery = SQLTranslator.buildInsertQuery(
                    this.collectionSchema.name,
                    validatedDocs[0],
                    updates[0]._id,
                    this.collectionSchema.constrainedFields,
                    this.collectionSchema.schema
                );
                const baseSQL = firstQuery.sql.substring(
                    0,
                    firstQuery.sql.indexOf('VALUES ') + 7
                );
                batchSQL =
                    baseSQL.replace('INSERT INTO', 'INSERT OR REPLACE INTO') +
                    sqlParts.join(', ');
            }

            await this.driver.exec(batchSQL, allParams);

            const resultContext = { ...context, result: validatedDocs };
            await this.pluginManager?.executeHookSafe(
                'onAfterInsert',
                resultContext
            );

            return validatedDocs;
        } catch (error) {
            const errorContext = { ...context, error: error as Error };
            await this.pluginManager?.executeHookSafe('onError', errorContext);

            if (error instanceof Error) {
                if (error.message.includes('UNIQUE constraint')) {
                    const fieldMatch = error.message.match(
                        /UNIQUE constraint failed: [^.]+\.([^,\s]+)/
                    );
                    const field = fieldMatch ? fieldMatch[1] : 'unknown';
                    throw new UniqueConstraintError(
                        `Document violates unique constraint on field: ${field}`,
                        'unknown'
                    );
                } else if (error.message.includes('FOREIGN KEY constraint')) {
                    throw new ValidationError(
                        'Document validation failed: Invalid foreign key reference',
                        error
                    );
                }
            }
            throw error;
        }
    }

    async findById(_id: string): Promise<InferSchema<T> | null> {
        await this.ensureInitialized();

        if (
            !this.collectionSchema.constrainedFields ||
            Object.keys(this.collectionSchema.constrainedFields).length === 0
        ) {
            const sql = `SELECT doc FROM ${this.collectionSchema.name} WHERE _id = ?`;
            const params = [_id];
            const rows = await this.driver.query(sql, params);
            if (rows.length === 0) return null;
            return parseDoc(rows[0].doc);
        }

        const constrainedFieldColumns = Object.keys(
            this.collectionSchema.constrainedFields
        )
            .map((f) => fieldPathToColumnName(f))
            .join(', ');
        const sql = `SELECT doc, ${constrainedFieldColumns} FROM ${this.collectionSchema.name} WHERE _id = ?`;
        const params = [_id];
        const rows = await this.driver.query(sql, params);
        if (rows.length === 0) return null;
        return mergeConstrainedFields(
            rows[0],
            this.collectionSchema.constrainedFields
        );
    }

    private validateFieldName(fieldName: string): void {
        // Skip validation for nested field paths (containing dots)
        // These are handled at the SQL level with json_extract
        if (fieldName.includes('.')) {
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

    // Add sync versions for backward compatibility
    insertSync(doc: Omit<InferSchema<T>, '_id'>): InferSchema<T> {
        const context = {
            collectionName: this.collectionSchema.name,
            schema: this.collectionSchema,
            operation: 'insert',
            data: doc,
        };

        // Note: Plugin hooks are async, so we can't properly await them in sync mode
        this.pluginManager
            ?.executeHookSafe('onBeforeInsert', context)
            .catch(console.warn);

        try {
            const docWithPossibleId = doc as any;
            let _id: string;

            if (docWithPossibleId._id) {
                _id = docWithPossibleId._id;
                const existing = this.findByIdSync(_id);
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
            this.driver.execSync(sql, params);

            const resultContext = { ...context, result: validatedDoc };
            this.pluginManager
                ?.executeHookSafe('onAfterInsert', resultContext)
                .catch(console.warn);

            return validatedDoc;
        } catch (error) {
            const errorContext = { ...context, error: error as Error };
            this.pluginManager
                ?.executeHookSafe('onError', errorContext)
                .catch(console.warn);

            if (error instanceof Error) {
                if (error.message.includes('UNIQUE constraint')) {
                    // Extract field name from SQLite error message
                    const fieldMatch = error.message.match(
                        /UNIQUE constraint failed: [^.]+\.([^,\s]+)/
                    );
                    const field = fieldMatch ? fieldMatch[1] : 'unknown';
                    throw new UniqueConstraintError(
                        `Document violates unique constraint on field: ${field}`,
                        (doc as any)._id || 'unknown'
                    );
                } else if (error.message.includes('FOREIGN KEY constraint')) {
                    throw new ValidationError(
                        'Document validation failed: Invalid foreign key reference',
                        error
                    );
                }
            }
            throw error;
        }
    }

    insertBulkSync(docs: Omit<InferSchema<T>, '_id'>[]): InferSchema<T>[] {
        if (docs.length === 0) return [];

        try {
            const validatedDocs: InferSchema<T>[] = [];
            const sqlParts: string[] = [];
            const allParams: any[] = [];

            for (const doc of docs) {
                const docWithPossibleId = doc as any;
                let _id: string;

                if (docWithPossibleId._id) {
                    _id = docWithPossibleId._id;
                    const existing = this.findByIdSync(_id);
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
                validatedDocs.push(validatedDoc);

                const { sql, params } = SQLTranslator.buildInsertQuery(
                    this.collectionSchema.name,
                    validatedDoc,
                    _id,
                    this.collectionSchema.constrainedFields,
                    this.collectionSchema.schema
                );

                const valuePart = sql.substring(sql.indexOf('VALUES ') + 7);
                sqlParts.push(valuePart);
                allParams.push(...params);
            }

            const firstQuery = SQLTranslator.buildInsertQuery(
                this.collectionSchema.name,
                validatedDocs[0],
                (validatedDocs[0] as any)._id,
                this.collectionSchema.constrainedFields,
                this.collectionSchema.schema
            );
            const baseSQL = firstQuery.sql.substring(
                0,
                firstQuery.sql.indexOf('VALUES ') + 7
            );
            const batchSQL = baseSQL + sqlParts.join(', ');

            this.driver.execSync(batchSQL, allParams);
            return validatedDocs;
        } catch (error) {
            if (error instanceof Error) {
                if (error.message.includes('UNIQUE constraint')) {
                    const fieldMatch = error.message.match(
                        /UNIQUE constraint failed: [^.]+\.([^,\s]+)/
                    );
                    const field = fieldMatch ? fieldMatch[1] : 'unknown';
                    throw new UniqueConstraintError(
                        `Document violates unique constraint on field: ${field}`,
                        'unknown'
                    );
                } else if (error.message.includes('FOREIGN KEY constraint')) {
                    throw new ValidationError(
                        'Document validation failed: Invalid foreign key reference',
                        error
                    );
                }
            }
            throw error;
        }
    }

    findByIdSync(_id: string): InferSchema<T> | null {
        if (
            !this.collectionSchema.constrainedFields ||
            Object.keys(this.collectionSchema.constrainedFields).length === 0
        ) {
            // Original behavior for collections without constrained fields
            const sql = `SELECT doc FROM ${this.collectionSchema.name} WHERE _id = ?`;
            const params = [_id];
            const rows = this.driver.querySync(sql, params);
            if (rows.length === 0) return null;
            return parseDoc(rows[0].doc);
        }

        // For collections with constrained fields, select both doc and constrained columns
        const constrainedFieldColumns = Object.keys(
            this.collectionSchema.constrainedFields
        )
            .map((f) => fieldPathToColumnName(f))
            .join(', ');
        const sql = `SELECT doc, ${constrainedFieldColumns} FROM ${this.collectionSchema.name} WHERE _id = ?`;
        const params = [_id];
        const rows = this.driver.querySync(sql, params);
        if (rows.length === 0) return null;
        return mergeConstrainedFields(
            rows[0],
            this.collectionSchema.constrainedFields
        );
    }

    toArraySync(): InferSchema<T>[] {
        const { sql, params } = SQLTranslator.buildSelectQuery(
            this.collectionSchema.name,
            { filters: [] },
            this.collectionSchema.constrainedFields
        );
        const rows = this.driver.querySync(sql, params);
        return rows.map((row) => parseDoc(row.doc));
    }

    countSync(): number {
        const sql = `SELECT COUNT(*) as count FROM ${this.collectionSchema.name}`;
        const result = this.driver.querySync(sql, []);
        return result[0].count;
    }

    firstSync(): InferSchema<T> | null {
        const { sql, params } = SQLTranslator.buildSelectQuery(
            this.collectionSchema.name,
            { filters: [], limit: 1 },
            this.collectionSchema.constrainedFields
        );
        const rows = this.driver.querySync(sql, params);
        return rows.length > 0 ? parseDoc(rows[0].doc) : null;
    }

    putSync(_id: string, doc: Partial<InferSchema<T>>): InferSchema<T> {
        const existing = this.findByIdSync(_id);
        if (!existing) {
            throw new NotFoundError('Document not found', _id);
        }

        const updatedDoc = { ...existing, ...doc, _id };
        const validatedDoc = this.validateDocument(updatedDoc);

        try {
            const { sql, params } = SQLTranslator.buildUpdateQuery(
                this.collectionSchema.name,
                validatedDoc,
                _id,
                this.collectionSchema.constrainedFields,
                this.collectionSchema.schema
            );
            this.driver.execSync(sql, params);
            return validatedDoc;
        } catch (error) {
            if (error instanceof Error) {
                if (error.message.includes('UNIQUE constraint')) {
                    // Extract field name from SQLite error message
                    const fieldMatch = error.message.match(
                        /UNIQUE constraint failed: [^.]+\.([^,\s]+)/
                    );
                    const field = fieldMatch ? fieldMatch[1] : 'unknown';
                    throw new UniqueConstraintError(
                        `Document violates unique constraint on field: ${field}`,
                        _id
                    );
                } else if (error.message.includes('FOREIGN KEY constraint')) {
                    throw new ValidationError(
                        'Document validation failed: Invalid foreign key reference',
                        error
                    );
                }
            }
            throw error;
        }
    }

    deleteSync(_id: string): boolean {
        const { sql, params } = SQLTranslator.buildDeleteQuery(
            this.collectionSchema.name,
            _id
        );
        this.driver.execSync(sql, params);
        return true;
    }

    deleteBulkSync(ids: string[]): number {
        let count = 0;
        for (const _id of ids) {
            if (this.deleteSync(_id)) count++;
        }
        return count;
    }

    upsertSync(_id: string, doc: Omit<InferSchema<T>, '_id'>): InferSchema<T> {
        try {
            const existing = this.findByIdSync(_id);
            if (existing) {
                return this.putSync(_id, doc as Partial<InferSchema<T>>);
            } else {
                return this.insertSync({ ...doc, _id } as any);
            }
        } catch (error) {
            if (error instanceof Error) {
                if (error.message.includes('UNIQUE constraint')) {
                    // Extract field name from SQLite error message
                    const fieldMatch = error.message.match(
                        /UNIQUE constraint failed: [^.]+\.([^,\s]+)/
                    );
                    const field = fieldMatch ? fieldMatch[1] : 'unknown';
                    throw new UniqueConstraintError(
                        `Document violates unique constraint on field: ${field}`,
                        _id
                    );
                } else if (error.message.includes('FOREIGN KEY constraint')) {
                    throw new ValidationError(
                        'Document validation failed: Invalid foreign key reference',
                        error
                    );
                }
            }
            throw error;
        }
    }

    upsertBulkSync(
        docs: { _id: string; doc: Omit<InferSchema<T>, '_id'> }[]
    ): InferSchema<T>[] {
        if (docs.length === 0) return [];

        try {
            const validatedDocs: InferSchema<T>[] = [];
            const sqlParts: string[] = [];
            const allParams: any[] = [];

            for (const item of docs) {
                const fullDoc = { ...item.doc, _id: item._id };
                const validatedDoc = this.validateDocument(fullDoc);
                validatedDocs.push(validatedDoc);

                if (
                    !this.collectionSchema.constrainedFields ||
                    Object.keys(this.collectionSchema.constrainedFields)
                        .length === 0
                ) {
                    const valuePart = `(?, ?)`;
                    sqlParts.push(valuePart);
                    allParams.push(item._id, JSON.stringify(validatedDoc));
                } else {
                    const { sql, params } = SQLTranslator.buildInsertQuery(
                        this.collectionSchema.name,
                        validatedDoc,
                        item._id,
                        this.collectionSchema.constrainedFields,
                        this.collectionSchema.schema
                    );

                    const valuePart = sql.substring(sql.indexOf('VALUES ') + 7);
                    sqlParts.push(valuePart);
                    allParams.push(...params);
                }
            }

            let batchSQL: string;
            if (
                !this.collectionSchema.constrainedFields ||
                Object.keys(this.collectionSchema.constrainedFields).length ===
                    0
            ) {
                batchSQL = `INSERT OR REPLACE INTO ${
                    this.collectionSchema.name
                } (_id, doc) VALUES ${sqlParts.join(', ')}`;
            } else {
                const firstQuery = SQLTranslator.buildInsertQuery(
                    this.collectionSchema.name,
                    validatedDocs[0],
                    docs[0]._id,
                    this.collectionSchema.constrainedFields,
                    this.collectionSchema.schema
                );
                const baseSQL = firstQuery.sql.substring(
                    0,
                    firstQuery.sql.indexOf('VALUES ') + 7
                );
                batchSQL =
                    baseSQL.replace('INSERT INTO', 'INSERT OR REPLACE INTO') +
                    sqlParts.join(', ');
            }

            this.driver.execSync(batchSQL, allParams);
            return validatedDocs;
        } catch (error) {
            if (error instanceof Error) {
                if (error.message.includes('UNIQUE constraint')) {
                    const fieldMatch = error.message.match(
                        /UNIQUE constraint failed: [^.]+\.([^,\s]+)/
                    );
                    const field = fieldMatch ? fieldMatch[1] : 'unknown';
                    throw new UniqueConstraintError(
                        `Document violates unique constraint on field: ${field}`,
                        'unknown'
                    );
                } else if (error.message.includes('FOREIGN KEY constraint')) {
                    throw new ValidationError(
                        'Document validation failed: Invalid foreign key reference',
                        error
                    );
                }
            }
            throw error;
        }
    }

    putBulkSync(
        updates: { _id: string; doc: Partial<InferSchema<T>> }[]
    ): InferSchema<T>[] {
        if (updates.length === 0) return [];

        try {
            const validatedDocs: InferSchema<T>[] = [];
            const sqlStatements: { sql: string; params: any[] }[] = [];

            for (const update of updates) {
                const existing = this.findByIdSync(update._id);
                if (!existing) {
                    throw new NotFoundError('Document not found', update._id);
                }

                const updatedDoc = {
                    ...existing,
                    ...update.doc,
                    _id: update._id,
                };
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
            }

            this.driver.execSync('BEGIN TRANSACTION', []);
            try {
                for (const statement of sqlStatements) {
                    this.driver.execSync(statement.sql, statement.params);
                }
                this.driver.execSync('COMMIT', []);
            } catch (error) {
                this.driver.execSync('ROLLBACK', []);
                throw error;
            }

            return validatedDocs;
        } catch (error) {
            if (error instanceof Error) {
                if (error.message.includes('UNIQUE constraint')) {
                    const fieldMatch = error.message.match(
                        /UNIQUE constraint failed: [^.]+\.([^,\s]+)/
                    );
                    const field = fieldMatch ? fieldMatch[1] : 'unknown';
                    throw new UniqueConstraintError(
                        `Document violates unique constraint on field: ${field}`,
                        'unknown'
                    );
                } else if (error.message.includes('FOREIGN KEY constraint')) {
                    throw new ValidationError(
                        'Document validation failed: Invalid foreign key reference',
                        error
                    );
                }
            }
            throw error;
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
