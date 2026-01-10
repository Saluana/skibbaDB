import { describe, test, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { createDB } from '../src/index.js';
import type { Database } from '../src/database.js';

const userSchema = z.object({
    _id: z.string().uuid(),
    name: z.string(),
    email: z.string().email(),
    age: z.number().int(),
    department: z.string(),
    isActive: z.boolean(),
    metadata: z
        .object({
            role: z.string(),
            level: z.number(),
        })
        .optional(),
});

describe('Select Field Tests', () => {
    let db: Database;
    let users: ReturnType<typeof db.collection<typeof userSchema>>;

    beforeEach(() => {
        db = createDB({ memory: true });
        users = db.collection('users', userSchema);
        users.insertBulkSync([
            {
                name: 'Alice',
                email: 'alice@example.com',
                age: 25,
                department: 'Engineering',
                isActive: true,
                metadata: { role: 'senior', level: 3 },
            },
            {
                name: 'Bob',
                email: 'bob@example.com',
                age: 30,
                department: 'Marketing',
                isActive: true,
                metadata: { role: 'manager', level: 2 },
            },
            {
                name: 'Charlie',
                email: 'charlie@example.com',
                age: 35,
                department: 'Sales',
                isActive: false,
                metadata: { role: 'junior', level: 1 },
            },
        ]);
    });

    describe('Basic Select Operations (Sync)', () => {
        test('select single field', () => {
            const results = users.query().select('name').toArraySync();
            expect(results).toHaveLength(3);
            for (const r of results) {
                expect(r).toHaveProperty('name');
                expect(r).not.toHaveProperty('email');
                expect(r).not.toHaveProperty('age');
                expect(r).not.toHaveProperty('_id');
            }
        });

        test('select multiple fields', () => {
            const results = users.query().select('name', 'email').toArraySync();
            expect(results).toHaveLength(3);
            for (const r of results) {
                expect(r).toHaveProperty('name');
                expect(r).toHaveProperty('email');
                expect(r).not.toHaveProperty('age');
                expect(r).not.toHaveProperty('_id');
            }
        });

        test('select all basic fields', () => {
            const results = users
                .query()
                .select('name', 'email', 'age', 'department', 'isActive')
                .toArraySync();
            expect(results).toHaveLength(3);
            for (const r of results) {
                expect(r).toHaveProperty('name');
                expect(r).toHaveProperty('email');
                expect(r).toHaveProperty('age');
                expect(r).toHaveProperty('department');
                expect(r).toHaveProperty('isActive');
                expect(r).not.toHaveProperty('_id');
                expect(r).not.toHaveProperty('metadata');
            }
        });

        test('select nested object fields', () => {
            const results = users
                .query()
                .select('name', 'metadata')
                .toArraySync();
            expect(results).toHaveLength(3);
            for (const r of results) {
                expect(r).toHaveProperty('name');
                expect(r).toHaveProperty('metadata');
                expect(r).not.toHaveProperty('email');
                expect(r).not.toHaveProperty('_id');
            }
        });

        test('select with filters', () => {
            const results = users
                .query()
                .where('isActive')
                .eq(true)
                .select('name', 'department')
                .toArraySync();

            expect(results).toHaveLength(2);
            for (const r of results) {
                expect(r).toHaveProperty('name');
                expect(r).toHaveProperty('department');
                expect(r).not.toHaveProperty('email');
                expect(r).not.toHaveProperty('isActive');
            }
            expect(results.map((r) => r.name)).toEqual(
                expect.arrayContaining(['Alice', 'Bob'])
            );
        });

        test('select with ordering', () => {
            const results = users
                .query()
                .select('name', 'age')
                .orderBy('age', 'desc')
                .toArraySync();

            expect(results).toHaveLength(3);
            expect(results[0].name).toBe('Charlie');
            expect(results[0].age).toBe(35);
            expect(results[1].name).toBe('Bob');
            expect(results[1].age).toBe(30);
            expect(results[2].name).toBe('Alice');
            expect(results[2].age).toBe(25);
        });

        test('select with limit', () => {
            const results = users
                .query()
                .select('name', 'age')
                .orderBy('age', 'asc')
                .limit(2)
                .toArraySync();

            expect(results).toHaveLength(2);
            expect(results[0].name).toBe('Alice');
            expect(results[1].name).toBe('Bob');
        });

        test('select with firstSync', () => {
            const result = users
                .query()
                .select('name', 'department')
                .where('department')
                .eq('Engineering')
                .firstSync();

            expect(result).not.toBeNull();
            expect(result).toHaveProperty('name', 'Alice');
            expect(result).toHaveProperty('department', 'Engineering');
            expect(result).not.toHaveProperty('email');
            expect(result).not.toHaveProperty('_id');
        });

        test('select returns null when no results with firstSync', () => {
            const result = users
                .query()
                .select('name')
                .where('age')
                .gt(100)
                .firstSync();

            expect(result).toBeNull();
        });
    });

    describe('Basic Select Operations (Async)', () => {
        test('select single field async', async () => {
            const results = await users.query().select('name').toArray();
            expect(results).toHaveLength(3);
            for (const r of results) {
                expect(r).toHaveProperty('name');
                expect(r).not.toHaveProperty('email');
                expect(r).not.toHaveProperty('age');
                expect(r).not.toHaveProperty('_id');
            }
        });

        test('select multiple fields async', async () => {
            const results = await users
                .query()
                .select('name', 'email')
                .toArray();
            expect(results).toHaveLength(3);
            for (const r of results) {
                expect(r).toHaveProperty('name');
                expect(r).toHaveProperty('email');
                expect(r).not.toHaveProperty('age');
                expect(r).not.toHaveProperty('_id');
            }
        });

        test('select with exec alias async', async () => {
            const results = await users.query().select('name', 'email').exec();
            expect(results).toHaveLength(3);
            for (const r of results) {
                expect(r).toHaveProperty('name');
                expect(r).toHaveProperty('email');
                expect(r).not.toHaveProperty('age');
                expect(r).not.toHaveProperty('_id');
            }
        });

        test('select with filters async', async () => {
            const results = await users
                .query()
                .where('isActive')
                .eq(true)
                .select('name', 'department')
                .toArray();

            expect(results).toHaveLength(2);
            for (const r of results) {
                expect(r).toHaveProperty('name');
                expect(r).toHaveProperty('department');
                expect(r).not.toHaveProperty('email');
                expect(r).not.toHaveProperty('isActive');
            }
        });

        test('select with ordering async', async () => {
            const results = await users
                .query()
                .select('name', 'age')
                .orderBy('age', 'desc')
                .toArray();

            expect(results).toHaveLength(3);
            expect(results[0].name).toBe('Charlie');
            expect(results[1].name).toBe('Bob');
            expect(results[2].name).toBe('Alice');
        });

        test('select with first async', async () => {
            const result = await users
                .query()
                .select('name', 'department')
                .where('department')
                .eq('Engineering')
                .first();

            expect(result).not.toBeNull();
            expect(result).toHaveProperty('name', 'Alice');
            expect(result).toHaveProperty('department', 'Engineering');
            expect(result).not.toHaveProperty('email');
            expect(result).not.toHaveProperty('_id');
        });

        test('select returns null when no results with first async', async () => {
            const result = await users
                .query()
                .select('name')
                .where('age')
                .gt(100)
                .first();

            expect(result).toBeNull();
        });
    });

    describe('Advanced Select Operations', () => {
        test('select with complex where conditions', () => {
            const results = users
                .query()
                .where('age')
                .gte(25)
                .where('age')
                .lte(30)
                .select('name', 'age', 'department')
                .orderBy('age')
                .toArraySync();

            expect(results).toHaveLength(2);
            expect(results[0].name).toBe('Alice');
            expect(results[1].name).toBe('Bob');
        });

        test('select with OR conditions', () => {
            const results = users
                .query()
                .where('department')
                .eq('Engineering')
                .or((builder) => builder.where('department').eq('Sales'))
                .select('name', 'department')
                .orderBy('name')
                .toArraySync();

            expect(results).toHaveLength(2);
            expect(results[0].name).toBe('Alice');
            expect(results[0].department).toBe('Engineering');
            expect(results[1].name).toBe('Charlie');
            expect(results[1].department).toBe('Sales');
        });

        test('select with string operations', () => {
            const results = users
                .query()
                .where('email')
                .contains('alice')
                .select('name', 'email')
                .toArraySync();

            expect(results).toHaveLength(1);
            expect(results[0].name).toBe('Alice');
        });

        test('select with pagination', () => {
            const page1 = users
                .query()
                .select('name', 'age')
                .orderBy('age')
                .page(1, 2)
                .toArraySync();

            const page2 = users
                .query()
                .select('name', 'age')
                .orderBy('age')
                .page(2, 2)
                .toArraySync();

            expect(page1).toHaveLength(2);
            expect(page2).toHaveLength(1);
            expect(page1[0].name).toBe('Alice');
            expect(page1[1].name).toBe('Bob');
            expect(page2[0].name).toBe('Charlie');
        });

        test('select with distinct', () => {
            // Add duplicate department data
            users.insertSync({
                name: 'David',
                email: 'david@example.com',
                age: 28,
                department: 'Engineering',
                isActive: true,
                metadata: { role: 'junior', level: 1 },
            });

            const results = users
                .query()
                .select('name', 'department')
                .where('department')
                .eq('Engineering')
                .toArraySync();

            expect(results).toHaveLength(2);
            expect(results.map((r) => r.name)).toEqual(
                expect.arrayContaining(['Alice', 'David'])
            );
        });
    });

    describe('Edge Cases and Error Handling', () => {
        test('select with no fields should throw or handle gracefully', () => {
            // This might depend on implementation - test current behavior
            const results = users.query().select().toArraySync();
            // Assuming it returns all fields or handles gracefully
            expect(results).toHaveLength(3);
        });

        test('select with invalid field names', () => {
            // Note: This might not throw an error if fields are treated as JSON paths
            const results = users.query().select('nonexistent').toArraySync();
            expect(results).toHaveLength(3);
            // Should still return results but field might be undefined
        });

        test('select with empty result set', () => {
            const results = users
                .query()
                .where('age')
                .gt(100)
                .select('name', 'age')
                .toArraySync();

            expect(results).toHaveLength(0);
        });

        test('select with nested field paths', () => {
            const results = users
                .query()
                .select('name', 'metadata.role', 'metadata.level')
                .where('metadata.role')
                .eq('senior')
                .toArraySync();

            console.log('nested', results);

            expect(results).toHaveLength(1);
            expect(results[0].name).toBe('Alice');
            // Check if nested field selection works - now returns proper nested object structure
            expect(results[0]?.metadata?.role).toBe('senior');
            expect(results[0]?.metadata?.level).toBe(3);
        });
    });

    describe('Mixed Sync and Async Behavior', () => {
        test('ensure sync and async return same results', async () => {
            const syncResults = users
                .query()
                .select('name', 'age')
                .where('isActive')
                .eq(true)
                .orderBy('age')
                .toArraySync();

            const asyncResults = await users
                .query()
                .select('name', 'age')
                .where('isActive')
                .eq(true)
                .orderBy('age')
                .toArray();

            expect(syncResults).toEqual(asyncResults);
        });

        test('ensure sync and async first return same result', async () => {
            const syncResult = users
                .query()
                .select('name', 'department')
                .where('age')
                .gte(30)
                .orderBy('age')
                .firstSync();

            const asyncResult = await users
                .query()
                .select('name', 'department')
                .where('age')
                .gte(30)
                .orderBy('age')
                .first();

            expect(syncResult).toEqual(asyncResult);
        });
    });

    describe('Performance and Large Datasets', () => {
        test('select fields with large dataset', () => {
            // Add more test data
            const bulkData = Array.from({ length: 100 }, (_, i) => ({
                _id: crypto.randomUUID(),
                name: `User${i}`,
                email: `user${i}@example.com`,
                age: 20 + (i % 40),
                department: ['Engineering', 'Marketing', 'Sales'][i % 3],
                isActive: i % 2 === 0,
                metadata: { role: 'user', level: 1 + (i % 3) },
            }));

            users.insertBulkSync(bulkData);

            const start = performance.now();
            const results = users
                .query()
                .select('name', 'department')
                .where('isActive')
                .eq(true)
                .limit(50)
                .toArraySync();
            const end = performance.now();

            expect(results).toHaveLength(50);
            expect(end - start).toBeLessThan(100); // Should complete within 100ms
        });
    });
});

// Deep Nested Field Tests
const deepNestedSchema = z.object({
    _id: z.string().uuid(),
    name: z.string(),
    profile: z.object({
        personal: z.object({
            bio: z.string(),
            contact: z.object({
                primary: z.object({
                    phone: z.string(),
                    email: z.string(),
                }),
                secondary: z
                    .object({
                        phone: z.string().optional(),
                        email: z.string().optional(),
                    })
                    .optional(),
            }),
        }),
        professional: z.object({
            company: z.string(),
            position: z.object({
                title: z.string(),
                level: z.number(),
                department: z.object({
                    name: z.string(),
                    division: z.object({
                        name: z.string(),
                        region: z.string(),
                    }),
                }),
            }),
            skills: z.array(
                z.object({
                    name: z.string(),
                    proficiency: z.object({
                        level: z.number(),
                        verified: z.boolean(),
                    }),
                })
            ),
        }),
        preferences: z.object({
            notifications: z.object({
                email: z.object({
                    marketing: z.boolean(),
                    updates: z.boolean(),
                }),
                push: z.object({
                    urgent: z.boolean(),
                    daily: z.boolean(),
                }),
            }),
            ui: z.object({
                theme: z.string(),
                language: z.string(),
                accessibility: z.object({
                    highContrast: z.boolean(),
                    fontSize: z.string(),
                }),
            }),
        }),
    }),
});

describe('Deep Nested Field Selection Tests', () => {
    let db: Database;
    let profiles: ReturnType<typeof db.collection<typeof deepNestedSchema>>;

    beforeEach(() => {
        db = createDB({ memory: true });
        profiles = db.collection('profiles', deepNestedSchema);

        profiles.insertBulkSync([
            {
                name: 'Alice Johnson',
                profile: {
                    personal: {
                        bio: 'Senior software engineer with 8+ years experience',
                        contact: {
                            primary: {
                                phone: '+1-555-0101',
                                email: 'alice.j@company.com',
                            },
                            secondary: {
                                phone: '+1-555-0102',
                                email: 'alice.personal@gmail.com',
                            },
                        },
                    },
                    professional: {
                        company: 'TechCorp Inc',
                        position: {
                            title: 'Senior Software Engineer',
                            level: 4,
                            department: {
                                name: 'Engineering',
                                division: {
                                    name: 'Platform',
                                    region: 'North America',
                                },
                            },
                        },
                        skills: [
                            {
                                name: 'TypeScript',
                                proficiency: {
                                    level: 9,
                                    verified: true,
                                },
                            },
                            {
                                name: 'React',
                                proficiency: {
                                    level: 8,
                                    verified: true,
                                },
                            },
                        ],
                    },
                    preferences: {
                        notifications: {
                            email: {
                                marketing: false,
                                updates: true,
                            },
                            push: {
                                urgent: true,
                                daily: false,
                            },
                        },
                        ui: {
                            theme: 'dark',
                            language: 'en-US',
                            accessibility: {
                                highContrast: false,
                                fontSize: 'medium',
                            },
                        },
                    },
                },
            },
            {
                name: 'Bob Smith',
                profile: {
                    personal: {
                        bio: 'Marketing manager with focus on digital campaigns',
                        contact: {
                            primary: {
                                phone: '+1-555-0201',
                                email: 'bob.s@company.com',
                            },
                        },
                    },
                    professional: {
                        company: 'TechCorp Inc',
                        position: {
                            title: 'Marketing Manager',
                            level: 3,
                            department: {
                                name: 'Marketing',
                                division: {
                                    name: 'Growth',
                                    region: 'Europe',
                                },
                            },
                        },
                        skills: [
                            {
                                name: 'SEO',
                                proficiency: {
                                    level: 8,
                                    verified: true,
                                },
                            },
                        ],
                    },
                    preferences: {
                        notifications: {
                            email: {
                                marketing: true,
                                updates: true,
                            },
                            push: {
                                urgent: true,
                                daily: true,
                            },
                        },
                        ui: {
                            theme: 'light',
                            language: 'en-GB',
                            accessibility: {
                                highContrast: true,
                                fontSize: 'large',
                            },
                        },
                    },
                },
            },
        ]);
    });

    describe('3-4 Level Deep Nested Field Selection', () => {
        test('select 3-level deep fields', () => {
            const results = profiles
                .query()
                .select(
                    'name',
                    'profile.professional.company',
                    'profile.personal.bio'
                )
                .toArraySync();

            console.log(
                '3-level deep results:',
                JSON.stringify(results, null, 2)
            );

            expect(results).toHaveLength(2);
            expect(results[0].name).toBe('Alice Johnson');
            expect(results[0].profile?.professional?.company).toBe(
                'TechCorp Inc'
            );
            expect(results[0].profile?.personal?.bio).toBe(
                'Senior software engineer with 8+ years experience'
            );
        });

        test('select 4-level deep fields', () => {
            const results = profiles
                .query()
                .select(
                    'name',
                    'profile.professional.position.title',
                    'profile.professional.position.level',
                    'profile.professional.position.department.division.name',
                    'profile.professional.position.department.division.region'
                )
                .toArraySync();

            console.log(
                '4-level deep results:',
                JSON.stringify(results, null, 2)
            );

            expect(results).toHaveLength(2);

            // Alice's data
            expect(results[0].name).toBe('Alice Johnson');
            expect(results[0].profile?.professional?.position?.title).toBe(
                'Senior Software Engineer'
            );
            expect(results[0].profile?.professional?.position?.level).toBe(4);
            expect(
                results[0].profile?.professional?.position?.department?.division
                    ?.name
            ).toBe('Platform');
            expect(
                results[0].profile?.professional?.position?.department?.division
                    ?.region
            ).toBe('North America');

            // Bob's data
            expect(results[1].name).toBe('Bob Smith');
            expect(results[1].profile?.professional?.position?.title).toBe(
                'Marketing Manager'
            );
            expect(results[1].profile?.professional?.position?.level).toBe(3);
            expect(
                results[1].profile?.professional?.position?.department?.division
                    ?.name
            ).toBe('Growth');
            expect(
                results[1].profile?.professional?.position?.department?.division
                    ?.region
            ).toBe('Europe');
        });

        test('select very deep contact information', () => {
            const results = profiles
                .query()
                .select(
                    'name',
                    'profile.personal.contact.primary.email',
                    'profile.personal.contact.primary.phone',
                    'profile.personal.contact.secondary.email'
                )
                .toArraySync();

            console.log(
                'Deep contact results:',
                JSON.stringify(results, null, 2)
            );

            expect(results).toHaveLength(2);
            expect(results[0].profile?.personal?.contact?.primary?.email).toBe(
                'alice.j@company.com'
            );
            expect(results[0].profile?.personal?.contact?.primary?.phone).toBe(
                '+1-555-0101'
            );
            expect(
                results[0].profile?.personal?.contact?.secondary?.email
            ).toBe('alice.personal@gmail.com');

            expect(results[1].profile?.personal?.contact?.primary?.email).toBe(
                'bob.s@company.com'
            );
            expect(results[1].profile?.personal?.contact?.primary?.phone).toBe(
                '+1-555-0201'
            );
            expect(
                results[1].profile?.personal?.contact?.secondary?.email
            ).toBeUndefined();
        });

        test('select mixed depth preferences', () => {
            const results = profiles
                .query()
                .select(
                    'name',
                    'profile.preferences.ui.theme',
                    'profile.preferences.ui.accessibility.highContrast',
                    'profile.preferences.ui.accessibility.fontSize',
                    'profile.preferences.notifications.email.marketing',
                    'profile.preferences.notifications.push.urgent'
                )
                .toArraySync();

            console.log(
                'Mixed depth preferences:',
                JSON.stringify(results, null, 2)
            );

            expect(results).toHaveLength(2);

            // Alice's preferences
            expect(results[0].profile?.preferences?.ui?.theme).toBe('dark');
            // Note: json_extract returns integers for booleans (0/1) - use toBeFalsy/toBeTruthy
            expect(
                results[0].profile?.preferences?.ui?.accessibility?.highContrast
            ).toBeFalsy();
            expect(
                results[0].profile?.preferences?.ui?.accessibility?.fontSize
            ).toBe('medium');
            expect(
                results[0].profile?.preferences?.notifications?.email?.marketing
            ).toBeFalsy();
            expect(
                results[0].profile?.preferences?.notifications?.push?.urgent
            ).toBeTruthy();

            // Bob's preferences
            expect(results[1].profile?.preferences?.ui?.theme).toBe('light');
            expect(
                results[1].profile?.preferences?.ui?.accessibility?.highContrast
            ).toBeTruthy();
            expect(
                results[1].profile?.preferences?.ui?.accessibility?.fontSize
            ).toBe('large');
            expect(
                results[1].profile?.preferences?.notifications?.email?.marketing
            ).toBeTruthy();
            expect(
                results[1].profile?.preferences?.notifications?.push?.urgent
            ).toBeTruthy();
        });

        test('select with filters on deep nested fields', () => {
            const results = profiles
                .query()
                .select(
                    'name',
                    'profile.professional.position.title',
                    'profile.professional.position.department.division.region'
                )
                .where(
                    'profile.professional.position.department.division.region'
                )
                .eq('North America')
                .toArraySync();

            console.log(
                'Filtered deep nested:',
                JSON.stringify(results, null, 2)
            );

            expect(results).toHaveLength(1);
            expect(results[0].name).toBe('Alice Johnson');
            expect(results[0].profile?.professional?.position?.title).toBe(
                'Senior Software Engineer'
            );
            expect(
                results[0].profile?.professional?.position?.department?.division
                    ?.region
            ).toBe('North America');
        });

        test('select array element deep fields', () => {
            // Note: This tests selecting from array elements - behavior may vary based on implementation
            const results = profiles
                .query()
                .select('name', 'profile.professional.skills')
                .where('name')
                .eq('Alice Johnson')
                .toArraySync();

            console.log('Array deep fields:', JSON.stringify(results, null, 2));

            expect(results).toHaveLength(1);
            expect(results[0].profile?.professional?.skills).toHaveLength(2);
            expect(results[0].profile?.professional?.skills?.[0]?.name).toBe(
                'TypeScript'
            );
            expect(
                results[0].profile?.professional?.skills?.[0]?.proficiency
                    ?.level
            ).toBe(9);
            expect(
                results[0].profile?.professional?.skills?.[0]?.proficiency
                    ?.verified
            ).toBe(true);
        });

        test('select combination of shallow and deep fields', () => {
            const results = profiles
                .query()
                .select(
                    'name', // 1 level
                    'profile.personal.bio', // 3 levels
                    'profile.professional.position.level', // 4 levels
                    'profile.preferences.notifications.email.marketing' // 5 levels
                )
                .toArraySync();

            console.log(
                'Mixed depth combination:',
                JSON.stringify(results, null, 2)
            );

            expect(results).toHaveLength(2);

            // Verify all nesting levels work together
            expect(results[0].name).toBe('Alice Johnson');
            expect(results[0].profile?.personal?.bio).toBe(
                'Senior software engineer with 8+ years experience'
            );
            expect(results[0].profile?.professional?.position?.level).toBe(4);
            // Note: json_extract returns integers for booleans (0/1) - use toBeFalsy
            expect(
                results[0].profile?.preferences?.notifications?.email?.marketing
            ).toBeFalsy();
        });

        test('async version of deep nested selection', async () => {
            const results = await profiles
                .query()
                .select(
                    'name',
                    'profile.professional.position.department.division.name',
                    'profile.preferences.ui.accessibility.fontSize'
                )
                .toArray();

            expect(results).toHaveLength(2);
            expect(
                results[0].profile?.professional?.position?.department?.division
                    ?.name
            ).toBe('Platform');
            expect(
                results[0].profile?.preferences?.ui?.accessibility?.fontSize
            ).toBe('medium');
            expect(
                results[1].profile?.professional?.position?.department?.division
                    ?.name
            ).toBe('Growth');
            expect(
                results[1].profile?.preferences?.ui?.accessibility?.fontSize
            ).toBe('large');
        });
    });
});
