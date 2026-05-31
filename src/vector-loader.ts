import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let sqliteVecModule: any = null;
let loadAttempted = false;

/**
 * Lazily load the sqlite-vec module. Returns null if not available.
 * The module is cached after first load attempt.
 */
function getSqliteVec(): any {
    if (loadAttempted) return sqliteVecModule;
    loadAttempted = true;
    try {
        sqliteVecModule = require('sqlite-vec');
    } catch {
        sqliteVecModule = null;
    }
    return sqliteVecModule;
}

/**
 * Try to load the sqlite-vec extension into a better-sqlite3 database.
 * Returns true if successful, false otherwise.
 */
export function tryLoadSqliteVecSync(db: unknown): boolean {
    const sqliteVec = getSqliteVec();
    if (!sqliteVec) return false;
    try {
        sqliteVec.load(db as any);
        return true;
    } catch {
        return false;
    }
}

/**
 * Try to load the sqlite-vec extension into a LibSQL client.
 * Returns true if successful, false otherwise.
 */
export async function tryLoadSqliteVecLibSQL(db: any): Promise<boolean> {
    const sqliteVec = getSqliteVec();
    if (!sqliteVec) return false;
    try {
        const extensionPath = sqliteVec.getLoadablePath();
        await db.execute({ sql: 'SELECT load_extension(?)', args: [extensionPath] });
        return true;
    } catch {
        return false;
    }
}

/**
 * Get the loadable path for sqlite-vec (for LibSQL).
 * Returns null if sqlite-vec is not installed.
 */
export function getSqliteVecLoadablePath(): string | null {
    const sqliteVec = getSqliteVec();
    if (!sqliteVec) return null;
    try {
        return sqliteVec.getLoadablePath();
    } catch {
        return null;
    }
}

/**
 * Check if a collection schema has any vector fields.
 */
export function collectionHasVectorFields(
    constrainedFields?: Record<string, any>
): boolean {
    if (!constrainedFields) return false;
    return Object.values(constrainedFields).some(
        (field: any) => field.type === 'VECTOR'
    );
}

/**
 * Throw a helpful error if sqlite-vec is not installed.
 */
export function throwVectorNotAvailable(): never {
    throw new Error(
        'Vector search requires sqlite-vec. Install it with:\n' +
        '  npm install sqlite-vec\n\n' +
        'Then restart your application.'
    );
}
