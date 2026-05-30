import type { DBConfig, DBPreset } from './types';

const PRESETS: Record<DBPreset, Partial<DBConfig>> = {
    memory: { memory: true },
    local: {
        sqlite: {
            journalMode: 'WAL',
            synchronous: 'NORMAL',
            busyTimeout: 3000,
        },
    },
    server: {
        sqlite: {
            journalMode: 'WAL',
            synchronous: 'FULL',
            busyTimeout: 10000,
        },
    },
    test: { memory: true },
    turso: {
        driver: 'node',
        libsql: true,
    },
};

export function applyDBPreset(config: DBConfig): DBConfig {
    const preset = config.preset;
    if (!preset) {
        return config;
    }
    const { preset: _p, ...rest } = config;
    const base = PRESETS[preset];
    if (!base) {
        return rest;
    }
    return {
        ...base,
        ...rest,
        sqlite: { ...base.sqlite, ...rest.sqlite },
        connectionPool: { ...base.connectionPool, ...rest.connectionPool },
        libsqlPool: { ...base.libsqlPool, ...rest.libsqlPool },
    };
}

export { PRESETS as SKIBBA_PRESETS };
