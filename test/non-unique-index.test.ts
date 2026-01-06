import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { createDB } from '../src';

describe('Non-Unique Index Support (Issue 3.3)', () => {
    let db: any;

    beforeEach(() => {
        db = createDB({ memory: true });
    });

    it('should create non-unique index on constrained field', async () => {
        const schema = z.object({
            _id: z.string(),
            name: z.string(),
            age: z.number(),
            email: z.string(),
        });

        const collection = db.collection('users', schema, {
            constrainedFields: {
                age: { type: 'INTEGER', index: true },
                email: { type: 'TEXT', unique: true },
            },
        });

        await collection.waitForInitialization();

        // Get driver to check index existence
        const driver = await db.ensureDriver();
        
        // Check that non-unique index was created for age
        const indexes = await driver.query(
            "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='users' ORDER BY name"
        );
        
        // Should have index for age (non-unique) and email (unique)
        const indexNames = indexes.map((idx: any) => idx.name);
        expect(indexNames).toContain('idx_users_age');
        
        // Verify age index is not unique
        const ageIndex = indexes.find((idx: any) => idx.name === 'idx_users_age');
        expect(ageIndex).toBeDefined();
        expect(ageIndex.sql).toContain('CREATE INDEX');
        expect(ageIndex.sql).not.toContain('UNIQUE');
    });

    it('should not create duplicate index when field is unique', async () => {
        const schema = z.object({
            _id: z.string(),
            email: z.string(),
        });

        const collection = db.collection('users', schema, {
            constrainedFields: {
                // Both unique and index - should only create unique index
                email: { type: 'TEXT', unique: true, index: true },
            },
        });

        await collection.waitForInitialization();

        const driver = await db.ensureDriver();
        const indexes = await driver.query(
            "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='users'"
        );
        
        // Should not have created idx_users_email because unique already provides an index
        const nonUniqueEmailIndex = indexes.find((idx: any) => 
            idx.name === 'idx_users_email'
        );
        
        expect(nonUniqueEmailIndex).toBeUndefined();
    });

    it('should use non-unique index in query plan', async () => {
        const schema = z.object({
            _id: z.string(),
            age: z.number(),
            name: z.string(),
        });

        const collection = db.collection('users', schema, {
            constrainedFields: {
                age: { type: 'INTEGER', index: true },
            },
        });

        await collection.waitForInitialization();

        // Insert test data
        collection.insertSync({ _id: '1', age: 25, name: 'Alice' });
        collection.insertSync({ _id: '2', age: 30, name: 'Bob' });
        collection.insertSync({ _id: '3', age: 25, name: 'Charlie' });

        const driver = await db.ensureDriver();
        
        // Check query plan for indexed field
        const plan = await driver.query(
            "EXPLAIN QUERY PLAN SELECT * FROM users WHERE age > 20"
        );
        
        // Query plan should mention the index
        const planText = JSON.stringify(plan);
        expect(planText).toContain('idx_users_age');
    });

    it('should allow multiple non-unique values with index', async () => {
        const schema = z.object({
            _id: z.string(),
            category: z.string(),
            title: z.string(),
        });

        const collection = db.collection('items', schema, {
            constrainedFields: {
                category: { type: 'TEXT', index: true },
            },
        });

        await collection.waitForInitialization();

        // Insert multiple items with same category (should work with non-unique index)
        collection.insertSync({ _id: '1', category: 'books', title: 'Book 1' });
        collection.insertSync({ _id: '2', category: 'books', title: 'Book 2' });
        collection.insertSync({ _id: '3', category: 'books', title: 'Book 3' });

        // All inserts should succeed
        const results = collection.where('category').eq('books').toArraySync();
        expect(results).toHaveLength(3);
    });

    it('should create indexes for multiple fields', async () => {
        const schema = z.object({
            _id: z.string(),
            age: z.number(),
            city: z.string(),
            active: z.boolean(),
        });

        const collection = db.collection('users', schema, {
            constrainedFields: {
                age: { type: 'INTEGER', index: true },
                city: { type: 'TEXT', index: true },
                active: { type: 'INTEGER', index: true },
            },
        });

        await collection.waitForInitialization();

        const driver = await db.ensureDriver();
        const indexes = await driver.query(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='users' ORDER BY name"
        );
        
        const indexNames = indexes.map((idx: any) => idx.name);
        expect(indexNames).toContain('idx_users_age');
        expect(indexNames).toContain('idx_users_city');
        expect(indexNames).toContain('idx_users_active');
    });

    it('should work without index property (backward compatibility)', async () => {
        const schema = z.object({
            _id: z.string(),
            name: z.string(),
        });

        // No index specified - should still work
        const collection = db.collection('users', schema, {
            constrainedFields: {
                name: { type: 'TEXT' },
            },
        });

        await collection.waitForInitialization();

        const driver = await db.ensureDriver();
        const indexes = await driver.query(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='users' AND name LIKE 'idx_%'"
        );
        
        // No non-unique indexes should be created
        expect(indexes).toHaveLength(0);
    });
});
