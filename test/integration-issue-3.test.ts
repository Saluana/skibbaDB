import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { createDB } from '../src';
import { ValidationError } from '../src/errors';

/**
 * Integration test demonstrating both Issue 3.1 and 3.3 fixes working together
 * 
 * Issue 3.1: Nested field validation prevents typos in query paths
 * Issue 3.3: Non-unique indexes improve query performance
 */
describe('Integration: Nested Validation + Performance Indexes', () => {
    let db: any;

    beforeEach(() => {
        db = createDB({ memory: true });
    });

    it('should validate nested paths and use indexes for optimal query performance', async () => {
        // Schema with nested objects
        const productSchema = z.object({
            _id: z.string(),
            name: z.string(),
            price: z.number(),
            category: z.object({
                main: z.string(),
                sub: z.string(),
                tags: z.array(z.string()),
            }),
            stock: z.object({
                quantity: z.number(),
                warehouse: z.string(),
            }),
        });

        // Create collection with performance indexes on frequently-queried fields
        const products = db.collection('products', productSchema, {
            constrainedFields: {
                price: { 
                    type: 'REAL', 
                    index: true,  // Issue 3.3: Non-unique index for range queries
                },
                'category.main': { 
                    type: 'TEXT',
                    index: true,  // Issue 3.3: Index on nested field
                },
                'stock.quantity': { 
                    type: 'INTEGER',
                    index: true,  // Issue 3.3: Index for inventory queries
                },
            },
        });

        await products.waitForInitialization();

        // Insert test data
        products.insertSync({
            _id: '1',
            name: 'Laptop',
            price: 999.99,
            category: { main: 'electronics', sub: 'computers', tags: ['tech'] },
            stock: { quantity: 10, warehouse: 'A' },
        });
        products.insertSync({
            _id: '2',
            name: 'Mouse',
            price: 29.99,
            category: { main: 'electronics', sub: 'accessories', tags: ['tech'] },
            stock: { quantity: 50, warehouse: 'B' },
        });
        products.insertSync({
            _id: '3',
            name: 'Desk',
            price: 299.99,
            category: { main: 'furniture', sub: 'office', tags: ['wood'] },
            stock: { quantity: 5, warehouse: 'A' },
        });

        // ===== ISSUE 3.1 VALIDATION: Correct paths work =====
        const electronics = products.where('category.main').eq('electronics').toArraySync();
        expect(electronics).toHaveLength(2);

        const affordable = products.where('price').lt(100).toArraySync();
        expect(affordable).toHaveLength(1);
        expect(affordable[0].name).toBe('Mouse');

        const lowStock = products.where('stock.quantity').lt(20).toArraySync();
        expect(lowStock).toHaveLength(2); // Laptop (10) and Desk (5)

        // ===== ISSUE 3.1 VALIDATION: Typos are caught =====
        
        // Typo in parent: "categry" instead of "category"
        expect(() => products.where('categry.main').eq('electronics'))
            .toThrow(ValidationError);

        // Typo in nested field: "man" instead of "main"
        expect(() => products.where('category.man').eq('electronics'))
            .toThrow(ValidationError);
        
        // Typo in deeply nested path: "quantiy" instead of "quantity"
        expect(() => products.where('stock.quantiy').gt(10))
            .toThrow(ValidationError);

        // Non-existent path
        expect(() => products.where('nonexistent.field').eq('value'))
            .toThrow(ValidationError);

        // ===== ISSUE 3.3 VERIFICATION: Indexes exist =====
        const driver = await db.ensureDriver();
        const indexes = await driver.query(
            "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='products' AND name LIKE 'idx_%' ORDER BY name"
        );

        const indexNames = indexes.map((idx: any) => idx.name);
        expect(indexNames).toContain('idx_products_price');
        expect(indexNames).toContain('idx_products_category_main');
        expect(indexNames).toContain('idx_products_stock_quantity');

        // ===== ISSUE 3.3 VERIFICATION: Indexes are used in query plans =====
        const pricePlan = await driver.query(
            "EXPLAIN QUERY PLAN SELECT * FROM products WHERE price < 100"
        );
        expect(JSON.stringify(pricePlan)).toContain('idx_products_price');

        const categoryPlan = await driver.query(
            "EXPLAIN QUERY PLAN SELECT * FROM products WHERE category_main = 'electronics'"
        );
        expect(JSON.stringify(categoryPlan)).toContain('idx_products_category_main');

        const stockPlan = await driver.query(
            "EXPLAIN QUERY PLAN SELECT * FROM products WHERE stock_quantity < 20"
        );
        expect(JSON.stringify(stockPlan)).toContain('idx_products_stock_quantity');
    });

    it('should handle complex queries with validation and indexes', async () => {
        const orderSchema = z.object({
            _id: z.string(),
            customer: z.object({
                name: z.string(),
                email: z.string(),
                tier: z.string(), // 'bronze', 'silver', 'gold'
            }),
            items: z.array(z.object({
                productId: z.string(),
                quantity: z.number(),
            })),
            total: z.number(),
            status: z.string(),
        });

        const orders = db.collection('orders', orderSchema, {
            constrainedFields: {
                'customer.tier': { type: 'TEXT', index: true },
                total: { type: 'REAL', index: true },
                status: { type: 'TEXT', index: true },
            },
        });

        await orders.waitForInitialization();

        // Insert data
        orders.insertSync({
            _id: '1',
            customer: { name: 'Alice', email: 'alice@example.com', tier: 'gold' },
            items: [{ productId: 'p1', quantity: 2 }],
            total: 500.00,
            status: 'completed',
        });
        orders.insertSync({
            _id: '2',
            customer: { name: 'Bob', email: 'bob@example.com', tier: 'silver' },
            items: [{ productId: 'p2', quantity: 1 }],
            total: 150.00,
            status: 'pending',
        });
        orders.insertSync({
            _id: '3',
            customer: { name: 'Charlie', email: 'charlie@example.com', tier: 'gold' },
            items: [{ productId: 'p3', quantity: 3 }],
            total: 750.00,
            status: 'completed',
        });

        // Valid complex query with indexed fields
        const goldOrders = orders
            .where('customer.tier').eq('gold')
            .toArraySync();
        expect(goldOrders).toHaveLength(2);

        const largeOrders = orders
            .where('total').gt(200)
            .toArraySync();
        expect(largeOrders).toHaveLength(2);

        // Validation catches typos
        expect(() => orders.where('customer.teir').eq('gold'))
            .toThrow(ValidationError);
        
        expect(() => orders.where('customer.tier.invalid').eq('value'))
            .toThrow(ValidationError);
    });

    it('should maintain data integrity with validation while leveraging index performance', async () => {
        // Real-world scenario: User profile search with performance optimization
        const userSchema = z.object({
            _id: z.string(),
            username: z.string(),
            profile: z.object({
                age: z.number(),
                city: z.string(),
                interests: z.array(z.string()),
            }),
            settings: z.object({
                privacy: z.string(),
                notifications: z.boolean(),
            }),
        });

        const users = db.collection('users', userSchema, {
            constrainedFields: {
                username: { type: 'TEXT', unique: true }, // Unique, no need for index
                'profile.age': { type: 'INTEGER', index: true }, // Index for age range queries
                'profile.city': { type: 'TEXT', index: true }, // Index for location queries
            },
        });

        await users.waitForInitialization();

        // Insert users
        const userData = [
            { _id: '1', username: 'alice', profile: { age: 25, city: 'NYC', interests: ['tech'] }, settings: { privacy: 'public', notifications: true } },
            { _id: '2', username: 'bob', profile: { age: 30, city: 'SF', interests: ['art'] }, settings: { privacy: 'private', notifications: false } },
            { _id: '3', username: 'charlie', profile: { age: 28, city: 'NYC', interests: ['music'] }, settings: { privacy: 'public', notifications: true } },
        ];

        userData.forEach(user => users.insertSync(user));

        // Valid indexed queries work efficiently
        const nycUsers = users.where('profile.city').eq('NYC').toArraySync();
        expect(nycUsers).toHaveLength(2);

        const youngUsers = users.where('profile.age').lt(30).toArraySync();
        expect(youngUsers).toHaveLength(2);

        // Validation prevents typos in nested paths
        expect(() => users.where('profle.age').gt(20))
            .toThrow(ValidationError);
        
        expect(() => users.where('profile.cty').eq('NYC'))
            .toThrow(ValidationError);
        
        expect(() => users.where('settings.privcy').eq('public'))
            .toThrow(ValidationError);

        // Verify indexes improve query performance
        const driver = await db.ensureDriver();
        const agePlan = await driver.query(
            "EXPLAIN QUERY PLAN SELECT * FROM users WHERE profile_age < 30"
        );
        expect(JSON.stringify(agePlan)).toContain('profile_age');

        const cityPlan = await driver.query(
            "EXPLAIN QUERY PLAN SELECT * FROM users WHERE profile_city = 'NYC'"
        );
        expect(JSON.stringify(cityPlan)).toContain('profile_city');
    });
});
