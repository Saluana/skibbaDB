import { z } from 'zod';
import type { Driver, CollectionSchema } from './types';
import { DatabaseError } from './errors';
import { UpgradeRunner } from './upgrade-runner';
import type { Collection } from './collection';

export interface MigrationInfo {
    collectionName: string;
    version: number;
    completedAlters: string[];
}

export interface SchemaDiff {
    alters: string[];
    breaking: boolean;
    breakingReasons: string[];
}

interface SchemaSnapshotField {
    sqlType: string;
    optional: boolean;
}

type SchemaSnapshot = Record<string, SchemaSnapshotField>;

export interface MigrationContext {
    collectionName: string;
    oldVersion: number;
    newVersion: number;
    diff: SchemaDiff;
}

export class Migrator {
    private driver: Driver;
    private static readonly META_TABLE = '_skibbadb_migrations';

    constructor(driver: Driver) {
        this.driver = driver;
    }

    async initializeMigrationsTable(): Promise<void> {
        const createTableSQL = `
            CREATE TABLE IF NOT EXISTS ${Migrator.META_TABLE} (
                collection_name TEXT PRIMARY KEY,
                version INTEGER NOT NULL,
                completed_alters TEXT NOT NULL DEFAULT '[]',
                schema_snapshot TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        `;
        
        try {
            await this.driver.exec(createTableSQL);
            const columns = await this.driver.query(
                `PRAGMA table_info(${Migrator.META_TABLE})`
            );
            if (!columns.some((column) => column.name === 'schema_snapshot')) {
                await this.driver.exec(
                    `ALTER TABLE ${Migrator.META_TABLE} ADD COLUMN schema_snapshot TEXT`
                );
            }
        } catch (error) {
            // Handle nested transaction errors and other transaction-related issues
            if (error instanceof Error && (
                error.message.includes('cannot start a transaction within a transaction') ||
                error.message.includes('Failed to execute: SQLiteError: cannot start a transaction within a transaction')
            )) {
                // Ignore the error if we're in a transaction - table should already exist or be created elsewhere
                return;
            }
            throw error;
        }
    }

    async getStoredVersion(collectionName: string): Promise<number> {
        try {
            const sql = `SELECT version FROM ${Migrator.META_TABLE} WHERE collection_name = ?`;
            const rows = await this.driver.query(sql, [collectionName]);
            return rows.length > 0 ? rows[0].version : 0;
        } catch (error) {
            // If migration table doesn't exist yet and we're in a transaction, return 0
            if (error instanceof Error && (
                error.message.includes('no such table') ||
                error.message.includes('cannot start a transaction within a transaction')
            )) {
                return 0;
            }
            throw error;
        }
    }

    async setStoredVersion(collectionName: string, version: number, completedAlters: string[] = []): Promise<void> {
        await this.setStoredVersionWithSnapshot(collectionName, version, completedAlters);
    }

    async getStoredSchemaSnapshot(collectionName: string): Promise<SchemaSnapshot | null> {
        const sql = `SELECT schema_snapshot FROM ${Migrator.META_TABLE} WHERE collection_name = ?`;
        const rows = await this.driver.query(sql, [collectionName]);
        const snapshot = rows[0]?.schema_snapshot;
        if (!snapshot) {
            return null;
        }
        return JSON.parse(String(snapshot)) as SchemaSnapshot;
    }

    private async setStoredVersionWithSnapshot(
        collectionName: string,
        version: number,
        completedAlters: string[] = [],
        schema?: z.ZodSchema
    ): Promise<void> {
        const sql = `
            INSERT INTO ${Migrator.META_TABLE} (collection_name, version, completed_alters, schema_snapshot, updated_at)
            VALUES (?, ?, ?, ?, datetime('now'))
            ON CONFLICT(collection_name) DO UPDATE SET
                version = excluded.version,
                completed_alters = excluded.completed_alters,
                schema_snapshot = excluded.schema_snapshot,
                updated_at = excluded.updated_at
        `;
        await this.driver.exec(sql, [
            collectionName,
            version,
            JSON.stringify(completedAlters),
            schema ? JSON.stringify(this.createSchemaSnapshot(schema)) : null,
        ]);
    }

    generateSchemaDiff(
        oldSchema: z.ZodSchema | SchemaSnapshot | null,
        newSchema: z.ZodSchema | SchemaSnapshot,
        tableName: string
    ): SchemaDiff {
        const alters: string[] = [];
        const breakingReasons: string[] = [];
        let breaking = false;

        if (!oldSchema) {
            return { alters: [], breaking: false, breakingReasons: [] };
        }

        const oldShape = this.createSchemaSnapshot(oldSchema);
        const newShape = this.createSchemaSnapshot(newSchema);

        if (!oldShape || !newShape) {
            breaking = true;
            breakingReasons.push('Cannot analyze schema shape - manual migration required');
            return { alters, breaking, breakingReasons };
        }

        for (const [fieldName, fieldDef] of Object.entries(newShape)) {
            if (!oldShape[fieldName]) {
                const sqlType = fieldDef.sqlType;
                const nullable = fieldDef.optional ? '' : ' NOT NULL DEFAULT NULL';
                alters.push(`ALTER TABLE ${tableName} ADD COLUMN ${fieldName} ${sqlType}${nullable}`);
            } else {
                const oldType = oldShape[fieldName].sqlType;
                const newType = fieldDef.sqlType;
                
                if (oldType !== newType) {
                    breaking = true;
                    breakingReasons.push(`Field '${fieldName}' type changed from ${oldType} to ${newType}`);
                }
            }
        }

        for (const fieldName of Object.keys(oldShape)) {
            if (!newShape[fieldName]) {
                breaking = true;
                breakingReasons.push(`Field '${fieldName}' was removed`);
            }
        }

        return { alters, breaking, breakingReasons };
    }

    private extractSchemaShape(schema: z.ZodSchema): Record<string, any> | null {
        if ('shape' in schema && schema.shape) {
            return schema.shape as Record<string, any>;
        }
        
        if ('_def' in schema && schema._def) {
            const def = schema._def as any;
            if (def.shape) {
                return typeof def.shape === 'function' ? def.shape() : def.shape;
            }
        }

        return null;
    }

    private createSchemaSnapshot(
        schema: z.ZodSchema | SchemaSnapshot
    ): SchemaSnapshot | null {
        if (!schema) {
            return null;
        }
        if (!this.isZodSchema(schema)) {
            return schema as SchemaSnapshot;
        }

        const shape = this.extractSchemaShape(schema);
        if (!shape) {
            return null;
        }

        return Object.fromEntries(
            Object.entries(shape).map(([fieldName, fieldDef]) => [
                fieldName,
                {
                    sqlType: this.zodTypeToSQL(fieldDef),
                    optional: this.isFieldOptional(fieldDef),
                },
            ])
        );
    }

    private isZodSchema(
        schema: z.ZodSchema | SchemaSnapshot
    ): schema is z.ZodSchema {
        return '_def' in schema;
    }

    private zodTypeToSQL(zodDef: any): string {
        if (!zodDef || !zodDef._def) {
            return 'TEXT';
        }

        const typeName = zodDef._def.typeName;
        
        switch (typeName) {
            case 'ZodString':
                return 'TEXT';
            case 'ZodNumber':
                return 'REAL';
            case 'ZodBigInt':
                return 'INTEGER';
            case 'ZodBoolean':
                return 'INTEGER';
            case 'ZodDate':
                return 'TEXT';
            case 'ZodArray':
            case 'ZodObject':
            case 'ZodRecord':
                return 'TEXT';
            case 'ZodOptional':
                return this.zodTypeToSQL(zodDef._def.innerType);
            case 'ZodNullable':
                return this.zodTypeToSQL(zodDef._def.innerType);
            case 'ZodUnion':
                const types = zodDef._def.options;
                if (types && types.length > 0) {
                    return this.zodTypeToSQL(types[0]);
                }
                return 'TEXT';
            default:
                return 'TEXT';
        }
    }

    private isFieldOptional(zodDef: any): boolean {
        if (!zodDef || !zodDef._def) {
            return true;
        }

        const typeName = zodDef._def.typeName;
        
        if (typeName === 'ZodOptional' || typeName === 'ZodNullable') {
            return true;
        }

        if (typeName === 'ZodUnion') {
            const options = zodDef._def.options;
            return options && options.some((opt: any) => 
                opt._def && (opt._def.typeName === 'ZodNull' || opt._def.typeName === 'ZodUndefined')
            );
        }

        return false;
    }

    async runMigration(
        collectionName: string, 
        oldVersion: number, 
        newVersion: number, 
        diff: SchemaDiff,
        schema: z.ZodSchema
    ): Promise<void> {
        if (diff.breaking) {
            throw new DatabaseError(
                `Breaking schema migration required for collection '${collectionName}' (v${oldVersion} → v${newVersion}): ${diff.breakingReasons.join(', ')}. Manual migration required.`,
                'BREAKING_MIGRATION'
            );
        }

        if (diff.alters.length === 0) {
            await this.setStoredVersionWithSnapshot(
                collectionName,
                newVersion,
                [],
                schema
            );
            return;
        }

        // Run migration operations - don't wrap in transaction since we might already be in one
        for (const alterSQL of diff.alters) {
            await this.driver.exec(alterSQL);
        }
        
        await this.setStoredVersionWithSnapshot(
            collectionName,
            newVersion,
            diff.alters,
            schema
        );
    }

    async checkAndRunMigration(
        collectionSchema: CollectionSchema,
        collection?: Collection<any>,
        database?: any
    ): Promise<void> {
        const { name, version = 1, schema, upgrade, seed } = collectionSchema;
        
        // Handle nested transaction errors gracefully by wrapping all migration operations
        try {
            await this.initializeMigrationsTable();
            const storedVersion = await this.getStoredVersion(name);
            
            if (storedVersion === version) {
                return;
            }
            
            if (storedVersion > version) {
                console.warn(
                    `Collection '${name}' has stored version ${storedVersion} which is higher than schema version ${version}. ` +
                    `This might happen when switching between git branches. No migration will be performed.`
                );
                return;
            }

            const oldSchema = storedVersion > 0
                ? await this.getStoredSchemaSnapshot(name)
                : null;

            const diff = this.generateSchemaDiff(oldSchema, schema, name);
        
        if (process.env.SKIBBADB_MIGRATE === 'print') {
            console.log(`Migration plan for ${name} (v${storedVersion} → v${version}):`);
            if (diff.breaking) {
                console.log('  BREAKING CHANGES:', diff.breakingReasons.join(', '));
            }
            for (const alter of diff.alters) {
                console.log(`  ${alter}`);
            }
            
            // Print upgrade functions plan
            if (upgrade && database && collection) {
                const upgradeRunner = new UpgradeRunner(this.driver, database);
                await upgradeRunner.printUpgradePlan(name, upgrade, storedVersion, version);
            }
            
            // Print seed function info
            if (storedVersion === 0 && seed) {
                console.log(`  Seed function: Will run after migration`);
            }
            
            return;
        }

        // Check if we're already in a transaction to avoid nested transaction issues
        const runMigrationOperations = async () => {
            // 1. Run automatic schema migrations (ALTER TABLE)
            await this.runMigration(name, storedVersion, version, diff, schema);
            
            // 2. Run custom upgrade functions
            if (upgrade && collection && database) {
                const upgradeRunner = new UpgradeRunner(this.driver, database);
                await upgradeRunner.runUpgrades(collection, upgrade, storedVersion, version);
            }
            
            // 3. Run seed function for new collections
            if (storedVersion === 0 && seed && collection) {
                const upgradeRunner = new UpgradeRunner(this.driver, database);
                await upgradeRunner.runSeedFunction(collection, seed);
            }
        };

        // Check if driver has transaction state tracking and use it
        const transactionDriver = this.driver as any;
        if (transactionDriver.isInTransaction) {
            // We're already in a transaction, run operations directly
            await runMigrationOperations();
        } else {
            // Not in a transaction, wrap in transaction for safety
            await this.driver.transaction(runMigrationOperations);
        }
        
        const hasChanges = diff.alters.length > 0 || upgrade || (storedVersion === 0 && seed);
        if (hasChanges) {
            console.log(`Migrated collection '${name}' from v${storedVersion} to v${version}`);
        }
        
        } catch (outerError) {
            if (outerError instanceof Error && (
                outerError.message.includes('cannot start a transaction within a transaction') ||
                outerError.message.includes('Failed to execute: SQLiteError: cannot start a transaction within a transaction')
            )) {
                // We're in a transaction context, skip migrations to avoid conflicts
                return;
            }
            throw outerError;
        }
    }

    async getMigrationStatus(): Promise<MigrationInfo[]> {
        await this.initializeMigrationsTable();
        
        const sql = `SELECT collection_name, version, completed_alters FROM ${Migrator.META_TABLE} ORDER BY collection_name`;
        const rows = await this.driver.query(sql);
        
        return rows.map(row => ({
            collectionName: row.collection_name,
            version: row.version,
            completedAlters: JSON.parse(row.completed_alters || '[]')
        }));
    }
}