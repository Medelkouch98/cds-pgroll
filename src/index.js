'use strict';

/**
 * @cds-pgroll/postgres
 *
 * Complementary migration toolkit for @cap-js/postgres.
 * Handles destructive DDL operations (DROP, RENAME) that CAP's
 * schema_evolution: 'alter' cannot perform.
 *
 * @module @cds-pgroll/postgres
 */

// --- Core utilities ---
const { cdsTypeToSql, formatDefault, CDS_TO_PG } = require('./types');
const { entityToTableName, elementToColumnName, quoteIdent, entityToCsvFileName } = require('./naming');

// --- Migration operations ---
const { applyOperation, tableExists, columnExists } = require('./operations');

// --- CSN comparison ---
const { detectSchemaChanges, parseStoredCSN } = require('./csn-diff');

// --- SQL helpers ---
const { PgRollSql } = require('./sql');

// --- Migration runner ---
const { run: runMigrations } = require('./runner');

// --- Migration generator ---
const {
  generate,
  getAvailableEntities,
  saveSnapshot,
  generateOperationsFromSnapshot,
  generateMigrationFileName,
  readCsvData,
} = require('./generator');

// --- Deployer preparation ---
const {
  prepare: prepareDeployer,
  prepareDataFiles,
  updatePackageJson: updateDeployerPackageJson,
  discoverTablesFromCSV,
  csvToTableName,
} = require('./deployer');

module.exports = {
  // Types
  cdsTypeToSql,
  formatDefault,
  CDS_TO_PG,

  // Naming
  entityToTableName,
  elementToColumnName,
  quoteIdent,
  entityToCsvFileName,

  // Operations
  applyOperation,
  tableExists,
  columnExists,

  // CSN diff
  detectSchemaChanges,
  parseStoredCSN,

  // SQL
  PgRollSql,

  // Runner
  runMigrations,

  // Generator
  generate,
  getAvailableEntities,
  saveSnapshot,
  generateOperationsFromSnapshot,
  generateMigrationFileName,
  readCsvData,

  // Deployer
  prepareDeployer,
  prepareDataFiles,
  updateDeployerPackageJson,
  discoverTablesFromCSV,
  csvToTableName,
};
