import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod/v3';
import { createDB } from '../src';
import type { UpgradeContext } from '../src/upgrade-types';

describe('Upgrade Functions - Simple Tests', () => {
    let db: any;

    beforeEach(async () => {
        db = createDB({ memory: true });
    });

    it('should run upgrade function on new collection', async () => {
        const UserSchema = z.object({
            _id: z.string(),
            name: z.string(),
            email: z.string().optional(),
        });

        let upgradeRan = false;
        let contextReceived: UpgradeContext | null = null;
        
        const users = db.collection('users1', UserSchema, {
            version: 2,
            upgrade: {
                2: async (collection: any, ctx: UpgradeContext) => {
                    upgradeRan = true;
                    contextReceived = ctx;
                    
                    // Add test data during upgrade
                    await collection.insert({ name: 'John', email: 'john@example.com' });
                }
            }
        });

        // Wait for async initialization
        await users.waitForInitialization();

        // Verify upgrade ran
        expect(upgradeRan).toBe(true);
        expect(contextReceived).toBeDefined();
        expect(contextReceived!.fromVersion).toBe(0);
        expect(contextReceived!.toVersion).toBe(2);

        // Verify data was created
        const usersData = await users.toArray();
        expect(usersData.length).toBe(1);
        expect(usersData[0].name).toBe('John');
        expect(usersData[0].email).toBe('john@example.com');
    });

    it('should run seed function for new collection', async () => {
        const UserSchema = z.object({
            _id: z.string(),
            name: z.string(),
            role: z.string(),
        });

        let seedRan = false;

        const users = db.collection('users2', UserSchema, {
            version: 1,
            seed: async (collection: any) => {
                seedRan = true;
                await collection.insert({ name: 'Admin', role: 'admin' });
                await collection.insert({ name: 'Guest', role: 'guest' });
            }
        });

        // Wait for async initialization
        await users.waitForInitialization();

        expect(seedRan).toBe(true);

        const seededUsers = await users.toArray();
        expect(seededUsers.length).toBe(2);
        expect(seededUsers.find(u => u.role === 'admin')).toBeDefined();
        expect(seededUsers.find(u => u.role === 'guest')).toBeDefined();
    });

    it('should skip conditional upgrade when condition is false', async () => {
        const UserSchema = z.object({
            _id: z.string(),
            name: z.string(),
        });

        let upgradeRan = false;

        const users = db.collection('users3', UserSchema, {
            version: 2,
            upgrade: {
                2: {
                    condition: async () => false, // Never run
                    migrate: async () => {
                        upgradeRan = true;
                    }
                }
            }
        });

        // Wait for async initialization
        await users.waitForInitialization();

        expect(upgradeRan).toBe(false);
    });

    it('should run multiple upgrade functions in sequence', async () => {
        const UserSchema = z.object({
            _id: z.string(),
            name: z.string(),
            email: z.string().optional(),
            fullName: z.string().optional(),
        });

        const executionOrder: number[] = [];

        const users = db.collection('users4', UserSchema, {
            version: 3,
            upgrade: {
                2: async (collection: any) => {
                    executionOrder.push(2);
                    await collection.insert({ name: 'John' });
                },
                3: async (collection: any) => {
                    executionOrder.push(3);
                    const users = await collection.toArray();
                    for (const user of users) {
                        await collection.put(user._id, { ...user, fullName: user.name });
                    }
                }
            }
        });

        // Wait for async initialization
        await users.waitForInitialization();

        expect(executionOrder).toEqual([2, 3]);

        const finalUsers = await users.toArray();
        expect(finalUsers.length).toBe(1);
        expect(finalUsers[0].fullName).toBe('John');
    });

    it('should handle upgrade function errors gracefully', async () => {
        const UserSchema = z.object({
            _id: z.string(),
            name: z.string(),
        });

        // This should fail during upgrade but not crash the collection creation
        const users = db.collection('users5', UserSchema, {
            version: 2,
            upgrade: {
                2: async () => {
                    throw new Error('Upgrade failed');
                }
            }
        });

        // Wait for async initialization - should not throw
        await new Promise(resolve => setTimeout(resolve, 200));

        // Collection should still work despite upgrade failure
        await users.insert({ name: 'John' });
        const userData = await users.toArray();
        expect(userData.length).toBe(1);
    });

    it('should work with dry-run mode', async () => {
        const originalEnv = process.env.SKIBBADB_MIGRATE;
        process.env.SKIBBADB_MIGRATE = 'print';

        try {
            const UserSchema = z.object({
                _id: z.string(),
                name: z.string(),
            });

            let upgradeRan = false;

            // This should print the plan but not run upgrades
            const users = db.collection('users6', UserSchema, {
                version: 2,
                upgrade: {
                    2: async () => {
                        upgradeRan = true;
                    }
                },
                seed: async () => {
                    // Seed function for testing
                }
            });

            // Wait for async initialization
            await new Promise(resolve => setTimeout(resolve, 200));

            expect(upgradeRan).toBe(false); // Should not run in dry-run mode
        } finally {
            if (originalEnv !== undefined) {
                process.env.SKIBBADB_MIGRATE = originalEnv;
            } else {
                delete process.env.SKIBBADB_MIGRATE;
            }
        }
    });

    it('should provide upgrade context with SQL access', async () => {
        const UserSchema = z.object({
            _id: z.string(),
            name: z.string(),
            nameLength: z.number().optional(),
        });

        const users = db.collection('users7', UserSchema, {
            version: 2,
            upgrade: {
                2: async (collection: any, ctx: UpgradeContext) => {
                    // Add some users first
                    await collection.insert({ name: 'John' });
                    await collection.insert({ name: 'Jane Smith' });
                    
                    // Use raw SQL to update all users  
                    await ctx.exec(`
                        UPDATE users7 
                        SET doc = JSON_SET(doc, '$.nameLength', LENGTH(JSON_EXTRACT(doc, '$.name')))
                        WHERE JSON_EXTRACT(doc, '$.nameLength') IS NULL
                    `);
                }
            }
        });

        // Wait for async initialization
        await users.waitForInitialization();

        const updatedUsers = await users.toArray();
        expect(updatedUsers.length).toBe(2);
        expect(updatedUsers.find(u => u.name === 'John')?.nameLength).toBe(4);
        expect(updatedUsers.find(u => u.name === 'Jane Smith')?.nameLength).toBe(10);
    });
});