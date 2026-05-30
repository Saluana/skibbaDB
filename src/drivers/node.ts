import type { Row, DBConfig, SqliteParam } from '../types';
import { DatabaseError } from '../errors';
import { BaseDriver } from './base.js';
import { createLibSQLPool } from '../libsql-pool';
import {
    BetterSQLite3Strategy,
    LibSQLClientStrategy,
    LibSQLPoolStrategy,
    createLibSQLClient,
    type DriverStrategy,
} from './driver-strategies';

export class NodeDriver extends BaseDriver {
    private strategy?: DriverStrategy;
    private libsqlPoolStrategy?: LibSQLPoolStrategy;
    private canSyncInitialize: boolean;

    constructor(config: DBConfig = {}) {
        super(config);
        this.canSyncInitialize =
            typeof process !== 'undefined' &&
            !!process.versions?.node &&
            !process.versions?.bun;
        if (!config.sharedConnection && this.canSyncInitialize) {
            this.initializeSync(config);
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
        await this.initializeAsync(config);
    }

    private initializeSync(config: DBConfig): void {
        try {
            const path = config.path || ':memory:';
            const isLocalFile =
                path === ':memory:' ||
                (!path.startsWith('http://') &&
                    !path.startsWith('https://') &&
                    !path.startsWith('libsql://') &&
                    !(config as any).authToken &&
                    !(config as any).libsql);

            if (isLocalFile) {
                const sqliteStrategy = new BetterSQLite3Strategy(path, this);
                sqliteStrategy.configureSQLite(config);
                this.strategy = sqliteStrategy;
                this.connectionState = {
                    isConnected: true,
                    isHealthy: true,
                    lastHealthCheck: Date.now(),
                    connectionAttempts: 0,
                };
            } else {
                this.connectionState = {
                    isConnected: false,
                    isHealthy: false,
                    lastHealthCheck: Date.now(),
                    connectionAttempts: 0,
                    lastError: new Error('Sync initialization not possible for remote connections. Use async methods.'),
                };
            }
        } catch (error) {
            this.connectionState = {
                isConnected: false,
                isHealthy: false,
                lastHealthCheck: Date.now(),
                connectionAttempts: 1,
                lastError: error instanceof Error ? error : new Error(String(error)),
            };
            throw error;
        }
    }

    private async initializeAsync(config: DBConfig): Promise<void> {
        try {
            const path = config.path || ':memory:';
            const isRemoteLibSQL =
                path.startsWith('http://') ||
                path.startsWith('https://') ||
                path.startsWith('libsql://') ||
                config.authToken;

            if (isRemoteLibSQL && config.libsqlPool) {
                const pool = createLibSQLPool(config, config.libsqlPool);
                this.libsqlPoolStrategy = new LibSQLPoolStrategy(pool);
                this.strategy = this.libsqlPoolStrategy;
                this.connectionState = {
                    isConnected: true,
                    isHealthy: true,
                    lastHealthCheck: Date.now(),
                    connectionAttempts: 0,
                };
                return;
            }

            const isLocalFile =
                path === ':memory:' ||
                (!path.startsWith('http://') &&
                    !path.startsWith('https://') &&
                    !path.startsWith('libsql://'));

            try {
                const db = await createLibSQLClient(config, path);
                this.strategy = new LibSQLClientStrategy(db);
                this.connectionState = {
                    isConnected: true,
                    isHealthy: true,
                    lastHealthCheck: Date.now(),
                    connectionAttempts: 0,
                };
            } catch (libsqlError) {
                if (isLocalFile) {
                    try {
                        const sqliteStrategy = new BetterSQLite3Strategy(path, this);
                        sqliteStrategy.configureSQLite(config);
                        this.strategy = sqliteStrategy;
                        this.connectionState = {
                            isConnected: true,
                            isHealthy: true,
                            lastHealthCheck: Date.now(),
                            connectionAttempts: 0,
                        };
                    } catch (sqliteError) {
                        throw new DatabaseError(
                            'No compatible SQLite driver found. Install one of:\n' +
                            '  npm install @libsql/client    (recommended - works with SQLite and LibSQL)\n' +
                            '  npm install better-sqlite3    (local files only - sync operations)\n' +
                            '\nErrors encountered:\n' +
                            'LibSQL: ' + (libsqlError instanceof Error ? libsqlError.message : String(libsqlError)) + '\n' +
                            'SQLite: ' + (sqliteError instanceof Error ? sqliteError.message : String(sqliteError))
                        );
                    }
                } else {
                    throw new DatabaseError(
                        'LibSQL client required for remote connections. Install with:\n' +
                        '  npm install @libsql/client\n' +
                        '\nError: ' + (libsqlError instanceof Error ? libsqlError.message : String(libsqlError))
                    );
                }
            }
        } catch (error) {
            this.connectionState = {
                isConnected: false,
                isHealthy: false,
                lastHealthCheck: Date.now(),
                connectionAttempts: this.connectionState.connectionAttempts + 1,
                lastError: error instanceof Error ? error : new Error(String(error)),
            };
            throw error;
        }
    }

    private ensureInitialized(): void {
        if (!this.strategy && !this.isClosed) {
            if (this.canSyncInitialize) {
                this.initializeSync(this.config);
            }
        }
    }

    private ensureStrategy(): DriverStrategy {
        if (!this.strategy) {
            throw new DatabaseError(
                'Database not available. Use async methods or ensure proper initialization.',
                'DB_NOT_AVAILABLE'
            );
        }
        return this.strategy;
    }

    async exec(sql: string, params: SqliteParam[] = []): Promise<void> {
        if (this.isClosed) throw new DatabaseError('Cannot execute on closed database');
        this.ensureInitialized();
        await this.ensureConnection();
        try {
            await this.ensureStrategy().exec(sql, params);
        } catch (error) {
            if (this.handleClosedDatabaseError(error)) throw new DatabaseError('Cannot execute on closed database');
            throw new DatabaseError(`Failed to execute: ${error instanceof Error ? error.message : String(error)}`, sql);
        }
    }

    protected async _query(sql: string, params: SqliteParam[] = []): Promise<Row[]> {
        if (this.isClosed) throw new DatabaseError('Cannot query closed database');
        this.ensureInitialized();
        await this.ensureConnection();
        try {
            return await this.ensureStrategy().query(sql, params);
        } catch (error) {
            if (this.handleClosedDatabaseError(error)) throw new DatabaseError('Cannot query closed database');
            throw new DatabaseError(`Failed to query: ${error instanceof Error ? error.message : String(error)}`, sql);
        }
    }

    execSync(sql: string, params: SqliteParam[] = []): void {
        if (this.isClosed) return;
        this.ensureInitialized();
        try {
            this.ensureStrategy().execSync(sql, params);
        } catch (error) {
            if (this.handleClosedDatabase(error)) return;
            throw new DatabaseError(`Failed to execute: ${error instanceof Error ? error.message : String(error)}`, sql);
        }
    }

    protected _querySync(sql: string, params: SqliteParam[] = []): Row[] {
        if (this.isClosed) return [];
        this.ensureInitialized();
        try {
            return this.ensureStrategy().querySync(sql, params);
        } catch (error) {
            if (this.handleClosedDatabase(error)) return [];
            throw new DatabaseError(`Failed to query: ${error instanceof Error ? error.message : String(error)}`, sql);
        }
    }

    protected async* _queryIterator(sql: string, params: SqliteParam[] = []): AsyncIterableIterator<Row> {
        if (this.isClosed) return;
        this.ensureInitialized();
        await this.ensureConnection();
        try {
            yield* this.ensureStrategy().queryIterator(sql, params);
        } catch (error) {
            if (this.handleClosedDatabaseError(error)) return;
            throw new DatabaseError(`Failed to stream query: ${error instanceof Error ? error.message : String(error)}`, sql);
        }
    }

    protected async performHealthCheck(): Promise<void> {
        this.ensureInitialized();
        await this.ensureStrategy().performHealthCheck();
    }

    async transaction<T>(fn: () => Promise<T>): Promise<T> {
        if (this.isClosed) throw new DatabaseError('Cannot start transaction on closed database');

        if (this.libsqlPoolStrategy) {
            const connection = await this.libsqlPoolStrategy.acquireConnection();
            this.libsqlPoolStrategy.setCurrentConnection(connection);
            try {
                return await super.transaction(fn);
            } finally {
                this.libsqlPoolStrategy.clearCurrentConnection();
                await this.libsqlPoolStrategy.releaseConnection(connection);
            }
        }

        return await super.transaction(fn);
    }

    protected async closeDatabase(): Promise<void> {
        try {
            if (this.strategy) {
                await this.strategy.close();
                this.strategy = undefined;
            }
            this.markConnectionClosed();
        } catch (error) {
            console.warn('Warning: Error closing database connection:', error);
        }
    }

    protected closeDatabaseSync(): void {
        try {
            if (this.strategy) {
                this.strategy.closeSync();
                this.strategy = undefined;
            }
            this.markConnectionClosed();
        } catch (error) {
            console.warn('Warning: Error closing database connection:', error);
        }
    }
}

export function createNodeDriver(config: DBConfig = {}): NodeDriver {
    return new NodeDriver(config);
}
