import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod/v3';
import { createDB } from '../src';
import type { UpgradeContext } from '../src/upgrade-types';

describe('Upgrade Functions', () => {
    let db: any;

    beforeEach(async () => {
        db = createDB({ memory: true });
    });

    it('should run simple upgrade function', async () => {
        const UserSchema = z.object({
            _id: z.string(),
            name: z.string(),
            email: z.string().optional(),
        });

        // Upgrade function will be called on v2 initialization
        let upgradeRan = false;

        const users = db.collection('users_simple', UserSchema, {
            version: 2,
            upgrade: {
                2: async (collection: any, ctx: UpgradeContext) => {
                    upgradeRan = true;
                    expect(ctx.fromVersion).toBe(0); // New collection starts from 0
                    expect(ctx.toVersion).toBe(2);
                    expect(ctx.database).toBeDefined();

                    // Add some initial users during upgrade
                    await collection.insert({
                        name: 'John Doe',
                        email: 'john.doe@example.com',
                    });
                    await collection.insert({
                        name: 'Jane Smith',
                        email: 'jane.smith@example.com',
                    });
                },
            },
        });

        // Wait for async initialization
        await users.waitForInitialization();

        // Verify upgrade ran
        expect(upgradeRan).toBe(true);

        // Verify data was created during upgrade
        const usersData = await users.toArray();
        expect(usersData.length).toBe(2);
        expect(usersData[0].email).toBe('john.doe@example.com');
        expect(usersData[1].email).toBe('jane.smith@example.com');
    });

    it('should run conditional upgrade function', async () => {
        const UserSchema = z.object({
            _id: z.string(),
            name: z.string(),
            isActive: z.boolean().optional(),
        });

        const path = `/tmp/skibbadb-upgrade-conditional-${Date.now()}-${Math.random()}.sqlite`;
        const initialDb = createDB({ path });
        const initialUsers = initialDb.collection('users', UserSchema, {
            version: 1,
        });
        await initialUsers.waitForInitialization();
        await initialUsers.insert({ name: 'John' });
        await initialDb.close();

        // Create collection with conditional upgrade
        let conditionChecked = false;
        let upgradeRan = false;

        const upgradedDb = createDB({ path });
        const users = upgradedDb.collection('users', UserSchema, {
            version: 2,
            upgrade: {
                2: {
                    condition: async (collection: any) => {
                        conditionChecked = true;
                        const count = await collection.count();
                        return count > 0; // Only run if there are users
                    },
                    migrate: async (collection: any) => {
                        upgradeRan = true;
                        const users = await collection.toArray();
                        for (const user of users) {
                            await collection.put(user._id, {
                                ...user,
                                isActive: true,
                            });
                        }
                    },
                },
            },
        });

        await users.waitForInitialization();

        expect(conditionChecked).toBe(true);
        expect(upgradeRan).toBe(true);

        const updatedUsers = await users.toArray();
        expect(updatedUsers[0].isActive).toBe(true);
        await upgradedDb.close();
    });

    it('should skip conditional upgrade when condition is false', async () => {
        const UserSchema = z.object({
            _id: z.string(),
            name: z.string(),
            processed: z.boolean().optional(),
        });

        let upgradeRan = false;

        const users = db.collection('users', UserSchema, {
            version: 2,
            upgrade: {
                2: {
                    condition: async () => false, // Never run
                    migrate: async () => {
                        upgradeRan = true;
                    },
                },
            },
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

        const path = `/tmp/skibbadb-upgrade-sequence-${Date.now()}-${Math.random()}.sqlite`;
        const initialDb = createDB({ path });
        const initialUsers = initialDb.collection('users', UserSchema, {
            version: 1,
        });
        await initialUsers.waitForInitialization();
        await initialUsers.insert({ name: 'John' });
        await initialDb.close();

        const executionOrder: number[] = [];

        const upgradedDb = createDB({ path });
        const users = upgradedDb.collection('users', UserSchema, {
            version: 3,
            upgrade: {
                2: async (collection: any) => {
                    executionOrder.push(2);
                    const users = await collection.toArray();
                    for (const user of users) {
                        const email = `${user.name.toLowerCase()}@example.com`;
                        await collection.put(user._id, { ...user, email });
                    }
                },
                3: async (collection: any) => {
                    executionOrder.push(3);
                    const users = await collection.toArray();
                    for (const user of users) {
                        await collection.put(user._id, {
                            ...user,
                            fullName: user.name,
                        });
                    }
                },
            },
        });

        await users.waitForInitialization();

        expect(executionOrder).toEqual([2, 3]);

        const finalUsers = await users.toArray();
        expect(finalUsers[0].email).toBe('john@example.com');
        expect(finalUsers[0].fullName).toBe('John');
        await upgradedDb.close();
    });

    it('should provide upgrade context with database access', async () => {
        const UserSchema = z.object({
            _id: z.string(),
            name: z.string(),
        });

        const ProfileSchema = z.object({
            _id: z.string(),
            userId: z.string(),
            bio: z.string(),
        });

        let contextReceived: UpgradeContext | null = null;

        const users = db.collection('users', UserSchema, {
            version: 2,
            upgrade: {
                2: async (collection: any, ctx: UpgradeContext) => {
                    contextReceived = ctx;

                    // Create profiles collection through database
                    const profiles = ctx.database.collection(
                        'profiles',
                        ProfileSchema,
                        { version: 1 }
                    );

                    // Create profile for each user
                    const users = await collection.toArray();
                    for (const user of users) {
                        await profiles.insert({
                            userId: user._id,
                            bio: `Profile for ${user.name}`,
                        });
                    }
                },
            },
        });

        // Add initial user
        const insertedUser = await users.insert({ name: 'John' });

        // Wait for async initialization
        await users.waitForInitialization();

        expect(contextReceived).toBeDefined();
        expect(contextReceived!.fromVersion).toBe(0);
        expect(contextReceived!.toVersion).toBe(2);
        expect(contextReceived!.database).toBeDefined();
        expect(contextReceived!.transaction).toBeDefined();
        expect(contextReceived!.sql).toBeDefined();
        expect(contextReceived!.exec).toBeDefined();

        // Verify profile was created
        const profiles = db.collection('profiles');
        const profilesData = await profiles.toArray();
        expect(profilesData.length).toBe(1);
        expect(profilesData[0].userId).toBe(insertedUser._id);
    });

    it('should run upgrade functions with SQL access', async () => {
        const UserSchema = z.object({
            _id: z.string(),
            name: z.string(),
            nameLength: z.number().optional(),
        });

        const users = db.collection('users', UserSchema, {
            version: 2,
            upgrade: {
                2: async (collection: any, ctx: UpgradeContext) => {
                    // Insert test data first
                    await collection.insert({ name: 'John' });
                    await collection.insert({ name: 'Jane Smith' });

                    // Use raw SQL to update all users
                    await ctx.exec(`
                        UPDATE users 
                        SET doc = JSON_SET(doc, '$.nameLength', LENGTH(JSON_EXTRACT(doc, '$.name')))
                        WHERE JSON_EXTRACT(doc, '$.nameLength') IS NULL
                    `);
                },
            },
        });

        // Wait for async initialization
        await users.waitForInitialization();

        const updatedUsers = await users.toArray();
        expect(updatedUsers[0].nameLength).toBe(4); // 'John'.length
        expect(updatedUsers[1].nameLength).toBe(10); // 'Jane Smith'.length
    });

    it('should run seed function for new collections', async () => {
        const UserSchema = z.object({
            _id: z.string(),
            name: z.string(),
            role: z.string(),
        });

        let seedRan = false;

        const users = db.collection('users', UserSchema, {
            version: 1,
            seed: async (collection: any) => {
                seedRan = true;

                // Create default admin user
                await collection.insert({
                    name: 'Admin',
                    role: 'admin',
                });

                await collection.insert({
                    name: 'Guest',
                    role: 'guest',
                });
            },
        });

        // Wait for async initialization
        await users.waitForInitialization();

        expect(seedRan).toBe(true);

        const seededUsers = await users.toArray();
        expect(seededUsers.length).toBe(2);
        expect(seededUsers.find((u) => u.name === 'Admin')).toBeDefined();
        expect(seededUsers.find((u) => u.name === 'Guest')).toBeDefined();
    });

    it('should handle upgrade function errors gracefully', async () => {
        const UserSchema = z.object({
            _id: z.string(),
            name: z.string(),
        });

        // This should fail during upgrade
        const users = db.collection('users', UserSchema, {
            version: 2,
            upgrade: {
                2: async () => {
                    throw new Error('Upgrade failed');
                },
            },
        });

        // Wait for initialization and expect it to fail
        let errorCaught = false;
        try {
            await users.waitForInitialization();
        } catch (error) {
            errorCaught = true;
            expect(error.message).toContain('Upgrade failed');
        }

        expect(errorCaught).toBe(true);
    });

    it('should work with dry-run mode', async () => {
        const originalEnv = process.env.SKIBBADB_MIGRATE;
        process.env.SKIBBADB_MIGRATE = 'print';

        try {
            const UserSchema = z.object({
                _id: z.string(),
                name: z.string(),
                processed: z.boolean().optional(),
            });

            let upgradeRan = false;

            // This should print the plan but not run upgrades
            const users = db.collection('users', UserSchema, {
                version: 2,
                upgrade: {
                    2: async () => {
                        upgradeRan = true;
                    },
                },
                seed: async () => {
                    // Seed function for testing
                },
            });

            // Wait for async initialization
            await users.waitForInitialization();

            expect(upgradeRan).toBe(false); // Should not run in dry-run mode
        } finally {
            if (originalEnv !== undefined) {
                process.env.SKIBBADB_MIGRATE = originalEnv;
            } else {
                delete process.env.SKIBBADB_MIGRATE;
            }
        }
    });

    it('should handle transaction rollback on upgrade failure', async () => {
        const UserSchema = z.object({
            _id: z.string(),
            name: z.string(),
            processed: z.boolean().optional(),
        });

        // Create collection first
        const users = db.collection('users', UserSchema, { version: 1 });
        await users.insert({ name: 'John' });

        // Now try to upgrade with a failing function
        let errorCaught = false;
        let caughtError: any = null;

        // The upgrade function will fail during async initialization
        const usersV2 = db.collection('users_v2', UserSchema, {
            version: 2,
            upgrade: {
                2: async (collection: any, ctx: UpgradeContext) => {
                    // Start some work
                    await ctx.exec('SELECT 1'); // This should work

                    // Then fail
                    throw new Error('Something went wrong');
                },
            },
        });

        // Wait for the initialization to complete and catch any errors
        try {
            await usersV2.waitForInitialization();
        } catch (error) {
            errorCaught = true;
            caughtError = error;
        }

        // Verify that the error was caught and has the expected properties
        expect(errorCaught).toBe(true);
        expect(caughtError).toBeDefined();
        expect(caughtError.message).toContain('Something went wrong');

        // The original data should still be intact
        const originalUsers = await users.toArray();
        expect(originalUsers.length).toBe(1);
        expect(originalUsers[0].name).toBe('John');
    });
});
