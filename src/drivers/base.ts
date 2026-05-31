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
    private transactionLockQueue: Array<{
        resolve: () => void;
        timeout: ReturnType<typeof setTimeout>;
    }> = [];
    private transactionLockDepth = 0;
    /** Nesting depth of active driver.transaction() frames (not connection mutex). */
    private transactionFrameDepth = 0;
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

    /** Serialize top-level transactions; nested savepoints bump depth only. */
    private async acquireExclusiveTransactionLock(): Promise<void> {
        if (this.transactionLockDepth === 0) {
            this.transactionLockDepth = 1;
            return;
        }
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                const idx = this.transactionLockQueue.findIndex(
                    (entry) => entry.resolve === resolve
                );
                if (idx !== -1) this.transactionLockQueue.splice(idx, 1);
                reject(
                    new DatabaseError(
                        'Transaction lock timeout: another transaction is still in progress',
                        'TRANSACTION_LOCK_TIMEOUT'
                    )
                );
            }, 30000);
            timeout.unref?.();
            this.transactionLockQueue.push({ resolve, timeout });
        });
    }

    private acquireNestedTransactionLock(): void {
        this.transactionLockDepth++;
    }

    private releaseTransactionLock(): void {
        if (this.transactionLockDepth > 1) {
            this.transactionLockDepth--;
            return;
        }
        this.transactionLockDepth = 0;
        const next = this.transactionLockQueue.shift();
        if (next) {
            clearTimeout(next.timeout);
            this.transactionLockDepth = 1;
            next.resolve();
        }
    }

    /** Serialize standalone statements so they do not interleave with open transactions. */
    protected async withConnectionMutex<T>(operation: () => Promise<T>): Promise<T> {
        if (this.transactionLockDepth > 0 || this.isInTransaction) {
            return operation();
        }
        await this.acquireExclusiveTransactionLock();
        try {
            return await operation();
        } finally {
            this.releaseTransactionLock();
        }
    }

    protected withConnectionMutexSync<T>(operation: () => T): T {
        if (this.transactionLockDepth > 0 || this.isInTransaction) {
            return operation();
        }
        this.transactionLockDepth = 1;
        try {
            return operation();
        } finally {
            this.releaseTransactionLock();
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

    /** True when inside driver.transaction() or an open SQLite transaction. */
    isTransactionActive(): boolean {
        return this.isInTransaction || this.transactionFrameDepth > 0;
    }

    async transaction<T>(fn: () => Promise<T>): Promise<T> {
        await this.ensureConnection();

        const parentFrameDepth = this.transactionFrameDepth;
        this.transactionFrameDepth++;

        const useSavepoint = parentFrameDepth > 0 && this.isInTransaction;
        const joinAmbientTransaction =
            !useSavepoint && this.isInTransaction;

        if (useSavepoint || joinAmbientTransaction) {
            this.acquireNestedTransactionLock();
        } else {
            await this.acquireExclusiveTransactionLock();
        }

        try {
            if (useSavepoint) {
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
                        await this.exec(
                            `ROLLBACK TO SAVEPOINT ${savepointName}`
                        );
                        await this.exec(`RELEASE SAVEPOINT ${savepointName}`);
                    } catch {
                        // Ignore rollback errors
                    }
                    this.savepointStack.pop();
                    throw error;
                }
            }

            if (joinAmbientTransaction) {
                return await fn();
            }

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
        } finally {
            this.releaseTransactionLock();
            this.transactionFrameDepth--;
        }
    }

    async close(): Promise<void> {
        if (this.isClosed) return;
        this.isClosed = true;
        this.isInTransaction = false;
        this.transactionFrameDepth = 0;
        this.savepointStack = [];
        this.statementCache.clear();
        await this.closeDatabase();
    }

    closeSync(): void {
        if (this.isClosed) return;
        this.isClosed = true;
        this.isInTransaction = false;
        this.transactionFrameDepth = 0;
        this.savepointStack = [];
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
