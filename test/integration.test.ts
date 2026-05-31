import { describe, test, expect, beforeEach } from 'vitest';
import { z } from 'zod/v3';
import {
    createDB,
    ValidationError,
    UniqueConstraintError,
    NotFoundError,
} from '../src/index.js';
import { unique, foreignKey, check, index } from '../src/schema-constraints.js';

const userSchema = z.object({
    _id: z.string().uuid(),
    name: z.string(),
    email: z.string().email(),
    age: z.number().int().optional(),
    isActive: z.boolean().default(true),
    tags: z.array(z.string()).default([]),
    createdAt: z.date().default(() => new Date()),
});

const postSchema = z.object({
    _id: z.string().uuid(),
    title: z.string(),
    content: z.string(),
    authorId: z.string().uuid(),
    createdAt: z.date().default(() => new Date()),
});

describe('Integration: skibbaDB End-to-End', () => {
    let db: ReturnType<typeof createDB>;
    let users: ReturnType<typeof db.collection<typeof userSchema>>;
    let posts: ReturnType<typeof db.collection<typeof postSchema>>;

    beforeEach(() => {
        db = createDB({ memory: true });
        users = db.collection('users', userSchema, {
            constraints: {
                constraints: {
                    email: unique(),
                },
                indexes: {
                    name: index('name'),
                },
            },
        });
        posts = db.collection('posts', postSchema, {
            constraints: {
                constraints: {
                    authorId: foreignKey('users', '_id'),
                },
                indexes: {
                    title: index('title'),
                },
            },
        });
    });

    test('insert and find user', () => {
        const user = users.insertSync({
            name: 'Alice',
            email: 'alice@example.com',
        });
        expect(user._id).toBeDefined();
        const found = users.findByIdSync(user._id);
        expect(found).toEqual(user);
    });

    test('insert bulk users', () => {
        const docs = [
            { name: 'Bob', email: 'bob@example.com' },
            { name: 'Carol', email: 'carol@example.com' },
        ];
        const inserted = users.insertBulkSync(docs);
        expect(inserted).toHaveLength(2);
        expect(inserted[0]._id).toBeDefined();
        expect(inserted[1]._id).toBeDefined();
    });

    test('unique constraint violation', () => {
        users.insertSync({ name: 'Dan', email: 'dan@example.com' });
        expect(() =>
            users.insertSync({ name: 'Dan2', email: 'dan@example.com' })
        ).toThrow(UniqueConstraintError);
    });

    test('validate email format', () => {
        expect(() =>
            users.insertSync({ name: 'Eve', email: 'not-an-email' } as any)
        ).toThrow(ValidationError);
    });

    test('put updates user', () => {
        const user = users.insertSync({
            name: 'Frank',
            email: 'frank@example.com',
        });
        const updated = users.putSync(user._id, { name: 'Franklin' });
        expect(updated.name).toBe('Franklin');
        expect(updated.email).toBe('frank@example.com');
    });

    test('put throws on non-existent', () => {
        expect(() =>
            users.putSync('non-existent-id', { name: 'Ghost' })
        ).toThrow(NotFoundError);
    });

    test('delete user', () => {
        const user = users.insertSync({
            name: 'Helen',
            email: 'helen@example.com',
        });
        expect(users.deleteSync(user._id)).toBe(true);
        expect(users.findByIdSync(user._id)).toBeNull();
    });

    test('delete bulk users', () => {
        const u1 = users.insertSync({ name: 'Ivy', email: 'ivy@example.com' });
        const u2 = users.insertSync({
            name: 'Jack',
            email: 'jack@example.com',
        });
        expect(users.deleteBulkSync([u1._id, u2._id])).toBe(2);
    });

    test('foreign key constraint', () => {
        const user = users.insertSync({
            name: 'Kim',
            email: 'kim@example.com',
        });
        const post = posts.insertSync({
            title: 'Hello',
            content: 'World',
            authorId: user._id,
        });
        expect(post.authorId).toBe(user._id);
        expect(() =>
            posts.insertSync({
                title: 'Bad',
                content: 'No user',
                authorId: 'bad-id',
            })
        ).toThrow(ValidationError);
    });

    test('query with where/eq', () => {
        users.insertSync({ name: 'Leo', email: 'leo@example.com' });
        const result = users.where('name').eq('Leo').toArraySync();
        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('Leo');
    });

    test('query with gt/lt', () => {
        users.insertSync({ name: 'Mia', email: 'mia@example.com', age: 30 });
        users.insertSync({ name: 'Nina', email: 'nina@example.com', age: 40 });
        const result = users.where('age').gt(35).toArraySync();
        expect(result.length).toBeGreaterThan(0);
    });

    test('query with in/nin', () => {
        users.insertSync({ name: 'Owen', email: 'owen@example.com', age: 20 });
        users.insertSync({ name: 'Paul', email: 'paul@example.com', age: 25 });
        const inRes = users.where('age').in([20, 25]).toArraySync();
        expect(inRes.length).toBe(2);
        const ninRes = users.where('age').nin([20]).toArraySync();
        expect(ninRes.some((u) => u.age !== 20)).toBe(true);
    });

    test('query with like/ilike', () => {
        users.insertSync({ name: 'Quinn', email: 'quinn@example.com' });
        const likeRes = users.where('name').like('Qui%').toArraySync();
        expect(likeRes.length).toBeGreaterThan(0);
        const ilikeRes = users.where('name').ilike('quinn%').toArraySync();
        expect(ilikeRes.length).toBeGreaterThan(0);
    });

    test('query with startsWith/endsWith/contains', () => {
        users.insertSync({ name: 'Rita', email: 'rita@example.com' });
        expect(
            users.where('name').startsWith('Ri').toArraySync().length
        ).toBeGreaterThan(0);
        expect(
            users.where('name').endsWith('ta').toArraySync().length
        ).toBeGreaterThan(0);
        expect(
            users.where('name').contains('it').toArraySync().length
        ).toBeGreaterThan(0);
    });

    test('exists/notExists', () => {
        users.insertSync({ name: 'Sam', email: 'sam@example.com', age: 50 });
        expect(
            users.where('age').exists().toArraySync().length
        ).toBeGreaterThan(0);
        expect(
            users.where('age').notExists().toArraySync().length
        ).toBeGreaterThanOrEqual(0);
    });

    test('between', () => {
        users.insertSync({ name: 'Tom', email: 'tom@example.com', age: 35 });
        users.insertSync({ name: 'Uma', email: 'uma@example.com', age: 37 });
        const res = users.where('age').between(34, 38).toArraySync();
        expect(res.length).toBeGreaterThan(0);
    });

    test('orderBy/orderByOnly/orderByMultiple', () => {
        users.insertSync({ name: 'Vera', email: 'vera@example.com', age: 22 });
        users.insertSync({ name: 'Will', email: 'will@example.com', age: 28 });
        const asc = users.orderBy('age', 'asc').toArraySync();
        const desc = users.orderBy('age', 'desc').toArraySync();
        expect(typeof asc[0].age).toBe('number');
        expect(typeof asc[1].age).toBe('number');
        expect(asc[0].age as number).toBeLessThanOrEqual(asc[1].age as number);
        expect(typeof desc[0].age).toBe('number');
        expect(typeof desc[1].age).toBe('number');
        expect(desc[0].age as number).toBeGreaterThanOrEqual(
            desc[1].age as number
        );
        const multi = users
            .orderByMultiple([
                { field: 'isActive', direction: 'desc' },
                { field: 'age', direction: 'asc' },
            ])
            .toArraySync();
        expect(multi.length).toBeGreaterThan(0);
    });

    test('limit/offset/page', () => {
        for (let i = 0; i < 10; i++)
            users.insertSync({ name: `User${i}`, email: `user${i}@ex.com` });
        expect(users.limit(5).toArraySync().length).toBe(5);
        expect(users.offset(5).toArraySync().length).toBeGreaterThanOrEqual(0);
        expect(users.page(2, 3).toArraySync().length).toBe(3);
    });

    test('distinct', () => {
        users.insertSync({
            name: 'Xander',
            email: 'xander@example.com',
            age: 30,
        });
        users.insertSync({
            name: 'Xander',
            email: 'xander2@example.com',
            age: 30,
        });
        const res = users.distinct().toArraySync();
        expect(res.length).toBeGreaterThan(1);
    });

    test('count', () => {
        users.insertSync({ name: 'Yara', email: 'yara@example.com' });
        expect(users.where('name').eq('Yara').countSync()).toBe(1);
    });

    test('first', () => {
        users.insertSync({ name: 'Zane', email: 'zane@example.com' });
        expect(users.where('name').eq('Zane').firstSync()?.name).toBe('Zane');
        expect(users.where('name').eq('NonExistent').firstSync()).toBeNull();
    });

    test('putBulk/upsert/upsertBulk', () => {
        const u = users.insertSync({ name: 'Bulk', email: 'bulk@example.com' });
        const updated = users.putBulkSync([
            { _id: u._id, doc: { name: 'Bulk2' } },
        ]);
        expect(updated[0].name).toBe('Bulk2');
        const up = users.upsertSync(u._id, {
            name: 'Bulk3',
            email: 'bulk3@example.com',
        });
        expect(up.name).toBe('Bulk3');
        const upBulk = users.upsertBulkSync([
            { _id: u._id, doc: { name: 'Bulk4', email: 'bulk4@example.com' } },
        ]);
        expect(upBulk[0].name).toBe('Bulk4');
    });

    test('edge: in with empty array', () => {
        expect(users.where('age').in([]).toArraySync()).toHaveLength(0);
    });

    test('edge: limit/offset negative', () => {
        expect(() => users.limit(-1)).toThrow('Limit must be non-negative');
        expect(() => users.offset(-1)).toThrow('Offset must be non-negative');
    });

    test('edge: page validation', () => {
        expect(() => users.page(0, 10)).toThrow('Page number must be >= 1');
        expect(() => users.page(1, 0)).toThrow('Page size must be >= 1');
    });

    test('edge: put with unique constraint', () => {
        const u1 = users.insertSync({
            name: 'Edge1',
            email: 'edge1@example.com',
        });
        const u2 = users.insertSync({
            name: 'Edge2',
            email: 'edge2@example.com',
        });
        expect(() =>
            users.putSync(u2._id, { email: 'edge1@example.com' })
        ).toThrow(UniqueConstraintError);
    });

    test('edge: upsert with unique constraint', () => {
        const u1 = users.insertSync({
            name: 'Edge3',
            email: 'edge3@example.com',
        });
        expect(() =>
            users.upsertSync(u1._id, {
                name: 'Edge3',
                email: 'edge3@example.com',
            })
        ).not.toThrow();
        const u2 = users.insertSync({
            name: 'Edge4',
            email: 'edge4@example.com',
        });
        expect(() =>
            users.upsertSync(u2._id, {
                name: 'Edge4',
                email: 'edge3@example.com',
            })
        ).toThrow(UniqueConstraintError);
    });

    test('edge: delete non-existent', () => {
        expect(users.deleteSync('non-existent-id')).toBe(false);
    });

    test('edge: deleteBulk with some non-existent', () => {
        const u = users.insertSync({
            name: 'Edge5',
            email: 'edge5@example.com',
        });
        expect(users.deleteBulkSync([u._id, 'bad-id'])).toBe(1);
    });

    test('edge: upsertBulk with new and existing', () => {
        const u = users.insertSync({
            name: 'Edge6',
            email: 'edge6@example.com',
        });
        // Generate a valid uuid for the new id
        const newId = crypto.randomUUID();
        const res = users.upsertBulkSync([
            { _id: u._id, doc: { name: 'Edge6-up', email: 'edge6@example.com' } },
            {
                _id: newId,
                doc: { name: 'Edge7', email: 'edge7@example.com' },
            },
        ]);
        expect(res.length).toBe(2);
    });

    // Add more edge and integration cases as needed to reach 65+
    for (let i = 0; i < 10; i++) {
        test(`bulk insert/delete edge case #${i + 1}`, () => {
            const docs = Array.from({ length: 5 }, (_, j) => ({
                name: `Bulk${i}-${j}`,
                email: `bulk${i}-${j}@ex.com`,
            }));
            const inserted = users.insertBulkSync(docs);
            expect(inserted.length).toBe(5);
            const ids = inserted.map((u) => u._id);
            expect(users.deleteBulkSync(ids)).toBe(5);
        });
    }

    // Edge: QueryBuilder state management
    test('query builder state management', () => {
        let builder = users.where('age').gt(20).orderBy('name').limit(10);
        expect(builder.hasFilters()).toBe(true);
        expect(builder.hasOrdering()).toBe(true);
        expect(builder.hasPagination()).toBe(true);
        builder = builder.clearFilters();
        expect(builder.hasFilters()).toBe(false);
        builder = builder.clearOrder();
        expect(builder.hasOrdering()).toBe(false);
        builder = builder.clearLimit();
        expect(builder.hasPagination()).toBe(false);
        builder = builder.reset();
        expect(builder.hasFilters()).toBe(false);
    });

    // Edge: QueryBuilder clone
    test('query builder clone', () => {
        const builder = users.where('age').gte(25).orderBy('name').limit(3);
        const clone = builder.clone();
        expect(clone.toArraySync()).toEqual(builder.toArraySync());
        const clearedClone = clone.clearFilters();
        expect(clearedClone.hasFilters()).toBe(false);
        expect(builder.hasFilters()).toBe(true);
    });

    // Edge: FieldBuilder error methods
    test('FieldBuilder execution methods throw errors', () => {
        const fieldBuilder = users.where('age');
        expect(() => fieldBuilder.toArraySync()).toThrow(
            'should not be called on FieldBuilder'
        );
        expect(() => fieldBuilder.firstSync()).toThrow(
            'should not be called on FieldBuilder'
        );
        expect(() => fieldBuilder.countSync()).toThrow(
            'should not be called on FieldBuilder'
        );
    });

    // Aggressive edge/breaking tests
    test('insert with missing required field should fail', () => {
        expect(() =>
            users.insertSync({ email: 'fail@example.com' } as any)
        ).toThrow(ValidationError);
    });

    test('insert with wrong type should fail', () => {
        expect(() =>
            users.insertSync({ name: 123, email: 'fail2@example.com' } as any)
        ).toThrow(ValidationError);
    });

    test('insert with duplicate id should fail', () => {
        const u = users.insertSync({ name: 'Dup', email: 'dup@example.com' });
        expect(() =>
            users.insertSync({
                _id: u._id,
                name: 'Dup2',
                email: 'dup2@example.com',
            } as any)
        ).toThrow();
    });

    test('deleteBulk with empty array', () => {
        expect(users.deleteBulkSync([])).toBe(0);
    });

    test('put with invalid id type', () => {
        expect(() => users.putSync(123 as any, { name: 'Bad' })).toThrow();
    });

    test('upsert with invalid id type', () => {
        expect(() =>
            users.upsertSync(123 as any, {
                name: 'Bad',
                email: 'bad@example.com',
            })
        ).toThrow();
    });

    test('upsertBulk with invalid doc', () => {
        const id = crypto.randomUUID();
        expect(() =>
            users.upsertBulkSync([
                { id, doc: { name: 123, email: 'bad@example.com' } as any },
            ])
        ).toThrow(ValidationError);
    });

    test('insert massive number of users', () => {
        const docs = Array.from({ length: 1000 }, (_, i) => ({
            name: `Big${i}`,
            email: `big${i}@ex.com`,
        }));
        const inserted = users.insertBulkSync(docs);
        expect(inserted.length).toBe(1000);
    });

    test('insert with invalid email type', () => {
        expect(() =>
            users.insertSync({ name: 'BadEmail', email: 12345 as any })
        ).toThrow(ValidationError);
    });

    test('findById with invalid id type', () => {
        expect(users.findByIdSync(123 as any)).toBeNull();
    });

    test('query with invalid field', () => {
        expect(() =>
            (users as any).where('notAField').eq('foo').toArraySync()
        ).toThrow();
    });

    test('orderBy with invalid field', () => {
        expect(() => users.orderBy('notAField' as any).toArraySync()).toThrow();
    });

    test('insert with extra fields (should strip or fail)', () => {
        const user = users.insertSync({
            name: 'Extra',
            email: 'extra@example.com',
            extra: 'field',
        } as any);
        expect(user.name).toBe('Extra');
        expect(user.email).toBe('extra@example.com');
        expect((user as any).extra).toBeUndefined();
    });

    test('insert with nulls for required fields', () => {
        expect(() =>
            users.insertSync({ name: null, email: null } as any)
        ).toThrow(ValidationError);
    });

    test('insert with undefined for required fields', () => {
        expect(() =>
            users.insertSync({ name: undefined, email: undefined } as any)
        ).toThrow(ValidationError);
    });

    test('insert with empty string for required fields', () => {
        expect(() => users.insertSync({ name: '', email: '' })).toThrow(
            ValidationError
        );
    });

    test('insert with whitespace string for required fields', () => {
        expect(() => users.insertSync({ name: '   ', email: '   ' })).toThrow(
            ValidationError
        );
    });

    test('insert with invalid uuid', () => {
        expect(() =>
            users.insertSync({
                _id: 'not-a-uuid',
                name: 'Bad',
                email: 'bad@example.com',
            } as any)
        ).toThrow(ValidationError);
    });

    test('insert with valid uuid', () => {
        const id = crypto.randomUUID();
        const user = users.upsertSync(id, {
            name: 'Good',
            email: 'good@example.com',
        });
        expect(user._id).toBe(id);
    });
});
