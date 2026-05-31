# Pagination

This guide explains how to implement pagination in skibbaDB for efficient data retrieval when working with large datasets.

## Overview

Pagination allows you to retrieve data in manageable chunks rather than loading all records at once. skibbaDB provides several pagination methods through the QueryBuilder interface.

## Basic Pagination Methods

### limit()
Restricts the maximum number of results returned:

```ts
// Get first 10 users
const users = await collection.limit(10).toArray();
```

### offset()
Skips a specified number of records from the beginning:

```ts
// Skip first 20 users, get the rest
const users = await collection.offset(20).toArray();
```

### Combined limit() and offset()
Use together for precise pagination control:

```ts
// Skip 10 records, then get next 5
const users = await collection.limit(5).offset(10).toArray();
```

## Page-Based Pagination

### page()
Convenience method for page-based pagination:

```ts
// Page 1, 10 items per page (records 1-10)
const page1 = await collection.page(1, 10).toArray();

// Page 2, 10 items per page (records 11-20)  
const page2 = await collection.page(2, 10).toArray();

// Page 3, 5 items per page (records 11-15)
const page3 = await collection.page(3, 5).toArray();
```

The `page()` method automatically calculates the offset as `(pageNumber - 1) * pageSize`.

## Pagination with Queries

Combine pagination with filtering and sorting:

```ts
// Get page 2 of active users, sorted by age
const activeUsers = await collection
  .where('status').eq('active')
  .orderBy('age', 'desc')
  .page(2, 25)
  .toArray();

// Get next 10 users older than 18, starting from record 50
const users = await collection
  .where('age').gte(18)
  .orderBy('name')
  .limit(10)
  .offset(50)
  .toArray();
```

## Collection-Level Shortcuts

Call pagination methods directly on collections:

```ts
// These create QueryBuilder instances with pagination applied
const limited = await collection.limit(5).toArray();
const offset = await collection.offset(10).toArray();
const paged = await collection.page(2, 10).toArray();
```

## Vector Search Pagination

Vector similarity searches support pagination via the `limit` option:

```ts
const results = await collection.vectorSearch({
  field: 'embedding',
  vector: [0.1, 0.2, 0.3, ...],
  limit: 20,  // Return top 20 most similar vectors
  where: [{ field: 'category', operator: 'eq', value: 'product' }]
});
```

## Input Validation

All pagination methods include comprehensive validation:

```ts
// ✅ Valid
collection.limit(10);
collection.offset(0);
collection.page(1, 25);

// ❌ Invalid - throws ValidationError
collection.limit(-1);     // Negative limit
collection.offset(-5);    // Negative offset  
collection.page(0, 10);   // Page numbers start at 1
collection.limit(1.5);    // Non-integer values
```

## Sync vs Async

Pagination works with both synchronous and asynchronous execution:

```ts
// Async (recommended)
const users = await collection.limit(10).toArray();
const first = await collection.page(1, 5).first();

// Sync
const users = collection.limit(10).toArraySync();
const first = collection.page(1, 5).firstSync();
```

## Performance Considerations

1. **Use ORDER BY with pagination** for consistent results:
   ```ts
   // ✅ Good - predictable order
   collection.orderBy('id').limit(10).offset(20)
   
   // ⚠️ Inconsistent - results may vary between queries
   collection.limit(10).offset(20)
   ```

2. **SQLite OFFSET behavior** - When using only `offset()` without `limit()`, skibbaDB automatically adds `LIMIT Number.MAX_SAFE_INTEGER` since SQLite requires LIMIT when using OFFSET.

3. **Large offsets** can be slow. Consider cursor-based pagination for better performance with large datasets:
   ```ts
   // Instead of large offset
   const page100 = collection.offset(99000).limit(1000);
   
   // Use cursor-based approach
   const afterId = 'last-seen-id';
   const nextPage = collection.where('id').gt(afterId).limit(1000);
   ```

## Complete Example

```ts
import { z } from 'zod';

const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  age: z.number(),
  email: z.string().email(),
  status: z.enum(['active', 'inactive'])
});

const users = new Collection(driver, {
  name: 'users', 
  schema: userSchema
});

async function paginateUsers() {
  const pageSize = 10;
  const pageNumber = 2;
  
  // Get page 2 of active users, sorted by name
  const userPage = await users
    .where('status').eq('active')
    .orderBy('name', 'asc')
    .page(pageNumber, pageSize)
    .toArray();
    
  // Get total count for pagination UI
  const totalActive = await users
    .where('status').eq('active')
    .executeCount();
    
  const totalPages = Math.ceil(totalActive / pageSize);
  
  return {
    users: userPage,
    currentPage: pageNumber,
    totalPages,
    totalUsers: totalActive,
    hasNextPage: pageNumber < totalPages,
    hasPrevPage: pageNumber > 1
  };
}
```

## Method Chaining

Pagination methods return new QueryBuilder instances, enabling fluent chaining:

```ts
const query = collection
  .where('active').eq(true)        // Filter active records
  .where('age').gte(18)            // Age 18 or older  
  .orderBy('name')                 // Sort by name
  .limit(25)                       // Max 25 results
  .offset(50);                     // Skip first 50

// Execute the query
const results = await query.toArray();
```

All pagination methods are validated, type-safe, and work seamlessly with skibbaDB's query system.