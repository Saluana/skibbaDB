import { describe, test, expect } from 'bun:test';
import { z } from 'zod/v3';
import { skibba, CollectionExistsError } from '../src/index';

describe('DX API', () => {
    test('skibba() and golden path aliases', async () => {
        const db = skibba();
        const schema = z.object({
            name: z.string(),
            email: z.string().email(),
        });
        const users = db.collection('users', schema, { unique: ['email'] });

        const ada = await users.insert({ name: 'Ada', email: 'ada@example.com' });
        expect(ada.id).toBe(ada._id);
        expect(await users.get(ada.id)).toEqual(ada);
        expect(await users.all()).toHaveLength(1);
        expect(await users.where('email').eq('ada@example.com').count()).toBe(1);

        await users.update(ada.id, { name: 'Ada L.' });
        expect((await users.get(ada.id))!.name).toBe('Ada L.');

        await db.close();
    });

    test('bulk namespace', async () => {
        const db = skibba();
        const schema = z.object({ name: z.string() });
        const items = db.collection('items', schema);
        const docs = await items.bulk.insert([{ name: 'a' }, { name: 'b' }]);
        expect(docs).toHaveLength(2);
        await db.close();
    });

    test('explain and health', async () => {
        const db = skibba();
        const schema = z.object({ email: z.string().email() });
        const users = db.collection('users', schema, { unique: ['email'] });
        const plan = await users.where('email').eq('x@y.com').explain();
        expect(plan.collection).toBe('users');
        expect(plan.sql).toContain('SELECT');
        const health = await db.health();
        expect(health.ok).toBe(true);
        expect(health.collections).toContain('users');
        await db.close();
    });

    test('duplicate collection error is actionable', () => {
        const db = skibba();
        const schema = z.object({ name: z.string() });
        db.collection('x', schema);
        expect(() => db.collection('x', schema)).toThrow(CollectionExistsError);
    });
});
