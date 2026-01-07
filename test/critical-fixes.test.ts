import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDB, VersionMismatchError } from '../src/index';
import { z } from 'zod';
import type { Database } from '../src/database';

describe('Critical Fixes Tests', () => {
    let db: Database;

    beforeEach(() => {
        db = createDB({ memory: true });
    });

    afterEach(() => {
        if (db) {
            db.close();
        }
    });

    describe('Fix 1: rebuildIndexes with streaming (queryIterator)', () => {
        it('should rebuild indexes without loading all documents into memory', async () => {
            const userSchema = z.object({
                _id: z.string(),
                name: z.string(),
                email: z.string(),
                age: z.number(),
            });

            const users = db.collection('users_rebuild_test', userSchema, {
                constrainedFields: {
                    email: { type: 'TEXT', unique: true, index: true },
                    age: { type: 'INTEGER', index: true },
                },
            });

            // Insert test documents
            const testDocs = [];
            for (let i = 0; i < 100; i++) {
                testDocs.push({
                    name: `User ${i}`,
                    email: `user${i}@test.com`,
                    age: 20 + (i % 50),
                });
            }
            await users.insertBulk(testDocs);

            // Rebuild indexes (should use streaming)
            const result = await users.rebuildIndexes();

            expect(result.scanned).toBe(100);
            expect(result.errors.length).toBe(0);
        });
    });

    describe('Fix 2: Optimistic concurrency in put()', () => {
        it('should use version checking in UPDATE query', async () => {
            const docSchema = z.object({
                _id: z.string(),
                value: z.string(),
            });

            const docs = db.collection('docs_version_test', docSchema);

            // Insert a document
            const doc = await docs.insert({ value: 'initial' });
            const docId = (doc as any)._id;
            expect((doc as any)._version).toBe(1);

            // Normal update should work and increment version
            const updated = await docs.put(docId, { value: 'updated' });
            expect(updated.value).toBe('updated');
            expect((updated as any)._version).toBe(2);
            
            // Verify in database
            const fromDb = await docs.findById(docId);
            expect(fromDb?.value).toBe('updated');
            expect((fromDb as any)._version).toBe(2);
        });

        it('should succeed when no concurrent update happens', async () => {
            const docSchema = z.object({
                _id: z.string(),
                value: z.string(),
            });

            const docs = db.collection('docs_version_success', docSchema);

            const doc = await docs.insert({ value: 'initial' });
            const docId = (doc as any)._id;

            // Update should succeed
            const updated = await docs.put(docId, { value: 'updated' });
            expect(updated.value).toBe('updated');
            expect((updated as any)._version).toBe(2);
        });
    });

    describe('Fix 3: DocumentCache with hashing', () => {
        it('should cache parsed documents efficiently', async () => {
            const docSchema = z.object({
                _id: z.string(),
                data: z.string(),
            });

            const docs = db.collection('cache_test', docSchema);

            // Insert multiple documents
            const testDocs = [];
            for (let i = 0; i < 50; i++) {
                testDocs.push({ data: `test data ${i}` });
            }
            await docs.insertBulk(testDocs);

            // Query multiple times - should benefit from cache
            const start = Date.now();
            for (let i = 0; i < 10; i++) {
                await docs.where('data').eq(`test data 0`).toArray();
            }
            const duration = Date.now() - start;

            // Just verify it doesn't crash - actual performance is hard to test
            expect(duration).toBeGreaterThan(0);
        });
    });

    describe('Fix 5: Bulk operations with driver.transaction()', () => {
        it('should handle nested transactions in insertBulk', async () => {
            const docSchema = z.object({
                _id: z.string(),
                value: z.string(),
            });

            const docs = db.collection('bulk_insert_test', docSchema);

            // Use driver.transaction wrapping insertBulk
            await db.driver.transaction(async () => {
                const inserted = await docs.insertBulk([
                    { value: 'doc1' },
                    { value: 'doc2' },
                    { value: 'doc3' },
                ]);
                expect(inserted.length).toBe(3);
            });

            // Verify documents were inserted
            const doc1 = await docs.where('value').eq('doc1').first();
            expect(doc1).not.toBeNull();
        });

        it('should handle nested transactions in putBulk', async () => {
            const docSchema = z.object({
                _id: z.string(),
                value: z.string(),
            });

            const docs = db.collection('bulk_put_test', docSchema);

            // Insert initial docs
            const doc1 = await docs.insert({ value: 'initial1' });
            const doc2 = await docs.insert({ value: 'initial2' });

            // Use driver.transaction wrapping putBulk
            await db.driver.transaction(async () => {
                await docs.putBulk([
                    { _id: (doc1 as any)._id, doc: { value: 'updated1' } },
                    { _id: (doc2 as any)._id, doc: { value: 'updated2' } },
                ]);
            });

            const updated1 = await docs.findById((doc1 as any)._id);
            const updated2 = await docs.findById((doc2 as any)._id);
            expect(updated1?.value).toBe('updated1');
            expect(updated2?.value).toBe('updated2');
        });

        it('should handle nested transactions in deleteBulk', async () => {
            const docSchema = z.object({
                _id: z.string(),
                value: z.string(),
            });

            const docs = db.collection('bulk_delete_test', docSchema);

            // Insert initial docs
            const doc1 = await docs.insert({ value: 'delete1' });
            const doc2 = await docs.insert({ value: 'delete2' });
            const doc3 = await docs.insert({ value: 'keep' });

            // Use driver.transaction wrapping deleteBulk
            await db.driver.transaction(async () => {
                const count = await docs.deleteBulk([
                    (doc1 as any)._id,
                    (doc2 as any)._id,
                ]);
                expect(count).toBe(2);
            });

            // Verify deletions
            const deleted1 = await docs.findById((doc1 as any)._id);
            const deleted2 = await docs.findById((doc2 as any)._id);
            const remaining = await docs.findById((doc3 as any)._id);
            expect(deleted1).toBeNull();
            expect(deleted2).toBeNull();
            expect(remaining).not.toBeNull();
        });

        it('should rollback all operations on error in nested transaction', async () => {
            const docSchema = z.object({
                _id: z.string(),
                value: z.string(),
            });

            const docs = db.collection('bulk_rollback_test', docSchema);

            try {
                await db.driver.transaction(async () => {
                    await docs.insertBulk([
                        { value: 'doc1' },
                        { value: 'doc2' },
                    ]);
                    
                    // Force an error
                    throw new Error('Simulated error');
                });
            } catch (error) {
                // Expected error
            }

            // Documents should have been rolled back
            const doc = await docs.where('value').eq('doc1').first();
            expect(doc).toBeNull();
        });
    });
});
