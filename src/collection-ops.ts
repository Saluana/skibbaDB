import type { z } from 'zod/v3';
import type {
    CollectionSchema,
    InferSchema,
    DocBindSql,
    QueryOptions,
} from './types';
import { SQLTranslator } from './sql-translator';
import {
    ValidationError,
    NotFoundError,
    UniqueConstraintError,
} from './errors.js';
import {
    parseDoc,
    mergeConstrainedFields,
    reconstructNestedObject,
} from './json-utils.js';
import {
    attachPublicId,
    normalizeIncomingDoc,
    resolveInternalId,
} from './document-id';
import {
    fieldPathToColumnName,
} from './constrained-fields';

/**
 * Prepared insert document with SQL and metadata ready for execution.
 */
export interface PreparedInsert<T> {
    sql: string;
    params: any[];
    validatedDoc: InferSchema<T>;
    _id: string;
    vectorQueries: { sql: string; params: any[] }[];
}

/**
 * Prepared update document with SQL and metadata ready for execution.
 */
export interface PreparedUpdate<T> {
    sql: string;
    params: any[];
    validatedDoc: InferSchema<T>;
    _id: string;
    vectorQueries: { sql: string; params: any[] }[];
}

/**
 * Prepare a single document for insert.
 * Handles normalization, ID generation, validation, SQL building, and vector query building.
 */
export function prepareInsertDoc<T extends z.ZodSchema>(
    doc: Omit<InferSchema<T>, '_id'>,
    schema: CollectionSchema<InferSchema<T>>,
    publicIdField: string,
    generateId: () => string,
    validateDoc: (doc: any) => InferSchema<T>,
    docBindSql: DocBindSql
): PreparedInsert<T> {
    const normalized = normalizeIncomingDoc(
        doc as Record<string, unknown>,
        publicIdField
    );
    const _id =
        resolveInternalId(normalized, publicIdField) ?? generateId();

    const fullDoc = { ...normalized, _id };
    const validatedDoc = validateDoc(fullDoc);

    const { sql, params } = SQLTranslator.buildInsertQuery(
        schema.name,
        validatedDoc,
        _id,
        schema.constrainedFields,
        schema.schema,
        docBindSql
    );

    const vectorQueries = SQLTranslator.buildVectorInsertQueries(
        schema.name,
        validatedDoc,
        _id,
        schema.constrainedFields
    );

    return { sql, params, validatedDoc, _id, vectorQueries };
}

/**
 * Build the result document for an insert (sets _version=1 and attaches public ID).
 */
export function mapInsertResult<T extends z.ZodSchema>(
    validatedDoc: InferSchema<T>,
    publicIdField: string
): InferSchema<T> {
    const result = { ...validatedDoc };
    (result as any)._version = 1;
    return attachPublicId(result as Record<string, unknown>, publicIdField) as InferSchema<T>;
}

/**
 * Prepare a single document for update.
 * Handles merging, validation, SQL building, version check, and vector query building.
 */
export function prepareUpdateDoc<T extends z.ZodSchema>(
    existing: InferSchema<T>,
    patch: Partial<InferSchema<T>>,
    _id: string,
    schema: CollectionSchema<InferSchema<T>>,
    publicIdField: string,
    validateDoc: (doc: any) => InferSchema<T>,
    docBindSql: DocBindSql,
    currentVersion?: number
): PreparedUpdate<T> {
    const updatedDoc = { ...existing, ...patch, _id };
    const validatedDoc = validateDoc(updatedDoc);

    const { sql, params } = SQLTranslator.buildUpdateQuery(
        schema.name,
        validatedDoc,
        _id,
        schema.constrainedFields,
        schema.schema,
        currentVersion,
        docBindSql,
        publicIdField
    );

    const vectorQueries = SQLTranslator.buildVectorUpdateQueries(
        schema.name,
        validatedDoc,
        _id,
        schema.constrainedFields
    );

    return { sql, params, validatedDoc, _id, vectorQueries };
}

/**
 * Build the result document for an update (increments _version).
 */
export function mapUpdateResult<T extends z.ZodSchema>(
    validatedDoc: InferSchema<T>,
    currentVersion: number,
    publicIdField: string
): InferSchema<T> {
    const result = { ...validatedDoc };
    (result as any)._version = currentVersion + 1;
    return attachPublicId(result as Record<string, unknown>, publicIdField) as InferSchema<T>;
}

/**
 * Prepare bulk insert: validate all docs, build SQL, build vector queries.
 */
export function prepareBulkInsertDocs<T extends z.ZodSchema>(
    docs: Omit<InferSchema<T>, '_id'>[],
    schema: CollectionSchema<InferSchema<T>>,
    publicIdField: string,
    generateId: () => string,
    validateDoc: (doc: any) => InferSchema<T>,
    docBindSql: DocBindSql
): {
    validatedDocs: InferSchema<T>[];
    sql: string;
    params: any[];
    vectorQueries: { sql: string; params: any[] }[];
} {
    const validatedDocs: InferSchema<T>[] = [];
    const allVectorQueries: { sql: string; params: any[] }[] = [];

    for (const doc of docs) {
        const normalized = normalizeIncomingDoc(
            doc as Record<string, unknown>,
            publicIdField
        );
        const _id =
            resolveInternalId(normalized, publicIdField) ?? generateId();
        const fullDoc = { ...normalized, _id };
        const validatedDoc = validateDoc(fullDoc);
        validatedDocs.push(validatedDoc);

        allVectorQueries.push(
            ...SQLTranslator.buildVectorInsertQueries(
                schema.name,
                validatedDoc,
                _id,
                schema.constrainedFields
            )
        );
    }

    const { sql, params } = SQLTranslator.buildBulkInsertQuery(
        schema.name,
        validatedDocs,
        schema.constrainedFields,
        schema.schema,
        docBindSql
    );

    return { validatedDocs, sql, params, vectorQueries: allVectorQueries };
}

/**
 * Prepare vector delete queries for a given document ID.
 */
export function prepareVectorDeletes(
    schemaName: string,
    _id: string,
    constrainedFields: CollectionSchema['constrainedFields']
): { sql: string; params: any[] }[] {
    return SQLTranslator.buildVectorDeleteQueries(
        schemaName,
        _id,
        constrainedFields
    );
}

/**
 * Row mapping: merge constrained fields back into document for joined queries.
 */
export function mapJoinedRow(row: any): any {
    const mergedObject: any = {};
    if (row.doc) {
        Object.assign(mergedObject, parseDoc(row.doc));
    }
    Object.keys(row).forEach((key) => {
        if (key !== 'doc' && row[key] !== null && row[key] !== undefined) {
            const fieldName = key.includes('.') ? key.split('.').pop() : key;
            if (fieldName) {
                mergedObject[fieldName] = row[key];
            }
        }
    });
    return mergedObject;
}
