import type { DBConfig } from './types';
import { createDB, type Database } from './database';
import { applyDBPreset } from './db-preset';

export { applyDBPreset } from './db-preset';

function pathToConfig(pathOrMemory: string): DBConfig {
    if (pathOrMemory === ':memory:' || pathOrMemory === 'memory') {
        return { memory: true };
    }
    return { path: pathOrMemory };
}

/**
 * Create a skibbaDB database instance.
 *
 * @example
 * skibba()
 * skibba(':memory:')
 * skibba('app.db')
 * skibba({ path: 'app.db', preset: 'local' })
 */
export function skibba(): Database;
export function skibba(path: string): Database;
export function skibba(config: DBConfig): Database;
export function skibba(path: string, config: DBConfig): Database;
export function skibba(
    pathOrConfig?: string | DBConfig,
    maybeConfig?: DBConfig
): Database {
    let config: DBConfig = {};

    if (typeof pathOrConfig === 'string') {
        config = { ...pathToConfig(pathOrConfig), ...(maybeConfig ?? {}) };
    } else if (pathOrConfig && typeof pathOrConfig === 'object') {
        config = pathOrConfig;
    } else if (maybeConfig) {
        config = maybeConfig;
    } else {
        config = { memory: true };
    }

    return createDB(applyDBPreset(config));
}
