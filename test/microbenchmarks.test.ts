import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod/v3';
import { skibba } from '../src/skibba';

const schema = z.object({
    id: z.string().optional(),
    name: z.string(),
    email: z.string(),
    age: z.number().optional(),
});

function timeMs(fn: () => void | Promise<void>): Promise<number> {
    const start = performance.now();
    const result = fn();
    if (result instanceof Promise) {
        return result.then(() => performance.now() - start);
    }
    return Promise.resolve(performance.now() - start);
}

describe('Microbenchmarks', () => {
    let db: ReturnType<typeof skibba>;
    let col: any;

    beforeEach(() => {
        db = skibba(':memory:');
        col = db.collection('bench', schema, { id: 'id' });
    });

    afterEach(async () => {
        await db.close();
    });

    it('basic DB open time', () => {
        const start = performance.now();
        const testDb = skibba(':memory:');
        const elapsed = performance.now() - start;
        testDb.closeSync();
        expect(elapsed).toBeLessThan(1000); // should be under 1s
    });

    it('insert 1 row', async () => {
        const elapsed = await timeMs(() =>
            col.insert({ name: 'Test', email: 'test@bench.com' })
        );
        expect(elapsed).toBeLessThan(1000);
    });

    it('insert 1,000 rows', async () => {
        const docs = Array.from({ length: 1000 }, (_, i) => ({
            name: `User${i}`,
            email: `user${i}@bench.com`,
            age: i,
        }));
        const elapsed = await timeMs(() => col.bulk.insert(docs));
        expect(elapsed).toBeLessThan(10000);
    });

    it('upsert 1,000 rows', async () => {
        const items = Array.from({ length: 1000 }, (_, i) => ({
            _id: `upsert-${i}`,
            doc: { name: `Upsert${i}`, email: `upsert${i}@bench.com`, age: i },
        }));
        const elapsed = await timeMs(() => col.bulk.upsert(items));
        expect(elapsed).toBeLessThan(10000);
    });

    it('delete 1,000 rows', async () => {
        // Insert first
        const docs = Array.from({ length: 1000 }, (_, i) => ({
            name: `Del${i}`,
            email: `del${i}@bench.com`,
        }));
        const inserted = await col.bulk.insert(docs);
        const ids = inserted.map((d: any) => d.id);

        const elapsed = await timeMs(() => col.bulk.delete(ids));
        expect(elapsed).toBeLessThan(10000);
    });

    it('simple query', async () => {
        await col.insert({ name: 'QueryTest', email: 'query@bench.com' });
        const elapsed = await timeMs(() =>
            col.where('name').eq('QueryTest').first()
        );
        expect(elapsed).toBeLessThan(1000);
    });

    it('QueryBuilder chained query', async () => {
        for (let i = 0; i < 100; i++) {
            await col.insert({ name: `Chain${i}`, email: `chain${i}@bench.com`, age: i });
        }
        const elapsed = await timeMs(() =>
            col.where('age').gte(50).orderBy('name', 'desc').limit(10).all()
        );
        expect(elapsed).toBeLessThan(1000);
    });
});
