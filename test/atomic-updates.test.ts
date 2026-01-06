import { test, expect, describe, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import {
    createDB,
    ValidationError,
    VersionMismatchError,
    NotFoundError,
} from '../src/index.js';
import type { Database } from '../src/database.js';

const counterSchema = z.object({
    _id: z.string().uuid(),
    name: z.string(),
    count: z.number().int().default(0),
    views: z.number().int().default(0),
    metadata: z.object({
        tags: z.array(z.string()).optional(),
        score: z.number().optional(),
    }).optional(),
});

describe('Atomic Update Operators', () => {
    let db: Database;

    beforeEach(() => {
        db = createDB({ memory: true });
    });

    afterEach(async () => {
        if (db) {
            await db.close();
        }
    });

    describe('$inc Operator', () => {
        test('should atomically increment a numeric field', async () => {
            const counters = db.collection('counters', counterSchema);

            const doc = await counters.insert({
                name: 'test-counter',
                count: 10,
                views: 0,
            });

            // Atomic increment
            const updated = await counters.atomicUpdate(doc._id, {
                $inc: { count: 5 }
            });

            expect(updated.count).toBe(15);
            expect(updated.views).toBe(0);
            expect(updated.name).toBe('test-counter');
        });

        test('should increment multiple fields atomically', async () => {
            const counters = db.collection('counters', counterSchema);

            const doc = await counters.insert({
                name: 'multi-counter',
                count: 10,
                views: 5,
            });

            const updated = await counters.atomicUpdate(doc._id, {
                $inc: { count: 3, views: 2 }
            });

            expect(updated.count).toBe(13);
            expect(updated.views).toBe(7);
        });

        test('should handle negative increments (decrement)', async () => {
            const counters = db.collection('counters', counterSchema);

            const doc = await counters.insert({
                name: 'dec-counter',
                count: 20,
                views: 10,
            });

            const updated = await counters.atomicUpdate(doc._id, {
                $inc: { count: -5, views: -3 }
            });

            expect(updated.count).toBe(15);
            expect(updated.views).toBe(7);
        });

        test('should increment nested fields', async () => {
            const counters = db.collection('counters', counterSchema);

            const doc = await counters.insert({
                name: 'nested-counter',
                count: 0,
                views: 0,
                metadata: { score: 10 },
            });

            const updated = await counters.atomicUpdate(doc._id, {
                $inc: { 'metadata.score': 5 }
            });

            expect(updated.metadata?.score).toBe(15);
        });

        test('should throw error for non-numeric increment', async () => {
            const counters = db.collection('counters', counterSchema);

            const doc = await counters.insert({
                name: 'invalid',
                count: 10,
                views: 0,
            });

            await expect(
                counters.atomicUpdate(doc._id, {
                    $inc: { count: 'invalid' as any }
                })
            ).rejects.toThrow();
        });
    });

    describe('$set Operator', () => {
        test('should atomically set a field value', async () => {
            const counters = db.collection('counters', counterSchema);

            const doc = await counters.insert({
                name: 'test',
                count: 10,
                views: 5,
            });

            const updated = await counters.atomicUpdate(doc._id, {
                $set: { name: 'updated-test' }
            });

            expect(updated.name).toBe('updated-test');
            expect(updated.count).toBe(10);
            expect(updated.views).toBe(5);
        });

        test('should set multiple fields atomically', async () => {
            const counters = db.collection('counters', counterSchema);

            const doc = await counters.insert({
                name: 'multi',
                count: 10,
                views: 5,
            });

            const updated = await counters.atomicUpdate(doc._id, {
                $set: { name: 'new-name', count: 100 }
            });

            expect(updated.name).toBe('new-name');
            expect(updated.count).toBe(100);
            expect(updated.views).toBe(5);
        });

        test('should set nested fields', async () => {
            const counters = db.collection('counters', counterSchema);

            const doc = await counters.insert({
                name: 'nested',
                count: 0,
                views: 0,
                metadata: { score: 10 },
            });

            const updated = await counters.atomicUpdate(doc._id, {
                $set: { 'metadata.score': 50 }
            });

            expect(updated.metadata?.score).toBe(50);
        });
    });

    describe('$push Operator', () => {
        test('should atomically append to array', async () => {
            const counters = db.collection('counters', counterSchema);

            const doc = await counters.insert({
                name: 'array-test',
                count: 0,
                views: 0,
                metadata: { tags: ['tag1', 'tag2'] },
            });

            const updated = await counters.atomicUpdate(doc._id, {
                $push: { 'metadata.tags': 'tag3' }
            });

            expect(updated.metadata?.tags).toEqual(['tag1', 'tag2', 'tag3']);
        });

        test('should push to empty array', async () => {
            const counters = db.collection('counters', counterSchema);

            const doc = await counters.insert({
                name: 'empty-array',
                count: 0,
                views: 0,
                metadata: { tags: [] },
            });

            const updated = await counters.atomicUpdate(doc._id, {
                $push: { 'metadata.tags': 'first-tag' }
            });

            expect(updated.metadata?.tags).toEqual(['first-tag']);
        });

        test('should push to non-existent array (create it)', async () => {
            const counters = db.collection('counters', counterSchema);

            const doc = await counters.insert({
                name: 'no-array',
                count: 0,
                views: 0,
            });

            const updated = await counters.atomicUpdate(doc._id, {
                $push: { 'metadata.tags': 'new-tag' }
            });

            expect(updated.metadata?.tags).toEqual(['new-tag']);
        });
    });

    describe('Combined Operators', () => {
        test('should apply multiple operators atomically', async () => {
            const counters = db.collection('counters', counterSchema);

            const doc = await counters.insert({
                name: 'combined',
                count: 10,
                views: 5,
                metadata: { tags: ['initial'], score: 10 },
            });

            const updated = await counters.atomicUpdate(doc._id, {
                $inc: { count: 5, 'metadata.score': 15 },
                $set: { name: 'combined-updated' },
                $push: { 'metadata.tags': 'new-tag' }
            });

            expect(updated.name).toBe('combined-updated');
            expect(updated.count).toBe(15);
            expect(updated.views).toBe(5);
            expect(updated.metadata?.score).toBe(25);
            expect(updated.metadata?.tags).toEqual(['initial', 'new-tag']);
        });
    });

    describe('With Constrained Fields', () => {
        test('should update constrained fields atomically', async () => {
            const products = db.collection('products', 
                z.object({
                    _id: z.string().uuid(),
                    name: z.string(),
                    price: z.number(),
                    stock: z.number().int(),
                }),
                {
                    constrainedFields: {
                        price: { type: 'REAL' },
                        stock: { type: 'INTEGER' },
                    }
                }
            );

            const product = await products.insert({
                name: 'Widget',
                price: 19.99,
                stock: 100,
            });

            const updated = await products.atomicUpdate(product._id, {
                $inc: { stock: -5 },
                $set: { price: 24.99 }
            });

            expect(updated.stock).toBe(95);
            expect(updated.price).toBe(24.99);
        });
    });

    describe('Error Handling', () => {
        test('should throw NotFoundError for non-existent document', async () => {
            const counters = db.collection('counters', counterSchema);

            await expect(
                counters.atomicUpdate('non-existent-id', {
                    $inc: { count: 1 }
                })
            ).rejects.toThrow(NotFoundError);
        });
    });

    describe('Sync Methods', () => {
        test('should work with atomicUpdateSync', () => {
            const counters = db.collection('counters', counterSchema);

            const doc = counters.insertSync({
                name: 'sync-test',
                count: 10,
                views: 0,
            });

            const updated = counters.atomicUpdateSync(doc._id, {
                $inc: { count: 5 }
            });

            expect(updated.count).toBe(15);
        });
    });
});
