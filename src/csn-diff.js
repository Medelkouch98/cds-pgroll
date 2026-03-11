'use strict';

/**
 * CSN Diff — Detect Destructive Schema Changes
 *
 * Compares two CAP CSN objects (old/deployed vs new/to-deploy) to detect
 * removed entities and removed elements. These require pgroll migrations
 * because @cap-js/postgres (schema_evolution: alter) cannot DROP.
 *
 * IMPORTANT: The old CSN (from cds_model table) and new CSN (from cds build)
 * may have different internal formats (resolved vs compiled types). This module
 * compares only entity/element **presence** — not types, which are CAP's domain.
 *
 * @module src/csn-diff
 */

const { entityToTableName, elementToColumnName } = require('./naming');

/**
 * Detect entities/elements that were removed between two CSN versions.
 * Returns an array of pgroll operations (drop_table, drop_column).
 *
 * @param {Object} oldCSN - Previously deployed CSN (from cds_model table, parsed)
 * @param {Object} newCSN - New CSN to deploy (from cds build, csn.json)
 * @param {Object} [options]
 * @param {Function} [options.log] - Logging function (default: console.log)
 * @returns {Array} Array of pgroll operations
 */
function detectSchemaChanges(oldCSN, newCSN, options = {}) {
  const log = options.log || console.log;
  const operations = [];

  if (!oldCSN || !newCSN) {
    return operations;
  }

  const oldDefs = oldCSN.definitions || {};
  const newDefs = newCSN.definitions || {};

  // Build set of persistent entities in the NEW model
  const newEntityNames = new Set(
    Object.keys(newDefs).filter(name => {
      const def = newDefs[name];
      return def.kind === 'entity' && !def.query && !def['@cds.persistence.skip'];
    })
  );

  // Check for removed entities and removed elements
  for (const [entityName, oldDef] of Object.entries(oldDefs)) {
    if (oldDef.kind !== 'entity' || oldDef.query || oldDef['@cds.persistence.skip']) {
      continue;
    }

    const tableName = entityToTableName(entityName, oldDef);

    if (!newEntityNames.has(entityName)) {
      log(`  [delta] DROP TABLE ${tableName} (entity ${entityName} removed)`);
      operations.push({
        drop_table: { table: tableName }
      });
      continue;
    }

    const newDef = newDefs[entityName];
    const oldElements = oldDef.elements || {};
    const newElements = newDef.elements || {};
    const newElementNames = new Set(Object.keys(newElements));

    for (const [elemName, oldElem] of Object.entries(oldElements)) {
      if (oldElem.virtual) continue;

      if (!newElementNames.has(elemName)) {
        const columnName = elementToColumnName(elemName, oldElem);
        log(`  [delta] DROP COLUMN ${tableName}.${columnName}`);
        operations.push({
          drop_column: {
            table: tableName,
            column: columnName,
            down: 'SELECT NULL'
          }
        });
      }
    }
  }

  return operations;
}

/**
 * Parse the CSN stored in cds_model table.
 * The cds_model table stores CSN as a TEXT column, so it may
 * need JSON.parse() depending on the database driver.
 *
 * @param {*} raw - Raw value from cds_model.csn column
 * @returns {Object|null} Parsed CSN object
 */
function parseStoredCSN(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }
  return raw; // Already an object (some drivers auto-parse JSONB)
}

module.exports = {
  detectSchemaChanges,
  parseStoredCSN,
};
