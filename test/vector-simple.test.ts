import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { Database } from '../src/database';
import type { VectorSearchOptions } from '../src/types';
import { isVectorExtensionAvailable } from './vector-support';

// Simple test with small vectors to avoid API calls
const DocumentSchema = z.object({
    _id: z.string(),
    title: z.string(),
    embedding: z.array(z.number()),
});

type Document = z.infer<typeof DocumentSchema>;

const documentCollection: CollectionSchema<Document> = {
    name: 'documents',
    schema: DocumentSchema,
    primaryKey: '_id',
    constrainedFields: {
        'embedding': {
            type: 'VECTOR',
            vectorDimensions: 3, // Small 3D vectors for testing
            vectorType: 'float',
        }
    }
};

const testDocuments = [
    {
        title: 'Document 1',
        embedding: [1.0, 0.0, 0.0],
    },
    {
        title: 'Document 2', 
        embedding: [0.0, 1.0, 0.0],
    },
    {
        title: 'Document 3',
        embedding: [0.0, 0.0, 1.0],
    },
];

describe.skipIf(!isVectorExtensionAvailable())('Vector Search Basic Tests', () => {
    let db: Database;
    let collection: ReturnType<Database['collection']>;

    beforeEach(async () => {
        db = new Database({ driver: 'bun', memory: true });
        collection = db.collection('documents', DocumentSchema, {
            primaryKey: '_id',
            constrainedFields: {
                'embedding': {
                    type: 'VECTOR',
                    vectorDimensions: 3, // Small 3D vectors for testing
                    vectorType: 'float',
                }
            }
        });
        
        // Insert test documents
        for (const doc of testDocuments) {
            await collection.insert(doc);
        }
    });

    afterEach(async () => {
        await db.close();
    });

    test('should create vector table and insert documents', async () => {
        const docs = await collection.toArray();
        expect(docs).toHaveLength(3);
        expect(docs[0].embedding).toEqual([1.0, 0.0, 0.0]);
    });

    test('should perform vector similarity search', async () => {
        const searchOptions: VectorSearchOptions = {
            field: 'embedding',
            vector: [1.0, 0.0, 0.0], // Should match Document 1 exactly
            limit: 1,
        };

        const results = await collection.vectorSearch(searchOptions);
        expect(results).toHaveLength(1);
        expect(results[0].document.title).toBe('Document 1');
        expect(results[0].distance).toBeDefined();
    });

    test('should validate vector dimensions', async () => {
        const searchOptions: VectorSearchOptions = {
            field: 'embedding',
            vector: [1.0, 0.0], // Wrong dimensions
            limit: 1,
        };

        await expect(collection.vectorSearch(searchOptions)).rejects.toThrow('must have 3 dimensions');
    });
});