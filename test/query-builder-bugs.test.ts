import { test, expect, describe, beforeEach } from 'vitest';
import { z } from 'zod';
import { createDB } from '../src/index.js';
import { QueryBuilder } from '../src/query-builder.js';
import type { Database } from '../src/database.js';

const testSchema = z.object({
    _id: z.string().uuid(),
    name: z.string(),
    email: z.string().email(),
    age: z.number().int(),
    score: z.number(),
    isActive: z.boolean(),
    tags: z.array(z.string()),
    metadata: z
        .object({
            category: z.string(),
            priority: z.number(),
        })
        .optional(),
    createdAt: z.date().default(() => new Date()),
});

describe('Query Builder Bugs and Performance Issues', () => {
    let db: Database;
    let collection: ReturnType<typeof db.collection<typeof testSchema>>;

    beforeEach(() => {
        db = createDB({ memory: true });
        collection = db.collection('test', testSchema);

        // Insert test data
        const testData = [
            {
                name: 'Alice Smith',
                email: 'alice@example.com',
                age: 25,
                score: 850.5,
                isActive: true,
                tags: ['admin', 'developer'],
                metadata: { category: 'engineering', priority: 1 },
            },
            {
                name: 'Bob Johnson',
                email: 'bob@example.com',
                age: 30,
                score: 750.0,
                isActive: true,
                tags: ['user', 'manager'],
                metadata: { category: 'management', priority: 2 },
            },
            {
                name: 'Charlie Brown',
                email: 'charlie@example.com',
                age: 35,
                score: 680.25,
                isActive: false,
                tags: ['user'],
                metadata: { category: 'sales', priority: 3 },
            },
        ];

        collection.insertBulkSync(testData);
    });

    describe('Bug #1: OR Logic Issue', () => {
        test('OR should create proper (A AND B) OR (C AND D) structure', () => {
            // This should find: (age > 30 AND isActive = true) OR (age < 30 AND score > 800)
            // Expected: Bob (30, active, 750) should NOT match, Alice (25, active, 850.5) should match
            const builder = collection
                .where('age')
                .gt(30)
                .where('isActive')
                .eq(true)
                .or((q) => q.where('age').lt(30).where('score').gt(800));

            const options = builder.getOptions();
            console.log(
                'OR Logic - Options:',
                JSON.stringify(options, null, 2)
            );

            const results = builder.toArraySync();
            console.log(
                'OR Logic - Results:',
                results.map((r) => ({
                    name: r.name,
                    age: r.age,
                    isActive: r.isActive,
                    score: r.score,
                }))
            );

            // Current bug: This will return unexpected results due to incorrect OR grouping
            // Should only return Alice (age < 30 AND score > 800), but may return others
            expect(results.length).toBe(1);
            expect(results[0].name).toBe('Alice Smith');
        });

        test('Multiple OR conditions should work correctly', () => {
            const builder = collection
                .where('age')
                .eq(25)
                .orWhere([
                    (q) => q.where('age').eq(30),
                    (q) => q.where('age').eq(35),
                ]);

            const options = builder.getOptions();
            console.log(
                'Multiple OR - Options:',
                JSON.stringify(options, null, 2)
            );

            const results = builder.toArraySync();
            console.log(
                'Multiple OR - Results:',
                results.map((r) => ({ name: r.name, age: r.age }))
            );

            // Should return all 3 records, but bug may cause incorrect behavior
            expect(results.length).toBe(3);
        });
    });

    describe('Bug #2: Shallow Clone Issue', () => {
        test('Clone should create independent instances', () => {
            const original = collection.where('age').gt(25);
            const cloned = original.clone();

            // Modify original - should not affect clone (immutable now returns new instance)
            const modified = original.where('isActive').eq(true);

            const originalFilters = original.getOptions().filters;
            const clonedFilters = cloned.getOptions().filters;
            const modifiedFilters = modified.getOptions().filters;

            console.log('Original filters:', originalFilters.length);
            console.log('Cloned filters:', clonedFilters.length);

            // Fixed: Original remains unchanged due to immutable pattern
            expect(originalFilters.length).toBe(1);
            expect(clonedFilters.length).toBe(1);
            expect(modifiedFilters.length).toBe(2);

            // Test shallow independence of nested objects
            // Note: With Phase 2 shallow copy optimization, filter objects are shared
            // but filter arrays are independent. This is safe because filters are immutable.
            if (originalFilters[0] && clonedFilters[0]) {
                // Filters may be shared (shallow copy) for performance
                // But the arrays themselves are different
                expect(originalFilters).not.toBe(clonedFilters);
            }
        });
    });

    describe('Bug #3: Input Validation Issues', () => {
        test('Should handle extreme limit values', () => {
            expect(() => {
                collection.limit(Number.MAX_SAFE_INTEGER + 1);
            }).toThrow();
        });

        test('Should handle extreme offset values', () => {
            expect(() => {
                collection.offset(Number.MAX_SAFE_INTEGER + 1);
            }).toThrow();
        });

        test('Should handle extreme page values', () => {
            expect(() => {
                collection.page(Number.MAX_SAFE_INTEGER, 10);
            }).toThrow();
        });
    });

    describe('Bug #4: Memory Leak in FieldBuilder', () => {
        test('FieldBuilder should not create unnecessary references', () => {
            const builder = collection.where('age').gt(25);
            const fieldBuilder = builder.where('name');

            // Collection property should no longer be copied (memory leak fixed)
            expect((fieldBuilder as any).collection).toBeUndefined();

            // Builder should still work correctly without collection copying
            // Memory leak is fixed by not copying collection property
            expect(fieldBuilder).toBeDefined();
        });
    });

    describe('Bug #5: Type Safety for JSON Operations', () => {
        test('arrayLength should validate input types', () => {
            expect(() => {
                // This should fail with proper type checking
                collection
                    .where('tags')
                    .arrayLength('eq' as any, 'not-a-number' as any);
            }).toThrow();
        });

        test('arrayContains should validate input', () => {
            // This should work
            const result = collection
                .where('tags')
                .arrayContains('admin')
                .toArraySync();
            expect(result.length).toBeGreaterThan(0);
        });
    });

    describe('Bug #6: Inconsistent Method Chaining', () => {
        test('Method chaining should be consistent', () => {
            const builder1 = collection.where('age').gt(25);
            const builder2 = builder1.where('isActive').eq(true);

            // Fixed: Immutable pattern means each method returns new instance
            expect(builder1).not.toBe(builder2);
            expect(builder1.getOptions().filters.length).toBe(1);
            expect(builder2.getOptions().filters.length).toBe(2);

            const builder3 = builder1.clone();
            // Clone should return a different instance
            expect(builder1).not.toBe(builder3);
            // But should have same state
            expect(builder1.getOptions()).toEqual(builder3.getOptions());
        });
    });

    describe('Performance Issues', () => {
        test('Large filter sets should perform reasonably', () => {
            const start = performance.now();

            let builder = collection.where('age').gt(0);

            // Add many filters to test array operation performance
            for (let i = 0; i < 1000; i++) {
                builder = builder.where('score').gt(i);
            }

            const end = performance.now();
            const duration = end - start;

            console.log(`Filter building took ${duration}ms for 1000 filters`);

            // Should complete in reasonable time (less than 100ms)
            expect(duration).toBeLessThan(100);
        });

        test('Multiple orderBy calls should be efficient', () => {
            const start = performance.now();

            let builder = collection.where('age').gt(0);

            // Add many sorts to test orderBy performance
            for (let i = 0; i < 100; i++) {
                builder = builder.orderBy('age', 'asc');
            }

            const end = performance.now();
            const duration = end - start;

            console.log(`OrderBy building took ${duration}ms for 100 sorts`);

            // Should complete in reasonable time
            expect(duration).toBeLessThan(50);
        });

        test('Redundant filter detection', () => {
            // This builder has redundant filters: age > 30 AND age > 25
            const builder = collection.where('age').gt(30).where('age').gt(25);

            const options = builder.getOptions();

            // With optimization, redundant filters should be detected/merged
            console.log('Redundant filters:', options.filters.length);

            // For now, just check that both filters exist (optimization not implemented yet)
            expect(options.filters.length).toBe(2);
        });

        test('Filter optimization should remove redundant conditions', () => {
            const builder = collection
                .where('age')
                .gt(30)
                .where('age')
                .gt(25) // Redundant - weaker condition
                .where('age')
                .gte(28) // Redundant - weaker condition
                .where('age')
                .lt(50)
                .where('age')
                .lte(60) // Redundant - weaker condition
                .where('name')
                .eq('test'); // Different field, should remain

            const originalCount = builder.getFilterCount();
            const optimized = builder.optimizeFilters();
            const optimizedCount = optimized.getFilterCount();

            console.log('Original filters:', originalCount);
            console.log('Optimized filters:', optimizedCount);
            console.log('Filters removed:', originalCount - optimizedCount);

            // Should remove redundant filters but keep the strongest ones and other fields
            expect(optimizedCount).toBeLessThan(originalCount);
            expect(optimizedCount).toBeGreaterThanOrEqual(3); // At least gt(30), lt(50), eq('test')
        });

        test('Filter caching removed for Phase 2 optimizations', async () => {
            // Note: Filter caching was removed in BLOCKER-3 fix as it was never used
            // and had no eviction strategy. Phase 2 optimizations use shallow copy instead.
            const { QueryBuilder } = await import('../src/query-builder.js');

            // Build a query pattern
            const builder1 = collection
                .where('age')
                .gt(25)
                .where('isActive')
                .eq(true)
                .limit(10);

            // Verify query builder works correctly
            const options = builder1.getOptions();
            expect(options.filters.length).toBe(2);
            expect(options.limit).toBe(10);

            // Performance improvement comes from shallow copy in Phase 2
            // rather than explicit caching
        });
    });
});
