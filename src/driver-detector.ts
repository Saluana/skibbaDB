import type { DBConfig } from './types';

export interface RuntimeEnvironment {
    runtime: 'bun' | 'node' | 'unknown';
    version?: string;
    capabilities: {
        hasBuiltinSQLite: boolean;
        supportsESM: boolean;
        supportsCJS: boolean;
    };
    confidence: number; // 0-100, higher means more confident in detection
}

export interface DriverDetectionResult {
    recommendedDriver: 'bun' | 'node';
    environment: RuntimeEnvironment;
    fallbackDrivers: ('bun' | 'node')[];
    warnings: string[];
    diagnostics?: Record<string, any>;
}

/**
 * Enhanced driver detection with better reliability for mixed-runtime environments
 */
export class DriverDetector {
    private static instance?: DriverDetector;
    private cachedEnvironment?: RuntimeEnvironment;

    static getInstance(): DriverDetector {
        if (!this.instance) {
            this.instance = new DriverDetector();
        }
        return this.instance;
    }

    /**
     * Detect the current runtime environment with high confidence
     */
    detectEnvironment(): RuntimeEnvironment {
        if (this.cachedEnvironment) {
            return this.cachedEnvironment;
        }

        const env = this.performEnvironmentDetection();
        this.cachedEnvironment = env;
        return env;
    }

    private performEnvironmentDetection(): RuntimeEnvironment {
        const checks = [
            this.checkBunRuntime(),
            this.checkNodeRuntime(),
            this.checkEnvironmentVariables(),
            this.checkGlobalObjects(),
            this.checkProcessVersions(),
        ];

        // Aggregate results from all checks
        const bunScore = checks.reduce(
            (score, check) => score + (check.isBun ? check.confidence : 0),
            0
        );
        const nodeScore = checks.reduce(
            (score, check) => score + (check.isNode ? check.confidence : 0),
            0
        );

        const runtime =
            bunScore > nodeScore ? 'bun' : nodeScore > 0 ? 'node' : 'unknown';
        const confidence = Math.max(bunScore, nodeScore);
        const version = this.extractVersion(runtime);

        return {
            runtime,
            version,
            capabilities: this.detectCapabilities(runtime),
            confidence: Math.min(confidence, 100),
        };
    }

    private checkBunRuntime(): {
        isBun: boolean;
        isNode: boolean;
        confidence: number;
    } {
        try {
            // Check for Bun global
            if (
                typeof globalThis.Bun !== 'undefined' &&
                globalThis.Bun !== null
            ) {
                // Additional validation - check if Bun methods are actually available
                if (typeof globalThis.Bun.version === 'string') {
                    return { isBun: true, isNode: false, confidence: 90 };
                }
                return { isBun: true, isNode: false, confidence: 70 };
            }
        } catch (error) {
            // Ignore errors in checking Bun global
        }
        return { isBun: false, isNode: false, confidence: 0 };
    }

    private checkNodeRuntime(): {
        isBun: boolean;
        isNode: boolean;
        confidence: number;
    } {
        try {
            // Check for Node.js process global
            if (
                typeof globalThis.process !== 'undefined' &&
                globalThis.process !== null
            ) {
                const proc = globalThis.process as any;

                // Strong Node.js indicators
                if (proc.versions && proc.versions.node && !proc.versions.bun) {
                    return { isBun: false, isNode: true, confidence: 90 };
                }

                // Weaker Node.js indicators
                if (proc.version && proc.version.startsWith('v')) {
                    return { isBun: false, isNode: true, confidence: 70 };
                }

                // Process exists but unclear
                return { isBun: false, isNode: true, confidence: 40 };
            }
        } catch (error) {
            // Ignore errors in checking process global
        }
        return { isBun: false, isNode: false, confidence: 0 };
    }

    private checkEnvironmentVariables(): {
        isBun: boolean;
        isNode: boolean;
        confidence: number;
    } {
        try {
            if (typeof process !== 'undefined' && process.env) {
                // Check for Bun-specific environment variables
                if (process.env.BUN_INSTALL || process.env.BUN_VERSION) {
                    return { isBun: true, isNode: false, confidence: 60 };
                }

                // Check for Node.js-specific environment variables
                if (process.env.NODE_VERSION || process.env.npm_version) {
                    return { isBun: false, isNode: true, confidence: 50 };
                }
            }
        } catch (error) {
            // Ignore errors
        }
        return { isBun: false, isNode: false, confidence: 0 };
    }

    private checkGlobalObjects(): {
        isBun: boolean;
        isNode: boolean;
        confidence: number;
    } {
        try {
            // Check for runtime-specific globals
            const hasBunSpecificGlobals =
                typeof globalThis.fetch !== 'undefined' &&
                typeof globalThis.Response !== 'undefined' &&
                typeof globalThis.Bun !== 'undefined';

            if (hasBunSpecificGlobals) {
                return { isBun: true, isNode: false, confidence: 30 };
            }

            // Check for Node.js-specific globals (these might not be reliable in modern Node.js)
            const hasNodeSpecificGlobals =
                typeof globalThis.global !== 'undefined' &&
                typeof globalThis.Buffer !== 'undefined' &&
                typeof globalThis.require !== 'undefined';

            if (
                hasNodeSpecificGlobals &&
                typeof globalThis.Bun === 'undefined'
            ) {
                return { isBun: false, isNode: true, confidence: 30 };
            }
        } catch (error) {
            // Ignore errors
        }
        return { isBun: false, isNode: false, confidence: 0 };
    }

    private checkProcessVersions(): {
        isBun: boolean;
        isNode: boolean;
        confidence: number;
    } {
        try {
            if (typeof process !== 'undefined' && process.versions) {
                // Bun runtime includes both bun and node in versions
                if (process.versions.bun && process.versions.node) {
                    return { isBun: true, isNode: false, confidence: 95 };
                }

                // Pure Node.js runtime
                if (process.versions.node && !process.versions.bun) {
                    return { isBun: false, isNode: true, confidence: 95 };
                }
            }
        } catch (error) {
            // Ignore errors
        }
        return { isBun: false, isNode: false, confidence: 0 };
    }

    private extractVersion(
        runtime: 'bun' | 'node' | 'unknown'
    ): string | undefined {
        try {
            switch (runtime) {
                case 'bun':
                    if (
                        typeof globalThis.Bun !== 'undefined' &&
                        globalThis.Bun.version
                    ) {
                        return globalThis.Bun.version;
                    }
                    if (
                        typeof process !== 'undefined' &&
                        process.versions?.bun
                    ) {
                        return process.versions.bun;
                    }
                    break;
                case 'node':
                    if (
                        typeof process !== 'undefined' &&
                        process.versions?.node
                    ) {
                        return process.versions.node;
                    }
                    break;
            }
        } catch (error) {
            // Ignore errors
        }
        return undefined;
    }

    private detectCapabilities(
        runtime: 'bun' | 'node' | 'unknown'
    ): RuntimeEnvironment['capabilities'] {
        return {
            hasBuiltinSQLite: runtime === 'bun',
            supportsESM: true, // Both modern Bun and Node support ESM
            supportsCJS: true, // Both support CommonJS
        };
    }

    /**
     * Determine the best driver for the given configuration and environment
     */
    detectDriver(config: DBConfig): DriverDetectionResult {
        const environment = this.detectEnvironment();
        const warnings: string[] = [];

        // Check environment variable override
        const envDriver = this.getEnvironmentDriverOverride();
        if (envDriver) {
            return {
                recommendedDriver: envDriver,
                environment,
                fallbackDrivers: this.getFallbackDrivers(envDriver),
                warnings: [
                    `Using driver '${envDriver}' from DATABASE_DRIVER environment variable`,
                ],
                diagnostics: this.getDiagnostics(),
            };
        }

        // Explicit driver configuration takes precedence
        if (config.driver) {
            const result = this.validateExplicitDriver(
                config.driver,
                environment
            );
            // If validation passes, we know driver is valid
            const validDriver = config.driver as 'bun' | 'node';
            return {
                recommendedDriver: validDriver,
                environment,
                fallbackDrivers: this.getFallbackDrivers(validDriver),
                warnings: result.warnings,
                diagnostics: this.getDiagnostics(),
            };
        }

        // Auto-detect based on environment
        const recommendedDriver = this.autoDetectDriver(environment, config);

        // Add warnings for low confidence detections
        if (environment.confidence < 70) {
            warnings.push(
                `Low confidence (${environment.confidence}%) in runtime detection. ` +
                    `Consider setting explicit driver: '${recommendedDriver}' in config.`
            );
        }

        // Add warnings for mixed environments
        if (this.isMixedEnvironment()) {
            warnings.push(
                'Mixed runtime environment detected. Ensure all dependencies are compatible with chosen driver.'
            );
        }

        return {
            recommendedDriver,
            environment,
            fallbackDrivers: this.getFallbackDrivers(recommendedDriver),
            warnings,
            diagnostics: this.getDiagnostics(),
        };
    }

    private getEnvironmentDriverOverride(): 'bun' | 'node' | null {
        try {
            const envDriver = process?.env?.DATABASE_DRIVER?.toLowerCase();
            if (envDriver === 'bun' || envDriver === 'node') {
                return envDriver;
            }
            if (envDriver && envDriver !== 'auto') {
                throw new Error(
                    `Invalid DATABASE_DRIVER environment variable: ${envDriver}. Use 'bun', 'node', or 'auto'.`
                );
            }
        } catch (error) {
            // If it's a validation error, re-throw it
            if (
                error instanceof Error &&
                error.message.includes('Invalid DATABASE_DRIVER')
            ) {
                throw error;
            }
            // Otherwise, process might not be available - ignore
        }
        return null;
    }

    private validateExplicitDriver(
        driver: string,
        environment: RuntimeEnvironment
    ): { warnings: string[] } {
        const warnings: string[] = [];

        // First validate that the driver type is recognized
        if (driver !== 'bun' && driver !== 'node') {
            throw new Error(
                `Invalid driver: ${driver}. ` +
                    `Supported drivers are: 'bun', 'node'. ` +
                    `Detected runtime: ${environment.runtime} (confidence: ${environment.confidence}%)`
            );
        }

        if (driver === 'bun' && environment.runtime === 'node') {
            warnings.push(
                'Explicit Bun driver selected but Node.js runtime detected. ' +
                    'This may fail if Bun is not available.'
            );
        }

        if (driver === 'node' && environment.runtime === 'bun') {
            warnings.push(
                'Explicit Node.js driver selected in Bun runtime. ' +
                    'Consider using Bun driver for better performance.'
            );
        }

        return { warnings };
    }

    private autoDetectDriver(
        environment: RuntimeEnvironment,
        config: DBConfig
    ): 'bun' | 'node' {
        // For high-confidence detection, use environment runtime
        if (environment.confidence >= 70) {
            if (environment.runtime === 'bun') {
                return 'bun';
            }
            if (environment.runtime === 'node') {
                return 'node';
            }
            return this.hasNodeRuntime() ? 'node' : 'bun';
        }

        // For low-confidence detection, use safer fallback
        // Node driver has broader compatibility, but only if Node runtime is confirmed
        if (this.hasNodeRuntime()) {
            return 'node';
        }
        return typeof globalThis.Bun !== 'undefined' ? 'bun' : 'node';
    }

    private getFallbackDrivers(
        primaryDriver: 'bun' | 'node'
    ): ('bun' | 'node')[] {
        return primaryDriver === 'bun' ? ['node'] : ['bun'];
    }

    private isMixedEnvironment(): boolean {
        try {
            const hasBun = typeof globalThis.Bun !== 'undefined';
            const hasNodeVersions =
                typeof process !== 'undefined' &&
                process.versions &&
                !!process.versions.node &&
                !!process.versions.bun;
            return hasBun && hasNodeVersions;
        } catch (error) {
            return false;
        }
    }

    private hasNodeRuntime(): boolean {
        return (
            typeof process !== 'undefined' &&
            !!process.versions &&
            !!process.versions.node
        );
    }

    /**
     * Clear cached environment detection (useful for testing)
     */
    clearCache(): void {
        this.cachedEnvironment = undefined;
    }

    /**
     * Get detailed diagnostics for troubleshooting
     */
    getDiagnostics(): Record<string, any> {
        const environment = this.detectEnvironment();

        return {
            environment,
            globals: {
                hasBun: typeof globalThis.Bun !== 'undefined',
                hasProcess: typeof globalThis.process !== 'undefined',
                hasBuffer: typeof globalThis.Buffer !== 'undefined',
                hasFetch: typeof globalThis.fetch !== 'undefined',
            },
            process:
                typeof process !== 'undefined'
                    ? {
                          versions: process.versions,
                          platform: process.platform,
                          arch: process.arch,
                          env: {
                              NODE_ENV: process.env.NODE_ENV,
                              DATABASE_DRIVER: process.env.DATABASE_DRIVER,
                              BUN_INSTALL: process.env.BUN_INSTALL,
                          },
                      }
                    : null,
            detectionTimestamp: new Date().toISOString(),
        };
    }
}

/**
 * Convenience function for driver detection
 */
export function detectDriver(config: DBConfig = {}): DriverDetectionResult {
    return DriverDetector.getInstance().detectDriver(config);
}

/**
 * Get runtime environment information
 */
export function getEnvironment(): RuntimeEnvironment {
    return DriverDetector.getInstance().detectEnvironment();
}

/**
 * Get diagnostics for troubleshooting driver detection issues
 */
export function getDiagnostics(): Record<string, any> {
    return DriverDetector.getInstance().getDiagnostics();
}
