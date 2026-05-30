import type { DBConfig } from './types';

export interface RuntimeEnvironment {
    runtime: 'bun' | 'node' | 'unknown';
    version?: string;
    capabilities: {
        hasBuiltinSQLite: boolean;
        supportsESM: boolean;
        supportsCJS: boolean;
    };
    confidence: number;
}

export interface DriverDetectionResult {
    recommendedDriver: 'bun' | 'node';
    environment: RuntimeEnvironment;
    fallbackDrivers: ('bun' | 'node')[];
    warnings: string[];
    diagnostics?: Record<string, any>;
}

function detectRuntime(): RuntimeEnvironment {
    const isBun = typeof globalThis.Bun !== 'undefined';
    const hasProcess = typeof process !== 'undefined' && !!process.versions;

    if (isBun || (hasProcess && !!process.versions.bun)) {
        const version = isBun ? (globalThis.Bun as any).version : process.versions.bun;
        return {
            runtime: 'bun',
            version,
            capabilities: { hasBuiltinSQLite: true, supportsESM: true, supportsCJS: true },
            confidence: 95,
        };
    }

    if (hasProcess && !!process.versions.node) {
        return {
            runtime: 'node',
            version: process.versions.node,
            capabilities: { hasBuiltinSQLite: false, supportsESM: true, supportsCJS: true },
            confidence: 95,
        };
    }

    return {
        runtime: 'unknown',
        capabilities: { hasBuiltinSQLite: false, supportsESM: true, supportsCJS: true },
        confidence: 0,
    };
}

let cachedEnvironment: RuntimeEnvironment | undefined;

export function getEnvironment(): RuntimeEnvironment {
    if (!cachedEnvironment) {
        cachedEnvironment = detectRuntime();
    }
    return cachedEnvironment;
}

export function clearDriverCache(): void {
    cachedEnvironment = undefined;
}

export function detectDriver(config: DBConfig = {}): DriverDetectionResult {
    const environment = getEnvironment();
    const warnings: string[] = [];

    // Check environment variable override
    try {
        const envDriver = process?.env?.DATABASE_DRIVER?.toLowerCase();
        if (envDriver === 'bun' || envDriver === 'node') {
            return {
                recommendedDriver: envDriver,
                environment,
                fallbackDrivers: envDriver === 'bun' ? ['node'] : ['bun'],
                warnings: [`Using driver '${envDriver}' from DATABASE_DRIVER environment variable`],
                diagnostics: getDiagnostics(),
            };
        }
        if (envDriver && envDriver !== 'auto') {
            throw new Error(`Invalid DATABASE_DRIVER environment variable: ${envDriver}. Use 'bun', 'node', or 'auto'.`);
        }
    } catch (error) {
        if (error instanceof Error && error.message.includes('Invalid DATABASE_DRIVER')) {
            throw error;
        }
    }

    // Explicit driver configuration
    if (config.driver) {
        if (config.driver !== 'bun' && config.driver !== 'node') {
            throw new Error(`Invalid driver: ${config.driver}. Supported drivers are: 'bun', 'node'.`);
        }
        if (config.driver === 'bun' && environment.runtime === 'node') {
            warnings.push('Explicit Bun driver selected but Node.js runtime detected.');
        }
        if (config.driver === 'node' && environment.runtime === 'bun') {
            warnings.push('Explicit Node.js driver selected in Bun runtime. Consider using Bun driver for better performance.');
        }
        const validDriver = config.driver as 'bun' | 'node';
        return {
            recommendedDriver: validDriver,
            environment,
            fallbackDrivers: validDriver === 'bun' ? ['node'] : ['bun'],
            warnings,
            diagnostics: getDiagnostics(),
        };
    }

    // Auto-detect: Bun if available, otherwise Node
    const recommendedDriver: 'bun' | 'node' = environment.runtime === 'bun' ? 'bun' : 'node';

    if (environment.confidence < 70) {
        warnings.push(`Low confidence (${environment.confidence}%) in runtime detection. Consider setting explicit driver in config.`);
    }

    return {
        recommendedDriver,
        environment,
        fallbackDrivers: recommendedDriver === 'bun' ? ['node'] : ['bun'],
        warnings,
        diagnostics: getDiagnostics(),
    };
}

export function getDiagnostics(): Record<string, any> {
    const environment = getEnvironment();
    return {
        environment,
        globals: {
            hasBun: typeof globalThis.Bun !== 'undefined',
            hasProcess: typeof globalThis.process !== 'undefined',
            hasBuffer: typeof globalThis.Buffer !== 'undefined',
            hasFetch: typeof globalThis.fetch !== 'undefined',
        },
        process: typeof process !== 'undefined'
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
