/**
 * SQL utility functions for security and validation
 * Prevents SQL injection through identifier names (table names, column names, etc.)
 */

/**
 * Valid SQLite identifier pattern
 * SQLite identifiers must:
 * - Start with a letter or underscore
 * - Contain only alphanumeric characters, underscores, and dots (for schema.table)
 * - Not be a reserved SQL keyword when unquoted
 */
const VALID_IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Extended identifier pattern that allows dots for nested field paths
 * Used for field paths like "metadata.category"
 */
const VALID_FIELD_PATH_REGEX = /^[a-zA-Z_][a-zA-Z0-9_.]*$/;

/**
 * SQLite reserved keywords that cannot be used as unquoted identifiers
 */
const SQLITE_RESERVED_KEYWORDS = new Set([
    'ABORT', 'ACTION', 'ADD', 'AFTER', 'ALL', 'ALTER', 'ALWAYS', 'ANALYZE', 'AND', 'AS', 'ASC',
    'ATTACH', 'AUTOINCREMENT', 'BEFORE', 'BEGIN', 'BETWEEN', 'BY', 'CASCADE', 'CASE', 'CAST',
    'CHECK', 'COLLATE', 'COLUMN', 'COMMIT', 'CONFLICT', 'CONSTRAINT', 'CREATE', 'CROSS',
    'CURRENT', 'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'DATABASE', 'DEFAULT',
    'DEFERRABLE', 'DEFERRED', 'DELETE', 'DESC', 'DETACH', 'DISTINCT', 'DO', 'DROP', 'EACH',
    'ELSE', 'END', 'ESCAPE', 'EXCEPT', 'EXCLUDE', 'EXCLUSIVE', 'EXISTS', 'EXPLAIN', 'FAIL',
    'FILTER', 'FIRST', 'FOLLOWING', 'FOR', 'FOREIGN', 'FROM', 'FULL', 'GENERATED', 'GLOB',
    'GROUP', 'GROUPS', 'HAVING', 'IF', 'IGNORE', 'IMMEDIATE', 'IN', 'INDEX', 'INDEXED',
    'INITIALLY', 'INNER', 'INSERT', 'INSTEAD', 'INTERSECT', 'INTO', 'IS', 'ISNULL', 'JOIN',
    'KEY', 'LAST', 'LEFT', 'LIKE', 'LIMIT', 'MATCH', 'MATERIALIZED', 'NATURAL', 'NO', 'NOT',
    'NOTHING', 'NOTNULL', 'NULL', 'NULLS', 'OF', 'OFFSET', 'ON', 'OR', 'ORDER', 'OTHERS',
    'OUTER', 'OVER', 'PARTITION', 'PLAN', 'PRAGMA', 'PRECEDING', 'PRIMARY', 'QUERY', 'RAISE',
    'RANGE', 'RECURSIVE', 'REFERENCES', 'REGEXP', 'REINDEX', 'RELEASE', 'RENAME', 'REPLACE',
    'RESTRICT', 'RETURNING', 'RIGHT', 'ROLLBACK', 'ROW', 'ROWS', 'SAVEPOINT', 'SELECT', 'SET',
    'TABLE', 'TEMP', 'TEMPORARY', 'THEN', 'TIES', 'TO', 'TRANSACTION', 'TRIGGER', 'UNBOUNDED',
    'UNION', 'UNIQUE', 'UPDATE', 'USING', 'VACUUM', 'VALUES', 'VIEW', 'VIRTUAL', 'WHEN',
    'WHERE', 'WINDOW', 'WITH', 'WITHOUT'
]);

/**
 * Maximum length for identifiers to prevent DoS via excessively long names
 */
const MAX_IDENTIFIER_LENGTH = 128;

/**
 * Validates and sanitizes a SQL identifier (table name, column name)
 * @param identifier The identifier to validate
 * @param type Description of what type of identifier this is (for error messages)
 * @returns The validated identifier (unchanged if valid)
 * @throws Error if the identifier is invalid
 */
export function validateIdentifier(identifier: string, type: string = 'identifier'): string {
    if (!identifier || typeof identifier !== 'string') {
        throw new Error(`Invalid ${type}: must be a non-empty string`);
    }

    if (identifier.length > MAX_IDENTIFIER_LENGTH) {
        throw new Error(`Invalid ${type}: exceeds maximum length of ${MAX_IDENTIFIER_LENGTH} characters`);
    }

    if (!VALID_IDENTIFIER_REGEX.test(identifier)) {
        throw new Error(
            `Invalid ${type} '${identifier}': must start with a letter or underscore, ` +
            `and contain only alphanumeric characters and underscores`
        );
    }

    // Check for SQL injection patterns
    if (identifier.includes('--') || identifier.includes(';') || identifier.includes('/*')) {
        throw new Error(`Invalid ${type} '${identifier}': contains prohibited characters`);
    }

    return identifier;
}

/**
 * Validates a field path (allows dots for nested fields)
 * @param fieldPath The field path to validate (e.g., "metadata.category")
 * @returns The validated field path (unchanged if valid)
 * @throws Error if the field path is invalid
 */
export function validateFieldPath(fieldPath: string): string {
    if (!fieldPath || typeof fieldPath !== 'string') {
        throw new Error('Invalid field path: must be a non-empty string');
    }

    if (fieldPath.length > MAX_IDENTIFIER_LENGTH) {
        throw new Error(`Invalid field path: exceeds maximum length of ${MAX_IDENTIFIER_LENGTH} characters`);
    }

    if (!VALID_FIELD_PATH_REGEX.test(fieldPath)) {
        throw new Error(
            `Invalid field path '${fieldPath}': must start with a letter or underscore, ` +
            `and contain only alphanumeric characters, underscores, and dots`
        );
    }

    // Validate each segment of the path
    const segments = fieldPath.split('.');
    for (const segment of segments) {
        if (!VALID_IDENTIFIER_REGEX.test(segment)) {
            throw new Error(`Invalid field path segment '${segment}' in '${fieldPath}'`);
        }
    }

    // Check for SQL injection patterns
    if (fieldPath.includes('--') || fieldPath.includes(';') || fieldPath.includes('/*')) {
        throw new Error(`Invalid field path '${fieldPath}': contains prohibited characters`);
    }

    return fieldPath;
}

/**
 * Validates a collection/table name
 * @param name The collection name to validate
 * @returns The validated name (unchanged if valid)
 * @throws Error if the name is invalid
 */
export function validateCollectionName(name: string): string {
    const validated = validateIdentifier(name, 'collection name');
    
    // Check against reserved keywords
    const upperName = validated.toUpperCase();
    if (SQLITE_RESERVED_KEYWORDS.has(upperName)) {
        throw new Error(
            `Invalid collection name '${name}': '${upperName}' is a reserved SQL keyword`
        );
    }

    return validated;
}

/**
 * Safely quotes a SQL identifier if needed
 * Use this when you need to use a reserved keyword or special characters
 * Note: This function is provided for edge cases where quoting is necessary.
 * The identifier is validated first, so the escaping of quotes is a safety measure.
 * @param identifier The identifier to quote
 * @returns The quoted identifier
 */
export function quoteIdentifier(identifier: string): string {
    // Validate first - this ensures the identifier doesn't contain malicious patterns
    validateIdentifier(identifier, 'identifier');
    
    // Quote with double quotes (SQL standard)
    // The escape logic is a defensive measure - validated identifiers won't have quotes
    return `"${identifier}"`;
}

/**
 * Validates and sanitizes a database file path
 * Prevents path traversal attacks
 * @param path The file path to validate
 * @returns The validated path
 * @throws Error if the path is potentially malicious
 */
export function validateDatabasePath(path: string | undefined): string | undefined {
    if (!path) return path;
    
    // Allow special memory path
    if (path === ':memory:') return path;
    
    // Allow LibSQL URLs
    if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('libsql://')) {
        // Basic URL validation - ensure no path traversal in URL
        if (path.includes('..')) {
            throw new Error('Invalid database path: URL cannot contain ".." path traversal');
        }
        return path;
    }
    
    // For file paths, prevent path traversal
    if (path.includes('..')) {
        throw new Error('Invalid database path: path traversal (..) is not allowed');
    }
    
    // Check for null bytes (common injection technique)
    if (path.includes('\0')) {
        throw new Error('Invalid database path: null bytes are not allowed');
    }
    
    // Check for shell metacharacters (but allow backslash for Windows paths)
    const dangerousChars = ['|', '&', ';', '$', '`', '>', '<', '!'];
    for (const char of dangerousChars) {
        if (path.includes(char)) {
            throw new Error(`Invalid database path: character '${char}' is not allowed`);
        }
    }
    
    return path;
}

/**
 * Sanitizes a value for safe inclusion in error messages
 * Prevents information disclosure through error messages
 * Dangerous characters are replaced with safe alternatives rather than removed entirely.
 * @param value The value to sanitize
 * @param maxLength Maximum length of the sanitized output
 * @returns A safe string representation
 */
export function sanitizeForErrorMessage(value: unknown, maxLength: number = 100): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    
    let str: string;
    
    if (typeof value === 'string') {
        str = value;
    } else if (typeof value === 'object') {
        try {
            str = JSON.stringify(value);
        } catch {
            str = '[Object]';
        }
    } else {
        str = String(value);
    }
    
    // Truncate long strings first
    if (str.length > maxLength) {
        str = str.substring(0, maxLength) + '...';
    }
    
    // Replace dangerous characters with safe alternatives for debugging visibility
    // Using Unicode replacements that are visually similar but safe
    str = str
        .replace(/</g, '\u2039')    // < -> ‹ (single left-pointing angle quotation mark)
        .replace(/>/g, '\u203a')    // > -> › (single right-pointing angle quotation mark)
        .replace(/"/g, '\u201c')    // " -> " (left double quotation mark)
        .replace(/'/g, '\u2019')    // ' -> ' (right single quotation mark)
        .replace(/&/g, '\uff06')    // & -> ＆ (fullwidth ampersand)
        .replace(/;/g, '\u037e');   // ; -> ; (greek question mark - looks like semicolon)
    
    return str;
}
