import type { Collection } from './collection';
import type { QueryBuilder } from './query-builder';
import { SQLTranslator } from './sql-translator';
import type { Driver } from './types';

export interface ExplainResult {
    collection: string;
    usesIndex: boolean;
    storage: 'column' | 'json' | 'mixed';
    sql: string;
    params: unknown[];
    filteredFields: string[];
}

export interface HealthResult {
    ok: boolean;
    collections: string[];
    driverReady: boolean;
    message?: string;
}

function fieldUsesColumn(
    field: string,
    constrainedFields?: Record<string, unknown>
): boolean {
    if (!constrainedFields) {
        return false;
    }
    const top = field.split('.')[0];
    return top in constrainedFields || field in constrainedFields;
}

export function buildExplainResult(
    collectionName: string,
    options: ReturnType<QueryBuilder<unknown>['getOptions']>,
    constrainedFields?: Record<string, unknown>
): ExplainResult {
    const { sql, params } = SQLTranslator.buildSelectQuery(
        collectionName,
        options,
        constrainedFields as any
    );

    const filteredFields = options.filters
        .map((f) => ('field' in f ? f.field : null))
        .filter((f): f is string => typeof f === 'string');

    const columnFields = filteredFields.filter((f) =>
        fieldUsesColumn(f, constrainedFields)
    );
    const usesIndex = columnFields.length > 0;
    let storage: ExplainResult['storage'] = 'json';
    if (columnFields.length === filteredFields.length && filteredFields.length > 0) {
        storage = 'column';
    } else if (columnFields.length > 0) {
        storage = 'mixed';
    }

    return {
        collection: collectionName,
        usesIndex,
        storage,
        sql,
        params,
        filteredFields,
    };
}

export async function explainQuery<T>(
    collection: Collection<any>,
    builder: QueryBuilder<T>
): Promise<ExplainResult> {
    const schema = (collection as any).collectionSchema;
    return buildExplainResult(
        schema.name,
        builder.getOptions(),
        schema.constrainedFields
    );
}

export async function checkDatabaseHealth(
    listCollections: () => string[],
    ensureDriver: () => Promise<Driver>
): Promise<HealthResult> {
    try {
        await ensureDriver();
        const collections = listCollections();
        return {
            ok: true,
            collections,
            driverReady: true,
        };
    } catch (error) {
        const message =
            error instanceof Error ? error.message : String(error);
        return {
            ok: false,
            collections: listCollections(),
            driverReady: false,
            message,
        };
    }
}
