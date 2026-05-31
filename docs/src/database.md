**Overview**
The **Database** class is the central entry point for managing a SQLite (or Bun/Node) connection, registering collections, executing raw SQL, and orchestrating plugins and transactions. Internally, it:

1. Detects and initializes a low‐level **Driver** (e.g. `NodeDriver` or `BunDriver`).
2. Optionally uses a shared‐connection pool (`sharedConnection: true`) or a dedicated connection.
3. Exposes a `.collection(...)` method to register or retrieve **Collection** instances.
4. Wraps every operation with a **PluginManager** for hooks (`onDatabaseInit`, `onCollectionCreate`, `onBeforeQuery`, `onTransactionError`, etc.).
5. Provides async and sync variants for raw `exec`/`query` and `close`.
6. Supports explicit `transaction(fn)` for atomic operations.
7. Integrates with a global **ConnectionManager** when pooling is enabled.

Below is a deep dive into every method, the constructor logic, lazy driver resolution, plugin hooks, error handling, and realistic usage examples.

---

## Table of Contents

1. [Imports & Type Parameters](#imports--type-parameters)
2. [Class Properties](#class-properties)
3. [Constructor & Initial Connection Logic](#constructor--initial-connection-logic)

    - [`config.sharedConnection`](#configsharedconnection)
    - [`initializeLazy()`](#initializelazy)
    - [`initializePlugins()`](#initializeplugins)

4. [Driver Creation & Detection](#driver-creation--detection)

    - [`createDriver(config)`](#createdriverconfig)
    - [`createDriverInstance(driverType, config, detection)`](#createdriverinstancedrivertype-config-detection)
    - [`ensureDriver()`](#ensuredriver)

5. [Registering & Retrieving Collections](#registering--retrieving-collections)

    - [`collection(name, schema?, options?)`](#collectionname-schemat-options)
    - [Interaction with `Registry`](#interaction-with-registry)
    - [Lazy Driver Proxy](#lazy-driver-proxy)

6. [Lazy Driver Proxy Implementation](#lazy-driver-proxy-implementation)

    - [Proxy Traps for Async Methods (`exec`, `query`, `transaction`, `close`)](#proxy-traps-for-async-methods-exec-query-transaction-close)
    - [Proxy Traps for Sync Methods (`execSync`, `querySync`, `closeSync`)](#proxy-traps-for-sync-methods-execsync-querysync-closesync)
    - [Accessing Other Driver Properties](#accessing-other-driver-properties)

7. [Transactions](#transactions)

    - [`transaction(fn)`](#transactionfn)
    - [Error Wrapping & Plugin Hooks](#error-wrapping--plugin-hooks)

8. [Closing Connections](#closing-connections)

    - [`close()` (async)](#close-async)
    - [`closeSync()` (sync)](#closesync-sync)
    - [Shared‐Connection vs. Dedicated Connection Behavior](#shared-connection-vs-dedicated-connection-behavior)

9. [Plugin Management](#plugin-management)

    - [`use(plugin)`](#useplugin)
    - [`unuse(pluginName)`](#unusepluginname)
    - [`getPlugin(name)` & `listPlugins()`](#getpluginname--listplugins)
    - [Plugin Hooks Used in Database](#plugin-hooks-used-in-database)

10. [Raw SQL Execution](#raw-sql-execution)

    - [`exec(sql, params?)` (async)](#execsql-params-async)
    - [`query(sql, params?)` (async)](#querysql-params-async)
    - [`execSync(sql, params?)` (sync)](#execsyncsql-params-sync)
    - [`querySync(sql, params?)` (sync)](#querysyncsql-params-sync)

11. [Connection Management](#connection-management)

    - [`getConnectionStats()`](#getconnectionstats)
    - [`closeAllConnections()`](#closeallconnections)

12. [Utility: `createDB(config?)`](#utility-createdbconfig)
13. [Error Types & When They’re Thrown](#error-types--when-theyr-thrown)
14. [Practical Examples](#practical-examples)

    1. [Basic Instantiation](#basic-instantiation)
    2. [Registering a Collection](#registering-a-collection)
    3. [Performing CRUD via a Collection](#performing-crud-via-a-collection)
    4. [Raw SQL Execution](#raw-sql-execution-example)
    5. [Using Transactions](#using-transactions)
    6. [Plugin Hooks in Action](#plugin-hooks-in-action)
    7. [Shared Connection Pooling](#shared-connection-pooling)
    8. [Closing the Database](#closing-the-database)

---

## Imports & Type Parameters

```ts
import { z } from 'zod';
import type {
    DBConfig,
    Driver,
    InferSchema,
    ConstrainedFieldDefinition,
    Row,
} from './types';
import { DatabaseError } from './errors';
import type { SchemaConstraints } from './schema-constraints';
import { NodeDriver } from './drivers/node';
import { Collection } from './collection';
import { Registry } from './registry';
import { PluginManager, type Plugin } from './plugin-system';
import {
    getGlobalConnectionManager,
    type ConnectionManager,
    type ManagedConnection,
} from './connection-manager';
import { detectDriver, type DriverDetectionResult } from './driver-detector';
```

-   **`DBConfig`**

    -   Interface describing database configuration options (e.g. `filename`, `sharedConnection`, `connectionPool`, `driver`, `verbose`, etc.).

-   **`Driver`**

    -   Abstract interface that any low‐level driver (NodeDriver, BunDriver) implements. Methods include `exec`, `execSync`, `query`, `querySync`, `transaction`, `close`, `closeSync`.

-   **`InferSchema<T>`**

    -   The TypeScript type inferred from a Zod schema `T`. Used when registering collections.

-   **`ConstrainedFieldDefinition`**

    -   Defines how a field in a document maps to a native SQL column (unique, foreign key, index).

-   **`Row`**

    -   Type alias for a raw result row from `driver.query` or `driver.querySync`.

-   **`SchemaConstraints`**

    -   Legacy interface for constraints (now typically replaced by `constrainedFields`).

-   **`NodeDriver`**

    -   A concrete driver implementation for Node.js that uses `sqlite3` or `better‐sqlite3` under the hood.

-   **`Collection<T>`**

    -   The class we documented previously; represents a table of JSON documents.

-   **`Registry`**

    -   Maintains a record of registered collections and their schemas (allows retrieving schema later, enforcing unique collection names).

-   **`PluginManager` & `Plugin`**

    -   Manages lifecycle hooks and allows plugins to tap into database/collection events.

-   **`getGlobalConnectionManager()`, `ConnectionManager`, `ManagedConnection`**

    -   Support for pooling: `getGlobalConnectionManager()` returns a lazily-initialized singleton that creates, tracks, and releases connections. The manager is only instantiated when first accessed, not at module import time.

-   **`detectDriver(config)`**

    -   Inspects the runtime environment (Bun vs Node, available modules) and returns a `DriverDetectionResult` with a `recommendedDriver` (string `'bun'` or `'node'`) plus any `warnings` and `fallbackDrivers`.

---

## Class Properties

```ts
export class Database {
    private driver?: Driver;
    private managedConnection?: ManagedConnection;
    private config: DBConfig;
    private registry = new Registry();
    private collections = new Map<string, Collection<any>>();
    public plugins = new PluginManager();
    private connectionManager: ConnectionManager;
    private isLazy = false;
    // …
}
```

1. **`driver?: Driver`**

    - Holds a dedicated driver instance for non‐shared connections.
    - For `sharedConnection: false` (default), this is set in the constructor.
    - For `sharedConnection: true`, this remains `undefined` until `ensureDriver()` is first called.

2. **`managedConnection?: ManagedConnection`**

    - When `sharedConnection: true`, `ensureDriver()` obtains a `ManagedConnection` from `globalConnectionManager`.
    - `ManagedConnection` bundles a `driver` plus an `id` (to later release back to pool).

3. **`config: DBConfig`**

    - The configuration object passed into `new Database(config)`.
    - Key fields:

        - `sharedConnection: boolean` (default `false`)
        - `connectionPool: boolean` (default `false`)
        - `driver?`: literal override for driver type (`'bun'` or `'node'`)
        - `filename`: path to SQLite file (or `:memory:`)
        - any other driver‐specific options (`verbose`, `mode`, etc.).

4. **`registry = new Registry()`**

    - Tracks `collectionName → CollectionSchema<T>`.
    - Ensures duplicate collection names cannot be registered.

5. **`collections = new Map<string, Collection<any>>()`**

    - Stores actual `Collection<T>` instances already created.
    - Keyed by collection name.

6. **`plugins = new PluginManager()`**

    - Public property allowing `db.use(plugin)` or `db.unuse(pluginName)`.
    - Fires hooks such as:

        - `onDatabaseInit` (during constructor)
        - `onCollectionCreate` (after `.collection(name, schema, options)`)
        - `onBeforeTransaction`, `onAfterTransaction`, `onTransactionError`
        - `onDatabaseClose` (in `close()`)
        - Possibly `onBeforeQuery` / `onAfterQuery` (if implemented by driver’s `exec`/`query`, but not in this file).

7. **`connectionManager: ConnectionManager`**

    - Initialized via `getGlobalConnectionManager()` (lazy singleton — only created when first accessed).
    - Used for obtaining or releasing pooled connections.

8. **`isLazy = false`**

    - Becomes `true` if `sharedConnection` is enabled, signaling “don’t create a driver until first operation.”

---

## Constructor & Initial Connection Logic

```ts
constructor(config: DBConfig = {}) {
  this.config = config;
    this.connectionManager = getGlobalConnectionManager();

  // 1. Decide lazy vs. eager driver initialization
  if (config.sharedConnection) {
    this.initializeLazy();
    // Driver remains undefined until first use
  } else {
    this.driver = this.createDriver(config);
  }

  // 2. Fire onDatabaseInit plugin hook asynchronously
  this.initializePlugins();
}
```

1. **Store `config` & pick a `connectionManager`**

    - Uses `getGlobalConnectionManager()` which lazily initializes the global ConnectionManager singleton on first access. The manager is not created at module import time, keeping startup lightweight.

2. **`if (config.sharedConnection) { … } else { … }`**

    - **`config.sharedConnection: true`**

        - Calls `initializeLazy()`, which sets `isLazy = true`.
        - Does **not** call `createDriver(...)` immediately.
        - When any method needing a driver is invoked, `ensureDriver()` will fetch a connection from `connectionManager`.

    - **`config.sharedConnection: false` (default)**

        - Immediately calls `this.createDriver(config)`, instantiating a dedicated driver (e.g. `NodeDriver`).
        - Assigns it to `this.driver`.

3. **`initializePlugins()`**

    - Calls `await this.plugins.executeHookSafe('onDatabaseInit', { … })`.
    - Runs in background (constructor is not `async`, so this is a “fire‐and‐forget”).
    - Plugins that subscribe to `onDatabaseInit` can read or modify initial state.

4. **No Immediate Pool Allocation**

    - Even with `connectionPool: true`, the code never fetches a connection or driver until an operation (query, exec, or collection creation) demands it.

---

### `initializeLazy()`

```ts
private initializeLazy(): void {
  this.isLazy = true;
  // Additional lazy logic could be added in the future
}
```

-   Simply marks `isLazy = true`.
-   Signals that driver creation is deferred.

---

### `initializePlugins()`

```ts
private async initializePlugins(): Promise<void> {
  await this.plugins.executeHookSafe('onDatabaseInit', {
    collectionName: '',
    schema: {} as any,
    operation: 'database_init',
  });
}
```

-   Immediately after constructor, the Database fires the `onDatabaseInit` hook.
-   Hook arguments:

    -   `collectionName: ''` (empty, because no collection yet)
    -   `schema: {} as any` (no schema at database initialization)
    -   `operation: 'database_init'` (string identifier)

-   Any registered plugin can subscribe and run custom logic on database startup (e.g. logging, setting global state).

---

## Driver Creation & Detection

### `createDriver(config: DBConfig): Driver`

```ts
private createDriver(config: DBConfig): Driver {
  const detection = detectDriver(config);

  // 1. Log any warnings from driver detection
  if (detection.warnings.length > 0) {
    console.warn('Driver Detection Warnings:', detection.warnings);
  }

  const driverType = detection.recommendedDriver;

  try {
    return this.createDriverInstance(driverType, config, detection);
  } catch (error) {
    // 2. If primary driver fails, attempt fallbacks
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

    // 3. If all attempts fail, throw DatabaseError with details
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
```

1. **`detectDriver(config)`**

    - Analyzes:

        - `config.driver` override (if user explicitly sets `"bun"` or `"node"`).
        - The runtime environment (`process.versions.bun`, `process.versions.node`, etc.).
        - Whether the `bun:` protocol is available.
        - Returns:

            - `recommendedDriver`: `'bun'` or `'node'`.
            - `fallbackDrivers`: array of strings representing fallback choices in order.
            - `warnings`: a list of warning messages if detection is uncertain.
            - `environment: { runtime: string; confidence: number }`.

2. **Try Primary Driver**

    - `driverType = detection.recommendedDriver`.
    - Calls `createDriverInstance(driverType, config, detection)`.
    - If it succeeds, returns that `Driver`.

3. **On Failure, Attempt Fallbacks**

    - Loops over `detection.fallbackDrivers`.
    - For each `fallbackDriver`, calls `createDriverInstance(...)`.
    - If any fallback succeeds, immediately return that driver.
    - If all fail, wrap the original error in a `DatabaseError('DRIVER_INIT_FAILED')`.

4. **Error Classification**

    - The thrown `DatabaseError` includes detailed context:

        - Which drivers were tried.
        - Underlying error message.
        - The detected runtime and confidence.

    - This helps the user diagnose environment mismatches or missing dependencies.

---

### `createDriverInstance(driverType, config, detection)`

```ts
private createDriverInstance(
  driverType: 'bun' | 'node',
  config: DBConfig,
  detection: DriverDetectionResult
): Driver {
  switch (driverType) {
    case 'bun':
      try {
        const { BunDriver } = require('./drivers/bun');
        return new BunDriver(config);
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
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
```

1. **`driverType === 'bun'`**

    - Attempts a dynamic `require('./drivers/bun')`.
    - If that file or the `bun:` protocol isn’t available, it throws.
    - Catches the error and rethrows a more descriptive `Error(...)` indicating that BunDriver only works under Bun.

2. **`driverType === 'node'`**

    - Immediately returns a new `NodeDriver(config)`.
    - `NodeDriver` in `./drivers/node` typically wraps `better‐sqlite3` or the official `sqlite3` module.

3. **Fallback**

    - In case `driverType` is unexpected, an `Error('Unknown driver: ...')` is thrown.

---

### `ensureDriver()`

```ts
private async ensureDriver(): Promise<Driver> {
  if (this.driver) {
    // Already have a dedicated driver
    return this.driver;
  }

  if (this.config.sharedConnection) {
    // 1. Fetch a pooled connection from ConnectionManager
    this.managedConnection = await this.connectionManager.getConnection(
      this.config,
      true // “true” indicates “shared” so it stays in pool until closed
    );
    return this.managedConnection.driver;
  } else {
    // 2. Create a dedicated driver if somehow driver is missing
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
```

-   **Purpose**

    -   Centralizes logic for obtaining a usable `Driver` instance, whether dedicated or pooled.
    -   Called internally by proxy methods for every async operation requiring a driver.

-   **Flow**

    1. **If `this.driver` already exists** (non‐shared configuration, or has been set previously), return it immediately.
    2. **If `config.sharedConnection` is `true`** and no dedicated driver exists:

        - Call `await this.connectionManager.getConnection(this.config, true)`.

            - The boolean `true` indicates “we want to hold onto this connection until explicitly released (e.g. on `close()`).”

        - Store returned `ManagedConnection` in `this.managedConnection`.
        - Return `this.managedConnection.driver`.

    3. **Else** (no driver, and `sharedConnection: false`):

        - Attempt to create a dedicated driver via `this.createDriver(this.config)`.
        - Store it in `this.driver` and return it.
        - On error, wrap in `DatabaseError('DRIVER_CREATION_FAILED')`.

-   **Note**

    -   After a pooled connection is acquired once, subsequent calls to `ensureDriver()` will find `this.managedConnection.driver` and return it (unless you `close()` or `releaseConnection` clears it).

---

## Registering & Retrieving Collections

```ts
collection<T extends z.ZodSchema>(
  name: string,
  schema?: T,
  options?: {
    primaryKey?: string;
    indexes?: string[];
    constraints?: SchemaConstraints;
    constrainedFields?: { [fieldPath: string]: ConstrainedFieldDefinition };
  }
): Collection<T> {
  if (schema) {
    // 1. Register new collection if schema is provided
    if (this.collections.has(name)) {
      throw new Error(`Collection '${name}' already exists`);
    }

    const collectionSchema = this.registry.register(
      name,
      schema,
      options
    );

    // 2. Create a new Collection<T> with a lazy‐driver proxy
    const collection = new Collection<T>(
      this.getDriverProxy(),
      collectionSchema,
      this.plugins
    );
    this.collections.set(name, collection);

    // 3. Fire onCollectionCreate hook (async)
    this.plugins
      .executeHookSafe('onCollectionCreate', {
        collectionName: name,
        schema: collectionSchema,
        operation: 'collection_create',
      })
      .catch(console.warn);

    return collection;
  }

  // 4. No schema provided → retrieve existing collection
  const existingCollection = this.collections.get(name);
  if (!existingCollection) {
    throw new Error(`Collection '${name}' not found`);
  }
  return existingCollection;
}
```

-   **When `schema` is provided**

    1. **Duplicate‐Name Check**

        - If `collections.has(name)`, throw `Error("Collection 'name' already exists")`. Prevents overwriting.

    2. **Register Schema**

        - Calls `this.registry.register(name, schema, options)`.
        - Internally, `Registry` stores a `CollectionSchema<T>` object:

            ```ts
            interface CollectionSchema<S> {
                name: string;
                schema: z.ZodObject<any>;
                primaryKey?: string;
                indexes?: string[];
                constraints?: SchemaConstraints;
                constrainedFields?: {
                    [fieldPath: string]: ConstrainedFieldDefinition;
                };
            }
            ```

        - Returns the newly created `collectionSchema`.

    3. **Instantiate `Collection<T>`**

        - Passes **`getDriverProxy()`** (not a raw driver) so that the collection uses a proxy that will call `ensureDriver()` under the hood.
        - `collectionSchema` provides table‐creation SQL and Zod schema.
        - `this.plugins` is forwarded so that every Collection operation also triggers plugin hooks.
        - Stores the new `collection` instance in `this.collections`.

    4. **Fire `onCollectionCreate` Hook**

        - Plugins can listen to this event and run code after a collection is registered (e.g. auto‐populate with default data).

-   **When `schema` is omitted (undefined)**

    1. Attempt to retrieve an existing collection from `this.collections`.
    2. If no such collection exists, throw `Error("Collection 'name' not found")`.
    3. Return the existing `Collection<T>`.

-   **Notes**

    -   Because you pass `getDriverProxy()` to `new Collection(...)`, creating a collection does not immediately force driver initialization, even if `sharedConnection: false`. The proxy’s first method call will call `ensureDriver()`.
    -   You can call `.collection('users', userSchema, { constrainedFields: {...} })` as early as you want—before executing any queries. The collection’s constructor will still run table‐creation SQL synchronously (because `Collection.createTable()` uses `driver.execSync(...)` via the proxy).

---

## Lazy Driver Proxy Implementation

```ts
private getDriverProxy(): Driver {
  return new Proxy({} as Driver, {
    get: (target, prop) => {
      if (this.driver) {
        return (this.driver as any)[prop];
      }

      // Async methods
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

      // Sync methods
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
          if (!this.driver) {
            // Create driver now for non‐shared connections
            this.driver = this.createDriver(this.config);
          }
          return (this.driver as any)[prop](...args);
        };
      }

      // Other properties or methods: if driver exists, forward, else throw
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
```

### Proxy Traps for Async Methods (`exec`, `query`, `transaction`, `close`)

-   When you attempt to call `driver.exec(...)`, the proxy intercepts `prop === 'exec'`.
-   It returns an **async function** `(…args) => { const driver = await ensureDriver(); return driver.exec(...args); }`.
-   Calling `await driver.exec(...)` for the first time triggers `ensureDriver()` → either returns existing `this.driver` or obtains a pooled `ManagedConnection` or creates a new dedicated driver.
-   After that, `this.driver` (or `this.managedConnection.driver`) exists, so subsequent `.exec()` calls forward directly to the low‐level driver method.

The same pattern applies to:

-   `query(...)` → calls `driver.query(...)`.
-   `transaction(fn)` → calls `driver.transaction(fn)`.
-   `close()` → calls `driver.close()`.

### Proxy Traps for Sync Methods (`execSync`, `querySync`, `closeSync`)

-   Only allowed when `sharedConnection: false`. If `sharedConnection: true`, immediately throw `DatabaseError('SYNC_WITH_SHARED_CONNECTION')`.
-   If `this.driver` is not yet set, create a dedicated driver synchronously via `this.createDriver(this.config)`.
-   Then call `driver.execSync(...)` / `driver.querySync(...)` / `driver.closeSync(...)`.

### Accessing Other Driver Properties

-   If you attempt to access any other property or method (e.g. `driver.filename`, `driver.someCustomMethod()`) and `this.driver` is already initialized, the proxy simply returns `(this.driver as any)[prop]`.
-   If `this.driver` is `undefined` and `prop` is neither an async method nor a sync method, the proxy throws `Error("Driver not initialized and property 'prop' accessed")`.

---

## Transactions

```ts
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
    const transactionError =
      error instanceof Error ? error : new Error(String(error));

    try {
      await this.plugins.executeHookSafe('onTransactionError', {
        ...context,
        error: transactionError,
      });
    } catch (pluginError) {
      console.warn(
        'Transaction error plugin hook failed:',
        pluginError
      );
    }

    // Wrap specific database errors
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

    // Re‐throw anything else
    throw error;
  }
}
```

1. **`onBeforeTransaction` Hook**

    - Fired before beginning a transaction.
    - `context`:

        ```ts
        {
          collectionName: '',
          schema: {} as any,
          operation: 'transaction'
        }
        ```

2. **`driver.transaction(fn)`**

    - Most drivers (NodeDriver, BunDriver) implement `transaction(fn)` as:

        1. `BEGIN TRANSACTION`
        2. Invoke `await fn()` (your callback where you do inserts/updates/etc.)
        3. If `fn()` resolves successfully → `COMMIT` → return `fn()`’s result.
        4. If `fn()` throws → `ROLLBACK` → rethrow the error.

3. **`onAfterTransaction` Hook**

    - Fired only if `driver.transaction(fn)` resolves → wrap `context` with `{ ...context, result }`.
    - Plugins can inspect the result of the transaction.

4. **Error Handling & Hooks**

    - If `driver.transaction(fn)` rejects:

        1. Normalize the thrown value to `Error` (`transactionError`).
        2. Fire `onTransactionError` hook (catches plugin errors, logs them, but does not override the original error).
        3. Inspect `transactionError.message`:

            - If it contains `"database is locked"`, `"busy"`, or `"timeout"`, throw a new `DatabaseError('TRANSACTION_LOCK_TIMEOUT')`.
            - If it contains `"rollback"` or `"abort"`, throw a new `DatabaseError('TRANSACTION_ROLLBACK')`.
            - Otherwise rethrow the original error so that validation or business logic errors bubble up unchanged.

5. **Example Error Cases**

    - If two overlapping transactions collide on the same SQLite file, SQLite might respond with `SQLITE_BUSY: database is locked`. That is mapped to `DatabaseError('TRANSACTION_LOCK_TIMEOUT')`.
    - If your callback manually throws `new Error('User-defined error')`, neither `"database is locked"` nor `"rollback"` substrings match, so the original `Error('User-defined error')` is rethrown.

---

## Closing Connections

### `close()` (async)

```ts
async close(): Promise<void> {
  await this.plugins.executeHookSafe('onDatabaseClose', {
    collectionName: '',
    schema: {} as any,
    operation: 'database_close',
  });

  if (this.managedConnection) {
    // 1. Release pooled connection back into pool
    await this.connectionManager.releaseConnection(
      this.managedConnection.id,
      true
    );
    this.managedConnection = undefined;
  } else if (this.driver) {
    // 2. Close dedicated driver
    await this.driver.close();
  }
}
```

1. **`onDatabaseClose` Hook**

    - Notifies plugins that the database is closing.
    - Plugins can flush caches, write logs, etc.

2. **If Using Pooled Connections (`managedConnection` exists)**

    - Call `connectionManager.releaseConnection(managedConnection.id, true)`.

        - The boolean `true` indicates the release came from `close()`, not an error.

    - Set `this.managedConnection = undefined`.

3. **Else If Dedicated Driver Exists (`this.driver`)**

    - Call `await this.driver.close()`.
    - After driver‐specific cleanup (closing file descriptors, freeing memory), the driver is gone.

4. **If Neither Exists**

    - Nothing to do. It’s safe to call `close()` multiple times.

---

### `closeSync()` (sync)

```ts
closeSync(): void {
  if (this.config.sharedConnection) {
    throw new DatabaseError(
      "Synchronous operations like 'closeSync' are not supported when using a shared connection. Please use asynchronous 'close()'.",
      'SYNC_WITH_SHARED_CONNECTION'
    );
  }

  if (this.managedConnection) {
    console.warn(
      'Warning: CloseSync called on a DB with a managedConnection but not configured as shared. This is an inconsistent state.'
    );
    this.managedConnection = undefined;
  } else if (this.driver) {
    this.driver.closeSync();
  }
}
```

-   **Errors**

    -   If `sharedConnection: true`, always throw `DatabaseError('SYNC_WITH_SHARED_CONNECTION')`.
    -   The rationale: releasing a pooled connection synchronously could stall, hang, or cause pool corruption; therefore disallowed.

-   **Behavior**

    1. If `this.managedConnection` is set despite `sharedConnection: false`, log a warning and discard it. This is “inconsistent” but attempts to recover gracefully.
    2. If `this.driver` exists, call `driver.closeSync()`. That typically calls `statement.finalize()` and closes file descriptors via synchronous APIs.
    3. If neither exists, do nothing.

---

## Plugin Management

The `Database` class extends plugin capabilities via its `PluginManager` instance.

### `use(plugin: Plugin): this`

```ts
use(plugin: Plugin): this {
  this.plugins.register(plugin);
  return this;
}
```

-   Registers the plugin under `plugin.name` (every `Plugin` must expose a unique `name: string`).

-   Plugins can subscribe to lifecycle hooks:

    -   `onDatabaseInit`
    -   `onCollectionCreate`
    -   `onBeforeTransaction`, `onAfterTransaction`, `onTransactionError`
    -   `onDatabaseClose`
    -   Potentially other hooks if implemented by driver (like `onBeforeQuery`, but not in this file).

-   Returns the same `Database` instance, enabling chaining:

    ```ts
    db.use(pluginA).use(pluginB);
    ```

### `unuse(pluginName: string): this`

```ts
unuse(pluginName: string): this {
  this.plugins.unregister(pluginName);
  return this;
}
```

-   Unregisters a plugin by its `name`.
-   If no plugin with that name exists, no‐op.
-   Returns `this` for chaining.

### `getPlugin(name: string): Plugin | undefined`

```ts
getPlugin(name: string): Plugin | undefined {
  return this.plugins.getPlugin(name);
}
```

-   Returns the plugin instance if registered, else `undefined`.

### `listPlugins(): Plugin[]`

```ts
listPlugins(): Plugin[] {
  return this.plugins.listPlugins();
}
```

-   Returns an array of all currently registered `Plugin` instances, in registration order.

### Plugin Hooks Used in `Database`

| Hook Name             | When Fired                                                           | Payload Example                                                                |
| --------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `onDatabaseInit`      | Immediately after `new Database(config)`                             | `{ collectionName: '', schema: {}, operation: 'database_init' }`               |
| `onCollectionCreate`  | After `collection(name, schema, options)` registers a new collection | `{ collectionName: 'users', schema: {...}, operation: 'collection_create' }`   |
| `onBeforeTransaction` | Right before a `database.transaction(fn)` begins                     | `{ collectionName: '', schema: {}, operation: 'transaction' }`                 |
| `onAfterTransaction`  | After `driver.transaction(fn)` resolves successfully                 | `{ collectionName: '', schema: {}, operation: 'transaction', result: <T> }`    |
| `onTransactionError`  | If `driver.transaction(fn)` rejects                                  | `{ collectionName: '', schema: {}, operation: 'transaction', error: <Error> }` |
| `onDatabaseClose`     | Right before closing or releasing connections                        | `{ collectionName: '', schema: {}, operation: 'database_close' }`              |

---

## Raw SQL Execution

### `exec(sql: string, params?: any[]): Promise<void>` (async)

```ts
async exec(sql: string, params?: any[]): Promise<void> {
  const driver = await this.ensureDriver();
  return driver.exec(sql, params);
}
```

-   **Purpose**: Execute arbitrary SQL (e.g. `CREATE TABLE`, `INSERT`, `UPDATE`, `DELETE`), ignoring any returned rows.
-   **Behavior**:

    1. Calls `ensureDriver()` to obtain or create a driver (dedicated or pooled).
    2. Calls `driver.exec(sql, params)`. Returns a `Promise<void>`.

-   **Throws**:

    -   Any driver‐thrown error (wrapped by driver, e.g. syntax errors, constraint violations).

### `query(sql: string, params?: any[]): Promise<Row[]>` (async)

```ts
async query(sql: string, params?: any[]): Promise<Row[]> {
  const driver = await this.ensureDriver();
  return driver.query(sql, params);
}
```

-   **Purpose**: Execute `SELECT`‐style SQL and return raw rows.
-   **Behavior**:

    1. Ensures driver via `await this.ensureDriver()`.
    2. Calls `driver.query(sql, params)`, which resolves to an array of `Row` objects (`Row` is a `Record<string, any>`).

-   **Throws**:

    -   Any driver error (e.g. malformed SQL, out‐of‐bounds).

### `execSync(sql: string, params?: any[]): void` (sync)

```ts
execSync(sql: string, params?: any[]): void {
  if (this.config.sharedConnection) {
    throw new DatabaseError(
      "Synchronous operations like 'execSync' are not supported when using a shared connection. Please use asynchronous methods instead.",
      'SYNC_WITH_SHARED_CONNECTION'
    );
  }
  if (!this.driver) {
    // Create a dedicated driver if it hasn’t been created yet
    this.driver = this.createDriver(this.config);
  }
  return this.driver.execSync(sql, params);
}
```

-   **Purpose**: Synchronously execute SQL, typically used in scripts or when plugin hooks are not needed.
-   **Behavior**:

    1. If `sharedConnection: true`, immediately throw `DatabaseError('SYNC_WITH_SHARED_CONNECTION')`.
    2. If `this.driver` is missing, call `createDriver(this.config)` to get a dedicated driver.
    3. Call `driver.execSync(sql, params)`. Return `void`.

-   **Throws**:

    -   `DatabaseError('SYNC_WITH_SHARED_CONNECTION')` if pooling is in use.
    -   Any synchronous driver error (`SyntaxError`, constraint violations, etc.).

### `querySync(sql: string, params?: any[]): Row[]` (sync)

```ts
querySync(sql: string, params?: any[]): Row[] {
  if (this.config.sharedConnection) {
    throw new DatabaseError(
      "Synchronous operations like 'querySync' are not supported when using a shared connection. Please use asynchronous methods instead.",
      'SYNC_WITH_SHARED_CONNECTION'
    );
  }
  if (!this.driver) {
    this.driver = this.createDriver(this.config);
  }
  return this.driver.querySync(sql, params);
}
```

-   **Purpose**: Synchronously fetch rows.
-   **Behavior**:

    1. If `sharedConnection: true`, throw `DatabaseError('SYNC_WITH_SHARED_CONNECTION')`.
    2. Ensure `this.driver` is set (create if needed).
    3. Call `driver.querySync(sql, params)` → `Row[]`.

-   **Throws**:

    -   `DatabaseError('SYNC_WITH_SHARED_CONNECTION')` if pooling is in use.
    -   Any driver‐level error on `querySync`.

---

## Connection Management

### `getConnectionStats()`

```ts
getConnectionStats() {
  return this.connectionManager.getStats();
}
```

-   **Purpose**: Expose statistics about the connection pool.
-   **Returns**: The result of `connectionManager.getStats()`, which typically includes:

    -   Number of open connections.
    -   Number of idle connections.
    -   Pool configuration limits (max/min).

### `closeAllConnections(): Promise<void>`

```ts
async closeAllConnections(): Promise<void> {
  await this.connectionManager.closeAll();
}
```

-   **Purpose**: Force‐close **every** pooled connection managed by `globalConnectionManager`.
-   **Typically Used**: In shutdown scripts for long‐running services, to ensure no “dangling” connections remain.

---

## Utility: `createDB(config?: DBConfig)`

```ts
export function createDB(config: DBConfig = {}): Database {
    return new Database(config);
}
```

-   Simple helper to avoid typing `new Database(...)`.
-   Equivalent to `const db = new Database(config)`.

---

## Error Types & When They’re Thrown

1. **`DatabaseError`**

    - Thrown when driver creation fails (`DRIVER_INIT_FAILED`, `DRIVER_CREATION_FAILED`).
    - Thrown when attempting sync operations in shared‐connection mode (`SYNC_WITH_SHARED_CONNECTION`).
    - Thrown when a transaction fails due to lock/timeout (`TRANSACTION_LOCK_TIMEOUT`, `TRANSACTION_ROLLBACK`).
    - Thrown if any synchronous close is invoked incorrectly.

2. **`Error`**

    - Generic JavaScript `Error` is used in some cases (e.g. “Collection ‘name’ already exists”).

3. **Driver‐Specific Errors**

    - If the underlying driver (e.g. `NodeDriver`) throws a low‐level error (e.g. SQL syntax error, file not found), it bubbles up unless explicitly caught and wrapped by `DatabaseError`.

---

## Practical Examples

Below are step‐by‐step examples demonstrating common usage patterns.

---

### 1. Basic Instantiation

```ts
import { createDB } from './database';
import path from 'path';

async function main() {
    // A. Dedicated connection, file‐based (default)
    const db1 = createDB({
        filename: path.resolve(__dirname, 'mydb.sqlite'),
        sharedConnection: false, // default: each Database gets its own Connection
        connectionPool: false, // no pooling
        // any other driver‐specific options here
    });

    // B. Dedicated connection, memory‐only
    const db2 = createDB({
        filename: ':memory:',
        sharedConnection: false,
        connectionPool: false,
    });

    // C. Shared connection (lazy connection, pooling disabled)
    const db3 = createDB({
        filename: path.resolve(__dirname, 'shared.sqlite'),
        sharedConnection: true,
        connectionPool: false,
    });

    // D. Shared + Pooled (lazy, then pooled)
    const db4 = createDB({
        filename: path.resolve(__dirname, 'pooled.sqlite'),
        sharedConnection: true,
        connectionPool: true,
        poolSize: 10, // hypothetical option passed to connectionManager
    });
}
```

-   **`db1` and `db2`**:

    -   Immediately in the constructor: `this.driver = this.createDriver(config)`.
    -   Under the hood, `createDriver` runs `detectDriver()`, finds `'node'`, and instantiates `new NodeDriver(config)`.
    -   `db1.driver` is set.

-   **`db3` and `db4`**:

    -   In constructor, `config.sharedConnection === true`, so `initializeLazy()` sets `isLazy = true`.
    -   `this.driver` remains `undefined`.
    -   No SQL file is opened until first call to `db3.exec(...)` or `db3.collection(...)`.

---

### 2. Registering a Collection

```ts
import { z } from 'zod';

// 1. Define a Zod schema for “User”
const userSchema = z.object({
    id: z.string(), // required
    name: z.string().min(1),
    email: z.string().email(),
    age: z.number().int().nonnegative(),
    createdAt: z.date(),
    updatedAt: z.date(),
});

// 2. Create DB (dedicated connection)
const db = createDB({ filename: 'app.sqlite' });

// 3. Register “users” collection
const users = db.collection('users', userSchema, {
    // optional: specify a unique index on “email”
    constrainedFields: {
        email: { type: 'unique' },
    },
});

// Internally:
// A. registry.register('users', userSchema, { constrainedFields: { email: … } });
// B. getDriverProxy() → returns a Proxy<Driver>
// C. new Collection(getDriverProxy(), collectionSchema, db.plugins)
//    → Collection constructor calls createTable():
//      driver.execSync(`CREATE TABLE IF NOT EXISTS users…`)
//      driver.execSync(`CREATE UNIQUE INDEX idx_users_email ON users(email)`)
// D. onCollectionCreate hook is fired asynchronously.
```

-   **After this**, the `users` variable is a fully functional `Collection<z.infer<typeof userSchema>>`.
-   The `users` table now exists with:

    -   `_id TEXT PRIMARY KEY`
    -   `doc TEXT NOT NULL` (JSON)
    -   `email TEXT UNIQUE` (for uniqueness checks, indexing).

---

### 3. Performing CRUD via a Collection

```ts
async function crudExample() {
    // A. Insert a new user
    const alice = await users.insert({
        name: 'Alice',
        email: 'alice@example.com',
        age: 28,
        // id is omitted → auto‐generated via UUID
        // createdAt/updatedAt handled by a timestamp plugin if registered
    });
    console.log('Inserted:', alice);
    // e.g. { id: 'uuid‐xxx', name: 'Alice', email: 'alice@example.com', age: 28, createdAt: Date, updatedAt: Date }

    // B. Query all users older than 18
    const adults = await users
        .where('age')
        .gt(18)
        .orderBy('age', 'desc')
        .toArray();
    console.log('Adults:', adults);

    // C. Find by ID
    const foundAlice = await users.findById(alice.id);
    console.log('Found by ID:', foundAlice);

    // D. Update via put()
    const updatedAlice = await users.put(alice.id, { age: 29 });
    console.log('Updated age:', updatedAlice);

    // E. Upsert (replace or insert)
    const upsertedAlice = await users.upsert(alice.id, {
        name: 'Alice Updated',
        email: 'alice_new@example.com',
        age: 30,
        createdAt: new Date(),
        updatedAt: new Date(),
    });
    console.log('Upserted:', upsertedAlice);

    // F. Delete
    await users.delete(alice.id);
    console.log('Deleted Alice');

    // G. Count, first, toArray
    const totalCount = await users.count();
    const firstUser = await users.first();
    const allUsers = await users.toArray();
    console.log({ totalCount, firstUser, allUsers });
}
```

-   Every method validates against the Zod schema.
-   Unique constraint on `email` will cause `users.insert({ email: 'alice@example.com' })` to throw `UniqueConstraintError` if that email already exists.
-   `put(id, doc)` requires the document to exist; otherwise throws `NotFoundError`.

---

### 4. Raw SQL Execution Example

```ts
async function rawSQLExample() {
    // 1. Creating a custom table outside of collections
    await db.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      action TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );
  `);

    // 2. Inserting a row
    await db.exec(
        'INSERT INTO audit_logs (id, userId, action, timestamp) VALUES (?, ?, ?, ?)',
        ['log1', 'alice‐uuid', 'USER_CREATED', new Date().toISOString()]
    );

    // 3. Querying rows
    const rows = await db.query('SELECT * FROM audit_logs WHERE userId = ?', [
        'alice‐uuid',
    ]);
    console.log('Audit logs for Alice:', rows);

    // 4. Updating
    await db.exec('UPDATE audit_logs SET action = ? WHERE id = ?', [
        'USER_UPDATED',
        'log1',
    ]);

    // 5. Deleting
    await db.exec('DELETE FROM audit_logs WHERE id = ?', ['log1']);
}
```

-   If you call `db.exec` or `db.query` before any collections are registered, the driver is still lazily initialized (via proxy).
-   In `sharedConnection: true` mode, `db.exec(...)` may pull a pooled connection from `connectionManager`.

---

### 5. Using Transactions

```ts
async function transactionalExample() {
    try {
        const result = await db.transaction<void>(async () => {
            // A. Insert User
            const bob = await users.insert({
                name: 'Bob',
                email: 'bob@example.com',
                age: 35,
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            // B. Insert Audit Log row for Bob
            await db.exec(
                'INSERT INTO audit_logs (id, userId, action, timestamp) VALUES (?, ?, ?, ?)',
                [
                    crypto.randomUUID(),
                    bob.id,
                    'USER_CREATED',
                    new Date().toISOString(),
                ]
            );

            // C. If we want to conditionally roll back:
            if (bob.email === 'forbidden@example.com') {
                throw new Error('Disallowed email'); // Causes rollback
            }

            // If no errors, transaction will COMMIT
        });
        console.log('Transaction succeeded');
    } catch (err) {
        console.error('Transaction failed:', err);
        // If the error message included “database is locked,” you might get a DatabaseError('TRANSACTION_LOCK_TIMEOUT').
        // If “Disallowed email” occurred, you get a plain Error('Disallowed email') because it doesn’t match lock/timeout checks.
    }
}
```

-   **Flow**

    1. `db.transaction(fn)` calls `onBeforeTransaction` hook.
    2. Ensures driver via `ensureDriver()`.
    3. Calls `driver.transaction(fn)`, wrapping `BEGIN`/`COMMIT`/`ROLLBACK`.
    4. If `fn()` resolves → `onAfterTransaction` hook → COMMIT → returns.
    5. If `fn()` rejects → `ROLLBACK` → `onTransactionError` hook → wrap specific DB errors or rethrow original.

---

### 6. Plugin Hooks in Action

Suppose you have a simple plugin that logs every time a transaction fails or a collection is created.

```ts
// plugins/logging.ts
import type { Plugin, HookContext } from '../plugin-system';

export class LoggingPlugin implements Plugin {
    public name = 'LoggingPlugin';

    async onCollectionCreate(context: HookContext) {
        const { collectionName } = context;
        console.log(`[LoggingPlugin] Collection created: ${collectionName}`);
    }

    async onTransactionError(context: HookContext) {
        console.error(`[LoggingPlugin] Transaction error:`, context.error);
    }

    async onDatabaseClose(context: HookContext) {
        console.log('[LoggingPlugin] Database is closing');
    }

    // Implement other hooks as needed (onDatabaseInit, onBeforeTransaction, etc.)
}

// Usage:
const db = createDB({ filename: 'app.sqlite' });
db.use(new LoggingPlugin());

const users = db.collection('users', userSchema, {
    constrainedFields: { email: { type: 'unique' } },
});
// → console logs: “[LoggingPlugin] Collection created: users”

try {
    await db.transaction(async () => {
        throw new Error('fail inside transaction');
    });
} catch {
    // → console logs: “[LoggingPlugin] Transaction error: Error: fail inside transaction”
}

await db.close();
// → console logs: “[LoggingPlugin] Database is closing”
```

-   Each hook is awaited serially. If a plugin hook itself throws, `executeHookSafe` catches it and logs (unless plugin errors are propagated in strict mode).

---

### 7. Shared Connection Pooling

```ts
// server.ts
import { createDB } from './database';

async function startServer() {
    // Shared & Pooled
    const db = createDB({
        filename: 'multiuser.sqlite',
        sharedConnection: true,
        connectionPool: true,
        poolSize: 5, // hypothetical config for pooling
    });

    // Register collections as usual:
    const users = db.collection('users', userSchema, {
        constrainedFields: { email: { type: 'unique' } },
    });

    // Now every request can run queries without worrying about concurrent low-level locks:
    // e.g.:
    app.get('/users/:id', async (req, res) => {
        // This .findById(...) call under the hood does:
        //   driver = await ensureDriver()   // obtains a pooled connection
        //   driver.query('SELECT doc FROM users WHERE _id = ?', [id])
        //   returns JSON.parse(...) → sends to client
        const user = await users.findById(req.params.id);
        res.json(user);
    });

    // On graceful shutdown:
    await db.closeAllConnections(); // closes all idle and active connections in the pool
    process.exit(0);
}
```

-   **Benefit**: In a multi‐threaded or multi‐request environment, `sharedConnection: true` with `connectionPool: true` ensures that each request obtains its own connection from a pool of 5.
-   **Caveat**: Sync methods (`execSync`, `querySync`, `closeSync`) are disallowed in this mode. Always use async variants.

---

### 8. Closing the Database

```ts
async function shutdown() {
    // 1. Close all connections (if pooling)
    await db.closeAllConnections();

    // 2. Then close this particular Database instance
    //    (If a pooled/shared connection was checked out, this returns it or closes it.)
    await db.close();
}
```

-   **`closeAllConnections()`**

    -   Tells `ConnectionManager` to forcibly drop every connection in the pool.

-   **`close()`**

    -   If you have a `managedConnection` checked out, it releases it back to the pool.
    -   If you have a dedicated driver, it calls `driver.close()`.

---

## Summary

The **Database** class abstracts away:

-   Driver detection (Bun vs Node), fallback, and error wrapping.
-   Lazy vs eager driver initialization (via `sharedConnection`).
-   Plugin hooks for lifecycle events (`onDatabaseInit`, `onCollectionCreate`, `onBeforeTransaction`, `onAfterTransaction`, `onTransactionError`, `onDatabaseClose`).
-   Registration of **Collection** instances (each backed by its own table).
-   Raw SQL execution (`exec`, `query`, plus sync counterparts).
-   Transaction management with detailed error handling.
-   Connection pooling support via `ConnectionManager`.

Use `createDB(config)` to instantiate. Call `db.collection(name, schema, options)` to register or fetch a collection. Perform `users.insert(...)`, `db.query(...)`, or wrap multiple steps in `db.transaction(...)`. Finally, shut down with `db.close()` (async) or `db.closeAllConnections()` if using pooling.

That completes the detailed documentation for **`database.ts`**.
