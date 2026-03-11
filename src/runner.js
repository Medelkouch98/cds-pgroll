'use strict';

/**
 * pgroll Migration Runner
 *
 * Runs as a Cloud Foundry task BEFORE the CAP db-deployer.
 * Two-phase execution:
 *   Phase 1: Auto-detect destructive changes by comparing CSN (old vs new)
 *   Phase 2: Apply manual migration JSON files
 *
 * After this runner completes, CAP's db-deployer (cds-deploy --model-only)
 * syncs the cds_model table, and the runtime's schema_evolution: alter
 * handles additive DDL (ADD columns, ADD tables).
 *
 * @module src/runner
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { detectSchemaChanges, parseStoredCSN } = require('./csn-diff');
const { applyOperation } = require('./operations');
const PgRollSql = require('./sql');

/**
 * Get PostgreSQL connection config from VCAP_SERVICES (Cloud Foundry).
 *
 * @param {Object} [env] - Environment variables (default: process.env)
 * @returns {Object} pg Pool configuration
 */
function getConnectionConfig(env = process.env) {
  // CF environment
  if (env.VCAP_SERVICES) {
    const vcap = JSON.parse(env.VCAP_SERVICES);
    const pgService = vcap['postgresql-db']?.[0] || vcap['postgresql']?.[0];
    if (!pgService?.credentials) {
      throw new Error('PostgreSQL service binding not found in VCAP_SERVICES');
    }
    const { hostname, port, username, password, dbname, sslcert, sslrootcert } = pgService.credentials;
    return {
      host: hostname,
      port: parseInt(port, 10),
      user: username,
      password,
      database: dbname,
      ssl: { rejectUnauthorized: false, ca: sslrootcert, cert: sslcert }
    };
  }

  // Local: connection string from DATABASE_URL
  if (env.DATABASE_URL) {
    return { connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } };
  }

  throw new Error('No PostgreSQL connection config found. Set VCAP_SERVICES or DATABASE_URL.');
}

/**
 * Get connection config from default-env.json (local development).
 *
 * @param {string} projectRoot - Path to project root
 * @returns {Object|null} pg Pool config or null
 */
function getLocalConnectionConfig(projectRoot) {
  const envPath = path.join(projectRoot, 'default-env.json');
  if (!fs.existsSync(envPath)) return null;
  try {
    const env = JSON.parse(fs.readFileSync(envPath, 'utf-8'));
    const pgService = env.VCAP_SERVICES?.['postgresql-db']?.[0];
    if (!pgService?.credentials) return null;
    const { hostname, port, username, password, dbname } = pgService.credentials;
    return {
      host: hostname,
      port: parseInt(port, 10),
      user: username,
      password,
      database: dbname,
      ssl: { rejectUnauthorized: false }
    };
  } catch {
    return null;
  }
}

/**
 * Load the NEW CSN from a csn.json file.
 *
 * @param {string} csnPath - Path to csn.json
 * @param {Function} [log] - Logging function
 * @returns {Object|null}
 */
function loadNewCSN(csnPath, log = console.log) {
  if (!fs.existsSync(csnPath)) {
    log('[runner] No csn.json found — skipping auto-detection');
    return null;
  }
  try {
    const csn = JSON.parse(fs.readFileSync(csnPath, 'utf-8'));
    log(`[runner] Loaded new CSN: ${Object.keys(csn.definitions || {}).length} definitions`);
    return csn;
  } catch (error) {
    log(`[runner] Failed to load csn.json: ${error.message}`);
    return null;
  }
}

/**
 * Load the deployed CSN from the cds_model table.
 *
 * @param {Object} pool - pg Pool
 * @param {string} schema - PostgreSQL schema
 * @param {Function} [log] - Logging function
 * @returns {Promise<Object|null>}
 */
async function loadDeployedCSN(pool, schema, log = console.log) {
  try {
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = 'cds_model'
      ) as exists
    `, [schema]);

    if (!tableCheck.rows[0].exists) {
      log('[runner] cds_model table does not exist — first deployment');
      return null;
    }

    const result = await pool.query(`SELECT csn FROM ${schema}.cds_model LIMIT 1`);
    if (result.rows.length === 0) {
      log('[runner] cds_model table is empty — first deployment');
      return null;
    }

    const csn = parseStoredCSN(result.rows[0].csn);
    if (!csn) {
      log('[runner] Failed to parse CSN from cds_model');
      return null;
    }
    log(`[runner] Loaded deployed CSN: ${Object.keys(csn.definitions || {}).length} definitions`);
    return csn;
  } catch (error) {
    log(`[runner] Failed to load deployed CSN: ${error.message}`);
    return null;
  }
}

/**
 * Get migration JSON files from a directory, sorted by filename (timestamp order).
 *
 * @param {string} migrationsDir - Path to migrations directory
 * @returns {string[]} Sorted list of JSON filenames
 */
function getMigrationFiles(migrationsDir) {
  if (!fs.existsSync(migrationsDir)) return [];
  return fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.json') && !f.startsWith('.') && f !== 'package.json' && f !== 'csn.json')
    .sort();
}

/**
 * Run the full migration pipeline.
 *
 * @param {Object} options
 * @param {string} options.migrationsDir - Path to migrations directory
 * @param {string} [options.csnPath] - Path to csn.json (default: migrationsDir/csn.json)
 * @param {string} [options.schema='public'] - PostgreSQL schema
 * @param {Object} [options.connectionConfig] - pg Pool config (auto-detected if omitted)
 * @param {Function} [options.log] - Logging function
 * @returns {Promise<{autoOps: number, applied: number, skipped: number}>}
 */
async function run(options) {
  const {
    migrationsDir,
    csnPath = path.join(migrationsDir, 'csn.json'),
    schema = 'public',
    connectionConfig,
    log = console.log,
  } = options;

  log('[runner] pgroll Migration Runner — CAP Delta Detection + Manual Migrations\n');
  log(`[runner] Target schema: ${schema}`);

  const config = connectionConfig || getConnectionConfig();
  const pool = new Pool(config);

  try {
    await pool.query('SELECT 1');
    log('[runner] Database connected\n');

    // Initialize pgroll schema
    const pgrollSql = new PgRollSql(pool, schema);
    const initialized = await pgrollSql.isPgRollInitialized();
    if (!initialized) {
      log('[runner] Initializing pgroll schema...');
      await pgrollSql.initializeSchema();
    }
    log('[runner] pgroll schema ready\n');

    // ═══════════════════════════════════════════
    // PHASE 1: Auto-detect destructive changes
    // ═══════════════════════════════════════════
    log('[runner] PHASE 1: CAP Delta Detection');
    let autoOps = 0;

    const newCSN = loadNewCSN(csnPath, log);
    const deployedCSN = await loadDeployedCSN(pool, schema, log);

    if (newCSN && deployedCSN) {
      const autoDetectedOps = detectSchemaChanges(deployedCSN, newCSN, { log });

      if (autoDetectedOps.length > 0) {
        log(`[runner] Auto-detected ${autoDetectedOps.length} destructive operation(s)\n`);
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          for (const op of autoDetectedOps) {
            await applyOperation({ query: (sql, params) => client.query(sql, params) }, schema, op, { log });
          }
          // Record with deterministic name based on definition count
          const autoMigrationName = `auto_delta_${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
          await client.query(`
            INSERT INTO pgroll.migrations (name, schema, done)
            VALUES ($1, $2, TRUE)
            ON CONFLICT (name) DO UPDATE SET done = TRUE, updated_at = NOW()
          `, [autoMigrationName, schema]);
          await client.query('COMMIT');
          autoOps = autoDetectedOps.length;
          log(`[runner] Applied ${autoOps} auto-detected operation(s)\n`);
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      } else {
        log('[runner] No destructive changes detected\n');
      }
    } else if (!deployedCSN) {
      log('[runner] First deployment — no delta detection needed\n');
    }

    // ═══════════════════════════════════════════
    // PHASE 2: Manual migration files
    // ═══════════════════════════════════════════
    log('[runner] PHASE 2: Manual Migration Files');

    const files = getMigrationFiles(migrationsDir);
    const appliedMap = new Map(
      (await pgrollSql.getMigrations()).map(r => [r.name, r.done])
    );

    log(`[runner] Found ${files.length} migration file(s)`);
    log(`[runner] Already applied: ${[...appliedMap.values()].filter(Boolean).length}\n`);

    let applied = 0;
    let skipped = 0;

    for (const file of files) {
      const migrationPath = path.join(migrationsDir, file);
      const migration = JSON.parse(fs.readFileSync(migrationPath, 'utf-8'));
      const migrationName = migration.name || file.replace('.json', '');

      if (appliedMap.get(migrationName) === true) {
        log(`[runner] Skip ${migrationName} (already applied)`);
        skipped++;
        continue;
      }

      log(`[runner] Applying: ${migrationName}`);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const op of migration.operations || []) {
          await applyOperation({ query: (sql, params) => client.query(sql, params) }, schema, op, { log });
        }
        await client.query(`
          INSERT INTO pgroll.migrations (name, schema, done)
          VALUES ($1, $2, TRUE)
          ON CONFLICT (name) DO UPDATE SET done = TRUE, updated_at = NOW()
        `, [migrationName, schema]);
        await client.query('COMMIT');
        applied++;
        log(`[runner] Applied: ${migrationName}\n`);
      } catch (error) {
        await client.query('ROLLBACK');
        log(`[runner] FAILED: ${migrationName} — ${error.message}`);
        throw error;
      } finally {
        client.release();
      }
    }

    log(`\n[runner] Complete: auto=${autoOps}, manual=${applied} applied, ${skipped} skipped`);
    return { autoOps, applied, skipped };
  } finally {
    await pool.end();
  }
}

module.exports = {
  run,
  getConnectionConfig,
  getLocalConnectionConfig,
  loadNewCSN,
  loadDeployedCSN,
  getMigrationFiles,
};
