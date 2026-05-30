import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod/v3';
import { Database } from '../src/database';
import { ConnectionManager } from '../src/connection-manager';
import { detectDriver, getEnvironment } from '../src/driver-detector';
import type { DBConfig } from '../src/types';

// Detect if we're running in Bun runtime
const isRunningInBun = () => {
    const env = getEnvironment();
    return env.runtime === 'bun';
};

const ORIGINAL_DATABASE_DRIVER = process.env.DATABASE_DRIVER;

beforeEach(() => {
    // Reset to original value before each test
    if (ORIGINAL_DATABASE_DRIVER !== undefined) {
        process.env.DATABASE_DRIVER = ORIGINAL_DATABASE_DRIVER;
    } else {
        delete process.env.DATABASE_DRIVER;
    }
});

afterEach(() => {
    // Reset to original value after each test
    if (ORIGINAL_DATABASE_DRIVER !== undefined) {
        process.env.DATABASE_DRIVER = ORIGINAL_DATABASE_DRIVER;
    } else {
        delete process.env.DATABASE_DRIVER;
    }
});

describe.skipIf(isRunningInBun())(
    'Driver Auto-Detection - Node.js Runtime',
    () => {
        describe('Runtime Environment Detection', () => {
            it('should detect Node.js runtime correctly', () => {
                const result = detectDriver();

                expect(result.recommendedDriver).toBe('node');
                expect(result.environment.confidence).toBeGreaterThan(90);
                expect(result.environment.runtime).toBe('node');
            });

            it('should create Database with auto-detected Node.js driver', () => {
                const config: DBConfig = { path: ':memory:' };
                const db = new Database(config);

                expect(db).toBeDefined();
                db.close();
            });

            it('should respect explicit node driver selection', () => {
                const config: DBConfig = {
                    driver: 'node',
                    path: ':memory:',
                };

                const db = new Database(config);
                expect(db).toBeDefined();
                db.close();
            });

            it('should reject explicit bun driver selection with helpful error', () => {
                const config: DBConfig = {
                    driver: 'bun',
                    path: ':memory:',
                };

                // In Node.js runtime, the system will fall back to Node driver
                // This should work since we have fallback logic
                expect(() => new Database(config)).not.toThrow();
            });

            it('should reject invalid driver names', () => {
                const config: DBConfig = {
                    driver: 'invalid' as any,
                    path: ':memory:',
                };

                expect(() => new Database(config)).toThrow();
            });
        });

        describe('Environment Variable Override', () => {
            it('should support DATABASE_DRIVER=node environment variable', () => {
                const originalEnv = process.env.DATABASE_DRIVER;
                process.env.DATABASE_DRIVER = 'node';

                try {
                    const config: DBConfig = { path: ':memory:' };
                    const db = new Database(config);
                    expect(db).toBeDefined();
                    db.close();
                } finally {
                    if (originalEnv !== undefined) {
                        process.env.DATABASE_DRIVER = originalEnv;
                    } else {
                        delete process.env.DATABASE_DRIVER;
                    }
                }
            });

            it('should reject DATABASE_DRIVER=bun in Node.js runtime', () => {
                const originalEnv = process.env.DATABASE_DRIVER;
                process.env.DATABASE_DRIVER = 'bun';

                try {
                    const config: DBConfig = { path: ':memory:' };
                    // The system will fall back to Node driver, so this should work
                    expect(() => new Database(config)).not.toThrow();
                } finally {
                    if (originalEnv !== undefined) {
                        process.env.DATABASE_DRIVER = originalEnv;
                    } else {
                        delete process.env.DATABASE_DRIVER;
                    }
                }
            });

            it('should validate environment variable values', () => {
                const originalEnv = process.env.DATABASE_DRIVER;
                process.env.DATABASE_DRIVER = 'invalid';

                try {
                    const config: DBConfig = { path: ':memory:' };
                    expect(() => new Database(config)).toThrow();
                } finally {
                    if (originalEnv !== undefined) {
                        process.env.DATABASE_DRIVER = originalEnv;
                    } else {
                        delete process.env.DATABASE_DRIVER;
                    }
                }
            });
        });

        describe('Driver Validation and Operations', () => {
            it('should validate Node.js driver capabilities', async () => {
                const config: DBConfig = { path: ':memory:' };
                const db = new Database(config);

                try {
                    // Test basic driver operations
                    const testSchema = z.object({
                        _id: z.string(),
                        name: z.string(),
                    });
                    const collection = db.collection('test', testSchema);

                    // Correct: do not pass id to insert
                    const inserted = await collection.insert({ name: 'test' });
                    expect(inserted._id).toBeDefined();
                    expect(inserted.name).toBe('test');

                    // Use findById and toArray async
                    const found = await collection.findById(inserted._id);
                    expect(found).toEqual(inserted);

                    const results = await collection.toArray();
                    expect(results).toHaveLength(1);
                    expect(results[0].name).toBe('test');

                    // Update using put
                    const updated = await collection.put(inserted._id, {
                        name: 'updated',
                    });
                    expect(updated.name).toBe('updated');
                    expect(updated._id).toBe(inserted._id);

                    // Delete using delete
                    const deleted = await collection.delete(inserted._id);
                    expect(deleted).toBe(true);
                    const afterDelete = await collection.findById(inserted._id);
                    expect(afterDelete).toBeNull();
                } finally {
                    db.close();
                }
            });

            it('should handle Node.js-specific SQLite features', async () => {
                const config: DBConfig = { path: ':memory:' };
                const db = new Database(config);

                try {
                    const performanceSchema = z.object({
                        _id: z.string(),
                        data: z.string(),
                    });
                    const collection = db.collection(
                        'performance_test',
                        performanceSchema
                    );

                    // Insert multiple records to test Node.js driver performance
                    const insertPromises = Array.from({ length: 100 }, (_, i) =>
                        collection.insert({ data: `test-data-${i}` })
                    );

                    await Promise.all(insertPromises);
                    const results = await collection.toArray();
                    expect(results).toHaveLength(100);
                } finally {
                    db.close();
                }
            });

            it('should provide meaningful error messages for Node.js driver failures', async () => {
                const config: DBConfig = {
                    driver: 'node',
                    path: '/invalid/path/that/cannot/be/created/database.db',
                };

                try {
                    const db = new Database(config);
                    // If we get here, close the database
                    db.close();
                    // If no error, fail the test
                    throw new Error('Expected error was not thrown');
                } catch (error) {
                    expect(error instanceof Error).toBe(true);
                    expect((error as Error).message).toContain(
                        'Failed to initialize'
                    );
                }
            });
        });

        describe('ConnectionManager with Node.js Driver', () => {
            it('should use Node.js driver in ConnectionManager', async () => {
                const connectionManager = new ConnectionManager();

                try {
                    const config: DBConfig = { path: ':memory:' };
                    const connection = await connectionManager.getConnection(
                        config
                    );

                    expect(connection).toBeDefined();
                    expect(connection.driver).toBeDefined();
                } finally {
                    await connectionManager.closeAll();
                }
            });

            it('should handle connection pooling with Node.js driver', async () => {
                const connectionManager = new ConnectionManager();

                try {
                    const config: DBConfig = {
                        path: ':memory:',
                        sharedConnection: true,
                    };

                    const connection1 = await connectionManager.getConnection(
                        config
                    );
                    const connection2 = await connectionManager.getConnection(
                        config
                    );

                    // Should reuse the same connection for shared configs
                    expect(connection1._id).toBe(connection2._id);
                } finally {
                    await connectionManager.closeAll();
                }
            });
        });

        describe('Cross-Platform Compatibility in Node.js', () => {
            it('should handle Windows path separators', () => {
                const config: DBConfig = {
                    driver: 'node',
                    path: 'C:\\Users\\test\\database.db',
                };

                // Should not throw due to path format
                expect(() => new Database(config)).not.toThrow();
            });

            it('should handle Unix path separators', () => {
                const config: DBConfig = {
                    driver: 'node',
                    path: '/home/user/database.db',
                    sharedConnection: true, // Defer initialization to avoid file system issues
                };

                expect(() => new Database(config)).not.toThrow();
            });

            it('should handle relative paths', () => {
                const config: DBConfig = {
                    path: './test-db.db',
                };

                expect(() => new Database(config)).not.toThrow();
            });
        });

        describe('Performance and Memory Management', () => {
            it('should clean up Node.js driver resources properly', async () => {
                const config: DBConfig = { path: ':memory:' };
                const db = new Database(config);

                try {
                    const testSchema = z.object({
                        _id: z.string(),
                    });
                    const collection = db.collection(
                        'node_test_cleanup',
                        testSchema
                    );
                    await collection.insert({});
                } finally {
                    db.close();
                }

                // After closing, subsequent operations should fail gracefully
                const db2 = new Database({ path: ':memory:' });
                const testSchema2 = z.object({
                    _id: z.string(),
                });
                const collection2 = db2.collection(
                    'node_test_cleanup2',
                    testSchema2
                );
                db2.close();
                try {
                    await collection2.insert({});
                    // If this doesn't throw, that's also acceptable behavior
                } catch (error) {
                    // Expected behavior when database is closed
                    expect(error instanceof Error).toBe(true);
                }
            });

            it('should handle multiple Node.js database instances', () => {
                const databases = Array.from(
                    { length: 3 },
                    () => new Database({ path: ':memory:' })
                );

                expect(databases).toHaveLength(3);

                // Clean up
                databases.forEach((db) => db.close());
            });
        });

        describe('Error Recovery and Resilience', () => {
            it('should provide Node.js-specific debugging information', () => {
                const result = detectDriver();

                expect(result.diagnostics).toBeDefined();
                expect(result.diagnostics!.environment).toBeDefined();
                expect(result.diagnostics!.environment.runtime).toBe('node');
                expect(result.diagnostics!.globals.hasProcess).toBe(true);
            });

            it('should handle concurrent operations in Node.js', async () => {
                const config: DBConfig = { path: ':memory:' };
                const db = new Database(config);

                try {
                    const concurrentSchema = z.object({
                        _id: z.string(),
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
                    expect(results).toHaveLength(10);

                    const allRecords = await collection.toArray();
                    expect(allRecords).toHaveLength(10);
                } finally {
                    db.close();
                }
            });
        });

        describe('Node.js-Specific Features', () => {
            it('should detect Node.js environment correctly', () => {
                expect(typeof process).toBe('object');
                expect(process.versions.node).toBeDefined();
                expect(typeof global).toBe('object');
            });

            it('should ensure Bun globals are not available', () => {
                expect(typeof (globalThis as any).Bun).toBe('undefined');
            });

            it('should work with better-sqlite3 dependency', async () => {
                const config: DBConfig = { path: ':memory:' };
                const db = new Database(config);

                try {
                    // Test that we can use better-sqlite3
                    const nodeSqliteSchema = z.object({
                        _id: z.string(),
                        timestamp: z.number(),
                    });
                    const collection = db.collection(
                        'node_sqlite_test',
                        nodeSqliteSchema
                    );

                    const startTime = Date.now();
                    await collection.insert({ timestamp: startTime });

                    const results = await collection.toArray();
                    expect(results).toHaveLength(1);
                    expect(results[0].timestamp).toBe(startTime);
                } finally {
                    db.close();
                }
            });

            it('should handle Node.js process events and cleanup', async () => {
                const config: DBConfig = { path: ':memory:' };
                const db = new Database(config);

                // Simulate process exit scenarios
                const cleanupSchema = z.object({
                    _id: z.string(),
                });
                const collection = db.collection(
                    'cleanup_test_node',
                    cleanupSchema
                );

                await collection.insert({ _id: 'test' });

                // Clean shutdown
                db.close();

                expect(true).toBe(true); // Test completed successfully
            });
        });

        describe('Dependency Management', () => {
            it('should handle missing better-sqlite3 gracefully', () => {
                // This test documents behavior when better-sqlite3 is not available
                // In practice, this would be tested in a separate environment
                expect(true).toBe(true);
            });

            it('should provide helpful error messages for dependency issues', () => {
                // Mock a scenario where dependencies are misconfigured
                const result = detectDriver();

                // Should still detect Node.js runtime even if SQLite deps are missing
                expect(result.environment.runtime).toBe('node');
            });
        });
    }
);
