import type { DBConfig, Driver } from './types.js';
import { DatabaseError } from './errors.js';

export interface ConnectionHealth {
    isHealthy: boolean;
    lastHealthCheck: number;
    connectionCount: number;
    errorCount: number;
    lastError?: Error;
}

export interface PoolConfig {
    maxConnections?: number;
    maxIdleTime?: number;
    healthCheckInterval?: number;
    retryAttempts?: number;
    retryDelay?: number;
}

export interface ManagedConnection {
    id: string;
    driver: Driver;
    isActive: boolean;
    lastUsed: number;
    useCount: number;
    health: ConnectionHealth;
}

export class ConnectionManager {
    private connections = new Map<string, ManagedConnection>();
    private sharedConnections = new Map<string, ManagedConnection>();
    private poolConfig: Required<PoolConfig>;
    private healthCheckTimer?: NodeJS.Timeout;

    constructor(poolConfig: PoolConfig = {}) {
        this.poolConfig = {
            maxConnections: poolConfig.maxConnections ?? 10,
            maxIdleTime: poolConfig.maxIdleTime ?? 300000, // 5 minutes
            healthCheckInterval: poolConfig.healthCheckInterval ?? 30000, // 30 seconds
            retryAttempts: poolConfig.retryAttempts ?? 3,
            retryDelay: poolConfig.retryDelay ?? 1000,
        };

        this.startHealthMonitoring();
        
        // BLOCKER-1 FIX: Register cleanup on process exit to prevent timer leak
        if (typeof process !== 'undefined') {
            const cleanup = () => {
                if (this.healthCheckTimer) {
                    clearInterval(this.healthCheckTimer);
                    this.healthCheckTimer = undefined;
                }
            };
            process.once('beforeExit', cleanup);
            process.once('exit', cleanup);
            process.once('SIGINT', cleanup);
            process.once('SIGTERM', cleanup);
        }
    }

    private startHealthMonitoring(): void {
        this.healthCheckTimer = setInterval(() => {
            this.performHealthChecks();
            this.cleanupIdleConnections();
        }, this.poolConfig.healthCheckInterval);
    }

    private async performHealthChecks(): Promise<void> {
        const allConnections = [
            ...this.connections.values(),
            ...this.sharedConnections.values(),
        ];

        for (const connection of allConnections) {
            await this.checkConnectionHealth(connection);
        }
    }

    private async checkConnectionHealth(
        connection: ManagedConnection
    ): Promise<void> {
        try {
            // Simple health check query
            await connection.driver.query('SELECT 1');
            connection.health = {
                isHealthy: true,
                lastHealthCheck: Date.now(),
                connectionCount: connection.useCount,
                errorCount: connection.health.errorCount,
            };
        } catch (error) {
            connection.health = {
                isHealthy: false,
                lastHealthCheck: Date.now(),
                connectionCount: connection.useCount,
                errorCount: connection.health.errorCount + 1,
                lastError:
                    error instanceof Error ? error : new Error(String(error)),
            };

            // If connection is consistently unhealthy, remove it
            if (connection.health.errorCount >= 3) {
                await this.removeConnection(connection.id);
            }
        }
    }

    private cleanupIdleConnections(): void {
        const now = Date.now();
        const connectionsToRemove: string[] = [];

        for (const [id, connection] of this.connections) {
            if (
                !connection.isActive &&
                now - connection.lastUsed > this.poolConfig.maxIdleTime
            ) {
                connectionsToRemove.push(id);
            }
        }

        connectionsToRemove.forEach((id) => this.removeConnection(id));
    }

    async getConnection(
        config: DBConfig,
        shared: boolean = false
    ): Promise<ManagedConnection> {
        // Auto-detect shared connection from config if not explicitly set
        const isShared = shared || config.sharedConnection || false;
        const connectionKey = this.generateConnectionKey(config);

        // Check for existing shared connection
        if (isShared) {
            const existing = this.sharedConnections.get(connectionKey);
            if (existing && existing.health.isHealthy) {
                existing.lastUsed = Date.now();
                existing.useCount++;
                return existing;
            }
        }

        // Check pool limits
        if (this.connections.size >= this.poolConfig.maxConnections) {
            // Try to find an available connection
            for (const connection of this.connections.values()) {
                if (!connection.isActive && connection.health.isHealthy) {
                    connection.isActive = true;
                    connection.lastUsed = Date.now();
                    connection.useCount++;
                    return connection;
                }
            }
            throw new DatabaseError(
                `Connection pool exhausted. Maximum ${this.poolConfig.maxConnections} connections allowed.`,
                'CONNECTION_POOL_EXHAUSTED'
            );
        }

        // Create new connection with retry logic
        return await this.createConnectionWithRetry(
            config,
            connectionKey,
            isShared
        );
    }

    private async createConnectionWithRetry(
        config: DBConfig,
        connectionKey: string,
        shared: boolean
    ): Promise<ManagedConnection> {
        let lastError: Error;

        for (
            let attempt = 0;
            attempt < this.poolConfig.retryAttempts;
            attempt++
        ) {
            try {
                const connection = await this.createConnection(
                    config,
                    connectionKey,
                    shared
                );

                if (shared) {
                    this.sharedConnections.set(connectionKey, connection);
                } else {
                    this.connections.set(connection.id, connection);
                }

                return connection;
            } catch (error) {
                lastError =
                    error instanceof Error ? error : new Error(String(error));

                if (attempt < this.poolConfig.retryAttempts - 1) {
                    await this.delay(
                        this.poolConfig.retryDelay * (attempt + 1)
                    );
                }
            }
        }

        throw new DatabaseError(
            `Failed to create connection after ${
                this.poolConfig.retryAttempts
            } attempts: ${lastError!.message}`,
            'CONNECTION_CREATE_FAILED'
        );
    }

    private async createConnection(
        config: DBConfig,
        connectionKey: string,
        shared: boolean
    ): Promise<ManagedConnection> {
        // Use enhanced driver detection for better reliability
        const { detectDriver } = await import('./driver-detector.js');
        const detection = detectDriver(config);

        // Log warnings if any
        if (detection.warnings.length > 0) {
            console.warn('Driver detection warnings:', detection.warnings);
        }

        let driver: Driver | undefined;
        const driverType = detection.recommendedDriver;

        try {
            driver = await this.createDriverInstance(driverType, config);
        } catch (error) {
            // Try fallback drivers if primary fails
            if (detection.fallbackDrivers.length > 0) {
                console.warn(
                    `Primary driver '${driverType}' failed, trying fallbacks:`,
                    error
                );

                for (const fallbackDriver of detection.fallbackDrivers) {
                    try {
                        driver = await this.createDriverInstance(
                            fallbackDriver,
                            config
                        );
                        console.warn(
                            `Successfully fell back to '${fallbackDriver}' driver`
                        );
                        break;
                    } catch (fallbackError) {
                        console.warn(
                            `Fallback driver '${fallbackDriver}' also failed:`,
                            fallbackError
                        );
                    }
                }

                if (!driver) {
                    throw new DatabaseError(
                        `All drivers failed. Primary: ${driverType} - ${
                            (error as Error).message
                        }`,
                        'ALL_DRIVERS_FAILED'
                    );
                }
            } else {
                throw new DatabaseError(
                    `Failed to initialize driver '${driverType}': ${
                        (error as Error).message
                    }`,
                    'DRIVER_INIT_FAILED'
                );
            }
        }

        const connection: ManagedConnection = {
            id: shared ? connectionKey : this.generateConnectionId(),
            driver: driver!,
            isActive: true,
            lastUsed: Date.now(),
            useCount: 1,
            health: {
                isHealthy: true,
                lastHealthCheck: Date.now(),
                connectionCount: 1,
                errorCount: 0,
            },
        };

        // Perform initial health check
        try {
            await this.performHealthCheck(connection);
        } catch (error) {
            console.warn(
                `Initial health check failed for connection ${connection.id}:`,
                error
            );
            connection.health.isHealthy = false;
            connection.health.errorCount = 1;
        }

        return connection;
    }

    private async createDriverInstance(
        driverType: 'bun' | 'node',
        config: DBConfig
    ): Promise<Driver> {
        switch (driverType) {
            case 'bun':
                const { BunDriver } = await import('./drivers/bun.js');
                return new BunDriver(config);
            case 'node':
                const { NodeDriver } = await import('./drivers/node.js');
                return new NodeDriver(config);
            default:
                throw new Error(`Unknown driver: ${driverType}`);
        }
    }

    private async performHealthCheck(
        connection: ManagedConnection
    ): Promise<void> {
        try {
            // Simple health check query
            await connection.driver.query('SELECT 1');
            connection.health = {
                isHealthy: true,
                lastHealthCheck: Date.now(),
                connectionCount: connection.useCount,
                errorCount: connection.health.errorCount,
            };
        } catch (error) {
            connection.health = {
                isHealthy: false,
                lastHealthCheck: Date.now(),
                connectionCount: connection.useCount,
                errorCount: connection.health.errorCount + 1,
                lastError:
                    error instanceof Error ? error : new Error(String(error)),
            };
        }
    }

    async releaseConnection(
        connectionId: string,
        shared: boolean = false
    ): Promise<void> {
        const connection = shared
            ? this.sharedConnections.get(connectionId)
            : this.connections.get(connectionId);

        if (connection) {
            connection.isActive = false;
            connection.lastUsed = Date.now();
        }
    }

    private async removeConnection(connectionId: string): Promise<void> {
        const connection =
            this.connections.get(connectionId) ||
            this.sharedConnections.get(connectionId);

        if (connection) {
            try {
                await connection.driver.close();
            } catch (error) {
                console.warn(
                    `Error closing connection ${connectionId}:`,
                    error
                );
            }

            this.connections.delete(connectionId);
            this.sharedConnections.delete(connectionId);
        }
    }

    async closeAll(): Promise<void> {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
        }

        const allConnections = [
            ...this.connections.values(),
            ...this.sharedConnections.values(),
        ];

        await Promise.all(
            allConnections.map(async (connection) => {
                try {
                    await connection.driver.close();
                } catch (error) {
                    console.warn(
                        `Error closing connection ${connection.id}:`,
                        error
                    );
                }
            })
        );

        this.connections.clear();
        this.sharedConnections.clear();
    }

    getStats(): {
        totalConnections: number;
        activeConnections: number;
        sharedConnections: number;
        healthyConnections: number;
    } {
        const allConnections = [
            ...this.connections.values(),
            ...this.sharedConnections.values(),
        ];

        return {
            totalConnections: allConnections.length,
            activeConnections: allConnections.filter((c) => c.isActive).length,
            sharedConnections: this.sharedConnections.size,
            healthyConnections: allConnections.filter((c) => c.health.isHealthy)
                .length,
        };
    }

    private generateConnectionKey(config: DBConfig): string {
        const key = JSON.stringify({
            driver: config.driver,
            path: config.path,
            memory: config.memory,
            authToken: config.authToken ? 'present' : undefined,
            syncUrl: config.syncUrl,
        });
        return Buffer.from(key).toString('base64');
    }

    private generateConnectionId(): string {
        return `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

// Global connection manager instance
export const globalConnectionManager = new ConnectionManager();
