import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../src/database';
import { z } from 'zod/v3';

// Test schemas
const UserSchema = z.object({
    _id: z.string(),
    name: z.string(),
    email: z.string(),
    age: z.number(),
    profile: z
        .object({
            bio: z.string().optional(),
            social: z
                .object({
                    twitter: z.string().optional(),
                    linkedin: z.string().optional(),
                })
                .optional(),
        })
        .optional(),
    tags: z.array(z.string()).optional(),
    metadata: z
        .object({
            category: z.string(),
            score: z.number(),
        })
        .optional(),
});

const OrderSchema = z.object({
    _id: z.string(),
    userId: z.string(),
    total: z.number(),
    items: z.array(
        z.object({
            name: z.string(),
            price: z.number(),
            quantity: z.number(),
        })
    ),
    status: z.string(),
    createdAt: z.date(),
});

const ProductSchema = z.object({
    _id: z.string(),
    name: z.string(),
    price: z.number(),
    category: z.string(),
    inStock: z.boolean(),
    reviews: z
        .array(
            z.object({
                rating: z.number(),
                comment: z.string(),
                userId: z.string(),
            })
        )
        .optional(),
});

describe('Enhanced Query Engine', () => {
    let db: Database;
    let users: any;
    let orders: any;
    let products: any;

    beforeEach(async () => {
        db = new Database({ memory: true });

        // Create collections
        users = db.collection('users', UserSchema, { primaryKey: '_id' });
        orders = db.collection('orders', OrderSchema, { primaryKey: '_id' });
        products = db.collection('products', ProductSchema, {
            primaryKey: '_id',
        });

        // Sample data
        const sampleUsers = [
            {
                _id: '1',
                name: 'Alice Smith',
                email: 'alice@example.com',
                age: 28,
                profile: {
                    bio: 'Software engineer',
                    social: { twitter: '@alice', linkedin: 'alice-smith' },
                },
                tags: ['developer', 'javascript', 'react'],
                metadata: { category: 'premium', score: 95 },
            },
            {
                _id: '2',
                name: 'Bob Johnson',
                email: 'bob@example.com',
                age: 35,
                profile: {
                    bio: 'Product manager',
                    social: { linkedin: 'bob-johnson' },
                },
                tags: ['product', 'management'],
                metadata: { category: 'standard', score: 82 },
            },
            {
                _id: '3',
                name: 'Carol Davis',
                email: 'carol@example.com',
                age: 24,
                profile: {
                    bio: 'Designer',
                },
                tags: ['design', 'ui', 'ux'],
                metadata: { category: 'premium', score: 88 },
            },
        ];

        const sampleOrders = [
            {
                _id: 'order1',
                userId: '1',
                total: 150.5,
                items: [
                    { name: 'Laptop', price: 100, quantity: 1 },
                    { name: 'Mouse', price: 50.5, quantity: 1 },
                ],
                status: 'completed',
                createdAt: new Date('2024-01-15'),
            },
            {
                _id: 'order2',
                userId: '1',
                total: 75.25,
                items: [{ name: 'Keyboard', price: 75.25, quantity: 1 }],
                status: 'pending',
                createdAt: new Date('2024-01-20'),
            },
            {
                _id: 'order3',
                userId: '2',
                total: 200.0,
                items: [{ name: 'Monitor', price: 200, quantity: 1 }],
                status: 'completed',
                createdAt: new Date('2024-01-18'),
            },
        ];

        const sampleProducts = [
            {
                _id: 'prod1',
                name: 'Laptop',
                price: 1000,
                category: 'electronics',
                inStock: true,
                reviews: [
                    { rating: 5, comment: 'Great laptop!', userId: '1' },
                    { rating: 4, comment: 'Good value', userId: '2' },
                ],
            },
            {
                _id: 'prod2',
                name: 'Mouse',
                price: 25,
                category: 'electronics',
                inStock: true,
                reviews: [{ rating: 4, comment: 'Works well', userId: '1' }],
            },
            {
                _id: 'prod3',
                name: 'Desk',
                price: 300,
                category: 'furniture',
                inStock: false,
                reviews: [],
            },
        ];

        // Insert sample data
        for (const user of sampleUsers) {
            await users.insert(user);
        }
        for (const order of sampleOrders) {
            await orders.insert(order);
        }
        for (const product of sampleProducts) {
            await products.insert(product);
        }
    });

    afterEach(async () => {
        await db.close();
    });

    describe('Aggregate Functions', () => {
        it('should count all records', async () => {
            const result = await users.query().count('*', 'total_users').exec();

            expect(result).toHaveLength(1);
            expect(result[0].total_users).toBe(3);
        });

        it('should count with GROUP BY', async () => {
            const result = await users
                .query()
                .select('metadata.category')
                .count('*', 'count')
                .groupBy('metadata.category')
                .exec();

            expect(result).toHaveLength(2);

            const premiumCount = result.find(
                (r: any) => r['metadata.category'] === 'premium'
            )?.count;
            const standardCount = result.find(
                (r: any) => r['metadata.category'] === 'standard'
            )?.count;

            expect(premiumCount).toBe(2);
            expect(standardCount).toBe(1);
        });

        it('should calculate sum and average', async () => {
            const result = await orders
                .query()
                .sum('total', 'total_sum')
                .avg('total', 'avg_total')
                .exec();

            expect(result).toHaveLength(1);
            expect(result[0].total_sum).toBe(425.75);
            expect(result[0].avg_total).toBeCloseTo(141.92, 2);
        });

        it('should find min and max values', async () => {
            const result = await users
                .query()
                .min('age', 'min_age')
                .max('age', 'max_age')
                .exec();

            expect(result).toHaveLength(1);
            expect(result[0].min_age).toBe(24);
            expect(result[0].max_age).toBe(35);
        });

        it('should support HAVING clause', async () => {
            const result = await users
                .query()
                .select('metadata.category')
                .count('*', 'user_count')
                .groupBy('metadata.category')
                .having('user_count')
                .gt(1)
                .exec();

            expect(result).toHaveLength(1);
            expect(result[0]['metadata.category']).toBe('premium');
            expect(result[0].user_count).toBe(2);
        });

        it('should support COUNT DISTINCT', async () => {
            const result = await orders
                .query()
                .count('userId', 'unique_users', true)
                .exec();

            expect(result).toHaveLength(1);
            expect(result[0].unique_users).toBe(2);
        });
    });

    describe('JOIN Operations', () => {
        it('should perform INNER JOIN', async () => {
            // First, let's check what data we have
            const allUsers = await users.query().exec();
            const allOrders = await orders.query().exec();
            console.log('Users:', allUsers.length);
            console.log('Orders:', allOrders.length);
            console.log(
                'Orders > 100:',
                allOrders.filter((o: any) => o.total > 100)
            );

            const result = await users
                .query()
                .select('name', 'email')
                .join('orders', '_id', 'userId')
                .where('orders.total')
                .gt(100)
                .exec();

            console.log('JOIN result:', result);

            expect(result.length).toBeGreaterThan(0);
            // Should only include users who have orders with total > 100
        });

        it('should perform LEFT JOIN', async () => {
            const result = await users
                .query()
                .select('name')
                .leftJoin('orders', '_id', 'userId')
                .exec();

            // Should include all users, even those without orders
            expect(result.length).toBeGreaterThanOrEqual(3);
        });

        it('should join with custom operators', async () => {
            const result = await orders
                .query()
                .select('_id', 'total')
                .join('products', 'total', 'price', '>')
                .exec();

            // Orders with total greater than product price
            expect(Array.isArray(result)).toBe(true);
        });
    });

    describe('Subqueries', () => {
        it('should support EXISTS subquery', async () => {
            const subquery = orders
                .query()
                .where('userId')
                .eq('1')
                .where('status')
                .eq('completed');

            const result = await users
                .query()
                .where('_id')
                .existsSubquery(subquery, 'orders')
                .exec();

            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('Alice Smith');
        });

        it('should support NOT EXISTS subquery', async () => {
            const subquery = orders.query().where('status').eq('pending');

            const result = await users
                .query()
                .where('_id')
                .notExistsSubquery(subquery, 'orders')
                .exec();

            // Users without pending orders
            expect(result.length).toBeGreaterThan(0);
        });

        it('should support IN subquery', async () => {
            const subquery = orders
                .query()
                .select('userId')
                .where('total')
                .gt(100);

            const result = await users
                .query()
                .where('_id')
                .inSubquery(subquery, 'orders')
                .exec();

            // Users who have orders > 100
            expect(result.length).toBeGreaterThan(0);
        });

        it('should support NOT IN subquery', async () => {
            const subquery = orders
                .query()
                .select('userId')
                .where('status')
                .eq('pending');

            const result = await users
                .query()
                .where('_id')
                .notInSubquery(subquery, 'orders')
                .exec();

            // Users without pending orders
            expect(result.length).toBeGreaterThan(0);
        });
    });

    describe('Deep JSON Path Support', () => {
        it('should query nested object properties', async () => {
            const result = await users
                .query()
                .where('profile.social.twitter')
                .exists()
                .exec();

            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('Alice Smith');
        });

        it('should query deep nested paths', async () => {
            const result = await users
                .query()
                .where('profile.social.linkedin')
                .like('%alice%')
                .exec();

            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('Alice Smith');
        });

        it('should support array length checks', async () => {
            const result = await users
                .query()
                .where('tags')
                .arrayLength('gte', 3)
                .exec();

            expect(result).toHaveLength(2); // Alice and Carol have 3+ tags
        });

        it('should support array contains', async () => {
            const result = await users
                .query()
                .where('tags')
                .arrayContains('javascript')
                .exec();

            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('Alice Smith');
        });

        it('should support array not contains', async () => {
            const result = await users
                .query()
                .where('tags')
                .arrayNotContains('java')
                .exec();

            expect(result).toHaveLength(3); // None have 'java' tag
        });

        it('should query nested arrays', async () => {
            const result = await products
                .query()
                .where('reviews')
                .arrayLength('gt', 1)
                .exec();

            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('Laptop');
        });

        it('should support complex nested JSON queries', async () => {
            const result = await orders
                .query()
                .where('items')
                .arrayLength('eq', 1)
                .exec();

            expect(result.length).toBeGreaterThan(0);
        });
    });

    describe('Complex Combined Queries', () => {
        it('should combine aggregates with joins and subqueries', async () => {
            // Find premium users and their order statistics
            const premiumUserSubquery = users
                .query()
                .select('_id')
                .where('metadata.category')
                .eq('premium');

            const result = await orders
                .query()
                .select('userId')
                .sum('total', 'total_spent')
                .count('*', 'order_count')
                .where('userId')
                .inSubquery(premiumUserSubquery, 'users')
                .groupBy('userId')
                .having('total_spent')
                .gt(100)
                .exec();

            expect(Array.isArray(result)).toBe(true);
        });

        it('should support complex OR conditions with JSON paths', async () => {
            const result = await users
                .query()
                .orWhere([
                    (q: any) => q.where('profile.social.twitter').exists(),
                    (q: any) => q.where('tags').arrayContains('design'),
                    (q: any) => q.where('metadata.score').gt(90),
                ])
                .exec();

            expect(result.length).toBeGreaterThan(0);
        });

        it('should support mixed aggregates and filtering', async () => {
            const result = await products
                .query()
                .select('category')
                .avg('price', 'avg_price')
                .count('*', 'product_count')
                .where('inStock')
                .eq(true)
                .groupBy('category')
                .orderBy('avg_price', 'desc')
                .exec();

            expect(Array.isArray(result)).toBe(true);
        });
    });

    describe('Advanced JSON Operations', () => {
        it('should handle deeply nested JSON paths', async () => {
            const result = await users
                .query()
                .where('metadata.category')
                .eq('premium')
                .where('profile.social.twitter')
                .exists()
                .exec();

            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('Alice Smith');
        });

        it('should support JSON array operations with ordering', async () => {
            const result = await users
                .query()
                .where('tags')
                .arrayLength('gt', 2)
                .orderBy('metadata.score', 'desc')
                .exec();

            expect(result.length).toBe(2);
            expect(result[0].metadata.score).toBeGreaterThan(
                result[1].metadata.score
            );
        });

        it('should combine multiple JSON array filters', async () => {
            const result = await users
                .query()
                .where('tags')
                .arrayContains('developer')
                .where('tags')
                .arrayNotContains('python')
                .exec();

            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('Alice Smith');
        });
    });
});
