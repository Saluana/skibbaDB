# Vector Search

BusNDB provides powerful vector search capabilities using sqlite-vec, enabling similarity search and semantic queries on your data.

## Overview

Vector search allows you to store high-dimensional vectors (embeddings) alongside your documents and perform similarity searches using K-nearest neighbor (KNN) queries. This is perfect for:

- Semantic search
- Recommendation systems
- Document similarity
- Image or audio similarity
- RAG (Retrieval Augmented Generation) applications

## Prerequisites

### Node.js
Vector search works out of the box with Node.js when you have `better-sqlite3` installed:

```bash
npm install better-sqlite3
```

### Bun
For Bun, you need SQLite with extension support:

```bash
# macOS
brew install sqlite

# The library will automatically detect and use the Homebrew SQLite installation
```

## Basic Usage

### Defining Vector Fields

Define vector fields in your collection schema using `constrainedFields`:

```typescript
import { z } from 'zod';
import { Database } from 'busndb';

const DocumentSchema = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  embedding: z.array(z.number()), // Vector field
});

const db = new Database();
const collection = db.collection('documents', DocumentSchema, {
  constrainedFields: {
    embedding: {
      type: 'VECTOR',
      vectorDimensions: 1536, // OpenAI text-embedding-3-small
      vectorType: 'float', // 'float' | 'int8' | 'binary'
    }
  }
});
```

### Vector Field Configuration

- `type: 'VECTOR'` - Marks the field as a vector
- `vectorDimensions: number` - Required. Number of dimensions in your vectors
- `vectorType: 'float' | 'int8' | 'binary'` - Optional. Defaults to `'float'`

### Inserting Documents with Vectors

```typescript
// Insert a document with an embedding vector
await collection.insert({
  title: 'Machine Learning Basics',
  content: 'Introduction to neural networks and deep learning',
  embedding: [0.1, 0.2, 0.3, ...] // 1536-dimensional vector
});
```

### Vector Similarity Search

Perform KNN similarity searches using the `vectorSearch` method:

```typescript
import type { VectorSearchOptions } from 'busndb';

const searchOptions: VectorSearchOptions = {
  field: 'embedding',
  vector: queryEmbedding, // Your query vector (same dimensions)
  limit: 10, // Number of results to return
  distance: 'cosine', // Distance function (optional)
  where: [ // Additional filters (optional)
    { field: 'category', operator: 'eq', value: 'tech' }
  ]
};

const results = await collection.vectorSearch(searchOptions);

// Results are ordered by similarity (closest first)
results.forEach(result => {
  console.log(`Document: ${result.document.title}`);
  console.log(`Distance: ${result.distance}`);
  console.log(`ID: ${result.id}`);
});
```

## Working with OpenAI Embeddings

### Setup

```typescript
// Helper function to get embeddings from OpenAI
async function getEmbedding(text: string): Promise<number[]> {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      input: text,
      model: 'text-embedding-3-small',
    }),
  });

  const data = await response.json();
  return data.data[0].embedding;
}
```

### Complete Example

```typescript
import { z } from 'zod';
import { Database } from 'busndb';

// Define schema
const ArticleSchema = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  embedding: z.array(z.number()),
  category: z.string(),
});

// Create collection with vector field
const db = new Database();
const articles = db.collection('articles', ArticleSchema, {
  constrainedFields: {
    embedding: {
      type: 'VECTOR',
      vectorDimensions: 1536,
    },
    category: {
      type: 'TEXT',
    }
  }
});

// Insert articles with embeddings
const articleData = [
  {
    title: 'Introduction to Machine Learning',
    content: 'Machine learning is a subset of artificial intelligence...',
    category: 'tech'
  },
  {
    title: 'Cooking with Python',
    content: 'Learn to cook delicious meals using Python recipes...',
    category: 'cooking'
  }
];

for (const article of articleData) {
  const embedding = await getEmbedding(article.content);
  await articles.insert({
    ...article,
    embedding
  });
}

// Perform semantic search
const queryText = 'artificial intelligence and neural networks';
const queryEmbedding = await getEmbedding(queryText);

const results = await articles.vectorSearch({
  field: 'embedding',
  vector: queryEmbedding,
  limit: 5,
  where: [
    { field: 'category', operator: 'eq', value: 'tech' }
  ]
});

console.log('Most relevant articles:', results);
```

## Advanced Features

### Vector Updates

Vector fields are automatically updated when you update documents:

```typescript
const doc = await articles.findById('article-1');
const newEmbedding = await getEmbedding('Updated content');

await articles.put(doc.id, {
  ...doc,
  content: 'Updated content',
  embedding: newEmbedding
});
```

Vector embeddings are also maintained during `upsert` and `upsertBulk` operations, so replacements keep vector data in sync.

### Bulk Operations

Vector fields work with bulk operations:

```typescript
const documentsWithEmbeddings = await Promise.all(
  documents.map(async (doc) => ({
    ...doc,
    embedding: await getEmbedding(doc.content)
  }))
);

await articles.insertBulk(documentsWithEmbeddings);
```

### Distance Functions

sqlite-vec supports different distance functions:

- `'cosine'` - Cosine similarity (default)
- `'euclidean'` - Euclidean (L2) distance
- `'manhattan'` - Manhattan (L1) distance

```typescript
const results = await articles.vectorSearch({
  field: 'embedding',
  vector: queryEmbedding,
  limit: 10,
  distance: 'euclidean'
});
```

## Performance Tips

### Vector Dimensions

Choose appropriate vector dimensions based on your model:

- OpenAI text-embedding-3-small: 1536 dimensions
- OpenAI text-embedding-3-large: 3072 dimensions
- Sentence Transformers (384-1024 dimensions vary by model)

### Indexing

Vector tables use sqlite-vec's built-in indexing for efficient similarity search. No additional indexing configuration is needed.

### Batch Processing

For better performance when inserting many vectors:

```typescript
// Process in batches
const batchSize = 100;
for (let i = 0; i < documents.length; i += batchSize) {
  const batch = documents.slice(i, i + batchSize);
  const withEmbeddings = await Promise.all(
    batch.map(async (doc) => ({
      ...doc,
      embedding: await getEmbedding(doc.content)
    }))
  );
  await articles.insertBulk(withEmbeddings);
}
```

## Error Handling

### Missing Extension

If sqlite-vec extension is not available:

```typescript
try {
  await articles.vectorSearch(options);
} catch (error) {
  if (error.message.includes('sqlite-vec extension')) {
    console.log('Vector search not available. Install SQLite with extension support.');
    // Fallback to regular text search
  }
}
```

### Dimension Mismatch

Vector dimensions must match the field definition:

```typescript
// This will throw an error if embedding has wrong dimensions
await articles.insert({
  title: 'Test',
  content: 'Test content',
  embedding: [1, 2, 3] // Wrong! Should be 1536 dimensions
});
```

## Troubleshooting

### Bun: Extension Loading Failed

If you see "This build of sqlite3 does not support dynamic extension loading":

1. Install SQLite with extension support: `brew install sqlite`
2. Ensure the library path is detected (check console logs)
3. Manually set path if needed:
   ```typescript
   import { Database } from "bun:sqlite";
   Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
   ```

### Node.js: Extension Loading Failed

Ensure you have `better-sqlite3` installed:
```bash
npm install better-sqlite3
```

### Performance Issues

- Use appropriate batch sizes for bulk operations
- Consider vector dimension reduction if vectors are very large
- Use WHERE filters to reduce search space when possible

## Integration Examples

### RAG (Retrieval Augmented Generation)

```typescript
// Store knowledge base with embeddings
async function storeKnowledge(documents: string[]) {
  for (const doc of documents) {
    const embedding = await getEmbedding(doc);
    await knowledge.insert({
      content: doc,
      embedding
    });
  }
}

// Retrieve relevant context for questions
async function getRelevantContext(question: string, limit = 3) {
  const questionEmbedding = await getEmbedding(question);
  
  const results = await knowledge.vectorSearch({
    field: 'embedding',
    vector: questionEmbedding,
    limit
  });
  
  return results.map(r => r.document.content).join('\n\n');
}
```

### Recommendation System

```typescript
// Find similar products
async function findSimilarProducts(productId: string, limit = 5) {
  const product = await products.findById(productId);
  
  return await products.vectorSearch({
    field: 'embedding',
    vector: product.embedding,
    limit: limit + 1, // +1 to exclude the product itself
    where: [
      { field: 'id', operator: 'neq', value: productId }
    ]
  });
}
```

## Type Safety

BusNDB provides full TypeScript support for vector operations:

```typescript
import type { VectorSearchOptions, VectorSearchResult } from 'busndb';

// Type-safe search options
const options: VectorSearchOptions = {
  field: 'embedding', // Autocompleted based on schema
  vector: queryEmbedding,
  limit: 10
};

// Type-safe results
const results: VectorSearchResult<typeof ArticleSchema>[] = 
  await articles.vectorSearch(options);

// results[0].document is fully typed based on your schema
console.log(results[0].document.title); // TypeScript knows this is a string
```
