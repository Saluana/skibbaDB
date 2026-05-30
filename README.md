# skibbaDB

A tiny, memorable TypeScript document database on SQLite — Zod schemas, chainable queries, and ACID transactions without writing SQL.

## Features

- **Zero config** — `skibba(':memory:')` and go
- **Type safe** — Zod validation on every write
- **Fluent queries** — `where`, `orderBy`, `limit`, aggregates
- **Async by default** — sync APIs live under `.sync` namespaces
- **Constraints & indexes** — unique fields, foreign keys, vector search (optional)
- **Bun & Node** — auto-detected drivers

## Install

```bash
bun add skibbadb zod
# or
npm install skibbadb zod
```

> **Note:** skibbaDB uses Zod's v3 compatibility layer internally. Always import Zod as `import { z } from 'zod/v3'` in your application code. The `zod` package is still what you install — `zod/v3` is a subpath export included in Zod v4.

## 30-second example

```typescript
import { z } from 'zod/v3';
import { skibba } from 'skibbadb';

const db = skibba(':memory:');

const users = db.collection('users', z.object({
    name: z.string(),
    email: z.string().email(),
    age: z.number().int().optional(),
}), {
    unique: ['email'],
    index: ['age'],
});

const ada = await users.insert({ name: 'Ada', email: 'ada@example.com', age: 36 });
const found = await users.get(ada.id);
const adults = await users.where('age').gte(18).orderBy('name').all();
const count = await users.where('age').gte(18).count();

await users.update(ada.id, { age: 37 });
await db.close();
```

`createDB({ memory: true })` remains available; `skibba()` is the recommended entry point.

## CRUD

```typescript
const doc = await users.insert({ name: 'Ada', email: 'a@b.com' });
const one = await users.get(doc.id);
const all = await users.all();
await users.update(doc.id, { name: 'Ada L.' });
await users.upsert(doc.id, { name: 'Updated', email: 'a@b.com' });
await users.remove(doc.id);
```

Bulk operations:

```typescript
await users.bulk.insert([
    { name: 'Grace', email: 'grace@example.com' },
    { name: 'Linus', email: 'linus@example.com' },
]);
await users.bulk.update([
    { id: doc.id, doc: { name: 'Grace Hopper' } },
]);
await users.bulk.delete([id1, id2]);
```

## Queries

```typescript
const active = await users.where('active').eq(true).all();
const adults = await users.where('age').gte(18).orderBy('name').all();
const first = await users.where('email').contains('@example').first();
const count = await users.where('active').eq(true).count();
```

Comparison operators:

```typescript
users.where('field').eq(value);
users.where('field').neq(value);
users.where('field').gt(value);
users.where('field').gte(value);
users.where('field').lt(value);
users.where('field').lte(value);
users.where('field').between(min, max);
```

String operators:

```typescript
users.where('field').like('pattern%');
users.where('field').ilike('%pattern%');
users.where('field').startsWith(prefix);
users.where('field').endsWith(suffix);
users.where('field').contains(substr);
```

Array and existence:

```typescript
users.where('field').in([v1, v2]);
users.where('field').nin([v1, v2]);
users.where('field').exists();
users.where('field').notExists();
```

Logical operators:

```typescript
users.where('a').eq(1).and().where('b').eq(2);
users.where('x').eq(1).or((b) => b.where('y').eq(2));
```

Sorting and pagination:

```typescript
users.orderBy('name', 'asc').limit(10).offset(20);
users.page(2, 10); // page 2, 10 per page
```

## Indexes and constraints

Use friendly options to declare constraints:

```typescript
const users = db.collection('users', userSchema, {
    unique: ['email'],
    index: ['departmentId', 'profile.age'],
    references: { departmentId: 'departments.id' },
});
```

For full control, use the `advanced` escape hatch:

```typescript
const posts = db.collection('posts', postSchema, {
    advanced: {
        constrainedFields: {
            slug: { unique: true, nullable: false },
            authorId: { foreignKey: 'users._id', onDelete: 'CASCADE' },
            viewCount: { type: 'INTEGER', checkConstraint: 'viewCount >= 0' },
        },
    },
});
```

## Advanced APIs

### Bulk operations

```typescript
await users.bulk.insert([...]);
await users.bulk.update([...]);
await users.bulk.upsert([...]);
await users.bulk.delete([id1, id2]);
```

### Atomic updates

```typescript
await users.atomic.update(id, { $inc: { views: 1 } });
await users.atomic.update(id, { $set: { status: 'active' } });
```

### Vector search

```typescript
await users.vector.search({
    field: 'embedding',
    vector: [0.1, 0.2, 0.3],
    limit: 10,
});
```

### Index maintenance

```typescript
await users.indexes.rebuild();
const status = await users.indexes.check();
```

### Transactions

```typescript
await db.transaction(async () => {
    const user = await users.insert({ name: 'Ada', email: 'a@b.com' });
    await posts.insert({ title: 'Hello', authorId: user.id });
    // All operations are atomic — if any fail, the entire transaction rolls back
});
```

## Sync API

Synchronous methods are available under the `.sync` namespace:

```typescript
users.sync.insert(doc);
users.sync.get(id);
users.sync.all();
users.sync.count();
users.sync.first();
users.sync.update(id, patch);
users.sync.remove(id);

db.sync.exec('PRAGMA journal_mode = WAL');
db.sync.close();
```

> **Note:** Sync methods do not support plugins or shared connections. Use the async API for those cases.

## Plugins

```typescript
import { TimestampPlugin, AuditLogPlugin, CachePlugin } from 'skibbadb';

db.use(new TimestampPlugin());
db.use(new AuditLogPlugin());
db.use(new CachePlugin({ ttl: 60_000 }));
```

## Diagnostics

```typescript
const health = await db.health();
// { ok: true, collections: ['users'], driverReady: true, warnings: [] }

const plan = await users.where('email').eq('a@b.com').explain();
// { collection: 'users', usesIndex: true, storage: 'mixed', sql: '...', params: [...] }
```

## API Reference

### Database

```typescript
const db = skibba('app.db');
const db = skibba(':memory:');
const db = skibba({ path: 'app.db', preset: 'local' });

await db.transaction(async () => { /* ... */ });
await db.health();
await db.close();
db.sync.close();
```

### Collection

```typescript
const users = db.collection('users', schema, options);

// Golden path
await users.insert(doc);
await users.get(id);
await users.update(id, patch);
await users.upsert(id, doc);
await users.remove(id);
await users.all();
await users.count();
await users.first();

// Queries
users.where(field).eq(value).all();
users.orderBy(field).limit(n).all();
```

### Query Builder

```typescript
// Execution
await query.all();      // alias for toArray()
await query.first();
await query.count();
await query.explain();

// Sync execution
query.allSync();
query.firstSync();
query.countSync();
```

### ConstrainedFieldDefinition

```typescript
interface ConstrainedFieldDefinition {
    type?: 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB';
    unique?: boolean;
    foreignKey?: string;        // 'table._id'
    onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT';
    onUpdate?: 'CASCADE' | 'SET NULL' | 'RESTRICT';
    nullable?: boolean;
    checkConstraint?: string;
}
```

## Drivers

skibbaDB auto-detects the best driver for your runtime.

**Bun** — uses built-in `bun:sqlite`, no extra install needed.

**Node.js (recommended)** — LibSQL:

```bash
npm install @libsql/client
```

**Node.js (SQLite only)** — better-sqlite3:

```bash
npm install better-sqlite3
```

Explicit configuration:

```typescript
const db = skibba({ driver: 'node', path: './data.db' });
const db = skibba({ driver: 'node', path: 'file:./data.db', libsql: true });
const db = skibba({ driver: 'node', path: 'libsql://your-db.turso.io', authToken: 'token' });
```

## Compatibility aliases

Old method names still work:

| Legacy | New |
|--------|-----|
| `createDB()` | `skibba()` |
| `findById(id)` | `get(id)` |
| `put(id, patch)` | `update(id, patch)` |
| `toArray()` | `all()` |
| `insertBulk(docs)` | `bulk.insert(docs)` |
| `putBulk(updates)` | `bulk.update(updates)` |
| `deleteBulk(ids)` | `bulk.delete(ids)` |
| `atomicUpdate(id, ops)` | `atomic.update(id, ops)` |
| `rebuildIndexes()` | `indexes.rebuild()` |
| `vectorSearch(opts)` | `vector.search(opts)` |
| `insertSync(doc)` | `sync.insert(doc)` |
| `findByIdSync(id)` | `sync.get(id)` |
| `toArraySync()` | `sync.all()` |

## Development

```bash
bun install
bun test
npm run build
```

## License

MIT
