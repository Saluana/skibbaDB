import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod/v3';
import { Database } from '../src/database';
import { ConnectionManager } from '../src/connection-manager';
import { detectDriver, getEnvironment } from '../src/driver-detector';
import type { DBConfig } from '../src/types';

// Detect if we're running in Node.js runtime
const isRunningInNode = () => {
    const env = getEnvironment();
    return env.runtime === 'node';
};

describe.skipIf(isRunningInNode())(
    'Driver Auto-Detection - Bun Runtime',
    () => {
        describe('Runtime Environment Detection', () => {
            it('should detect Bun runtime correctly', () => {
                const result = detectDriver();

                expect(result.recommendedDriver).toBe('bun');
                expect(result.environment.confidence).toBeGreaterThan(90);
                expect(result.environment.runtime).toBe('bun');
            });

            it('should create Database with auto-detected Bun driver', () => {
                const config: DBConfig = { path: ':memory:' };
                const db = new Database(config);

                expect(db).toBeDefined();
                db.close();
            });

            it('should respect explicit bun driver selection', () => {
                const config: DBConfig = {
                    driver: 'bun',
                    path: ':memory:',
                };

                const db = new Database(config);
                expect(db).toBeDefined();
                db.close();
            });

            it('should allow explicit node driver selection in Bun runtime', () => {
                const config: DBConfig = {
                    driver: 'node',
                    path: ':memory:',
                };

                // Node.js driver should work in Bun runtime (with warnings)
                const db = new Database(config);
                expect(db).toBeDefined();
                db.close();
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
            it('should support DATABASE_DRIVER=bun environment variable', () => {
                const originalEnv = process.env.DATABASE_DRIVER;
                process.env.DATABASE_DRIVER = 'bun';

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

            it('should allow DATABASE_DRIVER=node in Bun runtime', () => {
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
            it('should validate Bun driver capabilities', async () => {
                const config: DBConfig = { path: ':memory:' };
                const db = new Database(config);

                try {
                    // Test basic driver operations
                    const testSchema = z.object({
                        _id: z.string(),
                        name: z.string(),
                    });
                    const collection = db.collection('test', testSchema);

                    await collection.insert({ name: 'test' });
                    const results = await collection.all();
                    expect(results).toHaveLength(1);
                    expect(results[0].name).toBe('test');
                } finally {
                    db.close();
                }
            });

            it('should handle Bun-specific SQLite features', async () => {
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

                    // Insert multiple records to test Bun's performance
                    const insertPromises = Array.from({ length: 100 }, (_, i) =>
                        collection.insert({ data: `test-data-${i}` })
                    );

                    await Promise.all(insertPromises);
                    const results = await collection.all();
                    expect(results).toHaveLength(100);
                } finally {
                    db.close();
                }
            });

            it('should provide meaningful error messages for Bun driver failures', () => {
                const config: DBConfig = {
                    driver: 'bun',
                    path: '/invalid/path/that/cannot/be/created/database.db',
                };

                try {
                    const db = new Database(config);
                    // If we get here, close the database
                    db.close();
                } catch (error) {
                    expect(error instanceof Error).toBe(true);
                    expect((error as Error).message).toContain(
                        'Failed to initialize'
                    );
                }
            });
        });

        describe('ConnectionManager with Bun Driver', () => {
            it('should use Bun driver in ConnectionManager', async () => {
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

            it('should handle connection pooling with Bun driver', async () => {
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

        describe('Cross-Platform Compatibility in Bun', () => {
            it('should handle different path formats', () => {
                const configs = [
                    { path: ':memory:' },
                    { path: './test-db.db' },
                    { path: 'test-db.db' },
                ];

                configs.forEach((config) => {
                    const db = new Database(config);
                    expect(db).toBeDefined();
                    db.close();
                });
            });
        });

        describe('Performance and Memory Management', () => {
            it('should clean up Bun driver resources properly', async () => {
                const config: DBConfig = { path: ':memory:' };
                const db = new Database(config);

                try {
                    const testSchema = z.object({
                        _id: z.string(),
                    });
                    const collection = db.collection(
                        'cleanup_test',
                        testSchema
                    );
                    await collection.insert({ _id: 'test' });
                } finally {
                    db.close();
                }

                // After closing, subsequent operations should fail gracefully
                // Create a new database instance to test post-close behavior
                const db2 = new Database({ path: ':memory:' });
                const testSchema2 = z.object({
                    _id: z.string(),
                });
                const collection = db2.collection('cleanup_test', testSchema2);

                try {
                    await collection.insert({ _id: 'test2' });
                    // This should work since it's a new database instance
                    const results = await collection.all();
                    expect(results).toHaveLength(1);
                } finally {
                    db2.close();
                }
            });

            it('should handle multiple Bun database instances', () => {
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
            it('should provide Bun-specific debugging information', () => {
                const result = detectDriver();

                expect(result.diagnostics).toBeDefined();
                expect(result.diagnostics!.environment).toBeDefined();
                expect(result.diagnostics!.environment.runtime).toBe('bun');
                expect(result.diagnostics!.globals.hasBun).toBe(true);
            });

            it('should handle concurrent operations in Bun', async () => {
                const config: DBConfig = { path: ':memory:' };
                const db = new Database(config);

                try {
                    const concurrentSchema = z.object({
                        _id: z.string(),
                        value: z.number(),
                    });
                    const collection = db.collection(
                        'concurrent_test',
                        concurrentSchema
                    );

                    // Run concurrent inserts
                    const concurrentOps = Array.from({ length: 10 }, (_, i) =>
                        collection.insert({ value: i })
                    );

                    const results = await Promise.all(concurrentOps);
                    expect(results).toHaveLength(10);

                    const allRecords = await collection.all();
                    expect(allRecords).toHaveLength(10);
                } finally {
                    db.close();
                }
            });
        });

        describe('Bun-Specific Features', () => {
            it('should detect Bun globals correctly', () => {
                expect(typeof Bun).toBe('object');
                expect(Bun.version).toBeDefined();
            });

            it("should work with Bun's built-in SQLite", async () => {
                const config: DBConfig = { path: ':memory:' };
                const db = new Database(config);

                try {
                    // Test that we can use Bun's fast SQLite implementation
                    const bunSqliteSchema = z.object({
                        _id: z.string(),
                        timestamp: z.number(),
                    });
                    const collection = db.collection(
                        'bun_sqlite_test',
                        bunSqliteSchema
                    );

                    const startTime = Date.now();
                    await collection.insert({ timestamp: startTime });

                    const results = await collection.all();
                    expect(results).toHaveLength(1);
                    expect(results[0].timestamp).toBe(startTime);
                } finally {
                    db.close();
                }
            });
        });
    }
);
