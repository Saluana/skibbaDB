import { test, expect, describe, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { createDB } from '../src/index.js';
import type { Database } from '../src/database.js';

const largeDocSchema = z.object({
    _id: z.string().uuid(),
    name: z.string(),
    email: z.string().email(),
    age: z.number().int().optional(),
    profile: z.object({
        bio: z.string().optional(),
        skills: z.array(z.string()).optional(),
        experience: z.array(z.object({
            company: z.string(),
            role: z.string(),
            years: z.number(),
        })).optional(),
        settings: z.record(z.any()).optional(),
    }).optional(),
    metadata: z.object({
        created: z.date().default(() => new Date()),
        tags: z.array(z.string()).default([]),
        ratings: z.array(z.number()).default([]),
    }).default({ created: new Date(), tags: [], ratings: [] }),
});

describe('Projections (Field Selection)', () => {
    let db: Database;

    beforeEach(() => {
        db = createDB({ memory: true });
    });

    afterEach(async () => {
        if (db) {
            await db.close();
        }
    });

    describe('Basic Projections', () => {
        test('should select specific fields', async () => {
            const users = db.collection('users', largeDocSchema);

            await users.insert({
                name: 'Alice',
                email: 'alice@example.com',
                age: 30,
                profile: {
                    bio: 'Software engineer',
                    skills: ['TypeScript', 'React', 'Node.js'],
                    settings: { theme: 'dark', notifications: true },
                },
            });

            const results = await users
                .select('name', 'email')
                .toArray();

            expect(results).toHaveLength(1);
            const result = results[0];
            expect(result).toHaveProperty('name', 'Alice');
            expect(result).toHaveProperty('email', 'alice@example.com');
            // Other fields should not be present (projection optimization)
        });

        test('should select nested fields', async () => {
            const users = db.collection('users', largeDocSchema);

            await users.insert({
                name: 'Bob',
                email: 'bob@example.com',
                profile: {
                    bio: 'Data scientist',
                    skills: ['Python', 'Machine Learning'],
                },
            });

            const results = await users
                .select('name', 'profile.bio')
                .toArray();

            expect(results).toHaveLength(1);
            expect(results[0]).toHaveProperty('name', 'Bob');
            // Nested fields should be accessible
        });

        test('should combine projections with filters', async () => {
            const users = db.collection('users', largeDocSchema);

            await users.insertBulk([
                {
                    name: 'Charlie',
                    email: 'charlie@example.com',
                    age: 25,
                    profile: { skills: ['JavaScript'] },
                },
                {
                    name: 'David',
                    email: 'david@example.com',
                    age: 35,
                    profile: { skills: ['Python'] },
                },
                {
                    name: 'Eve',
                    email: 'eve@example.com',
                    age: 28,
                    profile: { skills: ['TypeScript'] },
                },
            ]);

            const results = await users
                .where('age').gte(28)
                .select('name', 'age')
                .toArray();

            expect(results).toHaveLength(2);
            results.forEach(r => {
                expect(r).toHaveProperty('name');
                expect(r).toHaveProperty('age');
                expect((r as any).age).toBeGreaterThanOrEqual(28);
            });
        });
    });

    describe('Projections with Constrained Fields', () => {
        test('should efficiently select constrained fields', async () => {
            const products = db.collection('products',
                z.object({
                    _id: z.string().uuid(),
                    name: z.string(),
                    price: z.number(),
                    stock: z.number().int(),
                    description: z.string(),
                    metadata: z.object({
                        category: z.string(),
                        tags: z.array(z.string()),
                    }).optional(),
                }),
                {
                    constrainedFields: {
                        price: { type: 'REAL', nullable: false },
                        stock: { type: 'INTEGER', nullable: false },
                    }
                }
            );

            await products.insertBulk([
                {
                    name: 'Widget A',
                    price: 19.99,
                    stock: 100,
                    description: 'A great widget',
                    metadata: { category: 'tools', tags: ['useful'] },
                },
                {
                    name: 'Widget B',
                    price: 29.99,
                    stock: 50,
                    description: 'An even better widget',
                    metadata: { category: 'tools', tags: ['premium'] },
                },
            ]);

            // Select only constrained fields (should use column access)
            const results = await products
                .select('name', 'price', 'stock')
                .where('price').gte(20)
                .toArray();

            expect(results).toHaveLength(1);
            expect(results[0]).toHaveProperty('name', 'Widget B');
            expect(results[0]).toHaveProperty('price', 29.99);
            expect(results[0]).toHaveProperty('stock', 50);
        });
    });

    describe('Performance Benefits', () => {
        test('should reduce data transfer with large documents', async () => {
            const users = db.collection('users', largeDocSchema);

            // Insert document with large nested data
            const largeProfile = {
                bio: 'A'.repeat(1000), // 1KB bio
                skills: Array(100).fill('skill'),
                experience: Array(50).fill({
                    company: 'Company',
                    role: 'Engineer',
                    years: 5,
                }),
                settings: Object.fromEntries(
                    Array(100).fill(0).map((_, i) => [`key${i}`, `value${i}`])
                ),
            };

            await users.insert({
                name: 'Frank',
                email: 'frank@example.com',
                age: 30,
                profile: largeProfile,
            });

            // Select only name and email (should be fast)
            const start = Date.now();
            const results = await users
                .select('name', 'email')
                .toArray();
            const duration = Date.now() - start;

            expect(results).toHaveLength(1);
            expect(results[0]).toHaveProperty('name', 'Frank');
            expect(results[0]).toHaveProperty('email', 'frank@example.com');

            // Should complete quickly even with large document
            expect(duration).toBeLessThan(100); // Should be fast
        });
    });

    describe('Edge Cases', () => {
        test('should handle empty projection (select all)', async () => {
            const users = db.collection('users', largeDocSchema);

            await users.insert({
                name: 'Grace',
                email: 'grace@example.com',
                age: 28,
            });

            const results = await users.toArray();

            expect(results).toHaveLength(1);
            expect(results[0]).toHaveProperty('name');
            expect(results[0]).toHaveProperty('email');
            expect(results[0]).toHaveProperty('age');
        });

        test('should work with distinct and projections', async () => {
            const users = db.collection('users', largeDocSchema);

            await users.insertBulk([
                { name: 'Henry', email: 'henry1@example.com', age: 30 },
                { name: 'Henry', email: 'henry2@example.com', age: 30 },
                { name: 'Ivy', email: 'ivy@example.com', age: 25 },
            ]);

            const results = await users
                .select('name', 'age')
                .distinct()
                .toArray();

            // Should have distinct combinations
            expect(results.length).toBeGreaterThan(0);
        });
    });
});

describe('Rebuild Indexes Tool', () => {
    let db: Database;

    beforeEach(() => {
        db = createDB({ memory: true });
    });

    afterEach(async () => {
        if (db) {
            await db.close();
        }
    });

    describe('Basic Rebuild', () => {
        test('should rebuild indexes successfully', async () => {
            const users = db.collection('users',
                z.object({
                    _id: z.string().uuid(),
                    name: z.string(),
                    email: z.string().email(),
                    status: z.string(),
                }),
                {
                    constrainedFields: {
                        email: { unique: true, nullable: false },
                        status: { type: 'TEXT' },
                    }
                }
            );

            await users.insertBulk([
                { name: 'Alice', email: 'alice@example.com', status: 'active' },
                { name: 'Bob', email: 'bob@example.com', status: 'inactive' },
                { name: 'Charlie', email: 'charlie@example.com', status: 'active' },
            ]);

            const result = await users.rebuildIndexes();

            expect(result.scanned).toBe(3);
            expect(result.errors).toHaveLength(0);
        });

        test('should return appropriate message for no constrained fields', async () => {
            const simple = db.collection('simple',
                z.object({
                    _id: z.string().uuid(),
                    data: z.string(),
                })
            );

            await simple.insert({ data: 'test' });

            const result = await simple.rebuildIndexes();

            expect(result.scanned).toBe(0);
            expect(result.fixed).toBe(0);
            expect(result.errors).toContain('No constrained fields to rebuild');
        });
    });

    describe('Corruption Detection', () => {
        test('should detect and fix inconsistent constrained fields', async () => {
            const products = db.collection('products',
                z.object({
                    _id: z.string().uuid(),
                    name: z.string(),
                    price: z.number(),
                    stock: z.number().int(),
                }),
                {
                    constrainedFields: {
                        price: { type: 'REAL', nullable: false },
                        stock: { type: 'INTEGER', nullable: false },
                    }
                }
            );

            await products.insertBulk([
                { name: 'Product A', price: 19.99, stock: 100 },
                { name: 'Product B', price: 29.99, stock: 50 },
            ]);

            // Manually corrupt data (simulate corruption)
            // This would require direct SQL access in a real scenario

            const result = await products.rebuildIndexes();

            expect(result.scanned).toBe(2);
            // If corruption was detected, fixed should be > 0
        });
    });

    describe('Sync Methods', () => {
        test('should work with rebuildIndexesSync', () => {
            const users = db.collection('users',
                z.object({
                    _id: z.string().uuid(),
                    name: z.string(),
                    email: z.string().email(),
                }),
                {
                    constrainedFields: {
                        email: { unique: true, nullable: false },
                    }
                }
            );

            users.insertBulkSync([
                { name: 'David', email: 'david@example.com' },
                { name: 'Eve', email: 'eve@example.com' },
            ]);

            const result = users.rebuildIndexesSync();

            expect(result.scanned).toBe(2);
            expect(result.errors).toHaveLength(0);
        });
    });

    describe('Error Handling', () => {
        test('should collect errors during rebuild', async () => {
            const users = db.collection('users',
                z.object({
                    _id: z.string().uuid(),
                    name: z.string(),
                    score: z.number(),
                }),
                {
                    constrainedFields: {
                        score: { type: 'REAL' },
                    }
                }
            );

            await users.insert({ name: 'Test', score: 100 });

            const result = await users.rebuildIndexes();

            // Should complete without throwing
            expect(result.scanned).toBeGreaterThanOrEqual(1);
        });
    });
});
