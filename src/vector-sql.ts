import type { ConstrainedFieldDefinition } from './types';
import {
    extractConstrainedValues,
    fieldPathToColumnName,
} from './constrained-fields';
import { SchemaSQLGenerator } from './schema-sql-generator';

/**
 * Vector buffer pool to reduce allocations in vector operations.
 * Pools Float32Arrays by dimension size to avoid creating new buffers for each operation.
 */
class VectorBufferPool {
    private pools = new Map<number, Float32Array[]>();
    private readonly maxPoolSize = 10;

    acquire(dimensions: number): Float32Array {
        const pool = this.pools.get(dimensions);
        if (pool && pool.length > 0) {
            return pool.pop()!;
        }
        return new Float32Array(dimensions);
    }

    release(buffer: Float32Array): void {
        const dimensions = buffer.length;
        let pool = this.pools.get(dimensions);
        if (!pool) {
            pool = [];
            this.pools.set(dimensions, pool);
        }
        if (pool.length < this.maxPoolSize) {
            buffer.fill(0);
            pool.push(buffer);
        }
    }
}

const vectorBufferPool = new VectorBufferPool();

function vectorValueToBuffer(vectorValue: number[]): Buffer {
    const vectorArray = vectorBufferPool.acquire(vectorValue.length);
    vectorArray.set(vectorValue);
    const vectorCopy = new Float32Array(vectorArray);
    const buf = Buffer.from(vectorCopy.buffer, vectorCopy.byteOffset, vectorCopy.byteLength);
    vectorBufferPool.release(vectorArray);
    return buf;
}

export function isVectorExtensionError(error: unknown): boolean {
    return error instanceof Error && (
        error.message.includes('vec0') ||
        error.message.includes('no such module') ||
        error.message.includes('no such table')
    );
}

export function buildVectorInsertQueries(
    tableName: string,
    doc: any,
    id: string,
    constrainedFields?: { [fieldPath: string]: ConstrainedFieldDefinition }
): { sql: string; params: any[] }[] {
    const queries: { sql: string; params: any[] }[] = [];
    if (!constrainedFields) return queries;

    const vectorFields = SchemaSQLGenerator.getVectorFields(constrainedFields);
    const constrainedValues = extractConstrainedValues(doc, constrainedFields);

    for (const [fieldPath] of Object.entries(vectorFields)) {
        const vectorTableName = SchemaSQLGenerator.getVectorTableName(tableName, fieldPath);
        const columnName = fieldPathToColumnName(fieldPath);
        const vectorValue = constrainedValues[fieldPath];

        if (vectorValue && Array.isArray(vectorValue)) {
            const sql = `INSERT INTO ${vectorTableName} (rowid, ${columnName}) VALUES (
                (SELECT rowid FROM ${tableName} WHERE _id = ?), ?
            )`;
            const params = [id, vectorValueToBuffer(vectorValue)];
            queries.push({ sql, params });
        }
    }

    return queries;
}

export function buildVectorUpdateQueries(
    tableName: string,
    doc: any,
    id: string,
    constrainedFields?: { [fieldPath: string]: ConstrainedFieldDefinition }
): { sql: string; params: any[] }[] {
    const queries: { sql: string; params: any[] }[] = [];
    if (!constrainedFields) return queries;

    const vectorFields = SchemaSQLGenerator.getVectorFields(constrainedFields);
    const constrainedValues = extractConstrainedValues(doc, constrainedFields);

    for (const [fieldPath] of Object.entries(vectorFields)) {
        const vectorTableName = SchemaSQLGenerator.getVectorTableName(tableName, fieldPath);
        const columnName = fieldPathToColumnName(fieldPath);
        const vectorValue = constrainedValues[fieldPath];

        if (vectorValue && Array.isArray(vectorValue)) {
            const deleteSql = `DELETE FROM ${vectorTableName} WHERE rowid = (SELECT rowid FROM ${tableName} WHERE _id = ?)`;
            queries.push({ sql: deleteSql, params: [id] });

            const insertSql = `INSERT INTO ${vectorTableName} (rowid, ${columnName}) VALUES (
                (SELECT rowid FROM ${tableName} WHERE _id = ?), ?
            )`;
            queries.push({ sql: insertSql, params: [id, vectorValueToBuffer(vectorValue)] });
        }
    }

    return queries;
}

export function buildVectorDeleteQueries(
    tableName: string,
    id: string,
    constrainedFields?: { [fieldPath: string]: ConstrainedFieldDefinition }
): { sql: string; params: any[] }[] {
    const queries: { sql: string; params: any[] }[] = [];
    if (!constrainedFields) return queries;

    const vectorFields = SchemaSQLGenerator.getVectorFields(constrainedFields);

    for (const [fieldPath] of Object.entries(vectorFields)) {
        const vectorTableName = SchemaSQLGenerator.getVectorTableName(tableName, fieldPath);
        const sql = `DELETE FROM ${vectorTableName} WHERE rowid = (SELECT rowid FROM ${tableName} WHERE _id = ?)`;
        queries.push({ sql, params: [id] });
    }

    return queries;
}
