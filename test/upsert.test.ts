import { expect, test } from 'vitest';
import { z } from 'zod/v3';
import { createDB } from '../index';

// Test schemas for different complexity levels
const simpleSchema = z.object({
    _id: z.string().default(() => crypto.randomUUID()),
    name: z.string(),
    score: z.number(),
});

const constrainedSchema = z.object({
    _id: z.string().default(() => crypto.randomUUID()),
    email: z.string().email(),
    username: z.string(),
    score: z.number(),
});

const complexSchema = z.object({
    _id: z.string().default(() => crypto.randomUUID()),
    name: z.string(),
    email: z.string().email(),
    age: z.number().int(),
    score: z.number(),
    isActive: z.boolean().default(true),
    metadata: z
        .object({
            level: z.enum(['junior', 'mid', 'senior', 'lead']),
            location: z.string(),
            skills: z.array(z.string()),
        })
        .optional(),
});

interface PerformanceResult {
    operation: string;
    count: number;
    totalDuration: number;
    avgDuration: number;
    opsPerSecond: number;
}

function benchmark(
    name: string,
    count: number,
    fn: () => void
): PerformanceResult {
    const start = performance.now();
    fn();
    const end = performance.now();
    const duration = end - start;
    const opsPerSecond = Math.round((count / duration) * 1000);
    const avgDuration = duration / count;

    return {
        operation: name,
        count,
        totalDuration: duration,
        avgDuration,
        opsPerSecond,
    };
}

async function analyzeUpsertPerformance() {
    console.log('=== Upsert Performance Analysis ===\n');

    const db = createDB({ memory: true });
    const results: PerformanceResult[] = [];

    // Test 1: Simple upserts (50% insert, 50% update)
    console.log('1. Testing simple upserts (50% insert, 50% update)...');
    const simpleCollection = db.collection('simple', simpleSchema);

    // Pre-populate with 500 documents
    const preData = Array.from({ length: 500 }, (_, i) => ({
        name: `User ${i}`,
        score: Math.random() * 1000,
    }));
    const preInserted = await simpleCollection.bulk.insert(preData);
    const existingIds = preInserted.map((doc) => doc._id!);

    // Generate test data: 500 existing IDs (updates) + 500 new IDs (inserts)
    const newIds = Array.from({ length: 500 }, () => crypto.randomUUID());
    const allIds = [...existingIds, ...newIds];

    const simpleUpsertResult = benchmark(
        'Simple Upserts (Mixed Insert/Update)',
        1000,
        () => {
            allIds.forEach((id, i) => {
                simpleCollection.upsertSync(id, {
                    name: `Updated User ${i}`,
                    score: i * 10,
                });
            });
        }
    );
    results.push(simpleUpsertResult);

    // Test 2: Simple upsert bulk operations
    console.log('2. Testing simple upsert bulk operations...');
    const bulkUpsertData = allIds.map((id, i) => ({
        _id: id,
        doc: {
            name: `Bulk User ${i}`,
            score: i * 5,
        },
    }));

    const bulkUpsertResult = benchmark('Simple Bulk Upserts', 1, () => {
        simpleCollection.upsertBulkSync(bulkUpsertData);
    });
    results.push(bulkUpsertResult);

    // Test 3: Complex upserts with constraints
    console.log('3. Testing upserts with unique constraints...');
    const constrainedCollection = db.collection(
        'constrained',
        constrainedSchema
    );

    const constrainedPreData = Array.from({ length: 500 }, (_, i) => ({
        email: `user${i}@example.com`,
        username: `user${i}`,
        score: Math.random() * 1000,
    }));
    const constrainedPreInserted = await constrainedCollection.bulk.insert(
        constrainedPreData
    );
    const constrainedExistingIds = constrainedPreInserted.map(
        (doc) => doc._id!
    );

    const constrainedNewIds = Array.from({ length: 500 }, () =>
        crypto.randomUUID()
    );
    const constrainedAllIds = [...constrainedExistingIds, ...constrainedNewIds];

    const constrainedUpsertResult = benchmark(
        'Constrained Upserts',
        1000,
        () => {
            constrainedAllIds.forEach((id, i) => {
                constrainedCollection.upsertSync(id, {
                    email: `updated${i}@example.com`,
                    username: `updated${i}`,
                    score: i * 15,
                });
            });
        }
    );
    results.push(constrainedUpsertResult);

    // Test 4: Complex schema upserts
    console.log('4. Testing complex schema upserts...');
    const complexCollection = db.collection('complex', complexSchema);

    const complexPreData = Array.from({ length: 500 }, (_, i) => ({
        name: `Complex User ${i}`,
        email: `complex${i}@example.com`,
        age: 20 + (i % 50),
        score: Math.random() * 1000,
        isActive: i % 2 === 0,
        metadata:
            i % 3 === 0
                ? {
                      level: (['junior', 'mid', 'senior', 'lead'] as const)[
                          i % 4
                      ],
                      location: `City ${i % 10}`,
                      skills: [`skill${i % 5}`, `skill${(i + 1) % 5}`],
                  }
                : undefined,
    }));
    const complexPreInserted = await complexCollection.bulk.insert(
        complexPreData
    );
    const complexExistingIds = complexPreInserted.map((doc) => doc._id!);

    const complexNewIds = Array.from({ length: 500 }, () =>
        crypto.randomUUID()
    );
    const complexAllIds = [...complexExistingIds, ...complexNewIds];

    const complexUpsertResult = benchmark(
        'Complex Schema Upserts',
        1000,
        () => {
            complexAllIds.forEach((id, i) => {
                complexCollection.upsertSync(id, {
                    name: `Updated Complex User ${i}`,
                    email: `updatedcomplex${i}@example.com`,
                    age: 25 + (i % 40),
                    score: i * 20,
                    isActive: i % 3 === 0,
                    metadata:
                        i % 2 === 0
                            ? {
                                  level: (
                                      [
                                          'junior',
                                          'mid',
                                          'senior',
                                          'lead',
                                      ] as const
                                  )[(i + 1) % 4],
                                  location: `Updated City ${i % 8}`,
                                  skills: [
                                      `newskill${i % 7}`,
                                      `newskill${(i + 2) % 7}`,
                                  ],
                              }
                            : undefined,
                });
            });
        }
    );
    results.push(complexUpsertResult);

    // Test 5: Mixed operation performance comparison
    console.log('5. Testing mixed operation performance...');
    const mixedResult = benchmark('Mixed Operations Comparison', 1000, () => {
        existingIds.slice(0, 250).forEach((id, i) => {
            simpleCollection.upsertSync(id, {
                name: `Mixed User ${i}`,
                score: i * 8,
            });
        });

        newIds.slice(0, 250).forEach((doc, i) => {
            simpleCollection.upsertSync(doc, {
                name: `New Mixed User ${i}`,
                score: i * 12,
            });
        });

        existingIds.slice(250, 500).forEach((id, i) => {
            if (i % 2 === 0) {
                simpleCollection.putSync(id, {
                    score: i * 20,
                });
            } else {
                simpleCollection.insertSync({
                    name: `Insert User ${i}`,
                    score: i * 25,
                });
            }
        });

        const mixedBulkData = newIds.slice(250, 500).map((id, i) => ({
            _id: id,
            doc: {
                name: `Bulk Mixed User ${i}`,
                score: i * 18,
            },
        }));
        simpleCollection.upsertBulkSync(mixedBulkData);
    });
    results.push(mixedResult);

    // Print results
    console.log('\n=== PERFORMANCE RESULTS ===');
    results.forEach((result) => {
        console.log(`\n${result.operation}:`);
        console.log(`  Operations: ${result.count.toLocaleString()}`);
        console.log(`  Total Time: ${result.totalDuration.toFixed(2)}ms`);
        console.log(`  Avg Time: ${result.avgDuration.toFixed(4)}ms`);
        console.log(`  Ops/sec: ${result.opsPerSecond.toLocaleString()}`);
    });

    // Clean up database
    db.close();

    return results;
}

test('Upsert Performance Analysis > should analyze upsert performance characteristics', async () => {
    const results = await analyzeUpsertPerformance();

    // Verify that we got results
    expect(results).toBeDefined();
    expect(results.length).toBeGreaterThan(0);

    // Verify each result has expected properties
    results.forEach((result) => {
        expect(result.operation).toBeDefined();
        expect(result.count).toBeGreaterThan(0);
        expect(result.totalDuration).toBeGreaterThan(0);
        expect(result.opsPerSecond).toBeGreaterThan(0);
    });

    // Verify reasonable performance (should complete operations)
    const simpleUpsertResult = results.find((r) =>
        r.operation.includes('Simple Upserts')
    );
    expect(simpleUpsertResult).toBeDefined();
    expect(simpleUpsertResult!.opsPerSecond).toBeGreaterThan(100); // At least 100 ops/sec
}, 30000);

test('Upsert Performance Analysis > should test basic upsert functionality', async () => {
    const db = createDB({ memory: true });
    try {
        const collection = db.collection('test', simpleSchema);

        const testId = crypto.randomUUID();

        // Test insert via upsert
        const insertResult = await collection.upsert(testId, {
            name: 'Test User',
            score: 100,
        });

        expect(insertResult._id).toBe(testId);
        expect(insertResult.name).toBe('Test User');
        expect(insertResult.score).toBe(100);

        // Test update via upsert
        const updateResult = await collection.upsert(testId, {
            name: 'Updated User',
            score: 200,
        });

        expect(updateResult._id).toBe(testId);
        expect(updateResult.name).toBe('Updated User');
        expect(updateResult.score).toBe(200);

        // Verify final state
        const finalDoc = await collection.get(testId);
        expect(finalDoc).toBeDefined();
        expect(finalDoc!.score).toBe(200);
    } finally {
        db.close();
    }
});

test('Upsert Performance Analysis > should test bulk upsert functionality', async () => {
    const db = createDB({ memory: true });
    try {
        const collection = db.collection('bulk_test', simpleSchema);

        const testData = Array.from({ length: 100 }, (_, i) => ({
            _id: crypto.randomUUID(),
            doc: {
                name: `Bulk User ${i}`,
                score: i * 10,
            },
        }));

        // Test bulk upsert (all inserts)
        const insertResults = await collection.upsertBulk(testData);
        expect(insertResults).toHaveLength(100);

        // Test bulk upsert (all updates)
        const updateData = testData.map(({ _id }, i) => ({
            _id,
            doc: {
                name: `Updated Bulk User ${i}`,
                score: i * 20,
            },
        }));

        const updateResults = await collection.upsertBulk(updateData);
        expect(updateResults).toHaveLength(100);

        // Verify final state
        const allDocs = await collection.all();
        expect(allDocs).toHaveLength(100);
        expect(allDocs[0].name).toContain('Updated');
    } finally {
        db.close();
    }
});
