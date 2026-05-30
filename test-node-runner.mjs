// Node.js driver auto-detection tests using Node.js built-in test runner
import { test } from 'node:test';
import assert from 'node:assert';
import { z } from 'zod/v3';
import { Database } from './test-compiled/src/database.js';
import { ConnectionManager } from './test-compiled/src/connection-manager.js';
import { detectDriver } from './test-compiled/src/driver-detector.js';

console.log('Running Node.js driver auto-detection tests...');

test('should detect Node.js runtime correctly', () => {
    const result = detectDriver();

    assert.strictEqual(result.recommendedDriver, 'node');
    assert(result.environment.confidence > 90);
    assert.strictEqual(result.environment.runtime, 'node');
});

test('should create Database with auto-detected Node.js driver', () => {
    const config = { path: ':memory:' };
    const db = new Database(config);

    assert(db);
    db.close();
});

test('should respect explicit node driver selection', () => {
    const config = {
        driver: 'node',
        path: ':memory:',
    };

    const db = new Database(config);
    assert(db);
    db.close();
});

test('should validate Node.js driver capabilities', async () => {
    const config = { path: ':memory:' };
    const db = new Database(config);

    try {
        // Test basic driver operations
        const testSchema = z.object({
            id: z.string(),
            name: z.string(),
        });
        const collection = db.collection('test', testSchema);

        // Test insert (correct API - do not pass id)
        const inserted = await collection.insert({ name: 'test' });
        assert(inserted.id);
        assert.strictEqual(inserted.name, 'test');

        // Test findById
        const found = await collection.findById(inserted.id);
        assert.deepStrictEqual(found, inserted);

        // Test toArray
        const results = await collection.toArray();
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].name, 'test');

        // Test update using put
        const updated = await collection.put(inserted.id, {
            name: 'updated',
        });
        assert.strictEqual(updated.name, 'updated');
        assert.strictEqual(updated.id, inserted.id);

        // Test delete
        const deleted = await collection.delete(inserted.id);
        assert.strictEqual(deleted, true);

        const afterDelete = await collection.findById(inserted.id);
        assert.strictEqual(afterDelete, null);
    } finally {
        db.close();
    }
});

test('should handle ConnectionManager with Node.js driver', async () => {
    const connectionManager = new ConnectionManager();

    try {
        const config = { path: ':memory:' };
        const connection = await connectionManager.getConnection(config);

        assert(connection);
        assert(connection.driver);
    } finally {
        await connectionManager.closeAll();
    }
});

test('should provide Node.js-specific debugging information', () => {
    const result = detectDriver();

    assert(result.diagnostics);
    assert(result.diagnostics.environment);
    assert.strictEqual(result.diagnostics.environment.runtime, 'node');
    assert.strictEqual(result.diagnostics.globals.hasProcess, true);
});

test('should handle concurrent operations in Node.js', async () => {
    const config = { path: ':memory:' };
    const db = new Database(config);

    try {
        const concurrentSchema = z.object({
            id: z.string(),
            value: z.number(),
        });
        const collection = db.collection(
            'concurrent_test_node',
            concurrentSchema
        );

        // Run concurrent inserts
        const concurrentOps = Array.from({ length: 10 }, (_, i) =>
            collection.insert({ value: i })
        );

        const results = await Promise.all(concurrentOps);
        assert.strictEqual(results.length, 10);

        const allRecords = await collection.toArray();
        assert.strictEqual(allRecords.length, 10);
    } finally {
        db.close();
    }
});

test('should detect Node.js environment correctly', () => {
    assert.strictEqual(typeof process, 'object');
    assert(process.versions.node);
    assert.strictEqual(typeof global, 'object');
});

test('should ensure Bun globals are not available', () => {
    assert.strictEqual(typeof globalThis.Bun, 'undefined');
});

test('should work with better-sqlite3 dependency', async () => {
    const config = { path: ':memory:' };
    const db = new Database(config);

    try {
        const nodeSqliteSchema = z.object({
            id: z.string(),
            timestamp: z.number(),
        });
        const collection = db.collection('node_sqlite_test', nodeSqliteSchema);

        const startTime = Date.now();
        await collection.insert({ timestamp: startTime });

        const results = await collection.toArray();
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].timestamp, startTime);
    } finally {
        db.close();
    }
});
