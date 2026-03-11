'use strict';

/**
 * CDS Entity → PostgreSQL Table Name Conversion
 *
 * Handles the translation between CDS entity names and PostgreSQL table names,
 * respecting the @cds.persistence.name annotation and CAP's default "plain" naming.
 *
 * @module src/naming
 */

/**
 * Convert a CDS entity name to a PostgreSQL table name.
 *
 * Respects the @cds.persistence.name annotation when present in the CSN definition.
 * Falls back to CAP's default "plain" naming: replace dots with underscores, lowercase.
 *
 * @param {string} entityName - Fully qualified CDS entity name (e.g., "cap.tva.db.FinancialDocuments")
 * @param {Object} [def] - CSN entity definition (may contain @cds.persistence.name)
 * @returns {string} PostgreSQL table name (lowercase)
 *
 * @example
 * entityToTableName('cap.tva.db.FinancialDocuments')
 * // → 'cap_tva_db_financialdocuments'
 *
 * entityToTableName('my.Entity', { '@cds.persistence.name': 'MY_CUSTOM_TABLE' })
 * // → 'my_custom_table'
 */
function entityToTableName(entityName, def) {
  if (def?.['@cds.persistence.name']) {
    return def['@cds.persistence.name'].toLowerCase();
  }
  return entityName.replace(/\./g, '_').toLowerCase();
}

/**
 * Convert a CDS element name to a PostgreSQL column name.
 *
 * Handles association flattening (address.street → address_street)
 * and respects @cds.persistence.name on elements.
 *
 * @param {string} elemName - CDS element name
 * @param {Object} [elem] - CDS element definition
 * @returns {string} PostgreSQL column name (lowercase)
 */
function elementToColumnName(elemName, elem) {
  if (elem?.['@cds.persistence.name']) {
    return elem['@cds.persistence.name'].toLowerCase();
  }
  // Handle structured type flattening (dots → underscores)
  return elemName.replace(/\./g, '_').toLowerCase();
}

/**
 * Quote a PostgreSQL identifier to safely handle reserved words and special characters.
 *
 * @param {string} identifier - Table or column name
 * @returns {string} Double-quoted identifier
 *
 * @example
 * quoteIdent('order')    // → '"order"'
 * quoteIdent('my_table') // → '"my_table"'
 */
function quoteIdent(identifier) {
  return '"' + identifier.replace(/"/g, '""') + '"';
}

/**
 * Convert a CDS entity name to the CSV data file name.
 * CAP convention: namespace-EntityName.csv
 *
 * @param {string} entityName - Fully qualified CDS entity name
 * @returns {string} CSV filename
 *
 * @example
 * entityToCsvFileName('cap.tva.db.TvaCode')
 * // → 'cap.tva.db-TvaCode.csv'
 */
function entityToCsvFileName(entityName) {
  const parts = entityName.split('.');
  const tablePart = parts.pop();
  const namespacePart = parts.join('.');
  return `${namespacePart}-${tablePart}.csv`;
}

module.exports = {
  entityToTableName,
  elementToColumnName,
  quoteIdent,
  entityToCsvFileName,
};
