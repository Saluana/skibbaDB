import { z } from 'zod';
import type { Database } from './database';
import type { Collection } from './collection';
import type { Driver } from './types';
import { Migrator } from './migrator';
import type {
    UpgradeContext,
    UpgradeDefinition,
    UpgradeMap,
    SeedFunction,
} from './upgrade-types';
import { DatabaseError } from './errors';

export class UpgradeRunner {
    constructor(private driver: Driver, private database: Database) {}

    async runUpgrades<T extends z.ZodSchema>(
        collection: Collection<T>,
        upgrades: UpgradeMap<T>,
        fromVersion: number,
        toVersion: number
    ): Promise<void> {
        if (!upgrades) return;

        // Run upgrades sequentially from fromVersion+1 to toVersion
        for (let version = fromVersion + 1; version <= toVersion; version++) {
            const upgradeDefinition = upgrades[version];

            if (upgradeDefinition) {
                try {
                    await this.runSingleUpgrade(
                        collection,
                        upgradeDefinition,
                        fromVersion, // Pass the original fromVersion (storedVersion)
                        version
                    );
                } catch (error) {
                    const errorMessage =
                        error instanceof Error ? error.message : String(error);
                    throw new DatabaseError(
                        `Custom upgrade v${version} failed for collection '${
                            (collection as any).collectionSchema.name
                        }': ${errorMessage}`,
                        'UPGRADE_FUNCTION_FAILED'
                    );
                }
            }
        }
    }

    async runSeedFunction<T extends z.ZodSchema>(
        collection: Collection<T>,
        seedFunction: SeedFunction<T>
    ): Promise<void> {
        try {
            // Don't start new transaction, we're already in one from the migrator
            await seedFunction(collection);
        } catch (error) {
            const errorMessage =
                error instanceof Error ? error.message : String(error);
            throw new DatabaseError(
                `Seed function failed for collection '${
                    (collection as any).collectionSchema.name
                }': ${errorMessage}`,
                'SEED_FUNCTION_FAILED'
            );
        }
    }

    private async runSingleUpgrade<T extends z.ZodSchema>(
        collection: Collection<T>,
        upgrade: UpgradeDefinition<T>,
        fromVersion: number,
        toVersion: number
    ): Promise<void> {
        const context: UpgradeContext = {
            fromVersion,
            toVersion,
            database: this.database,
            transaction: <U>(fn: () => Promise<U>) => {
                // We're already in a transaction, so just execute the function directly
                return fn();
            },
            migrator: new Migrator(this.driver),
            sql: (query: string, params?: any[]) =>
                this.driver.query(query, params),
            exec: (query: string, params?: any[]) =>
                this.driver.exec(query, params),
        };

        if (typeof upgrade === 'function') {
            // Simple function upgrade - don't start new transaction, we're already in one
            await upgrade(collection, context);
        } else {
            // Conditional upgrade
            const shouldRun = upgrade.condition
                ? await upgrade.condition(collection)
                : true;

            if (shouldRun) {
                // Don't start new transaction, we're already in one
                await upgrade.migrate(collection, context);
            }
        }
    }

    async printUpgradePlan<T extends z.ZodTypeAny>(
        collectionName: string,
        upgrades: UpgradeMap<T>,
        fromVersion: number,
        toVersion: number
    ): Promise<void> {
        if (!upgrades) return;

        const hasUpgrades = Object.keys(upgrades).some((v) => {
            const version = parseInt(v);
            return version > fromVersion && version <= toVersion;
        });

        if (hasUpgrades) {
            console.log(`  Custom upgrade functions:`);
            for (
                let version = fromVersion + 1;
                version <= toVersion;
                version++
            ) {
                const upgradeDefinition = upgrades[version];
                if (upgradeDefinition) {
                    const upgradeType = typeof upgradeDefinition === 'function' 
                        ? 'function' 
                        : 'conditional';
                    console.log(`    v${version}: ${upgradeType} upgrade`);
                }
            }
        }
    }
}
