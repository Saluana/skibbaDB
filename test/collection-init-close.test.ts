import { test, expect } from 'vitest';
import { z } from 'zod/v3';
import { skibba } from '../src/index.js';

const schema = z.object({
    _id: z.string(),
    name: z.string(),
});

test('close does not log migration failures when driver is already closed', async () => {
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
        warnings.push(args);
        originalWarn(...args);
    };

    try {
        const db = skibba({ memory: true });
        db.collection('users', schema);
        await db.close();

        const migrationWarnings = warnings.filter((args) =>
            String(args[0] ?? '').includes('Migration check failed')
        );
        expect(migrationWarnings).toHaveLength(0);
    } finally {
        console.warn = originalWarn;
    }
});

test('first operation awaits migrations before running', async () => {
    const db = skibba({ memory: true });
    const col = db.collection('users', schema);

    await col.insert({ name: 'alice' } as any);
    const found = await col.get((await col.all())[0]._id);
    expect(found?.name).toBe('alice');

    await db.close();
});
