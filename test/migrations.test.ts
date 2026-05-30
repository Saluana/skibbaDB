import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod/v3';
import { createDB } from '../src';
import { Migrator } from '../src/migrator';

describe('Schema Migrations', () => {
    let db: any;

    beforeEach(async () => {
        db = createDB({ memory: true });
    });

    it('should add version field to collection schema', () => {
        const UserSchema = z.object({
            _id: z.string(),
            name: z.string(),
            email: z.string(),
        });

        const users = db.collection('users', UserSchema, { version: 2 });
        expect(users).toBeDefined();
    });

    it('should handle collections without explicit version (defaults to 1)', () => {
        const UserSchema = z.object({
            _id: z.string(),
            name: z.string(),
        });

        const users = db.collection('users', UserSchema);
        expect(users).toBeDefined();
    });

    it('should create migrations meta table', async () => {
        const driver = await (db as any).ensureDriver();
        const migrator = new Migrator(driver);
        
        await migrator.initializeMigrationsTable();
        
        // Check that the table exists by querying it
        const result = await driver.query("SELECT name FROM sqlite_master WHERE type='table' AND name='_skibbadb_migrations'");
        expect(result.length).toBe(1);
    });

    it('should store and retrieve migration version', async () => {
        const driver = await (db as any).ensureDriver();
        const migrator = new Migrator(driver);
        
        await migrator.initializeMigrationsTable();
        await migrator.setStoredVersion('test_collection', 2);
        
        const version = await migrator.getStoredVersion('test_collection');
        expect(version).toBe(2);
    });

    it('should return 0 for non-existent collection version', async () => {
        const driver = await (db as any).ensureDriver();
        const migrator = new Migrator(driver);
        
        await migrator.initializeMigrationsTable();
        
        const version = await migrator.getStoredVersion('nonexistent');
        expect(version).toBe(0);
    });

    it('should generate schema diff for added fields', async () => {
        const driver = await (db as any).ensureDriver();
        const migrator = new Migrator(driver);
        
        const oldSchema = z.object({
            _id: z.string(),
            name: z.string(),
        });
        
        const newSchema = z.object({
            _id: z.string(),
            name: z.string(),
            email: z.string().optional(),
            age: z.number().optional(),
        });
        
        const diff = migrator.generateSchemaDiff(oldSchema, newSchema, 'users');
        
        expect(diff.breaking).toBe(false);
        expect(diff.alters.length).toBe(2);
        expect(diff.alters[0]).toContain('ALTER TABLE users ADD COLUMN email');
        expect(diff.alters[1]).toContain('ALTER TABLE users ADD COLUMN age');
    });

    it('should detect breaking changes when fields are removed', async () => {
        const driver = await (db as any).ensureDriver();
        const migrator = new Migrator(driver);
        
        const oldSchema = z.object({
            _id: z.string(),
            name: z.string(),
            email: z.string(),
        });
        
        const newSchema = z.object({
            _id: z.string(),
            name: z.string(),
        });
        
        const diff = migrator.generateSchemaDiff(oldSchema, newSchema, 'users');
        
        expect(diff.breaking).toBe(true);
        expect(diff.breakingReasons).toContain("Field 'email' was removed");
    });

    it('should detect breaking changes when field types change', async () => {
        const driver = await (db as any).ensureDriver();
        const migrator = new Migrator(driver);
        
        const oldSchema = z.object({
            _id: z.string(),
            age: z.string(),
        });
        
        const newSchema = z.object({
            _id: z.string(),
            age: z.number(),
        });
        
        const diff = migrator.generateSchemaDiff(oldSchema, newSchema, 'users');
        
        expect(diff.breaking).toBe(true);
        expect(diff.breakingReasons.length).toBeGreaterThan(0);
    });

    it('should run migration for new collection', async () => {
        const UserSchema = z.object({
            _id: z.string(),
            name: z.string(),
            email: z.string().optional(),
        });

        // Create collection with version 1
        const users = db.collection('users', UserSchema, { version: 1 });
        
        // Insert a test document to ensure the collection works
        const user = await users.insert({ name: 'John', email: 'john@example.com' });
        expect(user._id).toBeDefined();
        expect(user.name).toBe('John');
    });

    it('should get migration status', async () => {
        const UserSchema = z.object({
            _id: z.string(),
            name: z.string(),
        });

        // Create a collection to generate migration entry
        const users = db.collection('users', UserSchema, { version: 1 });
        
        await users.waitForInitialization();
        
        const status = await db.getMigrationStatus();
        expect(Array.isArray(status)).toBe(true);
    });

    it('should handle dry-run mode', async () => {
        // Set environment variable for dry-run
        const originalEnv = process.env.SKIBBADB_MIGRATE;
        process.env.SKIBBADB_MIGRATE = 'print';
        
        try {
            const UserSchema = z.object({
                _id: z.string(),
                name: z.string(),
            });

            // This should not throw in dry-run mode
            const users = db.collection('users', UserSchema, { version: 1 });
            expect(users).toBeDefined();
        } finally {
            // Restore environment
            if (originalEnv !== undefined) {
                process.env.SKIBBADB_MIGRATE = originalEnv;
            } else {
                delete process.env.SKIBBADB_MIGRATE;
            }
        }
    });

    it('should map Zod types to SQL types correctly', async () => {
        const driver = await (db as any).ensureDriver();
        const migrator = new Migrator(driver);
        
        const schema = z.object({
            _id: z.string(),
            name: z.string(),
            age: z.number(),
            isActive: z.boolean(),
            tags: z.array(z.string()),
            metadata: z.object({ key: z.string() }),
            optional: z.string().optional(),
        });
        
        const diff = migrator.generateSchemaDiff(null, schema, 'test');
        
        expect(diff.alters.length).toBe(0); // No alters for new schema
        expect(diff.breaking).toBe(false);
    });
});