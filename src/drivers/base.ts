import * as os from 'os';
import * as fs from 'fs';
import type { Driver, Row, DBConfig } from '../types.js';
import { DatabaseError } from '../errors.js';

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
    
    // HIGH-1 FIX: Add prepared statement cache with LRU eviction
    protected statementCache = new Map<string, any>();
    protected static readonly MAX_STATEMENTS = 100;
    protected cacheAccessOrder: string[] = [];
    
    // MEDIUM-1 FIX: Add savepoint stack for nested transactions
    public savepointStack: string[] = [];
    
    // Transaction lock queue - ensures only one transaction starts at a time
    // Note: In high-concurrency scenarios, the queue can grow. For production use,
    // consider implementing timeout/cancellation for waiting transactions.
    private transactionLockQueue: Array<() => void> = [];
    private transactionLockHeld = false;

    constructor(config: DBConfig) {
        this.config = config;
        this.autoReconnect = config.autoReconnect ?? true;
        this.maxReconnectAttempts = config.maxReconnectAttempts ?? 3;
        this.reconnectDelay = config.reconnectDelay ?? 1000;
        // Child classes must call this.initializeDriver(config) after their setup
    }

    /**
     * Acquire the transaction lock. This ensures only one transaction can start at a time.
     * Uses a queue to ensure fairness and prevent race conditions.
     * 
     * Note: The lock is automatically released when the transaction completes (commit/rollback).
     * If a transaction fails before releasing the lock, the base class transaction method
     * handles cleanup in its finally block.
     */
    private async acquireTransactionLock(): Promise<void> {
        // If lock is not held, acquire immediately
        if (!this.transactionLockHeld) {
            this.transactionLockHeld = true;
            return;
        }
        
        // Lock is held, wait in queue
        return new Promise((resolve) => {
            this.transactionLockQueue.push(resolve);
        });
    }
    
    /**
     * Release the transaction lock, allowing the next waiter to proceed.
     */
    private releaseTransactionLock(): void {
        // If there are waiters, give lock to the next one
        const nextWaiter = this.transactionLockQueue.shift();
        if (nextWaiter) {
            // Schedule the next waiter to run
            nextWaiter();
        } else {
            // No waiters, release the lock
            this.transactionLockHeld = false;
        }
    }
    
    // HIGH-1 FIX: Helper methods for statement caching
    protected getCachedStatement(sql: string): any | undefined {
        const stmt = this.statementCache.get(sql);
        if (stmt) {
            // Move to end (most recently used)
            const idx = this.cacheAccessOrder.indexOf(sql);
            if (idx > -1) {
                this.cacheAccessOrder.splice(idx, 1);
            }
            this.cacheAccessOrder.push(sql);
        }
        return stmt;
    }

    protected cacheStatement(sql: string, stmt: any): void {
        // Evict oldest if at capacity
        if (this.statementCache.size >= BaseDriver.MAX_STATEMENTS && !this.statementCache.has(sql)) {
            const oldest = this.cacheAccessOrder.shift();
            if (oldest) {
                const oldStmt = this.statementCache.get(oldest);
                // Finalize/close old statement if driver supports it
                if (oldStmt && typeof oldStmt.finalize === 'function') {
                    try {
                        oldStmt.finalize();
                    } catch (e) {
                        // Ignore finalize errors
                    }
                }
                this.statementCache.delete(oldest);
            }
        }
        this.statementCache.set(sql, stmt);
        this.cacheAccessOrder.push(sql);
    }

    protected clearStatementCache(): void {
        // Finalize all statements before clearing
        for (const [sql, stmt] of this.statementCache) {
            if (stmt && typeof stmt.finalize === 'function') {
                try {
                    stmt.finalize();
                } catch (e) {
                    // Ignore finalize errors
                }
            }
        }
        this.statementCache.clear();
        this.cacheAccessOrder = [];
    }

    protected abstract initializeDriver(config: DBConfig): Promise<void> | void;

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
        if (
            this.connectionState.connectionAttempts >= this.maxReconnectAttempts
        ) {
            throw new DatabaseError(
                `Max reconnection attempts (${this.maxReconnectAttempts}) exceeded`,
                'MAX_RECONNECT_ATTEMPTS'
            );
        }

        try {
            await this.closeDatabase();
            await this.delay(
                this.reconnectDelay *
                    (this.connectionState.connectionAttempts + 1)
            );

            await this.initializeDriver(this.config);

            this.connectionState = {
                isConnected: true,
                isHealthy: true,
                lastHealthCheck: Date.now(),
                connectionAttempts: 0,
            };
        } catch (error) {
            this.connectionState.connectionAttempts++;
            this.connectionState.lastError =
                error instanceof Error ? error : new Error(String(error));
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
            this.connectionState.lastError =
                error instanceof Error ? error : new Error(String(error));
            return false;
        }
    }

    protected async performHealthCheck(): Promise<void> {
        // Simple health check - override in child classes for driver-specific checks
        await this.query('SELECT 1');
    }

    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    getConnectionState(): ConnectionState {
        return { ...this.connectionState };
    }

    protected configureSQLite(config: DBConfig): void {
        const MIN_CACHE_KIB = -16000; // 16MB
        const MAX_CACHE_KIB = -256000; // 256MB
        const MB_IN_BYTES = 1024 * 1024;
        const KIB_IN_BYTES = 1024;

        // SECURITY: Define whitelists for PRAGMA values to prevent SQL injection
        const VALID_JOURNAL_MODES = new Set(['DELETE', 'TRUNCATE', 'PERSIST', 'MEMORY', 'WAL', 'OFF']);
        const VALID_SYNCHRONOUS = new Set(['OFF', 'NORMAL', 'FULL', 'EXTRA']);
        const VALID_TEMP_STORE = new Set(['DEFAULT', 'FILE', 'MEMORY']);
        const VALID_LOCKING_MODE = new Set(['NORMAL', 'EXCLUSIVE']);
        const VALID_AUTO_VACUUM = new Set(['NONE', 'FULL', 'INCREMENTAL']);

        // SECURITY: Validation function for PRAGMA values
        const validatePragmaValue = (value: any, validSet: Set<string> | null, name: string): string | number => {
            if (typeof value === 'number') {
                // Numeric pragmas (busyTimeout, cacheSize, walCheckpoint)
                if (!Number.isInteger(value) || !Number.isFinite(value)) {
                    throw new DatabaseError(`Invalid ${name}: must be a finite integer`);
                }
                return value;
            }
            if (validSet !== null) {
                // String pragmas with whitelist
                const strValue = String(value).toUpperCase();
                if (!validSet.has(strValue)) {
                    throw new DatabaseError(`Invalid ${name}: '${value}' is not allowed. Valid values: ${Array.from(validSet).join(', ')}`);
                }
                return strValue;
            }
            throw new DatabaseError(`Invalid ${name}: unexpected type`);
        };

        let calculatedCacheKiB: number;

        try {
            // Check for container memory limits (Docker, Lambda, Kubernetes)
            let availableMemoryBytes = os.freemem();
            let totalMemoryBytes = os.totalmem();

            // Try to read cgroup memory limit for accurate container memory detection
            try {
                // Check cgroup v1 location
                const cgroupV1Path = '/sys/fs/cgroup/memory/memory.limit_in_bytes';
                if (fs.existsSync(cgroupV1Path)) {
                    const limitStr = fs.readFileSync(cgroupV1Path, 'utf8').trim();
                    const cgroupLimit = parseInt(limitStr, 10);
                    // cgroup limit is valid if it's a reasonable number (not max uint64)
                    if (cgroupLimit > 0 && cgroupLimit < 9223372036854775807) {
                        // Use the cgroup limit if it's lower than the total memory
                        if (cgroupLimit < totalMemoryBytes) {
                            totalMemoryBytes = cgroupLimit;
                            // Estimate available memory as a percentage of cgroup limit
                            // Use the ratio of free to total from os module
                            const freeRatio = os.freemem() / os.totalmem();
                            availableMemoryBytes = Math.floor(cgroupLimit * freeRatio);
                        }
                    }
                }
            } catch (cgroupError) {
                // Try cgroup v2 location
                try {
                    const cgroupV2Path = '/sys/fs/cgroup/memory.max';
                    if (fs.existsSync(cgroupV2Path)) {
                        const limitStr = fs.readFileSync(cgroupV2Path, 'utf8').trim();
                        if (limitStr !== 'max') {
                            const cgroupLimit = parseInt(limitStr, 10);
                            if (cgroupLimit > 0 && cgroupLimit < totalMemoryBytes) {
                                totalMemoryBytes = cgroupLimit;
                                const freeRatio = os.freemem() / os.totalmem();
                                availableMemoryBytes = Math.floor(cgroupLimit * freeRatio);
                            }
                        }
                    }
                } catch (cgroupV2Error) {
                    // No cgroup limits found or accessible, continue with os.freemem()
                }
            }

            const freeMemoryBytes = availableMemoryBytes;
            const freeMemoryMB = freeMemoryBytes / MB_IN_BYTES;

            // Handle low memory: if 10% of free memory is less than 16MB, default to min cache.
            // 16MB is 16 * 1024 * 1024 bytes. 10% of this is 1.6MB.
            // So if freeMemoryBytes * 0.1 < 16 * MB_IN_BYTES (i.e. freeMemoryBytes < 160 * MB_IN_BYTES)
            if (freeMemoryBytes < 160 * MB_IN_BYTES) {
                calculatedCacheKiB = MIN_CACHE_KIB;
            } else {
                let baseCacheBytes = freeMemoryBytes * 0.1; // 10% of free memory

                if (this.queryCount < 100) {
                    baseCacheBytes *= 0.5; // 50% of base for low query count
                } else if (this.queryCount >= 1000) {
                    baseCacheBytes *= 1.5; // 150% of base for high query count
                }
                // For 100 <= queryCount < 1000, it's 100% of base, so no change.

                // Convert to KiB for PRAGMA, ensure it's an integer, and make it negative
                let cacheKiB = Math.floor(baseCacheBytes / KIB_IN_BYTES);

                // Clamp the value within defined min/max bounds
                // Note: Since values are negative, Math.max is used for lower bound (less negative)
                // and Math.min for upper bound (more negative).
                calculatedCacheKiB = Math.max(
                    MAX_CACHE_KIB,
                    Math.min(MIN_CACHE_KIB, -cacheKiB)
                );
            }
        } catch (error) {
            console.warn(
                'Warning: Failed to calculate dynamic cache size, defaulting to MIN_CACHE_KIB. Error:',
                error
            );
            calculatedCacheKiB = MIN_CACHE_KIB;
        }

        // SECURITY: Validate all user-provided PRAGMA values before use
        try {
            const sqliteConfig = {
                journalMode: validatePragmaValue(config.sqlite?.journalMode || 'WAL', VALID_JOURNAL_MODES, 'journal_mode'),
                synchronous: validatePragmaValue(config.sqlite?.synchronous || 'NORMAL', VALID_SYNCHRONOUS, 'synchronous'),
                busyTimeout: validatePragmaValue(config.sqlite?.busyTimeout || 5000, null, 'busy_timeout'),
                tempStore: validatePragmaValue(config.sqlite?.tempStore || 'MEMORY', VALID_TEMP_STORE, 'temp_store'),
                lockingMode: validatePragmaValue(config.sqlite?.lockingMode || 'NORMAL', VALID_LOCKING_MODE, 'locking_mode'),
                autoVacuum: validatePragmaValue(config.sqlite?.autoVacuum || 'NONE', VALID_AUTO_VACUUM, 'auto_vacuum'),
                cacheSize: calculatedCacheKiB,
                walCheckpoint: validatePragmaValue(config.sqlite?.walCheckpoint || 1000, null, 'wal_autocheckpoint'),
            };

            // Now safe to interpolate - all values are validated from whitelist or are safe integers
            this.execSync(`PRAGMA journal_mode = ${sqliteConfig.journalMode}`);
            this.execSync(`PRAGMA synchronous = ${sqliteConfig.synchronous}`);
            this.execSync(`PRAGMA busy_timeout = ${sqliteConfig.busyTimeout}`);
            this.execSync(`PRAGMA cache_size = ${sqliteConfig.cacheSize}`);
            this.execSync(`PRAGMA temp_store = ${sqliteConfig.tempStore}`);
            this.execSync(`PRAGMA locking_mode = ${sqliteConfig.lockingMode}`);
            this.execSync(`PRAGMA auto_vacuum = ${sqliteConfig.autoVacuum}`);

            if (sqliteConfig.journalMode === 'WAL') {
                this.execSync(
                    `PRAGMA wal_autocheckpoint = ${sqliteConfig.walCheckpoint}`
                );
            }

            this.execSync('PRAGMA foreign_keys = ON');
        } catch (error) {
            console.warn(
                'Warning: Failed to apply some SQLite configuration:',
                error
            );
        }
    }

    protected handleClosedDatabase(error: unknown): boolean {
        return (
            error instanceof Error &&
            (error.message.includes('closed database') ||
                error.message.includes('Database is closed'))
        );
    }

    // Helper to mark connection as closed and unhealthy
    protected markConnectionClosed(): void {
        this.connectionState.isConnected = false;
        this.connectionState.isHealthy = false;
    }

    // Helper to handle closed database errors consistently
    protected handleClosedDatabaseError(error: unknown): boolean {
        if (this.handleClosedDatabase(error)) {
            this.markConnectionClosed();
            return true;
        }
        return false;
    }

    // Helper that gets or prepares a statement with caching
    protected prepareStatement<T = any>(sql: string, prepareFunc: () => T): T {
        let stmt = this.getCachedStatement(sql);
        if (!stmt) {
            try {
                stmt = prepareFunc();
                this.cacheStatement(sql, stmt);
            } catch (error) {
                throw new DatabaseError(
                    `Failed to prepare statement: ${error instanceof Error ? error.message : String(error)}`,
                    sql
                );
            }
        }
        return stmt;
    }

    async transaction<T>(fn: () => Promise<T>): Promise<T> {
        await this.ensureConnection();

        // CRITICAL FIX: Use lock to prevent race conditions in concurrent transaction starts
        // This ensures that the check for isNested and setting isInTransaction are atomic
        await this.acquireTransactionLock();
        
        // MEDIUM-1 FIX: Implement nested transactions with SAVEPOINT
        const isNested = this.isInTransaction || this.savepointStack.length > 0;
        
        if (isNested) {
            // Release lock immediately for nested transactions - they don't need exclusive access
            this.releaseTransactionLock();
            
            // Use SAVEPOINT for nested transaction
            // Use crypto.randomUUID() for guaranteed uniqueness in high-concurrency scenarios
            const savepointName = `sp_${crypto.randomUUID().replace(/-/g, '_')}`;
            this.savepointStack.push(savepointName);
            
            await this.exec(`SAVEPOINT ${savepointName}`);
            try {
                const result = await fn();
                await this.exec(`RELEASE SAVEPOINT ${savepointName}`);
                this.savepointStack.pop();
                return result;
            } catch (error) {
                try {
                    await this.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
                    await this.exec(`RELEASE SAVEPOINT ${savepointName}`);
                } catch (rollbackError) {
                    console.warn('Failed to rollback savepoint:', rollbackError);
                }
                this.savepointStack.pop();
                throw error;
            }
        } else {
            // Top-level transaction - use BEGIN/COMMIT
            this.isInTransaction = true;
            
            try {
                // Execute BEGIN while holding the lock
                // This ensures no other transaction can start until SQLite has the transaction
                await this.exec('BEGIN');
            } finally {
                // Release lock after BEGIN has been executed - SQLite now has the transaction
                this.releaseTransactionLock();
            }
            
            try {
                const result = await fn();
                await this.exec('COMMIT');
                this.isInTransaction = false;
                return result;
            } catch (error) {
                // Enhanced rollback error recovery
                try {
                    await this.exec('ROLLBACK');
                } catch (rollbackError) {
                    // If rollback fails, log the error but don't override the original error
                    console.warn('Failed to rollback transaction:', rollbackError);

                    // If database is closed, handle gracefully
                    if (this.handleClosedDatabase(rollbackError)) {
                        this.connectionState.isConnected = false;
                        this.connectionState.isHealthy = false;
                        this.isClosed = true;
                        this.isInTransaction = false;
                        throw new DatabaseError(
                            `Transaction failed and database was closed during rollback: ${
                                (error as Error).message
                            }`,
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
        // HIGH-1 FIX: Clear statement cache before closing database
        this.clearStatementCache();
        await this.closeDatabase();
    }

    closeSync(): void {
        if (this.isClosed) return;
        this.isClosed = true;
        // HIGH-1 FIX: Clear statement cache before closing database
        this.clearStatementCache();
        this.closeDatabaseSync();
    }

    protected abstract closeDatabase(): Promise<void>;
    protected abstract closeDatabaseSync(): void;

    abstract exec(sql: string, params?: any[]): Promise<void>;
    protected abstract _query(sql: string, params?: any[]): Promise<Row[]>;
    // MEDIUM-2 FIX: Abstract method for streaming queries
    protected abstract _queryIterator(sql: string, params?: any[]): AsyncIterableIterator<Row>;
    abstract execSync(sql: string, params?: any[]): void;
    protected abstract _querySync(sql: string, params?: any[]): Row[];

    public async query(sql: string, params?: any[]): Promise<Row[]> {
        this.queryCount++;
        return this._query(sql, params);
    }

    public querySync(sql: string, params?: any[]): Row[] {
        this.queryCount++;
        return this._querySync(sql, params);
    }
    
    // MEDIUM-2 FIX: Public queryIterator for streaming large result sets
    public queryIterator(sql: string, params?: any[]): AsyncIterableIterator<Row> {
        this.queryCount++;
        return this._queryIterator(sql, params);
    }
}
