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

## Prerequisites

- Node.js >= 18
- A SAP CAP project with `@sap/cds` and `@cap-js/postgres`
- PostgreSQL database (local or Cloud Foundry bound)
- A `default-env.json` file with PostgreSQL credentials for local development

## Installation

```bash
npm install @cds-pgroll/postgres --save-dev
```

## Configuration

Add to your project's `package.json`:

```json
{
  "cds-pgroll": {
    "schema": "my_schema",
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
| `schema` | `'public'` | PostgreSQL schema name. **Important:** set this explicitly — the fallback to `cds.requires.db.schema` does not resolve CDS profile brackets like `[development]` or `[production]`. |
| `migrationsDir` | `'migrations'` | Directory for migration JSON files |
| `schemaPath` | `'db/schema.cds'` | Path to CDS schema file |
| `dataDir` | `'db/data'` | Path to CSV seed data directory |
| `deployerDir` | `'gen/pg'` | Path to CAP db-deployer build output |
| `schemaEvolution` | `'alter'` | CDS schema evolution mode |

## Database Connection

The CLI commands that need a database (`apply`, `run`, `status`) resolve connection config in this order:

1. **`VCAP_SERVICES`** env var — Cloud Foundry service binding (looks for `postgresql-db` or `postgresql`)
2. **`DATABASE_URL`** env var — PostgreSQL connection string
3. **`default-env.json`** file — local file with CF-style credentials (auto-discovered by walking up from cwd)
4. **`PGHOST`/`PGDATABASE`** env vars — standard PostgreSQL environment variables

For local development, the easiest option is having a `default-env.json` in your project root:

```json
{
  "VCAP_SERVICES": {
    "postgresql-db": [{
      "credentials": {
        "hostname": "localhost",
        "port": "5432",
        "username": "postgres",
        "password": "postgres",
        "dbname": "mydb"
      }
    }]
  }
}
```

## Quick Start

### 1. Configure

Add the `cds-pgroll` section to your `package.json` (see [Configuration](#configuration) above).

### 2. Initialize

```bash
npx cds-pgroll init
```

This reads your CDS model and creates a schema snapshot at `migrations/.schema-snapshot.json`. No database connection is needed — it only reads files.

### 3. Make schema changes

Edit `db/schema.cds` — remove a column, drop an entity, rename something, etc.

### 4. Generate migration

```bash
npx cds-pgroll generate
```

Interactive CLI that creates a timestamped migration JSON file in `migrations/`. You can choose from 12 operation types, or select "auto-detect" to compare against the snapshot and find removed entities/columns automatically.

> **Note:** Manual operations (choices 1–11) work without running `init` first. Auto-detect (choice 12) requires a snapshot.

### 5. Apply migrations

```bash
npx cds-pgroll apply
```

Connects to your database and runs a 2-phase pipeline:
- **Phase 1:** Auto-detects destructive changes by comparing the deployed CSN (from `cds_model` table) with the new CSN. Requires `gen/pg/db/csn.json` (run `npx cds build` first). If the file doesn't exist, this phase is skipped gracefully.
- **Phase 2:** Applies any pending migration JSON files from the migrations directory.

> `npx cds-pgroll run` is an alias for `apply`.

### 6. Check status

```bash
npx cds-pgroll status
```

Shows migration tracking state: schema status, applied migrations count, current version, and any pending migration files on disk.

## Migration File Format

Migration files are JSON with a `name` and `operations` array:

```json
{
  "name": "20260311_120000_drop_payment_category",
  "operations": [
    {
      "drop_column": {
        "table": "MY_SCHEMA_DB_FINANCIALDOCUMENTS",
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
| `alter_column` | Change column type | `{ "table": "T", "column": "C", "type": "VARCHAR(500)" }` |
| `add_column` | Add a column | `{ "table": "T", "column": { "name": "C", "type": "VARCHAR(100)" } }` |
| `set_not_null` | Add NOT NULL | `{ "table": "T", "column": "C" }` |
| `drop_not_null` | Remove NOT NULL | `{ "table": "T", "column": "C" }` |
| `set_default` | Set default value | `{ "table": "T", "column": "C", "default": "'value'" }` |
| `drop_default` | Remove default | `{ "table": "T", "column": "C" }` |
| `create_table` | Create a table | `{ "table": "T", "columns": [...], "data": [...] }` |
| `raw_sql` | Raw SQL statement | `{ "up": "CREATE INDEX ..." }` |

> **Note:** The `down` field is accepted for documentation purposes but is not executed — there is no automatic rollback mechanism. To reverse a migration, create a new migration with the inverse operations.

## MTA Integration (Cloud Foundry)

For CF deployments, you need two things:

1. A **pgroll-migrator** module that runs destructive DDL before the db-deployer
2. The **`prepare`** build step that configures the db-deployer

See [examples/mta-module.yaml](examples/mta-module.yaml) for a complete example.

### Build Commands

Add these to your `mta.yaml` `before-all` section — **after** `npx cds build --production`:

```yaml
build-parameters:
  before-all:
    - builder: custom
      commands:
        - npm ci
        - npx cds build --production
        # Prepare db-deployer: strip CSVs, set --model-only, configure schema
        - npx cds-pgroll prepare --model-only
        # Copy migration files and CSN to gen/migrations for the migrator module
        - mkdir -p gen/migrations
        - bash -c "cp migrations/*.json gen/migrations/ 2>/dev/null; exit 0"
        - cp gen/pg/db/csn.json gen/migrations/csn.json
```

The `prepare --model-only` command does three things:
1. Strips CSV data rows to header-only (prevents duplicate key errors on redeployment)
2. Sets `scripts.start` to `cds-deploy --model-only` in `gen/pg/package.json`
3. Configures the schema and schema_evolution settings

### Migrator Module

The migrator module needs `@cds-pgroll/postgres` and `pg` as dependencies. Create a `migrations/package.json`:

```json
{
  "name": "my-app-pgroll-migrator",
  "version": "1.0.0",
  "dependencies": {
    "@cds-pgroll/postgres": "^1.0.0",
    "pg": "^8.13.0"
  },
  "engines": {
    "node": ">=18"
  }
}
```

In the MTA module definition, use `npx cds-pgroll run` as the task command:

```yaml
- name: my-app-pgroll-migrator
  type: nodejs
  path: gen/migrations
  parameters:
    no-route: true
    no-start: true
    tasks:
      - name: run-pgroll-migrations
        command: npx cds-pgroll run --schema my_schema
  requires:
    - name: my-app-db

- name: my-app-db-deployer
  type: nodejs
  path: gen/pg
  deployed-after:
    - my-app-pgroll-migrator    # Must run AFTER pgroll
  # ...
```

## CLI Reference

```
cds-pgroll <command> [options]

Commands:
  init         Create schema snapshot (no DB needed)
  generate     Interactive migration generator (no DB needed)
  apply        Run pending migrations (needs DB)
  status       Show migration status (needs DB)
  prepare      Prepare gen/pg for deployment (no DB needed, needs cds build first)
  run          Alias for apply

Options:
  --schema <name>        PostgreSQL schema (overrides package.json config)
  --migrations <dir>     Migrations directory (overrides package.json config)
  --model-only           Use cds-deploy --model-only (for prepare command)
  --help                 Show help
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

const sql = new PgRollSql(client, 'my_schema');
await sql.initializeSchema();

// Query migrations
const migrations = await sql.getMigrations();
const pending = await sql.getPendingMigrations();
const health = await sql.healthCheck();
// health = { status: 'ok'|'not_initialized'|'migration_in_progress',
//            message: '...', healthy: true|false,
//            currentVersion: 'migration_name'|null }

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
