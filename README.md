# skibbaDB

skibbaDB is a small TypeScript document database built on top of SQLite.

You write normal JavaScript objects. skibbaDB stores them in SQLite, validates them with Zod, gives every document an `id`, and lets you query them without writing SQL for common work.

```ts
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

const ada = await users.insert({
    name: 'Ada',
    email: 'ada@example.com',
    age: 36,
});

const found = await users.get(ada.id);
const adults = await users.where('age').gte(18).orderBy('name').all();

await users.update(ada.id, { age: 37 });
await db.close();
```

## Why use it?

- **Easy document storage:** save objects like `{ name, email, age }`.
- **SQLite underneath:** your data lives in a real SQLite database.
- **Zod validation:** bad data is rejected before it is saved.
- **TypeScript-friendly:** schemas become useful TypeScript types.
- **Simple queries:** use `where`, `orderBy`, `limit`, `first`, `all`, and `count`.
- **Async by default:** normal methods return promises. Sync methods are grouped under `.sync`.
- **Indexes and constraints:** add unique fields, indexes, foreign keys, and advanced SQLite constraints.
- **Runs in Bun and Node.js:** the driver is detected automatically.

## Install

```bash
bun add skibbadb zod
```

or:

```bash
npm install skibbadb zod
```

Important: import Zod from `zod/v3`.

```ts
import { z } from 'zod/v3';
```

The package you install is still `zod`. The `/v3` import is a compatibility path that skibbaDB expects.

## The basic idea

A database has collections. A collection is like a table for one kind of object.

```ts
const db = skibba('app.db');

const posts = db.collection('posts', z.object({
    title: z.string(),
    body: z.string(),
    published: z.boolean().default(false),
}));
```

Every document gets a public `id`.

```ts
const post = await posts.insert({
    title: 'Hello',
    body: 'My first post',
});

console.log(post.id);
```

Internally, SQLite stores that value as `_id`. In normal app code, use `id`.

## Create a database

Use an in-memory database for tests and examples:

```ts
const db = skibba();
const db = skibba(':memory:');
```

Use a file for real local data:

```ts
const db = skibba('app.db');
const db = skibba({ path: 'app.db', preset: 'local' });
```

Close the database when your app is done with it:

```ts
await db.close();
```

`createDB()` is still available as an older compatibility name, but `skibba()` is the recommended entry point.

## Create a collection

```ts
const userSchema = z.object({
    name: z.string(),
    email: z.string().email(),
    age: z.number().int().optional(),
});

const users = db.collection('users', userSchema);
```

The schema controls what can be saved. This insert works:

```ts
await users.insert({
    name: 'Grace',
    email: 'grace@example.com',
});
```

This insert fails because the email is not valid:

```ts
await users.insert({
    name: 'Grace',
    email: 'not an email',
});
```

## Add indexes and rules

Use friendly collection options for common SQLite rules:

```ts
const users = db.collection('users', userSchema, {
    unique: ['email'],
    index: ['age'],
});
```

Common options:

| Option | What it does |
|--------|--------------|
| `unique: ['email']` | No two documents can have the same email. |
| `index: ['age']` | Makes age queries faster. |
| `index: ['profile.city']` | Indexes a nested field. |
| `references: { authorId: 'users.id' }` | Adds a foreign key. |
| `id: 'customId'` | Uses a different public id field name. |

Example with a relationship:

```ts
const posts = db.collection('posts', z.object({
    title: z.string(),
    authorId: z.string(),
}), {
    references: {
        authorId: 'users.id',
    },
});
```

For lower-level SQLite control, use `advanced.constrainedFields`:

```ts
const products = db.collection('products', z.object({
    sku: z.string(),
    price: z.number(),
}), {
    advanced: {
        constrainedFields: {
            sku: { unique: true, nullable: false },
            price: {
                type: 'REAL',
                checkConstraint: 'price >= 0',
            },
        },
    },
});
```

## CRUD

CRUD means create, read, update, and delete.

```ts
const user = await users.insert({
    name: 'Ada',
    email: 'ada@example.com',
});

const sameUser = await users.get(user.id);
const allUsers = await users.all();
const firstUser = await users.first();
const totalUsers = await users.count();

const updated = await users.update(user.id, {
    name: 'Ada Lovelace',
});

await users.remove(user.id);
```

`get(id)` returns `null` when no document exists.

`update(id, patch)` changes only the fields you pass.

`upsert(id, doc)` means "update this document if it exists, otherwise insert it."

```ts
await users.upsert('user-1', {
    name: 'Linus',
    email: 'linus@example.com',
});
```

## Queries

Start with `where(field)`, choose a comparison, then run the query with `all()`, `first()`, or `count()`.

```ts
const adults = await users.where('age').gte(18).all();
const ada = await users.where('email').eq('ada@example.com').first();
const adultCount = await users.where('age').gte(18).count();
```

Sorting and paging:

```ts
const page1 = await users
    .where('age').gte(18)
    .orderBy('name', 'asc')
    .limit(10)
    .all();

const page2 = await users
    .orderBy('name')
    .page(2, 10)
    .all();
```

Common comparisons:

```ts
await users.where('age').eq(36).all();
await users.where('age').neq(36).all();
await users.where('age').gt(18).all();
await users.where('age').gte(18).all();
await users.where('age').lt(65).all();
await users.where('age').lte(65).all();
await users.where('age').between(18, 65).all();
await users.where('name').in(['Ada', 'Grace']).all();
await users.where('name').nin(['Deleted']).all();
```

String helpers:

```ts
await users.where('email').contains('@example.com').all();
await users.where('name').startsWith('A').all();
await users.where('name').endsWith('a').all();
await users.where('name').like('A%').all();
await users.where('name').ilike('a%').all();
```

Field existence:

```ts
await users.where('age').exists().all();
await users.where('age').notExists().all();
```

Nested fields use dot paths:

```ts
const people = db.collection('people', z.object({
    name: z.string(),
    profile: z.object({
        city: z.string(),
    }),
}));

await people.where('profile.city').eq('Chicago').all();
```

Arrays:

```ts
const articles = db.collection('articles', z.object({
    title: z.string(),
    tags: z.array(z.string()),
}));

await articles.where('tags').arrayContains('typescript').all();
await articles.where('tags').arrayLength('gte', 2).all();
```

OR queries:

```ts
const results = await users
    .where('name').eq('Ada')
    .or((q) => q.where('email').eq('grace@example.com'))
    .all();
```

You can also start a query with `query()`:

```ts
const results = await users
    .query()
    .where('age').gte(18)
    .orderBy('name')
    .all();
```

## Select, aggregate, and join

Most apps only need the query examples above. These helpers are available when you need more SQL-like queries.

Select only some fields:

```ts
const names = await users
    .query()
    .select('name', 'email')
    .all();
```

Aggregate:

```ts
const rows = await users
    .query()
    .avg('age', 'averageAge')
    .all();
```

Group and filter groups:

```ts
const rows = await users
    .query()
    .select('role')
    .count('*', 'total')
    .groupBy('role')
    .having('total').gt(1)
    .all();
```

Join collections:

```ts
const rows = await posts
    .query()
    .join('users', 'authorId', '_id')
    .all();
```

Join conditions use stored field names. When joining to a document id, use `_id` in the join condition.

## Bulk operations

Use `bulk` when you want to write many documents at once.

```ts
const inserted = await users.bulk.insert([
    { name: 'Ada', email: 'ada@example.com' },
    { name: 'Grace', email: 'grace@example.com' },
]);

await users.bulk.update([
    { _id: inserted[0].id, doc: { name: 'Ada Lovelace' } },
]);

await users.bulk.upsert([
    {
        _id: 'user-3',
        doc: { name: 'Linus', email: 'linus@example.com' },
    },
]);

await users.bulk.delete([inserted[1].id]);
```

Note: the current bulk update and bulk upsert input objects use `_id` as the property name. Pass the same value you normally read from `doc.id`.

## Atomic updates

Atomic updates change a document in one database operation.

```ts
const posts = db.collection('posts', z.object({
    title: z.string(),
    views: z.number().default(0),
    tags: z.array(z.string()).default([]),
    status: z.string().default('draft'),
}));

const post = await posts.insert({ title: 'Hello' });

await posts.atomic.update(post.id, {
    $inc: { views: 1 },
});

await posts.atomic.update(post.id, {
    $set: { status: 'published' },
    $push: { tags: 'typescript' },
});
```

Supported operators:

| Operator | What it does |
|----------|--------------|
| `$inc` | Adds to a number. |
| `$set` | Sets a field to a new value. |
| `$push` | Adds one value to an array. |

## Transactions

A transaction groups work together. If one step fails, the whole group rolls back.

```ts
await db.transaction(async () => {
    const user = await users.insert({
        name: 'Ada',
        email: 'ada@example.com',
    });

    await posts.insert({
        title: 'Hello',
        authorId: user.id,
    });
});
```

## Sync API

The main API is async. Always use `await` with async methods.

Synchronous methods are available under `.sync`:

```ts
const user = users.sync.insert({
    name: 'Ada',
    email: 'ada@example.com',
});

const found = users.sync.get(user.id);
const all = users.sync.all();
const total = users.sync.count();

users.sync.update(user.id, { name: 'Ada Lovelace' });
users.sync.remove(user.id);

db.sync.exec('PRAGMA journal_mode = WAL');
const rows = db.sync.query('SELECT 1 AS ok');
db.sync.close();
```

Do not use sync methods with plugins unless you create the database with `allowSyncWithPlugins: true`. Shared connections also require async methods.

## Plugins

Plugins can run code around inserts, updates, deletes, queries, transactions, and database lifecycle events.

```ts
import {
    skibba,
    TimestampPlugin,
    AuditLogPlugin,
    CachePlugin,
    MetricsPlugin,
} from 'skibbadb';

const db = skibba('app.db');

db.use(new TimestampPlugin());
db.use(new AuditLogPlugin());
db.use(new CachePlugin({ ttl: 60_000 }));
db.use(new MetricsPlugin());
```

Built-in plugins exported by skibbaDB:

| Plugin | Purpose |
|--------|---------|
| `TimestampPlugin` | Adds or updates timestamp fields. |
| `AuditLogPlugin` | Logs database operations. |
| `CachePlugin` | Provides simple document/query cache helpers. |
| `MetricsPlugin` | Tracks operation counts and timings. |
| `ValidationPlugin` | Adds custom validation rules. |

## Vector search

Vector search is available through `collection.vector.search()`.

You need the optional `sqlite-vec` package and a vector field configured with `type: 'VECTOR'`.

```bash
npm install sqlite-vec
```

```ts
const docs = db.collection('docs', z.object({
    title: z.string(),
    embedding: z.array(z.number()),
}), {
    advanced: {
        constrainedFields: {
            embedding: {
                type: 'VECTOR',
                vectorDimensions: 3,
            },
        },
    },
});

await docs.insert({
    title: 'Intro',
    embedding: [0.1, 0.2, 0.3],
});

const matches = await docs.vector.search({
    field: 'embedding',
    vector: [0.1, 0.2, 0.25],
    limit: 5,
    distance: 'cosine',
});

console.log(matches[0].document);
console.log(matches[0].distance);
```

If the vector extension is not available, skibbaDB warns and vector features are disabled for that field.

## Index maintenance and diagnostics

Rebuild or check indexes:

```ts
const rebuild = await users.indexes.rebuild();
const check = await users.indexes.check();
```

Check database health:

```ts
const health = await db.health();

console.log(health.ok);
console.log(health.collections);
console.log(health.warnings);
```

Explain a query:

```ts
const plan = await users
    .where('email').eq('ada@example.com')
    .explain();

console.log(plan.sql);
console.log(plan.params);
console.log(plan.usesIndex);
```

## Drivers and runtimes

skibbaDB chooses a driver automatically.

In Bun, it uses Bun's built-in SQLite support.

In Node.js, it uses the Node driver. The package includes `better-sqlite3`; LibSQL/Turso support is available through the optional `@libsql/client` package.

Install optional LibSQL support when you need it:

```bash
npm install @libsql/client
```

Examples:

```ts
const local = skibba({ driver: 'node', path: './data.db' });

const libsqlFile = skibba({
    driver: 'node',
    path: 'file:./data.db',
    libsql: true,
});

const turso = skibba({
    driver: 'node',
    path: 'libsql://your-db.turso.io',
    authToken: process.env.TURSO_AUTH_TOKEN,
});
```

Useful presets:

```ts
skibba({ preset: 'memory' });
skibba({ preset: 'local', path: 'app.db' });
skibba({ preset: 'test' });
skibba({ preset: 'server', path: 'server.db' });
skibba({ preset: 'turso', path: 'libsql://your-db.turso.io', authToken: '...' });
```

## Errors

skibbaDB exports error classes so you can catch specific problems.

```ts
import {
    ValidationError,
    UniqueConstraintError,
    NotFoundError,
} from 'skibbadb';

try {
    await users.insert({ name: 'Ada', email: 'ada@example.com' });
    await users.insert({ name: 'Other Ada', email: 'ada@example.com' });
} catch (error) {
    if (error instanceof UniqueConstraintError) {
        console.log('That email is already used.');
    }

    if (error instanceof ValidationError) {
        console.log('The document does not match the schema.');
    }

    if (error instanceof NotFoundError) {
        console.log('The document was not found.');
    }
}
```

Exported error classes:

- `ValidationError`
- `UniqueConstraintError`
- `CheckConstraintError`
- `NotFoundError`
- `DatabaseError`
- `PluginError`
- `PluginTimeoutError`
- `VersionMismatchError`
- `CollectionExistsError`
- `CollectionNotFoundError`

## Public API

The recommended collection methods are:

```ts
await collection.insert(doc);
await collection.get(id);
await collection.update(id, patch);
await collection.upsert(id, doc);
await collection.remove(id);
await collection.all();
await collection.count();
await collection.first();
collection.where(field);
collection.query();
```

Grouped APIs:

```ts
collection.bulk.insert(docs);
collection.bulk.update(updates);
collection.bulk.upsert(items);
collection.bulk.delete(ids);

collection.sync.insert(doc);
collection.sync.get(id);
collection.sync.update(id, patch);
collection.sync.upsert(id, doc);
collection.sync.remove(id);
collection.sync.all();
collection.sync.count();
collection.sync.first();

collection.atomic.update(id, operators);
collection.indexes.rebuild();
collection.indexes.check();
collection.vector.search(options);

db.sync.exec(sql);
db.sync.query(sql);
db.sync.close();
```

## Compatibility aliases

Older method names still work. New code should use the names on the right.

| Older name | Preferred name |
|------------|----------------|
| `createDB()` | `skibba()` |
| `findById(id)` | `get(id)` |
| `put(id, patch)` | `update(id, patch)` |
| `delete(id)` | `remove(id)` |
| `toArray()` | `all()` |
| `find()` | `all()` |
| `insertBulk(docs)` | `bulk.insert(docs)` |
| `putBulk(updates)` | `bulk.update(updates)` |
| `upsertBulk(items)` | `bulk.upsert(items)` |
| `deleteBulk(ids)` | `bulk.delete(ids)` |
| `atomicUpdate(id, ops)` | `atomic.update(id, ops)` |
| `rebuildIndexes()` | `indexes.rebuild()` |
| `vectorSearch(opts)` | `vector.search(opts)` |
| `insertSync(doc)` | `sync.insert(doc)` |
| `findByIdSync(id)` | `sync.get(id)` |
| `putSync(id, patch)` | `sync.update(id, patch)` |
| `deleteSync(id)` | `sync.remove(id)` |
| `toArraySync()` | `sync.all()` |

These aliases are kept for compatibility. Do not remove them from existing apps until you have updated your code.

## Common mistakes

### Forgetting `await`

Most methods are async.

```ts
const user = await users.get(id);
```

### Importing the wrong Zod path

Use this:

```ts
import { z } from 'zod/v3';
```

### Using `_id` in normal app code

Use `id`:

```ts
const user = await users.insert({ name: 'Ada', email: 'ada@example.com' });
await users.get(user.id);
```

Only some older and bulk input shapes still use `_id` as a property name.

### Registering the same collection twice

This creates a collection:

```ts
const users = db.collection('users', userSchema);
```

This gets an already registered collection:

```ts
const sameUsers = db.collection('users');
```

Calling `db.collection('users', userSchema)` twice throws `CollectionExistsError`.

## Development

```bash
bun install
bun test
npm run build
```

## License

MIT
