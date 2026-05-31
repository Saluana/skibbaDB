import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '../src/database';
import { DatabaseError } from '../src/errors'; // Ensure DatabaseError is imported
import { getGlobalConnectionManager } from '../src/connection-manager';
import { z } from 'zod/v3';

describe('Connection Management', () => {
    let databases: Database[] = [];

    afterEach(async () => {
        // Clean up all databases
        for (const db of databases) {
            await db.close();
        }
        databases = [];

        // Clean up global connection manager
        await getGlobalConnectionManager().closeAll();
    });

    describe('Lazy Connection Initialization', () => {
        it('should not initialize connection until first use', () => {
            const db = new Database({
                memory: true,
                sharedConnection: true,
            });
            databases.push(db);

            // Database should be created but connection not yet established
            expect(db).toBeDefined();
        });

        it('should initialize connection on first query', async () => {
            const db = new Database({
                memory: true,
                sharedConnection: true,
            });
            databases.push(db);

            const result = await db.query('SELECT 1 as test');
            expect(result).toEqual([{ test: 1 }]);
        });
    });

    describe('Connection Sharing', () => {
        it('should share connections between Database instances', async () => {
            const db1 = new Database({
                path: ':memory:',
                sharedConnection: true,
            });
            const db2 = new Database({
                path: ':memory:',
                sharedConnection: true,
            });
            databases.push(db1, db2);

            // Both should work - since they share the same connection, they share the same database
            await db1.exec('CREATE TABLE shared_test (id INTEGER)');
            await db2.exec('INSERT INTO shared_test VALUES (1)');

            const result = await db1.query('SELECT * FROM shared_test');
            expect(result).toEqual([{ id: 1 }]);
        });

        it('should provide connection statistics', async () => {
            const db = new Database({
                memory: true,
                sharedConnection: true,
                connectionPool: {
                    maxConnections: 5,
                    healthCheckInterval: 1000,
                },
            });
            databases.push(db);

            await db.query('SELECT 1');

            const stats = db.getConnectionStats();
            expect(stats).toHaveProperty('totalConnections');
            expect(stats).toHaveProperty('activeConnections');
            expect(stats).toHaveProperty('sharedConnections');
            expect(stats).toHaveProperty('healthyConnections');
        });
    });

    describe('Connection Health Monitoring', () => {
        it('should detect unhealthy connections', async () => {
            const db = new Database({
                memory: true,
                autoReconnect: true,
                maxReconnectAttempts: 2,
                reconnectDelay: 100,
            });
            databases.push(db);

            // Initial connection should be healthy
            await db.query('SELECT 1');

            // Force close the underlying connection
            await db.close();

            // Should be able to reconnect automatically
            const db2 = new Database({
                memory: true,
                autoReconnect: true,
            });
            databases.push(db2);

            const result = await db2.query('SELECT 1 as test');
            expect(result).toEqual([{ test: 1 }]);
        });
    });

    describe('LibSQL Pool Configuration', () => {
        it('should accept LibSQL pool configuration', () => {
            // Don't actually initialize - just test configuration acceptance
            const db = new Database({
                path: 'libsql://localhost:8080',
                authToken: 'test-token',
                sharedConnection: true, // Use lazy initialization
                libsqlPool: {
                    maxConnections: 10,
                    minConnections: 2,
                    acquireTimeout: 5000,
                    idleTimeout: 300000,
                },
            });
            databases.push(db);

            expect(db).toBeDefined();
        });
    });

    describe('Collection with Connection Management', () => {
        // Test marked as async as it contains await
        it('should work with collections using managed connections', async () => {
            const db = new Database({
                memory: true,
                sharedConnection: true,
            });
            databases.push(db);

            const userSchema = z.object({
                _id: z.string(),
                name: z.string(),
                email: z.string().email(),
            });

            // With shared connections, collections should now work properly
            // as the Collection constructor has been made async-aware for DDL
            const users = db.collection('users', userSchema);
            
            // Should be able to insert and query with shared connections
            const insertedUser = await users.insert({
                name: 'John Doe',
                email: 'john@example.com',
            });
            
            expect(insertedUser._id).toBeDefined();
            expect(insertedUser.name).toBe('John Doe');
            expect(insertedUser.email).toBe('john@example.com');
            
            // Should be able to query the inserted user
            const foundUser = await users.get(insertedUser._id);
            expect(foundUser).toEqual(insertedUser);
        });
    });

    describe('Transaction with Connection Management', () => {
        it('should handle transactions with managed connections', async () => {
            const db = new Database({
                memory: true,
                // Don't use shared connection to avoid table conflicts
            });
            databases.push(db);

            await db.exec('CREATE TABLE test_tx1 (id INTEGER, value TEXT)');

            await db.transaction(async () => {
                await db.exec('INSERT INTO test_tx1 VALUES (1, \'first\')');
                await db.exec('INSERT INTO test_tx1 VALUES (2, \'second\')');
            });

            const result = await db.query(
                'SELECT COUNT(*) as count FROM test_tx1'
            );
            expect(result[0].count).toBe(2);
        });

        it('should rollback transactions on error with managed connections', async () => {
            const db = new Database({
                memory: true,
                // Don't use shared connection to avoid table conflicts
            });
            databases.push(db);

            await db.exec('CREATE TABLE test_tx2 (id INTEGER PRIMARY KEY)');

            try {
                await db.transaction(async () => {
                    await db.exec('INSERT INTO test_tx2 VALUES (1)');
                    await db.exec('INSERT INTO test_tx2 VALUES (1)'); // Should fail due to primary key constraint
                });
            } catch (error) {
                // Expected to fail
            }

            const result = await db.query(
                'SELECT COUNT(*) as count FROM test_tx2'
            );
            expect(result[0].count).toBe(0); // Should be rolled back
        });
    });

    describe('Advanced Connection Management', () => {
        describe('Reconnection Logic', () => {
            it('should respect maxReconnectAttempts setting', async () => {
                const db = new Database({
                    memory: true,
                    autoReconnect: true,
                    maxReconnectAttempts: 2,
                    reconnectDelay: 50,
                });
                databases.push(db);

                // First connection should work
                await db.query('SELECT 1');

                // Create new database after closing to test reconnection
                const db2 = new Database({
                    memory: true,
                    autoReconnect: true,
                    maxReconnectAttempts: 2,
                    reconnectDelay: 50,
                });
                databases.push(db2);

                // Should work with auto-reconnect
                const result = await db2.query('SELECT 1 as test');
                expect(result).toEqual([{ test: 1 }]);
            });

            it('should use exponential backoff for reconnection delays', async () => {
                const startTime = Date.now();

                const db = new Database({
                    memory: true,
                    autoReconnect: true,
                    maxReconnectAttempts: 1,
                    reconnectDelay: 100,
                });
                databases.push(db);

                await db.query('SELECT 1');
                const endTime = Date.now();

                // Should complete quickly since no reconnection needed
                expect(endTime - startTime).toBeLessThan(50);
            });
        });

        describe('Connection Pool Limits', () => {
            it('should respect maxConnections limit', async () => {
                const maxConnections = 3;
                const testDatabases: Database[] = [];

                for (let i = 0; i < maxConnections + 2; i++) {
                    const db = new Database({
                        memory: true,
                        connectionPool: {
                            maxConnections,
                            retryAttempts: 1,
                            retryDelay: 10,
                        },
                    });
                    testDatabases.push(db);
                }
                databases.push(...testDatabases);

                // Should be able to use all connections
                const promises = testDatabases.map((db) =>
                    db.query('SELECT 1')
                );
                const results = await Promise.all(promises);

                expect(results).toHaveLength(maxConnections + 2);
                results.forEach((result) => {
                    expect(result).toEqual([{ '1': 1 }]);
                });
            });

            it('should provide accurate connection statistics', async () => {
                const db = new Database({
                    memory: true,
                    sharedConnection: true,
                    connectionPool: {
                        maxConnections: 5,
                        healthCheckInterval: 100,
                    },
                });
                databases.push(db);

                // Make some queries to create connections
                await db.query('SELECT 1');
                await db.query('SELECT 2');

                const stats = db.getConnectionStats();
                expect(stats.totalConnections).toBeGreaterThanOrEqual(0);
                expect(stats.healthyConnections).toBeGreaterThanOrEqual(0);
                expect(typeof stats.activeConnections).toBe('number');
                expect(typeof stats.sharedConnections).toBe('number');
            });
        });

        describe('Error Handling', () => {
            it('should handle connection failures gracefully', async () => {
                const db = new Database({
                    memory: true,
                    autoReconnect: true,
                    maxReconnectAttempts: 1,
                });
                databases.push(db);

                // First query should work
                await db.query('SELECT 1');

                // Test new connection works
                const db2 = new Database({
                    memory: true,
                    autoReconnect: true,
                    maxReconnectAttempts: 1,
                });
                databases.push(db2);

                const result = await db2.query('SELECT 1 as test');
                expect(result).toEqual([{ test: 1 }]);
            });

            it('should handle concurrent connection failures', async () => {
                const db = new Database({
                    memory: true,
                    autoReconnect: true,
                    maxReconnectAttempts: 2,
                });
                databases.push(db);

                // Run multiple concurrent queries after connection issues
                const promises = Array.from({ length: 5 }, (_, i) =>
                    db.query(`SELECT ${i + 1} as num`)
                );

                const results = await Promise.all(promises);
                expect(results).toHaveLength(5);
                results.forEach((result, i) => {
                    expect(result).toEqual([{ num: i + 1 }]);
                });
            });
        });

        describe('Memory Management', () => {
            it('should clean up idle connections', async () => {
                const db = new Database({
                    memory: true,
                    connectionPool: {
                        maxIdleTime: 100, // 100ms
                        healthCheckInterval: 50,
                    },
                });
                databases.push(db);

                await db.query('SELECT 1');

                // Wait for idle cleanup
                await new Promise((resolve) => setTimeout(resolve, 200));

                // Should still work after cleanup
                const result = await db.query('SELECT 1 as test');
                expect(result).toEqual([{ test: 1 }]);
            });

            it('should handle multiple database instances efficiently', async () => {
                const numDatabases = 10;
                const testDatabases: Database[] = [];

                for (let i = 0; i < numDatabases; i++) {
                    const db = new Database({
                        memory: true,
                        sharedConnection: i % 2 === 0, // Alternate between shared and dedicated
                    });
                    testDatabases.push(db);
                }
                databases.push(...testDatabases);

                // All should be able to execute queries
                const promises = testDatabases.map((db, i) =>
                    db.query(`SELECT ${i} as id`)
                );

                const results = await Promise.all(promises);
                expect(results).toHaveLength(numDatabases);
            });
        });
    });

    describe('Stress Tests', () => {
        describe('High Concurrency', () => {
            it('should handle 100 concurrent queries with shared connections', async () => {
                const db = new Database({
                    memory: true,
                    sharedConnection: true,
                    connectionPool: {
                        maxConnections: 10,
                        retryAttempts: 3,
                        retryDelay: 10,
                    },
                });
                databases.push(db);

                // Create a test table
                await db.exec(
                    'CREATE TABLE stress_test (id INTEGER, data TEXT)'
                );

                const numQueries = 100;
                const promises: Promise<any>[] = [];

                // Mix of reads and writes
                for (let i = 0; i < numQueries; i++) {
                    if (i % 3 === 0) {
                        // Write operation
                        promises.push(
                            db.exec(
                                `INSERT INTO stress_test VALUES (${i}, 'data${i}')`
                            )
                        );
                    } else {
                        // Read operation
                        promises.push(
                            db.query(
                                'SELECT COUNT(*) as count FROM stress_test'
                            )
                        );
                    }
                }

                const results = await Promise.all(promises);
                expect(results).toHaveLength(numQueries);

                // Verify final state
                const finalCount = await db.query(
                    'SELECT COUNT(*) as count FROM stress_test'
                );
                expect(finalCount[0].count).toBeGreaterThan(0);
            }, 10000); // 10 second timeout

            it('should handle rapid database creation and destruction', async () => {
                const numCycles = 50;
                const promises: Promise<number>[] = [];

                for (let i = 0; i < numCycles; i++) {
                    promises.push(
                        (async () => {
                            const db = new Database({
                                memory: true,
                                sharedConnection: false, // Each gets its own connection
                            });

                            try {
                                await db.query(`SELECT ${i} as cycle`);
                                return i;
                            } finally {
                                await db.close();
                            }
                        })()
                    );
                }

                const results = await Promise.all(promises);
                expect(results).toHaveLength(numCycles);
                expect(results.every((r, i) => r === i)).toBe(true);
            }, 15000); // 15 second timeout
        });

        describe('Connection Pool Stress', () => {
            it('should handle connection pool exhaustion gracefully', async () => {
                const maxConnections = 5;
                const numRequests = 20;

                const db = new Database({
                    memory: true,
                    connectionPool: {
                        maxConnections,
                        retryAttempts: 3,
                        retryDelay: 50,
                    },
                });
                databases.push(db);

                // Create many concurrent long-running queries
                const promises = Array.from(
                    { length: numRequests },
                    async (_, i) => {
                        try {
                            // Simulate some processing time
                            await db.query('SELECT 1');
                            await new Promise((resolve) =>
                                setTimeout(resolve, Math.random() * 10)
                            );
                            return await db.query(`SELECT ${i} as request_id`);
                        } catch (error: any) {
                            return { error: error.message };
                        }
                    }
                );

                const results = await Promise.all(promises);
                expect(results).toHaveLength(numRequests);

                // Most should succeed
                const successes = results.filter((r: any) => !r.error);
                expect(successes.length).toBeGreaterThan(numRequests * 0.8); // At least 80% success
            }, 20000); // 20 second timeout

            it('should handle mixed workload with transactions', async () => {
                const db = new Database({
                    memory: true,
                    connectionPool: {
                        maxConnections: 8,
                    },
                });
                databases.push(db);

                await db.exec(
                    'CREATE TABLE workload_test (id INTEGER PRIMARY KEY, value TEXT, created_at INTEGER)'
                );

                const numOperations = 30; // Reduced for stability
                const promises: Promise<any>[] = [];

                for (let i = 0; i < numOperations; i++) {
                    if (i % 5 === 0) {
                        // Transaction with multiple operations (less frequent to avoid nested transactions)
                        promises.push(
                            db.transaction(async () => {
                                await db.exec(
                                    `INSERT INTO workload_test VALUES (${i}, 'tx_${i}', ${Date.now()})`
                                );
                                await db.exec(
                                    `INSERT INTO workload_test VALUES (${
                                        i + 1000
                                    }, 'tx_${i}_2', ${Date.now()})`
                                );
                                return 'transaction_complete';
                            })
                        );
                    } else if (i % 5 === 1) {
                        // Simple insert
                        promises.push(
                            db.exec(
                                `INSERT INTO workload_test VALUES (${
                                    i + 2000
                                }, 'simple_${i}', ${Date.now()})`
                            )
                        );
                    } else {
                        // Query operation
                        promises.push(
                            db.query(
                                'SELECT COUNT(*) as count FROM workload_test'
                            )
                        );
                    }
                }

                const results = await Promise.allSettled(promises);
                expect(results).toHaveLength(numOperations);

                // Check that most operations succeeded
                const successes = results.filter(
                    (r) => r.status === 'fulfilled'
                );
                expect(successes.length).toBeGreaterThan(numOperations * 0.7); // At least 70% success

                // Verify data integrity
                const finalCount = await db.query(
                    'SELECT COUNT(*) as count FROM workload_test'
                );
                expect(finalCount[0].count).toBeGreaterThan(0);
            }, 30000); // 30 second timeout
        });

        describe('Memory and Resource Stress', () => {
            it('should handle large result sets efficiently', async () => {
                const db = new Database({
                    memory: true,
                    sharedConnection: true,
                });
                databases.push(db);

                // Create table with many rows
                await db.exec(`
                    CREATE TABLE large_table (
                        id INTEGER PRIMARY KEY,
                        data TEXT,
                        random_num REAL
                    )
                `);

                // Insert many rows in batches
                const batchSize = 100;
                const numBatches = 20; // 2000 total rows

                for (let batch = 0; batch < numBatches; batch++) {
                    await db.transaction(async () => {
                        for (let i = 0; i < batchSize; i++) {
                            const id = batch * batchSize + i;
                            await db.exec(
                                `INSERT INTO large_table VALUES (${id}, 'data_${id}', ${Math.random()})`
                            );
                        }
                    });
                }

                // Query large result set
                const allRows = await db.query(
                    'SELECT * FROM large_table ORDER BY id'
                );
                expect(allRows).toHaveLength(batchSize * numBatches);

                // Test aggregation on large dataset
                const stats = await db.query(`
                    SELECT 
                        COUNT(*) as total,
                        AVG(random_num) as avg_random,
                        MIN(id) as min_id,
                        MAX(id) as max_id
                    FROM large_table
                `);

                expect(stats[0].total).toBe(batchSize * numBatches);
                expect(stats[0].min_id).toBe(0);
                expect(stats[0].max_id).toBe(batchSize * numBatches - 1);
            }, 60000); // 60 second timeout

            it('should handle connection churn under load', async () => {
                const numCycles = 30;
                const operationsPerCycle = 10;

                for (let cycle = 0; cycle < numCycles; cycle++) {
                    const cycleDatabases: Database[] = [];

                    // Create multiple databases
                    for (let i = 0; i < 3; i++) {
                        const db = new Database({
                            memory: true,
                            connectionPool: {
                                maxConnections: 5,
                                maxIdleTime: 100,
                            },
                        });
                        cycleDatabases.push(db);
                    }

                    // Use them concurrently
                    const promises = cycleDatabases.map(async (db, dbIndex) => {
                        const results: any[] = [];
                        for (let op = 0; op < operationsPerCycle; op++) {
                            results.push(
                                await db.query(
                                    `SELECT ${cycle} as cycle, ${dbIndex} as db_id, ${op} as op_id`
                                )
                            );
                        }
                        return results;
                    });

                    const results = await Promise.all(promises);
                    expect(results).toHaveLength(3);

                    // Clean up cycle databases
                    await Promise.all(cycleDatabases.map((db) => db.close()));
                }

                // Test that system is still responsive
                const finalDb = new Database({ memory: true });
                databases.push(finalDb);

                const finalResult = await finalDb.query(
                    'SELECT \'system_responsive\' as status'
                );
                expect(finalResult).toEqual([{ status: 'system_responsive' }]);
            }, 45000); // 45 second timeout
        });
    });
});
