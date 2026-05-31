import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { z } from 'zod/v3';
import { createDB } from '../src/index.js';
import type { Database } from '../src/database.js';
import { parseDoc, stringifyDoc } from '../src/json-utils.js';

describe('code-review-2 regressions', () => {
    let db: Database;

    beforeEach(() => {
        db = createDB({ memory: true });
    });

    afterEach(async () => {
        await db.close();
    });

    test('atomic updates chain repeated $inc and $push operations against the latest document state', async () => {
        const collection = db.collection(
            'atomic_review',
            z.object({
                _id: z.string(),
                count: z.number().optional(),
                tags: z.array(z.string()).optional(),
            })
        );
        await collection.waitForInitialization();

        const inserted = await collection.insert({ count: 1, tags: ['a'] });
        await collection.atomic.update(inserted._id, {
            $inc: { count: 2 },
            $push: { tags: 'b' },
        });
        await collection.atomic.update(inserted._id, {
            $inc: { count: 3 },
            $push: { tags: 'c' },
        });

        const updated = await collection.get(inserted._id);
        expect(updated?.count).toBe(6);
        expect(updated?.tags).toEqual(['a', 'b', 'c']);
    });

    test('atomic $inc on a missing field starts from zero', async () => {
        const collection = db.collection(
            'atomic_inc_missing',
            z.object({
                _id: z.string(),
                count: z.number().nullable().optional(),
            })
        );
        await collection.waitForInitialization();

        const inserted = await collection.insert({});
        await collection.atomic.update(inserted._id, {
            $inc: { count: 5 },
        });

        const updated = await collection.get(inserted._id);
        expect(updated?.count).toBe(5);
    });

    test('delete returns false for missing documents and deleteBulk counts only real deletions', async () => {
        const collection = db.collection(
            'delete_review',
            z.object({
                _id: z.string(),
                name: z.string(),
            })
        );
        await collection.waitForInitialization();

        const inserted = await collection.insert({ name: 'kept' });
        expect(await collection.delete('missing-id')).toBe(false);
        expect(await collection.bulk.delete([inserted._id, 'missing-id'])).toBe(1);
    });

    test('deleteBulk handles duplicate ids as one deleted document', async () => {
        const deletedIds: string[] = [];
        db.use({
            name: 'delete-hook-recorder',
            version: '1.0.0',
            onAfterDelete(context) {
                deletedIds.push(context.result._id);
            },
        });

        const collection = db.collection(
            'duplicate_delete_review',
            z.object({
                _id: z.string(),
                name: z.string(),
            })
        );
        await collection.waitForInitialization();

        const inserted = await collection.insert({ name: 'duplicate' });
        const count = await collection.bulk.delete([inserted._id, inserted._id]);

        expect(count).toBe(1);
        expect(deletedIds).toEqual([inserted._id]);
    });

    test('empty IN filters short-circuit instead of producing invalid SQL', async () => {
        const collection = db.collection(
            'empty_in_review',
            z.object({
                _id: z.string(),
                name: z.string(),
            })
        );
        await collection.waitForInitialization();

        await collection.insert({ name: 'alpha' });

        expect(collection.where('name').in([] as string[]).toArraySync()).toEqual([]);
        expect(collection.where('name').nin([] as string[]).toArraySync()).toHaveLength(1);
    });

    test('stringifyDoc preserves nullish and rich values while rejecting circular references', () => {
        const value = {
            plainNull: null,
            maybeUndefined: undefined,
            meta: new Map([['a', 1]]),
            tags: new Set(['x', 'y']),
        };

        const roundTrip = parseDoc(stringifyDoc(value));
        expect(roundTrip.plainNull).toBeNull();
        expect(roundTrip.maybeUndefined).toBeUndefined();
        expect(Array.from(roundTrip.meta.entries())).toEqual([['a', 1]]);
        expect(Array.from(roundTrip.tags.values())).toEqual(['x', 'y']);

        const circular: any = {};
        circular.self = circular;
        expect(() => stringifyDoc(circular)).toThrow('circular references');
    });
});
