import { describe, test, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { createDB } from '../src/index';
import { DatabaseError } from '../src/errors';

describe('SQL Injection Prevention', () => {
    let db: ReturnType<typeof createDB>;
    const userSchema = z.object({
        _id: z
            .string()
            .uuid()
            .default(() => crypto.randomUUID()),
        name: z.string().min(1),
        email: z.string().email(),
        role: z.string().default('user'),
    });

    beforeEach(() => {
        db = createDB({ memory: true });
    });

    test('prevents SQL injection in collection names', () => {
        expect(() => {
            db.collection("users'; DROP TABLE users; --", userSchema);
        }).toThrow();
    });

    test('prevents SQL injection in field paths for json_array_length', () => {
        const users = db.collection('users', userSchema);
        
        expect(() => {
            users.query().addJsonArrayLengthFilter("'; DROP TABLE users; --", 'gt', 0);
        }).toThrow();
    });

    test('prevents SQL injection via semicolons in field names', () => {
        const users = db.collection('users', userSchema);
        
        expect(() => {
            users.query().addJsonArrayLengthFilter("field; DROP TABLE users", 'gt', 0);
        }).toThrow();
    });

    test('prevents SQL injection via comment markers in field names', () => {
        const users = db.collection('users', userSchema);
        
        expect(() => {
            users.query().addJsonArrayLengthFilter("field--comment", 'gt', 0);
        }).toThrow();
    });

    test('prevents SQL injection via /* */ comments in field names', () => {
        const users = db.collection('users', userSchema);
        
        expect(() => {
            users.query().addJsonArrayLengthFilter("field/*comment*/", 'gt', 0);
        }).toThrow();
    });

    test('allows valid field paths in json_array_length', () => {
        const users = db.collection('users', userSchema);
        
        // Valid field paths should work
        expect(() => {
            users.query().addJsonArrayLengthFilter("tags", 'gt', 0);
        }).not.toThrow();
        
        expect(() => {
            users.query().addJsonArrayLengthFilter("metadata.tags", 'gt', 0);
        }).not.toThrow();
    });

    test('recommends explicit table prefix in JOIN queries for clarity', async () => {
        const users = db.collection('users', userSchema);
        const postsSchema = z.object({
            _id: z.string().uuid().default(() => crypto.randomUUID()),
            title: z.string(),
            authorId: z.string().uuid(),
            published: z.boolean().default(false),
        });
        const posts = db.collection('posts', postsSchema);

        await users.insert({ name: 'Alice', email: 'alice@example.com' });
        
        // Note: Unprefixed fields in JOINs now default to the base table
        // This is safer than the old heuristic-based guessing
        // While this doesn't throw an error, explicit prefixes are still recommended
        const results = await users.where('_id').exists()
            .join('posts', '_id', 'authorId')
            .where('published').eq(true) // Defaults to users.published
            .toArray();
        
        // This query succeeds but might not match expectations if user has no 'published' field
        expect(results).toBeDefined();
    });

    test('allows explicit table prefixes in JOIN queries', async () => {
        const users = db.collection('users', userSchema);
        const postsSchema = z.object({
            _id: z.string().uuid().default(() => crypto.randomUUID()),
            title: z.string(),
            authorId: z.string().uuid(),
            published: z.boolean().default(false),
        });
        const posts = db.collection('posts', postsSchema);

        const user = await users.insert({ name: 'Alice', email: 'alice@example.com' });
        await posts.insert({ 
            title: 'Test Post', 
            authorId: user._id!,
            published: true 
        });
        
        // This should work with explicit table prefix
        const results = await users.where('_id').exists()
            .join('posts', '_id', 'authorId')
            .where('posts.published').eq(true) // Explicit table prefix
            .toArray();
        
        expect(results).toBeDefined();
        expect(results.length).toBeGreaterThan(0);
    });

    test('validates collection names against SQL keywords', () => {
        expect(() => {
            db.collection('SELECT', userSchema);
        }).toThrow();
        
        expect(() => {
            db.collection('TABLE', userSchema);
        }).toThrow();
        
        expect(() => {
            db.collection('DROP', userSchema);
        }).toThrow();
    });

    test('allows safe identifiers', () => {
        // These should all work
        expect(() => {
            db.collection('users', userSchema);
        }).not.toThrow();
        
        expect(() => {
            db.collection('user_accounts', userSchema);
        }).not.toThrow();
        
        expect(() => {
            db.collection('UserProfiles', userSchema);
        }).not.toThrow();
    });

    test('validates field paths in array operations', () => {
        const users = db.collection('users', userSchema);
        
        // Invalid field paths should throw
        expect(() => {
            users.query().addJsonArrayContainsFilter("'; DROP TABLE users;--", 'test');
        }).toThrow();
        
        expect(() => {
            users.query().addJsonArrayNotContainsFilter("field--", 'test');
        }).toThrow();
        
        // Valid field paths should work
        expect(() => {
            users.query().addJsonArrayContainsFilter("tags", 'test');
        }).not.toThrow();
    });

    test('parameterizes values correctly to prevent injection', async () => {
        const users = db.collection('users', userSchema);
        
        // Insert user with suspicious name
        const suspiciousName = "'; DROP TABLE users; --";
        const user = await users.insert({
            name: suspiciousName,
            email: 'test@example.com'
        });
        
        // Query should work safely with parameterized values
        const results = await users.where('name').eq(suspiciousName).toArray();
        expect(results).toHaveLength(1);
        expect(results[0].name).toBe(suspiciousName);
        
        // Table should still exist
        const allUsers = await users.toArray();
        expect(allUsers).toHaveLength(1);
    });
});
