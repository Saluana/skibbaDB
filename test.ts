import { z } from 'zod/v3';
import { createDB } from './index';

const main = async () => {
    // Define your schema
    const userSchema = z.object({
        id: z.string().uuid(),
        name: z.string(),
        email: z.string().email(),
        meta: z
            .object({
                bio: z.string().optional(),
                swag: z.boolean().optional(),
            })
            .optional(),
    });

    // Create database with dual-storage optimization
    const db = createDB({ path: './db' }); // or { path: 'mydb.db' }
    const users = db.collection('users', userSchema, {
        // Constrained fields get dedicated columns + indexes
        constrainedFields: {
            name: { unique: true, nullable: false },
            email: { unique: true, nullable: false },
        },
        indexes: ['name', 'email'],
    });

    // Same NoSQL API, optimized performance
    const user = await users.insert({
        name: 'Alice Johnson',
        email: 'alice@example.com',
        meta: {
            bio: 'Software Engineer',
            swag: true,
        },
    });

    // Queries automatically use best access method
    const alice = await users.where('email').eq('alice@example.com').first(); // Uses column index (fast!)

    console.log('Alice:', alice);

    // 🚀 Async by Default (non-blocking operations)
    const results = await users
        .where('meta.bio')
        .contains('Engineer')
        .toArray();

    const newUser = await users.insert({
        name: 'New Employee',
        email: 'new@example.com',
    });

    // Sync versions available with 'Sync' suffix
    const syncResults = users.where('meta.swag').eq(true).toArraySync();

    console.log('Results:', results);
    console.log('New user:', newUser);
    console.log('Sync results:', syncResults);
};

main().catch((error) => {
    console.error('Error:', error);
});
