# @cds-pgroll/postgres

Complementary migration toolkit for **@cap-js/postgres**. Handles destructive DDL operations (DROP, RENAME) that CAP's `schema_evolution: 'alter'` cannot perform.

## Why?

SAP CAP with `@cap-js/postgres` supports `schema_evolution: 'alter'` which can:
- ✅ ADD tables, ADD columns, ALTER column types

But it **cannot**:
- ❌ DROP tables, DROP columns
- ❌ RENAME tables, RENAME columns
- ❌ DROP NOT NULL, SET DEFAULT

`@cds-pgroll/postgres` fills this gap with pgroll-inspired migrations that run **before** CAP's `cds-deploy`, handling the destructive/rename DDL that CAP leaves behind.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  CF Deployment                       │
│                                                      │
│  1. pgroll-migrator (CF task)                       │
│     ├── Phase 1: Auto-detect CSN delta              │
│     │   Compare old cds_model with new csn.json     │
│     │   → Generate DROP operations automatically     │
│     └── Phase 2: Apply manual migration files       │
│         → Run *.json from migrations/ directory      │
│                                                      │
│  2. db-deployer (deployed-after pgroll-migrator)    │
│     └── cds-deploy --model-only                     │
│         → ADD tables, ALTER columns, update cds_model│
│                                                      │
│  3. srv (deployed-after db-deployer)                │
│     └── Application server                           │
└─────────────────────────────────────────────────────┘
```

## Installation

```bash
npm install @cds-pgroll/postgres --save-dev
```

## Quick Start

### 1. Initialize

```bash
npx cds-pgroll init
```

Creates a schema snapshot in `migrations/.schema-snapshot.json`.

### 2. Make schema changes

Edit `db/schema.cds` — remove a column, drop an entity, etc.

### 3. Generate migration

```bash
npx cds-pgroll generate
```

Interactive CLI that creates a migration JSON file in `migrations/`.

### 4. Apply locally

```bash
npx cds-pgroll apply
```

### 5. Check status

```bash
npx cds-pgroll status
```

## Configuration

Add to your `package.json`:

```json
{
  "cds-pgroll": {
    "schema": "cap_tva",
    "migrationsDir": "migrations",
    "schemaPath": "db/schema.cds",
    "dataDir": "db/data",
    "schemaEvolution": "alter"
  }
}
```

Or use environment variables:
- `CAP_DB_SCHEMA` — PostgreSQL schema name
- `CAP_SCHEMA_EVOLUTION` — Schema evolution mode

## Migration File Format

Migration files are JSON with a `name` and `operations` array:

```json
{
  "name": "20260311_120000_drop_payment_category",
  "operations": [
    {
      "drop_column": {
        "table": "CAP_TVA_DB_FINANCIALDOCUMENTS",
        "column": "paymentcategory",
        "down": "SELECT NULL"
      }
    }
  ]
}
```

### Supported Operations

| Operation | Description | Example |
|-----------|-------------|---------|
| `drop_column` | Remove a column | `{ "table": "T", "column": "C", "down": "SELECT NULL" }` |
| `drop_table` | Remove a table | `{ "table": "T" }` |
| `rename_column` | Rename a column | `{ "table": "T", "from": "old", "to": "new" }` |
| `rename_table` | Rename a table | `{ "from": "OLD_T", "to": "NEW_T" }` |
| `alter_column` | Change column type | `{ "table": "T", "column": "C", "type": "VARCHAR(500)", "up": "CAST...", "down": "CAST..." }` |
| `add_column` | Add a column | `{ "table": "T", "column": { "name": "C", "type": "VARCHAR(100)" } }` |
| `set_not_null` | Add NOT NULL | `{ "table": "T", "column": "C" }` |
| `drop_not_null` | Remove NOT NULL | `{ "table": "T", "column": "C" }` |
| `set_default` | Set default value | `{ "table": "T", "column": "C", "default": "'value'" }` |
| `drop_default` | Remove default | `{ "table": "T", "column": "C" }` |
| `create_table` | Create a table | `{ "table": "T", "columns": [...], "data": [...] }` |
| `raw_sql` | Raw SQL statement | `{ "up": "CREATE INDEX ...", "down": "DROP INDEX ..." }` |

## MTA Integration

For Cloud Foundry deployments, add a pgroll-migrator module to your `mta.yaml`. See [examples/mta-module.yaml](examples/mta-module.yaml) for a complete example.

Key points:
1. Add `npx cds-pgroll prepare` to `before-all` build commands
2. Copy migration files to `gen/migrations/` during build
3. Set `deployed-after` on db-deployer to ensure correct ordering
4. Use `--model-only` flag for `cds-deploy` so CAP doesn't attempt DDL

### Build Commands

```yaml
build-parameters:
  before-all:
    - builder: custom
      commands:
        - npm ci
        - npx cds build --production
        - npx cds-pgroll prepare
        - 'sed -i ''s/"start": "cds-deploy"/"start": "cds-deploy --model-only"/'' gen/pg/package.json'
        - mkdir -p gen/migrations
        - cp migrations/package.json gen/migrations/
        - cp migrations/run-pgroll.js gen/migrations/
        - bash -c "cp migrations/*.json gen/migrations/ 2>/dev/null; exit 0"
        - cp gen/pg/db/csn.json gen/migrations/csn.json
```

## API Reference

### Core Functions

```js
const {
  // Type mapping
  cdsTypeToSql,        // Convert CDS type to PostgreSQL type
  
  // Naming
  entityToTableName,   // CDS entity → PG table name
  quoteIdent,          // Safe SQL identifier quoting
  
  // Operations
  applyOperation,      // Execute a pgroll operation against PG
  tableExists,         // Check if table exists
  columnExists,        // Check if column exists
  
  // CSN comparison
  detectSchemaChanges, // Compare CSNs for destructive changes
  parseStoredCSN,      // Parse CSN from cds_model TEXT column
  
  // SQL helpers
  PgRollSql,           // Migration tracking (init, record, query)
  
  // High-level
  runMigrations,       // Full 2-phase pipeline
  generate,            // Interactive migration generator
  prepareDeployer,     // Prepare gen/pg for deployment
} = require('@cds-pgroll/postgres');
```

### PgRollSql Class

```js
const { PgRollSql } = require('@cds-pgroll/postgres');
const { Client } = require('pg');

const client = new Client({ /* connection config */ });
await client.connect();

const sql = new PgRollSql(client, 'cap_tva');
await sql.initializeSchema();

// Query migrations
const migrations = await sql.getMigrations();
const pending = await sql.getPendingMigrations(['file1', 'file2']);
const health = await sql.healthCheck();

// Record a migration
await sql.recordMigration('my_migration', [{ drop_table: { table: 'T' } }]);
```

## CDS Type Mapping

| CDS Type | PostgreSQL Type |
|----------|----------------|
| `cds.UUID` | `VARCHAR(36)` |
| `cds.String` | `VARCHAR(length)` or `VARCHAR(5000)` |
| `cds.LargeString` | `TEXT` |
| `cds.Integer` | `INTEGER` |
| `cds.Integer64` | `BIGINT` |
| `cds.Decimal` | `DECIMAL(p,s)` or `DECIMAL` |
| `cds.Double` | `FLOAT8` |
| `cds.Boolean` | `BOOLEAN` |
| `cds.Date` | `DATE` |
| `cds.Time` | `TIME` |
| `cds.DateTime` | `TIMESTAMP` |
| `cds.Timestamp` | `TIMESTAMP` |
| `cds.Binary` | `BYTEA` |
| `cds.LargeBinary` | `BYTEA` |

## How It Differs from pgroll

This is **not** the [pgroll](https://github.com/xataio/pgroll) binary. It is a lightweight, CDS-aware migration runner that borrows pgroll's JSON operation format. Key differences:

- No expand/contract pattern (CAP handles schema evolution)
- No shadow columns or views
- Direct DDL execution with proper identifier quoting
- Integrated CSN delta detection
- CDS type system awareness

## License

MIT
