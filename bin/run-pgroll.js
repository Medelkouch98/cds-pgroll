#!/usr/bin/env node
'use strict';

/**
 * pgroll Migration Runner — Cloud Foundry Task Entry Point
 *
 * This script is designed to run as a CF task in the pgroll-migrator module.
 * It executes the full 2-phase migration pipeline:
 *   Phase 1: Auto-detect destructive changes (CSN diff)
 *   Phase 2: Apply manual migration JSON files
 *
 * Usage:
 *   node run-pgroll.js
 *   node node_modules/.bin/cds-pgroll run
 *
 * Environment:
 *   VCAP_SERVICES — Cloud Foundry service bindings (required in CF)
 *   CDS_CONFIG    — JSON with db.credentials.schema (optional, falls back to 'public')
 *
 * @module bin/run-pgroll
 */

const path = require('path');
const { run } = require('../src/runner');

// Determine schema from CDS_CONFIG or default
let schema = 'public';
if (process.env.CDS_CONFIG) {
  try {
    const config = JSON.parse(process.env.CDS_CONFIG);
    schema = config.requires?.db?.credentials?.schema || schema;
  } catch {
    console.warn('[run-pgroll] Failed to parse CDS_CONFIG, using default schema');
  }
}

const migrationsDir = __dirname.endsWith('bin')
  ? path.resolve(__dirname, '..') // When running from node_modules/.bin
  : __dirname;                    // When copied to gen/migrations

// csn.json should be in the same directory as this script (copied during build)
const csnPath = path.join(migrationsDir, 'csn.json');

run({
  migrationsDir,
  schema,
  csnPath,
}).then(result => {
  console.log(`\n[run-pgroll] Done: ${result.autoOps} auto + ${result.applied} manual applied, ${result.skipped} skipped`);
  process.exit(0);
}).catch(error => {
  console.error('\n[run-pgroll] Migration failed:', error.message);
  if (process.env.DEBUG) console.error(error.stack);
  process.exit(1);
});
