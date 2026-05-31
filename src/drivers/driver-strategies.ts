import type { Row, DBConfig, SqliteParam } from '../types';
import { DatabaseError } from '../errors';
import { createRequire } from 'module';
import { tryLoadSqliteVecSync, tryLoadSqliteVecLibSQL } from '../vector-loader';
import { LibSQLConnectionPool, createLibSQLPool } from '../libsql-pool';
import type { BaseDriver } from './base';
import { configureSQLitePragmas } from './pragma-configurator';

const require = createRequire(import.meta.url);

export interface DriverStrategy {
    exec(sql: string, params: SqliteParam[]): Promise<void>;
    query(sql: string, params: SqliteParam[]): Promise<Row[]>;
    queryIterator(sql: string, params: SqliteParam[]): AsyncIterableIterator<Row>;
    execSync(sql: string, params: SqliteParam[]): void;
    querySync(sql: string, params: SqliteParam[]): Row[];
    performHealthCheck(): Promise<void>;
    close(): Promise<void>;
    closeSync(): void;
}

export class BetterSQLite3Strategy implements DriverStrategy {
    private db: any;
    private driver: BaseDriver;

    constructor(path: string, driver: BaseDriver) {
        this.driver = driver;
        try {
            const Database = require('better-sqlite3');
            this.db = new Database(path === ':memory:' ? ':memory:' : path);
            // Lazy-load sqlite-vec only if available
            tryLoadSqliteVecSync(this.db);
            try {
                this.db.prepare('SELECT jsonb(?)').get('{}');
                driver.docBindSql = 'jsonb(?)';
            } catch {
                driver.docBindSql = 'json(?)';
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new DatabaseError(
                'better-sqlite3 is required for local SQLite files but could not be loaded.\n' +
                '\nTo fix this issue, install better-sqlite3:\n' +
                '  npm install better-sqlite3\n' +
                '\nAlternatively, use LibSQL for both local and remote connections:\n' +
                '  npm install @libsql/client\n' +
                '\nOriginal error: ' + errorMessage,
                'BETTER_SQLITE3_REQUIRED'
            );
        }
    }

    async exec(sql: string, params: SqliteParam[]): Promise<void> {
        const stmt = this.driver.prepareStatement(sql, () => this.db.prepare(sql));
        stmt.run(params);
    }

    async query(sql: string, params: SqliteParam[]): Promise<Row[]> {
        const stmt = this.driver.prepareStatement(sql, () => this.db.prepare(sql));
        return stmt.all(params);
    }

    async* queryIterator(sql: string, params: SqliteParam[]): AsyncIterableIterator<Row> {
        const stmt = this.driver.prepareStatement(sql, () => this.db.prepare(sql));
        for (const row of stmt.iterate(params)) {
            yield row as Row;
        }
    }

    execSync(sql: string, params: SqliteParam[]): void {
        const stmt = this.driver.prepareStatement(sql, () => this.db.prepare(sql));
        stmt.run(params);
    }

    querySync(sql: string, params: SqliteParam[]): Row[] {
        const stmt = this.driver.prepareStatement(sql, () => this.db.prepare(sql));
        return stmt.all(params);
    }

    async performHealthCheck(): Promise<void> {
        const stmt = this.db.prepare('SELECT 1');
        stmt.get();
    }

    async close(): Promise<void> {
        if (this.db.close) {
            this.db.close();
        }
    }

    closeSync(): void {
        if (this.db.close) {
            this.db.close();
        }
    }

    configureSQLite(config: DBConfig): void {
        configureSQLitePragmas((sql) => this.execSync(sql, []), config);
    }
}

export class LibSQLClientStrategy implements DriverStrategy {
    private db: any;

    constructor(db: any) {
        this.db = db;
    }

    async exec(sql: string, params: SqliteParam[]): Promise<void> {
        await this.db.execute({ sql, args: params });
    }

    async query(sql: string, params: SqliteParam[]): Promise<Row[]> {
        const result = await this.db.execute({ sql, args: params });
        return result.rows.map((row: any) => this.convertRow(row, result.columns));
    }

    async* queryIterator(sql: string, params: SqliteParam[]): AsyncIterableIterator<Row> {
        const result = await this.db.execute({ sql, args: params });
        for (const row of result.rows) {
            yield this.convertRow(row as any[], result.columns);
        }
    }

    execSync(sql: string, params: SqliteParam[]): void {
        if (!this.db.executeSync) {
            throw new DatabaseError(
                'LibSQL sync operations not available. Use async methods or switch to better-sqlite3 for sync support.',
                'SYNC_NOT_SUPPORTED'
            );
        }
        this.db.executeSync({ sql, args: params });
    }

    querySync(sql: string, params: SqliteParam[]): Row[] {
        if (!this.db.executeSync) {
            throw new DatabaseError(
                'LibSQL sync operations not available. Use async methods or switch to better-sqlite3 for sync support.',
                'SYNC_NOT_SUPPORTED'
            );
        }
        const result = this.db.executeSync({ sql, args: params });
        return result.rows.map((row: any) => this.convertRow(row, result.columns));
    }

    async performHealthCheck(): Promise<void> {
        await this.db.execute({ sql: 'SELECT 1', args: [] });
    }

    async close(): Promise<void> {
        if (this.db.close) {
            await this.db.close();
        }
    }

    closeSync(): void {
        if (this.db.closeSync) {
            this.db.closeSync();
        } else if (this.db.close) {
            throw new DatabaseError(
                'Cannot safely close a LibSQL connection synchronously; use close() instead.'
            );
        }
    }

    private convertRow(row: any[], columns: string[]): Row {
        const result: Row = {};
        columns.forEach((column, index) => {
            result[column] = row[index];
        });
        return result;
    }
}

export class LibSQLPoolStrategy implements DriverStrategy {
    private pool: LibSQLConnectionPool;
    private currentConnection?: any;

    constructor(pool: LibSQLConnectionPool) {
        this.pool = pool;
    }

    async exec(sql: string, params: SqliteParam[]): Promise<void> {
        const connection = this.currentConnection ?? (await this.pool.acquire());
        try {
            await connection.client.execute({ sql, args: params });
        } finally {
            if (!this.currentConnection) {
                await this.pool.release(connection);
            }
        }
    }

    async query(sql: string, params: SqliteParam[]): Promise<Row[]> {
        const connection = this.currentConnection ?? (await this.pool.acquire());
        try {
            const result = await connection.client.execute({ sql, args: params });
            return result.rows.map((row: any) => this.convertRow(row, result.columns));
        } finally {
            if (!this.currentConnection) {
                await this.pool.release(connection);
            }
        }
    }

    async* queryIterator(sql: string, params: SqliteParam[]): AsyncIterableIterator<Row> {
        const connection = this.currentConnection ?? (await this.pool.acquire());
        try {
            const result = await connection.client.execute({ sql, args: params });
            for (const row of result.rows) {
                yield this.convertRow(row as any[], result.columns);
            }
        } finally {
            if (!this.currentConnection) {
                await this.pool.release(connection);
            }
        }
    }

    execSync(_sql: string, _params: SqliteParam[]): void {
        throw new DatabaseError(
            'LibSQL pool does not support synchronous operations. Use async methods.',
            'SYNC_NOT_SUPPORTED'
        );
    }

    querySync(_sql: string, _params: SqliteParam[]): Row[] {
        throw new DatabaseError(
            'LibSQL pool does not support synchronous operations. Use async methods.',
            'SYNC_NOT_SUPPORTED'
        );
    }

    async performHealthCheck(): Promise<void> {
        const connection = await this.pool.acquire();
        try {
            await connection.client.execute({ sql: 'SELECT 1', args: [] });
        } finally {
            await this.pool.release(connection);
        }
    }

    async close(): Promise<void> {
        await this.pool.close();
    }

    closeSync(): void {
        console.warn('Warning: Cannot close LibSQL pool synchronously');
    }

    setCurrentConnection(connection: any): void {
        this.currentConnection = connection;
    }

    clearCurrentConnection(): void {
        this.currentConnection = undefined;
    }

    async acquireConnection(): Promise<any> {
        return await this.pool.acquire();
    }

    async releaseConnection(connection: any): Promise<void> {
        await this.pool.release(connection);
    }

    private convertRow(row: any[], columns: string[]): Row {
        const result: Row = {};
        columns.forEach((column, index) => {
            result[column] = row[index];
        });
        return result;
    }
}

export async function createLibSQLClient(config: DBConfig, path: string): Promise<any> {
    const { createClient } = require('@libsql/client');
    const clientConfig: any = {};

    if (path === ':memory:') {
        clientConfig.url = ':memory:';
    } else if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('libsql://')) {
        clientConfig.url = path;
    } else {
        clientConfig.url = path.startsWith('file:') ? path : `file:${path}`;
    }

    if ((config as any).authToken) {
        clientConfig.authToken = (config as any).authToken;
    }
    if ((config as any).syncUrl) {
        clientConfig.syncUrl = (config as any).syncUrl;
    }

    const db = createClient(clientConfig);

    // Lazy-load sqlite-vec only if available
    await tryLoadSqliteVecLibSQL(db);

    return db;
}
