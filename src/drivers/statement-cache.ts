/**
 * LRU prepared statement cache with eviction.
 * Caches prepared statements by SQL string to avoid re-preparation overhead.
 */
export class StatementCache {
    private cache = new Map<string, any>();
    private accessOrder: string[] = [];
    private readonly maxSize: number;

    constructor(maxSize: number = 100) {
        this.maxSize = maxSize;
    }

    get(sql: string): any | undefined {
        const stmt = this.cache.get(sql);
        if (stmt) {
            const idx = this.accessOrder.indexOf(sql);
            if (idx > -1) this.accessOrder.splice(idx, 1);
            this.accessOrder.push(sql);
        }
        return stmt;
    }

    set(sql: string, stmt: any): void {
        if (this.cache.has(sql)) {
            const idx = this.accessOrder.indexOf(sql);
            if (idx !== -1) this.accessOrder.splice(idx, 1);
        }
        if (this.cache.size >= this.maxSize && !this.cache.has(sql)) {
            const oldest = this.accessOrder.shift();
            if (oldest) {
                const oldStmt = this.cache.get(oldest);
                if (oldStmt && typeof oldStmt.finalize === 'function') {
                    try { oldStmt.finalize(); } catch { /* ignore */ }
                }
                this.cache.delete(oldest);
            }
        }
        this.cache.set(sql, stmt);
        this.accessOrder.push(sql);
    }

    has(sql: string): boolean {
        return this.cache.has(sql);
    }

    clear(): void {
        for (const [, stmt] of this.cache) {
            if (stmt && typeof stmt.finalize === 'function') {
                try { stmt.finalize(); } catch { /* ignore */ }
            }
        }
        this.cache.clear();
        this.accessOrder = [];
    }

    prepare<T = any>(sql: string, prepareFunc: () => T): T {
        let stmt = this.get(sql);
        if (!stmt) {
            stmt = prepareFunc();
            this.set(sql, stmt);
        }
        return stmt;
    }
}
