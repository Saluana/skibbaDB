import type { z } from 'zod/v3';
import type { Row, CollectionSchema } from './types';
import { PluginError, PluginTimeoutError } from './errors';

export interface PluginContext {
    collectionName: string;
    schema: CollectionSchema;
    operation: string;
    data?: any;
    result?: any;
    error?: Error;
    abortSignal?: AbortSignal;
}

export interface PluginSystemOptions {
    timeout?: number; // Timeout in milliseconds, default 5000
}

export interface Plugin {
    name: string;
    version?: string;
    systemOptions?: PluginSystemOptions;
    
    // Lifecycle hooks
    onBeforeInsert?(context: PluginContext): Promise<void> | void;
    onAfterInsert?(context: PluginContext): Promise<void> | void;
    
    onBeforeUpdate?(context: PluginContext): Promise<void> | void;
    onAfterUpdate?(context: PluginContext): Promise<void> | void;
    
    onBeforeDelete?(context: PluginContext): Promise<void> | void;
    onAfterDelete?(context: PluginContext): Promise<void> | void;
    
    onBeforeQuery?(context: PluginContext): Promise<void> | void;
    onAfterQuery?(context: PluginContext): Promise<void> | void;
    
    onBeforeTransaction?(context: PluginContext): Promise<void> | void;
    onAfterTransaction?(context: PluginContext): Promise<void> | void;
    onTransactionError?(context: PluginContext): Promise<void> | void;
    
    // Database lifecycle
    onDatabaseInit?(context: Omit<PluginContext, 'collectionName' | 'schema'>): Promise<void> | void;
    onDatabaseClose?(context: Omit<PluginContext, 'collectionName' | 'schema'>): Promise<void> | void;
    
    // Collection lifecycle
    onCollectionCreate?(context: PluginContext): Promise<void> | void;
    onCollectionDrop?(context: PluginContext): Promise<void> | void;
    
    // Error handling
    onError?(context: PluginContext): Promise<void> | void;
}

export interface PluginManagerOptions {
    strictMode?: boolean; // If true, plugin errors are thrown as PluginErrors
    defaultTimeout?: number; // Default timeout for plugins in milliseconds
}

const KNOWN_HOOK_NAMES = [
    'onBeforeInsert',
    'onAfterInsert',
    'onBeforeUpdate',
    'onAfterUpdate',
    'onBeforeDelete',
    'onAfterDelete',
    'onBeforeQuery',
    'onAfterQuery',
    'onBeforeTransaction',
    'onAfterTransaction',
    'onTransactionError',
    'onDatabaseInit',
    'onDatabaseClose',
    'onCollectionCreate',
    'onCollectionDrop',
    'onError',
] as const;

export class PluginManager {
    private plugins: Map<string, Plugin> = new Map();
    private hooks: Map<string, Plugin[]> = new Map();
    private options: PluginManagerOptions;
    
    constructor(options: PluginManagerOptions = {}) {
        this.options = {
            strictMode: false,
            defaultTimeout: 5000,
            ...options
        };
    }
    
    register(plugin: Plugin): void {
        if (this.plugins.has(plugin.name)) {
            throw new Error(`Plugin '${plugin.name}' is already registered`);
        }
        
        this.plugins.set(plugin.name, plugin);
        
        // Fast path: check known hook names directly (handles inheritance via JS property lookup)
        for (const hookName of KNOWN_HOOK_NAMES) {
            if (typeof (plugin as any)[hookName] === 'function') {
                this.addHook(hookName, plugin);
            }
        }

        // Slow path: walk prototype chain for custom hooks not in the known list
        let currentProto: any = Object.getPrototypeOf(plugin);
        while (currentProto && currentProto !== Object.prototype) {
            for (const key of Object.getOwnPropertyNames(currentProto)) {
                if (key.startsWith('on') && !KNOWN_HOOK_NAMES.includes(key as any) &&
                    typeof (currentProto as any)[key] === 'function') {
                    this.addHook(key, plugin);
                }
            }
            currentProto = Object.getPrototypeOf(currentProto);
        }

        // Also check own properties for custom hooks defined directly on the instance
        for (const key of Object.getOwnPropertyNames(plugin)) {
            if (key.startsWith('on') && !KNOWN_HOOK_NAMES.includes(key as any) &&
                typeof (plugin as any)[key] === 'function') {
                this.addHook(key, plugin);
            }
        }
    }

    private addHook(hookName: string, plugin: Plugin): void {
        let pluginsForHook = this.hooks.get(hookName);
        if (!pluginsForHook) {
            pluginsForHook = [];
            this.hooks.set(hookName, pluginsForHook);
        }
        if (!pluginsForHook.includes(plugin)) {
            pluginsForHook.push(plugin);
        }
    }
    
    unregister(pluginName: string): void {
        const plugin = this.plugins.get(pluginName);
        if (!plugin) {
            throw new Error(`Plugin '${pluginName}' is not registered`);
        }
        
        this.plugins.delete(pluginName);
        
        // Remove from hooks
        this.hooks.forEach((plugins, hookName) => {
            const index = plugins.indexOf(plugin);
            if (index !== -1) {
                plugins.splice(index, 1);
            }
        });
    }
    
    getPlugin(name: string): Plugin | undefined {
        return this.plugins.get(name);
    }
    
    listPlugins(): Plugin[] {
        return Array.from(this.plugins.values());
    }

    hasPlugins(): boolean {
        return this.plugins.size > 0;
    }

    executeHookSync(hookName: string, context: PluginContext): void {
        const plugins = this.hooks.get(hookName) || [];

        for (const plugin of plugins) {
            const hookFn = plugin[hookName as keyof Plugin] as Function | undefined;
            if (!hookFn) continue;

            try {
                const result = hookFn.call(plugin, context);
                // SECURITY FIX: Use more reliable Promise detection
                // Check both instanceof and constructor to catch all async patterns
                if (result && (result instanceof Promise || result?.constructor?.name === 'Promise')) {
                    throw new PluginError(
                        `Plugin '${plugin.name}' hook '${hookName}' returned a Promise during sync execution`,
                        plugin.name,
                        hookName
                    );
                }
            } catch (error) {
                const pluginError = error instanceof PluginError
                    ? error
                    : new PluginError(
                        `Plugin '${plugin.name}' hook '${hookName}' failed: ${(error as Error).message}`,
                        plugin.name,
                        hookName,
                        error as Error
                    );

                if (hookName !== 'onError') {
                    try {
                        const errorContext = { ...context, error: pluginError };
                        this.executeHookSync('onError', errorContext);
                    } catch {
                        // Ignore errors in onError hooks to prevent infinite loops
                    }
                }

                if (this.options.strictMode) {
                    throw pluginError;
                }
                console.warn(
                    `Plugin '${plugin.name}' hook '${hookName}' failed: ${pluginError.message}`,
                    pluginError.originalError ?? ''
                );
            }
        }
    }
    
    private async executeHookWithTimeout(
        plugin: Plugin, 
        hookName: string, 
        context: PluginContext
    ): Promise<void> {
        const hookFn = plugin[hookName as keyof Plugin] as Function;
        if (!hookFn) return;
        
        const timeout = plugin.systemOptions?.timeout ?? this.options.defaultTimeout!;
        const abortController = new AbortController();
        
        let timer: NodeJS.Timeout | undefined;
        
        try {
            return await new Promise<void>((resolve, reject) => {
                timer = setTimeout(() => {
                    abortController.abort();
                    reject(new PluginTimeoutError(plugin.name, hookName, timeout));
                }, timeout);
                timer.unref?.();

                context.abortSignal = abortController.signal;

                try {
                    const result = Promise.resolve(
                        hookFn.call(plugin, context)
                    );
                    
                    result
                        .then(() => {
                            if (timer) clearTimeout(timer);
                            resolve();
                        })
                        .catch((error) => {
                            if (timer) clearTimeout(timer);
                            // Wrap plugin errors for better context
                            if (error instanceof PluginTimeoutError) {
                                reject(error);
                            } else {
                                reject(new PluginError(
                                    `Plugin '${plugin.name}' hook '${hookName}' failed: ${error.message}`,
                                    plugin.name,
                                    hookName,
                                    error
                                ));
                            }
                        });
                } catch (error) {
                    // Handle synchronous errors in hook function
                    if (timer) clearTimeout(timer);
                    reject(new PluginError(
                        `Plugin '${plugin.name}' hook '${hookName}' threw synchronous error: ${(error as Error).message}`,
                        plugin.name,
                        hookName,
                        error as Error
                    ));
                }
            });
        } finally {
            if (timer) clearTimeout(timer);
            delete context.abortSignal;
        }
    }
    
    async executeHook(hookName: string, context: PluginContext): Promise<void> {
        const plugins = this.hooks.get(hookName) || [];
        
        for (const plugin of plugins) {
            try {
                await this.executeHookWithTimeout(plugin, hookName, context);
            } catch (error) {
                const pluginError = error instanceof PluginError 
                    ? error
                    : new PluginError(
                        `Plugin '${plugin.name}' hook '${hookName}' failed: ${(error as Error).message}`,
                        plugin.name,
                        hookName,
                        error as Error
                    );
                
                // If there's an error in a hook, try to call onError hooks
                if (hookName !== 'onError') {
                    try {
                        const errorContext = { ...context, error: pluginError };
                        await this.executeHook('onError', errorContext);
                    } catch {
                        // Ignore errors in onError hooks to prevent infinite loops
                    }
                }
                
                // Re-throw the error to maintain normal error flow
                throw pluginError;
            }
        }
    }
    
    async executeHookSafe(hookName: string, context: PluginContext): Promise<void> {
        try {
            await this.executeHook(hookName, context);
        } catch (error) {
            if (this.options.strictMode) {
                // In strict mode, throw PluginErrors
                throw error;
            } else {
                // Enhanced error logging with timeout-specific handling
                if (error instanceof PluginTimeoutError) {
                    console.warn(
                        `Plugin '${error.pluginName}' hook '${hookName}' timed out after ${error.timeout}ms - ` +
                        'consider increasing timeout or optimizing plugin performance'
                    );
                } else if (error instanceof PluginError) {
                    console.warn(
                        `Plugin '${error.pluginName}' hook '${hookName}' failed: ${error.message}`,
                        error.originalError ? error.originalError : ''
                    );
                } else {
                    console.warn(`Plugin hook '${hookName}' failed:`, error);
                }
            }
        }
    }
    
    setStrictMode(enabled: boolean): void {
        this.options.strictMode = enabled;
    }
    
    setDefaultTimeout(timeout: number): void {
        this.options.defaultTimeout = timeout;
    }
    
    getOptions(): PluginManagerOptions {
        return { ...this.options };
    }
}
