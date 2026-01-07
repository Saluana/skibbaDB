# skibbaDB CLI

A command-line interface for interacting with skibbaDB instances.

## Installation

```bash
cd cli
npm install
npm run build
```

## Usage

### Database Management

#### Create a database connection
```bash
# Create a file-based database
./bin/dev.js db:create mydb --path ./mydb.db

# Create an in-memory database
./bin/dev.js db:create memdb --memory

# Create a remote LibSQL database (Turso)
./bin/dev.js db:create remote --path libsql://db.turso.io --auth-token yourtoken
```

#### List all database connections
```bash
./bin/dev.js db:list
```

#### Switch between databases
```bash
./bin/dev.js db:use mydb
```

#### Show database information
```bash
./bin/dev.js db:info
```

### Collection Management

#### Create a collection
```bash
# Simple collection
./bin/dev.js collection:create users --schema '{"id": "string", "name": "string", "email": "email"}'

# With constrained fields
./bin/dev.js collection:create posts \
  --schema '{"id": "string", "title": "string", "content": "string", "authorId": "string"}' \
  --constrained 'authorId:fk:users,title:unique'
```

#### List all collections
```bash
./bin/dev.js collection:list

# Verbose mode with schema details
./bin/dev.js collection:list --verbose
```

### Data Manipulation

#### Insert a document
```bash
./bin/dev.js data:insert users '{"name": "John Doe", "email": "john@example.com"}'

# With custom ID
./bin/dev.js data:insert users '{"name": "Jane Doe", "email": "jane@example.com"}' --id custom-id
```

#### Query documents
```bash
# Get all documents
./bin/dev.js data:query users

# Filter by field
./bin/dev.js data:query users --where '{"name": "John Doe"}'

# With pagination and ordering
./bin/dev.js data:query users --limit 10 --offset 0 --order-by name

# Output as JSON
./bin/dev.js data:query users --json
```

#### Update a document
```bash
./bin/dev.js data:update users doc-id '{"name": "John Smith"}'
```

#### Delete a document
```bash
# With confirmation prompt
./bin/dev.js data:delete users doc-id

# Skip confirmation
./bin/dev.js data:delete users doc-id --confirm
```

## Examples

### Complete Workflow

```bash
# 1. Create a database
./bin/dev.js db:create testdb --path ./test.db

# 2. Create collections
./bin/dev.js collection:create users --schema '{"id": "string", "name": "string", "email": "email"}'
./bin/dev.js collection:create posts --schema '{"id": "string", "title": "string", "content": "string", "authorId": "string"}' --constrained 'authorId:fk:users'

# 3. Insert data
./bin/dev.js data:insert users '{"name": "Alice", "email": "alice@example.com"}'
./bin/dev.js data:insert users '{"name": "Bob", "email": "bob@example.com"}'

# 4. Query data
./bin/dev.js data:query users
./bin/dev.js data:query users --where '{"name": "Alice"}'

# 5. Update data
./bin/dev.js data:update users <user-id> '{"name": "Alice Smith"}'

# 6. View database info
./bin/dev.js db:info
./bin/dev.js collection:list
```

## Development

```bash
# Build the CLI
npm run build

# Run in development mode
./bin/dev.js --help

# Clean build
npm run clean && npm run build
```

## Schema Definition

The CLI uses JSON schema definitions that are converted to Zod schemas. Supported types:

- `string` - String value
- `number` - Numeric value
- `boolean` - Boolean value
- `date` - Date value
- `uuid` - UUID string
- `email` - Email string
- `optional-string` - Optional string
- `optional-number` - Optional number

## Constrained Fields

Format: `field:constraint,field2:constraint2`

Supported constraints:
- `unique` - Enforce uniqueness
- `fk:collection` - Foreign key reference
- `nullable` - Allow null values

## Configuration

The CLI stores database connections in `~/.skibba/config.json`.
