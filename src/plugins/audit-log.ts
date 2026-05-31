import type { Plugin, PluginContext } from '../plugin-system';

export interface AuditLogOptions {
    logInserts?: boolean;
    logUpdates?: boolean;
    logDeletes?: boolean;
    logQueries?: boolean;
    logLevel?: 'debug' | 'info' | 'warn' | 'error';
    customLogger?: (level: string, message: string, context: PluginContext) => void;
}

export class AuditLogPlugin implements Plugin {
    name = 'audit-log';
    version = '1.0.0';
    
    private options: Required<AuditLogOptions>;
    
    constructor(options: AuditLogOptions = {}) {
        this.options = {
            logInserts: true,
            logUpdates: true,
            logDeletes: true,
            logQueries: false,
            logLevel: 'info',
            ...options,
            customLogger: options.customLogger ?? this.defaultLogger.bind(this),
        };
    }
    
    private defaultLogger(level: string, message: string, context: PluginContext): void {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [${level.toUpperCase()}] [${this.name}] ${message}`);
        if (context.data || context.result) {
            console.log('  Context:', {
                collection: context.collectionName,
                operation: context.operation,
                dataKeys: context.data ? Object.keys(context.data) : undefined,
                resultKeys: context.result ? Object.keys(context.result) : undefined
            });
        }
    }
    
    async onAfterInsert(context: PluginContext): Promise<void> {
        if (this.options.logInserts) {
            const id = context.result?._id ?? context.result?.id ?? 'unknown';
            this.options.customLogger(
                this.options.logLevel,
                `Document inserted: ${context.collectionName}:${id}`,
                context
            );
        }
    }
    
    async onAfterUpdate(context: PluginContext): Promise<void> {
        if (this.options.logUpdates) {
            const id = context.result?._id ?? context.result?.id ?? context.data?._id ?? context.data?.id ?? 'unknown';
            this.options.customLogger(
                this.options.logLevel,
                `Document updated: ${context.collectionName}:${id}`,
                context
            );
        }
    }
    
    async onAfterDelete(context: PluginContext): Promise<void> {
        if (this.options.logDeletes) {
            const id = context.data?._id ?? context.data?.id ?? 'unknown';
            this.options.customLogger(
                this.options.logLevel,
                `Document deleted: ${context.collectionName}:${id}`,
                context
            );
        }
    }
    
    async onAfterQuery(context: PluginContext): Promise<void> {
        if (this.options.logQueries) {
            const resultCount = Array.isArray(context.result) ? context.result.length : 1;
            this.options.customLogger(
                this.options.logLevel,
                `Query executed: ${context.collectionName} (${resultCount} results)`,
                context
            );
        }
    }
    
    async onError(context: PluginContext): Promise<void> {
        this.options.customLogger(
            'error',
            `Operation failed: ${context.collectionName}:${context.operation} - ${context.error?.message}`,
            context
        );
    }
}