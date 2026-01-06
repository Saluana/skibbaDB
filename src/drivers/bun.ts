import { Database } from 'bun:sqlite';
import type { Row, DBConfig } from '../types';
import { DatabaseError } from '../errors';
import { BaseDriver } from './base';
import * as sqliteVec from 'sqlite-vec';

export class BunDriver extends BaseDriver {
    private db?: Database;

    constructor(config: DBConfig) {
        super(config);
        // Lazy initialization - only connect when needed
        if (!config.sharedConnection) {
            this.initializeDriverSync(config);
        }
    }

    protected async initializeDriver(config: DBConfig): Promise<void> {
        this.initializeDriverSync(config);
    }

    private initializeDriverSync(config: DBConfig): void {
        try {
            // Set custom SQLite library for extension support
            try {
                // Try common SQLite library paths that support extensions
                const sqlitePaths = [
                    '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib', // Homebrew sqlite package on Apple Silicon
                    '/usr/local/opt/sqlite/lib/libsqlite3.dylib', // Homebrew sqlite package on Intel
                    '/usr/local/opt/sqlite3/lib/libsqlite3.dylib', // Homebrew sqlite3 package (as shown in docs)
                    '/opt/homebrew/lib/libsqlite3.dylib', // Homebrew on Apple Silicon (alternative)
                    '/usr/local/lib/libsqlite3.dylib', // Generic /usr/local
                    '/usr/lib/x86_64-linux-gnu/libsqlite3.so.0', // Ubuntu/Debian
                    '/usr/lib/libsqlite3.so', // Generic Linux
                ];

                let sqliteSet = false;
                for (const path of sqlitePaths) {
                    try {
                        // Check if file exists using require('fs')
                        const fs = require('fs');
                        if (fs.existsSync(path)) {
                            Database.setCustomSQLite(path);
                            sqliteSet = true;
                            break;
                        }
                    } catch (e) {
                        // Continue to next path
                        continue;
                    }
                }

                if (!sqliteSet) {
                    console.warn(
                        'Warning: No SQLite library with extension support found. Vector functionality may not work.'
                    );
                    console.warn(
                        'To enable vector functionality in Bun, install SQLite with extension support:'
                    );
                    console.warn('  macOS: brew install sqlite3');
                    console.warn('  Linux: sudo apt-get install sqlite3-dev');
                }
            } catch (error) {
                console.warn(
                    'Warning: Could not set custom SQLite library:',
                    error
                );
            }

            this.db = new Database(
                config.memory ? ':memory:' : config.path || 'database.db'
            );
            if (!this.db) {
                throw new DatabaseError('Failed to create SQLite database');
            }
            // Load sqlite-vec extension
            try {
                // Use the proper sqlite-vec loading approach for Bun
                sqliteVec.load(this.db);
            } catch (error) {
                console.warn(
                    'Warning: Failed to load sqlite-vec extension. Vector operations will not be available:',
                    error
                );
                // Vector search functionality will not be available, but basic operations should still work
            }

            this.configureSQLite(config);

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
            throw new DatabaseError(`Failed to initialize database: ${error}`);
        }
    }

    private ensureInitialized(): void {
        if (!this.db) {
            this.initializeDriverSync(this.config);
        }
    }

    protected async performHealthCheck(): Promise<void> {
        this.ensureInitialized();
        if (!this.db) {
            throw new DatabaseError(
                'Database not initialized',
                'DB_NOT_INITIALIZED'
            );
        }

        try {
            const stmt = this.db.prepare('SELECT 1');
            stmt.get();
        } catch (error) {
            throw new DatabaseError(
                `Health check failed: ${error}`,
                'HEALTH_CHECK_FAILED'
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
            if (!this.db || this.isClosed) {
                // Silently return if database is closed/closing
                return;
            }
            const stmt = this.prepareStatement(sql, () => this.db!.prepare(sql));
            stmt.run(...params);
        } catch (error) {
            if (this.handleClosedDatabaseError(error)) {
                return;
            }
            throw new DatabaseError(`Failed to execute: ${error}`);
        }
    }

    protected async _query(sql: string, params: any[] = []): Promise<Row[]> {
        if (this.isClosed) {
            return [];
        }
        this.ensureInitialized();
        await this.ensureConnection();

        try {
            if (!this.db || this.isClosed) {
                // Silently return empty results if database is closed/closing
                return [];
            }
            const stmt = this.prepareStatement(sql, () => this.db!.prepare(sql));
            return stmt.all(...params) as Row[];
        } catch (error) {
            if (this.handleClosedDatabaseError(error)) {
                return [];
            }
            throw new DatabaseError(`Failed to query: ${error}`);
        }
    }

    execSync(sql: string, params: any[] = []): void {
        if (this.isClosed) {
            return;
        }
        this.ensureInitialized();

        try {
            if (!this.db || this.isClosed) {
                // Silently return if database is closed/closing
                return;
            }
            const stmt = this.prepareStatement(sql, () => this.db!.prepare(sql));
            stmt.run(...params);
        } catch (error) {
            if (this.handleClosedDatabaseError(error)) {
                return;
            }
            throw new DatabaseError(`Failed to execute: ${error}`);
        }
    }

    protected _querySync(sql: string, params: any[] = []): Row[] {
        if (this.isClosed) {
            return [];
        }
        this.ensureInitialized();

        try {
            if (!this.db || this.isClosed) {
                // Silently return empty results if database is closed/closing
                return [];
            }
            const stmt = this.prepareStatement(sql, () => this.db!.prepare(sql));
            return stmt.all(...params) as Row[];
        } catch (error) {
            if (this.handleClosedDatabaseError(error)) {
                return [];
            }
            throw new DatabaseError(`Failed to query: ${error}`);
        }
    }

    // MEDIUM-2 FIX: Implement streaming query iterator for Bun
    protected async* _queryIterator(sql: string, params: any[] = []): AsyncIterableIterator<Row> {
        if (this.isClosed) {
            return;
        }
        this.ensureInitialized();
        await this.ensureConnection();

        try {
            if (!this.db || this.isClosed) {
                return;
            }
            const stmt = this.prepareStatement(sql, () => this.db!.prepare(sql));
            // Bun's SQLite has values() method that returns an iterator
            const iterator = stmt.values(...params);
            for (const row of iterator) {
                // Convert array row to object using column names
                const columns = stmt.columns();
                const rowObj: Row = {};
                columns.forEach((col: any, idx: number) => {
                    rowObj[col.name] = (row as any[])[idx];
                });
                yield rowObj;
            }
        } catch (error) {
            if (this.handleClosedDatabaseError(error)) {
                return;
            }
            throw new DatabaseError(`Failed to stream query: ${error}`);
        }
    }

    protected async closeDatabase(): Promise<void> {
        if (this.db) {
            this.db.close();
            this.db = undefined;
        }
        this.markConnectionClosed();
    }

    protected closeDatabaseSync(): void {
        if (this.db) {
            this.db.close();
            this.db = undefined;
        }
        this.markConnectionClosed();
    }
}
