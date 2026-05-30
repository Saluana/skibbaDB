import type { z } from 'zod/v3';
import type { Collection } from './collection';
import type { Database } from './database';
import type { Migrator } from './migrator';

export interface UpgradeContext {
    fromVersion: number;
    toVersion: number;
    database: Database;
    transaction: <T>(fn: () => Promise<T>) => Promise<T>;
    migrator: Migrator;
    sql: (query: string, params?: any[]) => Promise<any[]>;
    exec: (query: string, params?: any[]) => Promise<void>;
}

export type UpgradeFunction<T extends z.ZodTypeAny> = (
    collection: Collection<T>,
    context: UpgradeContext
) => Promise<void>;

export interface ConditionalUpgrade<T extends z.ZodTypeAny> {
    condition?: (collection: Collection<T>) => Promise<boolean>;
    migrate: UpgradeFunction<T>;
}

export type UpgradeDefinition<T extends z.ZodTypeAny> = 
    | UpgradeFunction<T> 
    | ConditionalUpgrade<T>;

export interface UpgradeMap<T extends z.ZodTypeAny> {
    [version: number]: UpgradeDefinition<T>;
}

export type SeedFunction<T extends z.ZodTypeAny> = (collection: Collection<T>) => Promise<void>;