# skibbaDB

A developer-friendly, embeddable NoSQL database layer on top of SQLite that boots up in seconds with a single command, enforces schemas and type safety via Zod, and exposes intuitive, fully typed CRUD and query APIs with **dual-storage architecture** for optimal performance.

## Features

-   🚀 **Zero Configuration**: Single function call to get started
-   🔒 **Type Safety**: Full TypeScript support with Zod schema validation
-   ⚡ **Dual Storage**: Automatic optimization using both SQL columns and JSON documents
-   🔍 **Intuitive Queries**: Chainable query builder inspired by Dexie and Supabase
-   💾 **ACID Transactions**: Full transaction support
-   🔗 **Real Relationships**: True foreign keys with cascade operations
-   🎯 **Smart Constraints**: Database-level constraint enforcement
-   🏎️ **Performance Optimized**: Column indexes for critical fields, JSON flexibility for others
-   🌐 **Cross-Platform**: Works with both Bun and Node.js
-   ⚡ **Async by Default**: Non-blocking operations by default, sync versions available
-   🛠️ **CLI Tool**: Command-line interface for database management and administration

## CLI Tool

A powerful command-line interface is available for managing skibbaDB instances:

```bash
cd cli
npm install && npm run build

# Quick start
./bin/dev.js db:create mydb --path ./mydb.db
./bin/dev.js collection:create users --schema '{"id": "uuid", "name": "string"}'
./bin/dev.js data:insert users '{"name": "John", "email": "john@example.com"}'
./bin/dev.js data:query users
```

See [CLI Documentation](./cli/README.md) for complete usage guide.

## What Makes skibbaDB Special

skibbaDB uses a **dual-storage architecture** that gives you the best of both worlds:

- **Critical fields** (with constraints/relationships) → Stored in dedicated **SQL columns** with indexes
- **Flexible data** → Stored in **JSON documents** for NoSQL-style flexibility  
- **Complete documents** always available in JSON for full NoSQL experience
- **Automatic optimization** - the database chooses the fastest access method per query

This means you get SQL performance and constraints where you need them, with NoSQL flexibility everywhere else.

## Quick Start

```typescript
import { z } from 'zod';
import { createDB } from 'skibbaDB';

// Define your schema
const userSchema = z.object({
    id: z.string().uuid(),
    name: z.string(),
    email: z.string().email(),
    departmentId: z.string().uuid(),
    age: z.number().int().optional(),
    profile: z.object({
        bio: z.string().optional(),
        skills: z.array(z.string()).optional(),
        settings: z.record(z.any()).optional()
    }),
    createdAt: z.date().default(() => new Date()),
});

// Create database with dual-storage optimization
const db = createDB({ memory: true }); // or { path: 'mydb.db' }
const users = db.collection('users', userSchema, {
    // Constrained fields get dedicated columns + indexes
    constrainedFields: {
        email: { unique: true, nullable: false },
        departmentId: { 
            foreignKey: 'departments._id',
            onDelete: 'CASCADE' 
        },
        age: { type: 'INTEGER' }
    }
    // Other fields (name, profile, createdAt) remain in flexible JSON
});

// Same NoSQL API, optimized performance
const user = users.insert({
    name: 'Alice Johnson',
    email: 'alice@example.com',
    departmentId: 'dept-123',
    age: 28,
    profile: {
        bio: 'Software Engineer',
        skills: ['TypeScript', 'React'],
        settings: { theme: 'dark' }
    }
});

// Queries automatically use best access method
const alice = users.where('email').eq('alice@example.com').first();     // Uses column index (fast!)
const developers = users.where('profile.skills').contains('React');     // Uses JSON extraction (flexible!)

// Mixed queries optimize each field independently
const results = users
    .where('departmentId').eq('dept-123')           // Column index
    .where('age').gte(25)                           // Column index  
    .where('profile.bio').like('%Engineer%')        // JSON extraction
    .orderBy('email')                               // Column ordering
    .toArray();

// 🚀 Async by Default (non-blocking operations)
const results = await users
    .where('departmentId').eq('dept-123')
    .where('age').gte(25)
    .toArray();
    
const newUser = await users.insert({
    name: 'New Employee',
    email: 'new@example.com',
    // ... other fields
});

// Sync versions available with 'Sync' suffix
const syncResults = users
    .where('departmentId').eq('dept-123')
    .toArraySync();
```

## Installation

```bash
bun add skibbaDB zod
# or
npm install skibbaDB zod
```

### Database Drivers

skibbaDB supports multiple database drivers depending on your runtime and requirements:

#### Bun Driver (Default for Bun)
```bash
# No additional installation needed - uses built-in bun:sqlite
```

#### Node.js Drivers

**LibSQL (Recommended - Universal)**
```bash
npm install @libsql/client
# Works with: SQLite files, LibSQL files, Turso remote, embedded replicas
```

**Better SQLite3 (SQLite Only)**
```bash
npm install better-sqlite3
# Works with: SQLite files only (high performance)
```

**Legacy SQLite3**
```bash
npm install sqlite3  # Limited support (callback-based)
```

#### Driver Configuration

```typescript
// Auto-detect driver (Bun in Bun runtime, Node.js in Node runtime)
const db = createDB({ path: './data.db' });

// Explicit driver selection
const db = createDB({ 
    driver: 'node',
    path: './data.db' 
});

// LibSQL local file
const db = createDB({
    driver: 'node',
    path: 'file:./data.db',
    libsql: true
});

// LibSQL remote (Turso)
const db = createDB({
    driver: 'node',
    path: 'libsql://your-db.turso.io',
    authToken: 'your-auth-token'
});

// LibSQL with sync (embedded replica)
const db = createDB({
    driver: 'node',
    path: 'file:./replica.db',
    syncUrl: 'libsql://your-db.turso.io',
    authToken: 'your-auth-token'
});
```

## Dual-Storage Architecture

### Constrained Fields

Define which fields need SQL-level constraints and performance optimization:

```typescript
const posts = db.collection('posts', postSchema, {
    constrainedFields: {
        // Unique constraints with dedicated columns
        slug: { unique: true, nullable: false },
        
        // Foreign key relationships with cascading
        authorId: { 
            foreignKey: 'users._id',
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE'
        },
        
        // Type-specific columns with check constraints
        publishedAt: { 
            type: 'TEXT',  // Store as ISO string
            nullable: true 
        },
        
        viewCount: { 
            type: 'INTEGER',
            checkConstraint: 'viewCount >= 0'
        },
        
        // Nested field constraints
        'metadata.priority': { 
            type: 'INTEGER',
            checkConstraint: 'metadata_priority BETWEEN 1 AND 5'
        }
    }
});
```

### Generated SQL Structure

skibbaDB automatically creates optimized table structures:

```sql
CREATE TABLE posts (
  _id TEXT PRIMARY KEY,
  doc TEXT NOT NULL,                    -- Complete JSON document (NoSQL access)
  slug TEXT NOT NULL UNIQUE,            -- Constrained field column (SQL access)
  authorId TEXT NOT NULL REFERENCES users(_id) ON DELETE CASCADE,
  publishedAt TEXT,                     -- Nullable constrained field
  viewCount INTEGER CHECK (viewCount >= 0),
  metadata_priority INTEGER CHECK (metadata_priority BETWEEN 1 AND 5)
);

-- Automatic indexes for performance
CREATE UNIQUE INDEX posts_slug_unique ON posts (slug);
CREATE INDEX posts_authorId_fk ON posts (authorId);
```

### Constraint Types

| Constraint Type | SQL Feature | Use Case |
|----------------|-------------|----------|
| `unique: true` | `UNIQUE` constraint | Prevent duplicates (emails, usernames) |
| `foreignKey: 'table._id'` | `REFERENCES` with cascading | Relationships between collections |
| `checkConstraint: 'expr'` | `CHECK` constraint | Value validation (age > 0, enum values) |
| `nullable: false` | `NOT NULL` | Required fields |
| `type: 'INTEGER'` | Column type optimization | Performance for numbers, dates |

### Field Types

| Zod Type | SQLite Type | Storage |
|----------|-------------|---------|
| `z.string()` | `TEXT` | Direct string storage |
| `z.number()` | `REAL` | Numeric storage |
| `z.number().int()` | `INTEGER` | Integer storage |
| `z.boolean()` | `INTEGER` | 0/1 values |
| `z.date()` | `TEXT` | ISO string format |
| `z.array()` | `TEXT` | JSON serialized |
| `z.object()` | `TEXT` | JSON serialized |

## API Reference

### Database

```ts
const db = createDB({ 
    path?: string; 
    memory?: boolean; 
    driver?: 'bun' | 'node' 
});

const users = db.collection('users', userSchema, {
    constrainedFields?: { [fieldPath: string]: ConstrainedFieldDefinition }
});

await db.transaction(async () => { /* transactional operations */ });
await db.close();

// Sync versions (with Sync suffix)
db.execSync('CREATE INDEX ...');
const rows = db.querySync('SELECT * FROM ...');
db.closeSync();
```

### Collections

#### Collection Methods (CRUD & Bulk)

```ts
// Create
const newDoc = users.insert({
    /* fields except id */
});
const docs = users.insertBulk([
    {
        /* ... */
    },
]);

// Read
const found = users.findById(newDoc.id); // returns T | null
const all = users.toArray();

// Update (maintains dual storage sync)
const updated = users.put(newDoc.id, {
    /* partial fields */
});
const updatedBulk = users.putBulk([
    {
        id: newDoc.id,
        doc: {
            /* ... */
        },
    },
]);

// Delete
const ok = users.delete(newDoc.id); // returns true
const count = users.deleteBulk([newDoc.id]); // returns number deleted

// Upsert
const up = users.upsert(newId, {
    /* fields */
});
const upBulk = users.upsertBulk([
    {
        id: newId,
        doc: {
            /* ... */
        },
    },
]);

// Default methods (async)
const newDoc = await users.insert({ /* fields except id */ });
const docs = await users.insertBulk([{ /* ... */ }]);
const found = await users.findById(id);
const updated = await users.put(id, { /* partial fields */ });
const deleted = await users.delete(id);
const upserted = await users.upsert(id, { /* fields */ });
const all = await users.toArray();
const count = await users.count();
const first = await users.first();

// Sync versions (with Sync suffix)
const syncDoc = users.insertSync({ /* fields except id */ });
const syncFound = users.findByIdSync(id);
const syncAll = users.toArraySync();
const syncCount = users.countSync();
const syncFirst = users.firstSync();
```

#### Query Builder Methods

```ts
// Comparison operators
enum Op {
    eq,
    neq,
    gt,
    gte,
    lt,
    lte,
    between,
}
users.where('field').eq(value);
users.where('field').between(min, max);

// Array operators
users.where('field').in([v1, v2]);
users.where('field').nin([v1, v2]);

// String operators
users.where('field').like('pattern%');
users.where('field').ilike('%pattern%');
users.where('field').startsWith(prefix);
users.where('field').endsWith(suffix);
users.where('field').contains(substr);

// Existence
users.where('field').exists();
users.where('field').notExists();

// Logical
users.where('a').eq(1).and().where('b').eq(2);
users
    .where('x')
    .eq(1)
    .or((builder) => builder.where('y').eq(2));
users.orWhere([(b) => b.where('a').eq(1), (b) => b.where('b').gt(5)]);

// Sorting & Pagination
users.orderBy('field', 'asc');
users.orderByOnly('field', 'desc');
users.orderByMultiple([{ field: 'a', direction: 'asc' }]);
users.limit(10).offset(5).page(2, 10);

// Grouping & Distinct
users.groupBy('field1', 'field2');
users.distinct();

// State management
users.clearFilters();
users.clearOrder();
users.clearLimit();
users.reset();
users.clone();

// Inspection
users.hasFilters();
users.hasOrdering();
users.hasPagination();
users.getFilterCount();

// Default execution (async)
await users.toArray();
await users.first();
await users.count();

// Sync execution (with Sync suffix)
users.toArraySync();
users.firstSync();
users.countSync();
```

#### Direct Collection Shortcuts

```ts
users.orderBy('field');
users.limit(5);
users.offset(5);
users.page(1, 10);
users.distinct();
users.orderByMultiple([{ field: 'f1' }, { field: 'f2', direction: 'desc' }]);
users.or((b) => b.where('a').eq(1));
```

### Constrained Field Definition

```typescript
interface ConstrainedFieldDefinition {
    type?: 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB';
    unique?: boolean;
    foreignKey?: string; // 'table._id'
    onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT';
    onUpdate?: 'CASCADE' | 'SET NULL' | 'RESTRICT';
    nullable?: boolean;
    checkConstraint?: string;
}
```

## Async by Default

skibbaDB uses async operations by default, enabling non-blocking database access and better concurrency:

### Key Benefits

- **Modern by default**: All operations are non-blocking by default
- **Better concurrency**: Handle multiple database operations simultaneously  
- **Plugin integration**: Plugin hooks are properly awaited
- **Backward compatibility**: Sync versions available with 'Sync' suffix

### Basic Usage

```typescript
import { createDB } from 'skibbaDB';

const db = createDB({ memory: true });
const users = db.collection('users', userSchema);

// Default CRUD operations (async)
const user = await users.insert({
    name: 'Alice',
    email: 'alice@example.com'
});

const found = await users.findById(user.id);
const updated = await users.put(user.id, { name: 'Alice Smith' });
const deleted = await users.delete(user.id);

// Default queries (async)
const all = await users.toArray();
const count = await users.count();
const filtered = await users.where('name').like('A%').toArray();
const first = await users.orderBy('name').first();

// Default database operations (async)
await db.exec('CREATE INDEX idx_name ON users(name)');
const result = await db.query('SELECT COUNT(*) FROM users');
await db.close();
```

### Async Transactions

```typescript
await db.transaction(async () => {
    const user1 = await users.insert({ name: 'User 1' });
    const user2 = await users.insert({ name: 'User 2' });
    
    await users.put(user1.id, { status: 'active' });
    
    // All operations are atomic
});
```

### Performance Comparison

```typescript
// Sync operations (with Sync suffix)
for (const item of items) {
    users.insertSync(item);  // Blocking operations
}

// Default operations (async, non-blocking)
for (const item of items) {
    await users.insert(item);  // Allows other operations
}

// Bulk operations (optimal)
await users.insertBulk(items);  // Best performance
```

### Mixing Sync and Async

```typescript
// Both sync and async operations work on the same data
const syncUser = users.insertSync({ name: 'Sync User' });
const asyncUser = await users.insert({ name: 'Async User' });

// Results are immediately visible to both modes
const syncCount = users.where('name').like('%User%').countSync();  // 2
const asyncCount = await users.count();  // 2
```

## Examples

### E-Commerce with Relationships

```typescript
// Department schema
const departmentSchema = z.object({
    id: z.string().uuid(),
    name: z.string(),
    budget: z.number().positive(),
    location: z.string(),
    manager: z.object({
        name: z.string(),
        email: z.string().email()
    })
});

// User schema with relationships
const userSchema = z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    username: z.string(),
    departmentId: z.string().uuid(),
    profile: z.object({
        name: z.string(),
        age: z.number().int().min(18),
        bio: z.string().optional(),
        skills: z.array(z.string()).optional(),
        settings: z.record(z.any()).optional()
    }),
    salary: z.number().positive(),
    metadata: z.record(z.any()).optional()
});

// Create collections with relationships
const departments = db.collection('departments', departmentSchema, {
    constrainedFields: {
        name: { unique: true, nullable: false },
        budget: { type: 'REAL', nullable: false },
        'manager.email': { unique: true }
    }
});

const users = db.collection('users', userSchema, {
    constrainedFields: {
        email: { unique: true, nullable: false },
        username: { unique: true, nullable: false },
        departmentId: { 
            foreignKey: 'departments._id',
            onDelete: 'CASCADE',  // Delete users when department is deleted
            nullable: false
        },
        'profile.age': { 
            type: 'INTEGER',
            checkConstraint: 'profile_age >= 18 AND profile_age <= 65'
        },
        salary: { 
            type: 'REAL',
            checkConstraint: 'salary > 0'
        }
    }
});

// Insert with referential integrity
const engineering = departments.insert({
    name: 'Engineering',
    budget: 1000000,
    location: 'San Francisco',
    manager: {
        name: 'Sarah Connor',
        email: 'sarah@company.com'
    }
});

const alice = users.insert({
    email: 'alice@company.com',
    username: 'alice',
    departmentId: engineering.id,  // Foreign key relationship
    profile: {
        name: 'Alice Johnson',
        age: 28,
        bio: 'Senior Software Engineer',
        skills: ['TypeScript', 'React', 'Node.js'],
        settings: { theme: 'dark', notifications: true }
    },
    salary: 120000,
    metadata: { startDate: '2022-01-15', level: 'senior' }
});

// Optimized queries using dual storage
const seniorEngineers = users
    .where('departmentId').eq(engineering.id)     // Column index (fast)
    .where('salary').gte(100000)                  // Column index (fast)
    .where('profile.age').gte(25)                 // Column index (fast)
    .where('metadata.level').eq('senior')         // JSON extraction (flexible)
    .where('profile.skills').contains('React')    // JSON extraction (flexible)
    .orderBy('salary', 'desc')                    // Column ordering (fast)
    .toArray();
```

### Complex Queries with Mixed Storage

```typescript
const users = db.collection('users', userSchema, {
    constrainedFields: {
        email: { unique: true },
        departmentId: { foreignKey: 'departments._id' },
        'profile.age': { type: 'INTEGER' },
        salary: { type: 'REAL' }
    }
});

// Query optimization examples
const examples = {
    // All constrained fields → uses column indexes
    fastQuery: users
        .where('email').like('%@company.com')
        .where('departmentId').eq('dept-123')
        .where('profile.age').between(25, 35)
        .where('salary').gte(80000)
        .orderBy('salary', 'desc')
        .toArray(),

    // Mixed constrained + flexible fields
    hybridQuery: users
        .where('departmentId').eq('dept-123')          // Column index
        .where('profile.skills').contains('React')     // JSON extraction
        .where('salary').gte(100000)                   // Column index
        .where('metadata.level').eq('senior')          // JSON extraction
        .orderBy('profile.age', 'asc')                 // Column ordering
        .toArray(),

    // Pure JSON flexibility
    flexibleQuery: users
        .where('profile.bio').ilike('%engineer%')
        .where('profile.settings.theme').eq('dark')
        .where('metadata.projects').exists()
        .toArray(),

    // Performance-optimized aggregations
    departmentStats: {
        totalUsers: users.where('departmentId').eq('dept-123').count(),           // Column index
        seniorUsers: users
            .where('departmentId').eq('dept-123')                                 // Column index
            .where('metadata.level').eq('senior').count(),                       // JSON extraction
        avgSalary: users.where('departmentId').eq('dept-123').toArray()          // Would need custom SQL for AVG
            .reduce((sum, u) => sum + u.salary, 0) / users.where('departmentId').eq('dept-123').count()
    }
};
```

### Transactions with Relationships

```typescript
// Atomic operations with referential integrity
await db.transaction(async () => {
    // Create department
    const newDept = departments.insert({
        name: 'Data Science',
        budget: 800000,
        location: 'New York',
        manager: { name: 'Dr. Smith', email: 'smith@company.com' }
    });
    
    // Create users in that department
    const teamMembers = [
        {
            email: 'data1@company.com',
            username: 'data_scientist_1',
            departmentId: newDept.id,
            profile: { name: 'John Data', age: 32 },
            salary: 140000
        },
        {
            email: 'data2@company.com', 
            username: 'data_scientist_2',
            departmentId: newDept.id,
            profile: { name: 'Jane Analytics', age: 29 },
            salary: 135000
        }
    ];
    
    for (const member of teamMembers) {
        users.insert(member);
    }
    
    // If any operation fails, entire transaction rolls back
    // maintaining referential integrity
});
```

### Error Handling

```typescript
import { ValidationError, NotFoundError, UniqueConstraintError } from 'busndb';

try {
    users.insert({
        email: 'duplicate@example.com',  // Already exists
        username: 'newuser',
        departmentId: 'invalid-dept-id', // Foreign key violation
        profile: { name: 'Test User', age: 17 }, // Check constraint violation
        salary: -1000  // Check constraint violation
    });
} catch (error) {
    if (error instanceof ValidationError) {
        console.log('Schema validation failed:', error.details);
    } else if (error instanceof UniqueConstraintError) {
        console.log('Unique constraint violation:', error.field);
    } else if (error.message.includes('foreign key')) {
        console.log('Foreign key constraint violation');
    } else if (error.message.includes('CHECK constraint')) {
        console.log('Check constraint violation');
    }
}
```

## Performance Comparison

### Dual Storage Benefits

| Query Type | Traditional NoSQL | BusNDB Dual Storage | Performance Gain |
|------------|------------------|-------------------|------------------|
| Unique field lookup | Full JSON scan | Column index | **~100x faster** |
| Range queries | JSON extraction | Column index | **~50x faster** |
| Foreign key joins | Application logic | SQL JOIN | **~20x faster** |
| Mixed field query | Full JSON scan | Column + JSON hybrid | **~10x faster** |
| Flexible nested query | JSON extraction | JSON extraction | Same (no overhead) |

### Benchmarks

skibbaDB delivers excellent performance for embedded use cases:

-   **Inserts**: ~27,000 ops/sec (single), ~46,000 ops/sec (bulk)
-   **Constrained field queries**: ~10,000 ops/sec (column indexes)
-   **JSON field queries**: ~235 ops/sec (flexible extraction)
-   **Mixed queries**: ~2,000 ops/sec (hybrid optimization)
-   **Updates**: ~226 ops/sec (dual storage sync)
-   **Deletes**: ~55,000 ops/sec
-   **Cascade operations**: ~15,000 ops/sec

_Benchmarks run on Apple M1 with in-memory database_

## Migration Guide

### Existing Collections

Existing collections continue to work without changes:

```typescript
// v1.x behavior (pure JSON) - still works
const users = db.collection('users', userSchema);

// v2.x enhancement (dual storage) - opt-in
const optimizedUsers = db.collection('users', userSchema, {
    constrainedFields: {
        email: { unique: true },
        // Add constraints incrementally
    }
});
```

### Adding Constraints to Existing Data

```typescript
// Start with flexible schema
const posts = db.collection('posts', postSchema);

// Later, add constraints for performance
const optimizedPosts = db.collection('posts', postSchema, {
    constrainedFields: {
        authorId: { foreignKey: 'users._id' },  // Add relationships
        publishedAt: { type: 'TEXT' },          // Add type optimization
        slug: { unique: true }                  // Add uniqueness
    }
});
// skibbaDB will migrate existing data to dual storage automatically
```

## Development

```bash
# Install dependencies
bun install

# Run tests
bun test

# Run example
bun run example.ts

# Run benchmark
bun run benchmark.ts
```

## License

MIT