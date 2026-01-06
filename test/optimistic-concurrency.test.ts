import { test, expect, describe, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import {
    createDB,
    VersionMismatchError,
    NotFoundError,
} from '../src/index.js';
import type { Database } from '../src/database.js';

const userSchema = z.object({
    _id: z.string().uuid(),
    name: z.string(),
    email: z.string().email(),
    balance: z.number().default(0),
});

describe('Optimistic Concurrency Control (OCC)', () => {
    let db: Database;

    beforeEach(() => {
        db = createDB({ memory: true });
    });

    afterEach(async () => {
        if (db) {
            await db.close();
        }
    });

    describe('Version Tracking', () => {
        test('should initialize documents with version 1', async () => {
            const users = db.collection('users', userSchema);

            const user = await users.insert({
                name: 'Alice',
                email: 'alice@example.com',
                balance: 100,
            });

            expect((user as any)._version).toBe(1);
        });

        test('should increment version on update', async () => {
            const users = db.collection('users', userSchema);

            const user = await users.insert({
                name: 'Bob',
                email: 'bob@example.com',
                balance: 100,
            });

            expect((user as any)._version).toBe(1);

            const updated = await users.put(user._id, { balance: 150 });
            expect((updated as any)._version).toBe(2);

            const updated2 = await users.put(user._id, { balance: 200 });
            expect((updated2 as any)._version).toBe(3);
        });

        test('should increment version on atomic update', async () => {
            const users = db.collection('users', userSchema);

            const user = await users.insert({
                name: 'Charlie',
                email: 'charlie@example.com',
                balance: 100,
            });

            expect((user as any)._version).toBe(1);

            const updated = await users.atomicUpdate(user._id, {
                $inc: { balance: 50 }
            });

            expect((updated as any)._version).toBe(2);
        });

        test('should return version in findById', async () => {
            const users = db.collection('users', userSchema);

            const user = await users.insert({
                name: 'David',
                email: 'david@example.com',
                balance: 100,
            });

            const found = await users.findById(user._id);
            expect(found).not.toBeNull();
            expect((found as any)._version).toBe(1);
        });

        test('should return version in findByIdSync', () => {
            const users = db.collection('users', userSchema);

            const user = users.insertSync({
                name: 'Eve',
                email: 'eve@example.com',
                balance: 100,
            });

            const found = users.findByIdSync(user._id);
            expect(found).not.toBeNull();
            expect((found as any)._version).toBe(1);
        });
    });

    describe('Version-based Updates', () => {
        test('should succeed with correct expected version', async () => {
            const users = db.collection('users', userSchema);

            const user = await users.insert({
                name: 'Frank',
                email: 'frank@example.com',
                balance: 100,
            });

            const version = (user as any)._version;

            const updated = await users.atomicUpdate(
                user._id,
                { $inc: { balance: 50 } },
                { expectedVersion: version }
            );

            expect(updated.balance).toBe(150);
            expect((updated as any)._version).toBe(2);
        });

        test('should throw VersionMismatchError with incorrect expected version', async () => {
            const users = db.collection('users', userSchema);

            const user = await users.insert({
                name: 'Grace',
                email: 'grace@example.com',
                balance: 100,
            });

            // Update once to increment version
            await users.atomicUpdate(user._id, { $inc: { balance: 10 } });

            // Try to update with old version
            await expect(
                users.atomicUpdate(
                    user._id,
                    { $inc: { balance: 50 } },
                    { expectedVersion: 1 } // Version is now 2
                )
            ).rejects.toThrow(VersionMismatchError);
        });

        test('should include version details in error', async () => {
            const users = db.collection('users', userSchema);

            const user = await users.insert({
                name: 'Henry',
                email: 'henry@example.com',
                balance: 100,
            });

            await users.atomicUpdate(user._id, { $inc: { balance: 10 } });

            try {
                await users.atomicUpdate(
                    user._id,
                    { $inc: { balance: 50 } },
                    { expectedVersion: 1 }
                );
                expect.fail('Should have thrown VersionMismatchError');
            } catch (error) {
                expect(error).toBeInstanceOf(VersionMismatchError);
                expect((error as VersionMismatchError).id).toBe(user._id);
                expect((error as VersionMismatchError).expectedVersion).toBe(1);
                expect((error as VersionMismatchError).actualVersion).toBe(2);
            }
        });
    });

    describe('Concurrent Update Scenarios', () => {
        test('should prevent lost updates with version checking', async () => {
            const users = db.collection('users', userSchema);

            const user = await users.insert({
                name: 'Ivy',
                email: 'ivy@example.com',
                balance: 100,
            });

            // Simulate two concurrent readers
            const reader1 = await users.findById(user._id);
            const reader2 = await users.findById(user._id);

            expect(reader1).not.toBeNull();
            expect(reader2).not.toBeNull();
            expect((reader1 as any)._version).toBe(1);
            expect((reader2 as any)._version).toBe(1);

            // First writer succeeds
            await users.atomicUpdate(
                user._id,
                { $inc: { balance: 50 } },
                { expectedVersion: (reader1 as any)._version }
            );

            // Second writer fails due to version mismatch
            await expect(
                users.atomicUpdate(
                    user._id,
                    { $inc: { balance: 50 } },
                    { expectedVersion: (reader2 as any)._version }
                )
            ).rejects.toThrow(VersionMismatchError);
        });

        test('should allow retry after version mismatch', async () => {
            const users = db.collection('users', userSchema);

            const user = await users.insert({
                name: 'Jack',
                email: 'jack@example.com',
                balance: 100,
            });

            const reader = await users.findById(user._id);

            // Concurrent update
            await users.atomicUpdate(user._id, { $inc: { balance: 20 } });

            // Original reader's update fails
            let retrySucceeded = false;
            try {
                await users.atomicUpdate(
                    user._id,
                    { $inc: { balance: 50 } },
                    { expectedVersion: (reader as any)._version }
                );
            } catch (error) {
                if (error instanceof VersionMismatchError) {
                    // Retry with fresh read
                    const freshReader = await users.findById(user._id);
                    await users.atomicUpdate(
                        user._id,
                        { $inc: { balance: 50 } },
                        { expectedVersion: (freshReader as any)._version }
                    );
                    retrySucceeded = true;
                }
            }

            expect(retrySucceeded).toBe(true);

            const final = await users.findById(user._id);
            expect(final?.balance).toBe(170); // 100 + 20 + 50
        });
    });

    describe('Without Expected Version', () => {
        test('should succeed without version check', async () => {
            const users = db.collection('users', userSchema);

            const user = await users.insert({
                name: 'Kate',
                email: 'kate@example.com',
                balance: 100,
            });

            // Update without version check
            const updated = await users.atomicUpdate(user._id, {
                $inc: { balance: 50 }
            });

            expect(updated.balance).toBe(150);
            expect((updated as any)._version).toBe(2);
        });

        test('should allow concurrent updates without version check', async () => {
            const users = db.collection('users', userSchema);

            const user = await users.insert({
                name: 'Leo',
                email: 'leo@example.com',
                balance: 100,
            });

            // Multiple updates without version check (last write wins)
            await users.atomicUpdate(user._id, { $inc: { balance: 10 } });
            await users.atomicUpdate(user._id, { $inc: { balance: 20 } });
            await users.atomicUpdate(user._id, { $inc: { balance: 30 } });

            const final = await users.findById(user._id);
            expect(final?.balance).toBe(160); // 100 + 10 + 20 + 30
            expect((final as any)._version).toBe(4); // Initial + 3 updates
        });
    });

    describe('Sync Methods', () => {
        test('should support version checking in sync methods', () => {
            const users = db.collection('users', userSchema);

            const user = users.insertSync({
                name: 'Mike',
                email: 'mike@example.com',
                balance: 100,
            });

            const version = (user as any)._version;

            const updated = users.atomicUpdateSync(
                user._id,
                { $inc: { balance: 50 } },
                { expectedVersion: version }
            );

            expect(updated.balance).toBe(150);
            expect((updated as any)._version).toBe(2);
        });

        test('should throw VersionMismatchError in sync methods', () => {
            const users = db.collection('users', userSchema);

            const user = users.insertSync({
                name: 'Nina',
                email: 'nina@example.com',
                balance: 100,
            });

            users.atomicUpdateSync(user._id, { $inc: { balance: 10 } });

            expect(() => {
                users.atomicUpdateSync(
                    user._id,
                    { $inc: { balance: 50 } },
                    { expectedVersion: 1 }
                );
            }).toThrow(VersionMismatchError);
        });
    });

    describe('Integration with Regular Updates', () => {
        test('should track version across different update methods', async () => {
            const users = db.collection('users', userSchema);

            const user = await users.insert({
                name: 'Oscar',
                email: 'oscar@example.com',
                balance: 100,
            });

            expect((user as any)._version).toBe(1);

            // Regular put
            const updated1 = await users.put(user._id, { balance: 110 });
            expect((updated1 as any)._version).toBe(2);

            // Atomic update
            const updated2 = await users.atomicUpdate(user._id, { $inc: { balance: 10 } });
            expect((updated2 as any)._version).toBe(3);

            // Another put
            const updated3 = await users.put(user._id, { name: 'Oscar Updated' });
            expect((updated3 as any)._version).toBe(4);
        });
    });
});
