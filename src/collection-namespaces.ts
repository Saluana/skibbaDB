import type { Collection } from './collection';
import type {
    InferSchema,
    AtomicUpdateOperators,
    UpdateOptions,
    VectorSearchOptions,
    VectorSearchResult,
} from './types';
import type { z } from 'zod/v3';

type Doc<T extends z.ZodSchema> = InferSchema<T>;
type InsertDoc<T extends z.ZodSchema> = Omit<Doc<T>, '_id'>;

export class CollectionBulk<T extends z.ZodSchema> {
    constructor(private readonly col: Collection<T>) {}

    insert(docs: InsertDoc<T>[]): Promise<Doc<T>[]> {
        return this.col.insertBulk(docs);
    }

    update(
        updates: { _id: string; doc: Partial<Doc<T>> }[]
    ): Promise<Doc<T>[]> {
        return this.col.putBulk(updates);
    }

    delete(ids: string[]): Promise<number> {
        return this.col.deleteBulk(ids);
    }

    upsert(
        items: { _id: string; doc: Omit<Doc<T>, '_id'> }[]
    ): Promise<Doc<T>[]> {
        return this.col.upsertBulk(items);
    }
}

export class CollectionSync<T extends z.ZodSchema> {
    constructor(private readonly col: Collection<T>) {}

    insert(doc: InsertDoc<T>): Doc<T> {
        return this.col.insertSync(doc);
    }

    insertBulk(docs: InsertDoc<T>[]): Doc<T>[] {
        return this.col.insertBulkSync(docs);
    }

    get(id: string): Doc<T> | null {
        return this.col.findByIdSync(id);
    }

    update(id: string, patch: Partial<Doc<T>>): Doc<T> {
        return this.col.putSync(id, patch);
    }

    upsert(id: string, doc: Omit<Doc<T>, '_id'>): Doc<T> {
        return this.col.upsertSync(id, doc);
    }

    remove(id: string): boolean {
        return this.col.deleteSync(id);
    }

    deleteBulk(ids: string[]): number {
        return this.col.deleteBulkSync(ids);
    }

    all(): Doc<T>[] {
        return this.col.toArraySync();
    }

    count(): number {
        return this.col.countSync();
    }

    first(): Doc<T> | null {
        return this.col.firstSync();
    }

    putBulk(updates: { _id: string; doc: Partial<Doc<T>> }[]): Doc<T>[] {
        return this.col.putBulkSync(updates);
    }

    upsertBulk(
        items: { _id: string; doc: Omit<Doc<T>, '_id'> }[]
    ): Doc<T>[] {
        return this.col.upsertBulkSync(items);
    }

    atomicUpdate(
        id: string,
        operators: AtomicUpdateOperators,
        options?: UpdateOptions
    ): Doc<T> {
        return this.col.atomicUpdateSync(id, operators, options);
    }

    rebuildIndexes(): { scanned: number; fixed: number; errors: string[] } {
        return this.col.rebuildIndexesSync();
    }
}

export class CollectionAtomic<T extends z.ZodSchema> {
    constructor(private readonly col: Collection<T>) {}

    update(
        id: string,
        operators: AtomicUpdateOperators,
        options?: UpdateOptions
    ): Promise<Doc<T>> {
        return this.col.atomicUpdate(id, operators, options);
    }
}

export class CollectionIndexes<T extends z.ZodSchema> {
    constructor(private readonly col: Collection<T>) {}

    rebuild(): Promise<{ scanned: number; fixed: number; errors: string[] }> {
        return this.col.rebuildIndexes();
    }

    async check(): Promise<{
        ok: boolean;
        scanned: number;
        fixed: number;
        errors: string[];
    }> {
        const result = await this.col.rebuildIndexes();
        return {
            ok: result.errors.length === 0,
            ...result,
        };
    }
}

export class CollectionVector<T extends z.ZodSchema> {
    constructor(private readonly col: Collection<T>) {}

    search(
        options: VectorSearchOptions
    ): Promise<VectorSearchResult<Doc<T>>[]> {
        return this.col.vectorSearch(options);
    }
}

export class DatabaseSync {
    constructor(private readonly db: {
        execSync: (sql: string, params?: unknown[]) => void;
        querySync: (sql: string, params?: unknown[]) => unknown[];
        closeSync: () => void;
    }) {}

    exec(sql: string, params?: unknown[]): void {
        this.db.execSync(sql, params);
    }

    query(sql: string, params?: unknown[]): unknown[] {
        return this.db.querySync(sql, params);
    }

    close(): void {
        this.db.closeSync();
    }
}
