import { describe, test, expect } from 'vitest';
import { createDB } from '../src/index';
import { z } from 'zod';

describe('JSONB Performance Benchmark', () => {
    test('Baseline: Measure insert and read performance for 5k documents', async () => {
        const db = createDB({ memory: true });
        const schema = z.object({ 
            id: z.string().optional(), 
            hugeData: z.array(z.number()) 
        });
        const collection = db.collection('benchmark', schema);

        // Generate a doc with a large array (simulate AST or large data structure)
        const bigDoc = { hugeData: Array(1000).fill(0).map((_, i) => i) };

        // Measure insert time
        console.time('Insert 5k documents');
        for (let i = 0; i < 5000; i++) {
            await collection.insert({ ...bigDoc });
        }
        console.timeEnd('Insert 5k documents');

        // Measure read time
        console.time('Read all 5k documents');
        const results = await collection.toArray();
        console.timeEnd('Read all 5k documents');

        // Verify we got all documents
        expect(results.length).toBe(5000);
        expect(results[0].hugeData.length).toBe(1000);

        console.log('Benchmark complete: 5000 documents with 1000-element arrays each');
    });

    test('Query performance: Filter on array length', async () => {
        const db = createDB({ memory: true });
        const schema = z.object({ 
            id: z.string().optional(),
            name: z.string(),
            items: z.array(z.number()) 
        });
        const collection = db.collection('query_benchmark', schema);

        // Insert documents with varying array sizes
        console.time('Insert 1k documents with varying sizes');
        for (let i = 0; i < 1000; i++) {
            await collection.insert({ 
                name: `doc-${i}`,
                items: Array(i % 100).fill(0).map((_, j) => j)
            });
        }
        console.timeEnd('Insert 1k documents with varying sizes');

        // Query documents where array has more than 50 items
        console.time('Query documents with large arrays (>50 items)');
        const largeArrayDocs = await collection
            .where('items')
            .arrayLength('gt', 50)
            .toArray();
        console.timeEnd('Query documents with large arrays (>50 items)');

        expect(largeArrayDocs.length).toBeGreaterThan(0);
        console.log(`Found ${largeArrayDocs.length} documents with >50 items`);
    });

    test('Update performance: Upsert documents', async () => {
        const db = createDB({ memory: true });
        const schema = z.object({ 
            id: z.string().optional(),
            counter: z.number(),
            data: z.array(z.number()) 
        });
        const collection = db.collection('update_benchmark', schema);

        // Insert 1000 documents first
        const ids: string[] = [];
        for (let i = 0; i < 1000; i++) {
            const doc = await collection.insert({ 
                counter: 0,
                data: Array(100).fill(0).map((_, j) => j)
            });
            ids.push(doc._id);
        }

        // Measure upsert time (should update existing documents)
        console.time('Upsert 1k documents');
        for (const id of ids) {
            await collection.upsert(id, { 
                counter: 1,
                data: Array(100).fill(1).map((_, j) => j)
            });
        }
        console.timeEnd('Upsert 1k documents');

        console.log('Upsert benchmark complete');
    });
});
