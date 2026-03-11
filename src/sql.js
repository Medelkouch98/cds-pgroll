'use strict';

/**
 * pgroll SQL Helper — Migration Status & Health Checks
 *
 * Direct SQL queries for checking pgroll migration state.
 * Works with any PostgreSQL client (pg Pool, CDS db, etc.).
 *
 * @module src/sql
 */

class PgRollSql {
  /**
   * @param {Object} db - Database connection (CDS db or pg Pool)
   * @param {string} [schema='public'] - Target application schema
   */
  constructor(db, schema = 'public') {
    this.db = db;
    this.schema = schema;
  }

  /**
   * Execute a query — adapts to CDS (db.run) or pg (db.query) interface.
   * @private
   */
  async _query(sql, params = []) {
    if (typeof this.db.run === 'function') {
      return this.db.run(sql, params);
    }
    const result = await this.db.query(sql, params);
    return result.rows;
  }

  /**
   * Check if the pgroll schema and migrations table exist.
   * @returns {Promise<boolean>}
   */
  async isPgRollInitialized() {
    const result = await this._query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.schemata
        WHERE schema_name = 'pgroll'
      ) as exists
    `);
    return result[0]?.exists || false;
  }

  /**
   * Initialize the pgroll schema and migrations table.
   * Safe to call repeatedly (uses IF NOT EXISTS).
   */
  async initializeSchema() {
    await this._query('CREATE SCHEMA IF NOT EXISTS pgroll');
    await this._query(`
      CREATE TABLE IF NOT EXISTS pgroll.migrations (
        name TEXT PRIMARY KEY,
        schema TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        done BOOLEAN DEFAULT FALSE,
        parent TEXT REFERENCES pgroll.migrations(name)
      )
    `);
  }

  /**
   * Get all migrations from pgroll.migrations table.
   * @returns {Promise<Array>}
   */
  async getMigrations() {
    const initialized = await this.isPgRollInitialized();
    if (!initialized) return [];
    return this._query(`
      SELECT name, schema, created_at, updated_at, done, parent
      FROM pgroll.migrations ORDER BY created_at ASC
    `);
  }

  /**
   * Get latest completed migration name.
   * @returns {Promise<string|null>}
   */
  async getCurrentVersion() {
    const initialized = await this.isPgRollInitialized();
    if (!initialized) return null;
    const result = await this._query(`
      SELECT name FROM pgroll.migrations
      WHERE done = TRUE ORDER BY created_at DESC LIMIT 1
    `);
    return result[0]?.name || null;
  }

  /**
   * Get migrations that are started but not completed.
   * @returns {Promise<Array>}
   */
  async getPendingMigrations() {
    const initialized = await this.isPgRollInitialized();
    if (!initialized) return [];
    return this._query(`
      SELECT name, created_at, updated_at
      FROM pgroll.migrations WHERE done = FALSE ORDER BY created_at ASC
    `);
  }

  /**
   * Get a specific migration by name.
   * @param {string} migrationName
   * @returns {Promise<Object|null>}
   */
  async getMigration(migrationName) {
    const initialized = await this.isPgRollInitialized();
    if (!initialized) return null;
    const result = await this._query(
      'SELECT name, done, created_at, updated_at FROM pgroll.migrations WHERE name = $1',
      [migrationName]
    );
    return result[0] || null;
  }

  /**
   * Record a migration as completed.
   * @param {string} name - Migration name
   */
  async recordMigration(name) {
    await this._query(`
      INSERT INTO pgroll.migrations (name, schema, done)
      VALUES ($1, $2, TRUE)
      ON CONFLICT (name) DO UPDATE SET done = TRUE, updated_at = NOW()
    `, [name, this.schema]);
  }

  /**
   * Check migration health — are there incomplete migrations?
   * @returns {Promise<Object>}
   */
  async healthCheck() {
    const initialized = await this.isPgRollInitialized();
    if (!initialized) {
      return {
        status: 'not_initialized',
        message: 'pgroll schema not found — run init first',
        healthy: true
      };
    }

    const pending = await this.getPendingMigrations();
    const current = await this.getCurrentVersion();

    if (pending.length > 0) {
      return {
        status: 'migration_in_progress',
        message: `${pending.length} migration(s) in progress`,
        pending: pending.map(p => p.name),
        currentVersion: current,
        healthy: false
      };
    }

    return {
      status: 'ok',
      message: 'All migrations complete',
      currentVersion: current,
      healthy: true
    };
  }
}

module.exports = { PgRollSql };
