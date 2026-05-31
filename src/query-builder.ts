import type { 
    QueryFilter, 
    QueryOptions, 
    QueryGroup, 
    AggregateField, 
    JoinClause, 
    JoinCondition,
    SubqueryFilter,
    QueryCollectionAdapter,
} from './types';
import type { 
    QueryablePaths, 
    OrderablePaths, 
    NestedValue, 
    SafeNestedPaths 
} from './types/nested-paths';
import { validateFieldPath } from './sql-utils';
import { buildExplainResult, type ExplainResult } from './diagnostics';

type FilterTarget = 'where' | 'having';

export class FieldBuilder<T, K extends QueryablePaths<T> | string> {
    constructor(
        protected field: K,
        protected builder: QueryBuilder<T>,
        protected readonly target: FilterTarget = 'where'
    ) {}

    protected addFilterAndReturn(
        operator: any,
        value: any,
        value2?: any
    ): QueryBuilder<T> {
        if (this.target === 'having') {
            return this.builder.addHavingFilter(
                this.field as string,
                operator,
                value,
                value2
            );
        }
        return this.builder.addFilter(
            this.field as string,
            operator,
            value,
            value2
        );
    }

    eq(value: any): QueryBuilder<T> {
        return this.addFilterAndReturn('eq', value);
    }

    neq(value: any): QueryBuilder<T> {
        return this.addFilterAndReturn('neq', value);
    }

    gt(value: any): QueryBuilder<T> {
        return this.addFilterAndReturn('gt', value);
    }

    gte(value: any): QueryBuilder<T> {
        return this.addFilterAndReturn('gte', value);
    }

    lt(value: any): QueryBuilder<T> {
        return this.addFilterAndReturn('lt', value);
    }

    lte(value: any): QueryBuilder<T> {
        return this.addFilterAndReturn('lte', value);
    }

    between(min: any, max: any): QueryBuilder<T> {
        return this.addFilterAndReturn('between', min, max);
    }

    in(values: any[]): QueryBuilder<T> {
        return this.addFilterAndReturn('in', values);
    }

    nin(values: any[]): QueryBuilder<T> {
        return this.addFilterAndReturn('nin', values);
    }

    like(pattern: string): QueryBuilder<T> {
        return this.addFilterAndReturn('like', pattern);
    }

    ilike(pattern: string): QueryBuilder<T> {
        return this.addFilterAndReturn('ilike', pattern);
    }

    startsWith(prefix: string): QueryBuilder<T> {
        return this.addFilterAndReturn('startswith', prefix);
    }

    endsWith(suffix: string): QueryBuilder<T> {
        return this.addFilterAndReturn('endswith', suffix);
    }

    contains(substring: string): QueryBuilder<T> {
        return this.addFilterAndReturn('contains', substring);
    }

    exists(): QueryBuilder<T> {
        return this.addFilterAndReturn('exists', true);
    }

    notExists(): QueryBuilder<T> {
        return this.addFilterAndReturn('exists', false);
    }

    existsSubquery(subqueryBuilder: QueryBuilder<any>, collection: string): QueryBuilder<T> {
        return this.builder.addSubqueryFilter(this.field as string, 'exists', subqueryBuilder, collection);
    }

    notExistsSubquery(subqueryBuilder: QueryBuilder<any>, collection: string): QueryBuilder<T> {
        return this.builder.addSubqueryFilter(this.field as string, 'not_exists', subqueryBuilder, collection);
    }

    inSubquery(subqueryBuilder: QueryBuilder<any>, collection: string): QueryBuilder<T> {
        return this.builder.addSubqueryFilter(this.field as string, 'in', subqueryBuilder, collection);
    }

    notInSubquery(subqueryBuilder: QueryBuilder<any>, collection: string): QueryBuilder<T> {
        return this.builder.addSubqueryFilter(this.field as string, 'not_in', subqueryBuilder, collection);
    }

    arrayLength(operator: 'eq' | 'gt' | 'gte' | 'lt' | 'lte', value: number): QueryBuilder<T> {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
            throw new Error('Array length value must be a non-negative integer');
        }
        return this.builder.addJsonArrayLengthFilter(this.field as string, operator, value);
    }

    arrayContains(value: any): QueryBuilder<T> {
        return this.builder.addJsonArrayContainsFilter(this.field as string, value);
    }

    arrayNotContains(value: any): QueryBuilder<T> {
        return this.builder.addJsonArrayNotContainsFilter(this.field as string, value);
    }

    // Execution stubs — throw helpful errors since a comparison operator must be called first
    toArray(): Promise<T[]> {
        throw new Error('toArray() should not be called on FieldBuilder. Use a comparison operator first.');
    }

    exec(): Promise<T[]> {
        throw new Error('exec() should not be called on FieldBuilder. Use a comparison operator first.');
    }

    first(): Promise<T | null> {
        throw new Error('first() should not be called on FieldBuilder. Use a comparison operator first.');
    }

    executeCount(): Promise<number> {
        throw new Error('executeCount() should not be called on FieldBuilder. Use a comparison operator first.');
    }

    toArraySync(): T[] {
        throw new Error('toArraySync() should not be called on FieldBuilder. Use a comparison operator first.');
    }

    firstSync(): T | null {
        throw new Error('firstSync() should not be called on FieldBuilder. Use a comparison operator first.');
    }

    countSync(): number {
        throw new Error('countSync() should not be called on FieldBuilder. Use a comparison operator first.');
    }
}

export class QueryBuilder<T> {
    private options: QueryOptions = { filters: [] };
    private collection?: QueryCollectionAdapter<T>;

    constructor(collection?: QueryCollectionAdapter<T>) {
        this.collection = collection;
    }

    where<K extends QueryablePaths<T>>(field: K): FieldBuilder<T, K>;
    where(field: string): FieldBuilder<T, any>;
    where<K extends QueryablePaths<T>>(field: K | string): FieldBuilder<T, K> {
        return new FieldBuilder(field as K, this, 'where');
    }

    addFilter(
        field: string,
        operator: QueryFilter['operator'],
        value: any,
        value2?: any
    ): QueryBuilder<T> {
        this.options.filters.push({ field, operator, value, value2 });
        return this;
    }

    addSubqueryFilter(
        field: string,
        operator: 'exists' | 'not_exists' | 'in' | 'not_in',
        subqueryBuilder: QueryBuilder<any>,
        collection: string
    ): QueryBuilder<T> {
        const subqueryFilter: SubqueryFilter = {
            field,
            operator,
            subquery: subqueryBuilder.getOptions(),
            subqueryCollection: collection
        };
        this.options.filters.push(subqueryFilter);
        return this;
    }

    addJsonArrayLengthFilter(field: string, operator: string, value: number): QueryBuilder<T> {
        validateFieldPath(field);
        this.options.filters.push({ 
            field: `json_array_length(${field})`, 
            operator: operator as any, 
            value 
        });
        return this;
    }

    addJsonArrayContainsFilter(field: string, value: any): QueryBuilder<T> {
        validateFieldPath(field);
        this.options.filters.push({ 
            field: field, 
            operator: 'json_array_contains' as any, 
            value 
        });
        return this;
    }

    addJsonArrayNotContainsFilter(field: string, value: any): QueryBuilder<T> {
        validateFieldPath(field);
        this.options.filters.push({ 
            field: field, 
            operator: 'json_array_not_contains' as any, 
            value 
        });
        return this;
    }

    and(): QueryBuilder<T> {
        return this;
    }

    or(
        builderFn: (builder: QueryBuilder<T>) => QueryBuilder<T>
    ): QueryBuilder<T> {
        const currentFilters = this.deepCloneFilters(this.options.filters);

        const orBuilder = new QueryBuilder<T>();
        const result = builderFn(orBuilder);
        const orConditions = this.deepCloneFilters(result.getOptions().filters);

        if (currentFilters.length > 0 && orConditions.length > 0) {
            const leftGroup: QueryGroup = {
                type: 'and',
                filters: currentFilters,
            };
            
            const rightGroup: QueryGroup = {
                type: 'and', 
                filters: orConditions,
            };
            
            const orGroup: QueryGroup = {
                type: 'or',
                filters: [leftGroup, rightGroup],
            };

            this.options.filters = [orGroup];
        } else if (orConditions.length > 0) {
            this.options.filters = [
                {
                    type: 'or',
                    filters: orConditions,
                },
            ];
        }

        return this;
    }

    orWhere(
        conditions: Array<(builder: QueryBuilder<T>) => QueryBuilder<T>>
    ): QueryBuilder<T> {
        if (conditions.length === 0) return this;

        const currentFilters = this.deepCloneFilters(this.options.filters);
        const orGroups: QueryGroup[] = [];

        for (const condition of conditions) {
            const tempBuilder = new QueryBuilder<T>();
            const result = condition(tempBuilder);
            const conditionFilters = this.deepCloneFilters(result.getOptions().filters);
            
            if (conditionFilters.length > 0) {
                orGroups.push({
                    type: 'and',
                    filters: conditionFilters,
                });
            }
        }

        if (orGroups.length > 0) {
            if (currentFilters.length > 0) {
                const currentGroup: QueryGroup = {
                    type: 'and',
                    filters: currentFilters,
                };
                
                const orGroup: QueryGroup = {
                    type: 'or',
                    filters: [currentGroup].concat(orGroups),
                };
                
                this.options.filters = [orGroup];
            } else {
                const orGroup: QueryGroup = {
                    type: 'or',
                    filters: orGroups,
                };
                this.options.filters = [orGroup];
            }
        }

        return this;
    }

    orderBy<K extends OrderablePaths<T>>(
        field: K,
        direction?: 'asc' | 'desc'
    ): QueryBuilder<T>;
    orderBy(
        field: string,
        direction?: 'asc' | 'desc'
    ): QueryBuilder<T>;
    orderBy<K extends OrderablePaths<T>>(
        field: K | string,
        direction: 'asc' | 'desc' = 'asc'
    ): QueryBuilder<T> {
        if (!this.options.orderBy) this.options.orderBy = [];
        this.options.orderBy.push({ field: field as string, direction });
        return this;
    }

    orderByBatch(
        fields: Array<{ field: OrderablePaths<T> | string; direction?: 'asc' | 'desc' }>
    ): QueryBuilder<T> {
        this.options.orderBy = fields.map((f) => ({
            field: f.field as string,
            direction: f.direction || 'asc',
        }));
        return this;
    }

    orderByOnly<K extends OrderablePaths<T>>(
        field: K,
        direction?: 'asc' | 'desc'
    ): QueryBuilder<T>;
    orderByOnly(
        field: string,
        direction?: 'asc' | 'desc'
    ): QueryBuilder<T>;
    orderByOnly<K extends OrderablePaths<T>>(
        field: K | string,
        direction: 'asc' | 'desc' = 'asc'
    ): QueryBuilder<T> {
        this.options.orderBy = [{ field: field as string, direction }];
        return this;
    }

    /** @deprecated Use orderByBatch instead */
    orderByMultiple(
        orders: { field: OrderablePaths<T> | string; direction?: 'asc' | 'desc' }[]
    ): QueryBuilder<T> {
        return this.orderByBatch(orders);
    }

    limit(count: number): QueryBuilder<T> {
        if (count < 0) throw new Error('Limit must be non-negative');
        if (!Number.isInteger(count)) throw new Error('Limit must be an integer');
        if (count > Number.MAX_SAFE_INTEGER) throw new Error('Limit too large');
        this.options.limit = count;
        return this;
    }

    offset(count: number): QueryBuilder<T> {
        if (count < 0) throw new Error('Offset must be non-negative');
        if (!Number.isInteger(count)) throw new Error('Offset must be an integer');
        if (count > Number.MAX_SAFE_INTEGER) throw new Error('Offset too large');
        this.options.offset = count;
        return this;
    }

    page(pageNumber: number, pageSize: number): QueryBuilder<T> {
        if (pageNumber < 1) throw new Error('Page number must be >= 1');
        if (!Number.isInteger(pageNumber)) throw new Error('Page number must be an integer');
        if (pageNumber > Number.MAX_SAFE_INTEGER) throw new Error('Page number too large');
        if (pageSize < 1) throw new Error('Page size must be >= 1');
        if (!Number.isInteger(pageSize)) throw new Error('Page size must be an integer');
        if (pageSize > Number.MAX_SAFE_INTEGER) throw new Error('Page size too large');

        // Check for potential overflow BEFORE multiplication
        if ((pageNumber - 1) > Number.MAX_SAFE_INTEGER / pageSize) {
            throw new Error('Page calculation results in offset too large');
        }
        
        this.options.limit = pageSize;
        this.options.offset = (pageNumber - 1) * pageSize;
        return this;
    }

    groupBy<K extends OrderablePaths<T>>(...fields: K[]): QueryBuilder<T> {
        this.options.groupBy = fields.map((f) => f as string);
        return this;
    }

    distinct(): QueryBuilder<T> {
        this.options.distinct = true;
        return this;
    }

    select(...fields: string[]): QueryBuilder<T> {
        for (const field of fields) {
            validateFieldPath(field);
        }
        this.options.selectFields = fields;
        return this;
    }

    aggregate(fn: 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX', field: string = '*', alias?: string, distinct?: boolean): QueryBuilder<T> {
        if (!this.options.aggregates) this.options.aggregates = [];
        this.options.aggregates.push({ function: fn, field, alias, distinct });
        return this;
    }

    count(): Promise<number>;
    count(field: string, alias?: string, distinct?: boolean): QueryBuilder<T>;
    count(
        field?: string,
        alias?: string,
        distinct?: boolean
    ): QueryBuilder<T> | Promise<number> {
        if (field === undefined) {
            return this.executeCount();
        }
        return this.aggregateCount(field, alias, distinct);
    }

    aggregateCount(
        field: string = '*',
        alias?: string,
        distinct?: boolean
    ): QueryBuilder<T> {
        return this.aggregate('COUNT', field, alias, distinct);
    }

    sum(field: string, alias?: string, distinct?: boolean): QueryBuilder<T> {
        return this.aggregate('SUM', field, alias, distinct);
    }

    avg(field: string, alias?: string, distinct?: boolean): QueryBuilder<T> {
        return this.aggregate('AVG', field, alias, distinct);
    }

    min(field: string, alias?: string): QueryBuilder<T> {
        return this.aggregate('MIN', field, alias);
    }

    max(field: string, alias?: string): QueryBuilder<T> {
        return this.aggregate('MAX', field, alias);
    }

    having<K extends QueryablePaths<T>>(field: K): FieldBuilder<T, K>;
    having(field: string): FieldBuilder<T, any>;
    having<K extends QueryablePaths<T>>(field: K | string): FieldBuilder<T, K> {
        return new FieldBuilder(field as K, this, 'having');
    }

    addHavingFilter(
        field: string,
        operator: QueryFilter['operator'],
        value: any,
        value2?: any
    ): QueryBuilder<T> {
        if (!this.options.having) this.options.having = [];
        this.options.having.push({ field, operator, value, value2 });
        return this;
    }

    private addJoin<U = any>(
        type: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL',
        collection: string,
        leftField: string,
        rightField: string,
        operator: '=' | '!=' | '>' | '<' | '>=' | '<=' = '='
    ): QueryBuilder<T & U> {
        if (!this.options.joins) this.options.joins = [];
        this.options.joins.push({ type, collection, condition: { left: leftField, right: rightField, operator } });
        return this as any;
    }

    join<U = any>(
        collection: string,
        leftField: string,
        rightField: string,
        operator: '=' | '!=' | '>' | '<' | '>=' | '<=' = '='
    ): QueryBuilder<T & U> {
        return this.addJoin('INNER', collection, leftField, rightField, operator);
    }

    leftJoin<U = any>(
        collection: string,
        leftField: string,
        rightField: string,
        operator: '=' | '!=' | '>' | '<' | '>=' | '<=' = '='
    ): QueryBuilder<T & U> {
        return this.addJoin('LEFT', collection, leftField, rightField, operator);
    }

    rightJoin<U = any>(
        collection: string,
        leftField: string,
        rightField: string,
        operator: '=' | '!=' | '>' | '<' | '>=' | '<=' = '='
    ): QueryBuilder<T & U> {
        return this.addJoin('RIGHT', collection, leftField, rightField, operator);
    }

    fullJoin<U = any>(
        collection: string,
        leftField: string,
        rightField: string,
        operator: '=' | '!=' | '>' | '<' | '>=' | '<=' = '='
    ): QueryBuilder<T & U> {
        return this.addJoin('FULL', collection, leftField, rightField, operator);
    }

    clearFilters(): QueryBuilder<T> {
        this.options.filters = [];
        return this;
    }

    clearOrder(): QueryBuilder<T> {
        this.options.orderBy = undefined;
        return this;
    }

    clearLimit(): QueryBuilder<T> {
        this.options.limit = undefined;
        this.options.offset = undefined;
        return this;
    }

    reset(): QueryBuilder<T> {
        this.options = { filters: [] };
        return this;
    }

    getFilterCount(): number {
        return this.options.filters.length;
    }

    optimizeFilters(): QueryBuilder<T> {
        this.options.filters = this.removeRedundantFilters(this.options.filters);
        return this;
    }

    private removeRedundantFilters(filters: (QueryFilter | QueryGroup | SubqueryFilter)[]): (QueryFilter | QueryGroup | SubqueryFilter)[] {
        const optimized: (QueryFilter | QueryGroup | SubqueryFilter)[] = [];
        const fieldMap = new Map<string, QueryFilter[]>();

        for (const filter of filters) {
            if ('type' in filter) {
                optimized.push({
                    type: filter.type,
                    filters: this.removeRedundantFilters(filter.filters)
                });
            } else if ('subquery' in filter) {
                optimized.push(filter);
            } else {
                const field = filter.field;
                if (!fieldMap.has(field)) {
                    fieldMap.set(field, []);
                }
                fieldMap.get(field)!.push(filter);
            }
        }

        for (const [field, fieldFilters] of fieldMap) {
            const optimizedFieldFilters = this.optimizeFieldFilters(fieldFilters);
            for (let i = 0; i < optimizedFieldFilters.length; i++) {
                optimized.push(optimizedFieldFilters[i]);
            }
        }

        return optimized;
    }

    private optimizeFieldFilters(filters: QueryFilter[]): QueryFilter[] {
        if (filters.length <= 1) return filters;

        const gtFilters = filters.filter(f => f.operator === 'gt');
        const gteFilters = filters.filter(f => f.operator === 'gte');
        const ltFilters = filters.filter(f => f.operator === 'lt');
        const lteFilters = filters.filter(f => f.operator === 'lte');
        const otherFilters = filters.filter(f => !['gt', 'gte', 'lt', 'lte'].includes(f.operator));

        const optimized: QueryFilter[] = [];

        if (gtFilters.length > 1) {
            const maxGt = gtFilters.reduce((max, curr) => 
                Number(curr.value) > Number(max.value) ? curr : max
            );
            optimized.push(maxGt);
        } else if (gtFilters.length === 1) {
            optimized.push(gtFilters[0]);
        }

        if (gteFilters.length > 1) {
            const maxGte = gteFilters.reduce((max, curr) => 
                Number(curr.value) > Number(max.value) ? curr : max
            );
            optimized.push(maxGte);
        } else if (gteFilters.length === 1) {
            optimized.push(gteFilters[0]);
        }

        if (ltFilters.length > 1) {
            const minLt = ltFilters.reduce((min, curr) => 
                Number(curr.value) < Number(min.value) ? curr : min
            );
            optimized.push(minLt);
        } else if (ltFilters.length === 1) {
            optimized.push(ltFilters[0]);
        }

        if (lteFilters.length > 1) {
            const minLte = lteFilters.reduce((min, curr) => 
                Number(curr.value) < Number(min.value) ? curr : min
            );
            optimized.push(minLte);
        } else if (lteFilters.length === 1) {
            optimized.push(lteFilters[0]);
        }

        const hasGt = optimized.find(f => f.operator === 'gt');
        const hasGte = optimized.find(f => f.operator === 'gte');
        const hasLt = optimized.find(f => f.operator === 'lt');
        const hasLte = optimized.find(f => f.operator === 'lte');

        if (hasGt && hasGte && Number(hasGt.value) >= Number(hasGte.value)) {
            const gteIndex = optimized.findIndex(f => f === hasGte);
            optimized.splice(gteIndex, 1);
        }
        if (hasLt && hasLte && Number(hasLt.value) <= Number(hasLte.value)) {
            const lteIndex = optimized.findIndex(f => f === hasLte);
            optimized.splice(lteIndex, 1);
        }

        for (let i = 0; i < otherFilters.length; i++) {
            optimized.push(otherFilters[i]);
        }

        return optimized;
    }

    hasFilters(): boolean {
        return this.options.filters.length > 0;
    }

    hasOrdering(): boolean {
        return !!this.options.orderBy && this.options.orderBy.length > 0;
    }

    hasPagination(): boolean {
        return (
            this.options.limit !== undefined ||
            this.options.offset !== undefined
        );
    }

    clone(): QueryBuilder<T> {
        const cloned = new QueryBuilder<T>(this.collection);

        cloned.options = {
            filters: this.shallowCloneFilters(this.options.filters),
            orderBy: this.options.orderBy
                ? this.options.orderBy.map((o) => ({ ...o }))
                : undefined,
            limit: this.options.limit,
            offset: this.options.offset,
            groupBy: this.options.groupBy
                ? [...this.options.groupBy]
                : undefined,
            having: this.options.having
                ? this.shallowCloneFilters(this.options.having)
                : undefined,
            distinct: this.options.distinct,
            aggregates: this.options.aggregates
                ? this.options.aggregates.map((a) => ({ ...a }))
                : undefined,
            joins: this.options.joins
                ? this.options.joins.map((j) => ({
                      ...j,
                      condition: { ...j.condition },
                  }))
                : undefined,
            selectFields: this.options.selectFields
                ? [...this.options.selectFields]
                : undefined,
        };
        return cloned;
    }
    
    getOptions(): QueryOptions {
        return this.options;
    }

    private shallowCloneFilters(filters: (QueryFilter | QueryGroup | SubqueryFilter)[]): (QueryFilter | QueryGroup | SubqueryFilter)[] {
        if (filters.length === 0) return [];
        
        const result: (QueryFilter | QueryGroup | SubqueryFilter)[] = new Array(filters.length);
        for (let i = 0; i < filters.length; i++) {
            const filter = filters[i];
            if ('type' in filter) {
                result[i] = {
                    type: filter.type,
                    filters: this.shallowCloneFilters(filter.filters)
                };
            } else {
                result[i] = filter;
            }
        }
        return result;
    }

    private deepCloneFilters(filters: (QueryFilter | QueryGroup | SubqueryFilter)[]): (QueryFilter | QueryGroup | SubqueryFilter)[] {
        const result: (QueryFilter | QueryGroup | SubqueryFilter)[] = new Array(filters.length);
        for (let i = 0; i < filters.length; i++) {
            const filter = filters[i];
            if ('type' in filter) {
                result[i] = {
                    type: filter.type,
                    filters: this.deepCloneFilters(filter.filters)
                };
            } else if ('subquery' in filter) {
                result[i] = {
                    field: filter.field,
                    operator: filter.operator,
                    subquery: {
                        filters: this.deepCloneFilters(filter.subquery.filters),
                        orderBy: filter.subquery.orderBy,
                        limit: filter.subquery.limit,
                        offset: filter.subquery.offset,
                        groupBy: filter.subquery.groupBy,
                        having: filter.subquery.having,
                        distinct: filter.subquery.distinct,
                        aggregates: filter.subquery.aggregates,
                        joins: filter.subquery.joins,
                        selectFields: filter.subquery.selectFields,
                    },
                    subqueryCollection: filter.subqueryCollection
                };
            } else {
                result[i] = {
                    field: filter.field,
                    operator: filter.operator,
                    value: filter.value,
                    value2: filter.value2
                };
            }
        }
        return result;
    }

    // ── Execution methods (delegate to collection adapter) ──

    async toArray(): Promise<T[]> {
        if (!this.collection) {
            throw new Error('Collection not bound to query builder');
        }
        return this.collection.executeQuery(this.options);
    }

    async all(): Promise<T[]> {
        return this.toArray();
    }

    async exec(): Promise<T[]> {
        return this.toArray();
    }

    async *iterator(): AsyncIterableIterator<T> {
        if (!this.collection) {
            throw new Error('Collection not bound to query builder');
        }
        yield* this.collection.executeQueryIterator(this.options);
    }

    async first(): Promise<T | null> {
        const results = await this.limit(1).toArray();
        return results[0] || null;
    }

    async executeCount(): Promise<number> {
        if (!this.collection) {
            throw new Error('Collection not bound to query builder');
        }
        return this.collection.executeCount(this.options);
    }

    async explain(): Promise<ExplainResult> {
        if (!this.collection) {
            throw new Error('Collection not bound to query builder');
        }
        return this.collection.explainQuery(this.options);
    }

    toArraySync(): T[] {
        if (!this.collection) {
            throw new Error('Collection not bound to query builder');
        }
        return this.collection.executeQuerySync(this.options);
    }

    allSync(): T[] {
        return this.toArraySync();
    }

    firstSync(): T | null {
        const results = this.limit(1).toArraySync();
        return results[0] || null;
    }

    countSync(): number {
        if (!this.collection) {
            throw new Error('Collection not bound to query builder');
        }
        return this.collection.executeCountSync(this.options);
    }
}
