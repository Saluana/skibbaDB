import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { z } from 'zod/v3';
import { skibba } from '../src/index';
import { ValidationPlugin, validators } from '../src/plugins/validation';
import type { Database } from '../src/database';

describe('DI issues regression fixes', () => {
    let db: Database;

    beforeEach(() => {
        db = skibba({ memory: true });
    });

    afterEach(() => {
        db.close();
    });

    test('ValidationPlugin blocks insert when strict validation fails', async () => {
        db.use(
            new ValidationPlugin().addRule({
                field: 'name',
                validator: validators.pattern(/^ok-/),
                message: 'name must start with ok-',
            })
        );
        const schema = z.object({ name: z.string() });
        const users = db.collection('validated_users', schema);

        await expect(users.insert({ name: 'bad' })).rejects.toThrow(
            'Validation Error'
        );
        expect(await users.count()).toBe(0);
    });

    test('bulk.insert honors public id field', async () => {
        const schema = z.object({ label: z.string() });
        const items = db.collection('bulk_ids', schema);
        const docs = await items.bulk.insert([
            { id: 'public-1', label: 'one' } as any,
        ]);
        expect(docs[0].id).toBe('public-1');
        expect(await items.get('public-1')).not.toBeNull();
    });

    test('update and first attach public id without explicit schema id field', async () => {
        const schema = z.object({ name: z.string() });
        const users = db.collection('public_id_reads', schema);
        const created = await users.insert({ name: 'Ada' });
        const updated = await users.update(created.id, { name: 'Ada L.' });
        expect(updated.id).toBe(created.id);
        const first = await users.first();
        expect(first?.id).toBe(created.id);
    });

    test('limit(0) returns no rows', async () => {
        const schema = z.object({ name: z.string() });
        const users = db.collection('limit_zero', schema);
        await users.insert({ name: 'a' });
        await users.insert({ name: 'b' });
        expect(await users.limit(0).all()).toEqual([]);
    });

    test('sync.remove returns false for missing documents', () => {
        const schema = z.object({ name: z.string() });
        const items = db.collection('sync_remove', schema);
        expect(items.sync.remove('missing-id')).toBe(false);
    });

    test('rejects malicious select field paths', () => {
        const schema = z.object({ name: z.string() });
        const users = db.collection('sql_safe', schema);
        expect(() =>
            users.query().select("name') FROM users WHERE 1=1 --" as any)
        ).toThrow();
    });

    test('atomic update rejects invalid $set values for schema', async () => {
        const schema = z.object({
            score: z.number(),
        });
        const counters = db.collection('atomic_validate', schema);
        const doc = await counters.insert({ score: 1 });
        await expect(
            counters.atomic.update(doc.id, { $set: { score: 'not-a-number' } })
        ).rejects.toThrow();
    });

    test('atomic $set on constrained TEXT field succeeds', async () => {
        const schema = z.object({
            title: z.string(),
            status: z.string(),
        });
        const posts = db.collection('atomic_constrained', schema, {
            index: ['status'],
        });
        const post = await posts.insert({ title: 'Hello', status: 'draft' });
        const updated = await posts.atomic.update(post.id, {
            $set: { status: 'published' },
        });
        expect(updated.status).toBe('published');
    });
});
