#!/usr/bin/env tsx

console.log('Starting test...');

import { createDB } from './src/index.js';
import { z } from 'zod/v3';

console.log('Imports successful, testing database initialization...');

async function testDatabase() {
    try {
        // Detect runtime and test appropriate driver
        const isBun = typeof Bun !== 'undefined';
        const driver = isBun ? 'bun' : 'node';
        
        console.log(`\n🟡 Testing with ${driver} driver...`);
        const db = createDB({ path: ':memory:', driver });
        console.log(`✅ ${driver} database created successfully`);

        const schema = z.object({
            _id: z.string().optional(),
            title: z.string(),
            completed: z.boolean().default(false),
        });

        const collection = db.collection('test', schema);
        console.log(`✅ ${driver} collection created successfully`);

        await collection.insert({ title: `${driver} test todo`, completed: false });
        console.log(`✅ ${driver} insert successful`);

        const todos = await collection.toArray();
        console.log(`✅ ${driver} query successful:`, todos);

        console.log(`\n🎉 ${driver} database test completed successfully!`);
    } catch (error) {
        console.error('❌ Database test failed:', error);
        process.exit(1);
    }
}

testDatabase();
