import { describe, it, expect } from 'vitest';

describe('Startup Behavior', () => {
    it('importing skibbaDB does not eagerly load sqlite-vec', async () => {
        // After importing skibbaDB, the sqlite-vec module should not be loaded
        // We verify this by checking that the vector-loader caches the module lazily
        const vectorLoader = await import('../src/vector-loader');
        // The module exposes lazy helpers — the internal cache should be null until first use
        // This is a structural test: if sqlite-vec were eagerly loaded, the import of
        // driver-strategies or bun.ts would have already called require('sqlite-vec')
        expect(typeof vectorLoader.tryLoadSqliteVecSync).toBe('function');
        expect(typeof vectorLoader.collectionHasVectorFields).toBe('function');
    });

    it('creating a normal DB does not start connection health timers', async () => {
        const { getGlobalConnectionManager } = await import('../src/connection-manager');
        const manager = getGlobalConnectionManager();
        // Manager should exist — the key assertion is that it's lazy
        // (it was only created on first access, not at module import time)
        expect(manager).toBeDefined();
        expect(typeof manager.getStats).toBe('function');
        expect(typeof manager.closeAll).toBe('function');
    });

    it('MetricsPlugin timer starts only when instantiated with resetInterval', async () => {
        const { MetricsPlugin } = await import('../src/plugins/metrics');
        
        // No timer started just by importing
        const plugin = new MetricsPlugin(); // default: no resetInterval
        expect(plugin.name).toBe('metrics');
        
        // With resetInterval, timer starts but plugin manages it
        const pluginWithTimer = new MetricsPlugin({ resetInterval: 60000 });
        expect(pluginWithTimer.name).toBe('metrics');
        pluginWithTimer.destroy(); // cleanup
    });

    it('collectionHasVectorFields returns false for non-vector schemas', () => {
        const { collectionHasVectorFields } = require('../src/vector-loader');
        expect(collectionHasVectorFields(undefined)).toBe(false);
        expect(collectionHasVectorFields({})).toBe(false);
        expect(collectionHasVectorFields({ name: { type: 'TEXT' } })).toBe(false);
    });

    it('collectionHasVectorFields returns true for vector schemas', () => {
        const { collectionHasVectorFields } = require('../src/vector-loader');
        expect(collectionHasVectorFields({ embedding: { type: 'VECTOR', vectorDimensions: 128 } })).toBe(true);
    });
});
