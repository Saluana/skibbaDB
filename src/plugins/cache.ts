import type { Plugin, PluginContext } from '../plugin-system';

export interface CacheOptions {
    maxSize?: number;
    ttl?: number; // Time to live in milliseconds
    enableQueryCache?: boolean;
    enableDocumentCache?: boolean;
}

interface CacheEntry {
    value: any;
    timestamp: number;
    ttl: number;
}

export class CachePlugin implements Plugin {
    name = 'cache';
    version = '1.0.0';
    
    private options: Required<CacheOptions>;
    private documentCache = new Map<string, CacheEntry>();
    private queryCache = new Map<string, CacheEntry>();
    private cleanupTimer?: ReturnType<typeof setInterval>;
    
    constructor(options: CacheOptions = {}) {
        this.options = {
            maxSize: 1000,
            ttl: 60000, // 1 minute default
            enableQueryCache: false, // Query caching is complex, disabled by default
            enableDocumentCache: true,
            ...options
        };
        
        // Cleanup expired entries periodically
        this.cleanupTimer = setInterval(() => this.cleanup(), this.options.ttl);
        
        // SECURITY FIX: Register cleanup on process exit to prevent timer leak
        if (typeof process !== 'undefined') {
            const cleanup = () => this.destroy();
            process.once('beforeExit', cleanup);
            process.once('exit', cleanup);
        }
    }
    
    /**
     * Destroy the plugin and cleanup resources
     */
    destroy(): void {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = undefined;
        }
        this.clearCache();
    }
    
    private cleanup(): void {
        const now = Date.now();
        
        for (const [key, entry] of this.documentCache.entries()) {
            if (now - entry.timestamp > entry.ttl) {
                this.documentCache.delete(key);
            }
        }
        
        for (const [key, entry] of this.queryCache.entries()) {
            if (now - entry.timestamp > entry.ttl) {
                this.queryCache.delete(key);
            }
        }
    }
    
    private enforceMaxSize(cache: Map<string, CacheEntry>): void {
        if (cache.size > this.options.maxSize) {
            // Remove oldest entries (simple FIFO eviction)
            const keysToRemove = Array.from(cache.keys()).slice(0, cache.size - this.options.maxSize);
            keysToRemove.forEach(key => cache.delete(key));
        }
    }
    
    private getCacheKey(context: PluginContext, id?: string): string {
        return `${context.collectionName}:${id || 'query'}`;
    }
    
    async onAfterInsert(context: PluginContext): Promise<void> {
        if (this.options.enableDocumentCache && (context.result?._id || context.result?.id)) {
            const key = this.getCacheKey(context, context.result._id ?? context.result.id);
            this.documentCache.set(key, {
                value: context.result,
                timestamp: Date.now(),
                ttl: this.options.ttl
            });
            this.enforceMaxSize(this.documentCache);
        }
    }
    
    async onAfterUpdate(context: PluginContext): Promise<void> {
        if (this.options.enableDocumentCache && (context.result?._id || context.result?.id)) {
            const key = this.getCacheKey(context, context.result._id ?? context.result.id);
            this.documentCache.set(key, {
                value: context.result,
                timestamp: Date.now(),
                ttl: this.options.ttl
            });
            this.enforceMaxSize(this.documentCache);
        }
        
        // Invalidate query cache on updates
        if (this.options.enableQueryCache) {
            const pattern = `${context.collectionName}:query`;
            for (const key of this.queryCache.keys()) {
                if (key.startsWith(pattern)) {
                    this.queryCache.delete(key);
                }
            }
        }
    }
    
    async onAfterDelete(context: PluginContext): Promise<void> {
        if (this.options.enableDocumentCache && (context.data?._id || context.data?.id)) {
            const key = this.getCacheKey(context, context.data._id ?? context.data.id);
            this.documentCache.delete(key);
        }
        
        // Invalidate query cache on deletes
        if (this.options.enableQueryCache) {
            const pattern = `${context.collectionName}:query`;
            for (const key of this.queryCache.keys()) {
                if (key.startsWith(pattern)) {
                    this.queryCache.delete(key);
                }
            }
        }
    }
    
    // Public methods for manual cache management
    getCachedDocument(collectionName: string, id: string): any | null {
        const key = `${collectionName}:${id}`;
        const entry = this.documentCache.get(key);
        
        if (entry && Date.now() - entry.timestamp <= entry.ttl) {
            return entry.value;
        }
        
        if (entry) {
            this.documentCache.delete(key);
        }
        
        return null;
    }
    
    invalidateCollection(collectionName: string): void {
        for (const key of this.documentCache.keys()) {
            if (key.startsWith(`${collectionName}:`)) {
                this.documentCache.delete(key);
            }
        }
        
        for (const key of this.queryCache.keys()) {
            if (key.startsWith(`${collectionName}:`)) {
                this.queryCache.delete(key);
            }
        }
    }
    
    clearCache(): void {
        this.documentCache.clear();
        this.queryCache.clear();
    }
    
    getCacheStats(): { documentCache: number; queryCache: number } {
        return {
            documentCache: this.documentCache.size,
            queryCache: this.queryCache.size
        };
    }
}