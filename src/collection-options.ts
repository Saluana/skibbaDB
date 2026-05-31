import type { ConstrainedFieldDefinition } from './types';
import { validateForeignKeyReference } from './sql-utils';
import type { SchemaConstraints } from './schema-constraints';
import type { UpgradeMap, SeedFunction } from './upgrade-types';
import type { z } from 'zod/v3';

/** User-facing collection configuration (compiled to constrainedFields internally). */
export interface FriendlyCollectionOptions<T = unknown> {
    /** Public ID field on documents (default: `id`). Use `_id` for legacy APIs. */
    id?: string;
    unique?: string[];
    index?: string[];
    /** field → `table.column` (e.g. `departmentId: "departments.id"`) */
    references?: Record<string, string>;
    advanced?: {
        constrainedFields?: Record<string, ConstrainedFieldDefinition>;
        primaryKey?: string;
        constraints?: SchemaConstraints;
    };
    /** @deprecated Prefer `unique` / `index` / `references`. */
    constrainedFields?: Record<string, ConstrainedFieldDefinition>;
    constraints?: SchemaConstraints;
    primaryKey?: string;
    version?: number;
    indexes?: string[];
    upgrade?: UpgradeMap<z.ZodTypeAny>;
    seed?: SeedFunction<z.ZodTypeAny>;
}

export interface NormalizedCollectionOptions<T = unknown> {
    primaryKey?: string;
    version?: number;
    indexes?: string[];
    constraints?: SchemaConstraints;
    constrainedFields?: Record<string, ConstrainedFieldDefinition>;
    publicIdField: string;
    upgrade?: UpgradeMap<z.ZodTypeAny>;
    seed?: SeedFunction<z.ZodTypeAny>;
}

function parseReference(ref: string): {
    foreignKey: string;
    onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT';
    onUpdate?: 'CASCADE' | 'SET NULL' | 'RESTRICT';
} {
    const { table, column } = validateForeignKeyReference(ref);
    const targetColumn = column === 'id' ? '_id' : column;
    return { foreignKey: `${table}.${targetColumn}` };
}

export function normalizeCollectionOptions<T>(
    options: FriendlyCollectionOptions<T> = {}
): NormalizedCollectionOptions<T> {
    const publicIdField = options.id ?? options.advanced?.primaryKey ?? 'id';
    const constrainedFields: Record<string, ConstrainedFieldDefinition> = {
        ...(options.advanced?.constrainedFields ?? {}),
        ...(options.constrainedFields ?? {}),
    };

    for (const field of options.unique ?? []) {
        constrainedFields[field] = {
            ...constrainedFields[field],
            unique: true,
            nullable: constrainedFields[field]?.nullable ?? false,
        };
    }

    for (const field of options.index ?? []) {
        constrainedFields[field] = {
            ...constrainedFields[field],
            index: true,
        };
    }

    for (const [field, ref] of Object.entries(options.references ?? {})) {
        const parsed = parseReference(ref);
        constrainedFields[field] = {
            ...constrainedFields[field],
            foreignKey: parsed.foreignKey,
            onDelete: constrainedFields[field]?.onDelete ?? 'CASCADE',
        };
    }

    const mergedIndexes = [
        ...(options.indexes ?? []),
        ...(options.index ?? []).filter((f) => !options.indexes?.includes(f)),
    ];

    return {
        primaryKey: options.advanced?.primaryKey ?? options.primaryKey,
        version: options.version,
        indexes: mergedIndexes.length > 0 ? mergedIndexes : options.indexes,
        constraints: options.advanced?.constraints ?? options.constraints,
        constrainedFields:
            Object.keys(constrainedFields).length > 0
                ? constrainedFields
                : options.constrainedFields,
        publicIdField,
        upgrade: options.upgrade,
        seed: options.seed,
    };
}

/** Type helper for db.collection third argument */
export type CollectionOptions<T extends z.ZodTypeAny = z.ZodTypeAny> =
    FriendlyCollectionOptions<z.infer<T> extends infer U ? U : never>;
