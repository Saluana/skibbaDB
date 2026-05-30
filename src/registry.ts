import { z } from 'zod';
import type {
    CollectionSchema,
    InferSchema,
    ConstrainedFieldDefinition,
} from './types';
import type { SchemaConstraints, Constraint } from './schema-constraints';
import type { UpgradeMap, SeedFunction } from './upgrade-types';

export class Registry {
    private collections = new Map<string, CollectionSchema>();

    private convertConstraintsToConstrainedFields(
        constraints: SchemaConstraints
    ): { [fieldPath: string]: ConstrainedFieldDefinition } {
        const result: { [fieldPath: string]: ConstrainedFieldDefinition } = {};

        if (constraints?.constraints) {
            for (const [fieldPath, constraint] of Object.entries(
                constraints.constraints
            )) {
                const constraintArray = Array.isArray(constraint)
                    ? constraint
                    : [constraint];

                for (const c of constraintArray) {
                    switch (c.type) {
                        case 'unique':
                            // Handle composite unique constraints
                            if (c.fields && c.fields.length > 1) {
                                // For composite constraints, skip for now (needs table-level constraint)
                                // Skip composite unique constraints as they're not yet supported
                                continue;
                            } else if (c.fields && c.fields.length === 1) {
                                // Single field from composite constraint definition
                                const actualField = c.fields[0];
                                if (!result[actualField])
                                    result[actualField] = {};
                                result[actualField].unique = true;
                            } else {
                                // Regular single field constraint
                                if (!result[fieldPath]) result[fieldPath] = {};
                                result[fieldPath].unique = true;
                            }
                            break;
                        case 'foreign_key':
                            if (!result[fieldPath]) result[fieldPath] = {};
                            result[
                                fieldPath
                            ].foreignKey = `${c.referencedTable}.${c.referencedFields[0]}`;
                            if (c.onDelete)
                                result[fieldPath].onDelete =
                                    c.onDelete.toUpperCase() as any;
                            if (c.onUpdate)
                                result[fieldPath].onUpdate =
                                    c.onUpdate.toUpperCase() as any;
                            break;
                        case 'check':
                            if (!result[fieldPath]) result[fieldPath] = {};
                            result[fieldPath].checkConstraint = c.expression;
                            break;
                    }
                }
            }
        }

        return result;
    }

    register<T extends z.ZodSchema>(
        name: string,
        schema: T,
        options: {
            primaryKey?: string;
            version?: number;
            indexes?: string[];
            constraints?: SchemaConstraints;
            constrainedFields?: {
                [fieldPath: string]: ConstrainedFieldDefinition;
            };
            upgrade?: UpgradeMap<InferSchema<T>>;
            seed?: SeedFunction<InferSchema<T>>;
        } = {}
    ): CollectionSchema<InferSchema<T>> {
        if (this.collections.has(name)) {
            throw new Error(`Collection '${name}' is already registered`);
        }

        // Convert old constraints API to constrainedFields if needed
        let finalConstrainedFields = options.constrainedFields || {};
        if (options.constraints) {
            const convertedFields = this.convertConstraintsToConstrainedFields(
                options.constraints
            );
            finalConstrainedFields = {
                ...convertedFields,
                ...finalConstrainedFields,
            };
        }

        const collectionSchema: CollectionSchema<InferSchema<T>> = {
            name,
            schema,
            primaryKey: options.primaryKey || '_id',
            version: options.version || 1,
            indexes: options.indexes || [],
            constraints: options.constraints,
            constrainedFields: finalConstrainedFields,
            upgrade: options.upgrade,
            seed: options.seed,
        };

        this.collections.set(name, collectionSchema);
        return collectionSchema;
    }

    get(name: string): CollectionSchema<z.ZodTypeAny> | undefined {
        return this.collections.get(name);
    }

    has(name: string): boolean {
        return this.collections.has(name);
    }

    list(): string[] {
        return Array.from(this.collections.keys());
    }

    clear(): void {
        this.collections.clear();
    }
}
