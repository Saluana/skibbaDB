import { z } from 'zod/v3';
import { createDB } from '../src/index.js';

const userSchema = z.object({
    _id: z.string().uuid(),
    name: z.string(),
    email: z.string().email(),
    age: z.number().int(),
    score: z.number(),
    isActive: z.boolean().default(true),
    tags: z.array(z.string()).default([]),
    createdAt: z.date().default(() => new Date()),
});

interface BenchmarkResult {
    operation: string;
    count: number;
    duration: number;
    opsPerSecond: number;
}

function benchmark(
    name: string,
    count: number,
    fn: () => void
): BenchmarkResult {
    const start = performance.now();
    fn();
    const end = performance.now();
    const duration = end - start;
    const opsPerSecond = Math.round((count / duration) * 1000);

    return { operation: name, count, duration, opsPerSecond };
}

async function runBenchmarks() {
    console.log('=== skibbaDB Performance Benchmark ===\n');

    const db = createDB({ memory: true });
    const users = db.collection('users', userSchema);

    const results: BenchmarkResult[] = [];

    // Generate test data
    const generateUser = (i: number) => ({
        name: `User ${i}`,
        email: `user${i}@example.com`,
        age: 20 + (i % 50),
        score: Math.random() * 1000,
        isActive: i % 2 === 0,
        tags: [`tag${i % 10}`, `category${i % 5}`],
    });

    // Benchmark: Single Inserts
    console.log('1. Benchmarking single inserts...');
    const insertResult = benchmark('Single Inserts', 1000, () => {
        for (let i = 0; i < 1000; i++) {
            users.insert(generateUser(i));
        }
    });
    results.push(insertResult);

    // Benchmark: Bulk Inserts
    console.log('2. Benchmarking bulk inserts...');
    const bulkData = Array.from({ length: 5000 }, (_, i) =>
        generateUser(i + 1000)
    );
    const bulkInsertResult = benchmark('Bulk Inserts', 5000, () => {
        users.bulk.insert(bulkData);
    });
    results.push(bulkInsertResult);

    console.log(`Total documents: ${users.toArraySync().length}`);

    // Benchmark: Point Queries (findById)
    console.log('3. Benchmarking point queries...');
    const allDocs = users.toArraySync();
    
    // Guard against empty docs array
    if (allDocs.length === 0) {
        console.log('No documents found, skipping point queries benchmark');
        return;
    }
    
    const randomIds = Array.from(
        { length: Math.min(1000, allDocs.length) },
        () => allDocs[Math.floor(Math.random() * allDocs.length)]._id
    );

    const pointQueryResult = benchmark('Point Queries', 1000, () => {
        randomIds.forEach((id) => users.get(id));
    });
    results.push(pointQueryResult);

    // Benchmark: Range Queries
    console.log('4. Benchmarking range queries...');
    const rangeQueryResult = benchmark('Range Queries', 100, () => {
        for (let i = 0; i < 100; i++) {
            const minAge = 20 + (i % 30);
            users
                .where('age')
                .gte(minAge)
                .where('age')
                .lt(minAge + 10)
                .toArraySync();
        }
    });
    results.push(rangeQueryResult);

    // Benchmark: Complex Queries
    console.log('5. Benchmarking complex queries...');
    const complexQueryResult = benchmark('Complex Queries', 50, () => {
        for (let i = 0; i < 50; i++) {
            users
                .where('age')
                .gte(25)
                .and()
                .where('score')
                .gt(500)
                .and()
                .where('isActive')
                .eq(true)
                .orderBy('score', 'desc')
                .limit(10)
                .toArraySync();
        }
    });
    results.push(complexQueryResult);

    // Benchmark: Updates
    console.log('6. Benchmarking updates...');
    const updateIds = allDocs.slice(0, 1000).map((doc) => doc._id);
    const updateResult = benchmark('Updates', 1000, () => {
        updateIds.forEach((id, i) => {
            users.update(id, { score: i * 10 });
        });
    });
    results.push(updateResult);

    // Benchmark: Deletes
    console.log('7. Benchmarking deletes...');
    const deleteIds = allDocs.slice(1000, 2000).map((doc) => doc._id);
    const deleteResult = benchmark('Deletes', 1000, () => {
        deleteIds.forEach((id) => users.delete(id));
    });
    results.push(deleteResult);

    db.close();

    // Display results
    console.log('\n=== Results ===');
    console.log(
        'Operation'.padEnd(20) +
            'Count'.padStart(10) +
            'Duration (ms)'.padStart(15) +
            'Ops/sec'.padStart(12)
    );
    console.log('-'.repeat(57));

    results.forEach((result) => {
        console.log(
            result.operation.padEnd(20) +
                result.count.toString().padStart(10) +
                result.duration.toFixed(2).padStart(15) +
                result.opsPerSecond.toString().padStart(12)
        );
    });

    // Summary stats
    const totalOps = results.reduce((sum, r) => sum + r.count, 0);
    const totalTime = results.reduce((sum, r) => sum + r.duration, 0);
    const avgOpsPerSec = Math.round((totalOps / totalTime) * 1000);

    console.log('\n=== Summary ===');
    console.log(`Total operations: ${totalOps.toLocaleString()}`);
    console.log(`Total time: ${totalTime.toFixed(2)}ms`);
    console.log(`Average ops/sec: ${avgOpsPerSec.toLocaleString()}`);
}

runBenchmarks().catch(console.error);
