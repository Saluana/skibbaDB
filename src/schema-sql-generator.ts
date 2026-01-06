import type {
    IndexDefinition,
    SchemaConstraints,
} from './schema-constraints';
import type { ConstrainedFieldDefinition } from './types';
import { 
    fieldPathToColumnName,
    inferSQLiteType,
    getZodTypeForPath,
    parseForeignKeyReference,
    validateConstrainedFields
} from './constrained-fields';
import { validateIdentifier, validateFieldPath } from './sql-utils';

export class SchemaSQLGenerator {
    /**
     * Generate CREATE TABLE SQL with constraints
     */
    static buildCreateTableWithConstraints(
        tableName: string,
        constraints?: SchemaConstraints,
        constrainedFields?: { [fieldPath: string]: ConstrainedFieldDefinition },
        schema?: any
    ): { sql: string; additionalSQL: string[] } {
        // SECURITY: Validate table name to prevent SQL injection
        validateIdentifier(tableName, 'table name');
        
        let sql = `CREATE TABLE IF NOT EXISTS ${tableName} (\n`;
        sql += `  _id TEXT PRIMARY KEY,\n`;
        sql += `  doc TEXT NOT NULL,\n`;
        sql += `  _version INTEGER NOT NULL DEFAULT 1`;

        const additionalSQL: string[] = [];
        const vectorFields: { [fieldPath: string]: ConstrainedFieldDefinition } = {};
        const docSyncFields: Array<{
            fieldPath: string;
            columnName: string;
            sqliteType: string;
            fieldDef: ConstrainedFieldDefinition;
        }> = [];
        
        // Add constrained field columns
        if (constrainedFields && schema) {
            // Validate constrained fields exist in schema
            const validationErrors = validateConstrainedFields(schema, constrainedFields);
            if (validationErrors.length > 0) {
                throw new Error(`Invalid constrained fields: ${validationErrors.join(', ')}`);
            }
            
            for (const [fieldPath, fieldDef] of Object.entries(constrainedFields)) {
                const columnName = fieldPathToColumnName(fieldPath);
                const zodType = getZodTypeForPath(schema, fieldPath);
                let sqliteType = zodType ? inferSQLiteType(zodType, fieldDef) : 'TEXT';
                
                // Handle vector fields - they need both regular column and vec0 virtual tables
                if (sqliteType === 'VECTOR' || fieldDef.type === 'VECTOR') {
                    vectorFields[fieldPath] = fieldDef;
                    
                    // Validate vector dimensions are specified
                    if (!fieldDef.vectorDimensions) {
                        throw new Error(`Vector field '${fieldPath}' must specify vectorDimensions`);
                    }
                    
                    // Create vec0 virtual table for this vector field
                    const vectorType = fieldDef.vectorType || 'float';
                    const vectorTableName = `${tableName}_${columnName}_vec`;
                    
                    additionalSQL.push(
                        `CREATE VIRTUAL TABLE IF NOT EXISTS ${vectorTableName} USING vec0(${columnName} ${vectorType}[${fieldDef.vectorDimensions}])`
                    );
                    
                    // Continue to create regular column for JSON storage - don't skip
                    // Set sqliteType to TEXT for the regular column
                    sqliteType = 'TEXT';
                }
                
                // Build column definition for non-vector fields
                let columnDef = `${columnName} ${sqliteType}`;
                
                // Add NOT NULL if not nullable (default is nullable for constrained fields)
                if (fieldDef.nullable === false) {
                    columnDef += ' NOT NULL';
                }
                
                // Add UNIQUE constraint
                if (fieldDef.unique) {
                    columnDef += ' UNIQUE';
                }
                
                // Add foreign key constraint
                if (fieldDef.foreignKey) {
                    const fkRef = parseForeignKeyReference(fieldDef.foreignKey);
                    if (fkRef) {
                        // Expect foreign keys to reference the '_id' primary key column
                        const actualColumn = fkRef.column === 'id' ? '_id' : fkRef.column;
                        columnDef += ` REFERENCES ${fkRef.table}(${actualColumn})`;
                        
                        if (fieldDef.onDelete) {
                            columnDef += ` ON DELETE ${fieldDef.onDelete}`;
                        }
                        
                        if (fieldDef.onUpdate) {
                            columnDef += ` ON UPDATE ${fieldDef.onUpdate}`;
                        }
                    }
                }
                
                // Add check constraint
                if (fieldDef.checkConstraint) {
                    columnDef += ` CHECK (${fieldDef.checkConstraint.replace(new RegExp(`\\b${fieldPath}\\b`, 'g'), columnName)})`;
                }
                
                sql += `,\n  ${columnDef}`;

                docSyncFields.push({
                    fieldPath,
                    columnName,
                    sqliteType,
                    fieldDef,
                });
            }
        }

        if (constraints) {
            // Add indexes only (constraints now handled via constrainedFields)
            // Note: SchemaConstraints is deprecated - only indexes are processed
            if (constraints.indexes) {
                for (const [indexName, indexDef] of Object.entries(
                    constraints.indexes
                )) {
                    additionalSQL.push(
                        this.buildIndexSQL(indexName, indexDef, tableName)
                    );
                }
            }
        }

        sql += `\n)`;

        if (docSyncFields.length > 0) {
            const insertTriggerName = `${tableName}_doc_sync_insert`;
            const updateTriggerName = `${tableName}_doc_sync_update`;

            validateIdentifier(insertTriggerName, 'trigger name');
            validateIdentifier(updateTriggerName, 'trigger name');

            const docSyncExpression = docSyncFields.reduce((expr, field) => {
                const jsonPath = `$.${field.fieldPath}`;
                let valueExpr = `NEW.${field.columnName}`;

                if (field.fieldDef.type === 'VECTOR') {
                    valueExpr = `CASE WHEN json_valid(NEW.${field.columnName}) THEN json(NEW.${field.columnName}) ELSE json_quote(NEW.${field.columnName}) END`;
                } else if (field.sqliteType === 'INTEGER' || field.sqliteType === 'REAL') {
                    valueExpr = `NEW.${field.columnName}`;
                } else if (field.sqliteType === 'BLOB') {
                    valueExpr = `json_quote(hex(NEW.${field.columnName}))`;
                } else {
                    valueExpr = `CASE WHEN json_valid(NEW.${field.columnName}) THEN json(NEW.${field.columnName}) ELSE json_quote(NEW.${field.columnName}) END`;
                }

                return `json_set(${expr}, '${jsonPath}', ${valueExpr})`;
            }, 'COALESCE(NEW.doc, \'{}\')');

            const updateColumns = docSyncFields.map((field) => field.columnName).join(', ');

            // TRIGGER DESIGN NOTE: Using AFTER triggers with UPDATE
            // Risk: Could cause recursive trigger firing if other AFTER UPDATE triggers exist
            // Mitigation: These triggers only fire on constrained field updates (UPDATE OF clause)
            //             and only modify the 'doc' column, which is not in the UPDATE OF list
            // Alternative considered: BEFORE triggers modifying NEW values directly
            //   - Rejected because SQLite doesn't allow modifying NEW in BEFORE triggers for some operations
            // Safety: Triggers are idempotent - running twice produces same result
            
            additionalSQL.push(
                `CREATE TRIGGER IF NOT EXISTS ${insertTriggerName} AFTER INSERT ON ${tableName} BEGIN ` +
                    `UPDATE ${tableName} SET doc = ${docSyncExpression} WHERE rowid = NEW.rowid; ` +
                    `END`
            );

            additionalSQL.push(
                `CREATE TRIGGER IF NOT EXISTS ${updateTriggerName} AFTER UPDATE OF ${updateColumns} ON ${tableName} BEGIN ` +
                    `UPDATE ${tableName} SET doc = ${docSyncExpression} WHERE rowid = NEW.rowid; ` +
                    `END`
            );
        }

        return { sql, additionalSQL };
    }


    /**
     * Build index SQL
     */
    private static buildIndexSQL(
        indexName: string,
        indexDef: IndexDefinition,
        tableName: string
    ): string {
        // SECURITY: Validate identifiers to prevent SQL injection
        validateIdentifier(indexName, 'index name');
        validateIdentifier(tableName, 'table name');
        
        const uniqueKeyword = indexDef.unique ? 'UNIQUE ' : '';
        const fields = indexDef.fields
            .map((f) => {
                // SECURITY: Validate field names
                validateFieldPath(f);
                return `json_extract(doc, '$.${f}')`;
            })
            .join(', ');
        
        // SECURITY: Validate partial index WHERE clause doesn't contain dangerous patterns
        let whereClause = '';
        if (indexDef.partial) {
            // Only allow safe WHERE clauses - basic comparison expressions
            // Explicitly exclude quotes and semicolons to prevent SQL injection
            // Allowed: alphanumeric, underscore, dot, space, comparison operators, parentheses
            const safePartialPattern = /^[a-zA-Z0-9_.\s=<>!()]+$/;
            if (!safePartialPattern.test(indexDef.partial)) {
                throw new Error(`Invalid partial index expression: contains prohibited characters. Allowed: alphanumeric, underscore, dot, space, =, <, >, !, (, )`);
            }
            // Additional check: disallow SQL comment patterns
            if (indexDef.partial.includes('--') || indexDef.partial.includes('/*')) {
                throw new Error(`Invalid partial index expression: SQL comments are not allowed`);
            }
            whereClause = ` WHERE ${indexDef.partial}`;
        }

        return `CREATE ${uniqueKeyword}INDEX IF NOT EXISTS ${indexName} ON ${tableName} (${fields})${whereClause}`;
    }

    /**
     * Get vector table name for a field
     */
    static getVectorTableName(tableName: string, fieldPath: string): string {
        // SECURITY: Validate inputs
        validateIdentifier(tableName, 'table name');
        validateFieldPath(fieldPath);
        const columnName = fieldPathToColumnName(fieldPath);
        return `${tableName}_${columnName}_vec`;
    }

    /**
     * Get all vector fields from constrained fields
     */
    static getVectorFields(constrainedFields?: { [fieldPath: string]: ConstrainedFieldDefinition }): { [fieldPath: string]: ConstrainedFieldDefinition } {
        if (!constrainedFields) return {};
        
        const vectorFields: { [fieldPath: string]: ConstrainedFieldDefinition } = {};
        for (const [fieldPath, fieldDef] of Object.entries(constrainedFields)) {
            if (fieldDef.type === 'VECTOR') {
                vectorFields[fieldPath] = fieldDef;
            }
        }
        
        return vectorFields;
    }




}
