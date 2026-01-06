# Performance Analysis & Optimization Plan

## Baseline Analysis (Post Statement-Cache)

### Current State
- ✅ Prepared statement cache implemented (100 statement LRU)
- ✅ Bulk insert optimized (O(n) → O(1) existence checks)
- ✅ Transaction atomicity fixed
- 📊 Expected performance: findById ~10K ops/sec, bulk ops improved 50-100x

### Hot Path Identification

#### 1. **SQL Query Building (sql-translator.ts)** 🔥 HIGH IMPACT
**Issue**: String concatenation in query building
- `buildSelectQuery`: 130 lines with repeated string concatenation (`sql += ...`)
- `buildWhereClause`: Recursive string building with `parts.join()`
- Every filter creates new string allocations

**Current Pattern**:
```typescript
let sql = `${selectClause} ${fromClause}`;
sql += ` WHERE ${whereClause}`;  // string reallocation
sql += ` ORDER BY ${orderClauses.join(', ')}`;  // more allocations
```

**Optimization**: Use array-based building + single join
```typescript
const parts = [selectClause, fromClause];
if (whereClause) parts.push('WHERE', whereClause);
if (orderClauses) parts.push('ORDER BY', orderClauses.join(', '));
const sql = parts.join(' ');  // single allocation
```

**Expected Gain**: 30-40% reduction in query building time, fewer GC pauses

---

#### 2. **JSON Parsing Hot Path (json-utils.ts)** 🔥 HIGH IMPACT
**Issue**: No caching for frequently accessed documents
- `parseDoc()` called on every query result row
- No memoization for repeated document fetches
- `transformDates()` recursive traversal on every parse

**Current**: Every `findById()`, `where().toArray()` re-parses JSON
**Volume**: ~10K ops/sec × 1KB docs = 10MB/sec parsing

**Optimization**: LRU document cache
```typescript
const docCache = new LRU<string, any>(1000);  // 1000 docs
export function parseDoc(json: string): any {
    const cached = docCache.get(json);
    if (cached) return { ...cached };  // shallow copy
    const parsed = JSON.parse(json, dateReviver);
    docCache.set(json, parsed);
    return parsed;
}
```

**Expected Gain**: 3-5x for repeated document access patterns

---

#### 3. **Query Builder Allocation Churn (query-builder.ts)** 🔥 MEDIUM IMPACT
**Issue**: Deep clone on every fluent method call
- `clone()` called in `.where()`, `.and()`, `.or()`, `.orderBy()`, etc.
- `deepCloneFilters()` recursively clones entire filter tree
- For complex query with 10 operations → 10 deep clones

**Current Pattern**:
```typescript
where(field): FieldBuilder {
    const cloned = this.clone();  // deep clone entire state
    return new FieldBuilder(field, cloned);
}

private deepCloneFilters(filters): Filter[] {
    return filters.map(f => {
        if ('type' in f) return { type: f.type, filters: this.deepCloneFilters(f.filters) };
        return { ...f };
    });
}
```

**Optimization**: Structural sharing or copy-on-write
```typescript
// Option 1: Delay cloning until execution
private isDirty = false;
where(field): FieldBuilder {
    this.isDirty = true;
    return new FieldBuilder(field, this);
}

// Option 2: Shallow clone + mark modified nodes
where(field): FieldBuilder {
    const cloned = Object.create(this);
    cloned.options = { ...this.options, filters: [...this.options.filters] };
    return cloned;
}
```

**Expected Gain**: 50% reduction in query builder overhead

---

#### 4. **Vector Buffer Allocation (sql-translator.ts)** 🔥 LOW-MEDIUM IMPACT
**Issue**: New Float32Array + Buffer on every vector operation
- Lines 204, 244, 1592: `new Float32Array(vector)` for every insert/update/search
- For 1536-dim vectors (OpenAI): 6KB × 1000 ops = 6MB allocations

**Optimization**: Buffer pool
```typescript
class Float32Pool {
    private pool: Map<number, Float32Array[]> = new Map();
    acquire(dim: number): Float32Array {
        const arr = this.pool.get(dim)?.pop() || new Float32Array(dim);
        return arr;
    }
    release(arr: Float32Array) {
        const pool = this.pool.get(arr.length) || [];
        if (pool.length < 10) pool.push(arr);
    }
}
```

**Expected Gain**: 10-15% reduction in GC overhead for vector-heavy workloads

---

#### 5. **Collection Initialization (collection.ts)** 🔥 MEDIUM IMPACT
**Issue**: Migration check on every collection creation
- Lines 47-73: `createTable()` → `runMigrationsAsync()` every time
- For apps with 20 collections: 20 migration checks on startup

**Current**: 
```typescript
constructor(...) {
    this.createTable();  // always calls migration check
}
```

**Optimization**: Global migration registry
```typescript
private static migratedCollections = new Set<string>();

async runMigrationsAsync(): Promise<void> {
    const key = `${this.collectionSchema.name}_v${this.collectionSchema.version}`;
    if (Collection.migratedCollections.has(key)) return;
    // ... run migration
    Collection.migratedCollections.add(key);
}
```

**Expected Gain**: 50-200ms faster app startup for multi-collection apps

---

#### 6. **WHERE Clause Building (sql-translator.ts:527-577)** 🔥 HIGH IMPACT
**Issue**: Recursive filter tree traversal with string concatenation
- `buildWhereClause()` called recursively for nested groups
- `parts.join()` creates new strings at each level
- Complex queries with OR groups → deep recursion

**Optimization**: Flatten filter tree before building
```typescript
private static flattenFilters(filters: Filter[]): Filter[] {
    const result = [];
    for (const f of filters) {
        if ('type' in f && f.filters.length === 1) {
            result.push(...this.flattenFilters(f.filters));  // flatten single-child groups
        } else {
            result.push(f);
        }
    }
    return result;
}
```

**Expected Gain**: 20-30% for complex queries with nested logic

---

## Implementation Priority

### Phase 1: Quick Wins (1-2 hours) 🎯
1. ✅ SQL query building array-based concatenation
2. ✅ JSON document caching (LRU 1000)
3. ✅ Flatten single-child filter groups

**Expected Impact**: 40-50% improvement in query-heavy workloads

### Phase 2: Structural Changes (2-4 hours)
4. Query builder copy-on-write
5. Collection migration caching
6. WHERE clause optimization

**Expected Impact**: 30% improvement in complex queries, faster startup

### Phase 3: Specialized Optimizations (optional)
7. Vector buffer pooling
8. Constrained field extraction caching
9. Driver-specific query hints

**Expected Impact**: 10-15% for specific workloads

---

## Benchmarking Plan

### Before Optimization
```bash
# Run baseline benchmarks
npm run benchmark  # if bun available, else manual
# Expected: findById ~10K ops/sec, bulk insert improved
```

### After Each Phase
```bash
# Re-run benchmarks
# Compare: ops/sec, memory usage, GC pause time
```

### Metrics to Track
- **Throughput**: ops/sec for each operation type
- **Latency**: p50, p95, p99 response times
- **Memory**: allocation rate, GC frequency
- **CPU**: % time in hot functions (JSON.parse, string concat, etc.)

---

## Risk Assessment

### Low Risk ✅
- SQL array building (isolated change)
- JSON cache (behind feature flag possible)
- Migration caching (purely additive)

### Medium Risk ⚠️
- Query builder refactor (extensive testing needed)
- WHERE clause flattening (correctness critical)

### High Risk 🚨
- None identified (all optimizations are additive or isolated)

---

## Next Steps

1. Implement Phase 1 optimizations
2. Run benchmarks and validate improvements
3. Profile with real workload to identify remaining bottlenecks
4. Iterate on Phase 2 if needed
5. Document performance characteristics for users
