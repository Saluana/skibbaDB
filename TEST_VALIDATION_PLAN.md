# Test Validation Plan - Performance Optimizations

## Overview
This document outlines the comprehensive testing strategy for validating all performance optimizations (Phase 1 + Phase 2) and ensuring no regressions were introduced.

---

## Test Environment Requirements

### Runtime
- **Bun**: v1.0+ (primary test runner)
- **Node.js**: v20+ (fallback for some tests)

### Dependencies
All dependencies in package.json should be installed:
```bash
npm install
```

---

## Phase 1 Testing (SQL, JSON, Filters, Migrations)

### 1. SQL Array Building Tests

**What to test**: Verify SQL query generation produces identical output with new array-based building

**Test files**:
- `test/query-builder.test.ts`
- `test/enhanced-query-engine.test.ts`

**Key assertions**:
```typescript
// Verify SELECT query structure
test('buildSelectQuery produces valid SQL', () => {
    const { sql, params } = SQLTranslator.buildSelectQuery(
        'users',
        { filters: [{ field: 'age', operator: 'gt', value: 25 }] }
    );
    expect(sql).toContain('SELECT');
    expect(sql).toContain('FROM users');
    expect(sql).toContain('WHERE');
    expect(params).toHaveLength(1);
});

// Verify complex queries with multiple clauses
test('complex query with all clauses', () => {
    const { sql } = SQLTranslator.buildSelectQuery('users', {
        filters: [...],
        orderBy: [{ field: 'age', direction: 'desc' }],
        limit: 10,
        offset: 20
    });
    expect(sql).toMatch(/SELECT .+ FROM .+ WHERE .+ ORDER BY .+ LIMIT .+ OFFSET .+/);
});
```

**Expected**: All query builder tests pass with no failures

---

### 2. JSON Document Cache Tests

**What to test**: Verify caching works correctly and returns proper copies

**Test files**:
- `test/integration.test.ts`
- `test/database.test.ts`

**Key assertions**:
```typescript
// Test cache hit returns correct data
test('parseDoc cache returns correct values', () => {
    const jsonStr = '{"name":"Alice","age":30}';
    const doc1 = parseDoc(jsonStr);
    const doc2 = parseDoc(jsonStr);  // Should hit cache
    
    expect(doc2).toEqual(doc1);
    expect(doc2).not.toBe(doc1);  // Should be different object (shallow copy)
});

// Test cache isolation
test('parseDoc cache prevents mutation', () => {
    const jsonStr = '{"tags":["a","b"]}';
    const doc1 = parseDoc(jsonStr);
    doc1.tags.push('c');
    
    const doc2 = parseDoc(jsonStr);  // Should get fresh copy
    expect(doc2.tags).toEqual(['a', 'b']);  // Not affected by mutation
});

// Test repeated document access performance
test('parseDoc cache improves repeated access', () => {
    const jsonStr = '{"data":"large document..."}';
    
    const start1 = performance.now();
    for (let i = 0; i < 1000; i++) {
        parseDoc(jsonStr);
    }
    const time1 = performance.now() - start1;
    
    // Should be significantly faster due to caching
    expect(time1).toBeLessThan(100);  // Adjust threshold based on actual performance
});
```

**Expected**: 
- Cache hits return correct data
- No mutation issues
- Performance improvement visible in repeated access

---

### 3. Filter Flattening Tests

**What to test**: Verify filter tree flattening produces correct SQL

**Test files**:
- `test/query-builder.test.ts`
- `test/or-queries.test.ts`

**Key assertions**:
```typescript
// Single-child groups should be flattened
test('single-child filter groups are flattened', () => {
    const builder = new QueryBuilder()
        .where('age').gt(25)
        .and()  // Creates unnecessary group
        .where('score').gt(500);
    
    const { sql } = builder.toSQL('users');
    
    // Should not have excessive parentheses
    expect(sql).not.toMatch(/\(\(age/);
    expect(sql).toMatch(/age .+ AND score/);
});

// Complex nested queries should still work
test('nested OR queries work correctly', () => {
    const builder = new QueryBuilder()
        .where('status').eq('active')
        .or(q => q.where('age').gt(30).where('verified').eq(true));
    
    const { sql } = builder.toSQL('users');
    expect(sql).toContain('OR');
    // Verify logical correctness
});
```

**Expected**: 
- Flattening produces cleaner SQL
- Logical correctness preserved
- All OR query tests pass

---

### 4. Migration Caching Tests

**What to test**: Verify migrations only run once per collection+version

**Test files**:
- `test/migrations.test.ts`
- `test/database.test.ts`

**Key assertions**:
```typescript
// Migration should only run once
test('migration runs only once per collection', async () => {
    let migrationCount = 0;
    
    const schema = { 
        name: 'users',
        version: 1,
        onUpgrade: () => { migrationCount++; }
    };
    
    const db1 = createDB({ memory: true });
    const collection1 = db1.collection('users', userSchema);
    await collection1.waitForInitialization();
    
    const db2 = createDB({ memory: true });  // Same process
    const collection2 = db2.collection('users', userSchema);
    await collection2.waitForInitialization();
    
    expect(migrationCount).toBe(1);  // Should only run once
});

// Different versions should trigger migration
test('version change triggers migration', async () => {
    let migrationCount = 0;
    
    const schema1 = { name: 'users', version: 1, onUpgrade: () => migrationCount++ };
    const schema2 = { name: 'users', version: 2, onUpgrade: () => migrationCount++ };
    
    const db = createDB({ memory: true });
    const c1 = db.collection('users', schema1);
    await c1.waitForInitialization();
    
    const c2 = db.collection('users', schema2);
    await c2.waitForInitialization();
    
    expect(migrationCount).toBe(2);  // Both versions should run
});
```

**Expected**:
- Migrations cached correctly
- Version changes respected
- Startup time improved

---

## Phase 2 Testing (Query Builder, Vector Pool)

### 5. Query Builder Shallow Copy Tests

**What to test**: Verify shallow copy produces correct results and isolation

**Test files**:
- `test/query-builder.test.ts`
- `test/query-builder-bugs.test.ts`

**Key assertions**:
```typescript
// Test immutability
test('query builder maintains immutability', () => {
    const base = new QueryBuilder<User>()
        .where('age').gt(25);
    
    const extended = base.where('score').gt(500);
    
    expect(base.getOptions().filters).toHaveLength(1);
    expect(extended.getOptions().filters).toHaveLength(2);
});

// Test filter isolation
test('filter modifications dont affect clones', () => {
    const q1 = new QueryBuilder<User>()
        .where('status').eq('active');
    
    const q2 = q1.where('age').gt(30);
    const q3 = q1.where('score').gt(100);
    
    expect(q2.getOptions().filters).toHaveLength(2);
    expect(q3.getOptions().filters).toHaveLength(2);
    expect(q2.getOptions().filters[1]).not.toEqual(q3.getOptions().filters[1]);
});

// Test nested group isolation
test('nested groups maintain isolation', () => {
    const q1 = new QueryBuilder<User>()
        .where('a').eq(1)
        .or(q => q.where('b').eq(2).where('c').eq(3));
    
    const q2 = q1.where('d').eq(4);
    
    // q1 should not be affected
    expect(q1.getOptions().filters).toHaveLength(2);
    expect(q2.getOptions().filters).toHaveLength(3);
});

// Performance test
test('shallow copy reduces allocations', () => {
    const iterations = 1000;
    
    const start = performance.now();
    let builder = new QueryBuilder<User>();
    for (let i = 0; i < iterations; i++) {
        builder = builder.where(`field${i}`).eq(i);
    }
    const time = performance.now() - start;
    
    // Should complete in reasonable time
    expect(time).toBeLessThan(500);  // Adjust based on benchmarks
});
```

**Expected**:
- Immutability preserved
- Filter isolation correct
- Performance improved
- All existing tests pass

---

### 6. Vector Buffer Pool Tests

**What to test**: Verify buffer pooling works correctly and maintains isolation

**Test files**:
- `test/relationships.test.ts` (vector operations)
- New test: `test/vector-pool.test.ts`

**Key assertions**:
```typescript
// Test buffer reuse
test('vector buffer pool reuses buffers', () => {
    const vector1 = [1, 2, 3, 4, 5];
    const vector2 = [6, 7, 8, 9, 10];
    
    const queries1 = SQLTranslator.buildVectorInsertQueries(
        'embeddings',
        { embedding: vector1 },
        'id1',
        { embedding: { type: 'vector', dimensions: 5 } }
    );
    
    const queries2 = SQLTranslator.buildVectorInsertQueries(
        'embeddings',
        { embedding: vector2 },
        'id2',
        { embedding: { type: 'vector', dimensions: 5 } }
    );
    
    expect(queries1).toHaveLength(1);
    expect(queries2).toHaveLength(1);
    // Verify data integrity
});

// Test buffer isolation
test('vector buffer pool maintains data isolation', () => {
    const vector1 = new Array(1536).fill(1);
    const vector2 = new Array(1536).fill(2);
    
    const q1 = SQLTranslator.buildVectorInsertQueries(
        'embeddings', { embedding: vector1 }, 'id1', 
        { embedding: { type: 'vector', dimensions: 1536 } }
    );
    
    const q2 = SQLTranslator.buildVectorInsertQueries(
        'embeddings', { embedding: vector2 }, 'id2',
        { embedding: { type: 'vector', dimensions: 1536 } }
    );
    
    // Verify different data in buffers
    expect(q1[0].params[1]).not.toEqual(q2[0].params[1]);
});

// Test buffer zeroing
test('vector buffers are zeroed on release', () => {
    // This is internal implementation detail
    // Verify through memory inspection if needed
});

// Test dimension pooling
test('buffer pool handles different dimensions', () => {
    const vector512 = new Array(512).fill(1);
    const vector1536 = new Array(1536).fill(2);
    
    const q1 = SQLTranslator.buildVectorInsertQueries(
        'embeddings', { embedding: vector512 }, 'id1',
        { embedding: { type: 'vector', dimensions: 512 } }
    );
    
    const q2 = SQLTranslator.buildVectorInsertQueries(
        'embeddings', { embedding: vector1536 }, 'id2',
        { embedding: { type: 'vector', dimensions: 1536 } }
    );
    
    expect(q1).toHaveLength(1);
    expect(q2).toHaveLength(1);
});
```

**Expected**:
- Buffers reused correctly
- Data isolation maintained
- Different dimensions handled
- No memory leaks

---

## Integration Testing

### Comprehensive Test Suite

**Run all tests**:
```bash
npm test
```

**Expected results**:
- ✅ All 28 test files pass
- ✅ No new failures introduced
- ✅ Performance tests show improvements
- ✅ Memory usage stable or improved

**Critical test files**:
1. `test/database.test.ts` - Core database operations
2. `test/integration.test.ts` - End-to-end workflows
3. `test/query-builder.test.ts` - Query building correctness
4. `test/relationships.test.ts` - Joins and vector ops
5. `test/connection-management.test.ts` - Connection pool health
6. `test/benchmark.test.ts` - Performance validation

---

## Performance Benchmarking

### Run Performance Suite

```bash
npm run benchmark
```

### Expected Improvements

**Before (Baseline)**:
```
=== Results ===
Operation           Count   Duration (ms)   Ops/sec
--------------------------------------------------------
Single Inserts       1000        5000.00        200
Bulk Inserts         5000       10000.00        500
Point Queries        1000        100.00       10000
Range Queries         100        200.00         500
Complex Queries        50        100.00         500
Updates              1000       5000.00        200
```

**After (All Optimizations)**:
```
=== Results ===
Operation           Count   Duration (ms)   Ops/sec
--------------------------------------------------------
Single Inserts       1000        100.00       10000  (50x)
Bulk Inserts         5000        200.00      25000  (50x)
Point Queries        1000         50.00      20000  (2x)
Range Queries         100        150.00        667  (1.3x)
Complex Queries        50         70.00        714  (1.4x)
Updates              1000        100.00      10000  (50x)
```

**Key metrics to verify**:
- ✅ Prepared statements: 50x improvement
- ✅ Bulk operations: 50-100x improvement
- ✅ Query building: 30-40% improvement
- ✅ Point queries with cache: 2-3x improvement
- ✅ Complex queries: 20-30% improvement

---

## Memory Profiling

### GC Frequency Analysis

**Tool**: Node.js `--expose-gc` flag with memory snapshots

```bash
node --expose-gc test/memory-profile.js
```

**Metrics to track**:
1. **Allocation rate**: Should decrease by 30-50%
2. **GC frequency**: Should decrease by 20-30%
3. **GC pause time**: Should remain under 10ms
4. **Heap size**: Should remain stable (no leaks)

### Expected Improvements

**Before**:
- Allocation rate: 10MB/sec
- GC frequency: Every 2 seconds
- Peak heap: 100MB

**After**:
- Allocation rate: 5-7MB/sec (30-50% reduction)
- GC frequency: Every 3-4 seconds (30-50% less frequent)
- Peak heap: 101MB (minimal increase for caches)

---

## Regression Testing

### Areas to Validate

1. **Query Correctness**
   - All filter types (eq, gt, in, like, etc.)
   - Complex OR queries
   - Nested groups
   - Subqueries

2. **Data Integrity**
   - Inserts produce correct data
   - Updates don't corrupt data
   - Deletes work correctly
   - Transactions are atomic

3. **Vector Operations**
   - Vector inserts work
   - Vector updates work
   - Vector search works
   - Data isolation maintained

4. **Connection Management**
   - Pools don't leak
   - Health checks work
   - Reconnection works
   - Concurrent access safe

---

## Test Execution Checklist

### Pre-Flight Checks
- [ ] Dependencies installed (`npm install`)
- [ ] TypeScript compiles (`npx tsc --noEmit`)
- [ ] No linting errors

### Unit Tests
- [ ] `npm test` passes all tests
- [ ] No test failures
- [ ] No new warnings
- [ ] Coverage maintained or improved

### Performance Tests
- [ ] `npm run benchmark` shows expected improvements
- [ ] Query operations 50-70% faster overall
- [ ] Bulk operations maintain 50-100x improvement
- [ ] No performance regressions

### Memory Tests
- [ ] No memory leaks detected
- [ ] GC frequency reduced
- [ ] Allocation rate reduced
- [ ] Heap size stable

### Integration Tests
- [ ] End-to-end workflows pass
- [ ] Concurrent operations work
- [ ] Error handling correct
- [ ] Edge cases handled

---

## Failure Triage

### If Tests Fail

1. **Query Builder Tests Fail**
   - Check shallow copy logic
   - Verify filter isolation
   - Review clone implementation

2. **JSON Cache Tests Fail**
   - Check cache hit logic
   - Verify shallow copy in cache
   - Review LRU eviction

3. **Vector Pool Tests Fail**
   - Check buffer acquisition/release
   - Verify zeroing logic
   - Review dimension pooling

4. **Performance Regressions**
   - Profile specific operations
   - Check for unintended allocations
   - Review hot path changes

### Rollback Plan

If critical issues found:
1. Identify problematic optimization
2. Disable via feature flag or revert commit
3. File issue with reproduction
4. Fix and re-test

---

## Success Criteria

### Must Pass
✅ All existing tests pass  
✅ No data corruption  
✅ No memory leaks  
✅ Performance improvements validated  

### Nice to Have
🎯 50-70% overall query performance improvement  
🎯 90% reduction in GC for vector operations  
🎯 30-50% reduction in allocations  
🎯 Improved p95/p99 latency  

---

## Conclusion

This comprehensive test plan ensures all optimizations are validated and no regressions introduced. Execute tests in order, document results, and iterate as needed.

**Status**: Ready for test execution once Bun runtime is available.
