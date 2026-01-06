import { describe, test, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { createDB } from '../src/index';
import { ValidationError, DatabaseError } from '../src/errors';

describe('Transactions', () => {
    let db: ReturnType<typeof createDB>;
    const userSchema = z.object({
        _id: z
            .string()
            .uuid()
            .default(() => crypto.randomUUID()),
        name: z.string().min(1),
        email: z.string().email(),
        age: z.number().int().optional(),
        createdAt: z.date().default(() => new Date()),
    });
    const postSchema = z.object({
        _id: z
            .string()
            .uuid()
            .default(() => crypto.randomUUID()),
        title: z.string(),
        content: z.string(),
        authorId: z.string().uuid(),
    });

    beforeEach(() => {
        db = createDB({ memory: true });
    });

    test('commits all changes on success', async () => {
        const users = db.collection('users', userSchema);
        const posts = db.collection('posts', postSchema);
        const result = await db.transaction(async () => {
            const user = await users.insert({
                name: 'John',
                email: 'john@example.com',
            });
            const post = await posts.insert({
                title: 'Hello',
                content: 'World',
                authorId: user._id!,
            });
            return { user, post };
        });
        expect(result.user.name).toBe('John');
        expect(users.toArraySync()).toHaveLength(1);
        expect(posts.toArraySync()).toHaveLength(1);
    });

    test('rolls back all changes on error', async () => {
        const users = db.collection('users', userSchema);
        let error;
        try {
            await db.transaction(async () => {
                await users.insert({ name: 'A', email: 'a@example.com' });
                throw new Error('fail');
            });
        } catch (e) {
            error = e;
        }
        expect(error).toBeTruthy();
        expect(users.toArraySync()).toHaveLength(0);
    });

    test('rolls back on validation error', async () => {
        const users = db.collection('users', userSchema);
        let error;
        try {
            await db.transaction(async () => {
                await users.insert({ name: '', email: 'bad' } as any);
            });
        } catch (e) {
            error = e;
        }
        expect(error).toBeInstanceOf(ValidationError);
        expect(users.toArraySync()).toHaveLength(0);
    });

    test('returns value from transaction', async () => {
        const users = db.collection('users', userSchema);
        const id = await db.transaction(async () => {
            const user = await users.insert({
                name: 'Jane',
                email: 'jane@example.com',
            });
            return user._id;
        });
        expect(typeof id).toBe('string');
        expect(users.findById(id!)).toBeTruthy();
    });

    test('nested transactions reuse context and rollback all', async () => {
        const users = db.collection('users', userSchema);
        let error;
        try {
            await db.transaction(async () => {
                await users.insert({
                    name: 'Outer',
                    email: 'outer@example.com',
                });
                await db.transaction(async () => {
                    await users.insert({
                        name: 'Inner',
                        email: 'inner@example.com',
                    });
                });
                throw new Error('fail outer');
            });
        } catch (e) {
            error = e;
        }
        expect(error).toBeTruthy();
        expect(users.toArraySync()).toHaveLength(0);
    });

    test('nested transaction with SAVEPOINT commits inner independently', async () => {
        const users = db.collection('users', userSchema);
        
        await db.transaction(async () => {
            await users.insert({
                name: 'Outer1',
                email: 'outer1@example.com',
            });
            
            // Nested transaction should commit independently
            await db.transaction(async () => {
                await users.insert({
                    name: 'Inner1',
                    email: 'inner1@example.com',
                });
            });
            
            // Outer continues
            await users.insert({
                name: 'Outer2',
                email: 'outer2@example.com',
            });
        });
        
        expect(users.toArraySync()).toHaveLength(3);
    });

    test('nested transaction rollback does not affect outer', async () => {
        const users = db.collection('users', userSchema);
        
        await db.transaction(async () => {
            await users.insert({
                name: 'Outer',
                email: 'outer@example.com',
            });
            
            // Inner transaction fails
            try {
                await db.transaction(async () => {
                    await users.insert({
                        name: 'Inner',
                        email: 'inner@example.com',
                    });
                    throw new Error('inner fail');
                });
            } catch (e) {
                // Expected
            }
            
            // Outer can continue after inner rollback
            await users.insert({
                name: 'Outer2',
                email: 'outer2@example.com',
            });
        });
        
        // Only outer inserts should be present
        expect(users.toArraySync()).toHaveLength(2);
        const names = users.toArraySync().map(u => u.name);
        expect(names).toContain('Outer');
        expect(names).toContain('Outer2');
        expect(names).not.toContain('Inner');
    });

    test('deeply nested transactions work correctly', async () => {
        const users = db.collection('users', userSchema);
        
        await db.transaction(async () => {
            await users.insert({ name: 'L1', email: 'l1@example.com' });
            
            await db.transaction(async () => {
                await users.insert({ name: 'L2', email: 'l2@example.com' });
                
                await db.transaction(async () => {
                    await users.insert({ name: 'L3', email: 'l3@example.com' });
                });
            });
        });
        
        expect(users.toArraySync()).toHaveLength(3);
    });

    test('bulk operations are atomic', async () => {
        const users = db.collection('users', userSchema);
        await db.transaction(async () => {
            await users.insertBulk([
                { name: 'A', email: 'a@example.com' },
                { name: 'B', email: 'b@example.com' },
            ]);
        });
        expect(users.toArraySync()).toHaveLength(2);
    });

    test('bulk operations rollback on error', async () => {
        const users = db.collection('users', userSchema);
        let error;
        try {
            await db.transaction(async () => {
                await users.insertBulk([
                    { name: 'A', email: 'a@example.com' },
                    { name: '', email: 'bad' } as any,
                ]);
            });
        } catch (e) {
            error = e;
        }
        expect(error).toBeInstanceOf(ValidationError);
        expect(users.toArraySync()).toHaveLength(0);
    });

    test('supports reads and writes in transaction', async () => {
        const users = db.collection('users', userSchema);
        await users.insert({ name: 'X', email: 'x@example.com' });
        const result = await db.transaction(async () => {
            const before = (await users.toArray()).length;
            await users.insert({ name: 'Y', email: 'y@example.com' });
            const after = (await users.toArray()).length;
            return { before, after };
        });
        expect(result.before).toBe(1);
        expect(result.after).toBe(2);
        expect(users.toArraySync()).toHaveLength(2);
    });

    test('transaction isolation: changes not visible until commit', async () => {
        const users = db.collection('users', userSchema);
        let txDone = false;
        const tx = db.transaction(async () => {
            await users.insert({ name: 'Z', email: 'z@example.com' });
            await new Promise((r) => setTimeout(r, 20));
            txDone = true;
            return users.toArraySync().length;
        });
        expect(users.toArraySync()).toHaveLength(0);
        const count = await tx;
        expect(txDone).toBe(true);
        expect(count).toBe(1);
        expect(users.toArraySync()).toHaveLength(1);
    });

    test('commits an empty transaction', async () => {
        const result = await db.transaction(async () => {
            // No operations
            return 'empty';
        });
        expect(result).toBe('empty');
    });

    test('throws if non-Error value is thrown in transaction', async () => {
        let error;
        try {
            await db.transaction(async () => {
                throw 'string error';
            });
        } catch (e) {
            error = e;
        }
        expect(error).toBe('string error');
    });

    test('transaction rejects on async error', async () => {
        let error;
        try {
            await db.transaction(async () => {
                await Promise.reject(new Error('async fail'));
            });
        } catch (e) {
            error = e;
        }
        expect(error instanceof Error ? error.message : error).toBe(
            'async fail'
        );
    });

    test('writing to non-existent collection in transaction throws', async () => {
        let error;
        try {
            await db.transaction(async () => {
                await (db as any).collection('ghosts').insert({ foo: 'bar' });
            });
        } catch (e) {
            error = e;
        }
        expect(error).toBeInstanceOf(Error);
    });

    test('nested transaction: inner commit, outer rollback', async () => {
        const users = db.collection('users', userSchema);
        let error;
        try {
            await db.transaction(async () => {
                await users.insert({
                    name: 'Outer',
                    email: 'outer@example.com',
                });
                await db.transaction(async () => {
                    await users.insert({
                        name: 'Inner',
                        email: 'inner@example.com',
                    });
                });
                throw new Error('fail outer');
            });
        } catch (e) {
            error = e;
        }
        expect(error).toBeTruthy();
        expect(users.toArraySync()).toHaveLength(0);
    });

    test('transaction with no operations does not throw', async () => {
        await expect(db.transaction(async () => {})).resolves.toBeUndefined();
    });

    test('transaction with simultaneous reads and writes to multiple collections', async () => {
        const users = db.collection('users', userSchema);
        const posts = db.collection('posts', postSchema);
        await users.insert({ name: 'A', email: 'a@example.com' });
        const author = users.toArraySync()[0];
        expect(author).toBeTruthy();
        await db.transaction(async () => {
            await users.insert({ name: 'B', email: 'b@example.com' });
            await posts.insert({
                title: 'T',
                content: 'C',
                authorId: author._id!,
            });
            expect(await users.toArray()).toHaveLength(2);
            expect(await posts.toArray()).toHaveLength(1);
        });
        expect(users.toArraySync()).toHaveLength(2);
        expect(posts.toArraySync()).toHaveLength(1);
    });

    test('transaction with schema validation edge case: missing required field', async () => {
        const users = db.collection('users', userSchema);
        let error;
        try {
            await db.transaction(async () => {
                await users.insert({ email: 'missingname@example.com' } as any);
            });
        } catch (e) {
            error = e;
        }
        expect(error).toBeInstanceOf(ValidationError);
        expect(users.toArraySync()).toHaveLength(0);
    });

    test('transaction with schema validation edge case: invalid type', async () => {
        const users = db.collection('users', userSchema);
        let error;
        try {
            await db.transaction(async () => {
                await users.insert({ name: 'Bad', email: 12345 } as any);
            });
        } catch (e) {
            error = e;
        }
        expect(error).toBeInstanceOf(ValidationError);
        expect(users.toArraySync()).toHaveLength(0);
    });
});
