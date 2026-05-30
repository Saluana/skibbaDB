import { z } from 'zod/v3';
import { createDB } from '../src/database.js';
import { index } from '../src/schema-constraints.js';

// Define a comprehensive schema with both shallow and deep fields
const userSchema = z.object({
    _id: z.string().uuid(),
    name: z.string(),
    email: z.string().email(),
    age: z.number().int(),
    score: z.number(),
    salary: z.number(),
    isActive: z.boolean().default(true),
    department: z.string(),
    tags: z.array(z.string()).default([]),
    createdAt: z.date().default(() => new Date()),
    metadata: z
        .object({
            level: z.enum(['junior', 'mid', 'senior', 'lead']),
            location: z.string(),
            remote: z.boolean(),
            joinDate: z.date(),
            skills: z.array(z.string()),
            performance: z.object({
                rating: z.number().min(1).max(5),
                reviewDate: z.date(),
                goals: z.array(z.string()),
            }),
        })
        .optional(),
});

interface IndexBenchmarkResult {
    operation: string;
    type: 'shallow' | 'deep';
    indexed: {
        duration: number;
        opsPerSecond: number;
    };
    nonIndexed: {
        duration: number;
        opsPerSecond: number;
    };
    improvement: {
        speedup: number;
        percentage: number;
    };
}

function benchmark(
    name: string,
    count: number,
    fn: () => void
): { duration: number; opsPerSecond: number } {
    const start = performance.now();
    fn();
    const end = performance.now();
    const duration = end - start;
    const opsPerSecond = Math.round((count / duration) * 1000);

    return { duration, opsPerSecond };
}

function calculateImprovement(
    indexed: { duration: number; opsPerSecond: number },
    nonIndexed: { duration: number; opsPerSecond: number }
) {
    const speedup = nonIndexed.duration / indexed.duration;
    const percentage =
        ((nonIndexed.duration - indexed.duration) / nonIndexed.duration) * 100;
    return { speedup, percentage };
}

async function runIndexBenchmarks() {
    console.log('=== skibbaDB Index Performance Benchmark ===\n');
    console.log('Comparing indexed vs non-indexed query performance\n');

    const db = createDB({ memory: true });

    // Create two identical collections - one with indexes, one without
    const usersIndexed = db.collection('users_indexed', userSchema, {
        constraints: {
            indexes: {
                // Shallow field indexes
                age: index('age'),
                email: index('email'),
                score: index('score'),
                salary: index('salary'),
                department: index('department'),
                isActive: index('isActive'),
                createdAt: index('createdAt'),
                // Deep field indexes (nested object fields)
                level: index(['metadata', 'level'].join('.'), {
                    name: 'idx_metadata_level',
                }),
                location: index(['metadata', 'location'].join('.'), {
                    name: 'idx_metadata_location',
                }),
                remote: index(['metadata', 'remote'].join('.'), {
                    name: 'idx_metadata_remote',
                }),
                rating: index(['metadata', 'performance', 'rating'].join('.'), {
                    name: 'idx_performance_rating',
                }),
            },
        },
    });

    const usersNonIndexed = db.collection('users_non_indexed', userSchema);

    const results: IndexBenchmarkResult[] = [];

    // Generate comprehensive test data
    console.log('Generating test data...');
    const departments = [
        'Engineering',
        'Sales',
        'Marketing',
        'Product',
        'Design',
        'HR',
        'Finance',
    ];
    const levels = ['junior', 'mid', 'senior', 'lead'] as const;
    const locations = [
        'New York',
        'San Francisco',
        'Austin',
        'Seattle',
        'Remote',
        'London',
        'Berlin',
    ];
    const skillSets = [
        ['JavaScript', 'TypeScript', 'React'],
        ['Python', 'Django', 'PostgreSQL'],
        ['Go', 'Kubernetes', 'Docker'],
        ['Java', 'Spring', 'Maven'],
        ['C#', '.NET', 'Azure'],
        ['Sales', 'CRM', 'Negotiation'],
        ['Marketing', 'Analytics', 'SEO'],
        ['Design', 'Figma', 'UI/UX'],
    ];

    const generateUser = (i: number) => {
        const hasMetadata = i % 5 !== 0; // 80% of users have metadata
        const baseUser = {
            name: `User ${i}`,
            email: `user${i}@company.com`,
            age: 22 + (i % 43), // Ages 22-64
            score: Math.random() * 1000,
            salary: 40000 + (i % 100000), // Salaries 40k-140k
            isActive: i % 3 !== 0, // ~67% active
            department: departments[i % departments.length],
            tags: [`tag${i % 20}`, `category${i % 10}`],
            createdAt: new Date(2020 + (i % 4), i % 12, (i % 28) + 1),
        };

        if (hasMetadata) {
            return {
                ...baseUser,
                metadata: {
                    level: levels[i % levels.length],
                    location: locations[i % locations.length],
                    remote: i % 4 === 0,
                    joinDate: new Date(
                        2020 + (i % 4),
                        (i + 1) % 12,
                        (i % 28) + 1
                    ),
                    skills: skillSets[i % skillSets.length],
                    performance: {
                        rating: 1 + (i % 5), // Ratings 1-5
                        reviewDate: new Date(2023, i % 12, (i % 28) + 1),
                        goals: [`Goal ${i % 10}`, `Objective ${i % 15}`],
                    },
                },
            };
        }

        return baseUser;
    };

    const testData = Array.from({ length: 10000 }, (_, i) => generateUser(i));

    console.log('Inserting test data into both collections...');
    usersIndexed.insertBulkSync(testData);
    usersNonIndexed.insertBulkSync(testData);

    console.log(
        `Total documents in each collection: ${
            usersIndexed.toArraySync().length
        }\n`
    );

    // Benchmark 1: Point Queries (Equality) - Shallow Fields
    console.log('1. Benchmarking point queries (shallow fields)...');
    const testEmails = testData.slice(0, 500).map((u) => u.email);

    const pointShallowIndexed = benchmark(
        'Point Queries (Shallow, Indexed)',
        500,
        () => {
            testEmails.forEach((email) => {
                usersIndexed.where('email').eq(email).first();
            });
        }
    );

    const pointShallowNonIndexed = benchmark(
        'Point Queries (Shallow, Non-Indexed)',
        500,
        () => {
            testEmails.forEach((email) => {
                usersNonIndexed.where('email').eq(email).first();
            });
        }
    );

    results.push({
        operation: 'Point Queries (Email)',
        type: 'shallow',
        indexed: pointShallowIndexed,
        nonIndexed: pointShallowNonIndexed,
        improvement: calculateImprovement(
            pointShallowIndexed,
            pointShallowNonIndexed
        ),
    });

    // Benchmark 2: Point Queries (Equality) - Deep Fields
    console.log('2. Benchmarking point queries (deep fields)...');
    const testLevels = ['junior', 'mid', 'senior', 'lead'] as const;

    const pointDeepIndexed = benchmark(
        'Point Queries (Deep, Indexed)',
        400,
        () => {
            testLevels.forEach((level) => {
                for (let i = 0; i < 100; i++) {
                    usersIndexed
                        .where('metadata.level')
                        .eq(level)
                        .limit(10)
                        .toArraySync();
                }
            });
        }
    );

    const pointDeepNonIndexed = benchmark(
        'Point Queries (Deep, Non-Indexed)',
        400,
        () => {
            testLevels.forEach((level) => {
                for (let i = 0; i < 100; i++) {
                    usersNonIndexed
                        .where('metadata.level')
                        .eq(level)
                        .limit(10)
                        .toArraySync();
                }
            });
        }
    );

    results.push({
        operation: 'Point Queries (Metadata Level)',
        type: 'deep',
        indexed: pointDeepIndexed,
        nonIndexed: pointDeepNonIndexed,
        improvement: calculateImprovement(
            pointDeepIndexed,
            pointDeepNonIndexed
        ),
    });

    // Benchmark 3: Range Queries - Shallow Fields
    console.log('3. Benchmarking range queries (shallow fields)...');

    const rangeShallowIndexed = benchmark(
        'Range Queries (Shallow, Indexed)',
        200,
        () => {
            for (let i = 0; i < 200; i++) {
                const minAge = 25 + (i % 30);
                usersIndexed
                    .where('age')
                    .gte(minAge)
                    .where('age')
                    .lt(minAge + 10)
                    .toArraySync();
            }
        }
    );

    const rangeShallowNonIndexed = benchmark(
        'Range Queries (Shallow, Non-Indexed)',
        200,
        () => {
            for (let i = 0; i < 200; i++) {
                const minAge = 25 + (i % 30);
                usersNonIndexed
                    .where('age')
                    .gte(minAge)
                    .where('age')
                    .lt(minAge + 10)
                    .toArraySync();
            }
        }
    );

    results.push({
        operation: 'Range Queries (Age)',
        type: 'shallow',
        indexed: rangeShallowIndexed,
        nonIndexed: rangeShallowNonIndexed,
        improvement: calculateImprovement(
            rangeShallowIndexed,
            rangeShallowNonIndexed
        ),
    });

    // Benchmark 4: Range Queries - Deep Fields
    console.log('4. Benchmarking range queries (deep fields)...');

    const rangeDeepIndexed = benchmark(
        'Range Queries (Deep, Indexed)',
        250,
        () => {
            for (let i = 0; i < 250; i++) {
                const minRating = 1 + (i % 4);
                usersIndexed
                    .where('metadata.performance.rating')
                    .gte(minRating)
                    .limit(20)
                    .toArraySync();
            }
        }
    );

    const rangeDeepNonIndexed = benchmark(
        'Range Queries (Deep, Non-Indexed)',
        250,
        () => {
            for (let i = 0; i < 250; i++) {
                const minRating = 1 + (i % 4);
                usersNonIndexed
                    .where('metadata.performance.rating')
                    .gte(minRating)
                    .limit(20)
                    .toArraySync();
            }
        }
    );

    results.push({
        operation: 'Range Queries (Performance Rating)',
        type: 'deep',
        indexed: rangeDeepIndexed,
        nonIndexed: rangeDeepNonIndexed,
        improvement: calculateImprovement(
            rangeDeepIndexed,
            rangeDeepNonIndexed
        ),
    });

    // Benchmark 5: Sorting Operations - Shallow Fields
    console.log('5. Benchmarking sorting operations (shallow fields)...');

    const sortShallowIndexed = benchmark(
        'Sorting (Shallow, Indexed)',
        100,
        () => {
            for (let i = 0; i < 100; i++) {
                usersIndexed
                    .where('isActive')
                    .eq(true)
                    .orderBy('salary', 'desc')
                    .limit(50)
                    .toArraySync();
            }
        }
    );

    const sortShallowNonIndexed = benchmark(
        'Sorting (Shallow, Non-Indexed)',
        100,
        () => {
            for (let i = 0; i < 100; i++) {
                usersNonIndexed
                    .where('isActive')
                    .eq(true)
                    .orderBy('salary', 'desc')
                    .limit(50)
                    .toArraySync();
            }
        }
    );

    results.push({
        operation: 'Sorting Operations (Shallow)',
        type: 'shallow',
        indexed: sortShallowIndexed,
        nonIndexed: sortShallowNonIndexed,
        improvement: calculateImprovement(
            sortShallowIndexed,
            sortShallowNonIndexed
        ),
    });

    // Benchmark 6: Complex Multi-Field Queries
    console.log('6. Benchmarking complex multi-field queries...');

    const complexIndexed = benchmark('Complex Queries (Indexed)', 50, () => {
        for (let i = 0; i < 50; i++) {
            usersIndexed
                .where('department')
                .eq('Engineering')
                .where('age')
                .gte(30)
                .where('salary')
                .gt(80000)
                .where('metadata.level')
                .in(['senior', 'lead'])
                .where('metadata.remote')
                .eq(true)
                .orderBy('metadata.performance.rating', 'desc')
                .limit(10)
                .toArraySync();
        }
    });

    const complexNonIndexed = benchmark(
        'Complex Queries (Non-Indexed)',
        50,
        () => {
            for (let i = 0; i < 50; i++) {
                usersNonIndexed
                    .where('department')
                    .eq('Engineering')
                    .where('age')
                    .gte(30)
                    .where('salary')
                    .gt(80000)
                    .where('metadata.level')
                    .in(['senior', 'lead'])
                    .where('metadata.remote')
                    .eq(true)
                    .orderBy('metadata.performance.rating', 'desc')
                    .limit(10)
                    .toArraySync();
            }
        }
    );

    results.push({
        operation: 'Complex Multi-Field Queries',
        type: 'deep',
        indexed: complexIndexed,
        nonIndexed: complexNonIndexed,
        improvement: calculateImprovement(complexIndexed, complexNonIndexed),
    });

    // Print Results
    console.log('\n=== BENCHMARK RESULTS ===\n');

    results.forEach((result) => {
        console.log(`${result.operation} (${result.type}):`);
        console.log(
            `  Indexed:     ${result.indexed.duration.toFixed(2)}ms (${
                result.indexed.opsPerSecond
            } ops/sec)`
        );
        console.log(
            `  Non-Indexed: ${result.nonIndexed.duration.toFixed(2)}ms (${
                result.nonIndexed.opsPerSecond
            } ops/sec)`
        );
        console.log(
            `  Improvement: ${result.improvement.speedup.toFixed(
                2
            )}x faster (${result.improvement.percentage.toFixed(1)}% better)`
        );
        console.log('');
    });

    // Summary
    const avgSpeedup =
        results.reduce((sum, r) => sum + r.improvement.speedup, 0) /
        results.length;
    const avgPercentage =
        results.reduce((sum, r) => sum + r.improvement.percentage, 0) /
        results.length;

    console.log(`Overall Performance Summary:`);
    console.log(`  Average Speedup: ${avgSpeedup.toFixed(2)}x`);
    console.log(`  Average Improvement: ${avgPercentage.toFixed(1)}%`);
    console.log(`  Total Benchmarks: ${results.length}`);

    db.close();
}

// Test structure for running the benchmark
import { describe, it } from 'vitest';

describe('Index Performance Benchmark', () => {
    it('should demonstrate performance improvements with indexes', async () => {
        await runIndexBenchmarks();
    }, 30000); // 30 second timeout for comprehensive benchmarks
});
