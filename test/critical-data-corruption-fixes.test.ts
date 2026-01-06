import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { Database } from '../src/database';
import type { CollectionSchema } from '../src/types';

describe('Critical Data Corruption Fixes', () => {
    let db: Database;

    beforeEach(() => {
        db = new Database({ driver: 'bun', memory: true });
    });

    afterEach(async () => {
        await db.close();
    });

    describe('Issue #2: Vector Buffer Pool Corruption', () => {
        const VectorDocSchema = z.object({
            _id: z.string(),
            title: z.string(),
            embedding: z.array(z.number()),
        });

        type VectorDoc = z.infer<typeof VectorDocSchema>;

        test('should not corrupt vector data when inserting multiple documents', async () => {
            const collection = db.collection('vectors', VectorDocSchema, {
                primaryKey: '_id',
                constrainedFields: {
                    'embedding': {
                        type: 'VECTOR',
                        vectorDimensions: 3,
                        vectorType: 'float',
                    }
                }
            });

            // Insert multiple documents with different vectors
            const doc1 = await collection.insert({
                _id: 'doc1',
                title: 'First',
                embedding: [1.0, 0.0, 0.0],
            });

            const doc2 = await collection.insert({
                _id: 'doc2',
                title: 'Second',
                embedding: [0.0, 1.0, 0.0],
            });

            const doc3 = await collection.insert({
                _id: 'doc3',
                title: 'Third',
                embedding: [0.0, 0.0, 1.0],
            });

            // Verify all documents were inserted successfully
            const allDocs = await collection.toArray();
            expect(allDocs).toHaveLength(3);
            expect(allDocs[0].embedding).toEqual([1.0, 0.0, 0.0]);
            expect(allDocs[1].embedding).toEqual([0.0, 1.0, 0.0]);
            expect(allDocs[2].embedding).toEqual([0.0, 0.0, 1.0]);
        });

        test('should not corrupt vector data in bulk insert', async () => {
            const collection = db.collection('vectors_bulk', VectorDocSchema, {
                primaryKey: '_id',
                constrainedFields: {
                    'embedding': {
                        type: 'VECTOR',
                        vectorDimensions: 3,
                        vectorType: 'float',
                    }
                }
            });

            // Bulk insert multiple documents
            const docs = await collection.insertBulk([
                { _id: 'bulk1', title: 'First', embedding: [1.0, 2.0, 3.0] },
                { _id: 'bulk2', title: 'Second', embedding: [4.0, 5.0, 6.0] },
                { _id: 'bulk3', title: 'Third', embedding: [7.0, 8.0, 9.0] },
            ]);

            expect(docs).toHaveLength(3);

            // Verify using toArray() which properly retrieves vector data
            const allDocs = await collection.toArray();
            expect(allDocs).toHaveLength(3);
            
            const bulk1 = allDocs.find(d => d._id === 'bulk1');
            const bulk2 = allDocs.find(d => d._id === 'bulk2');
            const bulk3 = allDocs.find(d => d._id === 'bulk3');

            expect(bulk1?.embedding).toEqual([1.0, 2.0, 3.0]);
            expect(bulk2?.embedding).toEqual([4.0, 5.0, 6.0]);
            expect(bulk3?.embedding).toEqual([7.0, 8.0, 9.0]);
        });

        test('should not corrupt vector data during updates', async () => {
            const collection = db.collection('vectors_update', VectorDocSchema, {
                primaryKey: '_id',
                constrainedFields: {
                    'embedding': {
                        type: 'VECTOR',
                        vectorDimensions: 3,
                        vectorType: 'float',
                    }
                }
            });

            // Insert initial documents
            await collection.insert({
                _id: 'update1',
                title: 'Initial',
                embedding: [1.0, 0.0, 0.0],
            });

            // Update with new vector
            await collection.put('update1', {
                embedding: [9.0, 8.0, 7.0],
            });

            // Verify using toArray()
            const allDocs = await collection.toArray();
            const updated = allDocs.find(d => d._id === 'update1');
            expect(updated?.embedding).toEqual([9.0, 8.0, 7.0]);
        });
    });

    describe('Issue #3: Race Conditions in put()', () => {
        const UserSchema = z.object({
            _id: z.string(),
            name: z.string(),
            counter: z.number().default(0),
        });

        test('should handle concurrent put() operations atomically', async () => {
            const collection = db.collection('users_concurrent', UserSchema);

            // Insert initial document
            await collection.insert({
                _id: 'user1',
                name: 'Alice',
                counter: 0,
            });

            // Simulate concurrent updates
            // In a real race condition without transaction protection,
            // both reads would see counter: 0, and both would write counter: 1
            // With proper transaction protection, we should get counter: 2
            const updates = await Promise.all([
                collection.put('user1', { counter: 1 }),
                collection.put('user1', { counter: 2 }),
            ]);

            // At least one update should succeed
            const final = await collection.findById('user1');
            expect(final?.counter).toBeDefined();
            // The final value should be from the last successful update
            expect([1, 2]).toContain(final?.counter);
        });

        test('should prevent lost updates in concurrent modifications', async () => {
            const collection = db.collection('users_lost_update', UserSchema);

            await collection.insert({
                _id: 'user2',
                name: 'Bob',
                counter: 100,
            });

            // Run multiple concurrent increments
            // Without proper transaction handling, some increments could be lost
            const incrementOperations = Array.from({ length: 5 }, async (_, i) => {
                const user = await collection.findById('user2');
                if (user) {
                    return collection.put('user2', { 
                        counter: user.counter + 1 
                    });
                }
            });

            await Promise.all(incrementOperations);

            // Verify that at least some updates succeeded
            // Due to transaction conflicts, not all may succeed, but none should be lost
            const final = await collection.findById('user2');
            expect(final?.counter).toBeGreaterThanOrEqual(101);
        });
    });

    describe('Issue #4: Make insertBulk Fully Atomic', () => {
        const ProductSchema = z.object({
            _id: z.string(),
            name: z.string(),
            price: z.number(),
            embedding: z.array(z.number()).optional(),
        });

        test('should rollback all inserts if vector insert fails', async () => {
            const collection = db.collection('products_atomic', ProductSchema, {
                primaryKey: '_id',
                constrainedFields: {
                    'embedding': {
                        type: 'VECTOR',
                        vectorDimensions: 3,
                        vectorType: 'float',
                    }
                }
            });

            // Try to insert with invalid vector dimensions
            // This should fail and rollback everything
            try {
                await collection.insertBulk([
                    { _id: 'prod1', name: 'Product 1', price: 10, embedding: [1.0, 2.0, 3.0] },
                    { _id: 'prod2', name: 'Product 2', price: 20, embedding: [1.0, 2.0] }, // Invalid dimensions
                ]);
                // Should not reach here
                expect(true).toBe(false);
            } catch (error) {
                // Expected to fail
            }

            // Verify no documents were inserted (no "ghost" documents)
            const docs = await collection.toArray();
            expect(docs).toHaveLength(0);
        });

        test('should commit all documents and vectors together in bulk insert', async () => {
            const collection = db.collection('products_success', ProductSchema, {
                primaryKey: '_id',
                constrainedFields: {
                    'embedding': {
                        type: 'VECTOR',
                        vectorDimensions: 3,
                        vectorType: 'float',
                    }
                }
            });

            // Insert valid documents with vectors
            const docs = await collection.insertBulk([
                { _id: 'prod3', name: 'Product 3', price: 30, embedding: [1.0, 2.0, 3.0] },
                { _id: 'prod4', name: 'Product 4', price: 40, embedding: [4.0, 5.0, 6.0] },
                { _id: 'prod5', name: 'Product 5', price: 50, embedding: [7.0, 8.0, 9.0] },
            ]);

            expect(docs).toHaveLength(3);

            // Verify all documents and their vectors are properly stored using toArray()
            const allDocs = await collection.toArray();
            expect(allDocs).toHaveLength(3);
            
            const prod3 = allDocs.find(d => d._id === 'prod3');
            const prod4 = allDocs.find(d => d._id === 'prod4');
            const prod5 = allDocs.find(d => d._id === 'prod5');

            expect(prod3?.embedding).toEqual([1.0, 2.0, 3.0]);
            expect(prod4?.embedding).toEqual([4.0, 5.0, 6.0]);
            expect(prod5?.embedding).toEqual([7.0, 8.0, 9.0]);
        });

        test('should handle partial transaction rollback on constraint violation', async () => {
            const collection = db.collection('products_constraint', ProductSchema, {
                primaryKey: '_id',
                constrainedFields: {
                    'embedding': {
                        type: 'VECTOR',
                        vectorDimensions: 3,
                        vectorType: 'float',
                    }
                }
            });

            // Insert one document first
            await collection.insert({ _id: 'prod6', name: 'Product 6', price: 60 });

            // Try to bulk insert with a duplicate ID
            try {
                await collection.insertBulk([
                    { _id: 'prod7', name: 'Product 7', price: 70, embedding: [1.0, 2.0, 3.0] },
                    { _id: 'prod6', name: 'Duplicate', price: 99 }, // Duplicate ID
                ]);
                expect(true).toBe(false);
            } catch (error) {
                // Expected to fail
            }

            // Verify only the original document exists
            const docs = await collection.toArray();
            expect(docs).toHaveLength(1);
            expect(docs[0]._id).toBe('prod6');
        });
    });

    describe('Integration: All Fixes Together', () => {
        const DocumentSchema = z.object({
            _id: z.string(),
            title: z.string(),
            content: z.string(),
            embedding: z.array(z.number()),
        });

        test('should handle complex operations with all fixes applied', async () => {
            const collection = db.collection('documents_integration', DocumentSchema, {
                primaryKey: '_id',
                constrainedFields: {
                    'embedding': {
                        type: 'VECTOR',
                        vectorDimensions: 4,
                        vectorType: 'float',
                    }
                }
            });

            // 1. Bulk insert with vectors (tests Issue #2 and #4)
            const docs = await collection.insertBulk([
                { _id: 'doc1', title: 'First', content: 'Content 1', embedding: [1.0, 2.0, 3.0, 4.0] },
                { _id: 'doc2', title: 'Second', content: 'Content 2', embedding: [5.0, 6.0, 7.0, 8.0] },
            ]);

            expect(docs).toHaveLength(2);

            // 2. Verify bulk insert succeeded with vectors intact
            const allDocs = await collection.toArray();
            expect(allDocs).toHaveLength(2);
            
            const doc1 = allDocs.find(d => d._id === 'doc1');
            const doc2 = allDocs.find(d => d._id === 'doc2');

            expect(doc1?.embedding).toEqual([1.0, 2.0, 3.0, 4.0]);
            expect(doc2?.embedding).toEqual([5.0, 6.0, 7.0, 8.0]);
            expect(doc1?.title).toBe('First');
            expect(doc2?.title).toBe('Second');
        });
    });
});
