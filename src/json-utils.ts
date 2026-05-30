import {
    fieldPathToColumnName,
    getZodTypeForPath,
    isZodBoolean,
} from './constrained-fields';

class DocumentCache {
    private cache = new Map<string, any>();
    private readonly maxSize = 1000;

    /**
     * ISSUE #5 FIX: Deep clone objects to prevent mutation leaks.
     * Uses structuredClone for reliable deep cloning.
     * Falls back to JSON parse/stringify for environments without structuredClone.
     */
    private deepClone(value: any): any {
        if (value === null || typeof value !== 'object') {
            return value;
        }
        // structuredClone is available in Node 17+, Bun, and modern browsers
        if (typeof structuredClone === 'function') {
            try {
                return structuredClone(value);
            } catch {
                // Fall back for objects with non-cloneable properties (functions, etc.)
            }
        }
        // Fallback: JSON round-trip
        // Note: This loses Date objects (converted to strings), Map/Set (empty objects),
        // and other non-JSON types. For most skibbaDB use cases, this is acceptable
        // since documents are typically JSON-serializable.
        return JSON.parse(JSON.stringify(value));
    }

    get(json: string): any | undefined {
        const cached = this.cache.get(json);
        if (cached !== undefined) {
            this.cache.delete(json);
            this.cache.set(json, cached);
            return this.deepClone(cached);
        }
        return undefined;
    }

    set(json: string, value: any): void {
        if (this.cache.has(json)) {
            this.cache.delete(json);
        } else if (this.cache.size >= this.maxSize) {
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined) {
                this.cache.delete(oldest);
            }
        }
        this.cache.set(json, value);
    }

    clear(): void {
        this.cache.clear();
    }
}

const docCache = new DocumentCache();

export function stringifyDoc(doc: any): string {
    const seen = new WeakSet<object>();

    const transformDates = (obj: any): any => {
        if (obj instanceof Date) {
            return { __type: 'Date', value: obj.toISOString() };
        }
        if (obj instanceof Map) {
            return {
                __type: 'Map',
                value: Array.from(obj.entries()).map(([key, value]) => [
                    transformDates(key),
                    transformDates(value),
                ]),
            };
        }
        if (obj instanceof Set) {
            return {
                __type: 'Set',
                value: Array.from(obj.values()).map(transformDates),
            };
        }
        if (obj === undefined) {
            return { __type: 'Undefined' };
        }
        if (Array.isArray(obj)) {
            return obj.map(transformDates);
        }
        if (obj !== null && typeof obj === 'object') {
            if (seen.has(obj)) {
                throw new TypeError('Cannot stringify document with circular references');
            }
            seen.add(obj);
            const transformed: any = {};
            for (const key in obj) {
                if (obj.hasOwnProperty(key)) {
                    transformed[key] = transformDates(obj[key]);
                }
            }
            seen.delete(obj);
            return transformed;
        }
        return obj;
    };

    return JSON.stringify(transformDates(doc));
}

export function parseDoc(json: string): any {
    // PERF: Check cache first to avoid re-parsing frequently accessed documents
    const cached = docCache.get(json);
    if (cached !== undefined) {
        return cached;
    }

    const parsed = JSON.parse(json, (key, value) => {
        if (value && typeof value === 'object' && value.__type === 'Date') {
            return new Date(value.value);
        }
        if (value && typeof value === 'object' && value.__type === 'Map') {
            return new Map(value.value);
        }
        if (value && typeof value === 'object' && value.__type === 'Set') {
            return new Set(value.value);
        }
        if (value && typeof value === 'object' && value.__type === 'Undefined') {
            return undefined;
        }
        return value;
    });

    // Cache the parsed result
    docCache.set(json, parsed);
    return parsed;
}

/**
 * Merge constrained field values with document JSON, giving priority to constrained field values
 * ISSUE #7 FIX: Added schema parameter for schema-driven type conversion (especially booleans).
 */
export function mergeConstrainedFields(
    row: any,
    constrainedFields?: { [fieldPath: string]: any },
    schema?: any
): any {
    if (!constrainedFields || Object.keys(constrainedFields).length === 0) {
        return parseDoc(row.doc);
    }

    const mergedObject = parseDoc(row.doc);

    // Override with constrained field values, handling nested paths
    for (const fieldPath of Object.keys(constrainedFields)) {
        const columnName = fieldPathToColumnName(fieldPath);
        if (row[columnName] !== undefined) {
            let value = row[columnName];
            
            if (schema && (value === 0 || value === 1)) {
                try {
                    const zodType = getZodTypeForPath(schema, fieldPath);
                    if (isZodBoolean(zodType)) {
                        value = value === 1;
                    }
                } catch {
                    // If import fails, keep value as-is
                }
            }
            
            // Use constrained field value, even if null (for SET NULL cascades)
            mergedObject[fieldPath] = value;
        }
    }

    return mergedObject;
}

/**
 * Reconstruct nested object structure from flat properties with dot notation
 * Example: { "metadata.role": "senior", "metadata.level": 3 }
 * becomes { metadata: { role: "senior", level: 3 } }
 * 
 * ISSUE #7 FIX: Type conversion is NO LONGER heuristic-based.
 * - 0/1 values are kept as numbers unless schema explicitly declares the field as boolean.
 * - The schema-driven conversion happens at the constrained-fields level, not here.
 * - This function only handles JSON parsing for stringified arrays/objects.
 */
export function reconstructNestedObject(flatObj: any): any {
    const result: any = {};

    /**
     * Convert SQLite values to proper JavaScript types
     * ISSUE #7 FIX: Removed heuristic 0/1 -> boolean conversion.
     * Numbers remain numbers; boolean conversion should be schema-driven.
     */
    const convertSQLiteValue = (value: any): any => {
        // Handle null/undefined
        if (value === null) {
            return null;
        }

        // ISSUE #7 FIX: Do NOT convert 0/1 to boolean heuristically
        // Numbers should remain numbers - schema-driven conversion handles booleans
        // at the constrained-fields level where we have access to Zod type info

        // Try to parse JSON arrays/objects that were stringified
        if (typeof value === 'string') {
            // Check if it looks like JSON
            if (
                (value.startsWith('[') && value.endsWith(']')) ||
                (value.startsWith('{') && value.endsWith('}'))
            ) {
                try {
                    return JSON.parse(value);
                } catch {
                    // If parsing fails, return as string
                    return value;
                }
            }
        }

        return value;
    };

    for (const [key, value] of Object.entries(flatObj)) {
        const convertedValue = convertSQLiteValue(value);

        if (typeof key === 'string' && key.includes('.')) {
            // This is a nested field, reconstruct the path
            const parts = key.split('.');
            let current = result;

            // Navigate/create the nested structure
            for (let i = 0; i < parts.length - 1; i++) {
                const part = parts[i];
                if (!(part in current)) {
                    current[part] = {};
                }
                current = current[part];
            }

            // Set the final value
            const finalPart = parts[parts.length - 1];
            current[finalPart] = convertedValue;
        } else {
            // Regular field, copy as-is
            result[key] = convertedValue;
        }
    }

    return result;
}
