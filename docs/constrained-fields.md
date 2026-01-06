# Constrained Fields

Constrained fields provide a powerful way to enforce data integrity and optimize query performance in skibbaDB. They create dedicated SQLite columns with constraints for specific fields in your documents, enabling features like unique constraints, foreign key relationships, type coercion, and vector search capabilities.

## Overview

When you define constrained fields on a collection, skibbaDB:
1. Creates dedicated SQLite columns for those fields alongside the document JSON storage
2. Automatically extracts and stores field values in these columns during insert/update operations
3. Enforces constraints at the database level (unique, foreign key, nullability)
4. Provides optimized query performance through proper indexing
5. Enables advanced features like vector similarity search

## Basic Usage

```typescript
import { z } from 'zod';
import { createDB } from 'skibbaDB';

const userSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  username: z.string(),
  age: z.number().optional(),
  profile: z.object({
    firstName: z.string(),
    lastName: z.string(),
  }),
});

const db = createDB({ path: './data.db' });

const users = db.collection('users', userSchema, {
  constrainedFields: {
    email: { 
      unique: true, 
      nullable: false 
    },
    username: { 
      unique: true,
      type: 'TEXT' 
    },
    age: { 
      type: 'INTEGER',
      nullable: true 
    },
    'profile.firstName': { 
      type: 'TEXT' 
    },
  },
});
```

## ConstrainedFieldDefinition Reference

Each constrained field is defined using a `ConstrainedFieldDefinition` object with the following properties:

### Core Properties

#### `type?: 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB' | 'VECTOR'`
Explicitly sets the SQLite column type. If not specified, the type is inferred from the Zod schema:
- `z.string()` → `TEXT`
- `z.number()` → `REAL`  
- `z.bigint()` → `INTEGER`
- `z.boolean()` → `INTEGER` (0/1)
- `z.date()` → `TEXT` (ISO string)
- `z.array(z.number())` → `VECTOR` (for vector fields)
- `z.object()` → `TEXT` (JSON serialized)

```typescript
const products = db.collection('products', productSchema, {
  constrainedFields: {
    name: { type: 'TEXT' },
    price: { type: 'REAL' },
    inStock: { type: 'INTEGER' }, // boolean stored as 0/1
    metadata: { type: 'TEXT' },   // object stored as JSON
  },
});
```

#### `nullable?: boolean`
Controls whether the field can be `NULL`. Defaults to `true` (nullable).

```typescript
const users = db.collection('users', userSchema, {
  constrainedFields: {
    email: { nullable: false },      // NOT NULL constraint
    middleName: { nullable: true },  // allows NULL (default)
  },
});
```

#### `unique?: boolean`
Enforces a unique constraint on the field. Throws `UniqueConstraintError` on violation.

```typescript
const users = db.collection('users', userSchema, {
  constrainedFields: {
    email: { unique: true },
    username: { unique: true },
  },
});

// This will succeed
const user1 = await users.insert({
  email: 'john@example.com',
  username: 'john_doe',
});

// This will throw UniqueConstraintError
const user2 = await users.insert({
  email: 'john@example.com', // Duplicate email
  username: 'jane_doe',
});
```

#### `index?: boolean`
Creates a non-unique index on the field for improved query performance. Unlike `unique`, this allows duplicate values while still providing fast lookups.

```typescript
const products = db.collection('products', productSchema, {
  constrainedFields: {
    category: { 
      type: 'TEXT',
      index: true,  // Non-unique index for fast category queries
    },
    price: {
      type: 'REAL',
      index: true,  // Index for range queries (e.g., price > 100)
    },
    sku: {
      type: 'TEXT',
      unique: true, // Unique constraint (don't use index with unique)
    },
  },
});

// Fast queries using the index
const books = products.where('category').eq('books').toArraySync();
const expensive = products.where('price').gt(100).toArraySync();
```

**Note**: Don't set `index: true` when `unique: true` is already set, as unique constraints automatically create an index.

### Foreign Key Constraints

#### `foreignKey?: string`
Creates a foreign key relationship using the format `'table.column'`. Use `table._id` to reference the primary key of another collection.

```typescript
const users = db.collection('users', userSchema);

const posts = db.collection('posts', postSchema, {
  constrainedFields: {
    authorId: {
      foreignKey: 'users._id',  // References users table primary key
      nullable: false,
    },
    categoryId: {
      foreignKey: 'categories.id', // References custom field
      nullable: true,
    },
  },
});
```

#### `onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT'`
Defines the action when the referenced record is deleted:
- `CASCADE`: Delete this record when referenced record is deleted
- `SET NULL`: Set this field to NULL when referenced record is deleted  
- `RESTRICT`: Prevent deletion of referenced record (default)

#### `onUpdate?: 'CASCADE' | 'SET NULL' | 'RESTRICT'`
Defines the action when the referenced record's key is updated:
- `CASCADE`: Update this field when referenced record's key changes
- `SET NULL`: Set this field to NULL when referenced record's key changes
- `RESTRICT`: Prevent updates to referenced record's key (default)

```typescript
const posts = db.collection('posts', postSchema, {
  constrainedFields: {
    authorId: {
      foreignKey: 'users._id',
      onDelete: 'CASCADE',     // Delete post when user is deleted
      onUpdate: 'CASCADE',     // Update authorId when user ID changes
    },
    editorId: {
      foreignKey: 'users._id',
      onDelete: 'SET NULL',    // Set to NULL when editor is deleted
      nullable: true,
    },
  },
});
```

### Check Constraints

#### `checkConstraint?: string`
Adds a SQL CHECK constraint. The field name in the expression is automatically replaced with the column name.

```typescript
const products = db.collection('products', productSchema, {
  constrainedFields: {
    price: {
      type: 'REAL',
      checkConstraint: 'price > 0',           // Must be positive
    },
    quantity: {
      type: 'INTEGER', 
      checkConstraint: 'quantity >= 0',       // Non-negative
    },
    rating: {
      type: 'REAL',
      checkConstraint: 'rating BETWEEN 1 AND 5', // Rating scale
    },
  },
});
```

## Vector Fields

Constrained fields support vector embeddings for similarity search using LibSQL's vec0 extension.

### Vector Configuration

#### `type: 'VECTOR'`
Marks the field as a vector field. Requires `vectorDimensions` to be specified.

#### `vectorDimensions: number`
Required for vector fields. Specifies the dimension count of the vectors.

#### `vectorType?: 'float' | 'int8' | 'binary'`
The data type for vector storage. Defaults to `'float'`.

```typescript
const documentsSchema = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  embedding: z.array(z.number()), // Vector embedding
});

const documents = db.collection('documents', documentsSchema, {
  constrainedFields: {
    embedding: {
      type: 'VECTOR',
      vectorDimensions: 384,        // 384-dimensional vectors
      vectorType: 'float',          // 32-bit floats
    },
  },
});

// Insert document with vector
await documents.insert({
  title: 'Machine Learning Basics',
  content: 'An introduction to ML...',
  embedding: [0.1, 0.2, 0.3, /* ... 381 more values */],
});

// Perform vector similarity search
const results = await documents.vectorSearch({
  field: 'embedding',
  vector: queryEmbedding,
  limit: 10,
  distance: 'cosine',
});
```

## Nested Field Paths

Constrained fields support nested object properties using dot notation:

```typescript
const userSchema = z.object({
  id: z.string(),
  profile: z.object({
    personal: z.object({
      firstName: z.string(),
      lastName: z.string(),
    }),
    contact: z.object({
      email: z.string().email(),
      phone: z.string().optional(),
    }),
  }),
  settings: z.object({
    theme: z.enum(['light', 'dark']),
    notifications: z.boolean(),
  }),
});

const users = db.collection('users', userSchema, {
  constrainedFields: {
    'profile.personal.firstName': { 
      type: 'TEXT',
      nullable: false 
    },
    'profile.personal.lastName': { 
      type: 'TEXT',
      nullable: false 
    },
    'profile.contact.email': { 
      type: 'TEXT',
      unique: true,
      nullable: false 
    },
    'profile.contact.phone': { 
      type: 'TEXT',
      unique: true,
      nullable: true 
    },
    'settings.theme': { 
      type: 'TEXT' 
    },
  },
});
```

### Field Path Rules

1. **Validation**: Field paths are validated against the Zod schema at collection creation
2. **Column Naming**: Dots in field paths are converted to underscores for column names (`profile.email` → `profile_email`)
3. **Query Support**: You can query constrained nested fields directly for better performance
4. **Type Safety**: TypeScript provides autocomplete and type checking for valid field paths

## Query Performance Benefits

Constrained fields provide significant query performance improvements:

### Indexed Queries
```typescript
// Fast query using constrained field (uses column index)
const usersByEmail = await users.where('email').eq('john@example.com').toArray();

// Fast query using nested constrained field
const usersByFirstName = await users.where('profile.personal.firstName').eq('John').toArray();
```

### Range Queries
```typescript
const products = db.collection('products', productSchema, {
  constrainedFields: {
    price: { type: 'REAL' },
    createdAt: { type: 'TEXT' }, // Date stored as ISO string
  },
});

// Efficient range queries
const expensiveProducts = await products.where('price').gt(100).toArray();
const recentProducts = await products.where('createdAt').gte('2024-01-01').toArray();
```

### Join Operations
```typescript
// Efficient joins using foreign key constrained fields
const postsWithAuthors = await posts
  .join('users', 'authorId', '_id')
  .select(['title', 'content', 'users.name', 'users.email'])
  .toArray();
```

## Validation and Error Handling

### Schema Validation
Field paths are validated against the Zod schema when the collection is created:

```typescript
// This will throw an error at collection creation time
const invalid = db.collection('users', userSchema, {
  constrainedFields: {
    'nonexistent.field': { type: 'TEXT' }, // Error: field doesn't exist in schema
  },
});
```

### Constraint Violations
Different constraint violations throw specific error types:

```typescript
import { UniqueConstraintError, ForeignKeyError } from 'skibbaDB/errors';

try {
  await users.insert({ email: 'duplicate@example.com' });
} catch (error) {
  if (error instanceof UniqueConstraintError) {
    console.log(`Unique constraint violation: ${error.field}`);
  }
}

try {
  await posts.insert({ authorId: 'nonexistent-user-id' });
} catch (error) {
  if (error instanceof ForeignKeyError) {
    console.log(`Foreign key constraint violation: ${error.field}`);
  }
}
```

## Migration and Schema Evolution

When adding constrained fields to existing collections:

```typescript
// Original collection without constrained fields
const users = db.collection('users', userSchema);

// Later, add constrained fields (requires migration)
const usersV2 = db.collection('users', userSchemaV2, {
  version: 2,
  constrainedFields: {
    email: { unique: true, nullable: false },
  },
  upgrade: {
    2: async (oldDoc) => {
      // Migrate existing documents
      return {
        ...oldDoc,
        // Ensure email exists for new constraint
        email: oldDoc.email || `user-${oldDoc.id}@example.com`,
      };
    },
  },
});
```

## Best Practices

### 1. Choose Fields Wisely
Only create constrained fields for:
- Fields you frequently query or filter by
- Fields requiring constraints (unique, foreign key)
- Fields needing specific data types for performance
- Vector fields for similarity search

### 2. Type Specification
Be explicit about types when Zod inference isn't sufficient:
```typescript
constrainedFields: {
  score: { type: 'REAL' },      // Ensure floating point storage
  count: { type: 'INTEGER' },   // Ensure integer storage
  metadata: { type: 'TEXT' },   // Ensure JSON serialization
}
```

### 3. Nullability Consideration
Set `nullable: false` only when absolutely necessary:
```typescript
constrainedFields: {
  email: { unique: true, nullable: false }, // Required field
  phone: { unique: true, nullable: true },  // Optional but unique when present
}
```

### 4. Foreign Key Design
Use meaningful cascade behaviors:
```typescript
constrainedFields: {
  authorId: {
    foreignKey: 'users._id',
    onDelete: 'CASCADE',    // Delete posts when user is deleted
  },
  editorId: {
    foreignKey: 'users._id', 
    onDelete: 'SET NULL',   // Keep post but remove editor reference
    nullable: true,
  },
}
```

### 5. Vector Field Optimization
For vector fields, choose appropriate dimensions and types:
```typescript
constrainedFields: {
  textEmbedding: {
    type: 'VECTOR',
    vectorDimensions: 384,  // Match your embedding model
    vectorType: 'float',    // Good balance of precision and storage
  },
  imageEmbedding: {
    type: 'VECTOR', 
    vectorDimensions: 2048,
    vectorType: 'int8',     // Quantized embeddings for storage efficiency
  },
}
```

## Comparison with Legacy Schema Constraints

The legacy `constraints` system is deprecated in favor of `constrainedFields`:

```typescript
// ❌ Deprecated way (still supported but will be removed)
const users = db.collection('users', userSchema, {
  constraints: {
    constraints: {
      email: unique(),
      organizationId: foreignKey('organizations', 'id'),
    },
  },
});

// ✅ New way (recommended)
const users = db.collection('users', userSchema, {
  constrainedFields: {
    email: { unique: true, nullable: false },
    organizationId: { foreignKey: 'organizations._id' },
  },
});
```

The new system provides:
- Better TypeScript integration
- More granular control over field behavior
- Support for nested field paths
- Vector field capabilities
- Cleaner, more explicit syntax

## Conclusion

Constrained fields provide a powerful foundation for building robust, performant applications with skibbaDB. By carefully choosing which fields to constrain and how to configure them, you can ensure data integrity while maximizing query performance and enabling advanced features like vector search.