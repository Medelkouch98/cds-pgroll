#!/usr/bin/env node
'use strict';

/**
 * cds-pgroll CLI
 *
 * Usage:
 *   cds-pgroll init       - Initialize migration tracking & snapshot
 *   cds-pgroll generate   - Interactively create a migration file
 *   cds-pgroll apply      - Run pending migrations locally
 *   cds-pgroll status     - Show migration status
 *   cds-pgroll prepare    - Prepare db deployer (strip CSVs, configure package.json)
 *   cds-pgroll run        - Full pipeline (auto-detect + manual migrations)
 */

const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const command = args[0];

// Resolve project root (where package.json is)
function findProjectRoot() {
  let dir = process.cwd();
  while (dir !== '/') {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

const projectRoot = findProjectRoot();

// Load project package.json for config
function loadConfig() {
  const pkgPath = path.join(projectRoot, 'package.json');
  const pkg = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) : {};
  const pgrollConfig = pkg['cds-pgroll'] || pkg.pgroll || {};

  return {
    schema: pgrollConfig.schema || pkg.cds?.requires?.db?.schema || 'public',
    migrationsDir: path.resolve(projectRoot, pgrollConfig.migrationsDir || 'migrations'),
    schemaPath: path.resolve(projectRoot, pgrollConfig.schemaPath || 'db/schema.cds'),
    dataDir: path.resolve(projectRoot, pgrollConfig.dataDir || 'db/data'),
    deployerDir: path.resolve(projectRoot, pgrollConfig.deployerDir || 'gen/pg'),
    schemaEvolution: pgrollConfig.schemaEvolution || pkg.cds?.requires?.db?.schema_evolution || 'alter',
  };
}

function printUsage() {
  console.log(`
  cds-pgroll - Complementary migration toolkit for @cap-js/postgres

  Usage:
    cds-pgroll <command> [options]

  Commands:
    init         Initialize migration tracking & create schema snapshot
    generate     Interactively create a migration file
    apply        Run pending migrations against local/remote database
    status       Show migration status and pending migrations  
    prepare      Prepare db deployer (strip CSVs, configure CDS)
    run          Full pipeline: auto-detect CSN changes + apply manual migrations

  Options:
    --schema <name>        PostgreSQL schema (default: from package.json)
    --migrations <dir>     Migrations directory (default: ./migrations)
    --help                 Show this help

  Configuration (in package.json):
    {
      "cds-pgroll": {
        "schema": "cap_tva",
        "migrationsDir": "migrations",
        "schemaPath": "db/schema.cds",
        "dataDir": "db/data",
        "schemaEvolution": "alter"
      }
    }

  Examples:
    cds-pgroll init              # Create initial schema snapshot
    cds-pgroll generate          # Interactive migration generator
    cds-pgroll apply             # Apply pending migrations
    cds-pgroll status            # Check migration status
    cds-pgroll prepare           # Prepare gen/pg for deployment
    cds-pgroll run               # Full migration pipeline (CF task)
`);
}

async function main() {
  if (!command || command === '--help' || command === '-h') {
    printUsage();
    process.exit(0);
  }

  const config = loadConfig();

  // Parse flags
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--schema' && args[i + 1]) { config.schema = args[++i]; }
    else if (args[i] === '--migrations' && args[i + 1]) { config.migrationsDir = path.resolve(args[++i]); }
  }

  switch (command) {
    case 'init': {
      const { generate } = require('../src/generator');
      await generate({
        schemaPath: config.schemaPath,
        migrationsDir: config.migrationsDir,
        dataDir: config.dataDir,
        init: true,
      });
      console.log('\n  Migration tracking initialized.');
      console.log('  Schema snapshot saved. Now make changes to schema.cds');
      console.log('  and run: cds-pgroll generate');
      break;
    }

    case 'generate': {
      const { generate } = require('../src/generator');
      await generate({
        schemaPath: config.schemaPath,
        migrationsDir: config.migrationsDir,
        dataDir: config.dataDir,
      });
      break;
    }

    case 'apply': {
      const { run } = require('../src/runner');
      await run({
        migrationsDir: config.migrationsDir,
        schema: config.schema,
        csnPath: path.join(config.deployerDir, 'db', 'csn.json'),
      });
      break;
    }

    case 'status': {
      const { PgRollSql } = require('../src/sql');
      const { run: runRunner } = require('../src/runner');

      // Get connection from environment or default-env.json
      let connectionConfig;
      try {
        const defaultEnvPath = path.join(projectRoot, 'default-env.json');
        if (fs.existsSync(defaultEnvPath)) {
          const env = JSON.parse(fs.readFileSync(defaultEnvPath, 'utf-8'));
          const creds = env.VCAP_SERVICES?.['postgresql-db']?.[0]?.credentials;
          if (creds) {
            connectionConfig = {
              host: creds.hostname, port: creds.port,
              user: creds.username, password: creds.password,
              database: creds.dbname,
              ssl: creds.sslrootcert ? { ca: creds.sslrootcert, rejectUnauthorized: false } : false,
            };
          }
        }
      } catch { /* fallback to env vars */ }

      if (!connectionConfig) {
        connectionConfig = {
          host: process.env.PGHOST || 'localhost',
          port: parseInt(process.env.PGPORT || '5432'),
          user: process.env.PGUSER || 'postgres',
          password: process.env.PGPASSWORD || '',
          database: process.env.PGDATABASE || 'postgres',
        };
      }

      const { Client } = require('pg');
      const client = new Client(connectionConfig);
      await client.connect();

      try {
        const sql = new PgRollSql(client, config.schema);
        const health = await sql.healthCheck();

        console.log('\n  Migration Status');
        console.log('  ================');
        console.log(`  Schema: ${config.schema}`);
        console.log(`  Tracking initialized: ${health.initialized}`);

        if (health.initialized) {
          console.log(`  Applied migrations: ${health.migrationCount}`);
          console.log(`  Last migration: ${health.lastMigration}`);
          console.log(`  Last applied at: ${health.lastAppliedAt}`);

          // Check for pending
          const migrationFiles = fs.readdirSync(config.migrationsDir)
            .filter(f => f.endsWith('.json') && !f.startsWith('.'))
            .sort();
          const applied = await sql.getMigrations();
          const appliedNames = new Set(applied.map(m => m.name));
          const pending = migrationFiles.filter(f => {
            const name = f.replace('.json', '');
            return !appliedNames.has(name);
          });

          if (pending.length > 0) {
            console.log(`\n  Pending migrations (${pending.length}):`);
            pending.forEach(f => console.log(`    - ${f}`));
          } else {
            console.log('\n  All migrations applied.');
          }
        } else {
          console.log('  Run "cds-pgroll apply" to initialize.');
        }
      } finally {
        await client.end();
      }
      break;
    }

    case 'prepare': {
      const { prepare } = require('../src/deployer');
      prepare({
        projectRoot,
        schema: config.schema,
        schemaEvolution: config.schemaEvolution,
        deployerDir: config.deployerDir,
      });
      break;
    }

    case 'run': {
      const { run } = require('../src/runner');
      await run({
        migrationsDir: config.migrationsDir,
        schema: config.schema,
        csnPath: path.join(config.deployerDir, 'db', 'csn.json'),
      });
      break;
    }

    default:
      console.error(`  Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

main().catch(err => {
  console.error('  [cds-pgroll] Error:', err.message);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
