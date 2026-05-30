import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { Database } from '../src/database';
import type { CollectionSchema, VectorSearchOptions } from '../src/types';
import 'dotenv/config';
import { isVectorExtensionAvailable } from './vector-support';

const hasOpenAIKey = Boolean(process.env.OPENAI_API_KEY);
const canRunVectorSearchTests = isVectorExtensionAvailable() && hasOpenAIKey;

// OpenAI API helper
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

    if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.data[0].embedding;
}

// Define schema with vector field
const DocumentSchema = z.object({
    _id: z.string(),
    title: z.string(),
    content: z.string(),
    embedding: z.array(z.number()), // This will be treated as a vector field
    category: z.string(),
});

type Document = z.infer<typeof DocumentSchema>;

const documentCollection: CollectionSchema<Document> = {
    name: 'documents',
    schema: DocumentSchema,
    primaryKey: '_id',
    constrainedFields: {
        embedding: {
            type: 'VECTOR',
            vectorDimensions: 1536, // text-embedding-3-small dimensions
            vectorType: 'float',
        },
        category: {
            type: 'TEXT',
        },
    },
};

// Test documents with their content - embeddings will be generated
const testDocumentTexts = [
    {
        title: 'Document 1',
        content: 'This is about technology and artificial intelligence',
        category: 'tech',
    },
    {
        title: 'Document 2',
        content: 'This is about scientific research and biology',
        category: 'science',
    },
    {
        title: 'Document 3',
        content: 'This is about sports and athletics',
        category: 'sports',
    },
    {
        title: 'Document 4',
        content: 'Mixed technology and scientific computing',
        category: 'tech',
    },
];

// Cache embeddings to avoid repeated API calls
const embeddingCache = new Map<string, number[]>();

async function getOrCreateEmbedding(text: string): Promise<number[]> {
    if (embeddingCache.has(text)) {
        return embeddingCache.get(text)!;
    }
    const embedding = await getEmbedding(text);
    embeddingCache.set(text, embedding);
    return embedding;
}

const drivers = [
    { name: 'bun', config: { driver: 'bun' as const, memory: true } },
    { name: 'node-sqlite', config: { driver: 'node' as const, memory: true } },
] as const;

// Test with each driver
drivers.forEach(({ name, config }) => {
describe.skipIf(!canRunVectorSearchTests)(`Vector Search Tests - ${name} driver`, () => {
        let db: Database;
        let collection: ReturnType<Database['collection']>;

        beforeEach(async () => {
            db = new Database(config);
            collection = db.collection('documents', DocumentSchema, {
                primaryKey: '_id',
                constrainedFields: {
                    'embedding': {
                        type: 'VECTOR',
                        vectorDimensions: 1536, // text-embedding-3-small dimensions
                        vectorType: 'float',
                    },
                    'category': {
                        type: 'TEXT',
                    }
                }
            });

            // Insert test documents with real embeddings
            for (const docText of testDocumentTexts) {
                const embedding = await getOrCreateEmbedding(docText.content);
                await collection.insert({
                    ...docText,
                    embedding,
                });
            }
        });

        afterEach(async () => {
            await db.close();
        });

        test('should create vector table correctly', async () => {
            // Test that we can insert documents with vector fields
            const embedding = await getOrCreateEmbedding(
                'Testing vector table creation'
            );
            const doc = await collection.insert({
                title: 'Test vector creation',
                content: 'Testing vector table creation',
                embedding,
                category: 'test',
            });

            expect(doc.embedding).toEqual(embedding);
            expect(doc.embedding.length).toBe(1536);
        });

        test('should perform basic vector similarity search', async () => {
            // Search for technology-related content
            const queryEmbedding = await getOrCreateEmbedding(
                'artificial intelligence and machine learning'
            );

            const searchOptions: VectorSearchOptions = {
                field: 'embedding',
                vector: queryEmbedding,
                limit: 2,
            };

            const results = await collection.vectorSearch(searchOptions);

            expect(results).toHaveLength(2);
            expect(results[0].distance).toBeDefined();
            expect(typeof results[0].distance).toBe('number');
            expect(results[0]._id).toBeDefined();
            // Should return tech-related documents first
            expect(['Document 1', 'Document 4']).toContain(
                results[0].document.title
            );
        });

        test('should respect limit parameter', async () => {
            const queryEmbedding = await getOrCreateEmbedding(
                'scientific research'
            );

            const searchOptions: VectorSearchOptions = {
                field: 'embedding',
                vector: queryEmbedding,
                limit: 1,
            };

            const results = await collection.vectorSearch(searchOptions);

            expect(results).toHaveLength(1);
            expect(results[0].document.category).toBe('science');
        });

        test('should work with additional WHERE filters', async () => {
            const queryEmbedding = await getOrCreateEmbedding(
                'computing and programming'
            );

            const searchOptions: VectorSearchOptions = {
                field: 'embedding',
                vector: queryEmbedding,
                limit: 10,
                where: [{ field: 'category', operator: 'eq', value: 'tech' }],
            };

            const results = await collection.vectorSearch(searchOptions);

            expect(results.length).toBeLessThanOrEqual(2); // Only tech documents
            for (const result of results) {
                expect(result.document.category).toBe('tech');
            }
        });

        test('should validate vector dimensions', async () => {
            const searchOptions: VectorSearchOptions = {
                field: 'embedding',
                vector: [1.0, 0.0], // Wrong dimensions (2D instead of 1536D)
                limit: 1,
            };

            await expect(
                collection.vectorSearch(searchOptions)
            ).rejects.toThrow('must have 1536 dimensions');
        });

        test('should validate field is a vector field', async () => {
            const queryEmbedding = await getOrCreateEmbedding('test');

            const searchOptions: VectorSearchOptions = {
                field: 'category', // Not a vector field
                vector: queryEmbedding,
                limit: 1,
            };

            await expect(
                collection.vectorSearch(searchOptions)
            ).rejects.toThrow('is not a vector field');
        });

        test('should validate field exists', async () => {
            const queryEmbedding = await getOrCreateEmbedding('test');

            const searchOptions: VectorSearchOptions = {
                field: 'nonexistent', // Field doesn't exist
                vector: queryEmbedding,
                limit: 1,
            };

            await expect(
                collection.vectorSearch(searchOptions)
            ).rejects.toThrow('is not defined as a constrained field');
        });

        test('should handle vector updates', async () => {
            // Get a document first
            const docs = await collection.toArray();
            const doc = docs[0];

            // Update its embedding with new content
            const newEmbedding = await getOrCreateEmbedding(
                'updated content about machine learning algorithms'
            );
            const updatedDoc = await collection.put(doc._id, {
                ...doc,
                content: 'updated content about machine learning algorithms',
                embedding: newEmbedding,
            });

            expect(updatedDoc.embedding).toEqual(newEmbedding);

            // Search should find the updated vector
            const searchOptions: VectorSearchOptions = {
                field: 'embedding',
                vector: newEmbedding,
                limit: 1,
            };

            const results = await collection.vectorSearch(searchOptions);
            expect(results[0].document._id).toBe(doc._id);
        });

        test('should handle vector deletions', async () => {
            const docs = await collection.toArray();
            const initialCount = docs.length;

            // Delete a document
            await collection.delete(docs[0]._id);

            // Verify it's gone from regular queries
            const remainingDocs = await collection.toArray();
            expect(remainingDocs).toHaveLength(initialCount - 1);

            // Verify it's gone from vector searches
            const searchOptions: VectorSearchOptions = {
                field: 'embedding',
                vector: docs[0].embedding,
                limit: 10,
            };

            const results = await collection.vectorSearch(searchOptions);
            const foundDeleted = results.find(
                (r) => r.document._id === docs[0]._id
            );
            expect(foundDeleted).toBeUndefined();
        });

        test('should return results ordered by distance', async () => {
            const queryEmbedding = await getOrCreateEmbedding(
                'technology computer science'
            );

            const searchOptions: VectorSearchOptions = {
                field: 'embedding',
                vector: queryEmbedding,
                limit: 4,
            };

            const results = await collection.vectorSearch(searchOptions);

            // Distances should be in ascending order
            for (let i = 1; i < results.length; i++) {
                expect(results[i].distance).toBeGreaterThanOrEqual(
                    results[i - 1].distance
                );
            }
        });

        test('should handle bulk inserts with vectors', async () => {
            const embedding1 = await getOrCreateEmbedding('Bulk insert test 1');
            const embedding2 = await getOrCreateEmbedding('Bulk insert test 2');

            const newDocs = [
                {
                    title: 'Bulk 1',
                    content: 'Bulk insert test 1',
                    embedding: embedding1,
                    category: 'bulk',
                },
                {
                    title: 'Bulk 2',
                    content: 'Bulk insert test 2',
                    embedding: embedding2,
                    category: 'bulk',
                },
            ];

            const inserted = await collection.insertBulk(newDocs);
            expect(inserted).toHaveLength(2);

            // Verify they can be found via vector search
            const searchOptions: VectorSearchOptions = {
                field: 'embedding',
                vector: embedding1,
                limit: 1,
            };

            const results = await collection.vectorSearch(searchOptions);
            expect(results[0].document.title).toBe('Bulk 1');
        });
    });
});
