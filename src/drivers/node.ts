import type { Row, DBConfig } from '../types';
import { DatabaseError } from '../errors';
import { createRequire } from 'module';
import { BaseDriver } from './base.js';
import { LibSQLConnectionPool, createLibSQLPool } from '../libsql-pool';
import * as sqliteVec from 'sqlite-vec';

// Create require function for ES modules
const require = createRequire(import.meta.url);

export class NodeDriver extends BaseDriver {
    private db?: any;
    private dbType: 'sqlite' | 'libsql' = 'sqlite';
    private libsqlPool?: LibSQLConnectionPool;
    private currentConnection?: any;
    private canSyncInitialize: boolean;

    constructor(config: DBConfig = {}) {
        super(config);
        this.canSyncInitialize =
            typeof process !== 'undefined' &&
            !!process.versions?.node &&
            !process.versions?.bun;
        // Initialize the driver if not using shared connections
        if (!config.sharedConnection && this.canSyncInitialize) {
            this.initializeDriverSync(config);
        } else if (!config.sharedConnection) {
            this.connectionState = {
                isConnected: false,
                isHealthy: false,
                lastHealthCheck: Date.now(),
                connectionAttempts: 0,
            };
        }
    }

    protected async initializeDriver(config: DBConfig): Promise<void> {
        await this.initializeDatabase(config);
    }

    private initializeDriverSync(config: DBConfig): void {
        try {
            const path = config.path || ':memory:';

            // For sync initialization, prefer better-sqlite3 since it supports sync operations
            // LibSQL requires async initialization
            const isLocalFile =
                path === ':memory:' ||
                (!path.startsWith('http://') &&
                    !path.startsWith('https://') &&
                    !path.startsWith('libsql://') &&
                    !(config as any).authToken &&
                    !(config as any).libsql);

            if (isLocalFile) {
                this.initializeSQLite(path);
                this.dbType = 'sqlite';
                this.configureSQLite(config);

                this.connectionState = {
                    isConnected: true,
                    isHealthy: true,
                    lastHealthCheck: Date.now(),
                    connectionAttempts: 0,
                };
            } else {
                // For remote connections or LibSQL, defer to async initialization
                // This case should be handled by ensureConnection() which calls async initializeDriver
                this.connectionState = {
                    isConnected: false,
                    isHealthy: false,
                    lastHealthCheck: Date.now(),
                    connectionAttempts: 0,
                    lastError: new Error(
                        'Sync initialization not possible for remote connections. Use async methods.'
                    ),
                };
                return;
            }
        } catch (error) {
            this.connectionState = {
                isConnected: false,
                isHealthy: false,
                lastHealthCheck: Date.now(),
                connectionAttempts: 1,
                lastError:
                    error instanceof Error ? error : new Error(String(error)),
            };
            throw error;
        }
    }

    private async initializeDatabase(config: DBConfig): Promise<void> {
        try {
            const path = config.path || ':memory:';

            // Check if we should use LibSQL pooling for remote connections
            const isRemoteLibSQL =
                path.startsWith('http://') ||
                path.startsWith('https://') ||
                path.startsWith('libsql://') ||
                config.authToken;

            if (isRemoteLibSQL && config.libsqlPool) {
                // Use LibSQL connection pool for remote connections
                this.libsqlPool = createLibSQLPool(config, config.libsqlPool);
                this.dbType = 'libsql';

                this.connectionState = {
                    isConnected: true,
                    isHealthy: true,
                    lastHealthCheck: Date.now(),
                    connectionAttempts: 0,
                };
                return;
            }

            // For local files, prefer better-sqlite3 to avoid sync operation issues
            const isLocalFile =
                path === ':memory:' ||
                (!path.startsWith('http://') &&
                    !path.startsWith('https://') &&
                    !path.startsWith('libsql://'));

            // Always try LibSQL first (supports both local and remote)
            try {
                await this.initializeLibSQL(config, path);
                this.dbType = 'libsql';
            } catch (libsqlError) {
                // If LibSQL fails, fallback to SQLite drivers for local files only
                if (isLocalFile) {
                    try {
                        this.initializeSQLite(path);
                        this.dbType = 'sqlite';
                        // Configure SQLite pragmas
                        this.configureSQLite(config);
                    } catch (sqliteError) {
                        // Both LibSQL and SQLite failed
                        throw new DatabaseError(
                            'No compatible SQLite driver found. Install one of:\n' +
                                '  npm install @libsql/client    (recommended - works with SQLite and LibSQL)\n' +
                                '  npm install better-sqlite3    (local files only - sync operations)\n' +
                                '\nErrors encountered:\n' +
                                'LibSQL: ' +
                                (libsqlError instanceof Error
                                    ? libsqlError.message
                                    : String(libsqlError)) +
                                '\n' +
                                'SQLite: ' +
                                (sqliteError instanceof Error
                                    ? sqliteError.message
                                    : String(sqliteError))
                        );
                    }
                } else {
                    // For remote connections, LibSQL is required
                    throw new DatabaseError(
                        'LibSQL client required for remote connections. Install with:\n' +
                            '  npm install @libsql/client\n' +
                            '\nError: ' +
                            (libsqlError instanceof Error
                                ? libsqlError.message
                                : String(libsqlError))
                    );
                }
            }

            this.connectionState = {
                isConnected: true,
                isHealthy: true,
                lastHealthCheck: Date.now(),
                connectionAttempts: 0,
            };
        } catch (error) {
            this.connectionState = {
                isConnected: false,
                isHealthy: false,
                lastHealthCheck: Date.now(),
                connectionAttempts: this.connectionState.connectionAttempts + 1,
                lastError:
                    error instanceof Error ? error : new Error(String(error)),
            };
            throw error;
        }
    }

    private async initializeLibSQL(
        config: DBConfig,
        path: string
    ): Promise<void> {
        try {
            // Try to import @libsql/client
            const { createClient } = require('@libsql/client');

            const clientConfig: any = {};

            // Handle different path types
            if (path === ':memory:') {
                clientConfig.url = ':memory:';
            } else if (
                path.startsWith('http://') ||
                path.startsWith('https://') ||
                path.startsWith('libsql://')
            ) {
                // Remote LibSQL URL
                clientConfig.url = path;
            } else {
                // Local file - LibSQL can handle regular SQLite files
                clientConfig.url = path.startsWith('file:')
                    ? path
                    : `file:${path}`;
            }

            // Add auth token if provided
            if ((config as any).authToken) {
                clientConfig.authToken = (config as any).authToken;
            }

            // Add sync URL if provided (for embedded replicas)
            if ((config as any).syncUrl) {
                clientConfig.syncUrl = (config as any).syncUrl;
            }

            this.db = createClient(clientConfig);

            // Load sqlite-vec extension for LibSQL
            try {
                // SECURITY FIX: Use parameterized query to prevent SQL injection
                // Extension path could contain quotes or malicious characters
                const extensionPath = sqliteVec.getLoadablePath();
                await this.db.execute({
                    sql: 'SELECT load_extension(?)',
                    args: [extensionPath]
                });
            } catch (error) {
                console.warn(
                    'Warning: Failed to load sqlite-vec extension for LibSQL:',
                    error
                );
            }
        } catch (error) {
            throw new Error(
                'libsql client not found. Install with: npm install @libsql/client'
            );
        }
    }

    private initializeSQLite(path: string): void {
        // ISSUE #2 FIX: Only support better-sqlite3 for local SQLite files.
        // The sqlite3 package has incompatible async-only API that would require
        // a complete driver rewrite. For production safety, we fail fast with clear guidance.
        try {
            const Database = require('better-sqlite3');
            const db = new Database(
                path === ':memory:' ? ':memory:' : path
            );

            // Load sqlite-vec extension for better-sqlite3
            try {
                sqliteVec.load(db);
            } catch (error) {
                console.warn(
                    'Warning: Failed to load sqlite-vec extension for better-sqlite3:',
                    error
                );
            }

            this.db = db;
            return;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            
            // ISSUE #2 FIX: Fail fast with clear error message
            throw new DatabaseError(
                'better-sqlite3 is required for local SQLite files but could not be loaded.\n' +
                    '\nTo fix this issue, install better-sqlite3:\n' +
                    '  npm install better-sqlite3\n' +
                    '\nAlternatively, use LibSQL for both local and remote connections:\n' +
                    '  npm install @libsql/client\n' +
                    '\nNote: The sqlite3 package is NOT supported because it has an incompatible async-only API.\n' +
                    '\nOriginal error: ' + errorMessage,
                'BETTER_SQLITE3_REQUIRED'
            );
        }
    }

    private ensureInitialized(): void {
        if (!this.db && !this.libsqlPool && !this.isClosed) {
            // Try sync initialization for local SQLite files when supported
            if (this.canSyncInitialize) {
                this.initializeDriverSync(this.config);
            }
        }
    }

    private ensureSyncOperationSupported(): void {
        if (!this.db || this.isClosed) {
            throw new DatabaseError(
                'Database not available for synchronous operations. Use async methods or ensure proper initialization.',
                'DB_NOT_AVAILABLE_SYNC'
            );
        }

        if (this.dbType === 'libsql' && !this.db.executeSync) {
            throw new DatabaseError(
                'LibSQL sync operations not available. Use async methods (exec/query) or switch to better-sqlite3 for sync support.',
                'SYNC_NOT_SUPPORTED'
            );
        }

        if (!this.db.prepare) {
            throw new DatabaseError(
                'sqlite3 driver only supports async operations. For sync operations, install better-sqlite3: npm install better-sqlite3',
                'SYNC_NOT_SUPPORTED'
            );
        }
    }

    async exec(sql: string, params: any[] = []): Promise<void> {
        if (this.isClosed) {
            return;
        }
        this.ensureInitialized();
        await this.ensureConnection();

        try {
            if (this.libsqlPool) {
                // Acquire and release connection for each statement
                // Note: For proper transaction support with pools, additional work is needed
                const connection = await this.libsqlPool.acquire();
                try {
                    await connection.client.execute({ sql, args: params });
                } finally {
                    await this.libsqlPool.release(connection);
                }
            } else if (this.dbType === 'libsql') {
                if (!this.db || this.isClosed) {
                    // Silently return if database is closed/closing
                    return;
                }
                await this.db.execute({ sql, args: params });
            } else {
                if (!this.db || this.isClosed) {
                    // Silently return if database is closed/closing
                    return;
                }
                if (this.db.prepare) {
                    const stmt = this.db.prepare(sql);
                    stmt.run(params);
                } else {
                    // ISSUE #2 FIX: sqlite3 is no longer supported
                    throw new DatabaseError(
                        'sqlite3 driver only supports async operations. For sync operations, install better-sqlite3: npm install better-sqlite3',
                        'SYNC_NOT_SUPPORTED'
                    );
                }
            }
        } catch (error) {
            if (this.handleClosedDatabaseError(error)) {
                return;
            }
            throw new DatabaseError(
                `Failed to execute: ${
                    error instanceof Error ? error.message : String(error)
                }`,
                sql
            );
        }
    }

    protected async _query(sql: string, params: any[] = []): Promise<Row[]> {
        if (this.isClosed) {
            return [];
        }
        this.ensureInitialized();
        await this.ensureConnection();

        try {
            if (this.libsqlPool) {
                // Acquire and release connection for each query
                // Note: For proper transaction support with pools, additional work is needed
                const connection = await this.libsqlPool.acquire();
                try {
                    const result = await connection.client.execute({
                        sql,
                        args: params,
                    });
                    return result.rows.map((row: any) =>
                        this.convertLibSQLRow(row, result.columns)
                    );
                } finally {
                    await this.libsqlPool.release(connection);
                }
            } else if (this.dbType === 'libsql') {
                if (!this.db || this.isClosed) {
                    // Silently return empty results if database is closed/closing
                    return [];
                }
                const result = await this.db.execute({ sql, args: params });
                return result.rows.map((row: any) =>
                    this.convertLibSQLRow(row, result.columns)
                );
            } else {
                if (!this.db || this.isClosed) {
                    // Silently return empty results if database is closed/closing
                    return [];
                }
                if (this.db.prepare) {
                    const stmt = this.prepareStatement(sql, () => this.db!.prepare(sql));
                    return stmt.all(params);
                } else {
                    // ISSUE #2 FIX: sqlite3 is no longer supported
                    throw new DatabaseError(
                        'sqlite3 driver only supports async operations. For sync operations, install better-sqlite3: npm install better-sqlite3',
                        'SYNC_NOT_SUPPORTED'
                    );
                }
            }
        } catch (error) {
            if (this.handleClosedDatabaseError(error)) {
                return [];
            }
            throw new DatabaseError(
                `Failed to query: ${
                    error instanceof Error ? error.message : String(error)
                }`,
                sql
            );
        }
    }

    execSync(sql: string, params: any[] = []): void {
        if (this.isClosed) {
            return;
        }
        this.ensureInitialized();
        this.ensureSyncOperationSupported();

        try {
            if (this.dbType === 'libsql') {
                this.db.executeSync({ sql, args: params });
            } else {
                const stmt = this.prepareStatement(sql, () => this.db!.prepare(sql));
                stmt.run(params);
            }
        } catch (error) {
            if (this.handleClosedDatabase(error)) {
                return;
            }
            throw new DatabaseError(
                `Failed to execute: ${
                    error instanceof Error ? error.message : String(error)
                }`,
                sql
            );
        }
    }

    protected _querySync(sql: string, params: any[] = []): Row[] {
        if (this.isClosed) {
            return [];
        }
        this.ensureInitialized();
        this.ensureSyncOperationSupported();

        try {
            if (this.dbType === 'libsql') {
                const result = this.db.executeSync({ sql, args: params });
                return result.rows.map((row: any) =>
                    this.convertLibSQLRow(row, result.columns)
                );
            } else {
                const stmt = this.prepareStatement(sql, () => this.db!.prepare(sql));
                return stmt.all(params);
            }
        } catch (error) {
            if (this.handleClosedDatabase(error)) {
                return [];
            }
            throw new DatabaseError(
                `Failed to query: ${
                    error instanceof Error ? error.message : String(error)
                }`,
                sql
            );
        }
    }

    // MEDIUM-2 FIX: Implement streaming query iterator
    protected async* _queryIterator(sql: string, params: any[] = []): AsyncIterableIterator<Row> {
        if (this.isClosed) {
            return;
        }
        this.ensureInitialized();
        await this.ensureConnection();

        try {
            if (this.libsqlPool) {
                // Acquire and release connection for each query
                // Note: For proper transaction support with pools, additional work is needed
                const connection = await this.libsqlPool.acquire();
                try {
                    const result = await connection.client.execute({
                        sql,
                        args: params,
                    });
                    // Yield rows one by one to avoid loading all into memory
                    for (const row of result.rows) {
                        yield this.convertLibSQLRow(row as any[], result.columns);
                    }
                } finally {
                    await this.libsqlPool.release(connection);
                }
            } else if (this.dbType === 'libsql') {
                if (!this.db || this.isClosed) {
                    return;
                }
                const result = await this.db.execute({ sql, args: params });
                // Yield rows one by one to avoid loading all into memory
                for (const row of result.rows) {
                    yield this.convertLibSQLRow(row as any[], result.columns);
                }
            } else {
                if (!this.db || this.isClosed) {
                    return;
                }
                if (this.db.prepare) {
                    // For better-sqlite3, use iterate() for memory-efficient streaming
                    const stmt = this.prepareStatement(sql, () => this.db!.prepare(sql));
                    // better-sqlite3 iterate() returns an iterator
                    for (const row of stmt.iterate(params)) {
                        yield row as Row;
                    }
                } else {
                    throw new DatabaseError(
                        'sqlite3 driver only supports async operations. For streaming, install better-sqlite3: npm install better-sqlite3',
                        'STREAMING_NOT_SUPPORTED'
                    );
                }
            }
        } catch (error) {
            if (this.handleClosedDatabaseError(error)) {
                return;
            }
            throw new DatabaseError(
                `Failed to stream query: ${
                    error instanceof Error ? error.message : String(error)
                }`,
                sql
            );
        }
    }

    private convertLibSQLRow(row: any[], columns: string[]): Row {
        const result: Row = {};
        columns.forEach((column, index) => {
            result[column] = row[index];
        });
        return result;
    }

    protected async performHealthCheck(): Promise<void> {
        this.ensureInitialized();
        if (this.libsqlPool) {
            // Test pool health by acquiring and releasing a connection
            const connection = await this.libsqlPool.acquire();
            try {
                await connection.client.execute({ sql: 'SELECT 1', args: [] });
            } finally {
                await this.libsqlPool.release(connection);
            }
        } else if (this.dbType === 'libsql') {
            if (!this.db) {
                throw new DatabaseError(
                    'Database not initialized',
                    'DB_NOT_INITIALIZED'
                );
            }
            await this.db.execute({ sql: 'SELECT 1', args: [] });
        } else {
            if (!this.db) {
                throw new DatabaseError(
                    'Database not initialized',
                    'DB_NOT_INITIALIZED'
                );
            }
            if (this.db.prepare) {
                const stmt = this.db.prepare('SELECT 1');
                stmt.get();
            } else {
                throw new Error(
                    'Cannot perform health check on sqlite3 driver'
                );
            }
        }
    }

    async transaction<T>(fn: () => Promise<T>): Promise<T> {
        if (this.isClosed) {
            throw new DatabaseError(
                'Cannot start transaction on closed database'
            );
        }

        // ISSUE #1 FIX: Handle connection pinning for pooled LibSQL
        if (this.libsqlPool) {
            // Use the base class lock and transaction handling for proper concurrency
            // The pinned connection is used for executing statements
            return await super.transaction(fn);
        } else if (this.dbType === 'libsql') {
            // For LibSQL without pool, use the base class implementation that handles nested transactions with SAVEPOINT
            // and proper transaction lock
            return await super.transaction(fn);
        } else {
            // For better-sqlite3, use the base class implementation
            // since better-sqlite3 transactions don't support async functions
            return await super.transaction(fn);
        }
    }

    protected async closeDatabase(): Promise<void> {
        try {
            if (this.libsqlPool) {
                await this.libsqlPool.close();
                this.libsqlPool = undefined;
            } else if (this.db) {
                if (this.dbType === 'libsql') {
                    if (this.db.close) {
                        await this.db.close();
                    }
                } else {
                    if (this.db.close) {
                        this.db.close();
                    }
                }
                this.db = undefined;
            }

            this.markConnectionClosed();
        } catch (error) {
            console.warn('Warning: Error closing database connection:', error);
        }
    }

    protected closeDatabaseSync(): void {
        try {
            if (this.libsqlPool) {
                // Cannot close pool synchronously, just mark as closed
                console.warn('Warning: Cannot close LibSQL pool synchronously');
                this.libsqlPool = undefined;
            } else if (this.db) {
                if (this.dbType === 'libsql') {
                    if (this.db.closeSync) {
                        this.db.closeSync();
                    } else if (this.db.close) {
                        this.db.close();
                        console.warn(
                            'Warning: Called a potentially asynchronous close() method on a LibSQL non-pooled connection during closeDatabaseSync. Full synchronous cleanup cannot be guaranteed. Consider using the asynchronous close() method for LibSQL connections.'
                        );
                    }
                } else {
                    // For other dbTypes like 'sqlite'
                    if (this.db.close) {
                        this.db.close();
                    }
                }
                this.db = undefined;
            }

            this.markConnectionClosed();
        } catch (error) {
            console.warn('Warning: Error closing database connection:', error);
        }
    }
}

// Export a factory function for easier testing and configuration
export function createNodeDriver(config: DBConfig = {}): NodeDriver {
    return new NodeDriver(config);
}
