import { describe, test, expect, beforeEach } from 'vitest';
import { z } from 'zod/v3';
import { createDB } from '../src/index.js';
import { unique, foreignKey, index } from '../src/schema-constraints.js';

const userSchema = z.object({
    _id: z.string().uuid(),
    name: z.string(),
    email: z.string().email(),
    age: z.number().int().optional(),
    isActive: z.boolean().default(true),
    tags: z.array(z.string()).default([]),
    createdAt: z.date().default(() => new Date()),
});

const postSchema = z.object({
    _id: z.string().uuid(),
    title: z.string(),
    content: z.string(),
    authorId: z.string().uuid(),
    publishedAt: z.date().optional(),
    viewCount: z.number().int().default(0),
});

const categorySchema = z.object({
    _id: z.string().uuid(),
    name: z.string(),
    description: z.string().optional(),
    parentId: z.string().uuid().optional(),
});

describe('Tables: skibbaDB API vs Raw SQL Verification', () => {
    let db: ReturnType<typeof createDB>;
    let users: ReturnType<typeof db.collection<typeof userSchema>>;
    let posts: ReturnType<typeof db.collection<typeof postSchema>>;
    let categories: ReturnType<typeof db.collection<typeof categorySchema>>;

    beforeEach(() => {
        db = createDB({ memory: true });

        users = db.collection('users', userSchema, {
            constrainedFields: {
                email: { unique: true, nullable: false },
                name: { type: 'TEXT' },
                age: { type: 'INTEGER' },
            },
            constraints: {
                indexes: {
                    name: index('name'),
                    age: index('age'),
                },
            },
        });

        posts = db.collection('posts', postSchema, {
            constrainedFields: {
                authorId: {
                    foreignKey: 'users._id',
                    onDelete: 'CASCADE',
                },
                title: { type: 'TEXT' },
                viewCount: { type: 'INTEGER' },
            },
            constraints: {
                indexes: {
                    title: index('title'),
                    viewCount: index('viewCount'),
                },
            },
        });

        categories = db.collection('categories', categorySchema, {
            constrainedFields: {
                parentId: {
                    foreignKey: 'categories._id',
                    onDelete: 'CASCADE',
                    nullable: true,
                },
                name: { type: 'TEXT' },
            },
            constraints: {
                indexes: {
                    name: index('name'),
                },
            },
        });
    });

    describe('Async Operations', () => {
        test('table creation and structure verification', async () => {
            // Check if tables were created
            const tables = await db.query(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
            );
            const tableNames = tables.map((row) => row.name);

            expect(tableNames).toContain('users');
            expect(tableNames).toContain('posts');
            expect(tableNames).toContain('categories');

            // Check users table structure (skibbaDB uses _id and doc columns + constrained fields)
            const usersColumns = await db.query('PRAGMA table_info(users)');
            const userColumnNames = usersColumns.map((col) => col.name);
            expect(userColumnNames).toContain('_id');
            expect(userColumnNames).toContain('doc');
            expect(userColumnNames).toContain('email'); // Constrained field
            expect(userColumnNames).toContain('name'); // Constrained field
            expect(userColumnNames).toContain('age'); // Constrained field

            // Check posts table structure
            const postsColumns = await db.query('PRAGMA table_info(posts)');
            const postColumnNames = postsColumns.map((col) => col.name);
            expect(postColumnNames).toContain('_id');
            expect(postColumnNames).toContain('doc');
            expect(postColumnNames).toContain('authorId'); // Constrained field
            expect(postColumnNames).toContain('title'); // Constrained field
            expect(postColumnNames).toContain('viewCount'); // Constrained field
        });

        test('indexes and constraints verification', async () => {
            // Check indexes - constrained fields should have indexes
            const indexes = await db.query(
                "SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"
            );
            const indexNames = indexes.map((idx) => idx.name);

            // Should have indexes for constrained fields
            expect(indexes.length).toBeGreaterThan(0);

            // Check foreign key constraints on constrained fields
            const postsForeignKeys = await db.query(
                'PRAGMA foreign_key_list(posts)'
            );
            expect(postsForeignKeys.length).toBeGreaterThan(0);
            expect(postsForeignKeys[0].table).toBe('users');
            expect(postsForeignKeys[0].from).toBe('authorId');
            expect(postsForeignKeys[0].to).toBe('_id');

            // Check categories foreign key constraint (self-referential)
            const categoriesForeignKeys = await db.query(
                'PRAGMA foreign_key_list(categories)'
            );
            expect(categoriesForeignKeys.length).toBeGreaterThan(0);
            expect(categoriesForeignKeys[0].table).toBe('categories');
            expect(categoriesForeignKeys[0].from).toBe('parentId');
            expect(categoriesForeignKeys[0].to).toBe('_id');
        });

        test('insert operations: API vs Raw SQL verification', async () => {
            // Insert using API
            const user = await users.insert({
                name: 'John Doe',
                email: 'john@example.com',
                age: 30,
                tags: ['developer', 'typescript'],
            });

            // Verify using raw SQL
            const rawUserRows = await db.query(
                'SELECT * FROM users WHERE _id = ?',
                [user._id]
            );
            expect(rawUserRows.length).toBe(1);

            const rawUser = rawUserRows[0];
            expect(rawUser._id).toBe(user._id);
            expect(rawUser.email).toBe('john@example.com'); // Constrained field

            // Check doc column contains the full document
            const parsedData = JSON.parse(rawUser.doc);
            expect(parsedData.name).toBe('John Doe');
            expect(parsedData.email).toBe('john@example.com');
            expect(parsedData.age).toBe(30);
            expect(parsedData.tags).toEqual(['developer', 'typescript']);
            expect(parsedData.isActive).toBe(true);
            expect(new Date(parsedData.createdAt)).toBeInstanceOf(Date);

            // Insert post referencing the user
            const post = await posts.insert({
                title: 'My First Post',
                content: 'Hello world!',
                authorId: user._id,
                viewCount: 5,
            });

            // Verify post using raw SQL
            const rawPostRows = await db.query(
                'SELECT * FROM posts WHERE _id = ?',
                [post._id]
            );
            expect(rawPostRows.length).toBe(1);

            const rawPost = rawPostRows[0];
            expect(rawPost.authorId).toBe(user._id); // Constrained field

            const parsedPostData = JSON.parse(rawPost.doc);
            expect(parsedPostData.title).toBe('My First Post');
            expect(parsedPostData.content).toBe('Hello world!');
            expect(parsedPostData.viewCount).toBe(5);
        });

        test('bulk insert operations verification', async () => {
            // Insert multiple users using API
            const userData = [
                { name: 'Alice', email: 'alice@example.com', age: 25 },
                { name: 'Bob', email: 'bob@example.com', age: 35 },
                { name: 'Carol', email: 'carol@example.com', age: 28 },
            ];

            const insertedUsers = await users.insertBulk(userData);
            expect(insertedUsers.length).toBe(3);

            // Verify count using raw SQL
            const countResult = await db.query(
                'SELECT COUNT(*) as count FROM users'
            );
            expect(countResult[0].count).toBe(3);

            // Verify all users exist using raw SQL
            const allUsersRaw = await db.query(
                'SELECT * FROM users ORDER BY name'
            );
            expect(allUsersRaw.length).toBe(3);

            // Verify the users using constrained field columns
            expect(allUsersRaw[0].name).toBe('Alice');
            expect(allUsersRaw[1].name).toBe('Bob');
            expect(allUsersRaw[2].name).toBe('Carol');

            // Verify data integrity
            for (let i = 0; i < allUsersRaw.length; i++) {
                const rawUser = allUsersRaw[i];
                const parsedData = JSON.parse(rawUser.doc);
                expect(parsedData.email).toBe(rawUser.email); // Constrained field matches
                expect(parsedData.name).toBe(rawUser.name); // Constrained field matches
                expect(parsedData.isActive).toBe(true);
            }
        });

        test('query operations: API vs Raw SQL verification', async () => {
            // Setup test data
            const testUsers = [
                {
                    name: 'Developer Dan',
                    email: 'dan@dev.com',
                    age: 30,
                    tags: ['javascript', 'python'],
                },
                {
                    name: 'Designer Dana',
                    email: 'dana@design.com',
                    age: 28,
                    tags: ['figma', 'sketch'],
                },
                {
                    name: 'Manager Mike',
                    email: 'mike@mgmt.com',
                    age: 45,
                    tags: ['leadership'],
                },
            ];

            const insertedUsers = await users.insertBulk(testUsers);

            // Test simple where query
            const developersAPI = await users
                .where('name')
                .like('Developer%')
                .toArray();
            const developersSQL = await db.query(
                "SELECT * FROM users WHERE name LIKE 'Developer%'"
            );

            expect(developersAPI.length).toBe(1);
            expect(developersSQL.length).toBe(1);
            expect(developersAPI[0].name).toBe(developersSQL[0].name);

            // Test age range query
            const youngUsersAPI = await users.where('age').lt(35).toArray();
            const youngUsersSQL = await db.query(
                'SELECT * FROM users WHERE age < 35'
            );

            expect(youngUsersAPI.length).toBe(2);
            expect(youngUsersSQL.length).toBe(2);

            // Test ordering
            const orderedAPI = await users.orderBy('age', 'desc').toArray();
            const orderedSQL = await db.query(
                'SELECT * FROM users ORDER BY age DESC'
            );

            expect(orderedAPI.length).toBe(3);
            expect(orderedSQL.length).toBe(3);
            expect(orderedAPI[0].age).toBe(45); // Manager Mike should be first
        });

        test('update operations: API vs Raw SQL verification', async () => {
            // Insert initial user
            const user = await users.insert({
                name: 'Test User',
                email: 'test@example.com',
                age: 25,
            });

            // Update using API
            const updatedUser = await users.put(user._id, {
                name: 'Updated User',
                age: 26,
            });

            expect(updatedUser.name).toBe('Updated User');
            expect(updatedUser.age).toBe(26);
            expect(updatedUser.email).toBe('test@example.com'); // Should remain unchanged

            // Verify using raw SQL
            const rawUserRows = await db.query(
                'SELECT * FROM users WHERE _id = ?',
                [user._id]
            );
            expect(rawUserRows.length).toBe(1);

            const rawUser = rawUserRows[0];
            const parsedData = JSON.parse(rawUser.doc);
            expect(parsedData.name).toBe('Updated User');
            expect(parsedData.age).toBe(26);
            expect(parsedData.email).toBe('test@example.com');

            // Verify constrained fields are updated
            expect(rawUser.name).toBe('Updated User');
            expect(rawUser.age).toBe(26);
        });

        test('delete operations: API vs Raw SQL verification', async () => {
            // Insert test users
            const users1 = await users.insert({
                name: 'User 1',
                email: 'user1@example.com',
            });
            const users2 = await users.insert({
                name: 'User 2',
                email: 'user2@example.com',
            });
            const users3 = await users.insert({
                name: 'User 3',
                email: 'user3@example.com',
            });

            // Verify initial count
            const initialCount = await db.query(
                'SELECT COUNT(*) as count FROM users'
            );
            expect(initialCount[0].count).toBe(3);

            // Delete one user using API
            const deleteResult = await users.delete(users2._id);
            expect(deleteResult).toBe(true);

            // Verify using raw SQL
            const remainingUsers = await db.query(
                'SELECT * FROM users ORDER BY name'
            );
            expect(remainingUsers.length).toBe(2);
            expect(remainingUsers[0].name).toBe('User 1');
            expect(remainingUsers[1].name).toBe('User 3');

            // Verify deleted user is gone
            const deletedUserRows = await db.query(
                'SELECT * FROM users WHERE _id = ?',
                [users2._id]
            );
            expect(deletedUserRows.length).toBe(0);
        });

        test('complex relationship queries', async () => {
            // Create users
            const author1 = await users.insert({
                name: 'Author 1',
                email: 'author1@example.com',
            });
            const author2 = await users.insert({
                name: 'Author 2',
                email: 'author2@example.com',
            });

            // Create posts
            const post1 = await posts.insert({
                title: 'Post by Author 1',
                content: 'Content 1',
                authorId: author1._id,
                viewCount: 10,
            });

            const post2 = await posts.insert({
                title: 'Another Post by Author 1',
                content: 'Content 2',
                authorId: author1._id,
                viewCount: 5,
            });

            const post3 = await posts.insert({
                title: 'Post by Author 2',
                content: 'Content 3',
                authorId: author2._id,
                viewCount: 15,
            });

            // Query posts by author using API
            const author1Posts = await posts
                .where('authorId')
                .eq(author1._id)
                .toArray();
            expect(author1Posts.length).toBe(2);

            // Query posts by author using raw SQL
            const author1PostsSQL = await db.query(
                'SELECT * FROM posts WHERE authorId = ?',
                [author1._id]
            );
            expect(author1PostsSQL.length).toBe(2);

            // Query high-view posts using API
            const popularPosts = await posts
                .where('viewCount')
                .gte(10)
                .toArray();
            expect(popularPosts.length).toBe(2);

            // Verify with raw SQL
            const popularPostsSQL = await db.query(
                'SELECT * FROM posts WHERE viewCount >= 10'
            );
            expect(popularPostsSQL.length).toBe(2);
        });
    });

    describe('Sync Operations', () => {
        test('table creation and structure verification (sync)', () => {
            // Check if tables were created
            const tables = db.querySync(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
            );
            const tableNames = tables.map((row) => row.name);

            expect(tableNames).toContain('users');
            expect(tableNames).toContain('posts');
            expect(tableNames).toContain('categories');

            // Check users table structure
            const usersColumns = db.querySync('PRAGMA table_info(users)');
            const userColumnNames = usersColumns.map((col) => col.name);
            expect(userColumnNames).toContain('_id');
            expect(userColumnNames).toContain('doc');
            expect(userColumnNames).toContain('email');
            expect(userColumnNames).toContain('name');
            expect(userColumnNames).toContain('age');
        });

        test('insert operations: sync API vs Raw SQL verification', () => {
            // Insert using sync API
            const user = users.insertSync({
                name: 'John Doe Sync',
                email: 'john.sync@example.com',
                age: 30,
                tags: ['developer', 'typescript'],
            });

            // Verify using raw SQL
            const rawUserRows = db.querySync(
                'SELECT * FROM users WHERE _id = ?',
                [user._id]
            );
            expect(rawUserRows.length).toBe(1);

            const rawUser = rawUserRows[0];
            expect(rawUser._id).toBe(user._id);
            expect(rawUser.email).toBe('john.sync@example.com');

            // Check doc column contains the full document
            const parsedData = JSON.parse(rawUser.doc);
            expect(parsedData.name).toBe('John Doe Sync');
            expect(parsedData.email).toBe('john.sync@example.com');
            expect(parsedData.age).toBe(30);
            expect(parsedData.isActive).toBe(true);
        });

        test('bulk insert operations verification (sync)', () => {
            // Insert multiple users using sync API
            const userData = [
                {
                    name: 'Alice Sync',
                    email: 'alice.sync@example.com',
                    age: 25,
                },
                { name: 'Bob Sync', email: 'bob.sync@example.com', age: 35 },
                {
                    name: 'Carol Sync',
                    email: 'carol.sync@example.com',
                    age: 28,
                },
            ];

            const insertedUsers = users.insertBulkSync(userData);
            expect(insertedUsers.length).toBe(3);

            // Verify count using raw SQL
            const countResult = db.querySync(
                'SELECT COUNT(*) as count FROM users'
            );
            expect(countResult[0].count).toBe(3);

            // Verify all users exist using raw SQL
            const allUsersRaw = db.querySync(
                'SELECT * FROM users ORDER BY name'
            );
            expect(allUsersRaw.length).toBe(3);
            expect(allUsersRaw[0].name).toBe('Alice Sync');
            expect(allUsersRaw[1].name).toBe('Bob Sync');
            expect(allUsersRaw[2].name).toBe('Carol Sync');
        });

        test('query operations: sync API vs Raw SQL verification', () => {
            // Setup test data
            const testUsers = [
                {
                    name: 'Developer Dan Sync',
                    email: 'dan.sync@dev.com',
                    age: 30,
                },
                {
                    name: 'Designer Dana Sync',
                    email: 'dana.sync@design.com',
                    age: 28,
                },
                {
                    name: 'Manager Mike Sync',
                    email: 'mike.sync@mgmt.com',
                    age: 45,
                },
            ];

            const insertedUsers = users.insertBulkSync(testUsers);

            // Test simple where query
            const developersAPI = users
                .where('name')
                .like('Developer%')
                .toArraySync();
            const developersSQL = db.querySync(
                "SELECT * FROM users WHERE name LIKE 'Developer%'"
            );

            expect(developersAPI.length).toBe(1);
            expect(developersSQL.length).toBe(1);
            expect(developersAPI[0].name).toBe(developersSQL[0].name);

            // Test age range query
            const youngUsersAPI = users.where('age').lt(35).toArraySync();
            const youngUsersSQL = db.querySync(
                'SELECT * FROM users WHERE age < 35'
            );

            expect(youngUsersAPI.length).toBe(2);
            expect(youngUsersSQL.length).toBe(2);

            // Test ordering
            const orderedAPI = users.orderBy('age', 'desc').toArraySync();
            const orderedSQL = db.querySync(
                'SELECT * FROM users ORDER BY age DESC'
            );

            expect(orderedAPI.length).toBe(3);
            expect(orderedSQL.length).toBe(3);
            expect(orderedAPI[0].age).toBe(45); // Manager Mike should be first
        });

        test('update operations: sync API vs Raw SQL verification', () => {
            // Insert initial user
            const user = users.insertSync({
                name: 'Test User Sync',
                email: 'test.sync@example.com',
                age: 25,
            });

            // Update using sync API
            const updatedUser = users.putSync(user._id, {
                name: 'Updated User Sync',
                age: 26,
            });

            expect(updatedUser.name).toBe('Updated User Sync');
            expect(updatedUser.age).toBe(26);
            expect(updatedUser.email).toBe('test.sync@example.com');

            // Verify using raw SQL
            const rawUserRows = db.querySync(
                'SELECT * FROM users WHERE _id = ?',
                [user._id]
            );
            expect(rawUserRows.length).toBe(1);

            const rawUser = rawUserRows[0];
            const parsedData = JSON.parse(rawUser.doc);
            expect(parsedData.name).toBe('Updated User Sync');
            expect(parsedData.age).toBe(26);
            expect(parsedData.email).toBe('test.sync@example.com');
        });

        test('delete operations: sync API vs Raw SQL verification', () => {
            // Insert test users
            const users1 = users.insertSync({
                name: 'User 1 Sync',
                email: 'user1.sync@example.com',
            });
            const users2 = users.insertSync({
                name: 'User 2 Sync',
                email: 'user2.sync@example.com',
            });
            const users3 = users.insertSync({
                name: 'User 3 Sync',
                email: 'user3.sync@example.com',
            });

            // Verify initial count
            const initialCount = db.querySync(
                'SELECT COUNT(*) as count FROM users'
            );
            expect(initialCount[0].count).toBe(3);

            // Delete one user using sync API
            const deleteResult = users.deleteSync(users2._id);
            expect(deleteResult).toBe(true);

            // Verify using raw SQL
            const remainingUsers = db.querySync(
                'SELECT * FROM users ORDER BY name'
            );
            expect(remainingUsers.length).toBe(2);
            expect(remainingUsers[0].name).toBe('User 1 Sync');
            expect(remainingUsers[1].name).toBe('User 3 Sync');
        });

        test('complex relationship queries (sync)', () => {
            // Create users
            const author1 = users.insertSync({
                name: 'Author 1 Sync',
                email: 'author1.sync@example.com',
            });
            const author2 = users.insertSync({
                name: 'Author 2 Sync',
                email: 'author2.sync@example.com',
            });

            // Create posts
            const post1 = posts.insertSync({
                title: 'Post by Author 1 Sync',
                content: 'Content 1',
                authorId: author1._id,
                viewCount: 10,
            });

            const post2 = posts.insertSync({
                title: 'Another Post by Author 1 Sync',
                content: 'Content 2',
                authorId: author1._id,
                viewCount: 5,
            });

            // Query posts by author using sync API
            const author1Posts = posts
                .where('authorId')
                .eq(author1._id)
                .toArraySync();
            expect(author1Posts.length).toBe(2);

            // Query posts by author using raw SQL
            const author1PostsSQL = db.querySync(
                'SELECT * FROM posts WHERE authorId = ?',
                [author1._id]
            );
            expect(author1PostsSQL.length).toBe(2);

            // Query high-view posts using sync API
            const popularPosts = posts.where('viewCount').gte(10).toArraySync();
            expect(popularPosts.length).toBe(1);

            // Verify with raw SQL
            const popularPostsSQL = db.querySync(
                'SELECT * FROM posts WHERE viewCount >= 10'
            );
            expect(popularPostsSQL.length).toBe(1);
        });
    });

    describe('Mixed Async/Sync Edge Cases', () => {
        test('concurrent operations and data consistency', async () => {
            // Insert using sync
            const syncUser = users.insertSync({
                name: 'Sync User',
                email: 'sync@example.com',
                age: 30,
            });

            // Insert using async
            const asyncUser = await users.insert({
                name: 'Async User',
                email: 'async@example.com',
                age: 25,
            });

            // Query using both methods should see both users
            const syncResults = users.toArraySync();
            const asyncResults = await users.toArray();

            expect(syncResults.length).toBe(2);
            expect(asyncResults.length).toBe(2);

            // Both should have the same data
            expect(syncResults).toEqual(asyncResults);
        });

        test('transaction behavior verification', async () => {
            // Test that operations are properly isolated
            const initialCount = await users.count();
            expect(initialCount).toBe(0);

            // Insert sync
            users.insertSync({ name: 'User 1', email: 'user1@example.com' });

            // Insert async
            await users.insert({ name: 'User 2', email: 'user2@example.com' });

            // Both sync and async count should see both records
            const syncCount = users.countSync();
            const asyncCount = await users.count();

            expect(syncCount).toBe(2);
            expect(asyncCount).toBe(2);
        });

        test('error handling consistency between sync and async', async () => {
            // Insert a user
            const user = users.insertSync({
                name: 'Test User',
                email: 'test@example.com',
            });

            // Try to insert duplicate email (should fail in both sync and async)
            expect(() => {
                users.insertSync({
                    name: 'Duplicate User',
                    email: 'test@example.com',
                });
            }).toThrow();

            // Async version should also fail
            await expect(
                users.insert({
                    name: 'Duplicate User Async',
                    email: 'test@example.com',
                })
            ).rejects.toThrow();
        });
    });
});
