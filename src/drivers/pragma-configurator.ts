import * as os from 'os';
import * as fs from 'fs';
import type { DBConfig } from '../types';
import { DatabaseError } from '../errors';

const VALID_JOURNAL_MODES = new Set(['DELETE', 'TRUNCATE', 'PERSIST', 'MEMORY', 'WAL', 'OFF']);
const VALID_SYNCHRONOUS = new Set(['OFF', 'NORMAL', 'FULL', 'EXTRA']);
const VALID_TEMP_STORE = new Set(['DEFAULT', 'FILE', 'MEMORY']);
const VALID_LOCKING_MODE = new Set(['NORMAL', 'EXCLUSIVE']);
const VALID_AUTO_VACUUM = new Set(['NONE', 'FULL', 'INCREMENTAL']);

function validatePragmaValue(value: any, validSet: Set<string> | null, name: string): string | number {
    if (typeof value === 'number') {
        if (!Number.isInteger(value) || !Number.isFinite(value)) {
            throw new DatabaseError(`Invalid ${name}: must be a finite integer`);
        }
        return value;
    }
    if (validSet !== null) {
        const strValue = String(value).toUpperCase();
        if (!validSet.has(strValue)) {
            throw new DatabaseError(`Invalid ${name}: '${value}' is not allowed. Valid values: ${Array.from(validSet).join(', ')}`);
        }
        return strValue;
    }
    throw new DatabaseError(`Invalid ${name}: unexpected type`);
}

function detectContainerMemoryLimit(): { total: number; available: number } {
    const MB_IN_BYTES = 1024 * 1024;
    let totalMemoryBytes = os.totalmem();
    let availableMemoryBytes = os.freemem();

    try {
        const cgroupV1Path = '/sys/fs/cgroup/memory/memory.limit_in_bytes';
        if (fs.existsSync(cgroupV1Path)) {
            const limitStr = fs.readFileSync(cgroupV1Path, 'utf8').trim();
            const cgroupLimit = parseInt(limitStr, 10);
            if (cgroupLimit > 0 && cgroupLimit < 9223372036854775807 && cgroupLimit < totalMemoryBytes) {
                totalMemoryBytes = cgroupLimit;
                const freeRatio = os.freemem() / os.totalmem();
                availableMemoryBytes = Math.floor(cgroupLimit * freeRatio);
            }
        }
    } catch {
        try {
            const cgroupV2Path = '/sys/fs/cgroup/memory.max';
            if (fs.existsSync(cgroupV2Path)) {
                const limitStr = fs.readFileSync(cgroupV2Path, 'utf8').trim();
                if (limitStr !== 'max') {
                    const cgroupLimit = parseInt(limitStr, 10);
                    if (cgroupLimit > 0 && cgroupLimit < totalMemoryBytes) {
                        totalMemoryBytes = cgroupLimit;
                        const freeRatio = os.freemem() / os.totalmem();
                        availableMemoryBytes = Math.floor(cgroupLimit * freeRatio);
                    }
                }
            }
        } catch {
            // No cgroup limits found
        }
    }

    return { total: totalMemoryBytes, available: availableMemoryBytes };
}

function calculateCacheSize(): number {
    const MIN_CACHE_KIB = -16000;
    const MAX_CACHE_KIB = -256000;
    const MB_IN_BYTES = 1024 * 1024;
    const KIB_IN_BYTES = 1024;

    try {
        const { available } = detectContainerMemoryLimit();
        if (available < 160 * MB_IN_BYTES) {
            return MIN_CACHE_KIB;
        }
        const baseCacheBytes = available * 0.1;
        const cacheKiB = Math.floor(baseCacheBytes / KIB_IN_BYTES);
        return Math.max(MAX_CACHE_KIB, Math.min(MIN_CACHE_KIB, -cacheKiB));
    } catch {
        return MIN_CACHE_KIB;
    }
}

export function configureSQLitePragmas(execSync: (sql: string) => void, config: DBConfig): void {
    try {
        const sqliteConfig = {
            journalMode: validatePragmaValue(config.sqlite?.journalMode || 'WAL', VALID_JOURNAL_MODES, 'journal_mode'),
            synchronous: validatePragmaValue(config.sqlite?.synchronous || 'NORMAL', VALID_SYNCHRONOUS, 'synchronous'),
            busyTimeout: validatePragmaValue(config.sqlite?.busyTimeout || 5000, null, 'busy_timeout'),
            tempStore: validatePragmaValue(config.sqlite?.tempStore || 'MEMORY', VALID_TEMP_STORE, 'temp_store'),
            lockingMode: validatePragmaValue(config.sqlite?.lockingMode || 'NORMAL', VALID_LOCKING_MODE, 'locking_mode'),
            autoVacuum: validatePragmaValue(config.sqlite?.autoVacuum || 'NONE', VALID_AUTO_VACUUM, 'auto_vacuum'),
            cacheSize: calculateCacheSize(),
            walCheckpoint: validatePragmaValue(config.sqlite?.walCheckpoint || 1000, null, 'wal_autocheckpoint'),
        };

        execSync(`PRAGMA journal_mode = ${sqliteConfig.journalMode}`);
        execSync(`PRAGMA synchronous = ${sqliteConfig.synchronous}`);
        execSync(`PRAGMA busy_timeout = ${sqliteConfig.busyTimeout}`);
        execSync(`PRAGMA cache_size = ${sqliteConfig.cacheSize}`);
        execSync(`PRAGMA temp_store = ${sqliteConfig.tempStore}`);
        execSync(`PRAGMA locking_mode = ${sqliteConfig.lockingMode}`);
        execSync(`PRAGMA auto_vacuum = ${sqliteConfig.autoVacuum}`);
        if (sqliteConfig.autoVacuum !== 'NONE') {
            execSync('VACUUM');
        }
        if (sqliteConfig.journalMode === 'WAL') {
            execSync(`PRAGMA wal_autocheckpoint = ${sqliteConfig.walCheckpoint}`);
        }
        execSync('PRAGMA foreign_keys = ON');
    } catch (error) {
        console.warn('Warning: Failed to apply some SQLite configuration:', error);
    }
}
