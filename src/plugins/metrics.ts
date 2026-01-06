import type { Plugin, PluginContext } from '../plugin-system';

export interface MetricsOptions {
    trackOperations?: boolean;
    trackPerformance?: boolean;
    trackErrors?: boolean;
    resetInterval?: number; // Reset metrics every N milliseconds
}

export interface OperationMetrics {
    count: number;
    totalTime: number;
    avgTime: number;
    minTime: number;
    maxTime: number;
    errors: number;
}

export interface CollectionMetrics {
    inserts: OperationMetrics;
    updates: OperationMetrics;
    deletes: OperationMetrics;
    queries: OperationMetrics;
}

export class MetricsPlugin implements Plugin {
    name = 'metrics';
    version = '1.0.0';
    
    private options: Required<MetricsOptions>;
    private metrics = new Map<string, CollectionMetrics>();
    private operationStartTimes = new Map<string, number>();
    private resetTimer?: ReturnType<typeof setInterval>;
    
    constructor(options: MetricsOptions = {}) {
        this.options = {
            trackOperations: true,
            trackPerformance: true,
            trackErrors: true,
            resetInterval: 0, // 0 = never reset
            ...options
        };
        
        if (this.options.resetInterval > 0) {
            this.resetTimer = setInterval(() => this.resetMetrics(), this.options.resetInterval);
        }
        
        // SECURITY FIX: Register cleanup on process exit to prevent timer leak
        if (typeof process !== 'undefined') {
            const cleanup = () => this.destroy();
            process.once('beforeExit', cleanup);
            process.once('exit', cleanup);
        }
    }
    
    /**
     * Destroy the plugin and cleanup resources
     */
    destroy(): void {
        if (this.resetTimer) {
            clearInterval(this.resetTimer);
            this.resetTimer = undefined;
        }
        this.resetMetrics();
    }
    
    private getCollectionMetrics(collectionName: string): CollectionMetrics {
        if (!this.metrics.has(collectionName)) {
            this.metrics.set(collectionName, {
                inserts: this.createOperationMetrics(),
                updates: this.createOperationMetrics(),
                deletes: this.createOperationMetrics(),
                queries: this.createOperationMetrics()
            });
        }
        return this.metrics.get(collectionName)!;
    }
    
    private createOperationMetrics(): OperationMetrics {
        return {
            count: 0,
            totalTime: 0,
            avgTime: 0,
            minTime: Infinity,
            maxTime: 0,
            errors: 0
        };
    }
    
    private updateOperationMetrics(metrics: OperationMetrics, duration?: number): void {
        metrics.count++;
        
        if (duration !== undefined && this.options.trackPerformance) {
            metrics.totalTime += duration;
            metrics.avgTime = metrics.totalTime / metrics.count;
            metrics.minTime = Math.min(metrics.minTime, duration);
            metrics.maxTime = Math.max(metrics.maxTime, duration);
        }
    }
    
    private getOperationKey(context: PluginContext): string {
        return `${context.collectionName}:${context.operation}:${Date.now()}:${Math.random()}`;
    }
    
    private getOperationType(operation: string): keyof CollectionMetrics {
        if (operation.includes('insert') || operation.includes('put') || operation.includes('upsert')) {
            return 'inserts';
        }
        if (operation.includes('update')) {
            return 'updates';
        }
        if (operation.includes('delete')) {
            return 'deletes';
        }
        return 'queries';
    }
    
    async onBeforeInsert(context: PluginContext): Promise<void> {
        if (this.options.trackPerformance) {
            const key = this.getOperationKey(context);
            this.operationStartTimes.set(key, performance.now());
            context.data = { ...context.data, _metricsKey: key };
        }
    }
    
    async onAfterInsert(context: PluginContext): Promise<void> {
        if (this.options.trackOperations) {
            const metrics = this.getCollectionMetrics(context.collectionName);
            let duration: number | undefined;
            
            if (this.options.trackPerformance && context.data?._metricsKey) {
                const startTime = this.operationStartTimes.get(context.data._metricsKey);
                if (startTime) {
                    duration = performance.now() - startTime;
                    this.operationStartTimes.delete(context.data._metricsKey);
                }
            }
            
            this.updateOperationMetrics(metrics.inserts, duration);
        }
    }
    
    async onBeforeUpdate(context: PluginContext): Promise<void> {
        if (this.options.trackPerformance) {
            const key = this.getOperationKey(context);
            this.operationStartTimes.set(key, performance.now());
            context.data = { ...context.data, _metricsKey: key };
        }
    }
    
    async onAfterUpdate(context: PluginContext): Promise<void> {
        if (this.options.trackOperations) {
            const metrics = this.getCollectionMetrics(context.collectionName);
            let duration: number | undefined;
            
            if (this.options.trackPerformance && context.data?._metricsKey) {
                const startTime = this.operationStartTimes.get(context.data._metricsKey);
                if (startTime) {
                    duration = performance.now() - startTime;
                    this.operationStartTimes.delete(context.data._metricsKey);
                }
            }
            
            this.updateOperationMetrics(metrics.updates, duration);
        }
    }
    
    async onBeforeDelete(context: PluginContext): Promise<void> {
        if (this.options.trackPerformance) {
            const key = this.getOperationKey(context);
            this.operationStartTimes.set(key, performance.now());
            context.data = { ...context.data, _metricsKey: key };
        }
    }
    
    async onAfterDelete(context: PluginContext): Promise<void> {
        if (this.options.trackOperations) {
            const metrics = this.getCollectionMetrics(context.collectionName);
            let duration: number | undefined;
            
            if (this.options.trackPerformance && context.data?._metricsKey) {
                const startTime = this.operationStartTimes.get(context.data._metricsKey);
                if (startTime) {
                    duration = performance.now() - startTime;
                    this.operationStartTimes.delete(context.data._metricsKey);
                }
            }
            
            this.updateOperationMetrics(metrics.deletes, duration);
        }
    }
    
    async onBeforeQuery(context: PluginContext): Promise<void> {
        if (this.options.trackPerformance) {
            const key = this.getOperationKey(context);
            this.operationStartTimes.set(key, performance.now());
            context.data = { ...context.data, _metricsKey: key };
        }
    }
    
    async onAfterQuery(context: PluginContext): Promise<void> {
        if (this.options.trackOperations) {
            const metrics = this.getCollectionMetrics(context.collectionName);
            let duration: number | undefined;
            
            if (this.options.trackPerformance && context.data?._metricsKey) {
                const startTime = this.operationStartTimes.get(context.data._metricsKey);
                if (startTime) {
                    duration = performance.now() - startTime;
                    this.operationStartTimes.delete(context.data._metricsKey);
                }
            }
            
            this.updateOperationMetrics(metrics.queries, duration);
        }
    }
    
    async onError(context: PluginContext): Promise<void> {
        if (this.options.trackErrors) {
            const metrics = this.getCollectionMetrics(context.collectionName);
            const operationType = this.getOperationType(context.operation);
            metrics[operationType].errors++;
        }
    }
    
    // Public methods for accessing metrics
    getMetrics(collectionName?: string): Map<string, CollectionMetrics> | CollectionMetrics | undefined {
        if (collectionName) {
            return this.metrics.get(collectionName);
        }
        return this.metrics;
    }
    
    getSummary(): { totalOperations: number; totalErrors: number; collections: string[] } {
        let totalOperations = 0;
        let totalErrors = 0;
        
        for (const [collectionName, metrics] of this.metrics.entries()) {
            totalOperations += metrics.inserts.count + metrics.updates.count + 
                            metrics.deletes.count + metrics.queries.count;
            totalErrors += metrics.inserts.errors + metrics.updates.errors + 
                         metrics.deletes.errors + metrics.queries.errors;
        }
        
        return {
            totalOperations,
            totalErrors,
            collections: Array.from(this.metrics.keys())
        };
    }
    
    resetMetrics(): void {
        this.metrics.clear();
        this.operationStartTimes.clear();
    }
    
    resetCollection(collectionName: string): void {
        this.metrics.delete(collectionName);
    }
}