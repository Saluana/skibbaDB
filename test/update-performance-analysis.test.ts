import { z } from 'zod';
import { createDB } from '../src/index.js';
import { unique, foreignKey, index } from '../src/schema-constraints.js';

// Test schemas for different complexity levels
const simpleSchema = z.object({
    _id: z.string().uuid(),
    name: z.string(),
    score: z.number(),
});

const constrainedSchema = z.object({
    _id: z.string().uuid(),
    email: z.string().email(),
    username: z.string(),
    score: z.number(),
});

const complexSchema = z.object({
    _id: z.string().uuid(),
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

async function analyzeUpdatePerformance() {
    console.log('=== Update Performance Analysis ===\n');

    const db = createDB({ memory: true });
    const results: PerformanceResult[] = [];

    // Test 1: Simple updates without constraints
    console.log('1. Testing simple updates (no constraints)...');
    const simpleCollection = db.collection('simple', simpleSchema);

    // Generate test data
    const simpleData = Array.from({ length: 1000 }, (_, i) => ({
        name: `User ${i}`,
        score: Math.random() * 1000,
    }));

    simpleCollection.insertBulkSync(simpleData);
    const simpleIds = simpleCollection.toArraySync().map((doc) => doc._id);

    const simpleUpdateResult = benchmark(
        'Simple Updates (No Constraints)',
        1000,
        () => {
            simpleIds.forEach((id, i) => {
                simpleCollection.put(id, { score: i * 10 });
            });
        }
    );
    results.push(simpleUpdateResult);

    // Test 2: Updates with unique constraints
    console.log('2. Testing updates with unique constraints...');
    const constrainedCollection = db.collection(
        'constrained',
        constrainedSchema,
        {
            constraints: {
                constraints: {
                    email: unique(),
                    username: unique(),
                },
            },
        }
    );

    const constrainedData = Array.from({ length: 1000 }, (_, i) => ({
        email: `user${i}@example.com`,
        username: `user${i}`,
        score: Math.random() * 1000,
    }));

    constrainedCollection.insertBulkSync(constrainedData);
    const constrainedIds = constrainedCollection
        .toArraySync()
        .map((doc) => doc._id);

    const constrainedUpdateResult = benchmark(
        'Updates with Unique Constraints',
        1000,
        () => {
            constrainedIds.forEach((id, i) => {
                constrainedCollection.put(id, { score: i * 10 });
            });
        }
    );
    results.push(constrainedUpdateResult);

    // Test 3: Updates with complex schema + validation
    console.log('3. Testing updates with complex schema...');
    const complexCollection = db.collection('complex', complexSchema, {
        constraints: {
            constraints: {
                email: unique(),
            },
            indexes: {
                email: index('email'),
                age: index('age'),
                level: index(['metadata', 'level'].join('.')),
            },
        },
    });

    const complexData = Array.from({ length: 1000 }, (_, i) => ({
        name: `User ${i}`,
        email: `user${i}@example.com`,
        age: 25 + (i % 40),
        score: Math.random() * 1000,
        isActive: i % 2 === 0,
        metadata:
            i % 3 !== 0
                ? {
                      level: (['junior', 'mid', 'senior', 'lead'] as const)[
                          i % 4
                      ],
                      location: `City ${i % 10}`,
                      skills: [`skill${i % 5}`, `skill${(i + 1) % 5}`],
                  }
                : undefined,
    }));

    complexCollection.insertBulkSync(complexData);
    const complexIds = complexCollection.toArraySync().map((doc) => doc._id);

    const complexUpdateResult = benchmark(
        'Complex Updates (Schema + Constraints)',
        1000,
        () => {
            complexIds.forEach((id, i) => {
                complexCollection.put(id, { score: i * 10 });
            });
        }
    );
    results.push(complexUpdateResult);

    // Test 4: Updates that trigger unique constraint validation
    console.log('4. Testing updates that change unique fields...');
    const uniqueUpdateResult = benchmark(
        'Updates Changing Unique Fields',
        100,
        () => {
            constrainedIds.slice(0, 100).forEach((id, i) => {
                constrainedCollection.put(id, {
                    score: i * 10,
                    // Change username to trigger unique constraint validation
                    username: `updated_user${i}`,
                });
            });
        }
    );
    results.push(uniqueUpdateResult);

    // Test 5: Raw SQLite update performance for comparison
    console.log('5. Testing raw SQLite updates for comparison...');
    const rawUpdateResult = benchmark('Raw SQLite Updates', 1000, () => {
        simpleIds.forEach((id, i) => {
            db.collection('simple')['driver'].exec(
                `UPDATE simple SET doc = json_set(doc, '$.score', ?) WHERE _id = ?`,
                [i * 10, id]
            );
        });
    });
    results.push(rawUpdateResult);

    // Test 6: Individual components timing
    console.log('6. Testing individual update components...');

    // Time just the findById calls
    const findByIdResult = benchmark('FindById Operations', 1000, () => {
        simpleIds.forEach((id) => {
            simpleCollection.findById(id);
        });
    });
    results.push(findByIdResult);

    // Time just the validation calls
    const validationResult = benchmark('Zod Validation', 1000, () => {
        simpleIds.forEach((id, i) => {
            const existing = simpleCollection.findById(id);
            const updatedDoc = { ...existing, score: i * 10 };
            simpleCollection['validateDocument'](updatedDoc);
        });
    });
    results.push(validationResult);

    // Small delay to ensure all async operations complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    db.close();

    // Display results
    console.log('\n=== PERFORMANCE ANALYSIS RESULTS ===\n');

    results.forEach((result) => {
        console.log(`${result.operation}:`);
        console.log(`  Total Time:   ${result.totalDuration.toFixed(2)}ms`);
        console.log(`  Avg per Op:   ${result.avgDuration.toFixed(3)}ms`);
        console.log(`  Ops/sec:      ${result.opsPerSecond.toLocaleString()}`);
        console.log('');
    });

    // Analysis
    console.log('=== ANALYSIS ===\n');

    const simpleOps = results.find((r) =>
        r.operation.includes('Simple Updates')
    )?.opsPerSecond;
    const constrainedOps = results.find((r) =>
        r.operation.includes('Unique Constraints')
    )?.opsPerSecond;
    const complexOps = results.find((r) =>
        r.operation.includes('Complex Updates')
    )?.opsPerSecond;
    const rawOps = results.find((r) =>
        r.operation.includes('Raw SQLite')
    )?.opsPerSecond;
    const findOps = results.find((r) =>
        r.operation.includes('FindById')
    )?.opsPerSecond;
    const validationOps = results.find((r) =>
        r.operation.includes('Zod Validation')
    )?.opsPerSecond;

    let constraintOverhead = 0;
    let complexityOverhead = 0;
    let skibbadbOverhead = 0;

    if (simpleOps && constrainedOps) {
        constraintOverhead = ((simpleOps - constrainedOps) / simpleOps) * 100;
        console.log(
            `Constraint Validation Overhead: ${constraintOverhead.toFixed(1)}%`
        );
    }

    if (simpleOps && complexOps) {
        complexityOverhead = ((simpleOps - complexOps) / simpleOps) * 100;
        console.log(
            `Schema Complexity Overhead: ${complexityOverhead.toFixed(1)}%`
        );
    }

    if (rawOps && simpleOps) {
        skibbadbOverhead = ((rawOps - simpleOps) / rawOps) * 100;
        console.log(
            `skibbaDB vs Raw SQLite Overhead: ${skibbadbOverhead.toFixed(1)}%`
        );
    }

    console.log(`\nComponent Performance:`);
    console.log(`  FindById Operations: ${findOps?.toLocaleString()} ops/sec`);
    console.log(`  Zod Validation: ${validationOps?.toLocaleString()} ops/sec`);
    console.log(`  Raw SQLite Updates: ${rawOps?.toLocaleString()} ops/sec`);
    console.log(
        `  skibbaDB Simple Updates: ${simpleOps?.toLocaleString()} ops/sec`
    );

    // Recommendations
    console.log('\n=== RECOMMENDATIONS ===\n');

    if (findOps && findOps < 10000) {
        console.log(
            '⚠️  FindById operations seem slow - check query performance'
        );
    }

    if (validationOps && validationOps < 50000) {
        console.log(
            '⚠️  Zod validation seems slow - consider schema optimization'
        );
    }

    if (constraintOverhead && constraintOverhead > 50) {
        console.log(
            '⚠️  High constraint validation overhead - consider batching or optimization'
        );
    }

    if (skibbadbOverhead && skibbadbOverhead > 70) {
        console.log('⚠️  High skibbaDB overhead - investigate abstraction costs');
    } else {
        console.log(
            '✅ skibbaDB overhead is reasonable for the features provided'
        );
    }
}

// Test structure for running the analysis
import { describe, it } from 'vitest';

describe('Update Performance Analysis', () => {
    it('should analyze update performance bottlenecks', async () => {
        await analyzeUpdatePerformance();
    }, 30000); // 30 second timeout
});
