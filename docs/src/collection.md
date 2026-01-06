**Overview**
A **Collection** represents a named set of JSON‐serializable documents stored in a SQL table. Each document must conform to a Zod schema. Under the hood, a Collection wraps:

-   A **Driver** (e.g. BunDriver or NodeDriver) for executing SQL.
-   A **CollectionSchema**, which includes:

    -   `name`: the SQL table name.
    -   `schema`: a Zod schema (ZodObject) that describes the shape of each document (including an `id: string` field).
    -   `constrainedFields`: an optional map of document fields to SQL constraint definitions (e.g. unique, foreign key).

When you construct a Collection, it:

1. Creates its SQL table immediately (synchronously).
2. Registers any indexes or constraints (e.g. unique on `email`) via additional SQL.
3. Stores a reference to a PluginManager (if provided) so that hooks like `onBeforeInsert` / `onAfterInsert` can be invoked.

After construction, you can:

-   **Insert, update, delete, upsert** documents (either asynchronously or synchronously).
-   **Query** documents via fluent query methods (`where`, `orderBy`, `limit`, etc.) that build SQL under the hood.
-   Use **bulk** variants of insert/put/upsert/delete.
-   Retrieve raw lists (`toArray`, `count`, `first`), again either async or sync.

Every document you insert or update is validated against the Zod schema. If validation fails, a `ValidationError` is thrown. If you violate a unique or foreign‐key constraint, you get a `UniqueConstraintError` or `ValidationError`. If you attempt to update/delete an `id` that doesn’t exist, you get a `NotFoundError`.

---

## Table of Contents

1. [Importing & Type Parameters](#importing--type-parameters)
2. [Constructor & Initialization](#constructor--initialization)
3. [Document Validation](#document-validation)
4. [ID Generation](#id-generation)
5. [Async CRUD Methods](#async-crud-methods)

    - [insert](#insert)
    - [insertBulk](#insertbulk)
    - [put](#put)
    - [putBulk](#putbulk)
    - [delete](#delete)
    - [deleteBulk](#deletebulk)
    - [upsert](#upsert)
    - [upsertOptimized](#upsertoptimized)
    - [upsertBulk](#upsertbulk)
    - [findById](#findbyid)
    - [count](#count)
    - [first](#first)
    - [toArray](#toarray)

6. [Sync CRUD Methods](#sync-crud-methods)

    - [insertSync](#insertsync)
    - [insertBulkSync](#insertbulksync)
    - [findByIdSync](#findbyidsync)
    - [toArraySync](#toarraysync)
    - [countSync](#countsync)
    - [firstSync](#firstsync)
    - [putSync](#putsync)
    - [deleteSync](#deletesync)
    - [deleteBulkSync](#deletebulksync)
    - [upsertSync](#upsertsync)
    - [upsertBulkSync](#upsertbulksync)
    - [putBulkSync](#putbulksync)

7. [Fluent Query Builder](#fluent-query-builder)

    - [where](#where)
    - [orderBy / orderByMultiple](#orderby--orderbymultiple)
    - [limit / offset / page](#limit--offset--page)
    - [distinct / or](#distinct--or)
    - [Async vs. Sync Query Execution](#async-vs-sync-query-execution)

8. [Plugin Hooks](#plugin-hooks)
9. [Error Types](#error-types)
10. [Examples](#examples)

---

## Importing & Type Parameters

```ts
import { z } from 'zod';
import type { Driver, CollectionSchema, InferSchema } from './types';
import { QueryBuilder, FieldBuilder } from './query-builder';
import { SQLTranslator } from './sql-translator';
import { SchemaSQLGenerator } from './schema-sql-generator.js';
import {
    ValidationError,
    NotFoundError,
    UniqueConstraintError,
} from './errors.js';
import { parseDoc, mergeConstrainedFields } from './json-utils.js';
import type { QueryablePaths, OrderablePaths } from './types/nested-paths';
import type { PluginManager } from './plugin-system';
```

-   **`T extends z.ZodSchema`** is the Zod schema type parameter.
-   **`InferSchema<T>`** is the TypeScript type that Zod produces when you parse a document with `T`. Typically, if you define:

    ```ts
    const userSchema = z.object({
        id: z.string(),
        name: z.string(),
        email: z.string().email(),
        age: z.number().int().nonnegative(),
    });
    type User = z.infer<typeof userSchema>; // { id: string; name: string; email: string; age: number; }
    ```

    then `InferSchema<typeof userSchema>` equals that `User` type.

---

## Constructor & Initialization

```ts
export class Collection<T extends z.ZodSchema> {
    private driver: Driver;
    private collectionSchema: CollectionSchema<InferSchema<T>>;
    private pluginManager?: PluginManager;

    constructor(
        driver: Driver,
        schema: CollectionSchema<InferSchema<T>>,
        pluginManager?: PluginManager
    ) {
        this.driver = driver;
        this.collectionSchema = schema;
        this.pluginManager = pluginManager;
        this.createTable();
    }

    private createTable(): void {
        const { sql, additionalSQL } =
            SchemaSQLGenerator.buildCreateTableWithConstraints(
                this.collectionSchema.name,
                this.collectionSchema.constraints,
                this.collectionSchema.constrainedFields,
                this.collectionSchema.schema
            );

        // Create table synchronously
        this.driver.execSync(sql);

        // Execute additional SQL for indexes & constraints
        for (const additionalQuery of additionalSQL) {
            this.driver.execSync(additionalQuery);
        }
    }
    // …
}
```

1. **Parameters**

    - `driver: Driver`

        - An instantiated driver (e.g. `new BunDriver(config)` or `new NodeDriver(config)`).
        - Must implement the `Driver` interface: `exec`, `execSync`, `query`, `querySync`, etc.

    - `schema: CollectionSchema<InferSchema<T>>`

        - Contains:

            - `name: string`  – the SQL table name (e.g. `"users"`).
            - `schema: T`  – your Zod schema object (must include an `id: string`).
            - `constrainedFields?: { [fieldPath: string]: ConstrainedFieldDefinition }`

                - If you want indexes, unique constraints, foreign keys, etc., you declare them here.

            - _(Optionally)_ `constraints` for legacy usage (deprecated) but they’re converted internally to `constrainedFields`.

    - `pluginManager?: PluginManager` (optional)

        - If provided, the Collection will attempt to fire hooks like `onBeforeInsert` / `onAfterInsert`.

2. **Immediate Table Creation**

    - **`SchemaSQLGenerator.buildCreateTableWithConstraints(...)`**

        - Inspects `collectionSchema.schema` (the Zod object) and `constrainedFields`.
        - Outputs one `CREATE TABLE IF NOT EXISTS` statement containing an `_id PRIMARY KEY TEXT` column plus a `doc TEXT NOT NULL` column (stored as JSON).
        - Produces extra SQL statements for any constrained fields (e.g. `CREATE UNIQUE INDEX idx_users_email ON users(email);`).

    - **`this.driver.execSync(sql)`** creates the table immediately.
    - **`additionalSQL.forEach(this.driver.execSync)`** runs each index/constraint creation synchronously.

3. **No Async in Constructor**

    - This design choice ensures your tables and indexes exist before any code runs. If you need truly lazy initialization, wrap in your own logic outside the constructor.

---

## Document Validation

```ts
private validateDocument(doc: any): InferSchema<T> {
  try {
    return this.collectionSchema.schema.parse(doc);
  } catch (error) {
    throw new ValidationError('Document validation failed', error);
  }
}
```

-   Any time you insert/put/upsert, the raw JavaScript object is passed into Zod’s `.parse()`.
-   On success, you get back a fully type‐narrowed object (`InferSchema<T>`).
-   On failure, you throw a `ValidationError` with the underlying Zod error attached (`error.details`).

---

## ID Generation

```ts
private generateId(): string {
  return crypto.randomUUID();
}
```

-   If the user doesn’t provide an `id` field, a `uuid` is generated automatically.
-   If they _do_ supply `id` in `insert(...)`, it’s validated (ensures no duplicate).

---

## Async CRUD Methods

All async methods return Promises and fire plugin hooks **in this order**:

1. `onBeforeXXX` (e.g. `onBeforeInsert`)
2. The SQL operation
3. `onAfterXXX` (e.g. `onAfterInsert`)
4. If any error occurs in step 2 or 3, `onError` hook is fired.

### insert

```ts
async insert(doc: Omit<InferSchema<T>, 'id'>): Promise<InferSchema<T>> {
  const context = {
    collectionName: this.collectionSchema.name,
    schema: this.collectionSchema,
    operation: 'insert',
    data: doc,
  };
  // 1. Fire onBeforeInsert hook
  await this.pluginManager?.executeHookSafe('onBeforeInsert', context);

  try {
    // 2a. If doc.id was provided, check uniqueness
    const docWithPossibleId = doc as any;
    let id: string;
    if (docWithPossibleId.id) {
      id = docWithPossibleId.id;
      const existing = await this.findById(id);
      if (existing) {
        throw new UniqueConstraintError(
          `Document with id '${id}' already exists`,
          'id'
        );
      }
    } else {
      // 2b. Generate new ID
      id = this.generateId();
    }

    // 3. Combine data + id, then validate
    const fullDoc = { ...doc, id };
    const validatedDoc = this.validateDocument(fullDoc);

    // 4. Build INSERT SQL (includes all constrainedFields)
    const { sql, params } = SQLTranslator.buildInsertQuery(
      this.collectionSchema.name,
      validatedDoc,
      id,
      this.collectionSchema.constrainedFields,
      this.collectionSchema.schema
    );
    await this.driver.exec(sql, params);

    // 5. Fire onAfterInsert hook
    const resultContext = { ...context, result: validatedDoc };
    await this.pluginManager?.executeHookSafe('onAfterInsert', resultContext);

    return validatedDoc;
  } catch (error) {
    // 6. Fire onError hook
    const errorContext = { ...context, error: error as Error };
    await this.pluginManager?.executeHookSafe('onError', errorContext);

    // 7. Map SQLite constraint errors to UniqueConstraintError or ValidationError
    if (error instanceof Error) {
      if (error.message.includes('UNIQUE constraint')) {
        const fieldMatch = error.message.match(
          /UNIQUE constraint failed: [^.]+\.([^,\s]+)/
        );
        const field = fieldMatch ? fieldMatch[1] : 'unknown';
        throw new UniqueConstraintError(
          `Document violates unique constraint on field: ${field}`,
          (doc as any).id || 'unknown'
        );
      } else if (error.message.includes('FOREIGN KEY constraint')) {
        throw new ValidationError(
          'Document validation failed: Invalid foreign key reference',
          error
        );
      }
    }
    throw error;
  }
}
```

-   **Parameters**

    -   `doc: Omit<InferSchema<T>, 'id'>` – a partial object without `id`.

-   **Returns**

    -   `Promise<InferSchema<T>>` – the inserted document, including its generated or user‐supplied `id`.

-   **Throws**

    -   `ValidationError` if Zod validation fails.
    -   `UniqueConstraintError` if the `_id` or any unique‐constrained field already exists.
    -   `ValidationError` if a foreign key is invalid.
    -   Any SQL or driver error that doesn’t match these patterns is re‐thrown.

### insertBulk

```ts
async insertBulk(
  docs: Omit<InferSchema<T>, 'id'>[]
): Promise<InferSchema<T>[]> {
  const results: InferSchema<T>[] = [];
  for (const doc of docs) {
    results.push(await this.insert(doc));
  }
  return results;
}
```

-   Simply calls `insert(...)` in series.
-   If any insert fails, the entire method throws; partial inserts won’t be rolled back automatically (no wrapping transaction). If you want atomicity, call `database.transaction(() => collection.insertBulk([...]))`.

### put

```ts
async put(
  id: string,
  doc: Partial<InferSchema<T>>
): Promise<InferSchema<T>> {
  const existing = await this.findById(id);
  if (!existing) {
    throw new NotFoundError('Document not found', id);
  }
  // Merge existing + new data, keep same id
  const updatedDoc = { ...existing, ...doc, id };
  const validatedDoc = this.validateDocument(updatedDoc);

  // Build UPDATE SQL
  const { sql, params } = SQLTranslator.buildUpdateQuery(
    this.collectionSchema.name,
    validatedDoc,
    id,
    this.collectionSchema.constrainedFields,
    this.collectionSchema.schema
  );
  await this.driver.exec(sql, params);
  return validatedDoc;
}
```

-   **Parameters**

    -   `id: string` – the document ID to update.
    -   `doc: Partial<InferSchema<T>>` – an object containing only the fields you wish to change (excluding `id`).

-   **Returns**

    -   `Promise<InferSchema<T>>` – the updated (and validated) document.

-   **Throws**

    -   `NotFoundError` if no document with that `id` exists.
    -   `ValidationError` if merging fails validation.
    -   `UniqueConstraintError` or `ValidationError` on constraint errors.

### putBulk

```ts
async putBulk(
  updates: { id: string; doc: Partial<InferSchema<T>> }[]
): Promise<InferSchema<T>[]> {
  const results: InferSchema<T>[] = [];
  for (const update of updates) {
    results.push(await this.put(update.id, update.doc));
  }
  return results;
}
```

-   Sequentially calls `put(id, doc)` for each update.
-   Similar atomicity considerations as `insertBulk`.

### delete

```ts
async delete(id: string): Promise<boolean> {
  const { sql, params } = SQLTranslator.buildDeleteQuery(
    this.collectionSchema.name,
    id
  );
  await this.driver.exec(sql, params);
  return true;
}
```

-   **Parameters**

    -   `id: string` – the document ID to remove.

-   **Returns**

    -   `Promise<boolean>` – always `true` if SQL runs without error.

-   **Throws**

    -   SQL/Driver errors if something goes wrong.
    -   It does **not** throw `NotFoundError` on missing row; deleting a non‐existent row still resolves to `true`. If you need to check existence first, call `findById`.

### deleteBulk

```ts
async deleteBulk(ids: string[]): Promise<number> {
  let count = 0;
  for (const id of ids) {
    if (await this.delete(id)) count++;
  }
  return count;
}
```

-   Returns the number of successful `delete` calls (all will be counted).

### upsert

```ts
async upsert(
  id: string,
  doc: Omit<InferSchema<T>, 'id'>
): Promise<InferSchema<T>> {
  return this.upsertOptimized(id, doc);
}
```

-   Delegates to `upsertOptimized`.

### upsertOptimized

```ts
async upsertOptimized(
  id: string,
  doc: Omit<InferSchema<T>, 'id'>
): Promise<InferSchema<T>> {
  const fullDoc = { ...doc, id };
  const validatedDoc = this.validateDocument(fullDoc);

  try {
    // If no constrainedFields, use pure INSERT OR REPLACE (faster)
    if (
      !this.collectionSchema.constrainedFields ||
      Object.keys(this.collectionSchema.constrainedFields).length === 0
    ) {
      const sql = `INSERT OR REPLACE INTO ${this.collectionSchema.name} (_id, doc) VALUES (?, ?)`;
      const params = [id, JSON.stringify(validatedDoc)];
      await this.driver.exec(sql, params);
    } else {
      // Build a normal INSERT SQL, then replace “INSERT” with “INSERT OR REPLACE”
      const { sql, params } = SQLTranslator.buildInsertQuery(
        this.collectionSchema.name,
        validatedDoc,
        id,
        this.collectionSchema.constrainedFields,
        this.collectionSchema.schema
      );
      const upsertSQL = sql.replace('INSERT INTO', 'INSERT OR REPLACE INTO');
      await this.driver.exec(upsertSQL, params);
    }
    return validatedDoc;
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('UNIQUE constraint')) {
        const fieldMatch = error.message.match(
          /UNIQUE constraint failed: [^.]+\.([^,\s]+)/
        );
        const field = fieldMatch ? fieldMatch[1] : 'unknown';
        throw new UniqueConstraintError(
          `Document violates unique constraint on field: ${field}`,
          id
        );
      } else if (error.message.includes('FOREIGN KEY constraint')) {
        throw new ValidationError(
          'Document validation failed: Invalid foreign key reference',
          error
        );
      }
    }
    throw error;
  }
}
```

-   **IDempotent**: If the row exists, it’s replaced. If not, it’s inserted.
-   **Faster** than manual check‐then‐insert/update.
-   Still enforces Zod validation and SQL constraints.

### upsertBulk

```ts
async upsertBulk(
  updates: { id: string; doc: Omit<InferSchema<T>, 'id'> }[]
): Promise<InferSchema<T>[]> {
  const results: InferSchema<T>[] = [];
  for (const update of updates) {
    results.push(await this.upsertOptimized(update.id, update.doc));
  }
  return results;
}
```

-   Executes `upsertOptimized` for each item, returning the resulting validated docs.

### findById

```ts
async findById(id: string): Promise<InferSchema<T> | null> {
  const sql = `SELECT doc FROM ${this.collectionSchema.name} WHERE _id = ?`;
  const params = [id];
  const rows = await this.driver.query(sql, params);
  if (rows.length === 0) return null;
  return parseDoc(rows[0].doc);
}
```

-   **Parameters**

    -   `id: string` – the document ID.

-   **Returns**

    -   `Promise<InferSchema<T> | null>` – if found, JSON is parsed and returned; otherwise `null`.

### toArray

```ts
async toArray(): Promise<InferSchema<T>[]> {
  const { sql, params } = SQLTranslator.buildSelectQuery(
    this.collectionSchema.name,
    { filters: [] },
    this.collectionSchema.constrainedFields
  );
  const rows = await this.driver.query(sql, params);
  return rows.map((row) => parseDoc(row.doc));
}
```

-   **Returns**

    -   `Promise<InferSchema<T>[]>` – every document in the collection.
    -   Internally calls `SELECT doc FROM table` (no WHERE).

### count

```ts
async count(): Promise<number> {
  const sql = `SELECT COUNT(*) as count FROM ${this.collectionSchema.name}`;
  const result = await this.driver.query(sql, []);
  return result[0].count;
}
```

-   **Returns**

    -   `Promise<number>` – total number of documents in the collection.

### first

```ts
async first(): Promise<InferSchema<T> | null> {
  const { sql, params } = SQLTranslator.buildSelectQuery(
    this.collectionSchema.name,
    { filters: [], limit: 1 },
    this.collectionSchema.constrainedFields
  );
  const rows = await this.driver.query(sql, params);
  return rows.length > 0 ? parseDoc(rows[0].doc) : null;
}
```

-   **Returns**

    -   `Promise<InferSchema<T> | null>` – the first document by insertion order (unless you added an `ORDER BY` in your query builder).

---

## Sync CRUD Methods

> **Note**: Sync methods are deprecated and will throw if plugins are registered, unless you set `allowSyncWithPlugins: true` in `DBConfig`. When enabled, only synchronous plugin hooks are allowed—async hooks will error. Prefer the async APIs for correctness and plugin support.

### insertSync

```ts
insertSync(doc: Omit<InferSchema<T>, 'id'>): InferSchema<T> {
  const context = {
    collectionName: this.collectionSchema.name,
    schema: this.collectionSchema,
    operation: 'insert',
    data: doc,
  };
  // Fire onBeforeInsert asynchronously (not awaited)
  this.pluginManager
    ?.executeHookSafe('onBeforeInsert', context)
    .catch(console.warn);

  try {
    const docWithPossibleId = doc as any;
    let id: string;
    if (docWithPossibleId.id) {
      id = docWithPossibleId.id;
      const existing = this.findByIdSync(id);
      if (existing) {
        throw new UniqueConstraintError(
          `Document with id '${id}' already exists`,
          'id'
        );
      }
    } else {
      id = this.generateId();
    }

    const fullDoc = { ...doc, id };
    const validatedDoc = this.validateDocument(fullDoc);

    const { sql, params } = SQLTranslator.buildInsertQuery(
      this.collectionSchema.name,
      validatedDoc,
      id,
      this.collectionSchema.constrainedFields,
      this.collectionSchema.schema
    );
    this.driver.execSync(sql, params);

    const resultContext = { ...context, result: validatedDoc };
    this.pluginManager
      ?.executeHookSafe('onAfterInsert', resultContext)
      .catch(console.warn);

    return validatedDoc;
  } catch (error) {
    const errorContext = { ...context, error: error as Error };
    this.pluginManager
      ?.executeHookSafe('onError', errorContext)
      .catch(console.warn);

    if (error instanceof Error) {
      if (error.message.includes('UNIQUE constraint')) {
        const fieldMatch = error.message.match(
          /UNIQUE constraint failed: [^.]+\.([^,\s]+)/
        );
        const field = fieldMatch ? fieldMatch[1] : 'unknown';
        throw new UniqueConstraintError(
          `Document violates unique constraint on field: ${field}`,
          (doc as any).id || 'unknown'
        );
      } else if (error.message.includes('FOREIGN KEY constraint')) {
        throw new ValidationError(
          'Document validation failed: Invalid foreign key reference',
          error
        );
      }
    }
    throw error;
  }
}
```

### insertBulkSync

```ts
insertBulkSync(docs: Omit<InferSchema<T>, 'id'>[]): InferSchema<T>[] {
  const results: InferSchema<T>[] = [];
  for (const doc of docs) {
    results.push(this.insertSync(doc));
  }
  return results;
}
```

### findByIdSync

```ts
findByIdSync(id: string): InferSchema<T> | null {
  if (
    !this.collectionSchema.constrainedFields ||
    Object.keys(this.collectionSchema.constrainedFields).length === 0
  ) {
    // Simple case: only `_id` + `doc`
    const sql = `SELECT doc FROM ${this.collectionSchema.name} WHERE _id = ?`;
    const params = [id];
    const rows = this.driver.querySync(sql, params);
    if (rows.length === 0) return null;
    return parseDoc(rows[0].doc);
  }

  // Case with constrained fields: need to retrieve both `doc` (JSON) and raw constrained columns for merges
  const constrainedFieldColumns = Object.keys(
    this.collectionSchema.constrainedFields
  ).join(', ');
  const sql = `SELECT doc, ${constrainedFieldColumns} FROM ${
    this.collectionSchema.name
  } WHERE _id = ?`;
  const params = [id];
  const rows = this.driver.querySync(sql, params);
  if (rows.length === 0) return null;
  return mergeConstrainedFields(rows[0], this.collectionSchema.constrainedFields);
}
```

-   If you have `constrainedFields`, the table may store certain document fields as native SQL columns for faster lookups (e.g. storing `email` in its own column so you can index `email`). In that case, `mergeConstrainedFields(...)` reassembles a final JSON document by overriding field values from the raw row.

### toArraySync

```ts
toArraySync(): InferSchema<T>[] {
  const { sql, params } = SQLTranslator.buildSelectQuery(
    this.collectionSchema.name,
    { filters: [] },
    this.collectionSchema.constrainedFields
  );
  const rows = this.driver.querySync(sql, params);
  return rows.map((row) => parseDoc(row.doc));
}
```

### countSync

```ts
countSync(): number {
  const sql = `SELECT COUNT(*) as count FROM ${this.collectionSchema.name}`;
  const result = this.driver.querySync(sql, []);
  return result[0].count;
}
```

### firstSync

```ts
firstSync(): InferSchema<T> | null {
  const { sql, params } = SQLTranslator.buildSelectQuery(
    this.collectionSchema.name,
    { filters: [], limit: 1 },
    this.collectionSchema.constrainedFields
  );
  const rows = this.driver.querySync(sql, params);
  return rows.length > 0 ? parseDoc(rows[0].doc) : null;
}
```

### putSync

```ts
putSync(id: string, doc: Partial<InferSchema<T>>): InferSchema<T> {
  const existing = this.findByIdSync(id);
  if (!existing) {
    throw new NotFoundError('Document not found', id);
  }
  const updatedDoc = { ...existing, ...doc, id };
  const validatedDoc = this.validateDocument(updatedDoc);

  try {
    const { sql, params } = SQLTranslator.buildUpdateQuery(
      this.collectionSchema.name,
      validatedDoc,
      id,
      this.collectionSchema.constrainedFields,
      this.collectionSchema.schema
    );
    this.driver.execSync(sql, params);
    return validatedDoc;
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('UNIQUE constraint')) {
        const fieldMatch = error.message.match(
          /UNIQUE constraint failed: [^.]+\.([^,\s]+)/
        );
        const field = fieldMatch ? fieldMatch[1] : 'unknown';
        throw new UniqueConstraintError(
          `Document violates unique constraint on field: ${field}`,
          id
        );
      } else if (error.message.includes('FOREIGN KEY constraint')) {
        throw new ValidationError(
          'Document validation failed: Invalid foreign key reference',
          error
        );
      }
    }
    throw error;
  }
}
```

### deleteSync

```ts
deleteSync(id: string): boolean {
  const { sql, params } = SQLTranslator.buildDeleteQuery(
    this.collectionSchema.name,
    id
  );
  this.driver.execSync(sql, params);
  return true;
}
```

### deleteBulkSync

```ts
deleteBulkSync(ids: string[]): number {
  let count = 0;
  for (const id of ids) {
    if (this.deleteSync(id)) count++;
  }
  return count;
}
```

### upsertSync

```ts
upsertSync(id: string, doc: Omit<InferSchema<T>, 'id'>): InferSchema<T> {
  try {
    const existing = this.findByIdSync(id);
    if (existing) {
      // Simply call putSync
      return this.putSync(id, doc as Partial<InferSchema<T>>);
    } else {
      // Insert with user‐supplied id
      return this.insertSync({ ...doc, id } as any);
    }
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('UNIQUE constraint')) {
        const fieldMatch = error.message.match(
          /UNIQUE constraint failed: [^.]+\.([^,\s]+)/
        );
        const field = fieldMatch ? fieldMatch[1] : 'unknown';
        throw new UniqueConstraintError(
          `Document violates unique constraint on field: ${field}`,
          id
        );
      } else if (error.message.includes('FOREIGN KEY constraint')) {
        throw new ValidationError(
          'Document validation failed: Invalid foreign key reference',
          error
        );
      }
    }
    throw error;
  }
}
```

### upsertBulkSync

```ts
upsertBulkSync(
  docs: { id: string; doc: Omit<InferSchema<T>, 'id'> }[]
): InferSchema<T>[] {
  const results: InferSchema<T>[] = [];
  for (const item of docs) {
    results.push(this.upsertSync(item.id, item.doc));
  }
  return results;
}
```

### putBulkSync

```ts
putBulkSync(
  updates: { id: string; doc: Partial<InferSchema<T>> }[]
): InferSchema<T>[] {
  const results: InferSchema<T>[] = [];
  for (const update of updates) {
    results.push(this.putSync(update.id, update.doc));
  }
  return results;
}
```

---

## Fluent Query Builder

Rather than building raw SQL strings yourself, you can use the provided **`QueryBuilder<T>`** and **`FieldBuilder<T, K>`**. Every time you call a method that builds a query (e.g. `where('age').gt(18)`), you get back a `QueryBuilder<InferSchema<T>>` with all options accumulated in an internal `QueryOptions` object. When you finally call `toArray()`, `exec()`, or `first()`, the SQL is generated for you.

All builder methods automatically validate that the given field path exists in the Zod schema (unless you use a nested JSON field like `metadata.category`, in which case validation is skipped because it’s interpreted via `json_extract(...)`). If you supply an invalid field name, you get a `ValidationError`.

### where

```ts
where<K extends QueryablePaths<InferSchema<T>>>(
  field: K
): FieldBuilder<InferSchema<T>, K> & { collection: Collection<T> };

where(field: string): FieldBuilder<InferSchema<T>, any> & { collection: Collection<T> };
```

-   **Usage**

    ```ts
    collection.where('email').eq('bob@example.com').toArray();
    collection.where('age').gte(18).lt(65).toArray();
    collection.where('metadata.category').eq('sports').toArray();
    ```

-   **Return Value**

    -   A `FieldBuilder<…, K>` that lets you chain comparison operators (e.g. `.eq()`, `.gt()`, `.like()`, `.in()`, etc.).
    -   Once you call a comparison operator (say `.eq(...)`), that returns a `QueryBuilder<T>`, on which you can call `.orderBy()`, `.limit()`, etc.

### orderBy / orderByMultiple

```ts
orderBy<K extends OrderablePaths<InferSchema<T>>>(
  field: K,
  direction?: 'asc' | 'desc'
): QueryBuilder<InferSchema<T>>;
orderBy(field: string, direction?: 'asc' | 'desc'): QueryBuilder<InferSchema<T>>;

orderByMultiple(
  orders: { field: keyof InferSchema<T>; direction?: 'asc' | 'desc' }[]
): QueryBuilder<InferSchema<T>>;
```

-   **Usage**

    ```ts
    collection.where('age').gt(18).orderBy('age', 'desc').toArray();
    collection
        .orderByMultiple([
            { field: 'name', direction: 'asc' },
            { field: 'createdAt', direction: 'desc' },
        ])
        .toArray();
    ```

-   **Validation**

    -   Ensures the field is a primitive (string, number, boolean, Date) or nested primitive.

### limit / offset / page

```ts
limit(count: number): QueryBuilder<InferSchema<T>>;
offset(count: number): QueryBuilder<InferSchema<T>>;
page(pageNumber: number, pageSize: number): QueryBuilder<InferSchema<T>>;
```

-   **Usage**

    ```ts
    collection
        .where('active')
        .eq(true)
        .orderBy('name')
        .limit(20)
        .offset(40)
        .toArray();
    // Or:
    collection.where('active').eq(true).orderBy('name').page(3, 20).toArray();
    ```

-   **Internals**

    -   `page(p, s)` is sugar for `.limit(s).offset((p - 1) * s)`.

### distinct / or

```ts
distinct(): QueryBuilder<InferSchema<T>>;
or(
  builderFn: (b: QueryBuilder<InferSchema<T>>) => QueryBuilder<InferSchema<T>>
): QueryBuilder<InferSchema<T>>;
```

-   `distinct()` adds `SELECT DISTINCT doc` instead of `SELECT doc`.
-   `or(...)` allows grouping filters:

    ```ts
    collection
        .where('age')
        .gt(18)
        .or((b) => b.where('role').eq('admin').where('role').eq('moderator'))
        .toArray();
    ```

    translates to:

    ```
    SELECT doc FROM users
    WHERE (age > 18) OR ((role = 'admin') AND (role = 'moderator'))
    ```

    (i.e. the contents of the callback become a separate AND group, then OR’d with existing filters).

### Async vs. Sync Query Execution

Every `QueryBuilder<T>` has both async and sync execution methods. Once you finish chaining:

-   **Async**

    -   `await qb.toArray()` or `await qb.exec()` returns `T[]`.
    -   `await qb.first()` returns `T | null`.
    -   `await qb.executeCount()` returns `number`.

-   **Sync**

    -   `qb.toArraySync()` returns `T[]`.
    -   `qb.firstSync()` returns `T | null`.
    -   `qb.countSync()` returns `number`.

Attempting to call `toArray()` directly on `FieldBuilder` (before a comparison operator) will throw an error:

> “`toArray() should not be called on FieldBuilder. Use a comparison operator first.`”

---

## Plugin Hooks

If you passed a `PluginManager` into the constructor, Collection fires these hooks at the appropriate times:

1. **`onBeforeInsert(context)`**  before validating or inserting a document.
2. **`onAfterInsert(context)`**  after a successful insert.
3. **`onBeforeUpdate(context)`** / **`onAfterUpdate(context)`** for `put` & `upsert`.
4. **`onBeforeDelete(context)`** / **`onAfterDelete(context)`** for `delete`.
5. **`onBeforeQuery(context)`** / **`onAfterQuery(context)`** for any `.toArray()`, `.first()`, `.executeCount()`.
6. **`onError(context)`**  if any of the above operations throw.

Each hook receives a `PluginContext` object:

```ts
interface PluginContext {
    collectionName: string;
    schema: CollectionSchema;
    operation: string; // e.g. 'insert', 'update', 'delete', 'query', etc.
    data?: any; // input data (document) for insert/update
    result?: any; // resulting document or query result
    error?: Error; // if an error occurred
}
```

-   Hooks run **in sequence** for each registered plugin.
-   If a hook throws (or times out), `executeHookSafe` catches errors so that plugin failures do not break your application—unless you enabled strict mode in `PluginManager`.

---

## Error Types

-   **`ValidationError`** (extends `Error`)

    -   Thrown if Zod schema validation fails, or if a foreign key constraint is violated.
    -   Constructor: `new ValidationError(message: string, details?: any)`.

-   **`UniqueConstraintError`** (extends `Error`)

    -   Thrown when a SQL UNIQUE constraint fails.
    -   Constructor: `new UniqueConstraintError(message: string, field?: string)`.

-   **`NotFoundError`** (extends `Error`)

    -   Thrown when you try to `put(...)` or `putSync(...)` a document ID that does not exist.
    -   Constructor: `new NotFoundError(message: string, id?: string)`.

-   **`DatabaseError`** / **`PluginError`** / **`PluginTimeoutError`** are thrown by other layers (driver, plugin system) as needed.

---

## Examples

Below are some concrete examples (TypeScript) showing how to use a Collection in a typical application. Assume we have a `Database` instance already instantiated:

```ts
// src/models/user.ts
import { z } from 'zod';
import type { Driver, ConstrainedFieldDefinition } from '../types';
import { Collection } from '../collection';
import { TimestampPlugin } from '../plugins/timestamp';
import { validationPlugin } from '../plugins/validation';
import type { PluginManager } from '../plugin-system';

// 1. Define a Zod schema for User
export const userSchema = z.object({
    id: z.string(), // required by Collection
    name: z.string().min(1),
    email: z.string().email(),
    age: z.number().int().nonnegative(),
    role: z.enum(['user', 'admin', 'moderator']),
    metadata: z
        .object({
            category: z.string().optional(),
            notificationsEnabled: z.boolean().optional(),
        })
        .optional(),
    createdAt: z.date(), // timestamps handled by plugin
    updatedAt: z.date(),
});

// 2. Specify constrainedFields (e.g. unique email, foreign key on role later)
const constrainedFields: { [fieldPath: string]: ConstrainedFieldDefinition } = {
    email: {
        type: 'unique',
        // SQLite type guessed from Zod: TEXT
    },
};

// 3. Build a CollectionSchema
import type { CollectionSchema, InferSchema } from '../types';
const userCollectionSchema: CollectionSchema<InferSchema<typeof userSchema>> = {
    name: 'users',
    schema: userSchema,
    constrainedFields,
    // “constraints” can be omitted if using constrainedFields
};

// 4. Suppose we already have a Database instance: `db: Database`
// PluginManager is usually instantiated within Database if you called `db.use(...)`,
// but you can also pass your own:
import { PluginManager } from '../plugin-system';
const pluginManager = new PluginManager({ strictMode: true });

// Register plugins (e.g. auto‐timestamp, custom validation rules)
pluginManager.register(
    new TimestampPlugin({
        createField: 'createdAt',
        updateField: 'updatedAt',
        autoCreate: true,
        autoUpdate: true,
    })
);
pluginManager.register(
    validationPlugin({
        rules: [
            {
                field: 'age',
                validator: (value) => (value < 18 ? 'Must be 18+' : true),
                message: 'User must be at least 18',
            },
        ],
        strictMode: true,
    })
);

// 5. Create the Collection
//   Note: `db.getDriver()` is assumed to return a `Driver` instance
const users = new Collection(
    db.getDriver(), // low‐level SQL driver
    userCollectionSchema,
    pluginManager // enables timestamp + custom validation
);

// --- Insert a new user ---
async function createUser() {
    try {
        const newUser = await users.insert({
            name: 'Alice Johnson',
            email: 'alice@example.com',
            age: 25,
            role: 'user',
            // No id: auto‐generated. createdAt/updatedAt auto‐added by TimestampPlugin.
        });
        console.log('Created user:', newUser);
    } catch (err) {
        console.error('Failed to create user:', err);
    }
}

// --- Query: find all admins older than 30, sorted by name ---
async function listAdmins() {
    const admins = await users
        .where('role')
        .eq('admin')
        .where('age')
        .gt(30)
        .orderBy('name', 'asc')
        .toArray();

    console.log('Admins > 30, sorted by name:', admins);
}

// --- Update (put) a user ---
async function updateEmail(userId: string, newEmail: string) {
    try {
        const updated = await users.put(userId, { email: newEmail });
        console.log('Email updated:', updated);
    } catch (err) {
        console.error('Failed to update email:', err);
    }
}

// --- Upsert: create if not exists, else replace ---
async function upsertUser(
    userId: string,
    data: Omit<InferSchema<typeof userSchema>, 'id'>
) {
    try {
        const upserted = await users.upsert(userId, data);
        console.log('Upserted user:', upserted);
    } catch (err) {
        console.error('Failed to upsert:', err);
    }
}

// --- Delete a user by ID ---
async function removeUser(userId: string) {
    await users.delete(userId);
    console.log('User removed');
}

// --- Count & first / toArray ---
async function getStats() {
    const totalUsers = await users.count();
    const firstUser = await users.first();
    const allUsers = await users.toArray();
    console.log({ totalUsers, firstUser, allUsers });
}

// --- Sync Example (only call from synchronous context, e.g. a simple script) ---
function syncExample() {
    // 1. Insert synchronously
    const bob = users.insertSync({
        name: 'Bob Smith',
        email: 'bob@example.com',
        age: 30,
        role: 'user',
    });
    console.log('Bob inserted (sync):', bob);

    // 2. Query sync
    const foundBob = users.where('email').eq('bob@example.com').firstSync();
    console.log('Found Bob (sync):', foundBob);

    // 3. Count sync
    console.log('Total users (sync):', users.countSync());

    // 4. Delete sync
    users.deleteSync(bob.id);
    console.log('Bob deleted (sync)');
}
```

---

## Field Name Validation

Internally, methods like `where(field: string)` or `orderBy(field: string)` call:

```ts
private validateFieldName(fieldName: string): void {
  if (fieldName.includes('.')) {
    // Nested JSON path (e.g. "metadata.category")—skip validation
    return;
  }
  // Otherwise, extract valid top‐level fields from the Zod object:
  const schema = this.collectionSchema.schema as any;
  let validFields: string[] = [];
  if (schema.shape) {
    validFields = Object.keys(schema.shape);
  } else if (schema._def && schema._def.shape) {
    validFields = Object.keys(schema._def.shape);
  } else if (schema._def && typeof schema._def.shape === 'function') {
    validFields = Object.keys(schema._def.shape());
  }
  if (validFields.length > 0 && !validFields.includes(fieldName)) {
    throw new ValidationError(
      `Field '${fieldName}' does not exist in schema. Valid fields: ${validFields.join(
        ', '
      )}`
    );
  }
  // If we can’t determine valid fields, skip validation (backward compatibility)
}
```

-   Nested paths with `.` are assumed to reference JSON fields and are handled in SQL via `json_extract(...)`.
-   If you supply a nonexistent top‐level field (e.g. `where('nonexistent')`), you get a `ValidationError`.

---

## How Constrained Fields Work

If you set `constrainedFields` in your `CollectionSchema`, the code:

1. Adds extra columns for each constrained field next to the `doc TEXT` column.
2. Builds indexes / unique constraints / foreign keys at table creation.
3. On any `findByIdSync`, `findById`, etc., it does:

    - `SELECT doc, fieldA, fieldB, ... FROM table WHERE _id = ?`.
    - Calls `mergeConstrainedFields(...)` to overwrite the JSON’s property values with the raw SQL‐column values (this is required if you have cascade deletes or default values).

Inserts/updates automatically populate both the JSON `doc` column **and** any constrained field columns.

---

## Summary of Key Methods & Return Types

| Method                     | Signature                                                                               | Returns                                   | Throws                                                                  |                      |
| -------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------- | -------------------- |
| **insert**                 | `insert(doc: Omit<InferSchema<T>, 'id'>): Promise<InferSchema<T>>`                      | Inserted document (with `id`).            | `ValidationError`, `UniqueConstraintError`, `ValidationError(FK)`.      |                      |
| **insertBulk**             | `insertBulk(docs: Omit<InferSchema<T>, 'id'>[]): Promise<InferSchema<T>[]>`             | Array of inserted docs.                   | Same as `insert`, stops on first error.                                 |                      |
| **put**                    | `put(id: string, doc: Partial<InferSchema<T>>): Promise<InferSchema<T>>`                | Updated document.                         | `NotFoundError`, `ValidationError`, `UniqueConstraintError`.            |                      |
| **putBulk**                | `putBulk(updates: {id,doc}[]): Promise<InferSchema<T>[]>`                               | Array of updated docs.                    | Same as `put`, stops on first error.                                    |                      |
| **delete**                 | `delete(id: string): Promise<boolean>`                                                  | `true` always if SQL executes.            | Only raw SQL errors.                                                    |                      |
| **deleteBulk**             | `deleteBulk(ids: string[]): Promise<number>`                                            | Number of successful deletes.             | Only raw SQL errors.                                                    |                      |
| **upsert**                 | `upsert(id: string, doc: Omit<InferSchema<T>, 'id'>): Promise<InferSchema<T>>`          | Inserted or replaced doc.                 | `ValidationError`, `UniqueConstraintError`, `ValidationError(FK)`.      |                      |
| **upsertOptimized**        | `upsertOptimized(id: string, doc: Omit<InferSchema<T>, 'id'>): Promise<InferSchema<T>>` | Same as `upsert`.                         | Same as `upsert`.                                                       |                      |
| **upsertBulk**             | `upsertBulk(docs: {id,doc}[]): Promise<InferSchema<T>[]>`                               | Array of upserted docs.                   | Same as `upsert`, stops on first error.                                 |                      |
| **findById**               | \`findById(id: string): Promise\<InferSchema<T>                                         | null>\`                                   | Document if found, else `null`.                                         | Only raw SQL errors. |
| **toArray**                | `toArray(): Promise<InferSchema<T>[]>`                                                  | All documents in collection.              | Only raw SQL errors.                                                    |                      |
| **count**                  | `count(): Promise<number>`                                                              | Total document count.                     | Only raw SQL errors.                                                    |                      |
| **first**                  | \`first(): Promise\<InferSchema<T>                                                      | null>\`                                   | First document or `null`.                                               | Only raw SQL errors. |
| **where(...).eq(...)**     | `where<K>(field: K).eq(value): QueryBuilder<InferSchema<T>>`                            | QueryBuilder; call `.toArray()` to fetch. | `ValidationError` if invalid field.                                     |                      |
| **orderBy / limit / etc.** | Many overrides: `orderBy(field, direction): QueryBuilder<InferSchema<T>>`               | QueryBuilder; call `.toArray()` to fetch. | `ValidationError` if invalid field or misuse.                           |                      |
|                            |                                                                                         |                                           |                                                                         |                      |
| **Sync Versions**          | Same names with `Sync` suffix (e.g. `insertSync`, `toArraySync`, `countSync`, etc.)     | Return data or throw, synchronously.      | Throws same errors, but plugin hooks run _in background_ (not awaited). |                      |

---

## Final Notes

-   All JSON documents are stored in a single `doc TEXT NOT NULL` column (JSON‐serialized).
-   Constrained fields (if any) are stored in native SQL columns alongside the JSON column, for indexing and constraint enforcement.
-   Validation is always done through Zod _before_ hitting the SQL layer.
-   Plugin hooks let you automatically add timestamps, run custom validation rules, audit logs, metrics, caches, etc.
-   Use async methods in production to ensure plugin hooks run in order and you catch errors properly. Only use sync methods in simple scripts that don’t care about hooks.

With this documentation, you should be able to:

1. Understand how the Collection class initializes its table and indexes.
2. Validate and insert/update documents safely.
3. Perform both basic “get all” operations (`toArray` / `count` / `first`) and complex queries via the fluent QueryBuilder (`where` / `orderBy` / `limit`, etc.).
4. Handle unique, foreign‐key, and other constraints automatically.
5. Integrate plugin hooks to customize behavior around every CRUD operation.

That covers everything in **`src/collection.ts`**. Use the examples above as templates for your code.
