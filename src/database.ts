import { z } from 'zod';
import type {
    DBConfig,
    Driver,
    InferSchema,
    ConstrainedFieldDefinition,
    Row,
    PluginClass,
    PluginFactory,
} from './types';
import { DatabaseError } from './errors';
import type { SchemaConstraints } from './schema-constraints';
import { NodeDriver } from './drivers/node';
import { Collection } from './collection';
import { Registry } from './registry';
import { PluginManager, type Plugin } from './plugin-system';
import {
    globalConnectionManager,
    type ConnectionManager,
    type ManagedConnection,
} from './connection-manager';
import { detectDriver, type DriverDetectionResult } from './driver-detector';
import { Migrator, type MigrationInfo } from './migrator';
import type { UpgradeMap, SeedFunction } from './upgrade-types';

export class Database {
    private driver?: Driver;
    private managedConnection?: ManagedConnection;
    private config: DBConfig;
    private registry = new Registry();
    private collections = new Map<string, Collection<any>>();
    public plugins = new PluginManager();
    private connectionManager: ConnectionManager;
    private isLazy = false;
    public _dbId: string; // Unique ID for migration cache scoping

    constructor(config: DBConfig = {}) {
        this.config = config;
        this._dbId = `db_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this.connectionManager = config.connectionPool
            ? globalConnectionManager
            : globalConnectionManager;

        // Initialize driver based on connection sharing preference
        if (config.sharedConnection) {
            this.initializeLazy();
            // Driver is not created here for shared connections; it will be handled by ensureDriver.
        } else {
            this.driver = this.createDriver(config);
        }

        this.initializePlugins();
    }

    private initializeLazy(): void {
        this.isLazy = true;
        // Further lazy initialization logic can be added here if needed.
    }

    private async ensureDriver(): Promise<Driver> {
        if (this.driver) {
            return this.driver;
        }

        if (this.config.sharedConnection) {
            // Obtain a driver from the connection manager.
            // Note: this.driver on the Database instance is NOT set for shared connections;
            // the driver is managed per-operation or per-connection from the pool.
            this.managedConnection = await this.connectionManager.getConnection(
                this.config,
                true
            );
            return this.managedConnection.driver;
        } else {
            // Create dedicated driver
            try {
                this.driver = this.createDriver(this.config);
                return this.driver;
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error);
                throw new DatabaseError(
                    `Failed to create dedicated driver: ${message}`,
                    'DRIVER_CREATION_FAILED'
                );
            }
        }
    }

    private async initializePlugins(): Promise<void> {
        await this.plugins.executeHookSafe('onDatabaseInit', {
            collectionName: '',
            schema: {} as any,
            operation: 'database_init',
        });
    }

    private createDriver(config: DBConfig): Driver {
        const detection = detectDriver(config);

        // Log warnings for debugging
        if (detection.warnings.length > 0) {
            console.warn('Driver Detection Warnings:', detection.warnings);
        }

        const driverType = detection.recommendedDriver;

        try {
            return this.createDriverInstance(driverType, config, detection);
        } catch (error) {
            // Try fallback drivers if the primary driver fails
            for (const fallbackDriver of detection.fallbackDrivers) {
                try {
                    console.warn(
                        `Primary driver '${driverType}' failed, trying fallback: '${fallbackDriver}'`
                    );
                    return this.createDriverInstance(
                        fallbackDriver,
                        config,
                        detection
                    );
                } catch (fallbackError) {
                    console.warn(
                        `Fallback driver '${fallbackDriver}' also failed:`,
                        fallbackError
                    );
                }
            }

            // If all drivers fail, throw the original error with enhanced context
            const errorMessage =
                error instanceof Error ? error.message : String(error);
            throw new DatabaseError(
                `Failed to initialize database driver. ` +
                    `Tried '${driverType}' and fallbacks: ${detection.fallbackDrivers.join(
                        ', '
                    )}. ` +
                    `Error: ${errorMessage}. ` +
                    `Environment: ${detection.environment.runtime} (confidence: ${detection.environment.confidence}%). ` +
                    `Consider explicitly setting driver in config or check installation.`,
                'DRIVER_INIT_FAILED'
            );
        }
    }

    private createDriverInstance(
        driverType: 'bun' | 'node',
        config: DBConfig,
        detection: DriverDetectionResult
    ): Driver {
        switch (driverType) {
            case 'bun':
                // Dynamic import to avoid Node.js resolving bun: protocol during static analysis
                try {
                    const { BunDriver } = require('./drivers/bun');
                    return new BunDriver(config);
                } catch (e) {
                    const errorMessage =
                        e instanceof Error ? e.message : String(e);
                    throw new Error(
                        `BunDriver is only available in Bun runtime. ` +
                            `Current environment: ${detection.environment.runtime} ` +
                            `(confidence: ${detection.environment.confidence}%). ` +
                            `Error: ${errorMessage}`
                    );
                }
            case 'node':
                return new NodeDriver(config);
            default:
                throw new Error(`Unknown driver: ${driverType}`);
        }
    }

    collection<T extends z.ZodSchema>(
        name: string,
        schema?: T,
        options?: {
            primaryKey?: string;
            version?: number;
            indexes?: string[];
            constraints?: SchemaConstraints;
            constrainedFields?: {
                [fieldPath: string]: ConstrainedFieldDefinition;
            };
            upgrade?: UpgradeMap<InferSchema<T>>;
            seed?: SeedFunction<InferSchema<T>>;
        }
    ): Collection<T> {
        if (schema) {
            if (this.collections.has(name)) {
                throw new Error(`Collection '${name}' already exists`);
            }

            const collectionSchema = this.registry.register(
                name,
                schema,
                options
            );

            // Create collection with lazy driver resolution
            const collection = new Collection<T>(
                this.getDriverProxy(),
                collectionSchema,
                this.plugins,
                this // Pass database reference for upgrade functions
            );
            this.collections.set(name, collection);

            // Execute collection creation hook (non-blocking)
            this.plugins
                .executeHookSafe('onCollectionCreate', {
                    collectionName: name,
                    schema: collectionSchema,
                    operation: 'collection_create',
                })
                .catch(console.warn);

            return collection;
        }

        const existingCollection = this.collections.get(name);
        if (!existingCollection) {
            throw new Error(`Collection '${name}' not found`);
        }

        return existingCollection;
    }

    private getDriverProxy(): Driver {
        // Create a proxy that resolves the driver lazily
        return new Proxy({} as Driver, {
            get: (target, prop) => {
                if (this.driver) {
                    return (this.driver as any)[prop];
                }

                // Return async methods that ensure driver is initialized
                if (
                    prop === 'exec' ||
                    prop === 'query' ||
                    prop === 'transaction' ||
                    prop === 'close'
                ) {
                    return async (...args: any[]) => {
                        const driver = await this.ensureDriver();
                        return (driver as any)[prop](...args);
                    };
                }

                // Return sync methods that ensure driver is initialized
                if (
                    prop === 'execSync' ||
                    prop === 'querySync' ||
                    prop === 'closeSync'
                ) {
                    return (...args: any[]) => {
                        if (this.config.sharedConnection) {
                            throw new DatabaseError(
                                `Synchronous operations like '${String(
                                    prop
                                )}' are not supported when using a shared connection. Please use asynchronous methods instead.`,
                                'SYNC_WITH_SHARED_CONNECTION'
                            );
                        }
                        // Original logic for non-shared connections:
                        if (!this.driver) {
                            // For sync methods, we need the driver to be already initialized
                            // This path should ideally only be hit if sharedConnection is false
                            // and the constructor somehow failed to create the driver, or it was cleared.
                            this.driver = this.createDriver(this.config);
                        }
                        return (this.driver as any)[prop](...args);
                    };
                }

                // For other properties, try to get from current driver or throw
                if (this.driver) {
                    return (this.driver as any)[prop];
                }

                throw new Error(
                    `Driver not initialized and property ${String(
                        prop
                    )} accessed`
                );
            },
        });
    }

    async transaction<T>(fn: () => Promise<T>): Promise<T> {
        const context = {
            collectionName: '',
            schema: {} as any,
            operation: 'transaction',
        };

        await this.plugins.executeHookSafe('onBeforeTransaction', context);

        try {
            const driver = await this.ensureDriver();
            const result = await driver.transaction(fn);
            await this.plugins.executeHookSafe('onAfterTransaction', {
                ...context,
                result,
            });
            return result;
        } catch (error) {
            // Enhanced error recovery for transaction failures
            const transactionError =
                error instanceof Error ? error : new Error(String(error));

            try {
                await this.plugins.executeHookSafe('onTransactionError', {
                    ...context,
                    error: transactionError,
                });
            } catch (pluginError) {
                // If plugin error handling fails, log it but don't override the original error
                console.warn(
                    'Transaction error plugin hook failed:',
                    pluginError
                );
            }

            // Only wrap specific database-level errors, preserve application errors
            if (
                transactionError.message.includes('database is locked') ||
                transactionError.message.includes('busy') ||
                transactionError.message.includes('timeout')
            ) {
                throw new DatabaseError(
                    `Transaction failed due to database lock or timeout: ${transactionError.message}`,
                    'TRANSACTION_LOCK_TIMEOUT'
                );
            }

            if (
                transactionError.message.includes('rollback') ||
                transactionError.message.includes('abort')
            ) {
                throw new DatabaseError(
                    `Transaction was rolled back: ${transactionError.message}`,
                    'TRANSACTION_ROLLBACK'
                );
            }

            // Re-throw original error to preserve validation and application errors
            throw error;
        }
    }

    async close(): Promise<void> {
        await this.plugins.executeHookSafe('onDatabaseClose', {
            collectionName: '',
            schema: {} as any,
            operation: 'database_close',
        });

        if (this.managedConnection) {
            // Release managed connection back to pool
            await this.connectionManager.releaseConnection(
                this.managedConnection.id,
                true
            );
            this.managedConnection = undefined;
        } else if (this.driver) {
            await this.driver.close();
        }
    }

    /**
     * Synchronously closes the database connection.
     *
     * Important Notes:
     * - This method operates synchronously and therefore **does not execute asynchronous plugin hooks**
     *   (e.g., `onDatabaseClose`). For comprehensive cleanup including plugin hooks, use the
     *   asynchronous `close()` method.
     * - If using a shared connection (`config.sharedConnection: true`), this method cannot
     *   release the connection back to a pool synchronously. It will log a warning and clear
     *   its local reference to the managed connection, but the actual pool management might be affected.
     * - For dedicated connections (`config.sharedConnection: false`), it attempts to close the
     *   driver synchronously.
     *
     * @throws {DatabaseError} If called when `config.sharedConnection` is true.
     */
    closeSync(): void {
        if (this.config.sharedConnection) {
            throw new DatabaseError(
                "Synchronous operations like 'closeSync' are not supported when using a shared connection. Please use asynchronous 'close()'.",
                'SYNC_WITH_SHARED_CONNECTION'
            );
        }

        // Original logic for non-shared connections (this.driver should be set)
        // The this.managedConnection check below would only be relevant if, hypothetically,
        // a non-shared connection somehow ended up with a managedConnection, which is not standard.
        if (this.managedConnection) {
            console.warn(
                'Warning: CloseSync called on a DB with a managedConnection but not configured as shared. This is an inconsistent state.'
            );
            this.managedConnection = undefined; // Clear local ref
        } else if (this.driver) {
            this.driver.closeSync();
        }
    }

    // Plugin management methods
    use(pluginInput: Plugin | PluginClass | PluginFactory | any, options?: any): this {
        let plugin: Plugin;
        
        // Handle different plugin input types
        if (this.isPluginInstance(pluginInput)) {
            // Already a plugin instance
            plugin = pluginInput;
        } else if (this.isPluginClass(pluginInput)) {
            // Plugin class - instantiate it
            plugin = new pluginInput(options);
        } else if (this.isPluginFactory(pluginInput)) {
            // Plugin factory function - call it
            plugin = pluginInput(options);
        } else if (pluginInput && pluginInput.default) {
            // ES module with default export - try that
            return this.use(pluginInput.default, options);
        } else {
            throw new Error('Invalid plugin: must be Plugin instance, class, or factory function');
        }
        
        this.plugins.register(plugin);
        return this;
    }

    private isPluginInstance(obj: any): obj is Plugin {
        return obj && typeof obj === 'object' && typeof obj.name === 'string';
    }

    private isPluginClass(obj: any): obj is new (options?: any) => Plugin {
        return typeof obj === 'function' && obj.prototype && 
               (obj.prototype.name !== undefined || obj.prototype.constructor === obj);
    }

    private isPluginFactory(obj: any): obj is (options?: any) => Plugin {
        return typeof obj === 'function' && !obj.prototype;
    }

    unuse(pluginName: string): this {
        this.plugins.unregister(pluginName);
        return this;
    }

    getPlugin(name: string): Plugin | undefined {
        return this.plugins.getPlugin(name);
    }

    listPlugins(): Plugin[] {
        return this.plugins.listPlugins();
    }

    listCollections(): string[] {
        return this.registry.list();
    }

    async exec(sql: string, params?: any[]): Promise<void> {
        const driver = await this.ensureDriver();
        return driver.exec(sql, params);
    }

    async query(sql: string, params?: any[]): Promise<Row[]> {
        const driver = await this.ensureDriver();
        return driver.query(sql, params);
    }

    // Sync versions for backward compatibility
    /**
     * Executes a SQL command synchronously.
     *
     * Note: This is a synchronous operation and **does not execute asynchronous plugin hooks**
     * (e.g., `onBeforeQuery`, `onAfterQuery`). For plugin support, use the asynchronous `exec()` method.
     *
     * @param sql The SQL string to execute.
     * @param params Optional parameters for the SQL query.
     * @throws {DatabaseError} If called when `config.sharedConnection` is true.
     */
    execSync(sql: string, params?: any[]): void {
        if (this.config.sharedConnection) {
            throw new DatabaseError(
                "Synchronous operations like 'execSync' are not supported when using a shared connection. Please use asynchronous methods instead.",
                'SYNC_WITH_SHARED_CONNECTION'
            );
        }
        if (!this.driver) {
            // This logic is primarily for non-shared connections if the driver wasn't set in constructor.
            this.driver = this.createDriver(this.config);
        }
        return this.driver.execSync(sql, params);
    }

    /**
     * Executes a SQL query synchronously and returns the results.
     *
     * Note: This is a synchronous operation and **does not execute asynchronous plugin hooks**
     * (e.g., `onBeforeQuery`, `onAfterQuery`). For plugin support, use the asynchronous `query()` method.
     *
     * @param sql The SQL string to query.
     * @param params Optional parameters for the SQL query.
     * @returns An array of rows resulting from the query.
     * @throws {DatabaseError} If called when `config.sharedConnection` is true.
     */
    querySync(sql: string, params?: any[]): Row[] {
        if (this.config.sharedConnection) {
            throw new DatabaseError(
                "Synchronous operations like 'querySync' are not supported when using a shared connection. Please use asynchronous methods instead.",
                'SYNC_WITH_SHARED_CONNECTION'
            );
        }
        if (!this.driver) {
            // This logic is primarily for non-shared connections if the driver wasn't set in constructor.
            this.driver = this.createDriver(this.config);
        }
        return this.driver.querySync(sql, params);
    }

    // Connection management methods
    getConnectionStats() {
        return this.connectionManager.getStats();
    }

    async closeAllConnections(): Promise<void> {
        await this.connectionManager.closeAll();
    }

    async getMigrationStatus(): Promise<MigrationInfo[]> {
        const driver = await this.ensureDriver();
        const migrator = new Migrator(driver);
        return migrator.getMigrationStatus();
    }
}

export function createDB(config: DBConfig = {}): Database {
    return new Database(config);
}
