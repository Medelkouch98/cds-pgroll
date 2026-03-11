'use strict';

/**
 * CAP PostgreSQL Deployer Preparation
 *
 * Prepares the gen/pg deployer artefact for safe production deployment:
 * - Strips CSV data rows to prevent duplicate key errors with schema_evolution: 'alter'
 * - Configures package.json with correct CDS settings
 * - Removes hardcoded credentials (CF uses VCAP_SERVICES bindings)
 *
 * Used as an MTA build step before the db-deployer module is packaged.
 *
 * @module src/deployer
 */

const fs = require('fs');
const path = require('path');

/**
 * Convert CSV filename to PostgreSQL table name.
 *
 * @param {string} csvFilename - e.g. "cap.tva.db-UserAuthorization.csv"
 * @returns {string} - e.g. "CAP_TVA_DB_USERAUTHORIZATION"
 */
function csvToTableName(csvFilename) {
  return csvFilename.replace('.csv', '').replace(/[.-]/g, '_').toUpperCase();
}

/**
 * Discover all tables from CSV files in a data directory.
 *
 * @param {string} dataDir - Path to the directory containing CSV files
 * @returns {Array<{csvFile: string, tableName: string}>}
 */
function discoverTablesFromCSV(dataDir) {
  if (!fs.existsSync(dataDir)) {
    console.log('  [deployer] No data directory found');
    return [];
  }

  const csvFiles = fs.readdirSync(dataDir).filter(f => f.endsWith('.csv'));
  const tables = csvFiles.map(csvFile => ({
    csvFile,
    tableName: csvToTableName(csvFile),
  }));

  console.log(`  [deployer] Discovered ${tables.length} tables from CSV files`);
  tables.forEach(t => console.log(`    ${t.csvFile} -> ${t.tableName}`));
  return tables;
}

/**
 * Strip CSV data rows, keeping only headers.
 *
 * With `schema_evolution: 'alter'`, CAP uses INSERT (not UPSERT).
 * On redeployment this causes duplicate key errors. By stripping
 * data rows, tables are created with correct schema but no seed
 * data conflicts.
 *
 * @param {string} dataDir - Path to gen/pg/db/data/
 * @returns {Array<{csvFile: string, tableName: string}>} Discovered tables
 */
function prepareDataFiles(dataDir) {
  if (!fs.existsSync(dataDir)) {
    console.log('  [deployer] No data directory found, skipping CSV preparation');
    return [];
  }

  const tables = discoverTablesFromCSV(dataDir);
  const csvFiles = fs.readdirSync(dataDir).filter(f => f.endsWith('.csv'));

  console.log('  [deployer] Stripping CSV data (header-only):');
  for (const csvFile of csvFiles) {
    const csvPath = path.join(dataDir, csvFile);
    const content = fs.readFileSync(csvPath, 'utf-8');
    const lines = content.trim().split('\n');

    if (lines.length > 1) {
      fs.writeFileSync(csvPath, lines[0] + '\n');
      console.log(`    ${csvFile}: stripped ${lines.length - 1} data rows`);
    } else {
      console.log(`    ${csvFile}: already header-only`);
    }
  }

  return tables;
}

/**
 * Update the deployer package.json with correct CDS configuration.
 *
 * @param {string} packageJsonPath - Path to gen/pg/package.json
 * @param {Object} options
 * @param {string} options.schema - PostgreSQL schema name
 * @param {string} [options.schemaEvolution='alter'] - CDS schema_evolution mode
 * @param {boolean} [options.modelOnly=false] - Use cds-deploy --model-only
 * @param {Array} [options.tables] - Discovered tables (for logging)
 */
function updatePackageJson(packageJsonPath, options) {
  const { schema, schemaEvolution = 'alter', modelOnly = false, tables = [] } = options;

  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`Cannot find deployer package.json at ${packageJsonPath}`);
  }

  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
  pkg.scripts = pkg.scripts || {};
  pkg.scripts.start = modelOnly ? 'cds-deploy --model-only' : 'cds-deploy';

  // Remove obsolete prestart hook if present
  if (pkg.scripts.prestart) delete pkg.scripts.prestart;

  // Configure CDS
  pkg.cds = pkg.cds || {};
  pkg.cds.requires = pkg.cds.requires || {};
  pkg.cds.requires.db = pkg.cds.requires.db || {};

  // Remove hardcoded credentials — CF uses VCAP_SERVICES bindings
  delete pkg.cds.requires.db.credentials;

  pkg.cds.requires.db.schema = schema;
  pkg.cds.requires.db.schema_evolution = schemaEvolution;

  fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n');

  console.log(`  [deployer] Updated package.json:`);
  console.log(`    schema: ${schema}`);
  console.log(`    schema_evolution: ${schemaEvolution}`);
  console.log(`    start: cds-deploy`);

  if (tables.length > 0) {
    console.log(`  [deployer] ${tables.length} tables will be managed`);
  }
}

/**
 * Run the full deployer preparation pipeline.
 *
 * @param {Object} options
 * @param {string} options.projectRoot - Root of the CAP project
 * @param {string} options.schema - PostgreSQL schema name
 * @param {string} [options.schemaEvolution='alter'] - Schema evolution mode
 * @param {boolean} [options.modelOnly=false] - Use cds-deploy --model-only
 * @param {string} [options.deployerDir] - Path to gen/pg (auto-detected if omitted)
 */
function prepare(options) {
  const {
    projectRoot,
    schema,
    schemaEvolution = 'alter',
    modelOnly = false,
    deployerDir = path.join(projectRoot, 'gen', 'pg'),
  } = options;

  const dataDir = path.join(deployerDir, 'db', 'data');
  const packageJsonPath = path.join(deployerDir, 'package.json');

  console.log('  [deployer] Preparing CAP PostgreSQL deployer');
  console.log(`    Schema: ${schema}`);
  console.log(`    Evolution: ${schemaEvolution}`);
  console.log(`    Deployer: ${deployerDir}`);

  const tables = prepareDataFiles(dataDir);
  updatePackageJson(packageJsonPath, { schema, schemaEvolution, modelOnly, tables });

  console.log('  [deployer] Preparation complete');
  return { tables, deployerDir };
}

module.exports = {
  prepare,
  prepareDataFiles,
  updatePackageJson,
  discoverTablesFromCSV,
  csvToTableName,
};
