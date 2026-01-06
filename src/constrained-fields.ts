import { z } from 'zod';
import type { ConstrainedFieldDefinition } from './types';

/**
 * Extract values from a document for constrained fields
 */
export function extractConstrainedValues(
    doc: any,
    constrainedFields: { [fieldPath: string]: ConstrainedFieldDefinition }
): { [fieldPath: string]: any } {
    const values: { [fieldPath: string]: any } = {};
    
    for (const fieldPath of Object.keys(constrainedFields)) {
        values[fieldPath] = getNestedValue(doc, fieldPath);
    }
    
    return values;
}

/**
 * Get nested value from object using dot notation
 */
export function getNestedValue(obj: any, path: string): any {
    if (!path || !obj) return undefined;
    
    const keys = path.split('.');
    let current = obj;
    
    for (const key of keys) {
        if (current === null || current === undefined) return undefined;
        current = current[key];
    }
    
    return current;
}

/**
 * Set nested value in object using dot notation
 */
export function setNestedValue(obj: any, path: string, value: any): void {
    if (!path || !obj) return;
    
    const keys = path.split('.');
    let current = obj;
    
    for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        if (!(key in current) || current[key] === null || typeof current[key] !== 'object') {
            current[key] = {};
        }
        current = current[key];
    }
    
    current[keys[keys.length - 1]] = value;
}

/**
 * Infer SQLite column type from Zod type
 */
export function inferSQLiteType(zodType: z.ZodType, fieldDef?: ConstrainedFieldDefinition): string {
    // If type is explicitly specified, use it
    if (fieldDef?.type) {
        return fieldDef.type;
    }
    
    // Try to infer from Zod type
    const zodTypeName = (zodType._def as any).typeName;
    
    switch (zodTypeName) {
        case 'ZodString':
            return 'TEXT';
        case 'ZodNumber':
            return 'REAL';
        case 'ZodBigInt':
            return 'INTEGER';
        case 'ZodBoolean':
            return 'INTEGER'; // SQLite uses 0/1 for booleans
        case 'ZodDate':
            return 'TEXT'; // Store as ISO string
        case 'ZodArray':
            // Check if this is a vector array (number array)
            const itemType = (zodType as any)._def.type;
            if (itemType && (itemType._def as any).typeName === 'ZodNumber') {
                return 'VECTOR';
            }
            return 'TEXT'; // Regular arrays serialize as JSON
        case 'ZodObject':
            return 'TEXT'; // Serialize as JSON
        case 'ZodOptional':
        case 'ZodNullable':
            // Recursively check the inner type
            return inferSQLiteType((zodType as any)._def.innerType, fieldDef);
        default:
            return 'TEXT'; // Default fallback
    }
}

/**
 * Get Zod type for a nested field path
 */
export function getZodTypeForPath(schema: z.ZodSchema, path: string): z.ZodType | null {
    const keys = path.split('.');
    let current: any = schema;
    
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (!current) return null;
        
        // Unwrap optional/nullable types first
        while (current._def?.typeName === 'ZodOptional' || current._def?.typeName === 'ZodNullable') {
            current = current._def.innerType;
        }
        
        // Handle ZodObject
        if (current._def?.typeName === 'ZodObject') {
            let shape = current._def.shape;
            
            // Handle case where shape is a function
            if (typeof shape === 'function') {
                shape = shape();
            }
            
            if (shape && typeof shape === 'object') {
                current = shape[key];
            } else {
                return null;
            }
        } else {
            return null;
        }
    }
    
    return current || null;
}

/**
 * Validate that constrained field paths exist in the schema
 */
export function validateConstrainedFields(
    schema: z.ZodSchema,
    constrainedFields: { [fieldPath: string]: ConstrainedFieldDefinition }
): string[] {
    const errors: string[] = [];
    
    for (const fieldPath of Object.keys(constrainedFields)) {
        const zodType = getZodTypeForPath(schema, fieldPath);
        if (!zodType) {
            errors.push(`Constrained field '${fieldPath}' does not exist in schema`);
        }
    }
    
    return errors;
}

/**
 * Parse foreign key reference string 'table.column' 
 */
export function parseForeignKeyReference(reference: string): { table: string; column: string } | null {
    const parts = reference.split('.');
    if (parts.length !== 2) {
        return null;
    }
    return { table: parts[0], column: parts[1] };
}

/**
 * Generate column name from field path (replace dots with underscores)
 */
export function fieldPathToColumnName(fieldPath: string): string {
    return fieldPath.replace(/\./g, '_');
}

/**
 * Convert value for SQLite storage based on inferred type
 */
export function convertValueForStorage(value: any, sqliteType: string): any {
    if (value === null || value === undefined) {
        return null;
    }
    
    switch (sqliteType) {
        case 'INTEGER':
            if (typeof value === 'boolean') return value ? 1 : 0;
            return Number(value);
        case 'REAL':
            return Number(value);
        case 'TEXT':
            if (typeof value === 'object') return JSON.stringify(value);
            if (value instanceof Date) return value.toISOString();
            return String(value);
        case 'BLOB':
            return value; // Let SQLite handle blob conversion
        case 'VECTOR':
            // MEDIUM-4: VECTOR fields are stored in two places:
            // 1. In the document JSON (doc column) as JSON array - for document completeness
            // 2. In vec0 virtual tables as BLOB (Float32Array buffer) - for efficient similarity search
            // This dual storage is intentional: JSON for retrieval, BLOB for search performance
            // Convert array to JSON string for doc column storage
            if (Array.isArray(value)) {
                return JSON.stringify(value);
            }
            return JSON.stringify([value]); // Single number becomes array
        default:
            return value;
    }
}

/**
 * Convert value from SQLite storage back to JavaScript
 */
export function convertValueFromStorage(value: any, sqliteType: string): any {
    if (value === null || value === undefined) {
        return null;
    }
    
    switch (sqliteType) {
        case 'INTEGER':
            return Number(value);
        case 'REAL':
            return Number(value);
        case 'TEXT':
            // Try to parse as JSON first, fallback to string
            if (typeof value === 'string') {
                try {
                    return JSON.parse(value);
                } catch {
                    return value;
                }
            }
            return String(value);
        case 'BLOB':
            return value;
        case 'VECTOR':
            // MEDIUM-4: Parse vector from document JSON storage
            // Note: vec0 virtual tables use BLOB storage (handled separately in sql-translator.ts)
            // This handles reading from the doc column representation
            if (typeof value === 'string') {
                try {
                    return JSON.parse(value);
                } catch {
                    return [];
                }
            }
            return Array.isArray(value) ? value : [];
        default:
            return value;
    }
}