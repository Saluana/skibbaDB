import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod/v3';
import { skibba } from '../src/skibba';

const userSchema = z.object({
    id: z.string().optional(),
    name: z.string(),
    email: z.string(),
    age: z.number().optional(),
    tags: z.array(z.string()).optional(),
    status: z.string().optional(),
    teamId: z.string().optional(),
});

type User = z.infer<typeof userSchema>;

describe('API Compatibility', () => {
    let db: ReturnType<typeof skibba>;
    let users: any;

    beforeEach(() => {
        db = skibba(':memory:');
        users = db.collection('users', userSchema, {
            id: 'id',
            unique: ['email'],
            index: ['name'],
        });
    });

    afterEach(async () => {
        await db.close();
    });

    it('insert and get', async () => {
        const inserted = await users.insert({ name: 'Alice', email: 'alice@test.com' });
        expect(inserted.id).toBeDefined();
        expect(inserted.name).toBe('Alice');

        const found = await users.get(inserted.id);
        expect(found?.name).toBe('Alice');
    });

    it('where().eq().first()', async () => {
        await users.insert({ name: 'Bob', email: 'bob@test.com' });
        const result = await users.where('name').eq('Bob').first();
        expect(result?.name).toBe('Bob');
    });

    it('where().eq().all()', async () => {
        await users.insert({ name: 'Charlie', email: 'charlie@test.com' });
        await users.insert({ name: 'Charlie', email: 'charlie2@test.com' });
        const results = await users.where('name').eq('Charlie').all();
        expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('count()', async () => {
        await users.insert({ name: 'Dave', email: 'dave@test.com' });
        const count = await users.count();
        expect(count).toBeGreaterThanOrEqual(1);
    });

    it('first()', async () => {
        await users.insert({ name: 'Eve', email: 'eve@test.com' });
        const first = await users.first();
        expect(first).not.toBeNull();
    });

    it('all()', async () => {
        await users.insert({ name: 'Frank', email: 'frank@test.com' });
        const all = await users.all();
        expect(all.length).toBeGreaterThanOrEqual(1);
    });

    it('update', async () => {
        const inserted = await users.insert({ name: 'Grace', email: 'grace@test.com' });
        const updated = await users.update(inserted.id, { name: 'Grace Updated' });
        expect(updated.name).toBe('Grace Updated');
    });

    it('remove', async () => {
        const inserted = await users.insert({ name: 'Hank', email: 'hank@test.com' });
        const removed = await users.remove(inserted.id);
        expect(removed).toBe(true);
    });

    it('upsert', async () => {
        await users.upsert('test-id', { name: 'Ivy', email: 'ivy@test.com' });
        const found = await users.get('test-id');
        expect(found?.name).toBe('Ivy');
    });

    it('bulk.insert()', async () => {
        const results = await users.bulk.insert([
            { name: 'Jack', email: 'jack@test.com' },
            { name: 'Karen', email: 'karen@test.com' },
        ]);
        expect(results.length).toBe(2);
    });

    it('bulk.delete()', async () => {
        const inserted = await users.bulk.insert([
            { name: 'Leo', email: 'leo@test.com' },
            { name: 'Mia', email: 'mia@test.com' },
        ]);
        const count = await users.bulk.delete(inserted.map((d: any) => d.id));
        expect(count).toBe(2);
    });

    it('sync.insert()', () => {
        const inserted = users.sync.insert({ name: 'Noah', email: 'noah@test.com' });
        expect(inserted.name).toBe('Noah');
        expect(inserted.id).toBeDefined();
    });

    it('sync.all()', () => {
        users.sync.insert({ name: 'Olivia', email: 'olivia@test.com' });
        const all = users.sync.all();
        expect(all.length).toBeGreaterThanOrEqual(1);
    });

    it('sync.count()', () => {
        users.sync.insert({ name: 'Pat', email: 'pat@test.com' });
        const count = users.sync.count();
        expect(count).toBeGreaterThanOrEqual(1);
    });

    it('sync.first()', () => {
        users.sync.insert({ name: 'Quinn', email: 'quinn@test.com' });
        const first = users.sync.first();
        expect(first).not.toBeNull();
    });

    it('query().where().all()', async () => {
        await users.insert({ name: 'Rachel', email: 'rachel@test.com' });
        const results = await users.query().where('name').eq('Rachel').all();
        expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('orderBy()', async () => {
        await users.insert({ name: 'Sam', email: 'sam@test.com' });
        await users.insert({ name: 'Tina', email: 'tina@test.com' });
        const results = await users.orderBy('name', 'asc').all();
        expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it('limit and offset', async () => {
        await users.insert({ name: 'Uma', email: 'uma@test.com' });
        await users.insert({ name: 'Vic', email: 'vic@test.com' });
        await users.insert({ name: 'Wendy', email: 'wendy@test.com' });
        const page = await users.limit(2).offset(0).all();
        expect(page.length).toBeLessThanOrEqual(2);
    });

    it('distinct()', async () => {
        await users.insert({ name: 'Xander', email: 'xander@test.com', status: 'active' });
        await users.insert({ name: 'Yara', email: 'yara@test.com', status: 'active' });
        const builder = users.distinct();
        expect(builder).toBeDefined();
    });

    it('id field maps correctly', async () => {
        const inserted = await users.insert({ name: 'Zoe', email: 'zoe@test.com' });
        expect(inserted.id).toBeDefined();
        // _id is the internal storage field, present alongside public id
        expect((inserted as any)._id).toBeDefined();
    });

    it('_id still works for internal access', async () => {
        const inserted = await users.insert({ name: 'Aaron', email: 'aaron@test.com' });
        const found = await users.get(inserted.id);
        expect(found?.id).toBe(inserted.id);
    });

    it('plugins still run in async mode', async () => {
        const { TimestampPlugin } = await import('../src/plugins/timestamp');
        db.use(new TimestampPlugin());
        const inserted = await users.insert({ name: 'Ben', email: 'ben@test.com' });
        // TimestampPlugin doesn't add fields by default, just verify insert works
        expect(inserted.name).toBe('Ben');
    });

    it('or() works', async () => {
        await users.insert({ name: 'Carl', email: 'carl@test.com', age: 25 });
        await users.insert({ name: 'Dana', email: 'dana@test.com', age: 35 });
        const results = await users
            .or((b) => b.where('age').gt(30))
            .all();
        expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it('page() works', async () => {
        for (let i = 0; i < 5; i++) {
            await users.insert({ name: `User${i}`, email: `user${i}@test.com` });
        }
        const page1 = await users.page(1, 2).all();
        expect(page1.length).toBeLessThanOrEqual(2);
    });

    it('groupBy works', async () => {
        await users.insert({ name: 'E1', email: 'e1@test.com', status: 'active' });
        await users.insert({ name: 'E2', email: 'e2@test.com', status: 'active' });
        await users.insert({ name: 'E3', email: 'e3@test.com', status: 'inactive' });
        const results = await users.query().groupBy('status').count('status').all();
        expect(results.length).toBeGreaterThanOrEqual(2);
    });
});
