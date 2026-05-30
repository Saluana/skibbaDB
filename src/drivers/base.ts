import type { Driver, Row, DBConfig, DocBindSql, SqliteParam } from '../types.js';
import { DatabaseError } from '../errors.js';
import { StatementCache } from './statement-cache';
import { configureSQLitePragmas } from './pragma-configurator';

export interface ConnectionState {
    isConnected: boolean;
    isHealthy: boolean;
    lastHealthCheck: number;
    connectionAttempts: number;
    lastError?: Error;
}

export abstract class BaseDriver implements Driver {
    protected isClosed = false;
    public isInTransaction = false;
    public docBindSql: DocBindSql = 'json(?)';
    protected queryCount: number = 0;
    protected connectionState: ConnectionState = {
        isConnected: false,
        isHealthy: false,
        lastHealthCheck: 0,
        connectionAttempts: 0,
    };
    protected config: DBConfig;
    protected autoReconnect: boolean;
    protected maxReconnectAttempts: number;
    protected reconnectDelay: number;

    protected statementCache = new StatementCache();
    private transactionLockQueue: Array<() => void> = [];
    private transactionLockHeld = false;
    public savepointStack: string[] = [];

    constructor(config: DBConfig) {
        this.config = config;
        this.autoReconnect = config.autoReconnect ?? true;
        this.maxReconnectAttempts = config.maxReconnectAttempts ?? 3;
        this.reconnectDelay = config.reconnectDelay ?? 1000;
    }

    protected abstract initializeDriver(config: DBConfig): Promise<void> | void;

    protected detectJsonbSupport(test: () => void): void {
        try {
            test();
            this.docBindSql = 'jsonb(?)';
        } catch {
            this.docBindSql = 'json(?)';
        }
    }

    private async acquireTransactionLock(): Promise<void> {
        if (!this.transactionLockHeld) {
            this.transactionLockHeld = true;
            return;
        }
        return new Promise((resolve) => {
            this.transactionLockQueue.push(resolve);
        });
    }

    private releaseTransactionLock(): void {
        const next = this.transactionLockQueue.shift();
        if (next) {
            next();
        } else {
            this.transactionLockHeld = false;
        }
    }

    protected isNestedTransactionError(error: unknown): boolean {
        return (
            error instanceof Error &&
            error.message.includes('cannot start a transaction within a transaction')
        );
    }

    protected async ensureConnection(): Promise<void> {
        if (this.isClosed) {
            throw new DatabaseError('Driver is closed', 'DRIVER_CLOSED');
        }
        if (!this.connectionState.isConnected) {
            await this.reconnect();
        } else if (!this.connectionState.isHealthy) {
            const shouldReconnect = await this.checkHealth();
            if (!shouldReconnect && this.autoReconnect) {
                await this.reconnect();
            }
        }
    }

    protected async reconnect(): Promise<void> {
        if (this.connectionState.connectionAttempts >= this.maxReconnectAttempts) {
            throw new DatabaseError(
                `Max reconnection attempts (${this.maxReconnectAttempts}) exceeded`,
                'MAX_RECONNECT_ATTEMPTS'
            );
        }
        try {
            await this.closeDatabase();
            await this.delay(this.reconnectDelay * (this.connectionState.connectionAttempts + 1));
            await this.initializeDriver(this.config);
            this.connectionState = {
                isConnected: true,
                isHealthy: true,
                lastHealthCheck: Date.now(),
                connectionAttempts: 0,
            };
        } catch (error) {
            this.connectionState.connectionAttempts++;
            this.connectionState.lastError = error instanceof Error ? error : new Error(String(error));
            throw error;
        }
    }

    protected async checkHealth(): Promise<boolean> {
        try {
            await this.performHealthCheck();
            this.connectionState.isHealthy = true;
            this.connectionState.lastHealthCheck = Date.now();
            return true;
        } catch (error) {
            this.connectionState.isHealthy = false;
            this.connectionState.lastError = error instanceof Error ? error : new Error(String(error));
            return false;
        }
    }

    protected async performHealthCheck(): Promise<void> {
        await this.query('SELECT 1');
    }

    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    getConnectionState(): ConnectionState {
        return { ...this.connectionState };
    }

    protected configureSQLite(config: DBConfig): void {
        configureSQLitePragmas((sql) => this.execSync(sql), config);
    }

    protected handleClosedDatabase(error: unknown): boolean {
        return (
            error instanceof Error &&
            (error.message.includes('closed database') ||
                error.message.includes('Database is closed'))
        );
    }

    protected markConnectionClosed(): void {
        this.connectionState.isConnected = false;
        this.connectionState.isHealthy = false;
    }

    protected handleClosedDatabaseError(error: unknown): boolean {
        if (this.handleClosedDatabase(error)) {
            this.markConnectionClosed();
            return true;
        }
        return false;
    }

    public prepareStatement<T = any>(sql: string, prepareFunc: () => T): T {
        try {
            return this.statementCache.prepare(sql, prepareFunc);
        } catch (error) {
            throw new DatabaseError(
                `Failed to prepare statement: ${error instanceof Error ? error.message : String(error)}`,
                sql
            );
        }
    }

    async transaction<T>(fn: () => Promise<T>): Promise<T> {
        await this.ensureConnection();
        await this.acquireTransactionLock();

        const isNested = this.isInTransaction || this.savepointStack.length > 0;

        if (isNested) {
            this.releaseTransactionLock();
            const savepointName = `sp_${crypto.randomUUID().replace(/-/g, '_')}`;
            this.savepointStack.push(savepointName);
            try {
                await this.exec(`SAVEPOINT ${savepointName}`);
            } catch (savepointError) {
                this.savepointStack.pop();
                throw savepointError;
            }
            try {
                const result = await fn();
                await this.exec(`RELEASE SAVEPOINT ${savepointName}`);
                this.savepointStack.pop();
                return result;
            } catch (error) {
                try {
                    await this.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
                    await this.exec(`RELEASE SAVEPOINT ${savepointName}`);
                } catch {
                    // Ignore rollback errors
                }
                this.savepointStack.pop();
                throw error;
            }
        } else {
            let usingAmbientTransaction = false;
            try {
                await this.exec('BEGIN');
                this.isInTransaction = true;
            } catch (error) {
                this.isInTransaction = false;
                if (this.isNestedTransactionError(error)) {
                    usingAmbientTransaction = true;
                } else {
                    throw error;
                }
            } finally {
                this.releaseTransactionLock();
            }

            if (usingAmbientTransaction) {
                const previousIsInTransaction = this.isInTransaction;
                this.isInTransaction = true;
                try {
                    return await fn();
                } finally {
                    this.isInTransaction = previousIsInTransaction;
                }
            }

            try {
                const result = await fn();
                await this.exec('COMMIT');
                this.isInTransaction = false;
                return result;
            } catch (error) {
                try {
                    await this.exec('ROLLBACK');
                } catch (rollbackError) {
                    console.warn('Failed to rollback transaction:', rollbackError);
                    if (this.handleClosedDatabase(rollbackError)) {
                        this.connectionState.isConnected = false;
                        this.connectionState.isHealthy = false;
                        this.isClosed = true;
                        this.isInTransaction = false;
                        throw new DatabaseError(
                            `Transaction failed and database was closed during rollback: ${(error as Error).message}`,
                            'TRANSACTION_ROLLBACK_DB_CLOSED'
                        );
                    }
                }
                this.isInTransaction = false;
                throw error;
            }
        }
    }

    async close(): Promise<void> {
        if (this.isClosed) return;
        this.isClosed = true;
        this.statementCache.clear();
        await this.closeDatabase();
    }

    closeSync(): void {
        if (this.isClosed) return;
        this.isClosed = true;
        this.statementCache.clear();
        this.closeDatabaseSync();
    }

    protected abstract closeDatabase(): Promise<void>;
    protected abstract closeDatabaseSync(): void;

    abstract exec(sql: string, params?: SqliteParam[]): Promise<void>;
    protected abstract _query(sql: string, params?: SqliteParam[]): Promise<Row[]>;
    protected abstract _queryIterator(sql: string, params?: SqliteParam[]): AsyncIterableIterator<Row>;
    abstract execSync(sql: string, params?: SqliteParam[]): void;
    protected abstract _querySync(sql: string, params?: SqliteParam[]): Row[];

    public async query(sql: string, params?: SqliteParam[]): Promise<Row[]> {
        this.queryCount++;
        return this._query(sql, params);
    }

    public querySync(sql: string, params?: SqliteParam[]): Row[] {
        this.queryCount++;
        return this._querySync(sql, params);
    }

    public queryIterator(sql: string, params?: SqliteParam[]): AsyncIterableIterator<Row> {
        this.queryCount++;
        return this._queryIterator(sql, params);
    }
}
