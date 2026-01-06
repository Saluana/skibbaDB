import type { DBConfig } from './types.js';
import { DatabaseError } from './errors.js';

export interface LibSQLPoolConfig {
    maxConnections?: number;
    minConnections?: number;
    acquireTimeout?: number;
    createTimeout?: number;
    destroyTimeout?: number;
    idleTimeout?: number;
    reapInterval?: number;
    maxRetries?: number;
}

export interface LibSQLConnection {
    id: string;
    client: any; // LibSQL client
    isActive: boolean;
    createdAt: number;
    lastUsed: number;
    useCount: number;
    retryCount: number;
}

export class LibSQLConnectionPool {
    private config: Required<LibSQLPoolConfig>;
    private connections: LibSQLConnection[] = [];
    private waiting: Array<{
        resolve: (connection: LibSQLConnection) => void;
        reject: (error: Error) => void;
        timeout: NodeJS.Timeout;
    }> = [];
    private reapTimer?: NodeJS.Timeout;
    private isClosing = false;
    private dbConfig: DBConfig;

    constructor(dbConfig: DBConfig, poolConfig: LibSQLPoolConfig = {}) {
        this.dbConfig = dbConfig;
        this.config = {
            maxConnections: poolConfig.maxConnections ?? 10,
            minConnections: poolConfig.minConnections ?? 2,
            acquireTimeout: poolConfig.acquireTimeout ?? 30000, // 30 seconds
            createTimeout: poolConfig.createTimeout ?? 10000, // 10 seconds
            destroyTimeout: poolConfig.destroyTimeout ?? 5000, // 5 seconds
            idleTimeout: poolConfig.idleTimeout ?? 300000, // 5 minutes
            reapInterval: poolConfig.reapInterval ?? 60000, // 1 minute
            maxRetries: poolConfig.maxRetries ?? 3,
        };

        this.startReaping();
        this.ensureMinConnections();
        
        // BLOCKER-2 FIX: Register cleanup on process exit to prevent timer leak
        if (typeof process !== 'undefined') {
            const cleanup = async () => {
                if (!this.isClosing) {
                    await this.close().catch(console.error);
                }
            };
            process.once('beforeExit', cleanup);
            process.once('exit', cleanup);
            process.once('SIGINT', cleanup);
            process.once('SIGTERM', cleanup);
        }
    }

    private startReaping(): void {
        this.reapTimer = setInterval(() => {
            this.reapIdleConnections();
        }, this.config.reapInterval);
    }

    private async ensureMinConnections(): Promise<void> {
        const needed = this.config.minConnections - this.connections.length;
        if (needed > 0) {
            const promises = Array.from({ length: needed }, () => this.createConnection());
            await Promise.allSettled(promises);
        }
    }

    async acquire(): Promise<LibSQLConnection> {
        if (this.isClosing) {
            throw new DatabaseError('Connection pool is closing', 'POOL_CLOSING');
        }

        // Try to find an available connection
        const available = this.connections.find(conn => !conn.isActive);
        if (available) {
            available.isActive = true;
            available.lastUsed = Date.now();
            available.useCount++;
            return available;
        }

        // Create new connection if under limit
        if (this.connections.length < this.config.maxConnections) {
            try {
                const connection = await this.createConnection();
                connection.isActive = true;
                return connection;
            } catch (error) {
                // If creation fails, try to wait for an existing connection
            }
        }

        // Wait for a connection to become available
        return new Promise<LibSQLConnection>((resolve, reject) => {
            const timeout = setTimeout(() => {
                const index = this.waiting.findIndex(w => w.resolve === resolve);
                if (index >= 0) {
                    this.waiting.splice(index, 1);
                }
                reject(new DatabaseError(
                    `Connection acquire timeout after ${this.config.acquireTimeout}ms`,
                    'ACQUIRE_TIMEOUT'
                ));
            }, this.config.acquireTimeout);

            this.waiting.push({ resolve, reject, timeout });
        });
    }

    async release(connection: LibSQLConnection): Promise<void> {
        connection.isActive = false;
        connection.lastUsed = Date.now();

        // Serve waiting requests
        if (this.waiting.length > 0) {
            const waiter = this.waiting.shift()!;
            clearTimeout(waiter.timeout);
            connection.isActive = true;
            connection.useCount++;
            waiter.resolve(connection);
        }
    }

    private async createConnection(): Promise<LibSQLConnection> {
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => {
                reject(new DatabaseError(
                    `Connection creation timeout after ${this.config.createTimeout}ms`,
                    'CREATE_TIMEOUT'
                ));
            }, this.config.createTimeout);
        });

        try {
            const client = await Promise.race([
                this.createLibSQLClient(),
                timeoutPromise
            ]);

            const connection: LibSQLConnection = {
                id: this.generateConnectionId(),
                client,
                isActive: false,
                createdAt: Date.now(),
                lastUsed: Date.now(),
                useCount: 0,
                retryCount: 0,
            };

            this.connections.push(connection);
            return connection;

        } catch (error) {
            throw new DatabaseError(
                `Failed to create LibSQL connection: ${(error as Error).message}`,
                'CREATE_FAILED'
            );
        }
    }

    private async createLibSQLClient(): Promise<any> {
        try {
            // Dynamic import to avoid issues when @libsql/client is not installed
            const { createClient } = await import('@libsql/client');
            
            const clientConfig: any = {};

            // Handle different path types
            const path = this.dbConfig.path || ':memory:';
            
            if (path === ':memory:') {
                clientConfig.url = ':memory:';
            } else if (
                path.startsWith('http://') ||
                path.startsWith('https://') ||
                path.startsWith('libsql://')
            ) {
                clientConfig.url = path;
            } else {
                clientConfig.url = path.startsWith('file:') ? path : `file:${path}`;
            }

            // Add auth token if provided
            if ((this.dbConfig as any).authToken) {
                clientConfig.authToken = (this.dbConfig as any).authToken;
            }

            // Add sync URL if provided (for embedded replicas)
            if ((this.dbConfig as any).syncUrl) {
                clientConfig.syncUrl = (this.dbConfig as any).syncUrl;
            }

            return createClient(clientConfig);

        } catch (error) {
            throw new Error(
                'LibSQL client not found or failed to initialize. Install with: npm install @libsql/client'
            );
        }
    }

    private async destroyConnection(connection: LibSQLConnection): Promise<void> {
        const index = this.connections.indexOf(connection);
        if (index >= 0) {
            this.connections.splice(index, 1);
        }

        try {
            const timeoutPromise = new Promise<void>((resolve) => {
                setTimeout(() => resolve(), this.config.destroyTimeout);
            });

            const closePromise = connection.client.close?.() || Promise.resolve();

            await Promise.race([closePromise, timeoutPromise]);
        } catch (error) {
            console.warn(`Error destroying LibSQL connection ${connection.id}:`, error);
        }
    }

    private async reapIdleConnections(): Promise<void> {
        if (this.isClosing) return;

        const now = Date.now();
        const minConnectionsToKeep = this.config.minConnections;
        let connectionsKept = 0;

        const toDestroy: LibSQLConnection[] = [];

        for (const connection of this.connections) {
            if (connection.isActive) {
                connectionsKept++;
                continue;
            }

            const isIdle = now - connection.lastUsed > this.config.idleTimeout;
            
            if (isIdle && connectionsKept >= minConnectionsToKeep) {
                toDestroy.push(connection);
            } else {
                connectionsKept++;
            }
        }

        // Destroy idle connections
        await Promise.all(
            toDestroy.map(conn => this.destroyConnection(conn))
        );

        // Ensure we maintain minimum connections
        await this.ensureMinConnections();
    }

    async close(): Promise<void> {
        this.isClosing = true;

        if (this.reapTimer) {
            clearInterval(this.reapTimer);
        }

        // Reject all waiting requests
        this.waiting.forEach(({ reject, timeout }) => {
            clearTimeout(timeout);
            reject(new DatabaseError('Connection pool is closing', 'POOL_CLOSING'));
        });
        this.waiting.length = 0;

        // Close all connections
        await Promise.all(
            this.connections.map(conn => this.destroyConnection(conn))
        );
    }

    getStats() {
        return {
            totalConnections: this.connections.length,
            activeConnections: this.connections.filter(c => c.isActive).length,
            idleConnections: this.connections.filter(c => !c.isActive).length,
            waitingRequests: this.waiting.length,
            averageUseCount: this.connections.reduce((sum, c) => sum + c.useCount, 0) / this.connections.length || 0,
        };
    }

    private generateConnectionId(): string {
        return `libsql_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
}

// Factory function to create LibSQL pools when needed
export function createLibSQLPool(
    dbConfig: DBConfig, 
    poolConfig?: LibSQLPoolConfig
): LibSQLConnectionPool {
    return new LibSQLConnectionPool(dbConfig, poolConfig);
}