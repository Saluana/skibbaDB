import { expect, test } from 'vitest';
import { z } from 'zod/v3';
import { createDB } from '../index';

const testSchema = z.object({
    _id: z.string().optional(),
    name: z.string(),
    email: z.string().email(),
    score: z.number(),
    metadata: z
        .object({
            level: z.number(),
            tags: z.array(z.string()),
        })
        .optional(),
});

interface BenchmarkResult {
    operation: string;
    mode: 'sync' | 'async';
    count: number;
    totalTime: number;
    avgTime: number;
    opsPerSecond: number;
}

function benchmarkSync(
    name: string,
    count: number,
    fn: () => void
): BenchmarkResult {
    const start = performance.now();
    fn();
    const end = performance.now();
    const totalTime = end - start;

    return {
        operation: name,
        mode: 'sync',
        count,
        totalTime,
        avgTime: totalTime / count,
        opsPerSecond: Math.round((count / totalTime) * 1000),
    };
}

async function benchmarkAsync(
    name: string,
    count: number,
    fn: () => Promise<void>
): Promise<BenchmarkResult> {
    const start = performance.now();
    await fn();
    const end = performance.now();
    const totalTime = end - start;

    return {
        operation: name,
        mode: 'async',
        count,
        totalTime,
        avgTime: totalTime / count,
        opsPerSecond: Math.round((count / totalTime) * 1000),
    };
}

function printBenchmarkResult(result: BenchmarkResult) {
    console.log(`\n${result.operation} (${result.mode}):`);
    console.log(`  Operations: ${result.count}`);
    console.log(`  Total time: ${result.totalTime.toFixed(2)}ms`);
    console.log(`  Avg time: ${result.avgTime.toFixed(4)}ms`);
    console.log(`  Ops/sec: ${result.opsPerSecond.toLocaleString()}`);
}

function compareResults(
    syncResult: BenchmarkResult,
    asyncResult: BenchmarkResult
) {
    const speedup = asyncResult.opsPerSecond / syncResult.opsPerSecond;
    const faster = speedup > 1 ? 'async' : 'sync';
    const percentage = Math.abs((speedup - 1) * 100);

    console.log(`\nComparison (${syncResult.operation}):`);
    console.log(
        `  ${faster} is ${percentage.toFixed(1)}% ${
            speedup > 1 ? 'faster' : 'slower'
        }`
    );
    console.log(`  Sync: ${syncResult.opsPerSecond.toLocaleString()} ops/sec`);
    console.log(
        `  Async: ${asyncResult.opsPerSecond.toLocaleString()} ops/sec`
    );
}

test('Upsert Benchmark - Comprehensive Sync vs Async', async () => {
    console.log('=== Comprehensive Upsert Benchmark ===');

    const db = createDB({ memory: true });
    const collection = db.collection('benchmark', testSchema);

    // Test parameters
    const setupCount = 1000;
    const benchmarkCount = 500;

    console.log(`\nSetup: Creating ${setupCount} initial documents...`);

    // Setup: Create initial data for updates
    const setupData = Array.from({ length: setupCount }, (_, i) => ({
        name: `User ${i}`,
        email: `user${i}@example.com`,
        score: Math.floor(Math.random() * 1000),
        metadata:
            i % 3 === 0
                ? {
                      level: i % 10,
                      tags: [`tag${i % 5}`, `category${i % 3}`],
                  }
                : undefined,
    }));

    const setupDocs = await collection.insertBulk(setupData);
    const existingIds = setupDocs.map((doc) => doc._id!);

    // Generate test data: 50% updates (existing IDs) + 50% inserts (new IDs)
    const newIds = Array.from({ length: benchmarkCount }, () =>
        crypto.randomUUID()
    );
    const updateIds = existingIds.slice(0, benchmarkCount);
    const testIds = [...updateIds, ...newIds];

    console.log(
        `\nBenchmarking ${
            benchmarkCount * 2
        } operations (${benchmarkCount} updates + ${benchmarkCount} inserts)...`
    );

    // === Single Upsert Operations ===

    // Sync single upserts
    const syncSingleResult = benchmarkSync(
        'Single Upserts',
        testIds.length,
        () => {
            testIds.forEach((id, i) => {
                collection.upsertSync(id, {
                    name: `Updated User ${i}`,
                    email: `updated${i}@example.com`,
                    score: i * 10,
                    metadata:
                        i % 2 === 0
                            ? {
                                  level: i % 5,
                                  tags: [`updated${i % 3}`, `bench${i % 4}`],
                              }
                            : undefined,
                });
            });
        }
    );

    printBenchmarkResult(syncSingleResult);

    // Reset data for async test
    await collection.delete(updateIds[0]); // Trigger a small change to reset state

    // Async single upserts
    const asyncSingleResult = await benchmarkAsync(
        'Single Upserts',
        testIds.length,
        async () => {
            for (const [i, id] of testIds.entries()) {
                await collection.upsert(id, {
                    name: `Updated User ${i}`,
                    email: `updated${i}@example.com`,
                    score: i * 10,
                    metadata:
                        i % 2 === 0
                            ? {
                                  level: i % 5,
                                  tags: [`updated${i % 3}`, `bench${i % 4}`],
                              }
                            : undefined,
                });
            }
        }
    );

    printBenchmarkResult(asyncSingleResult);
    compareResults(syncSingleResult, asyncSingleResult);

    // Async concurrent upserts using Promise.all
    const asyncConcurrentResult = await benchmarkAsync(
        'Single Upserts (Concurrent)',
        testIds.length,
        async () => {
            const promises = testIds.map((id, i) =>
                collection.upsert(id, {
                    name: `Concurrent User ${i}`,
                    email: `concurrent${i}@example.com`,
                    score: i * 10,
                    metadata:
                        i % 2 === 0
                            ? {
                                  level: i % 5,
                                  tags: [
                                      `concurrent${i % 3}`,
                                      `parallel${i % 4}`,
                                  ],
                              }
                            : undefined,
                })
            );
            await Promise.all(promises);
        }
    );

    printBenchmarkResult(asyncConcurrentResult);

    console.log(`\nConcurrency Comparison:`);
    console.log(
        `  Sequential: ${asyncSingleResult.opsPerSecond.toLocaleString()} ops/sec`
    );
    console.log(
        `  Concurrent: ${asyncConcurrentResult.opsPerSecond.toLocaleString()} ops/sec`
    );
    const concurrentSpeedup =
        asyncConcurrentResult.opsPerSecond / asyncSingleResult.opsPerSecond;
    console.log(
        `  Concurrent is ${concurrentSpeedup.toFixed(1)}x ${
            concurrentSpeedup > 1 ? 'faster' : 'slower'
        } than sequential`
    );
    console.log(
        `  Concurrent vs Sync: ${(
            asyncConcurrentResult.opsPerSecond / syncSingleResult.opsPerSecond
        ).toFixed(1)}x speedup`
    );

    // === Bulk Upsert Operations ===

    const bulkUpsertData = testIds.map((id, i) => ({
        _id: id,
        doc: {
            name: `Bulk User ${i}`,
            email: `bulk${i}@example.com`,
            score: i * 5,
            metadata:
                i % 3 === 0
                    ? {
                          level: i % 7,
                          tags: [`bulk${i % 4}`, `test${i % 5}`],
                      }
                    : undefined,
        },
    }));

    // Sync bulk upserts
    const syncBulkResult = benchmarkSync('Bulk Upserts', 1, () => {
        collection.upsertBulkSync(bulkUpsertData);
    });

    printBenchmarkResult(syncBulkResult);

    // Async bulk upserts
    const asyncBulkResult = await benchmarkAsync(
        'Bulk Upserts',
        1,
        async () => {
            await collection.upsertBulk(bulkUpsertData);
        }
    );

    printBenchmarkResult(asyncBulkResult);
    compareResults(syncBulkResult, asyncBulkResult);

    // === Mixed Operations Performance ===

    // Test mixed insert/update performance
    const mixedTestIds = [
        ...existingIds.slice(0, benchmarkCount / 2), // Half updates
        ...Array.from({ length: benchmarkCount / 2 }, () =>
            crypto.randomUUID()
        ), // Half inserts
    ];

    // Sync mixed operations
    const syncMixedResult = benchmarkSync(
        'Mixed Insert/Update',
        mixedTestIds.length,
        () => {
            mixedTestIds.forEach((id, i) => {
                if (i % 4 === 0) {
                    // 25% pure inserts with new data
                    collection.insertSync({
                        name: `New User ${i}`,
                        email: `new${i}@example.com`,
                        score: i * 15,
                    });
                } else if (i % 4 === 1) {
                    // 25% updates using put
                    if (existingIds.includes(id)) {
                        collection.putSync(id, {
                            score: i * 20,
                        });
                    }
                } else {
                    // 50% upserts
                    collection.upsertSync(id, {
                        name: `Mixed User ${i}`,
                        email: `mixed${i}@example.com`,
                        score: i * 12,
                    });
                }
            });
        }
    );

    printBenchmarkResult(syncMixedResult);

    // Async mixed operations
    const asyncMixedResult = await benchmarkAsync(
        'Mixed Insert/Update',
        mixedTestIds.length,
        async () => {
            for (const [i, id] of mixedTestIds.entries()) {
                if (i % 4 === 0) {
                    // 25% pure inserts with new data
                    await collection.insert({
                        name: `New User ${i}`,
                        email: `new${i}@example.com`,
                        score: i * 15,
                    });
                } else if (i % 4 === 1) {
                    // 25% updates using put
                    if (existingIds.includes(id)) {
                        await collection.put(id, {
                            score: i * 20,
                        });
                    }
                } else {
                    // 50% upserts
                    await collection.upsert(id, {
                        name: `Mixed User ${i}`,
                        email: `mixed${i}@example.com`,
                        score: i * 12,
                    });
                }
            }
        }
    );

    printBenchmarkResult(asyncMixedResult);
    compareResults(syncMixedResult, asyncMixedResult);

    // Async concurrent mixed operations
    const asyncConcurrentMixedResult = await benchmarkAsync(
        'Mixed Insert/Update (Concurrent)',
        mixedTestIds.length,
        async () => {
            const promises = mixedTestIds.map((id, i) => {
                if (i % 4 === 0) {
                    // 25% pure inserts with new data
                    return collection.insert({
                        name: `Concurrent New User ${i}`,
                        email: `concurrentnew${i}@example.com`,
                        score: i * 15,
                    });
                } else if (i % 4 === 1) {
                    // 25% updates using put
                    if (existingIds.includes(id)) {
                        return collection.put(id, {
                            score: i * 25,
                        });
                    } else {
                        // Fallback to upsert if ID doesn't exist
                        return collection.upsert(id, {
                            name: `Fallback User ${i}`,
                            email: `fallback${i}@example.com`,
                            score: i * 25,
                        });
                    }
                } else {
                    // 50% upserts
                    return collection.upsert(id, {
                        name: `Concurrent Mixed User ${i}`,
                        email: `concurrentmixed${i}@example.com`,
                        score: i * 12,
                    });
                }
            });
            await Promise.all(promises);
        }
    );

    printBenchmarkResult(asyncConcurrentMixedResult);

    console.log(`\nMixed Operations Concurrency Comparison:`);
    console.log(
        `  Sequential: ${asyncMixedResult.opsPerSecond.toLocaleString()} ops/sec`
    );
    console.log(
        `  Concurrent: ${asyncConcurrentMixedResult.opsPerSecond.toLocaleString()} ops/sec`
    );
    const mixedConcurrentSpeedup =
        asyncConcurrentMixedResult.opsPerSecond / asyncMixedResult.opsPerSecond;
    console.log(
        `  Concurrent is ${mixedConcurrentSpeedup.toFixed(1)}x ${
            mixedConcurrentSpeedup > 1 ? 'faster' : 'slower'
        } than sequential`
    );
    console.log(
        `  Concurrent vs Sync: ${(
            asyncConcurrentMixedResult.opsPerSecond /
            syncMixedResult.opsPerSecond
        ).toFixed(1)}x speedup`
    );

    // === Verify Results ===

    const finalCount = await collection.count();
    console.log(`\nFinal verification:`);
    console.log(`  Total documents in collection: ${finalCount}`);

    // Test that both sync and async produce the same results
    const testId = crypto.randomUUID();
    const testDoc = {
        name: 'Test User',
        email: 'test@example.com',
        score: 100,
    };

    const syncUpsertResult = collection.upsertSync(testId, testDoc);
    const asyncUpsertResult = await collection.upsert(testId, {
        ...testDoc,
        score: 200,
    });

    expect(syncUpsertResult._id).toBe(testId);
    expect(asyncUpsertResult._id).toBe(testId);
    expect(asyncUpsertResult.score).toBe(200);

    console.log(`\n✅ All benchmark tests completed successfully!`);
}, 60000); // 60 second timeout for comprehensive benchmark

test('Upsert Correctness - Sync vs Async Equivalence', async () => {
    console.log('\n=== Testing Sync/Async Equivalence ===');

    const db = createDB({ memory: true });
    const collection = db.collection('equivalence', testSchema);

    const testId = crypto.randomUUID();
    const insertDoc = {
        name: 'Equivalence Test',
        email: 'equiv@test.com',
        score: 50,
    };

    // Test 1: Insert via sync upsert
    const syncInsertResult = collection.upsertSync(testId, insertDoc);
    console.log(
        `Sync insert result: ID=${syncInsertResult._id}, score=${syncInsertResult.score}`
    );

    // Test 2: Update via async upsert
    const asyncUpdateResult = await collection.upsert(testId, {
        ...insertDoc,
        score: 100,
    });
    console.log(
        `Async update result: ID=${asyncUpdateResult._id}, score=${asyncUpdateResult.score}`
    );

    // Test 3: Verify final state
    const finalDoc = collection.findByIdSync(testId);
    console.log(`Final state: ID=${finalDoc?._id}, score=${finalDoc?.score}`);

    expect(syncInsertResult._id).toBe(testId);
    expect(asyncUpdateResult._id).toBe(testId);
    expect(finalDoc?.score).toBe(100);
    expect(finalDoc?.name).toBe('Equivalence Test');

    console.log('✅ Sync/Async equivalence verified!');
});
