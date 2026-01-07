import { fieldPathToColumnName } from './constrained-fields';

/**
 * FNV-1a hash function for string hashing (32-bit)
 * Fast, non-cryptographic hash with good distribution
 */
function hashString(str: string): number {
    let hash = 2166136261; // FNV offset basis
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 16777619); // FNV prime
    }
    return hash >>> 0; // Convert to unsigned 32-bit integer
}

// PERF: LRU cache for parsed documents to avoid re-parsing frequently accessed docs
// Uses hashed keys to reduce memory usage
class DocumentCache {
    private cache = new Map<number, any>();
    private accessOrder: number[] = [];
    private readonly maxSize = 1000;

    get(json: string): any | undefined {
        const key = hashString(json);
        const cached = this.cache.get(key);
        if (cached !== undefined) {
            // Move to end (most recently used)
            const idx = this.accessOrder.indexOf(key);
            if (idx > -1) {
                this.accessOrder.splice(idx, 1);
            }
            this.accessOrder.push(key);
            // Return shallow copy to prevent mutation
            return Array.isArray(cached) ? [...cached] : { ...cached };
        }
        return undefined;
    }

    set(json: string, value: any): void {
        const key = hashString(json);
        // Evict oldest if at capacity
        if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
            const oldest = this.accessOrder.shift();
            if (oldest !== undefined) {
                this.cache.delete(oldest);
            }
        }
        this.cache.set(key, value);
        this.accessOrder.push(key);
    }

    clear(): void {
        this.cache.clear();
        this.accessOrder = [];
    }
}

const docCache = new DocumentCache();

export function stringifyDoc(doc: any): string {
    const transformDates = (obj: any): any => {
        if (obj instanceof Date) {
            return { __type: 'Date', value: obj.toISOString() };
        }
        if (Array.isArray(obj)) {
            return obj.map(transformDates);
        }
        if (obj !== null && typeof obj === 'object') {
            const transformed: any = {};
            for (const key in obj) {
                if (obj.hasOwnProperty(key)) {
                    transformed[key] = transformDates(obj[key]);
                }
            }
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
        return value;
    });

    // Cache the parsed result
    docCache.set(json, parsed);
    return parsed;
}

/**
 * Merge constrained field values with document JSON, giving priority to constrained field values
 */
export function mergeConstrainedFields(
    row: any,
    constrainedFields?: { [fieldPath: string]: any }
): any {
    if (!constrainedFields || Object.keys(constrainedFields).length === 0) {
        return parseDoc(row.doc);
    }

    const mergedObject = parseDoc(row.doc);

    // Override with constrained field values, handling nested paths
    for (const fieldPath of Object.keys(constrainedFields)) {
        const columnName = fieldPathToColumnName(fieldPath);
        if (row[columnName] !== undefined) {
            // Use constrained field value, even if null (for SET NULL cascades)
            mergedObject[fieldPath] = row[columnName];
        }
    }

    return mergedObject;
}

/**
 * Reconstruct nested object structure from flat properties with dot notation
 * Example: { "metadata.role": "senior", "metadata.level": 3 }
 * becomes { metadata: { role: "senior", level: 3 } }
 */
export function reconstructNestedObject(flatObj: any): any {
    const result: any = {};

    /**
     * Convert SQLite values to proper JavaScript types
     */
    const convertSQLiteValue = (value: any): any => {
        // Handle null/undefined
        if (value === null) {
            return undefined; // Convert SQLite NULL to undefined for optional fields
        }

        // Convert SQLite booleans (0/1) to JavaScript booleans
        if (value === 0 || value === 1) {
            // Check if this looks like it should be a boolean
            // This is a heuristic - we convert 0/1 to boolean only for specific patterns
            return value === 1;
        }

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
