'use strict';

/**
 * CDS → PostgreSQL Type Mapping
 *
 * Single source of truth for mapping CDS types to the PostgreSQL types
 * that @cap-js/postgres actually generates. This ensures pgroll migrations
 * create columns with types consistent with CAP's schema evolution.
 *
 * @module src/types
 * @see https://cap.cloud.sap/docs/guides/databases/postgres#type-mapping
 */

/**
 * Map of CDS types to PostgreSQL type generator functions.
 * Each function receives the CDS element definition and returns
 * the SQL type string that @cap-js/postgres would generate.
 */
const CDS_TO_PG = {
  'cds.String':       (el) => `VARCHAR(${el.length || 255})`,
  'cds.LargeString':  ()   => 'TEXT',
  'cds.Integer':      ()   => 'INTEGER',
  'cds.Int':          ()   => 'INTEGER',
  'cds.Int32':        ()   => 'INTEGER',
  'cds.Int64':        ()   => 'BIGINT',
  'cds.UInt8':        ()   => 'SMALLINT',
  'cds.UInt16':       ()   => 'INTEGER',
  'cds.UInt32':       ()   => 'BIGINT',
  'cds.Decimal':      (el) => `DECIMAL(${el.precision || 18}, ${el.scale || 2})`,
  'cds.DecimalFloat': (el) => `DECIMAL(${el.precision || 18}, ${el.scale || 2})`,
  'cds.Double':       ()   => 'FLOAT8',
  'cds.Float':        ()   => 'FLOAT8',
  'cds.Boolean':      ()   => 'BOOLEAN',
  'cds.Date':         ()   => 'DATE',
  'cds.Time':         ()   => 'TIME',
  'cds.DateTime':     ()   => 'TIMESTAMP',
  'cds.Timestamp':    ()   => 'TIMESTAMP',
  'cds.UUID':         ()   => 'VARCHAR(36)',
  'cds.Binary':       (el) => `BYTEA`,
  'cds.LargeBinary':  ()   => 'BYTEA',
};

/**
 * Convert a CDS type + element definition to the PostgreSQL SQL type
 * that @cap-js/postgres generates.
 *
 * @param {string} type - CDS type (e.g., 'cds.String', 'cds.UUID')
 * @param {Object} element - CDS element definition with optional length, precision, scale
 * @returns {string} PostgreSQL type string
 */
function cdsTypeToSql(type, element = {}) {
  const baseType = type || 'cds.String';
  const mapper = CDS_TO_PG[baseType];
  return mapper ? mapper(element) : `VARCHAR(${element.length || 255})`;
}

/**
 * Format a CDS default value for PostgreSQL DDL.
 *
 * @param {Object} element - CDS element definition
 * @returns {string} SQL DEFAULT clause (empty string if no default)
 */
function formatDefault(element) {
  const def = element.default;
  if (def === undefined || def === null) return '';
  const value = typeof def === 'object' && 'val' in def ? def.val : def;
  if (typeof value === 'boolean') return value ? ' DEFAULT TRUE' : ' DEFAULT FALSE';
  if (typeof value === 'number') return ` DEFAULT ${value}`;
  if (value === null) return ' DEFAULT NULL';
  return ` DEFAULT '${String(value).replace(/'/g, "''")}'`;
}

module.exports = {
  CDS_TO_PG,
  cdsTypeToSql,
  formatDefault,
};
