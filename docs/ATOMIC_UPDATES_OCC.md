# Atomic Update Operators, OCC, and Repair Tools

This document describes the new features added to skibbaDB for atomic updates, optimistic concurrency control, field projections, and database repair tools.

## 1. Atomic Update Operators

Atomic update operators allow you to modify documents without reading them first, preventing race conditions and improving performance.

### Available Operators

#### `$inc` - Atomic Increment/Decrement
Atomically increments (or decrements with negative values) numeric fields.

```typescript
// Increment a counter
await users.atomicUpdate(userId, {
    $inc: { viewCount: 1, likeCount: 2 }
});

// Decrement (use negative values)
await users.atomicUpdate(userId, {
    $inc: { balance: -50 }
});

// Works with nested fields
await users.atomicUpdate(userId, {
    $inc: { 'stats.score': 10 }
});
```

#### `$set` - Atomic Field Update
Atomically sets field values without reading the document.

```typescript
// Set single field
await users.atomicUpdate(userId, {
    $set: { status: 'active' }
});

// Set multiple fields
await users.atomicUpdate(userId, {
    $set: { 
        status: 'active',
        lastLogin: new Date()
    }
});

// Set nested fields
await users.atomicUpdate(userId, {
    $set: { 'profile.theme': 'dark' }
});
```

#### `$push` - Atomic Array Append
Atomically appends values to array fields.

```typescript
// Append to array
await users.atomicUpdate(userId, {
    $push: { 'profile.tags': 'new-tag' }
});

// Works with non-existent arrays (creates them)
await users.atomicUpdate(userId, {
    $push: { 'metadata.history': { action: 'login', timestamp: Date.now() } }
});
```

### Combining Operators

You can combine multiple operators in a single atomic update:

```typescript
await users.atomicUpdate(userId, {
    $inc: { 'stats.loginCount': 1, 'stats.points': 10 },
    $set: { lastLogin: new Date(), status: 'active' },
    $push: { 'activity.recent': { type: 'login', time: Date.now() } }
});
```

### Performance Benefits

- **No read-before-write**: Eliminates the need to fetch the document first
- **Atomic execution**: All updates happen in a single SQL statement
- **Race condition free**: Multiple concurrent updates won't overwrite each other
- **Constrained field optimization**: Updates to constrained fields use direct column updates

### Sync Version

```typescript
// Synchronous atomic update
const updated = users.atomicUpdateSync(userId, {
    $inc: { count: 1 }
});
```

## 2. Optimistic Concurrency Control (OCC)

OCC prevents lost updates in concurrent scenarios by using version numbers.

### Version Tracking

Every document now has a hidden `_version` field that:
- Starts at 1 when a document is created
- Increments by 1 on every update (both `put()` and `atomicUpdate()`)
- Is automatically returned in `findById()`, `insert()`, and `put()` operations

```typescript
// Insert returns version
const user = await users.insert({ 
    name: 'Alice',
    email: 'alice@example.com' 
});
console.log((user as any)._version); // 1

// Update increments version
const updated = await users.put(user._id, { name: 'Alice Smith' });
console.log((updated as any)._version); // 2
```

### Version-Based Updates

Use the `expectedVersion` option to ensure the document hasn't changed since you read it:

```typescript
// Read document
const user = await users.findById(userId);
const version = (user as any)._version;

// Perform atomic update with version check
try {
    await users.atomicUpdate(
        userId,
        { $inc: { balance: 100 } },
        { expectedVersion: version }
    );
    console.log('Update successful');
} catch (error) {
    if (error instanceof VersionMismatchError) {
        // Document was modified by another process
        console.log(`Version mismatch: expected ${error.expectedVersion}, got ${error.actualVersion}`);
        // Retry with fresh read
    }
}
```

### Preventing Lost Updates

OCC is particularly useful for concurrent updates:

```typescript
// Two processes read the same document
const process1User = await users.findById(userId);
const process2User = await users.findById(userId);

// Process 1 updates successfully
await users.atomicUpdate(
    userId,
    { $inc: { balance: 50 } },
    { expectedVersion: (process1User as any)._version }
); // Success

// Process 2's update fails due to version mismatch
await users.atomicUpdate(
    userId,
    { $inc: { balance: 100 } },
    { expectedVersion: (process2User as any)._version }
); // Throws VersionMismatchError
```

### Retry Pattern

A common pattern for handling version conflicts:

```typescript
async function updateWithRetry(userId: string, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            // Read current state
            const user = await users.findById(userId);
            if (!user) throw new Error('User not found');
            
            const version = (user as any)._version;
            
            // Attempt update with version check
            return await users.atomicUpdate(
                userId,
                { $inc: { loginCount: 1 } },
                { expectedVersion: version }
            );
        } catch (error) {
            if (error instanceof VersionMismatchError && i < maxRetries - 1) {
                // Retry with exponential backoff
                await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 100));
                continue;
            }
            throw error;
        }
    }
}
```

### Without Version Checking

If you don't need version checking, simply omit the `expectedVersion` option:

```typescript
// Last write wins
await users.atomicUpdate(userId, {
    $inc: { views: 1 }
});
```

## 3. Field Projections

Projections allow you to select specific fields from documents, reducing data transfer and parsing overhead.

### Basic Projections

```typescript
// Select specific fields
const results = await users
    .query()
    .select('name', 'email')
    .toArray();

// Select nested fields
const results = await users
    .query()
    .select('name', 'profile.bio', 'profile.avatar')
    .toArray();
```

### With Filters

```typescript
// Combine with where clauses
const activeUsers = await users
    .where('status').eq('active')
    .select('name', 'email', 'lastLogin')
    .toArray();
```

### Performance Benefits

Projections are especially beneficial for:
- Large documents with many fields
- Documents with nested arrays or objects
- Bandwidth-constrained environments

```typescript
// Without projection - fetches entire 100KB document
const user = await users.findById(userId);

// With projection - fetches only name and email
const user = await users
    .where('_id').eq(userId)
    .select('name', 'email')
    .first();
```

### Constrained Fields Optimization

When selecting constrained fields, skibbaDB uses direct column access instead of JSON parsing:

```typescript
const products = db.collection('products', productSchema, {
    constrainedFields: {
        price: { type: 'REAL' },
        stock: { type: 'INTEGER' }
    }
});

// Efficiently uses column indexes
const results = await products
    .query()
    .select('name', 'price', 'stock')
    .where('price').gte(10)
    .toArray();
```

## 4. Rebuild Indexes Tool

The `rebuildIndexes()` method scans all documents and repairs any inconsistencies between JSON documents and constrained field columns.

### Basic Usage

```typescript
const result = await users.rebuildIndexes();
console.log(`Scanned: ${result.scanned}`);
console.log(`Fixed: ${result.fixed}`);
console.log(`Errors: ${result.errors.join(', ')}`);
```

### When to Use

Use `rebuildIndexes()` when:
- Migrating from pure JSON to constrained fields
- Recovering from data corruption
- After manual database modifications
- Verifying data integrity

### What It Does

1. Scans all documents in the collection
2. Extracts constrained field values from JSON
3. Compares with current column values
4. Updates columns if they don't match
5. Rebuilds vector indexes if present

### Example

```typescript
const products = db.collection('products', productSchema, {
    constrainedFields: {
        price: { type: 'REAL' },
        stock: { type: 'INTEGER' }
    }
});

// Add some products
await products.insertBulk([...]);

// Later, rebuild indexes to verify/repair
const result = await products.rebuildIndexes();

if (result.fixed > 0) {
    console.log(`Repaired ${result.fixed} documents`);
}

if (result.errors.length > 0) {
    console.error('Errors during rebuild:', result.errors);
}
```

### Sync Version

```typescript
const result = users.rebuildIndexesSync();
```

## Migration Guide

### Adding Atomic Updates to Existing Code

**Before:**
```typescript
// Old pattern with race conditions
const user = await users.findById(userId);
user.balance += 100;
await users.put(userId, user);
```

**After:**
```typescript
// New atomic pattern
await users.atomicUpdate(userId, {
    $inc: { balance: 100 }
});
```

### Adding OCC to Critical Updates

**Before:**
```typescript
// No protection against concurrent updates
await users.atomicUpdate(userId, { $inc: { balance: amount } });
```

**After:**
```typescript
// With version checking
const user = await users.findById(userId);
await users.atomicUpdate(
    userId,
    { $inc: { balance: amount } },
    { expectedVersion: (user as any)._version }
);
```

## Performance Considerations

### Atomic Updates vs. Put

| Operation | Atomic Update | Put (read-modify-write) |
|-----------|--------------|-------------------------|
| Database round trips | 1 | 2 (read + write) |
| Race conditions | None | Possible |
| Lock duration | Minimal | Longer |
| Network traffic | Minimal | 2x (read + write) |

### Version Checking Overhead

- Version checking adds minimal overhead (single integer comparison in WHERE clause)
- Use it for critical updates where consistency matters
- Omit it for non-critical updates where last-write-wins is acceptable

### Projection Performance

For a 10KB document selecting 2 fields:
- **Without projection**: ~10KB transferred, full JSON parse
- **With projection**: ~100 bytes transferred, minimal parsing
- **Speed improvement**: ~50-100x for large documents

## Error Handling

```typescript
import { 
    VersionMismatchError,
    NotFoundError,
    ValidationError 
} from 'skibbadb';

try {
    await users.atomicUpdate(userId, {
        $inc: { balance: 100 }
    }, { expectedVersion: 5 });
} catch (error) {
    if (error instanceof VersionMismatchError) {
        console.log('Concurrent modification detected');
        console.log(`Expected version: ${error.expectedVersion}`);
        console.log(`Actual version: ${error.actualVersion}`);
    } else if (error instanceof NotFoundError) {
        console.log('Document not found');
    } else if (error instanceof ValidationError) {
        console.log('Invalid update operators');
    }
}
```

## Best Practices

1. **Use atomic updates for counters and incremental changes**
   ```typescript
   // Good
   await users.atomicUpdate(userId, { $inc: { views: 1 } });
   
   // Avoid
   const user = await users.findById(userId);
   user.views++;
   await users.put(userId, user);
   ```

2. **Use OCC for critical financial/inventory operations**
   ```typescript
   // For money transfers, inventory deduction, etc.
   await users.atomicUpdate(userId, 
       { $inc: { balance: -amount } },
       { expectedVersion: currentVersion }
   );
   ```

3. **Use projections for list views and summaries**
   ```typescript
   // Efficient user list
   const users = await users
       .query()
       .select('name', 'email', 'avatar')
       .limit(50)
       .toArray();
   ```

4. **Run rebuildIndexes() after schema changes**
   ```typescript
   // After adding new constrained fields
   const result = await collection.rebuildIndexes();
   ```

5. **Combine operators for complex updates**
   ```typescript
   await orders.atomicUpdate(orderId, {
       $set: { status: 'processing' },
       $inc: { 'stats.processedCount': 1 },
       $push: { 'history': { status: 'processing', time: Date.now() } }
   });
   ```
