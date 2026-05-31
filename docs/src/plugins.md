## Plugin System Overview

The **Plugin System** enables custom code to hook into database and collection lifecycle events. By implementing a standardized `Plugin` interface and registering plugins with a central `PluginManager`, you can:

-   React to CRUD operations (`insert`, `update`, `delete`, `query`) before or after they run
-   Capture transaction lifecycle events (`onBeforeTransaction`, `onAfterTransaction`, `onTransactionError`)
-   Hook into database‐level events (`onDatabaseInit`, `onDatabaseClose`)
-   Hook into collection‐level events (`onCollectionCreate`, `onCollectionDrop`)
-   Centralize error handling via a universal `onError` hook
-   Enforce timeouts on any hook so that misbehaving plugins do not stall main operations

Below is an in‐depth look at the key interfaces and classes in **`plugin-system.ts`**, followed by usage examples and best practices.

---

## Table of Contents

1. [Key Interfaces](#key-interfaces)

    - [Plugin](#plugin)
    - [PluginContext](#plugincontext)
    - [PluginSystemOptions](#pluginsystemoptions)
    - [PluginManagerOptions](#pluginmanageroptions)

2. [PluginManager Class](#pluginmanager-class)

    - [Constructor & Options](#constructor--options)
    - [`register(plugin)` / `unregister(pluginName)`](#registerplugin--unregisterpluginname)
    - [Hook Discovery](#hook-discovery)
    - [`executeHookWithTimeout(plugin, hookName, context)`](#executehookwithtimeoutplugin-hookname-context)
    - [`executeHook(hookName, context)`](#executehookhookname-context)
    - [`executeHookSafe(hookName, context)`](#executehooksafehookname-context)
    - [Configuration Methods](#configuration-methods)

3. [Supported Lifecycle Hooks](#supported-lifecycle-hooks)

    - [CRUD Hooks](#crud-hooks)
    - [Query Hooks](#query-hooks)
    - [Transaction Hooks](#transaction-hooks)
    - [Database Hooks](#database-hooks)
    - [Collection Hooks](#collection-hooks)
    - [Error Hook](#error-hook)

4. [Error Types](#error-types)

    - [PluginError](#pluginerror)
    - [PluginTimeoutError](#plugintimeouterror)

5. [Usage Examples](#usage-examples)

    - [1. Writing a Simple Logging Plugin](#1-writing-a-simple-logging-plugin)
    - [2. Enforcing Automatic Timestamps](#2-enforcing-automatic-timestamps)
    - [3. Ignoring Plugin Errors vs. Strict Mode](#3-ignoring-plugin-errors-vs-strict-mode)

6. [Best Practices & Tips](#best-practices--tips)
7. [Appendix: Full PluginManager API Reference](#appendix-full-pluginmanager-api-reference)

---

## Key Interfaces

### Plugin

A **`Plugin`** is any object that implements one or more of the predefined lifecycle hook methods. Every plugin must have at least a unique `name`. Optionally, a plugin can specify its own `version` and **`systemOptions`** (per‐plugin timeouts).

```ts
export interface Plugin {
    /** Unique plugin name (used for registration/unregistration) */
    name: string;

    /** Optional version string (for informational / compatibility checks) */
    version?: string;

    /** Optional per‐plugin system options (e.g., hook timeout override) */
    systemOptions?: PluginSystemOptions;

    // ----- CRUD Hooks -----
    onBeforeInsert?(context: PluginContext): Promise<void> | void;
    onAfterInsert?(context: PluginContext): Promise<void> | void;
    onBeforeUpdate?(context: PluginContext): Promise<void> | void;
    onAfterUpdate?(context: PluginContext): Promise<void> | void;
    onBeforeDelete?(context: PluginContext): Promise<void> | void;
    onAfterDelete?(context: PluginContext): Promise<void> | void;

    // ----- Query Hooks -----
    onBeforeQuery?(context: PluginContext): Promise<void> | void;
    onAfterQuery?(context: PluginContext): Promise<void> | void;

    // ----- Transaction Hooks -----
    onBeforeTransaction?(context: PluginContext): Promise<void> | void;
    onAfterTransaction?(context: PluginContext): Promise<void> | void;
    onTransactionError?(context: PluginContext): Promise<void> | void;

    // ----- Database Lifecycle Hooks -----
    onDatabaseInit?(
        context: Omit<PluginContext, 'collectionName' | 'schema'>
    ): Promise<void> | void;
    onDatabaseClose?(
        context: Omit<PluginContext, 'collectionName' | 'schema'>
    ): Promise<void> | void;

    // ----- Collection Lifecycle Hooks -----
    onCollectionCreate?(context: PluginContext): Promise<void> | void;
    onCollectionDrop?(context: PluginContext): Promise<void> | void;

    // ----- Error Handling Hook -----
    onError?(context: PluginContext): Promise<void> | void;
}
```

-   **All hook methods are optional**. A plugin can implement only the hooks it cares about.
-   Each hook method receives a single **`PluginContext`** argument (described below).
-   Hook implementations can return either `void` or `Promise<void>`. All hooks are awaited unless you use the “Safe” variant (described later).

### PluginContext

A **`PluginContext`** is an object passed into every hook invocation. It describes the operation being performed, the relevant collection and schema, and any associated data, result, or error.

```ts
export interface PluginContext {
    /** Name of the collection (e.g. "users"), or empty string for database‐level hooks */
    collectionName: string;

    /** Full collection schema (column definitions, constrained fields, etc.) */
    schema: CollectionSchema;

    /** Operation name (e.g. "insert", "update", "delete", "query", "transaction", etc.) */
    operation: string;

    /**
     * For CRUD or query hooks, this is the input data (document to insert/update/delete/query filters, etc.).
     * For Transaction hooks, it may be undefined.
     */
    data?: any;

    /**
     * For “After” hooks or error hooks, contains the operation result (e.g. inserted document, query results).
     */
    result?: any;

    /** For error handling or transactionError, contains the thrown Error object. */
    error?: Error;
}
```

-   **`collectionName`**: Always provided, even for “insert” or “update” hooks. For database‐level hooks (`onDatabaseInit`, `onDatabaseClose`), `collectionName` is set to `""`.
-   **`schema`**: The registered `CollectionSchema` object, which includes Zod schema, constrained fields, indexes, etc.
-   **`operation`**: A string identifying the action. Common values:

    -   `"insert"`, `"update"`, `"delete"`, `"query"`
    -   `"transaction"`
    -   `"database_init"`, `"database_close"`
    -   `"collection_create"`, `"collection_drop"`

-   **`data`**:

    -   For `onBeforeInsert`, the new document object (without `id`).
    -   For `onBeforeUpdate`, partial document changes.
    -   For `onBeforeDelete`, the `id` of the document.
    -   For `onBeforeQuery`, an object describing filter conditions or raw SQL.
    -   For `onBeforeTransaction`, usually `{}` (no data).

-   **`result`**:

    -   For `onAfterInsert`, the fully validated document with `id`.
    -   For `onAfterQuery`, the array of returned rows.
    -   For `onAfterTransaction`, the value returned by the transaction callback.

-   **`error`**:

    -   For `onError`, the thrown `Error` from a CRUD/query/transaction.
    -   For `onTransactionError`, the specific error that caused rollback.

### PluginSystemOptions

Defines per‐plugin configuration options. Currently only supports a `timeout` (in milliseconds).

```ts
export interface PluginSystemOptions {
    /**
     * Maximum time (ms) to wait for any given hook in this plugin to finish.
     * If the hook does not resolve within this time, a PluginTimeoutError is thrown.
     * Default (if unspecified): 5000ms (inherited from PluginManagerOptions.defaultTimeout).
     */
    timeout?: number;
}
```

If a hook exceeds its timeout, the manager will reject with `PluginTimeoutError` and then handle it according to strict mode or safe mode logic.

### PluginManagerOptions

Defines global options for a `PluginManager` instance.

```ts
export interface PluginManagerOptions {
    /**
     * If `true`, any plugin error (or timeout) will be re‐thrown to the caller immediately.
     * If `false` (default), plugin errors/timeouts are logged (via `console.warn`) and the main operation continues.
     */
    strictMode?: boolean;

    /**
     * Default timeout for plugin hooks (ms).
     * Individual plugins can override by specifying `plugin.systemOptions.timeout`.
     */
    defaultTimeout?: number;
}
```

-   **`strictMode = false`**: All plugin exceptions/timeouts are caught and logged; they do not interrupt the primary database operation.
-   **`strictMode = true`**: Any plugin error (including a timeout) is re‐thrown as a `PluginError` or `PluginTimeoutError`. The calling code (e.g. `Collection.insert`, `Database.transaction`) must handle/rethrow that.
-   **`defaultTimeout`**: The fallback hook timeout for all plugins not specifying their own `systemOptions.timeout`.

---

## PluginManager Class

The **`PluginManager`** is the central orchestrator. It:

1. Holds a registry of all registered plugins (`Map<string, Plugin>`).
2. Discovers, categorizes, and stores plugins by which hooks they implement (`Map<string, Plugin[]>`).
3. Provides methods to invoke hooks in sequence, honoring per‐plugin timeouts and handling errors.
4. Supports two execution modes:

    - **`executeHook`**: Throws on any plugin error/timeout (unless caught by caller).
    - **`executeHookSafe`**: Catches errors/timeouts, logs them (unless strictMode), but does not interrupt main flow.

### Constructor & Options

```ts
export class PluginManager {
    private plugins: Map<string, Plugin> = new Map();
    private hooks: Map<string, Plugin[]> = new Map();
    private options: PluginManagerOptions;

    constructor(options: PluginManagerOptions = {}) {
        this.options = {
            strictMode: false,
            defaultTimeout: 5000,
            ...options,
        };
    }
    // ...
}
```

-   By default, **`strictMode = false`** and **`defaultTimeout = 5000ms`**.
-   You can override either option when instantiating:

    ```ts
    const manager = new PluginManager({
        strictMode: true,
        defaultTimeout: 10_000,
    });
    ```

### `register(plugin: Plugin): void`

Registers a plugin instance:

1. **Duplicate‐Name Check**: Throws if a plugin with the same `plugin.name` is already registered.
2. **Stores in `this.plugins`**: Keyed by `plugin.name`.
3. **Discovers Hooks**:

    - Fast path: checks a constant list of known hook names (`onBeforeInsert`, `onAfterInsert`, `onBeforeUpdate`, `onAfterUpdate`, `onBeforeDelete`, `onAfterDelete`, `onBeforeQuery`, `onAfterQuery`, `onBeforeTransaction`, `onAfterTransaction`, `onTransactionError`, `onDatabaseInit`, `onDatabaseClose`, `onCollectionCreate`, `onCollectionDrop`, `onError`) directly on the plugin instance. This handles inheritance via normal JS property lookup.
    - Slow path: walks the prototype chain for custom hooks not in the known list (any method starting with `"on"`).
    - For each discovered hook method, adds the plugin instance to `this.hooks.get(hookName)`.

        - Ensures each plugin appears only once per hook.

```ts
register(plugin: Plugin): void {
  if (this.plugins.has(plugin.name)) {
    throw new Error(`Plugin '${plugin.name}' is already registered`);
  }
  this.plugins.set(plugin.name, plugin);

  // Discover all hook methods on this plugin (including inherited)
  const potentialHookKeys = new Set<string>();
  let currentProto: any = plugin;
  while (currentProto && currentProto !== Object.prototype) {
    Object.getOwnPropertyNames(currentProto).forEach(name => {
      potentialHookKeys.add(name);
    });
    currentProto = Object.getPrototypeOf(currentProto);
  }

  potentialHookKeys.forEach(key => {
    if (key.startsWith('on') && typeof (plugin as any)[key] === 'function') {
      let pluginsForHook = this.hooks.get(key);
      if (!pluginsForHook) {
        pluginsForHook = [];
        this.hooks.set(key, pluginsForHook);
      }
      if (!pluginsForHook.includes(plugin)) {
        pluginsForHook.push(plugin);
      }
    }
  });
}
```

-   After registration, any future calls to `executeHook("onSomeHook", context)` will include this plugin if it implements `onSomeHook`.

### `unregister(pluginName: string): void`

Removes a plugin by name:

1. Ensures the plugin is registered; otherwise throws.
2. Deletes it from `this.plugins`.
3. Iterates `this.hooks` and removes the plugin from every hook’s array.

```ts
unregister(pluginName: string): void {
  const plugin = this.plugins.get(pluginName);
  if (!plugin) {
    throw new Error(`Plugin '${pluginName}' is not registered`);
  }
  this.plugins.delete(pluginName);

  // Remove from all hook lists
  this.hooks.forEach((plugins, hookName) => {
    const index = plugins.indexOf(plugin);
    if (index !== -1) {
      plugins.splice(index, 1);
    }
  });
}
```

### Hook Discovery

-   **All hook methods** follow the naming convention `onXxx` (e.g. `onBeforeInsert`, `onAfterQuery`, `onError`).
-   Known hooks are checked directly on the plugin instance (handles inheritance). Custom hooks are discovered by walking the prototype chain, so subclasses that override a hook will be discovered automatically.
-   Duplicate plugin instances or methods are guarded against; each plugin only appears once per hook.

### `executeHookWithTimeout(plugin, hookName, context): Promise<void>`

Internally used to run a single plugin’s hook method and enforce per‐hook timeouts:

1. Fetches the hook function:

    ```ts
    const hookFn = plugin[hookName as keyof Plugin] as Function;
    if (!hookFn) return; // Plugin does not implement this hook → no action
    ```

2. Determines timeout in milliseconds:

    ```ts
    const timeout =
        plugin.systemOptions?.timeout ?? this.options.defaultTimeout!;
    ```

3. Returns a `Promise<void>` that does:

    - **Starts a timer**: after `timeout` ms, rejects with `PluginTimeoutError(plugin.name, hookName, timeout)`.
    - **Calls** `hookFn.call(plugin, context)` and awaits its result (cast to a `Promise<void>`).
    - If the hook completes before the timer, we `clearTimeout(timer)` and resolve.
    - If the hook throws or returns a rejected promise:

        - We clear the timer
        - If the error is already `PluginTimeoutError`, reject with it
        - Otherwise, wrap in a new `PluginError(...)` (capturing plugin name, hook name, original error) and reject

```ts
private async executeHookWithTimeout(
  plugin: Plugin,
  hookName: string,
  context: PluginContext
): Promise<void> {
  const hookFn = plugin[hookName as keyof Plugin] as Function;
  if (!hookFn) return;

  const timeout = plugin.systemOptions?.timeout ?? this.options.defaultTimeout!;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new PluginTimeoutError(plugin.name, hookName, timeout));
    }, timeout);

    const cleanup = () => clearTimeout(timer);

    try {
      const result = Promise.resolve(hookFn.call(plugin, context));
      result
        .then(() => {
          cleanup();
          resolve();
        })
        .catch(error => {
          cleanup();
          if (error instanceof PluginTimeoutError) {
            reject(error);
          } else {
            reject(
              new PluginError(
                `Plugin '${plugin.name}' hook '${hookName}' failed: ${error.message}`,
                plugin.name,
                hookName,
                error
              )
            );
          }
        });
    } catch (error) {
      cleanup();
      reject(
        new PluginError(
          `Plugin '${plugin.name}' hook '${hookName}' threw synchronous error: ${
            (error as Error).message
          }`,
          plugin.name,
          hookName,
          error as Error
        )
      );
    }
  });
}
```

### `executeHook(hookName, context): Promise<void>`

Invokes **all registered plugins’** implementations of a specific hook in sequence and **propagates** any thrown errors. If any plugin hook fails or times out, this method:

1. Wraps low‐level errors/timeouts in a uniform `PluginError` or `PluginTimeoutError`.
2. Attempts to call `onError` hooks on _other_ plugins (unless the failed hook itself was `onError`) with a `PluginContext` containing the original error.
3. Re‐throws the original or newly wrapped error to the caller, stopping further plugin execution for that hook.

```ts
async executeHook(hookName: string, context: PluginContext): Promise<void> {
  const plugins = this.hooks.get(hookName) || [];
  for (const plugin of plugins) {
    try {
      await this.executeHookWithTimeout(plugin, hookName, context);
    } catch (error) {
      const pluginError =
        error instanceof PluginError
          ? error
          : new PluginError(
              `Plugin '${plugin.name}' hook '${hookName}' failed: ${
                (error as Error).message
              }`,
              plugin.name,
              hookName,
              error as Error
            );

      // Attempt to call onError hooks (if we’re not already in onError)
      if (hookName !== 'onError') {
        try {
          const errorContext: PluginContext = { ...context, error: pluginError };
          await this.executeHook('onError', errorContext);
        } catch {
          // Ignore any errors in onError to avoid infinite loops
        }
      }
      // Re‐throw so the caller knows a plugin failed
      throw pluginError;
    }
  }
}
```

-   **Sequential Execution**: Plugins are invoked in registration order. If one plugin throws, later plugins for the same hook are not invoked.
-   **Error Propagation**: If a plugin error (or timeout) occurs, that error (wrapped as `PluginError`) is thrown up to the caller of `executeHook(...)`.
-   **`onError` Hook**: If an error occurs and `hookName !== 'onError'`, the manager attempts to invoke each registered plugin’s `onError` hook (if defined). Failures in `onError` do not abort the flow—those are logged/ignored to avoid infinite recursion.

### `executeHookSafe(hookName, context): Promise<void>`

A **“no‐fail”** variant of `executeHook`. It calls `executeHook(...)` but **catches all errors/timeouts**. Errors are logged via `console.warn` (unless `strictMode` is `true`, in which case they are re‐thrown exactly).

```ts
async executeHookSafe(hookName: string, context: PluginContext): Promise<void> {
  try {
    await this.executeHook(hookName, context);
  } catch (error) {
    if (this.options.strictMode) {
      // In strict mode, rethrow plugin errors
      throw error;
    } else {
      // Log the error or timeout
      if (error instanceof PluginTimeoutError) {
        console.warn(
          `Plugin '${error.pluginName}' hook '${hookName}' timed out after ${error.hookName} ms - consider increasing timeout or optimizing plugin performance`
        );
      } else if (error instanceof PluginError) {
        console.warn(
          `Plugin '${error.pluginName}' hook '${hookName}' failed: ${error.message}`,
          error.originalError || ''
        );
      } else {
        console.warn(`Plugin hook '${hookName}' failed:`, error);
      }
    }
  }
}
```

-   **Use Case**: Typically called inside database or collection operations (e.g. `onBeforeInsert`, `onAfterInsert`, etc.). The main database logic continues even if plugins fail, unless you explicitly turn on `strictMode`.

### Configuration Methods

-   **`setStrictMode(enabled: boolean): void`**
    Switches strict mode on/off at runtime.

    -   `true`: All plugin errors/timeouts will be re‐thrown.
    -   `false` (default): Plugin errors are caught and logged.

-   **`setDefaultTimeout(timeout: number): void`**
    Adjusts the global default hook timeout (in ms).
    Plugins without a custom `systemOptions.timeout` will now be given this new default.

-   **`getOptions(): PluginManagerOptions`**
    Returns a shallow copy of the current `{ strictMode, defaultTimeout }`. Useful for introspection or dynamic logging.

---

## Supported Lifecycle Hooks

Below is a rundown of every hook name recognized by the system. If a plugin implements any of these methods, it will be automatically called at the appropriate time.

### CRUD Hooks

-   **`onBeforeInsert(context: PluginContext)`**
    Fired immediately before a document insertion is validated.

    -   `context.data`: The document to be inserted (without `id`).
    -   `context.result`: `undefined`.
    -   If this hook throws, insertion is aborted and the error bubbles up (unless `executeHookSafe` is used).

-   **`onAfterInsert(context: PluginContext)`**
    Fired after the document was successfully inserted and validated.

    -   `context.data`: The original document passed in.
    -   `context.result`: The full inserted document (including generated `id`).

-   **`onBeforeUpdate(context: PluginContext)`**
    Fired right before an update (`put`) is applied.

    -   `context.data`: An object `{ id: string; doc: Partial<…> }` or just the partial fields being updated.
    -   `context.result`: `undefined`.

-   **`onAfterUpdate(context: PluginContext)`**
    Fired after a document update succeeds.

    -   `context.data`: The input update object.
    -   `context.result`: The fully validated updated document.

-   **`onBeforeDelete(context: PluginContext)`**
    Fired before a document deletion.

    -   `context.data`: The `id: string` being deleted.
    -   `context.result`: `undefined`.

-   **`onAfterDelete(context: PluginContext)`**
    Fired after a deletion completes.

    -   `context.data`: The `id` that was deleted.
    -   `context.result`: Typically `true` or the number of rows deleted.

### Query Hooks

-   **`onBeforeQuery(context: PluginContext)`**
    Triggered before any “simple” query (e.g. `toArray()`, `first()`, `count()`) is executed.

    -   `context.data`: An object representing filters, sort order, pagination, etc.
    -   `context.result`: `undefined`.

-   **`onAfterQuery(context: PluginContext)`**
    Triggered after a query completes successfully.

    -   `context.data`: The same filters/pagination object.
    -   `context.result`: The array of returned documents (or aggregated row).

### Transaction Hooks

-   **`onBeforeTransaction(context: PluginContext)`**
    Fired immediately before `db.transaction(async () => { … })` begins.

    -   `context.data`: Undefined.
    -   `context.result`: Undefined.

-   **`onAfterTransaction(context: PluginContext)`**
    Fired if the entire transaction callback resolves successfully and commits.

    -   `context.result`: The return value of the callback.

-   **`onTransactionError(context: PluginContext)`**
    Fired if the transaction callback throws or the commit fails (e.g. due to a lock).

    -   `context.error`: The thrown error (wrapped or original).
    -   This hook itself may throw (wrapped as `PluginError` or `PluginTimeoutError`), which is caught or rethrown according to `strictMode`.

### Database Hooks

-   **`onDatabaseInit(context: Omit<PluginContext, 'collectionName' | 'schema'>)`**
    Called once immediately after the `new Database(config)` constructor finishes basic setup.

    -   `context.operation`: `"database_init"`.
    -   `context.collectionName` and `context.schema` are omitted (always empty object for schema).
    -   Ideal for hooking global startup logic (e.g. creating aggregated indexes, seeding data).

-   **`onDatabaseClose(context: Omit<PluginContext, 'collectionName' | 'schema'>)`**
    Called when `db.close()` is invoked (before actually closing the driver or releasing a connection).

    -   `context.operation`: `"database_close"`.
    -   No `context.data` or `context.result`.
    -   Create cleanup logic (e.g. flushing in‐memory caches, writing metrics to disk).

### Collection Hooks

-   **`onCollectionCreate(context: PluginContext)`**
    Fired after `db.collection(name, schema, options)` successfully registers a new collection and creates its table.

    -   `context.collectionName`: The new collection name.
    -   `context.schema`: The `CollectionSchema` object.
    -   `context.operation`: `"collection_create"`.
    -   This hook is invoked via `executeHookSafe`, so plugin exceptions do not prevent collection creation (unless strict mode).

-   **`onCollectionDrop(context: PluginContext)`**
    (If implemented) would be fired when a collection is explicitly dropped. The core library does not expose a `dropCollection` method by default, but the hook is defined for future or custom implementations.

    -   `context.collectionName`: The collection being dropped.
    -   `context.operation`: `"collection_drop"`.

### Error Hook

-   **`onError(context: PluginContext)`**
    Called whenever any other hook throws an exception or times out. The system attempts to invoke `onError` with:

    -   `context.error`: The original `PluginError` or `PluginTimeoutError`.
    -   `context.operation`: The name of the hook that failed (e.g. `"onBeforeInsert"`).
    -   `context.collectionName`: The collection currently involved.
    -   This hook **will never be recursively invoked** if it itself throws (errors from `onError` are silently ignored to avoid infinite loops).

---

## Error Types

### PluginError

A wrapper for any synchronous or asynchronous exception thrown inside a plugin hook, except timeouts.

```ts
export class PluginError extends Error {
    constructor(
        message: string,
        public pluginName: string,
        public hookName: string,
        public originalError?: Error
    ) {
        super(message);
        this.name = 'PluginError';
    }
}
```

-   **`message`**: Descriptive text, e.g. `"Plugin 'MetricsPlugin' hook 'onBeforeInsert' failed: TypeError: x is undefined"`.
-   **`pluginName`**: Name string of the plugin that threw.
-   **`hookName`**: The hook method that threw (e.g. `"onAfterUpdate"`).
-   **`originalError`**: The underlying error object (if any).

### PluginTimeoutError

A specialized error thrown when a plugin hook exceeds its specified timeout.

```ts
export class PluginTimeoutError extends PluginError {
    constructor(pluginName: string, hookName: string, public timeout: number) {
        super(
            `Plugin '${pluginName}' hook '${hookName}' timed out after ${timeout}ms`,
            pluginName,
            hookName
        );
        this.name = 'PluginTimeoutError';
    }
}
```

-   Inherits from `PluginError`.
-   Includes an extra `timeout` property for easier logging (`timeout` in ms).
-   Managed the same way as `PluginError`, except the warning message is specific to timeouts.

---

## Usage Examples

### 1. Writing a Simple Logging Plugin

A plugin that logs every insert and query to the console.

```ts
// src/plugins/logging.ts
import type { Plugin, PluginContext } from '../plugin-system';

export class LoggingPlugin implements Plugin {
    public name = 'LoggingPlugin';
    public version = '1.0.0';
    public systemOptions = { timeout: 2000 }; // 2‐second max per hook

    async onBeforeInsert(context: PluginContext): Promise<void> {
        console.log(
            `[LoggingPlugin:onBeforeInsert] Collection='${context.collectionName}' Data=`,
            context.data
        );
    }

    async onAfterInsert(context: PluginContext): Promise<void> {
        console.log(
            `[LoggingPlugin:onAfterInsert] Inserted into '${context.collectionName}' Result=`,
            context.result
        );
    }

    async onBeforeQuery(context: PluginContext): Promise<void> {
        console.log(
            `[LoggingPlugin:onBeforeQuery] Collection='${context.collectionName}' Filters=`,
            context.data
        );
    }

    async onAfterQuery(context: PluginContext): Promise<void> {
        console.log(
            `[LoggingPlugin:onAfterQuery] Collection='${context.collectionName}' Result count=`,
            Array.isArray(context.result) ? context.result.length : 0
        );
    }

    async onError(context: PluginContext): Promise<void> {
        console.error(
            `[LoggingPlugin:onError] Collection='${context.collectionName}' Hook='${context.operation}' Error=`,
            context.error
        );
    }
}
```

**Registering and Using**:

```ts
import { createDB } from './database';
import { LoggingPlugin } from './plugins/logging';

async function main() {
    // 1. Create database
    const db = createDB({ filename: 'app.sqlite' });

    // 2. Register LoggingPlugin
    db.use(new LoggingPlugin());

    // 3. Register a simple "users" collection
    const users = db.collection(
        'users',
        z.object({ id: z.string(), name: z.string(), email: z.string() }),
        {
            constrainedFields: {
                email: { type: 'string', unique: true, nullable: false },
            },
        }
    );

    // 4. Perform an insert and query
    await users.insert({ name: 'Alice', email: 'alice@example.com' });
    const results = await users
        .where('email')
        .eq('alice@example.com')
        .toArray();
    console.log('Fetched users:', results);
}

main().catch(console.error);
```

-   **Console Output**:

    ```
    [LoggingPlugin:onBeforeInsert] Collection='users' Data= { name: 'Alice', email: 'alice@example.com' }
    [LoggingPlugin:onAfterInsert] Inserted into 'users' Result= { id: 'uuid-...', name: 'Alice', email: 'alice@example.com' }
    [LoggingPlugin:onBeforeQuery] Collection='users' Filters= { field: 'email', operator: 'eq', value: 'alice@example.com' }
    [LoggingPlugin:onAfterQuery] Collection='users' Result count= 1
    ```

---

### 2. Enforcing Automatic Timestamps

A plugin that sets `createdAt` and `updatedAt` fields on every insert/update:

```ts
// src/plugins/timestamp-plugin.ts
import type { Plugin, PluginContext } from '../plugin-system';

export interface TimestampOptions {
    /** Field name for creation timestamp (default = "createdAt") */
    createField?: string;

    /** Field name for update timestamp (default = "updatedAt") */
    updateField?: string;

    /** Automatically set `createField` if missing */
    autoCreate?: boolean;

    /** Automatically set `updateField` on each update */
    autoUpdate?: boolean;
}

export class TimestampPlugin implements Plugin {
    public name = 'TimestampPlugin';
    public systemOptions = { timeout: 1000 }; // 1s per hook
    private options: Required<TimestampOptions>;

    constructor(options: TimestampOptions = {}) {
        this.options = {
            createField: 'createdAt',
            updateField: 'updatedAt',
            autoCreate: true,
            autoUpdate: true,
            ...options,
        };
    }

    // Before inserting a new document:
    async onBeforeInsert(context: PluginContext): Promise<void> {
        if (!this.options.autoCreate) return;

        const now = new Date().toISOString();
        const data = context.data as any;
        // If the document doesn't already have a createdAt field, add it
        if (!(this.options.createField in data)) {
            data[this.options.createField] = now;
        }
        // Also set updatedAt to now
        data[this.options.updateField] = now;
    }

    // Before updating an existing document:
    async onBeforeUpdate(context: PluginContext): Promise<void> {
        if (!this.options.autoUpdate) return;

        const now = new Date().toISOString();
        const data = context.data as any;
        data[this.options.updateField] = now;
    }
}
```

**Usage**:

```ts
import { createDB } from './database';
import { TimestampPlugin } from './plugins/timestamp-plugin';

async function main() {
    const db = createDB({ filename: 'app.sqlite' });
    db.use(new TimestampPlugin({ autoCreate: true, autoUpdate: true }));

    const posts = db.collection(
        'posts',
        z.object({
            id: z.string(),
            title: z.string(),
            content: z.string(),
            createdAt: z.string().optional(),
            updatedAt: z.string().optional(),
        })
    );

    // Insert without specifying timestamps:
    const newPost = await posts.insert({ title: 'Hello', content: 'World' });
    // newPost.createdAt and newPost.updatedAt are now set automatically

    // Update:
    const updated = await posts.put(newPost.id, { content: 'Universe' });
    // updated.updatedAt has been updated to the current timestamp
}

main();
```

---

### 3. Ignoring Plugin Errors vs. Strict Mode

By default, all plugin errors are caught and only logged, allowing the main database operation to proceed. If you want plugin failures to halt operations, enable **strict mode**:

```ts
import { createDB } from './database';
import { LoggingPlugin } from './plugins/logging';

async function main() {
    // 1. Create manager in strict mode
    const db = createDB({ filename: 'app.sqlite' });
    // Turn on strict mode after instantiation
    db.getPluginManager().setStrictMode(true);

    // 2. Register a plugin that intentionally throws
    class FailingPlugin implements Plugin {
        public name = 'FailingPlugin';
        async onBeforeInsert(context: PluginContext): Promise<void> {
            throw new Error('Intentional failure');
        }
    }

    db.use(new FailingPlugin());

    // 3. Attempt to insert
    try {
        const users = db.collection(
            'users',
            z.object({ id: z.string(), name: z.string() })
        );
        await users.insert({ name: 'Bob' }); // Will throw PluginError
    } catch (err) {
        console.error('Insert aborted due to plugin failure:', err);
    }
}

main();
```

-   With `strictMode = true`, the `insert` call fails as soon as `FailingPlugin.onBeforeInsert` throws.
-   If we had used the default `strictMode = false`, the error would be caught and only logged; the insert would still proceed.

---

## Best Practices & Tips

1. **Keep Hooks Lightweight**

    - Avoid long‐running operations in plugin hooks. If you need to perform heavy work (e.g. network calls or large computations), either increase the hook timeout or delegate to a background job.
    - By default, every hook has a 5000ms (5‐second) timeout. You can override per plugin or globally via `PluginManagerOptions.defaultTimeout`.

2. **Use `executeHookSafe` in Core Logic**

    - When you call plugin hooks inside your database/collection code, use the “Safe” variant so that plugin failures do not block normal operations (unless strict mode is explicitly desired).
    - Core code usually looks like:

        ```ts
        await this.pluginManager.executeHookSafe('onBeforeInsert', context);
        ```

3. **Namespace Your Plugin Names**

    - Choose descriptive, unique plugin names (e.g. `"MyApp.LoggingPlugin"` rather than just `"LoggingPlugin"`), to avoid accidental name collisions.

4. **Avoid Recursion between Hooks**

    - A plugin’s `onError` hook should avoid calling `throw` (unless in strict mode) to prevent infinite loops. The `PluginManager` will catch any `onError` exceptions and ignore them.

5. **Handle Transactions Carefully**

    - If you implement `onBeforeTransaction` or `onAfterTransaction`, remember that these hooks occur outside the context of a single insert/update/delete. Keep your logic general (e.g. resetting caches or starting performance timers).

6. **Order of Execution**

    - Plugins are invoked **in registration order**. If two plugins implement the same hook, the first one registered always runs before the second. If ordering matters, register them in the desired sequence.

7. **Unregistering Plugins**

    - Use `pluginManager.unregister(pluginName)` to remove a plugin at runtime. This immediately prevents subsequent hooks from firing for that plugin.

8. **Testing Plugin Behavior**

    - Write unit tests for each hook you implement. You can supply a fake `PluginContext` to your hook method and verify it behaves as expected.
    - When using timeouts, write tests that simulate a slow hook to ensure `PluginTimeoutError` is thrown.

9. **Evolving Your Schema**

    - If a plugin relies on a particular `CollectionSchema` format (e.g. expecting a certain field), ensure compatibility when migrating your Zod schemas or constrained fields. Use `context.schema` to inspect the current version of the schema.

---

## Appendix: Full PluginManager API Reference

<details>
<summary>Click to expand full PluginManager method signatures and behaviors</summary>

```ts
class PluginManager {
    // ─────────────────────────────────────────────────────────────────────────────
    // Constructor & Options
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * @param options.strictMode If true, rethrow plugin errors; otherwise just log them.
     * @param options.defaultTimeout Default timeout in ms for each hook call.
     */
    constructor(options?: PluginManagerOptions);

    /**
     * Returns current manager options `{ strictMode, defaultTimeout }`.
     */
    getOptions(): PluginManagerOptions;

    /**
     * Enables or disables strict mode at runtime.
     */
    setStrictMode(enabled: boolean): void;

    /**
     * Sets a new global default timeout (ms) for all plugin hooks that don’t override.
     */
    setDefaultTimeout(timeout: number): void;

    // ─────────────────────────────────────────────────────────────────────────────
    // Plugin Registration / Unregistration
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Registers a plugin instance. Discovers and stores which hooks it implements.
     * @throws Error if plugin name is already registered.
     */
    register(plugin: Plugin): void;

    /**
     * Unregisters a plugin (by its `plugin.name`). Removes it from all hook lists.
     * @throws Error if pluginName not found.
     */
    unregister(pluginName: string): void;

    /**
     * Retrieve a registered plugin instance by name, or undefined if not registered.
     */
    getPlugin(name: string): Plugin | undefined;

    /**
     * List all registered plugins in registration order.
     */
    listPlugins(): Plugin[];

    // ─────────────────────────────────────────────────────────────────────────────
    // Hook Execution (Throwing)
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Executes every plugin’s implementation of `hookName` in registration order.
     * Waits (awaits) each hook sequentially, enforcing per-hook timeouts.
     * If a plugin throws or times out, wraps and rethrows as PluginError/PluginTimeoutError.
     * Also invokes registered `onError` hooks (except when hookName === 'onError').
     * @throws PluginError or PluginTimeoutError on plugin failure/timeout.
     */
    executeHook(hookName: string, context: PluginContext): Promise<void>;

    // ─────────────────────────────────────────────────────────────────────────────
    // Hook Execution (Safe / Non-Throwing)
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Same as executeHook(...), but catches all PluginError / PluginTimeoutError.
     * - If strictMode === true, rethrows the error to the caller.
     * - Otherwise, logs via console.warn and continues.
     * @param hookName The lifecycle hook, e.g. 'onBeforeInsert', 'onAfterQuery', etc.
     * @param context The PluginContext for this operation.
     */
    executeHookSafe(hookName: string, context: PluginContext): Promise<void>;

    // ─────────────────────────────────────────────────────────────────────────────
    // Internal: Single-Plugin Hook Invocation + Timeout
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Internal helper: invokes a single plugin’s hook and applies a timeout.
     * If plugin does not implement this hook, does nothing.
     * @param plugin Plugin instance
     * @param hookName Hook method name (e.g. 'onBeforeInsert')
     * @param context PluginContext argument
     * @throws PluginTimeoutError if hook exceeds timeout, or PluginError if hook throws.
     */
    private executeHookWithTimeout(
        plugin: Plugin,
        hookName: string,
        context: PluginContext
    ): Promise<void>;
}
```

</details>

---

### Summary

1. **Define Plugins** by implementing the `Plugin` interface.
2. **Register** them on your `Database` or `Collection` (both share the same `PluginManager`) via `db.use(pluginInstance)`.
3. **Core code** (e.g. inside `Collection.insert`, `Collection.put`, `Database.transaction`) should invoke hooks with:

    ```ts
    await pluginManager.executeHookSafe('onBeforeInsert', context);
    // ... perform insert ...
    await pluginManager.executeHookSafe('onAfterInsert', {
        ...context,
        result,
    });
    ```

    or if you want to fail on plugin error:

    ```ts
    await pluginManager.executeHook('onBeforeInsert', context);
    ```

4. **Hooks run in registration order** with per‐hook timeouts. Plugin errors are wrapped in `PluginError` or `PluginTimeoutError`.
5. **Strict Mode** toggles whether plugin failures abort main operations (`strictMode = true`) or are only logged (`strictMode = false`).

By following this guide, you can seamlessly extend the database/collection behavior in BusNDB (or any downstream application) without touching core library code—just write plugins that react to the events you care about.
