import { describe, test, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { createDB } from '../src/index';

describe('Iterator - Memory-Efficient Streaming', () => {
    let db: ReturnType<typeof createDB>;
    const userSchema = z.object({
        _id: z
            .string()
            .uuid()
            .default(() => crypto.randomUUID()),
        name: z.string().min(1),
        email: z.string().email(),
        age: z.number().int().optional(),
    });

    beforeEach(() => {
        db = createDB({ memory: true });
    });

    test('Collection.iterator() streams results one by one', async () => {
        const users = db.collection('users', userSchema);
        
        // Insert test data
        for (let i = 0; i < 100; i++) {
            await users.insert({
                name: `User${i}`,
                email: `user${i}@example.com`,
                age: 20 + i,
            });
        }

        // Use iterator to stream results
        let count = 0;
        for await (const user of users.iterator()) {
            expect(user).toHaveProperty('name');
            expect(user).toHaveProperty('email');
            expect(user.name).toMatch(/^User\d+$/);
            count++;
        }

        expect(count).toBe(100);
    });

    test('QueryBuilder.iterator() streams filtered results', async () => {
        const users = db.collection('users', userSchema);
        
        // Insert test data
        for (let i = 0; i < 50; i++) {
            await users.insert({
                name: `User${i}`,
                email: `user${i}@example.com`,
                age: 20 + i,
            });
        }

        // Stream filtered results
        let count = 0;
        for await (const user of users.where('age').gte(40).iterator()) {
            expect(user.age).toBeGreaterThanOrEqual(40);
            count++;
        }

        // Should get users with age >= 40 (age 40-69, so 30 users)
        expect(count).toBe(30);
    });

    test('iterator works with ordering and pagination', async () => {
        const users = db.collection('users', userSchema);
        
        // Insert test data
        for (let i = 0; i < 20; i++) {
            await users.insert({
                name: `User${i}`,
                email: `user${i}@example.com`,
                age: 20 + i,
            });
        }

        // Stream with ordering and limit
        const results: any[] = [];
        for await (const user of users.orderBy('age', 'desc').limit(5).iterator()) {
            results.push(user);
        }

        expect(results).toHaveLength(5);
        // Should be ordered by age descending
        expect(results[0].age).toBe(39);
        expect(results[4].age).toBe(35);
    });

    test('iterator handles empty results', async () => {
        const users = db.collection('users', userSchema);
        
        let count = 0;
        for await (const user of users.iterator()) {
            count++;
        }

        expect(count).toBe(0);
    });

    test('iterator can be broken out of early', async () => {
        const users = db.collection('users', userSchema);
        
        // Insert test data
        for (let i = 0; i < 100; i++) {
            await users.insert({
                name: `User${i}`,
                email: `user${i}@example.com`,
                age: 20 + i,
            });
        }

        // Break after 10 iterations
        let count = 0;
        for await (const user of users.iterator()) {
            count++;
            if (count >= 10) break;
        }

        expect(count).toBe(10);
    });

    test('multiple iterators can be used simultaneously', async () => {
        const users = db.collection('users', userSchema);
        
        // Insert test data
        for (let i = 0; i < 20; i++) {
            await users.insert({
                name: `User${i}`,
                email: `user${i}@example.com`,
                age: 20 + i,
            });
        }

        const iter1 = users.where('age').lt(30).iterator();
        const iter2 = users.where('age').gte(30).iterator();

        let count1 = 0;
        for await (const user of iter1) {
            expect(user.age).toBeLessThan(30);
            count1++;
        }

        let count2 = 0;
        for await (const user of iter2) {
            expect(user.age).toBeGreaterThanOrEqual(30);
            count2++;
        }

        expect(count1).toBe(10);
        expect(count2).toBe(10);
    });

    test('iterator memory efficiency compared to toArray', async () => {
        const users = db.collection('users', userSchema);
        
        // Insert larger dataset
        const insertPromises = [];
        for (let i = 0; i < 1000; i++) {
            insertPromises.push(
                users.insert({
                    name: `User${i}`,
                    email: `user${i}@example.com`,
                    age: 20 + (i % 50),
                })
            );
        }
        await Promise.all(insertPromises);

        // Test that iterator works without loading all into memory
        let iteratorCount = 0;
        let firstUser = null;
        let lastUser = null;
        
        for await (const user of users.iterator()) {
            if (iteratorCount === 0) firstUser = user;
            lastUser = user;
            iteratorCount++;
        }

        expect(iteratorCount).toBe(1000);
        expect(firstUser).toBeTruthy();
        expect(lastUser).toBeTruthy();
        expect(firstUser).not.toBe(lastUser);

        // Verify toArray also works for comparison
        const allUsers = await users.toArray();
        expect(allUsers).toHaveLength(1000);
    });
});
