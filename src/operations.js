'use strict';

/**
 * pgroll Migration Operations
 *
 * Applies migration operations (DROP, CREATE, ALTER, RENAME) to PostgreSQL
 * using properly quoted identifiers for safety against reserved-word collisions.
 *
 * @module src/operations
 */

const { quoteIdent } = require('./naming');

/**
 * Check if a table exists in the specified schema.
 *
 * @param {Object} client - pg Pool or Client with .query()
 * @param {string} schema - PostgreSQL schema name
 * @param {string} tableName - Table name (unquoted)
 * @returns {Promise<boolean>}
 */
async function tableExists(client, schema, tableName) {
  const result = await client.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = $2
    ) as exists
  `, [schema, tableName]);
  return result.rows[0].exists;
}

/**
 * Check if a column exists in a table.
 *
 * @param {Object} client - pg Pool or Client with .query()
 * @param {string} schema - PostgreSQL schema name
 * @param {string} tableName - Table name (unquoted)
 * @param {string} columnName - Column name (unquoted)
 * @returns {Promise<boolean>}
 */
async function columnExists(client, schema, tableName, columnName) {
  const result = await client.query(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 AND column_name = $3
    ) as exists
  `, [schema, tableName, columnName]);
  return result.rows[0].exists;
}

/**
 * Apply a single pgroll migration operation to the database.
 *
 * Supported operations:
 * - drop_column, drop_table, create_table, add_column
 * - rename_column, rename_table (alias: alter_table)
 * - alter_column, set_not_null, drop_not_null
 * - set_default, drop_default
 *
 * @param {Object} client - pg Pool/Client with .query(sql, params)
 * @param {string} schema - PostgreSQL schema name
 * @param {Object} operation - pgroll operation object (e.g., { drop_column: { table, column } })
 * @param {Object} [options] - Additional options
 * @param {Function} [options.log] - Logging function (default: console.log)
 */
async function applyOperation(client, schema, operation, options = {}) {
  const log = options.log || console.log;
  const opType = Object.keys(operation)[0];
  const opData = operation[opType];
  const qs = quoteIdent(schema);

  switch (opType) {
    case 'drop_column': {
      const exists = await columnExists(client, schema, opData.table, opData.column);
      if (!exists) {
        log(`   [skip] Column ${opData.table}.${opData.column} does not exist`);
        return;
      }
      const sql = `ALTER TABLE ${qs}.${quoteIdent(opData.table)} DROP COLUMN IF EXISTS ${quoteIdent(opData.column)} CASCADE`;
      log(`   [drop_column] ${sql}`);
      await client.query(sql);
      break;
    }

    case 'drop_table': {
      const exists = await tableExists(client, schema, opData.table);
      if (!exists) {
        log(`   [skip] Table ${opData.table} does not exist`);
        return;
      }
      const sql = `DROP TABLE IF EXISTS ${qs}.${quoteIdent(opData.table)} CASCADE`;
      log(`   [drop_table] ${sql}`);
      await client.query(sql);
      break;
    }

    case 'create_table': {
      const exists = await tableExists(client, schema, opData.table);
      if (exists) {
        log(`   [skip] Table ${opData.table} already exists`);
        return;
      }

      const columnDefs = opData.columns.map(col => {
        let def = `${quoteIdent(col.name)} ${col.type}`;
        if (col.primaryKey) def += ' PRIMARY KEY';
        if (!col.nullable && !col.primaryKey) def += ' NOT NULL';
        if (col.default !== undefined && col.default !== null) def += ` DEFAULT ${col.default}`;
        return def;
      }).join(',\n    ');

      const sql = `CREATE TABLE ${qs}.${quoteIdent(opData.table)} (\n    ${columnDefs}\n)`;
      log(`   [create_table] ${opData.table} (${opData.columns.map(c => c.name).join(', ')})`);
      await client.query(sql);

      // Insert seed data if provided
      if (opData.data && Array.isArray(opData.data) && opData.data.length > 0) {
        log(`   [seed] Inserting ${opData.data.length} rows into ${opData.table}...`);
        const columns = Object.keys(opData.data[0]);
        const columnList = columns.map(c => quoteIdent(c)).join(', ');
        const BATCH_SIZE = 100;
        let insertedCount = 0;

        for (let i = 0; i < opData.data.length; i += BATCH_SIZE) {
          const batch = opData.data.slice(i, i + BATCH_SIZE);
          const valueRows = [];
          const params = [];
          let paramIndex = 1;

          for (const row of batch) {
            const placeholders = columns.map(() => `$${paramIndex++}`);
            valueRows.push(`(${placeholders.join(', ')})`);
            columns.forEach(col => {
              let val = row[col];
              if (val === 'true') val = true;
              else if (val === 'false') val = false;
              else if (val === '' || val === 'null' || val === undefined) val = null;
              params.push(val);
            });
          }

          const insertSql = `INSERT INTO ${qs}.${quoteIdent(opData.table)} (${columnList}) VALUES ${valueRows.join(', ')} ON CONFLICT DO NOTHING`;
          await client.query(insertSql, params);
          insertedCount += batch.length;
        }
        log(`   [seed] Inserted ${insertedCount} rows`);
      }
      break;
    }

    case 'add_column': {
      const { table, column } = opData;
      let sql = `ALTER TABLE ${qs}.${quoteIdent(table)} ADD COLUMN IF NOT EXISTS ${quoteIdent(column.name)} ${column.type}`;
      if (column.default !== null && column.default !== undefined) {
        sql += ` DEFAULT ${column.default}`;
      }
      log(`   [add_column] ${table}.${column.name}`);
      await client.query(sql);
      break;
    }

    case 'rename_column': {
      const sql = `ALTER TABLE ${qs}.${quoteIdent(opData.table)} RENAME COLUMN ${quoteIdent(opData.from)} TO ${quoteIdent(opData.to)}`;
      log(`   [rename_column] ${opData.table}.${opData.from} -> ${opData.to}`);
      await client.query(sql);
      break;
    }

    case 'alter_column': {
      const sql = `ALTER TABLE ${qs}.${quoteIdent(opData.table)} ALTER COLUMN ${quoteIdent(opData.column)} TYPE ${opData.type} USING ${quoteIdent(opData.column)}::${opData.type}`;
      log(`   [alter_column] ${opData.table}.${opData.column} -> ${opData.type}`);
      await client.query(sql);
      break;
    }

    case 'rename_table':
    case 'alter_table': {
      const exists = await tableExists(client, schema, opData.from);
      if (!exists) {
        log(`   [skip] Table ${opData.from} does not exist`);
        return;
      }
      const sql = `ALTER TABLE ${qs}.${quoteIdent(opData.from)} RENAME TO ${quoteIdent(opData.to)}`;
      log(`   [rename_table] ${opData.from} -> ${opData.to}`);
      await client.query(sql);
      break;
    }

    case 'set_not_null': {
      const exists = await columnExists(client, schema, opData.table, opData.column);
      if (!exists) {
        log(`   [skip] Column ${opData.table}.${opData.column} does not exist`);
        return;
      }
      const sql = `ALTER TABLE ${qs}.${quoteIdent(opData.table)} ALTER COLUMN ${quoteIdent(opData.column)} SET NOT NULL`;
      log(`   [set_not_null] ${opData.table}.${opData.column}`);
      await client.query(sql);
      break;
    }

    case 'drop_not_null': {
      const exists = await columnExists(client, schema, opData.table, opData.column);
      if (!exists) {
        log(`   [skip] Column ${opData.table}.${opData.column} does not exist`);
        return;
      }
      const sql = `ALTER TABLE ${qs}.${quoteIdent(opData.table)} ALTER COLUMN ${quoteIdent(opData.column)} DROP NOT NULL`;
      log(`   [drop_not_null] ${opData.table}.${opData.column}`);
      await client.query(sql);
      break;
    }

    case 'set_default': {
      const exists = await columnExists(client, schema, opData.table, opData.column);
      if (!exists) {
        log(`   [skip] Column ${opData.table}.${opData.column} does not exist`);
        return;
      }
      const defaultValue = opData.default === null ? 'NULL' : opData.default;
      const sql = `ALTER TABLE ${qs}.${quoteIdent(opData.table)} ALTER COLUMN ${quoteIdent(opData.column)} SET DEFAULT ${defaultValue}`;
      log(`   [set_default] ${opData.table}.${opData.column}`);
      await client.query(sql);
      break;
    }

    case 'drop_default': {
      const exists = await columnExists(client, schema, opData.table, opData.column);
      if (!exists) {
        log(`   [skip] Column ${opData.table}.${opData.column} does not exist`);
        return;
      }
      const sql = `ALTER TABLE ${qs}.${quoteIdent(opData.table)} ALTER COLUMN ${quoteIdent(opData.column)} DROP DEFAULT`;
      log(`   [drop_default] ${opData.table}.${opData.column}`);
      await client.query(sql);
      break;
    }

    case 'raw_sql': {
      if (opData.up) {
        log(`   [raw_sql] Executing custom SQL`);
        await client.query(opData.up);
      }
      break;
    }

    default:
      log(`   [warn] Unknown operation type: ${opType}`);
  }
}

module.exports = {
  tableExists,
  columnExists,
  applyOperation,
};
