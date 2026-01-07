# CLI Example Workflows

This document demonstrates common workflows using the skibbaDB CLI.

## Workflow 1: Blog Platform

### Setup
```bash
# Create database
./bin/dev.js db:create blog --path ./blog.db

# Create users collection
./bin/dev.js collection:create users \
  --schema '{"id": "uuid", "username": "string", "email": "email", "bio": "optional-string"}'

# Create posts collection
./bin/dev.js collection:create posts \
  --schema '{"id": "uuid", "title": "string", "content": "string", "authorId": "string", "publishedAt": "optional-string"}'

# Create comments collection
./bin/dev.js collection:create comments \
  --schema '{"id": "uuid", "postId": "string", "authorId": "string", "content": "string", "createdAt": "string"}'
```

### Add Data
```bash
# Add users
./bin/dev.js data:insert users '{"username": "alice", "email": "alice@blog.com", "bio": "Tech blogger"}'
# Note the returned user ID for next steps

./bin/dev.js data:insert users '{"username": "bob", "email": "bob@blog.com"}'

# Add posts
./bin/dev.js data:insert posts '{"title": "Getting Started with skibbaDB", "content": "skibbaDB is amazing...", "authorId": "<alice-user-id>", "publishedAt": "2026-01-07"}'

./bin/dev.js data:insert posts '{"title": "NoSQL vs SQL", "content": "Comparing databases...", "authorId": "<alice-user-id>"}'

# Add comments
./bin/dev.js data:insert comments '{"postId": "<post-id>", "authorId": "<bob-user-id>", "content": "Great post!", "createdAt": "2026-01-07T10:30:00Z"}'
```

### Query Data
```bash
# List all posts
./bin/dev.js data:query posts --order-by title

# Find posts by author
./bin/dev.js data:query posts --where '{"authorId": "<alice-user-id>"}'

# Get user details
./bin/dev.js data:query users --where '{"username": "alice"}' --json

# Raw SQL for complex queries
./bin/dev.js db:query "SELECT u.username, COUNT(p._id) as post_count FROM users u LEFT JOIN posts p ON u._id = p.authorId GROUP BY u.username"
```

## Workflow 2: Task Management System

### Setup
```bash
# Create database
./bin/dev.js db:create tasks --path ./tasks.db

# Create projects collection
./bin/dev.js collection:create projects \
  --schema '{"id": "uuid", "name": "string", "description": "optional-string", "status": "string"}'

# Create tasks collection
./bin/dev.js collection:create tasks \
  --schema '{"id": "uuid", "projectId": "string", "title": "string", "description": "optional-string", "status": "string", "priority": "number", "assignee": "optional-string"}'
```

### Add Data
```bash
# Create project
./bin/dev.js data:insert projects '{"name": "Website Redesign", "description": "Redesign company website", "status": "active"}'
# Note project ID

# Create tasks
./bin/dev.js data:insert tasks '{"projectId": "<project-id>", "title": "Design mockups", "description": "Create initial mockups", "status": "todo", "priority": 1, "assignee": "alice"}'

./bin/dev.js data:insert tasks '{"projectId": "<project-id>", "title": "Implement navigation", "status": "in-progress", "priority": 2, "assignee": "bob"}'

./bin/dev.js data:insert tasks '{"projectId": "<project-id>", "title": "Write tests", "status": "todo", "priority": 3}'
```

### Manage Tasks
```bash
# View all tasks for a project
./bin/dev.js data:query tasks --where '{"projectId": "<project-id>"}' --order-by priority

# Update task status
./bin/dev.js data:update tasks <task-id> '{"status": "completed"}'

# Assign task
./bin/dev.js data:update tasks <task-id> '{"assignee": "alice"}'

# Get project statistics
./bin/dev.js db:query "SELECT status, COUNT(*) as count FROM tasks GROUP BY status"

# Find high priority tasks
./bin/dev.js db:query "SELECT * FROM tasks WHERE json_extract(doc, '$.priority') <= 2 ORDER BY json_extract(doc, '$.priority')"
```

## Workflow 3: E-commerce Catalog

### Setup
```bash
# Create database
./bin/dev.js db:create shop --path ./shop.db

# Create categories
./bin/dev.js collection:create categories \
  --schema '{"id": "uuid", "name": "string", "description": "optional-string"}'

# Create products
./bin/dev.js collection:create products \
  --schema '{"id": "uuid", "name": "string", "description": "string", "price": "number", "categoryId": "string", "stock": "number", "tags": "optional-string"}'
```

### Add Data
```bash
# Add categories
./bin/dev.js data:insert categories '{"name": "Electronics", "description": "Electronic devices"}'
./bin/dev.js data:insert categories '{"name": "Books", "description": "Books and literature"}'

# Add products
./bin/dev.js data:insert products '{"name": "Laptop", "description": "High-performance laptop", "price": 999.99, "categoryId": "<electronics-id>", "stock": 10, "tags": "computer,work"}'

./bin/dev.js data:insert products '{"name": "Programming Book", "description": "Learn coding", "price": 49.99, "categoryId": "<books-id>", "stock": 25, "tags": "programming,education"}'
```

### Query Products
```bash
# List all products
./bin/dev.js data:query products --order-by price

# Products in category
./bin/dev.js data:query products --where '{"categoryId": "<electronics-id>"}'

# In-stock products
./bin/dev.js db:query "SELECT * FROM products WHERE json_extract(doc, '$.stock') > 0"

# Price range
./bin/dev.js db:query "SELECT * FROM products WHERE json_extract(doc, '$.price') < 100 ORDER BY json_extract(doc, '$.price')"
```

## Workflow 4: Multi-Database Management

### Setup Multiple Databases
```bash
# Development database
./bin/dev.js db:create dev --path ./dev.db

# Testing database
./bin/dev.js db:create test --path ./test.db --set-current false

# Production database
./bin/dev.js db:create prod --path ./prod.db --set-current false
```

### Switch Between Databases
```bash
# Work on development
./bin/dev.js db:use dev
./bin/dev.js collection:list

# Switch to test
./bin/dev.js db:use test
./bin/dev.js collection:list

# Check which database is active
./bin/dev.js db:list
```

## Tips and Tricks

### 1. Using JSON Output for Scripting
```bash
# Get all user IDs
./bin/dev.js data:query users --json | jq '.[].id'

# Count documents
./bin/dev.js db:query "SELECT COUNT(*) as count FROM users" --json | jq '.[0].count'
```

### 2. Batch Operations with Shell Scripts
```bash
# Insert multiple documents
for i in {1..10}; do
  ./bin/dev.js data:insert users "{\"username\": \"user$i\", \"email\": \"user$i@example.com\"}"
done
```

### 3. Quick Data Inspection
```bash
# Show table structure
./bin/dev.js db:query "SELECT sql FROM sqlite_master WHERE type='table' AND name='users'"

# Show all columns
./bin/dev.js db:query "PRAGMA table_info(users)"

# Count all collections
./bin/dev.js db:query "SELECT name, (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%') as count FROM sqlite_master WHERE type='table' LIMIT 1"
```

### 4. Backup and Export
```bash
# Export data as JSON
./bin/dev.js data:query users --json > users_backup.json

# Get schema
./bin/dev.js db:query "SELECT sql FROM sqlite_master WHERE type='table'" --json > schema.json
```

### 5. Performance Analysis
```bash
# Analyze query performance
./bin/dev.js db:query "EXPLAIN QUERY PLAN SELECT * FROM users WHERE email = 'test@example.com'"

# Table statistics
./bin/dev.js db:query "SELECT * FROM sqlite_stat1"
```

## Common Patterns

### Pattern 1: Find and Update
```bash
# Find documents
ID=$(./bin/dev.js data:query users --where '{"username": "alice"}' --json | jq -r '.[0]._id')

# Update found document
./bin/dev.js data:update users "$ID" '{"email": "newemail@example.com"}'
```

### Pattern 2: Conditional Delete
```bash
# Find IDs to delete
./bin/dev.js db:query "SELECT _id FROM users WHERE json_extract(doc, '$.status') = 'inactive'" --json | jq -r '.[].id' | while read id; do
  ./bin/dev.js data:delete users "$id" --confirm
done
```

### Pattern 3: Data Migration
```bash
# Export from old database
./bin/dev.js db:use old
./bin/dev.js data:query users --json > users.json

# Import to new database
./bin/dev.js db:use new
cat users.json | jq -c '.[]' | while read user; do
  ./bin/dev.js data:insert users "$user"
done
```

## Troubleshooting

### Database Locked
If you get "database is locked" errors, ensure only one CLI instance is accessing the database at a time.

### Schema Validation Errors
Make sure your JSON matches the schema defined when creating the collection. Use `--json` flag to see detailed error messages.

### Performance Issues
For large datasets:
- Use `--limit` and `--offset` for pagination
- Create indexes using raw SQL: `db:query "CREATE INDEX idx_name ON users(name)"`
- Use `db:query` with specific column selection instead of SELECT *
