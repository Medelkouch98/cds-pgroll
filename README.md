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

Creates a schema snapshot in `migrations/.schema-snapshot.json`. No database connection needed — this only reads your CDS model files.

### 2. Make schema changes

Edit `db/schema.cds` — remove a column, drop an entity, rename something, etc.

### 3. Generate migration

```bash
npx cds-pgroll generate
```

Interactive CLI that creates a migration JSON file in `migrations/`. It compares the current CDS model against the snapshot and offers operation types.

### 4. Apply locally

```bash
npx cds-pgroll apply
```

Connects to your local PostgreSQL using `default-env.json` (VCAP_SERVICES format) or `DATABASE_URL` environment variable, then runs the 2-phase pipeline:
- **Phase 1**: Auto-detect removed entities/columns by comparing the deployed CSN (from `cds_model` table) with the new CSN
- **Phase 2**: Apply any pending migration JSON files from `migrations/`

### 5. Check status

```bash
npx cds-pgroll status
```

Shows migration health, applied count, current version, and any pending migration files. Reads connection from `default-env.json`.

## Configuration

Add to your `package.json`:

```json
{
  "cds-pgroll": {
    "schema": "cap_project",
    "migrationsDir": "migrations",
    "schemaPath": "db/schema.cds",
    "dataDir": "db/data",
    "deployerDir": "gen/pg",
    "schemaEvolution": "alter"
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `schema` | `'public'` | PostgreSQL schema name (falls back to `cds.requires.db.schema`) |
| `migrationsDir` | `'migrations'` | Directory for migration JSON files |
| `schemaPath` | `'db/schema.cds'` | Path to CDS schema file |
| `dataDir` | `'db/data'` | Path to CSV seed data directory |
| `deployerDir` | `'gen/pg'` | Path to CAP db-deployer build output |
| `schemaEvolution` | `'alter'` | CDS schema evolution mode |

## Migration File Format

Migration files are JSON with a `name` and `operations` array:

```json
{
  "name": "20260311_120000_drop_payment_category",
  "operations": [
    {
      "drop_column": {
        "table": "CAP_PROJECT_DB_FINANCIALDOCUMENTS",
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
1. Add `npx cds-pgroll prepare` to `before-all` build commands — this strips CSV data rows and sets `cds-deploy --model-only` in `gen/pg/package.json` automatically
2. Copy the runner and migration files to `gen/migrations/` during build
3. Add a `pgroll-migrator` module that runs **before** the db-deployer
4. Set `deployed-after` on db-deployer to ensure correct ordering

### Build Commands

```yaml
build-parameters:
  before-all:
    - builder: custom
      commands:
        - npm ci
        - npx cds build --production
        - npx cds-pgroll prepare
        - mkdir -p gen/migrations
        - cp -r node_modules/@cds-pgroll/postgres/bin/run-pgroll.js gen/migrations/
        - cp -r node_modules/@cds-pgroll gen/migrations/node_modules/@cds-pgroll
        - cp -r node_modules/pg gen/migrations/node_modules/pg
        - bash -c "cp migrations/*.json gen/migrations/ 2>/dev/null; exit 0"
        - cp gen/pg/db/csn.json gen/migrations/csn.json
```

The `npx cds-pgroll prepare` command:
- Strips CSV data files to header-only (prevents duplicate key errors on re-deploy)
- Sets `scripts.start` to `cds-deploy --model-only` in `gen/pg/package.json`
- Configures `schema` and `schema_evolution` in CDS config
- Removes hardcoded credentials (CF uses VCAP_SERVICES bindings)

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
const pending = await sql.getPendingMigrations();
const health = await sql.healthCheck();

// Record a migration
await sql.recordMigration('my_migration');
```

## CDS Type Mapping

| CDS Type | PostgreSQL Type |
|----------|----------------|
| `cds.UUID` | `VARCHAR(36)` |
| `cds.String` | `VARCHAR(length)` or `VARCHAR(255)` |
| `cds.LargeString` | `TEXT` |
| `cds.Integer` | `INTEGER` |
| `cds.Int64` | `BIGINT` |
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
