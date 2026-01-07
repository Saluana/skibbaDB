import type {
    QueryOptions,
    QueryFilter,
    QueryGroup,
    SubqueryFilter,
    AggregateField,
    JoinClause,
    ConstrainedFieldDefinition,
} from './types';
import { stringifyDoc } from './json-utils';
import {
    extractConstrainedValues,
    fieldPathToColumnName,
    convertValueForStorage,
    inferSQLiteType,
    getZodTypeForPath,
} from './constrained-fields';
import { SchemaSQLGenerator } from './schema-sql-generator';
import { validateIdentifier, validateFieldPath } from './sql-utils';
import { DatabaseError } from './errors';

/**
 * Small helper: cache `"json_extract(doc,'$.field')"` strings so we build
 * each unique path exactly once per process.
 */
const jsonPathCache = new Map<string, string>();
const jsonPath = (field: string) => {
    // Validate field path to prevent SQL injection
    validateFieldPath(field);
    let cached = jsonPathCache.get(field);
    if (!cached) {
        cached = `json_extract(doc, '$.${field}')`;
        jsonPathCache.set(field, cached);
    }
    return cached;
};

/**
 * PERF PHASE 2: Vector buffer pool to reduce allocations in vector operations
 * Pools Float32Arrays by dimension size to avoid creating new buffers for each operation
 */
class VectorBufferPool {
    private pools = new Map<number, Float32Array[]>();
    private readonly maxPoolSize = 10;  // Max buffers per dimension size
    
    acquire(dimensions: number): Float32Array {
        const pool = this.pools.get(dimensions);
        if (pool && pool.length > 0) {
            return pool.pop()!;
        }
        return new Float32Array(dimensions);
    }
    
    release(buffer: Float32Array): void {
        const dimensions = buffer.length;
        let pool = this.pools.get(dimensions);
        if (!pool) {
            pool = [];
            this.pools.set(dimensions, pool);
        }
        if (pool.length < this.maxPoolSize) {
            // Zero out for security/privacy
            buffer.fill(0);
            pool.push(buffer);
        }
    }
}

const vectorBufferPool = new VectorBufferPool();

/**
 * Choose optimal field access method based on whether field is constrained
 */
const getFieldAccess = (
    field: string,
    constrainedFields?: { [fieldPath: string]: ConstrainedFieldDefinition }
): string => {
    if (constrainedFields && constrainedFields[field]) {
        // Use dedicated column for constrained fields
        return fieldPathToColumnName(field);
    }
    // Use JSON extraction for non-constrained fields
    return jsonPath(field);
};

export class SQLTranslator {
    /**
     * Convert JavaScript values to SQLite-compatible values.
     * Booleans are converted to 0/1 for SQLite compatibility.
     */
    private static convertValue(value: any): any {
        if (typeof value === 'boolean') {
            return value ? 1 : 0;
        }
        return value;
    }

    static buildSelectQuery(
        tableName: string,
        options: QueryOptions,
        constrainedFields?: { [fieldPath: string]: ConstrainedFieldDefinition }
    ): { sql: string; params: any[] } {
        // SECURITY: Validate table name to prevent SQL injection
        validateIdentifier(tableName, 'table name');
        
        const params: any[] = [];
        
        // PERF: Use array-based building for single allocation instead of string concatenation
        const sqlParts: string[] = [];
        
        // Build SELECT clause
        sqlParts.push(this.buildSelectClause(tableName, options, constrainedFields));
        
        // Build FROM clause with joins
        sqlParts.push(this.buildFromClause(tableName, options.joins));

        // Build WHERE clause
        if (options.filters.length > 0) {
            const { whereClause, whereParams } = this.buildWhereClause(
                options.filters,
                'AND',
                constrainedFields,
                tableName,
                options.joins
            );
            sqlParts.push('WHERE', whereClause);
            params.push(...whereParams);
        }

        // Build GROUP BY clause
        if (options.groupBy && options.groupBy.length > 0) {
            const groupClauses = options.groupBy.map((field) =>
                this.qualifyFieldAccess(field, tableName, constrainedFields, options.joins)
            );
            sqlParts.push('GROUP BY', groupClauses.join(', '));
        }

        // Build HAVING clause
        if (options.having && options.having.length > 0) {
            const { whereClause: havingClause, whereParams: havingParams } = this.buildHavingClause(
                options.having,
                'AND',
                constrainedFields,
                tableName
            );
            sqlParts.push('HAVING', havingClause);
            params.push(...havingParams);
        }

        // Build ORDER BY clause
        if (options.orderBy && options.orderBy.length > 0) {
            const orderClauses = options.orderBy.map(
                (order) =>
                    `${this.qualifyFieldAccess(
                        order.field,
                        tableName,
                        constrainedFields,
                        options.joins
                    )} ${order.direction.toUpperCase()}`
            );
            sqlParts.push('ORDER BY', orderClauses.join(', '));
        }

        // Build LIMIT and OFFSET clauses
        if (options.limit) {
            sqlParts.push('LIMIT ?');
            params.push(options.limit);

            if (options.offset) {
                sqlParts.push('OFFSET ?');
                params.push(options.offset);
            }
        } else if (options.offset) {
            // SQLite requires LIMIT when using OFFSET, so we use a very large limit
            sqlParts.push('LIMIT ? OFFSET ?');
            params.push(Number.MAX_SAFE_INTEGER, options.offset);
        }

        return { sql: sqlParts.join(' '), params };
    }

    static buildInsertQuery(
        tableName: string,
        doc: any,
        id: string,
        constrainedFields?: { [fieldPath: string]: ConstrainedFieldDefinition },
        schema?: any
    ): { sql: string; params: any[] } {
        // SECURITY: Validate table name to prevent SQL injection
        validateIdentifier(tableName, 'table name');
        
        if (!constrainedFields || Object.keys(constrainedFields).length === 0) {
            // Original behavior for collections without constrained fields
            const sql = `INSERT INTO ${tableName} (_id, doc) VALUES (?, ?)`;
            return { sql, params: [id, stringifyDoc(doc)] };
        }

        // Build insert with constrained field columns
        const columns = ['_id', 'doc'];
        const params: any[] = [id, stringifyDoc(doc)];

        const constrainedValues = extractConstrainedValues(
            doc,
            constrainedFields
        );

        for (const [fieldPath, fieldDef] of Object.entries(constrainedFields)) {
            // SECURITY: Validate field path
            validateFieldPath(fieldPath);
            const columnName = fieldPathToColumnName(fieldPath);
            const value = constrainedValues[fieldPath];

            // Infer SQLite type for proper value conversion
            const zodType = schema
                ? getZodTypeForPath(schema, fieldPath)
                : null;
            const sqliteType = zodType
                ? inferSQLiteType(zodType, fieldDef)
                : 'TEXT';

            columns.push(columnName);
            params.push(convertValueForStorage(value, sqliteType));
        }

        const placeholders = columns.map(() => '?').join(', ');
        const sql = `INSERT INTO ${tableName} (${columns.join(
            ', '
        )}) VALUES (${placeholders})`;

        return { sql, params };
    }

    /**
     * CRITICAL FIX: Build proper upsert query that preserves _version counter
     * Uses INSERT ... ON CONFLICT ... DO UPDATE instead of INSERT OR REPLACE
     */
    static buildUpsertQuery(
        tableName: string,
        doc: any,
        id: string,
        constrainedFields?: { [fieldPath: string]: ConstrainedFieldDefinition },
        schema?: any
    ): { sql: string; params: any[] } {
        // SECURITY: Validate table name to prevent SQL injection
        validateIdentifier(tableName, 'table name');
        
        if (!constrainedFields || Object.keys(constrainedFields).length === 0) {
            // Simple upsert for collections without constrained fields
            const sql = `
                INSERT INTO ${tableName} (_id, doc, _version)
                VALUES (?, ?, 1)
                ON CONFLICT(_id) DO UPDATE SET
                    doc = excluded.doc,
                    _version = _version + 1
            `;
            return { sql, params: [id, stringifyDoc(doc)] };
        }

        // Build upsert with constrained field columns
        const columns = ['_id', 'doc'];
        const params: any[] = [id, stringifyDoc(doc)];
        const updateClauses: string[] = ['doc = excluded.doc', '_version = _version + 1'];

        const constrainedValues = extractConstrainedValues(
            doc,
            constrainedFields
        );

        for (const [fieldPath, fieldDef] of Object.entries(constrainedFields)) {
            // SECURITY: Validate field path
            validateFieldPath(fieldPath);
            const columnName = fieldPathToColumnName(fieldPath);
            const value = constrainedValues[fieldPath];

            // Infer SQLite type for proper value conversion
            const zodType = schema
                ? getZodTypeForPath(schema, fieldPath)
                : null;
            const sqliteType = zodType
                ? inferSQLiteType(zodType, fieldDef)
                : 'TEXT';

            columns.push(columnName);
            params.push(convertValueForStorage(value, sqliteType));
            
            // Add to update clause
            updateClauses.push(`${columnName} = excluded.${columnName}`);
        }

        const placeholders = columns.map(() => '?').join(', ');
        const sql = `
            INSERT INTO ${tableName} (${columns.join(', ')})
            VALUES (${placeholders})
            ON CONFLICT(_id) DO UPDATE SET
                ${updateClauses.join(',\n                ')}
        `;

        return { sql, params };
    }

    /**
     * Build vector insertion queries for vec0 virtual tables
     */
    static buildVectorInsertQueries(
        tableName: string,
        doc: any,
        id: string,
        constrainedFields?: { [fieldPath: string]: ConstrainedFieldDefinition }
    ): { sql: string; params: any[] }[] {
        const queries: { sql: string; params: any[] }[] = [];
        
        if (!constrainedFields) return queries;
        
        const vectorFields = SchemaSQLGenerator.getVectorFields(constrainedFields);
        const constrainedValues = extractConstrainedValues(doc, constrainedFields);
        
        for (const [fieldPath, fieldDef] of Object.entries(vectorFields)) {
            const vectorTableName = SchemaSQLGenerator.getVectorTableName(tableName, fieldPath);
            const columnName = fieldPathToColumnName(fieldPath);
            const vectorValue = constrainedValues[fieldPath];
            
            if (vectorValue && Array.isArray(vectorValue)) {
                const sql = `INSERT INTO ${vectorTableName} (rowid, ${columnName}) VALUES (
                    (SELECT rowid FROM ${tableName} WHERE _id = ?), ?
                )`;
                // PERF PHASE 2: Use buffer pool to reduce Float32Array allocations
                const vectorArray = vectorBufferPool.acquire(vectorValue.length);
                vectorArray.set(vectorValue);
                // CRITICAL FIX: Deep copy buffer to prevent corruption when array is released to pool
                // Create a new Float32Array copy, then convert to Buffer to avoid shared memory
                const vectorCopy = new Float32Array(vectorArray);
                const params = [id, Buffer.from(vectorCopy.buffer, vectorCopy.byteOffset, vectorCopy.byteLength)];
                queries.push({ sql, params });
                // Return to pool for reuse - safe now that buffer has its own copy
                vectorBufferPool.release(vectorArray);
            }
        }
        
        return queries;
    }

    /**
     * Build vector update queries for vec0 virtual tables
     */
    static buildVectorUpdateQueries(
        tableName: string,
        doc: any,
        id: string,
        constrainedFields?: { [fieldPath: string]: ConstrainedFieldDefinition }
    ): { sql: string; params: any[] }[] {
        const queries: { sql: string; params: any[] }[] = [];
        
        if (!constrainedFields) return queries;
        
        const vectorFields = SchemaSQLGenerator.getVectorFields(constrainedFields);
        const constrainedValues = extractConstrainedValues(doc, constrainedFields);
        
        for (const [fieldPath, fieldDef] of Object.entries(vectorFields)) {
            const vectorTableName = SchemaSQLGenerator.getVectorTableName(tableName, fieldPath);
            const columnName = fieldPathToColumnName(fieldPath);
            const vectorValue = constrainedValues[fieldPath];
            
            if (vectorValue && Array.isArray(vectorValue)) {
                // For updates, first delete existing vector, then insert new one
                // Delete existing vector data
                const deleteSql = `DELETE FROM ${vectorTableName} WHERE rowid = (SELECT rowid FROM ${tableName} WHERE _id = ?)`;
                queries.push({ sql: deleteSql, params: [id] });
                
                // Insert new vector data
                const insertSql = `INSERT INTO ${vectorTableName} (rowid, ${columnName}) VALUES (
                    (SELECT rowid FROM ${tableName} WHERE _id = ?), ?
                )`;
                // PERF PHASE 2: Use buffer pool to reduce Float32Array allocations
                const vectorArray = vectorBufferPool.acquire(vectorValue.length);
                vectorArray.set(vectorValue);
                // CRITICAL FIX: Deep copy buffer to prevent corruption when array is released to pool
                // Create a new Float32Array copy, then convert to Buffer to avoid shared memory
                const vectorCopy = new Float32Array(vectorArray);
                const params = [id, Buffer.from(vectorCopy.buffer, vectorCopy.byteOffset, vectorCopy.byteLength)];
                queries.push({ sql: insertSql, params });
                // Return to pool for reuse - safe now that buffer has its own copy
                vectorBufferPool.release(vectorArray);
            }
        }
        
        return queries;
    }

    /**
     * Build vector deletion queries for vec0 virtual tables
     */
    static buildVectorDeleteQueries(
        tableName: string,
        id: string,
        constrainedFields?: { [fieldPath: string]: ConstrainedFieldDefinition }
    ): { sql: string; params: any[] }[] {
        const queries: { sql: string; params: any[] }[] = [];
        
        if (!constrainedFields) return queries;
        
        const vectorFields = SchemaSQLGenerator.getVectorFields(constrainedFields);
        
        for (const [fieldPath] of Object.entries(vectorFields)) {
            const vectorTableName = SchemaSQLGenerator.getVectorTableName(tableName, fieldPath);
            const sql = `DELETE FROM ${vectorTableName} WHERE rowid = (SELECT rowid FROM ${tableName} WHERE _id = ?)`;
            const params = [id];
            queries.push({ sql, params });
        }
        
        return queries;
    }

    static buildUpdateQuery(
        tableName: string,
        doc: any,
        id: string,
        constrainedFields?: { [fieldPath: string]: ConstrainedFieldDefinition },
        schema?: any,
        expectedVersion?: number
    ): { sql: string; params: any[] } {
        // SECURITY: Validate table name to prevent SQL injection
        validateIdentifier(tableName, 'table name');
        
        if (!constrainedFields || Object.keys(constrainedFields).length === 0) {
            // Original behavior for collections without constrained fields
            const whereClause = expectedVersion !== undefined 
                ? 'WHERE _id = ? AND _version = ?' 
                : 'WHERE _id = ?';
            const sql = `UPDATE ${tableName} SET doc = ?, _version = _version + 1 ${whereClause}`;
            const params = expectedVersion !== undefined
                ? [stringifyDoc(doc), id, expectedVersion]
                : [stringifyDoc(doc), id];
            return { sql, params };
        }

        // Build update with constrained field columns
        const setClauses = ['doc = ?'];
        const params: any[] = [stringifyDoc(doc)];

        const constrainedValues = extractConstrainedValues(
            doc,
            constrainedFields
        );

        for (const [fieldPath, fieldDef] of Object.entries(constrainedFields)) {
            // SECURITY: Validate field path
            validateFieldPath(fieldPath);
            const columnName = fieldPathToColumnName(fieldPath);
            const value = constrainedValues[fieldPath];

            // Infer SQLite type for proper value conversion
            const zodType = schema
                ? getZodTypeForPath(schema, fieldPath)
                : null;
            const sqliteType = zodType
                ? inferSQLiteType(zodType, fieldDef)
                : 'TEXT';

            setClauses.push(`${columnName} = ?`);
            params.push(convertValueForStorage(value, sqliteType));
        }

        // Always increment version
        setClauses.push('_version = _version + 1');

        // Add WHERE clause with optional version check
        const whereClause = expectedVersion !== undefined 
            ? 'WHERE _id = ? AND _version = ?' 
            : 'WHERE _id = ?';
        
        params.push(id); // WHERE clause parameter
        if (expectedVersion !== undefined) {
            params.push(expectedVersion);
        }
        
        const sql = `UPDATE ${tableName} SET ${setClauses.join(
            ', '
        )} ${whereClause}`;

        return { sql, params };
    }

    /**
     * Build atomic update query using operators like $inc, $set, $push
     * Returns SQL that performs updates without reading document first
     */
    static buildAtomicUpdateQuery(
        tableName: string,
        id: string,
        operators: import('./types').AtomicUpdateOperators,
        expectedVersion: number | undefined,
        constrainedFields?: { [fieldPath: string]: ConstrainedFieldDefinition },
        schema?: any
    ): { sql: string; params: any[] } {
        // SECURITY: Validate table name to prevent SQL injection
        validateIdentifier(tableName, 'table name');

        const setClauses: string[] = [];
        const params: any[] = [];
        
        // Track which fields need JSON updates
        const jsonUpdates: { field: string; value: any; op: string }[] = [];

        // Process $inc operator - atomic increment
        if (operators.$inc) {
            for (const [field, increment] of Object.entries(operators.$inc)) {
                validateFieldPath(field);
                if (typeof increment !== 'number') {
                    throw new Error(`$inc value for field '${field}' must be a number`);
                }
                
                // Check if field is constrained
                if (constrainedFields && constrainedFields[field]) {
                    const columnName = fieldPathToColumnName(field);
                    setClauses.push(`${columnName} = ${columnName} + ?`);
                    params.push(increment);
                }
                jsonUpdates.push({ field, value: increment, op: 'inc' });
            }
        }

        // Process $set operator - atomic field set
        if (operators.$set) {
            for (const [field, value] of Object.entries(operators.$set)) {
                validateFieldPath(field);
                
                // Check if field is constrained
                if (constrainedFields && constrainedFields[field]) {
                    const columnName = fieldPathToColumnName(field);
                    const zodType = schema ? getZodTypeForPath(schema, field) : null;
                    const sqliteType = zodType ? inferSQLiteType(zodType, constrainedFields[field]) : 'TEXT';
                    setClauses.push(`${columnName} = ?`);
                    params.push(convertValueForStorage(value, sqliteType));
                }
                jsonUpdates.push({ field, value, op: 'set' });
            }
        }

        // Process $push operator - atomic array append
        if (operators.$push) {
            for (const [field, value] of Object.entries(operators.$push)) {
                validateFieldPath(field);
                jsonUpdates.push({ field, value, op: 'push' });
            }
        }

        // Build JSON update using json_set
        // SQLite's json_set can handle nested paths
        if (jsonUpdates.length > 0) {
            let docExpr = 'doc';
            for (const update of jsonUpdates) {
                if (update.op === 'set') {
                    // json_set(doc, '$.field', value)
                    docExpr = `json_set(${docExpr}, '$.${update.field}', json(?))`;
                    params.push(JSON.stringify(update.value));
                } else if (update.op === 'inc') {
                    // json_set(doc, '$.field', json_extract(doc, '$.field') + value)
                    // Use 'doc' directly in json_extract to avoid nested expansion
                    docExpr = `json_set(${docExpr}, '$.${update.field}', CAST(json_extract(doc, '$.${update.field}') AS REAL) + ?)`;
                    params.push(update.value);
                } else if (update.op === 'push') {
                    // Append to array using json_insert with '$[#]' to append at end
                    // Use 'doc' directly in json_extract to avoid nested expansion
                    docExpr = `json_set(${docExpr}, '$.${update.field}', json_insert(COALESCE(json_extract(doc, '$.${update.field}'), json_array()), '$[#]', json(?)))`;
                    params.push(JSON.stringify(update.value));
                }
            }
            setClauses.unshift(`doc = ${docExpr}`);
        }

        // Always increment version
        setClauses.push('_version = _version + 1');

        // Build WHERE clause with optional version check
        let whereClause = '_id = ?';
        params.push(id);
        
        if (expectedVersion !== undefined) {
            whereClause += ' AND _version = ?';
            params.push(expectedVersion);
        }

        const sql = `UPDATE ${tableName} SET ${setClauses.join(', ')} WHERE ${whereClause}`;
        return { sql, params };
    }

    static buildDeleteQuery(
        tableName: string,
        id: string
    ): { sql: string; params: any[] } {
        // SECURITY: Validate table name to prevent SQL injection
        validateIdentifier(tableName, 'table name');
        const sql = `DELETE FROM ${tableName} WHERE _id = ?`;
        return { sql, params: [id] };
    }

    static buildCreateTableQuery(tableName: string): string {
        // SECURITY: Validate table name to prevent SQL injection
        validateIdentifier(tableName, 'table name');
        return `CREATE TABLE IF NOT EXISTS ${tableName} (
      _id TEXT PRIMARY KEY,
      doc TEXT NOT NULL
    )`;
    }

    /** ----------  1. **O(n)** WHERE‑clause builder  ---------- */
    /** New helper methods for enhanced queries */
    
    static buildSelectClause(
        tableName: string,
        options: QueryOptions,
        constrainedFields?: { [fieldPath: string]: ConstrainedFieldDefinition }
    ): string {
        let selectClause = 'SELECT';
        
        if (options.distinct) {
            selectClause += ' DISTINCT';
        }

        // Handle aggregates and custom field selection
        if (options.aggregates && options.aggregates.length > 0) {
            const aggregateFields = options.aggregates.map(agg => 
                this.buildAggregateField(agg, tableName, constrainedFields)
            ).join(', ');
            
            if (options.selectFields && options.selectFields.length > 0) {
                const selectedFields = options.selectFields.map(field => {
                    const fieldAccess = this.qualifyFieldAccess(field, tableName, constrainedFields, options.joins);
                    // Add alias for better field names in results
                    if (fieldAccess.includes('json_extract')) {
                        return `${fieldAccess} AS "${field}"`;
                    }
                    return fieldAccess;
                }).join(', ');
                selectClause += ` ${selectedFields}, ${aggregateFields}`;
            } else {
                selectClause += ` ${aggregateFields}`;
            }
        } else if (options.selectFields && options.selectFields.length > 0) {
            const selectedFields = options.selectFields.map(field => {
                const fieldAccess = this.qualifyFieldAccess(field, tableName, constrainedFields, options.joins);
                // Add alias for better field names in results
                if (fieldAccess.includes('json_extract')) {
                    return `${fieldAccess} AS "${field}"`;
                }
                return fieldAccess;
            }).join(', ');
            selectClause += ` ${selectedFields}`;
        } else {
            // Default to selecting documents
            selectClause += ` ${tableName}.doc`;
        }
        
        return selectClause;
    }

    static buildFromClause(tableName: string, joins?: JoinClause[]): string {
        let fromClause = `FROM ${tableName}`;
        
        if (joins && joins.length > 0) {
            for (const join of joins) {
                const joinType = join.type === 'FULL' ? 'FULL OUTER' : join.type;
                
                // For joins, we need to handle field access properly for document-based storage
                const leftFieldAccess = join.condition.left === '_id'
                    ? `${tableName}._id`
                    : `json_extract(${tableName}.doc, '$.${join.condition.left}')`;

                const rightFieldAccess = join.condition.right === '_id'
                    ? `${join.collection}._id`
                    : `json_extract(${join.collection}.doc, '$.${join.condition.right}')`;
                    
                const operator = join.condition.operator || '=';
                
                fromClause += ` ${joinType} JOIN ${join.collection} ON ${leftFieldAccess} ${operator} ${rightFieldAccess}`;
            }
        }
        
        return fromClause;
    }

    static buildAggregateField(
        agg: AggregateField,
        tableName: string,
        constrainedFields?: { [fieldPath: string]: ConstrainedFieldDefinition }
    ): string {
        const fieldAccess = agg.field === '*' ? '*' : this.qualifyFieldAccess(agg.field, tableName, constrainedFields);
        const distinctPrefix = agg.distinct ? 'DISTINCT ' : '';
        const alias = agg.alias ? ` AS ${agg.alias}` : '';
        
        return `${agg.function}(${distinctPrefix}${fieldAccess})${alias}`;
    }

    static qualifyFieldAccess(
        field: string,
        tableName: string,
        constrainedFields?: { [fieldPath: string]: ConstrainedFieldDefinition },
        joins?: JoinClause[]
    ): string {
        // Handle table-prefixed fields like "users.name" or "posts.title"
        if (field.includes('.')) {
            const [tablePrefix, fieldName] = field.split('.', 2);
            
            // Check if this is actually a nested JSON path, not a table prefix
            // If the full field path is a constrained field, it's a nested path
            if (constrainedFields && constrainedFields[field]) {
                return `${tableName}.${fieldPathToColumnName(field)}`;
            }
            
            // Check if this field is a constrained field in any table
            if (constrainedFields && constrainedFields[fieldName]) {
                return `${tablePrefix}.${fieldPathToColumnName(fieldName)}`;
            }
            
            // For id field, use _id column directly
            if (fieldName === '_id') {
                return `${tablePrefix}._id`;
            }
            
            // IMPROVED LOGIC: Check if we're in a JOIN context and if the prefix is a known table
            const knownTables = [tableName];
            if (joins && joins.length > 0) {
                knownTables.push(...joins.map(join => join.collection));
            }
            
            if (knownTables.includes(tablePrefix)) {
                // This is a real table.field reference (either main table or joined table)
                return `json_extract(${tablePrefix}.doc, '$.${fieldName}')`;
            } else {
                // This is a nested JSON path (e.g., meta.bio, user.preferences.theme, anything.nested)
                return `json_extract(${tableName}.doc, '$.${field}')`;
            }
        }
        
        // Handle non-prefixed fields
        if (constrainedFields && constrainedFields[field]) {
            return `${tableName}.${fieldPathToColumnName(field)}`;
        }
        
        // For id field, use _id column directly
        if (field === '_id') {
            return `${tableName}._id`;
        }
        
        // PERF NOTE: COALESCE approach for JOINs may be inefficient for large queries
        // as it attempts json_extract on each joined table even if field is found in first table.
        // Future optimization: implement field existence metadata or more targeted resolution.
        if (joins && joins.length > 0) {
            // Use COALESCE to try joined tables first, then fall back to main table
            // This way if the field exists in any table, it will be found
            const attempts = [
                ...joins.map(join => `json_extract(${join.collection}.doc, '$.${field}')`),
                `json_extract(${tableName}.doc, '$.${field}')`
            ];
            // Use COALESCE to return the first non-null value
            return `COALESCE(${attempts.join(', ')})`;
        }
        
        return `json_extract(${tableName}.doc, '$.${field}')`;
    }


    static getFieldAccess(field: string): string {
        // Simple field access without table qualification for joins
        return field;
    }

    static buildHavingClause(
        filters: (QueryFilter | QueryGroup)[],
        joinOp: 'AND' | 'OR' = 'AND',
        constrainedFields?: { [fieldPath: string]: ConstrainedFieldDefinition },
        tableName?: string
    ): { whereClause: string; whereParams: any[] } {
        const parts: string[] = [];
        const params: any[] = [];

        for (const f of filters) {
            if ('type' in f) {
                /* QueryGroup */
                const grp = f as QueryGroup;
                const { whereClause, whereParams } = this.buildHavingClause(
                    grp.filters as (QueryFilter | QueryGroup)[], // HAVING doesn't support subqueries
                    grp.type.toUpperCase() as 'AND' | 'OR',
                    constrainedFields,
                    tableName
                );
                if (whereClause) {
                    parts.push(`(${whereClause})`);
                    params.push(...whereParams);
                }
            } else {
                /* QueryFilter */
                const { whereClause, whereParams } = this.buildHavingFilterClause(
                    f as QueryFilter,
                    constrainedFields,
                    tableName
                );
                parts.push(whereClause);
                params.push(...whereParams);
            }
        }
        return {
            whereClause: parts.join(` ${joinOp} `),
            whereParams: params,
        };
    }

    // PERF: Flatten single-child filter groups to reduce unnecessary parentheses and recursion
    private static flattenFilters(filters: (QueryFilter | QueryGroup | SubqueryFilter)[]): (QueryFilter | QueryGroup | SubqueryFilter)[] {
        const result: (QueryFilter | QueryGroup | SubqueryFilter)[] = [];
        
        for (const f of filters) {
            if ('type' in f) {
                const grp = f as QueryGroup;
                // If group has only one filter, unwrap it
                if (grp.filters.length === 1) {
                    result.push(...this.flattenFilters(grp.filters));
                } else if (grp.filters.length > 0) {
                    // Recursively flatten nested filters
                    result.push({
                        type: grp.type,
                        filters: this.flattenFilters(grp.filters)
                    } as QueryGroup);
                }
            } else {
                result.push(f);
            }
        }
        
        return result;
    }

    static buildWhereClause(
        filters: (QueryFilter | QueryGroup | SubqueryFilter)[],
        joinOp: 'AND' | 'OR' = 'AND',
        constrainedFields?: { [fieldPath: string]: ConstrainedFieldDefinition },
        tableName?: string,
        joins?: JoinClause[]
    ): { whereClause: string; whereParams: any[] } {
        // PERF: Flatten filters before building to reduce unnecessary nesting
        const flattenedFilters = this.flattenFilters(filters);
        
        const parts: string[] = [];
        const params: any[] = [];

        for (const f of flattenedFilters) {
            if ('type' in f) {
                /* QueryGroup */
                const grp = f as QueryGroup;
                const { whereClause, whereParams } = this.buildWhereClause(
                    grp.filters,
                    grp.type.toUpperCase() as 'AND' | 'OR',
                    constrainedFields,
                    tableName,
                    joins
                );
                if (whereClause) {
                    parts.push(`(${whereClause})`);
                    params.push(...whereParams);
                }
            } else if ('subquery' in f) {
                /* SubqueryFilter */
                const { whereClause, whereParams } = this.buildSubqueryClause(
                    f as SubqueryFilter,
                    constrainedFields,
                    tableName
                );
                parts.push(whereClause);
                params.push(...whereParams);
            } else {
                /* QueryFilter */
                const { whereClause, whereParams } = this.buildFilterClause(
                    f as QueryFilter,
                    constrainedFields,
                    tableName,
                    joins
                );
                parts.push(whereClause);
                params.push(...whereParams);
            }
        }
        return {
            whereClause: parts.join(` ${joinOp} `),
            whereParams: params,
        };
    }

    /** ----------  2. Subquery clause builder ---------- */
    /**
     * Builds a subquery clause for EXISTS, NOT EXISTS, IN, or NOT IN operations.
     * 
     * For EXISTS/NOT EXISTS: The subquery is used as-is. If you need correlated subqueries,
     * ensure your subquery includes appropriate WHERE conditions that reference the outer table.
     * 
     * Example usage for correlated EXISTS:
     * ```
     * // Find users who have orders
     * const orderSubquery = new QueryBuilder()
     *   .where('status').eq('completed');
     * 
     * users.where('_id').existsSubquery(orderSubquery, 'orders');
     * // Note: The subquery should include a filter like: .where('userId').eq(???) 
     * // but true correlation requires runtime binding which is not yet fully supported.
     * ```
     * 
     * For IN/NOT IN: The subquery should select the values to match against.
     */
    private static buildSubqueryClause(
        filter: SubqueryFilter,
        constrainedFields?: { [fieldPath: string]: ConstrainedFieldDefinition },
        tableName?: string
    ): {
        whereClause: string;
        whereParams: any[];
    } {
        const fieldAccess = tableName 
            ? this.qualifyFieldAccess(filter.field, tableName, constrainedFields)
            : getFieldAccess(filter.field, constrainedFields);
        
        // For EXISTS/NOT EXISTS, we need to add correlation
        // The pattern: users.where('_id').existsSubquery(ordersQuery, 'orders')
        // Should correlate: orders.userId = users._id
        const needsCorrelation = (filter.operator === 'exists' || filter.operator === 'not_exists') && tableName;
        
        let subquerySql: string;
        let subqueryParams: any[];
        
        if (needsCorrelation) {
            // Build the base subquery
            const originalBuild = this.buildSelectQuery(
                filter.subqueryCollection,
                filter.subquery,
                constrainedFields
            );
            
            // Inject correlation clause into WHERE
            // Foreign key naming heuristic: {tableName}Id (e.g., users -> userId)
            // NOTE: This heuristic fails for irregular plurals (e.g., 'children' -> 'childrenId' instead of 'childId')
            // For production use, consider a configuration-based approach for irregular plurals
            const foreignKeyField = tableName!.endsWith('s') 
                ? tableName!.slice(0, -1) + 'Id'  // users -> userId
                : tableName! + 'Id';
            
            const correlationCondition = `json_extract(${filter.subqueryCollection}.doc, '$.${foreignKeyField}') = ${fieldAccess}`;
            
            if (originalBuild.sql.includes('WHERE')) {
                subquerySql = originalBuild.sql.replace(
                    /WHERE (.+?)( GROUP BY| HAVING| ORDER BY| LIMIT|$)/,
                    `WHERE $1 AND ${correlationCondition}$2`
                );
            } else {
                // Insert WHERE clause before GROUP BY, ORDER BY, or LIMIT
                subquerySql = originalBuild.sql.replace(
                    /( GROUP BY| HAVING| ORDER BY| LIMIT|$)/,
                    ` WHERE ${correlationCondition}$1`
                );
            }
            subqueryParams = originalBuild.params;
        } else {
            const built = this.buildSelectQuery(
                filter.subqueryCollection,
                filter.subquery,
                constrainedFields
            );
            subquerySql = built.sql;
            subqueryParams = built.params;
        }
        
        let whereClause = '';
        
        switch (filter.operator) {
            case 'exists':
                // EXISTS with correlation checks if any correlated rows exist
                whereClause = `EXISTS (${subquerySql})`;
                break;
            case 'not_exists':
                // NOT EXISTS checks if no correlated rows exist
                whereClause = `NOT EXISTS (${subquerySql})`;
                break;
            case 'in':
                // IN checks if the field value is in the subquery result set
                whereClause = `${fieldAccess} IN (${subquerySql})`;
                break;
            case 'not_in':
                // NOT IN checks if the field value is not in the subquery result set
                whereClause = `${fieldAccess} NOT IN (${subquerySql})`;
                break;
        }
        
        return { whereClause, whereParams: subqueryParams };
    }

    /** ----------  3. HAVING clause filter builder ---------- */
    private static buildHavingFilterClause(
        filter: QueryFilter,
        constrainedFields?: { [fieldPath: string]: ConstrainedFieldDefinition },
        tableName?: string
    ): {
        whereClause: string;
        whereParams: any[];
    } {
        const col = filter.field;
        const p: any[] = [];
        let c = '';

        switch (filter.operator) {
            case 'eq':
                c = `${col} = ?`;
                p.push(SQLTranslator.convertValue(filter.value));
                break;
            case 'neq':
                c = `${col} != ?`;
                p.push(SQLTranslator.convertValue(filter.value));
                break;
            case 'gt':
                c = `${col} > ?`;
                p.push(SQLTranslator.convertValue(filter.value));
                break;
            case 'gte':
                c = `${col} >= ?`;
                p.push(SQLTranslator.convertValue(filter.value));
                break;
            case 'lt':
                c = `${col} < ?`;
                p.push(SQLTranslator.convertValue(filter.value));
                break;
            case 'lte':
                c = `${col} <= ?`;
                p.push(SQLTranslator.convertValue(filter.value));
                break;
            case 'between':
                c = `${col} BETWEEN ? AND ?`;
                p.push(SQLTranslator.convertValue(filter.value), SQLTranslator.convertValue(filter.value2));
                break;
            case 'in':
            case 'nin': {
                const placeholders = filter.value.map(() => '?').join(', ');
                c = `${col}${filter.operator === 'nin' ? ' NOT' : ''} IN (${placeholders})`;
                p.push(...filter.value.map((v: any) => SQLTranslator.convertValue(v)));
                break;
            }
        }
        return { whereClause: c, whereParams: p };
    }

    /** ----------  4. Cheap single‑pass filter builder ---------- */
    private static buildFilterClause(
        filter: QueryFilter,
        constrainedFields?: { [fieldPath: string]: ConstrainedFieldDefinition },
        tableName?: string,
        joins?: JoinClause[]
    ): {
        whereClause: string;
        whereParams: any[];
    } {
        let col: string;
        
        // If we have joins, we need to determine which table the field belongs to
        // Check if the field is already a SQL function (like json_array_length)
        if (filter.field.includes('(') && filter.field.includes(')')) {
            // This is already a SQL function, use it as-is but need to extract the actual field for JSON access
            const fieldMatch = filter.field.match(/\(([^)]+)\)/);
            if (fieldMatch) {
                const actualField = fieldMatch[1];
                const fieldAccess = tableName 
                    ? this.qualifyFieldAccess(actualField, tableName, constrainedFields, joins)
                    : getFieldAccess(actualField, constrainedFields);
                col = filter.field.replace(actualField, fieldAccess);
            } else {
                col = filter.field; // fallback
            }
        } else if (joins && joins.length > 0) {
            // MEDIUM-3 FIX: Require explicit table prefixes for joins
            // Handle table-prefixed field names like "posts.published"
            if (filter.field.includes('.')) {
                const [tablePrefix, fieldName] = filter.field.split('.', 2);
                
                // Validate table and field identifiers
                validateIdentifier(tablePrefix, 'table name');
                validateFieldPath(fieldName);
                
                // Use the specified table prefix
                if (constrainedFields && constrainedFields[fieldName]) {
                    col = `${tablePrefix}.${fieldPathToColumnName(fieldName)}`;
                } else if (fieldName === '_id') {
                    col = `${tablePrefix}._id`;
                } else {
                    col = `json_extract(${tablePrefix}.doc, '$.${fieldName}')`;
                }
            } else {
                // MEDIUM-3 FIX: Allow fields from base table if tableName provided, else require prefix
                // If we have a tableName (base table), allow unprefixed fields to refer to it
                if (tableName) {
                    col = this.qualifyFieldAccess(filter.field, tableName, constrainedFields, joins);
                } else {
                    // No base table context - require explicit prefix
                    throw new DatabaseError(
                        `Field '${filter.field}' in JOIN query must include explicit table prefix (e.g., 'tableName.${filter.field}'). ` +
                        `This prevents ambiguity and incorrect data access.`,
                        'FIELD_REQUIRES_TABLE_PREFIX'
                    );
                }
            }
        } else {
            col = tableName 
                ? this.qualifyFieldAccess(filter.field, tableName, constrainedFields, joins)
                : getFieldAccess(filter.field, constrainedFields);
        }
        const p: any[] = [];
        let c = '';

        switch (filter.operator) {
            case 'eq':
                c = `${col} = ?`;
                p.push(SQLTranslator.convertValue(filter.value));
                break;
            case 'neq':
                c = `${col} != ?`;
                p.push(SQLTranslator.convertValue(filter.value));
                break;
            case 'gt':
                c = `${col} > ?`;
                p.push(SQLTranslator.convertValue(filter.value));
                break;
            case 'gte':
                c = `${col} >= ?`;
                p.push(SQLTranslator.convertValue(filter.value));
                break;
            case 'lt':
                c = `${col} < ?`;
                p.push(SQLTranslator.convertValue(filter.value));
                break;
            case 'lte':
                c = `${col} <= ?`;
                p.push(SQLTranslator.convertValue(filter.value));
                break;
            case 'between':
                c = `${col} BETWEEN ? AND ?`;
                p.push(SQLTranslator.convertValue(filter.value), SQLTranslator.convertValue(filter.value2));
                break;
            case 'in':
            case 'nin': {
                const placeholders = filter.value.map(() => '?').join(', ');
                c = `${col}${filter.operator === 'nin' ? ' NOT' : ''} IN (${placeholders})`;
                p.push(...filter.value.map((v: any) => SQLTranslator.convertValue(v)));
                break;
            }
            case 'like':
                c = `${col} LIKE ?`;
                p.push(SQLTranslator.convertValue(filter.value));
                break;
            case 'ilike':
                c = `UPPER(${col}) LIKE UPPER(?)`;
                p.push(SQLTranslator.convertValue(filter.value));
                break;
            case 'startswith':
                c = `${col} LIKE ?`;
                p.push(`${SQLTranslator.convertValue(filter.value)}%`);
                break;
            case 'endswith':
                c = `${col} LIKE ?`;
                p.push(`%${SQLTranslator.convertValue(filter.value)}`);
                break;
            case 'contains':
                c = `${col} LIKE ?`;
                p.push(`%${SQLTranslator.convertValue(filter.value)}%`);
                break;
            case 'exists':
                c = filter.value ? `${col} IS NOT NULL` : `${col} IS NULL`;
                break;
            case 'json_array_contains':
                c = `EXISTS (SELECT 1 FROM json_each(${col}) WHERE value = ?)`;
                p.push(SQLTranslator.convertValue(filter.value));
                break;
            case 'json_array_not_contains':
                c = `NOT EXISTS (SELECT 1 FROM json_each(${col}) WHERE value = ?)`;
                p.push(SQLTranslator.convertValue(filter.value));
                break;
        }
        return { whereClause: c, whereParams: p };
    }
}
