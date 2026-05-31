# Schema Constraints and SQL Generation

This document covers two related modules:

1. **`schema-constraints.ts`** (Deprecated Constraint Definitions)
2. **`SchemaSQLGenerator`** (SQL Generation based on `constrainedFields`)

---

## 1. `schema-constraints.ts`

> **Note**: The entire constraint system in this file is **deprecated** in favor of `constrainedFields` (see `types.ts`).
> These definitions will be removed in v2.0.0. Only `IndexDefinition` remains fully supported; other constraint types are ignored.

### 1.1 Deprecated Constraint Interfaces

All of the following interfaces are marked `@deprecated` and should be replaced by `ConstrainedFieldDefinition` entries in your collection schema.

```ts
export interface UniqueConstraint {
    type: 'unique';
    name?: string; // Optional user-defined index name
    fields: string[]; // List of top-level field names involved in the unique constraint
}

export interface ForeignKeyConstraint {
    type: 'foreign_key';
    name?: string; // Optional name for the foreign key
    fields: string[]; // Local field paths (top-level) that reference another table
    referencedTable: string; // The table being referenced
    referencedFields: string[]; // Field(s) in the referenced table (usually ['id'])
    onDelete?: 'cascade' | 'set_null' | 'restrict' | 'no_action';
    onUpdate?: 'cascade' | 'set_null' | 'restrict' | 'no_action';
}

export interface CheckConstraint {
    type: 'check';
    name?: string; // Optional constraint name
    expression: string; // Arbitrary SQL expression (e.g. "age > 0")
}

export type Constraint =
    | UniqueConstraint
    | ForeignKeyConstraint
    | CheckConstraint;

export interface SchemaConstraints {
    constraints?: { [field: string]: Constraint | Constraint[] };
    indexes?: { [name: string]: IndexDefinition };
    tableLevelConstraints?: Constraint[];
}
```

-   **`UniqueConstraint`**: Intended for single- or multi-column unique constraints. Ultimately, the engine will ignore these and use `constrainedFields` for uniqueness instead.
-   **`ForeignKeyConstraint`**: Intended for single- or multi-column foreign key constraints. Ignored in favor of `constrainedFields` definitions.
-   **`CheckConstraint`**: Intended for arbitrary SQL `CHECK(...)` expressions. Ignored in favor of `constrainedFields`.
-   **`SchemaConstraints`**: A top-level object that grouped per-field `constraints` and named `indexes`.

> **Key Point**: Starting in v2.0.0, you must use the `constrainedFields` property on your collection schema (see `types.ts`) to define unique, nullable, foreign key, and check constraints. The old system here is here only for backward compatibility and will be removed.

---

### 1.2 `IndexDefinition` (Supported)

Unlike the other types, `IndexDefinition` remains valid and used by the SQL generator (when you supply a `SchemaConstraints.indexes` map). Its structure:

```ts
export interface IndexDefinition {
    type: 'index';
    name?: string; // Optional index name; if omitted, a default name may be generated.
    fields: string[]; // List of JSON field paths (top-level or nested) to index. Uses `json_extract(doc, '$.field')` under the hood.
    unique?: boolean; // If `true`, the index is created as `UNIQUE INDEX`.
    partial?: string; // Optional SQL `WHERE` clause for a partial index (e.g. "age > 18").
}
```

-   **`fields`** refers to the JSON paths inside your `doc` column (e.g., `['email']` or `['metadata.category']`). SQL indexes will be defined using `json_extract(doc, '$.field')`.
-   **`unique`** triggers a `UNIQUE INDEX` instead of a normal index.
-   **`partial`** allows you to specify a `WHERE` clause for partial indexing.

Even though the rest of `SchemaConstraints` is deprecated, if you supply `{ indexes: { ... } }` in your old collection definition, the SQL generator will still create these indexes before v2.0.0.

---

### 1.3 Helper Functions (Deprecated)

To facilitate building the old constraint objects, these helper functions were provided, but they are fully deprecated:

```ts
export function unique(name?: string): UniqueConstraint;
export function foreignKey(
    referencedTable: string,
    referencedField: string = 'id',
    options?: {
        name?: string;
        onDelete?: ForeignKeyConstraint['onDelete'];
        onUpdate?: ForeignKeyConstraint['onUpdate'];
    }
): ForeignKeyConstraint;
export function check(expression: string, name?: string): CheckConstraint;
export function index(
    fields?: string | string[],
    options?: { name?: string; unique?: boolean; partial?: string }
): IndexDefinition;
export function compositeUnique(
    fields: string[],
    name?: string
): UniqueConstraint;
export function compositeForeignKey(
    fields: string[],
    referencedTable: string,
    referencedFields: string[],
    options?: {
        name?: string;
        onDelete?: ForeignKeyConstraint['onDelete'];
        onUpdate?: ForeignKeyConstraint['onUpdate'];
    }
): ForeignKeyConstraint;
```

-   All of these are marked `@deprecated` and will be removed. You should instead define a `constrainedFields: { [fieldPath: string]: ConstrainedFieldDefinition }` map (see below).

---

## 2. `SchemaSQLGenerator` (Using `constrainedFields`)

Located in **`schema-sql-generator.ts`**, this class generates the `CREATE TABLE` statement **plus** any needed index creation statements, based on:

-   **`tableName: string`**: The SQL table to create (e.g., `'users'`).
-   **`constraints?: SchemaConstraints`** (Deprecated): Only `indexes` are processed, via `buildIndexSQL`. All other constraint sections (unique, foreign key, check) are ignored.
-   **`constrainedFields?: { [fieldPath: string]: ConstrainedFieldDefinition }`**: The recommended way to declare per-field constraints. (See `types.ts` for `ConstrainedFieldDefinition`.)
-   **`schema?: any`**: The Zod schema object for the collection, used to validate `constrainedFields` and infer SQLite types.

### 2.1 `buildCreateTableWithConstraints(...)`

```ts
static buildCreateTableWithConstraints(
  tableName: string,
  constraints?: SchemaConstraints,
  constrainedFields?: { [fieldPath: string]: ConstrainedFieldDefinition },
  schema?: any
): { sql: string; additionalSQL: string[] } { /* ... */ }
```

This produces two outputs:

-   **`sql: string`**: A single `CREATE TABLE IF NOT EXISTS tableName ( … )` statement, including:

    1. **`_id TEXT PRIMARY KEY`**: The unique identifier column.
    2. **`doc TEXT NOT NULL`**: The JSON column storing the entire document.
    3. **Additional columns** for each entry in `constrainedFields` (see below).

-   **`additionalSQL: string[]`**: An array of extra SQL commands (e.g. `CREATE INDEX …`) for either:

    -   The legacy `SchemaConstraints.indexes` map (via `buildIndexSQL`).
    -   Potentially other table-level statements (in a future version).

#### 2.1.1 Generating the Base Table Definition

```sql
CREATE TABLE IF NOT EXISTS ${tableName} (
  _id TEXT PRIMARY KEY,
  doc TEXT NOT NULL
  -- Additional columns for each constrained field appended here
);
```

-   Always includes `_id TEXT PRIMARY KEY` and `doc TEXT NOT NULL`.

#### 2.1.2 Handling `constrainedFields`

If you supply a map like:

```ts
constrainedFields: {
  'email': {
    type: 'TEXT',               // Zod type inference helper
    unique: true,
    nullable: false,
  },
  'metadata.category': {
    type: 'TEXT',
    checkConstraint: "metadata.category IN ('tech','news','sports')",
  },
  'authorId': {
    type: 'TEXT',
    foreignKey: 'users._id',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE'
  }
}
```

For each `(fieldPath, fieldDef)` pair:

1. **`validateConstrainedFields(schema, constrainedFields)`**

    - Ensures each `fieldPath` exists in the Zod `schema` or is a valid nested path.
    - Returns an array of errors if any `fieldPath` is invalid. Throws if any exist.

2. **`fieldPathToColumnName(fieldPath)`**

    - Transforms a JSON path into a valid SQL column name. For example:

        - `'email'` → `'email'`
        - `'metadata.category'` → `'metadata_category'`

    - Ensures no special characters remain, so you can store each constrained field in its own column.

3. **`getZodTypeForPath(schema, fieldPath)`**

    - Inspects the Zod schema to find the `ZodType` at that path. If found, you can infer a better SQLite type (e.g. `INTEGER` for `z.number().int()`).
    - If not found (e.g. unknown path), you may default to `'TEXT'`.

4. **`inferSQLiteType(zodType, fieldDef)`**

    - Based on the extracted `zodType` and any `fieldDef` hints (e.g. `fieldDef.type === 'number'`), returns a string like `'TEXT'`, `'INTEGER'`, `'REAL'`, or `'BLOB'`.
    - Common mappings:

        - `z.string()` → `TEXT`
        - `z.number().int()` → `INTEGER`
        - `z.number()` → `REAL`
        - `z.boolean()` → `INTEGER` (`0/1`)
        - `z.date()` → `TEXT` (ISO string) or `INTEGER` (Unix timestamp), depending on plugin choice.

5. **Build the column definition**:

    ```sql
    {columnName} {sqliteType} [NOT NULL] [UNIQUE] [REFERENCES {table}({column}) ON DELETE ... ON UPDATE ...] [CHECK (...)]
    ```

    - **`NOT NULL`** if `fieldDef.nullable === false`. Default is nullable.
    - **`UNIQUE`** if `fieldDef.unique === true`.
    - **Foreign Key**: If `fieldDef.foreignKey` is present, parse it using `parseForeignKeyReference`, which yields `{ table, column }`. Then append:

        ```sql
        REFERENCES {table}({actualColumn})
        [ON DELETE {action}]
        [ON UPDATE {action}]
        ```

        - Note: If you reference another collection’s `id`, you must map it to `_id`, since the actual PK column is named `_id`. (E.g. `REFERENCES users(_id)`.)

    - **`CHECK`**: If `fieldDef.checkConstraint` is provided (a string using the original `fieldPath`), replace occurrences of `fieldPath` with the actual `columnName` and wrap in `CHECK(...)`. For example:

        - Given `checkConstraint: "age > 0"` on `fieldPath = "age"`, and `columnName = "age"`, produce: `CHECK (age > 0)`.
        - For nested paths like `metadata.category`, replace `metadata.category` with `metadata_category` in the expression.

6. **Append the column definition** to the `CREATE TABLE` block after `doc TEXT NOT NULL`, separated by commas:

    ```sql
    CREATE TABLE IF NOT EXISTS users (
      _id TEXT PRIMARY KEY,
      doc TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      metadata_category TEXT,
      authorId TEXT,
      …
    )
    ```

#### 2.1.3 Handling Legacy `SchemaConstraints.indexes`

If you provided a `constraints.indexes` object (deprecated), each named index is converted via `buildIndexSQL`:

```ts
if (constraints && constraints.indexes) {
    for (const [indexName, indexDef] of Object.entries(constraints.indexes)) {
        additionalSQL.push(this.buildIndexSQL(indexName, indexDef, tableName));
    }
}
```

-   `additionalSQL` thus accumulates `CREATE INDEX IF NOT EXISTS …` statements. These run **after** the `CREATE TABLE` statement.

#### 2.1.4 Final Return Value

After assembling the main `CREATE TABLE` statement plus any additional index SQL, the function returns:

```ts
return { sql: <createTableStatement>, additionalSQL: [<index creations>] };
```

A caller (such as the `Collection` constructor) will do:

```ts
const { sql, additionalSQL } = SchemaSQLGenerator.buildCreateTableWithConstraints(...);
this.driver.execSync(sql);
for (const idxSQL of additionalSQL) {
  this.driver.execSync(idxSQL);
}
```

### 2.2 `buildIndexSQL(indexName, indexDef, tableName)`

```ts
private static buildIndexSQL(
  indexName: string,
  indexDef: IndexDefinition,
  tableName: string
): string {
  const uniqueKeyword = indexDef.unique ? 'UNIQUE ' : '';
  const fields = indexDef.fields
    .map((f) => `json_extract(doc, '$.${f}')`)
    .join(', ');
  const whereClause = indexDef.partial
    ? ` WHERE ${indexDef.partial}`
    : '';

  return `CREATE ${uniqueKeyword}INDEX IF NOT EXISTS ${indexName} ON ${tableName} (${fields})${whereClause}`;
}
```

-   **`indexName`**: Name of the index (must be unique in the database). If omitted in your old `SchemaConstraints`, a default index name should still be provided.
-   **`indexDef.unique`**: If `true`, generates `CREATE UNIQUE INDEX IF NOT EXISTS {indexName} ON …`. Otherwise `CREATE INDEX IF NOT EXISTS {indexName} ON …`.
-   **`indexDef.fields`**: An array of JSON field paths (e.g. `['email', 'metadata.category']`). Each is mapped to `json_extract(doc, '$.{field}')` so that SQLite indexes on the JSON value inside the `doc` column.
-   **`indexDef.partial`**: Optional SQL `WHERE` clause (e.g. `"age > 18"`). If provided, appended as `WHERE {partial}`.

**Example**:

```ts
const idxDef: IndexDefinition = {
    type: 'index',
    name: 'idx_users_email',
    fields: ['email'],
    unique: true,
};

const idxSQL = SchemaSQLGenerator.buildIndexSQL(
    'idx_users_email',
    idxDef,
    'users'
);

// idxSQL ===
// `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (json_extract(doc, '$.email'))`
```

---

## 3. Example Usage in a Collection Constructor

When a `Collection` is instantiated (in `collection.ts`), it might call something like:

```ts
const { sql, additionalSQL } =
    SchemaSQLGenerator.buildCreateTableWithConstraints(
        this.collectionSchema.name,
        this.collectionSchema.constraints,
        this.collectionSchema.constrainedFields,
        this.collectionSchema.schema
    );

// Run main CREATE TABLE…
this.driver.execSync(sql);
// Then run each index / additional statement
for (const additionalQuery of additionalSQL) {
    this.driver.execSync(additionalQuery);
}
```

-   **`this.collectionSchema.constraints`**: Legacy `SchemaConstraints` object. Only `indexes` are honored.
-   **`this.collectionSchema.constrainedFields`**: Modern, fully supported map of fieldPath → `ConstrainedFieldDefinition`. Will produce real SQL columns, constraints, and checks.
-   **`this.collectionSchema.schema`**: Zod schema used to validate each document and constrained field.

After this step, the actual SQL table exists on disk (or in memory). Subsequent operations (`insert`, `put`, `findById`, etc.) reference the `_id` column, the `doc` column, and any constrained field columns for faster lookups or foreign key enforcement.

---

## 4. Transition from `SchemaConstraints` to `constrainedFields`

Because the old `SchemaConstraints` system is deprecated:

-   **Do not define** `constraints: { … }` or `indexes: { … }` in new code. Instead, specify `constrainedFields` in your collection schema JSON.
-   A `ConstrainedFieldDefinition` (in `types.ts`) allows you to define:

    -   `unique: boolean` → generates a `UNIQUE` column or index.
    -   `nullable: boolean` → adds or omits `NOT NULL`.
    -   `foreignKey: { table: string; column?: string }` → generates `REFERENCES {table}({column})` and optional `ON DELETE` / `ON UPDATE`.
    -   `checkConstraint: string` → a SQL `CHECK(...)` expression, auto‐rewriting field paths into column names.

By moving all constraint definitions into `constrainedFields`, the code becomes simpler and more robust. The SQL generator can then treat each constrained field uniformly, create native columns for them, and avoid parsing legacy `SchemaConstraints` except for indexes (until v2.0.0).

---

## 5. Summary and Best Practices

1. **Avoid using any deprecated APIs** from `schema-constraints.ts`. Instead, configure `constrainedFields` directly in your collection definition. For example:

    ```ts
    db.collection('posts', postSchema, {
        constrainedFields: {
            authorId: {
                type: 'TEXT',
                foreignKey: 'users._id',
                onDelete: 'CASCADE',
            },
            slug: { type: 'TEXT', unique: true, nullable: false },
            status: {
                type: 'TEXT',
                checkConstraint: "status IN ('draft','published')",
            },
        },
    });
    ```

2. **Understand how `SchemaSQLGenerator` works**:

    - It builds the main `CREATE TABLE` statement, including a `_id` PK, a `doc` JSON column, and any columns from `constrainedFields`.
    - It runs `validateConstrainedFields(...)` at runtime to ensure your schema matches your Zod definition. If a `fieldPath` is invalid, table creation fails early.
    - It infers SQLite column types (e.g. `TEXT`, `INTEGER`) from your Zod schema or explicit hints in `ConstrainedFieldDefinition`.
    - It assembles per-field SQL fragments: `NOT NULL`, `UNIQUE`, `REFERENCES ...`, `CHECK(...)`, and appends them to the base table.
    - It uses `buildIndexSQL` to create any leftover indexes from the legacy `constraints.indexes` map, using JSON extraction on the `doc` column.

3. **When you update your collection’s schema** (add new constrained fields), you must manually run schema migrations (e.g., `ALTER TABLE ADD COLUMN ...`) because `SchemaSQLGenerator`’s `CREATE TABLE IF NOT EXISTS` will not alter an existing table. You may need to write an explicit `ALTER TABLE` or drop & recreate the table in dev environments.

4. **Plan for v2.0.0**:

    - By v2.0.0, `schema-constraints.ts` will be removed, so migrate all unique/foreign key/check definitions into `constrainedFields`. The old helper functions (`unique()`, `foreignKey()`, etc.) will disappear.

---

_End of schema.md document._
