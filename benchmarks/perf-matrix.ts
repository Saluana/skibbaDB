/**
 * Performance matrix: skibbaDB vs raw SQLite.
 *
 * - Bun: `bun run benchmark:matrix` (baseline uses bun:sqlite)
 * - Node: `npm run benchmark:matrix:node` (baseline uses better-sqlite3)
 */
import { z } from 'zod/v3';
import { bench, group, run } from 'mitata';
import { skibba } from '../src/index.js';

const docSchema = z.object({
    _id: z.string(),
    name: z.string(),
    score: z.number(),
});

const COUNT_INSERT = 10_000;
const COUNT_BULK = 10_000;
const COUNT_READ = 100_000;

const isBun = typeof Bun !== 'undefined';
const rawSqliteLabel = isBun ? 'bun:sqlite' : 'better-sqlite3';

type RawDoc = { _id: string; name: string; score: number };

interface RawSqliteDb {
    exec(sql: string): void;
    prepare(sql: string): {
        run(...params: unknown[]): void;
        get(...params: unknown[]): { doc: string } | null;
    };
    transaction<T>(fn: (rows: T) => void): (rows: T) => void;
    close(): void;
}

function openRawSqlite(): RawSqliteDb {
    if (isBun) {
        const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
        const db = new Database(':memory:');
        return {
            exec: (sql) => db.exec(sql),
            prepare: (sql) => db.prepare(sql),
            transaction: (fn) => db.transaction(fn),
            close: () => db.close(),
        };
    }

    const Database = require('better-sqlite3') as typeof import('better-sqlite3');
    const db = new Database(':memory:');
    return {
        exec: (sql) => db.exec(sql),
        prepare: (sql) => db.prepare(sql),
        transaction: (fn) => db.transaction(fn),
        close: () => db.close(),
    };
}

function makeDocs(count: number, offset = 0): RawDoc[] {
    return Array.from({ length: count }, (_, i) => ({
        _id: `id-${offset + i}`,
        name: `user-${offset + i}`,
        score: i % 1000,
    }));
}

group('inserts (10k)', () => {
    bench('skibba insert (single)', async () => {
        const db = skibba({ memory: true });
        const col = db.collection('users', docSchema);
        await col.waitForInitialization();
        for (let i = 0; i < COUNT_INSERT; i++) {
            await col.insert({
                name: `user-${i}`,
                score: i,
            } as any);
        }
        await db.close();
    });

    bench(`${rawSqliteLabel} insert (single)`, () => {
        const sqlite = openRawSqlite();
        sqlite.exec(
            `CREATE TABLE users (_id TEXT PRIMARY KEY, doc TEXT NOT NULL)`
        );
        const stmt = sqlite.prepare(
            `INSERT INTO users (_id, doc) VALUES (?, ?)`
        );
        for (let i = 0; i < COUNT_INSERT; i++) {
            const id = `id-${i}`;
            stmt.run(id, JSON.stringify({ _id: id, name: `user-${i}`, score: i }));
        }
        sqlite.close();
    });

    bench('skibba bulk.insert (10k)', async () => {
        const db = skibba({ memory: true });
        const col = db.collection('users', docSchema);
        await col.waitForInitialization();
        const docs = makeDocs(COUNT_BULK).map(({ _id, ...rest }) => rest);
        await col.bulk.insert(docs as any);
        await db.close();
    });

    bench(`${rawSqliteLabel} transaction insert (10k)`, () => {
        const sqlite = openRawSqlite();
        sqlite.exec(
            `CREATE TABLE users (_id TEXT PRIMARY KEY, doc TEXT NOT NULL)`
        );
        const stmt = sqlite.prepare(
            `INSERT INTO users (_id, doc) VALUES (?, ?)`
        );
        const insertMany = sqlite.transaction((rows: RawDoc[]) => {
            for (const row of rows) {
                stmt.run(row._id, JSON.stringify(row));
            }
        });
        insertMany(makeDocs(COUNT_BULK));
        sqlite.close();
    });
});

group('reads (100k point lookups)', () => {
    bench('skibba get by id', async () => {
        const db = skibba({ memory: true });
        const col = db.collection('users', docSchema);
        await col.waitForInitialization();
        const seed = makeDocs(1000).map(({ _id, ...rest }) => rest);
        await col.bulk.insert(seed as any);
        const all = await col.all();
        const lookupIds = Array.from(
            { length: COUNT_READ },
            (_, i) => (all[i % all.length] as any)._id as string
        );
        for (const id of lookupIds) {
            await col.get(id);
        }
        await db.close();
    });

    bench(`${rawSqliteLabel} get by id`, () => {
        const sqlite = openRawSqlite();
        sqlite.exec(
            `CREATE TABLE users (_id TEXT PRIMARY KEY, doc TEXT NOT NULL)`
        );
        const insert = sqlite.prepare(
            `INSERT INTO users (_id, doc) VALUES (?, ?)`
        );
        const seed = makeDocs(1000);
        const insertMany = sqlite.transaction((rows: RawDoc[]) => {
            for (const row of rows) {
                insert.run(row._id, JSON.stringify(row));
            }
        });
        insertMany(seed);
        const get = sqlite.prepare(`SELECT doc FROM users WHERE _id = ?`);
        const lookupIds = Array.from(
            { length: COUNT_READ },
            (_, i) => seed[i % seed.length]._id
        );
        for (const id of lookupIds) {
            get.get(id);
        }
        sqlite.close();
    });
});

await run();
