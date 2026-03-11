'use strict';

const { entityToTableName, elementToColumnName, quoteIdent, entityToCsvFileName } = require('../src/naming');

describe('naming', () => {
  describe('entityToTableName', () => {
    test('converts dots to underscores and lowercases', () => {
      expect(entityToTableName('cap.tva.db.FinancialDocuments'))
        .toBe('cap_tva_db_financialdocuments');
    });

    test('single-level entity name', () => {
      expect(entityToTableName('MyEntity')).toBe('myentity');
    });

    test('respects @cds.persistence.name annotation', () => {
      const def = { '@cds.persistence.name': 'MY_CUSTOM_TABLE' };
      expect(entityToTableName('cap.tva.db.Something', def)).toBe('my_custom_table');
    });

    test('falls back when no annotation', () => {
      expect(entityToTableName('cap.tva.db.TvaCode', {})).toBe('cap_tva_db_tvacode');
    });

    test('handles undefined def gracefully', () => {
      expect(entityToTableName('a.b.c')).toBe('a_b_c');
      expect(entityToTableName('a.b.c', undefined)).toBe('a_b_c');
      expect(entityToTableName('a.b.c', null)).toBe('a_b_c');
    });
  });

  describe('elementToColumnName', () => {
    test('lowercases element names', () => {
      expect(elementToColumnName('PaymentCategory')).toBe('paymentcategory');
    });

    test('flattens structured types (dots to underscores)', () => {
      expect(elementToColumnName('address.street')).toBe('address_street');
    });

    test('respects @cds.persistence.name', () => {
      const elem = { '@cds.persistence.name': 'MY_COL' };
      expect(elementToColumnName('myCol', elem)).toBe('my_col');
    });

    test('handles undefined elem', () => {
      expect(elementToColumnName('amount')).toBe('amount');
    });
  });

  describe('quoteIdent', () => {
    test('wraps identifier in double quotes', () => {
      expect(quoteIdent('my_table')).toBe('"my_table"');
    });

    test('escapes double quotes inside identifier', () => {
      expect(quoteIdent('my"table')).toBe('"my""table"');
    });

    test('handles reserved words', () => {
      expect(quoteIdent('order')).toBe('"order"');
      expect(quoteIdent('user')).toBe('"user"');
      expect(quoteIdent('select')).toBe('"select"');
    });

    test('handles empty string', () => {
      expect(quoteIdent('')).toBe('""');
    });
  });

  describe('entityToCsvFileName', () => {
    test('converts fully qualified name to CSV filename', () => {
      expect(entityToCsvFileName('cap.tva.db.TvaCode')).toBe('cap.tva.db-TvaCode.csv');
    });

    test('two-level name', () => {
      expect(entityToCsvFileName('my.Entity')).toBe('my-Entity.csv');
    });

    test('single name (no namespace)', () => {
      expect(entityToCsvFileName('Entity')).toBe('-Entity.csv');
    });

    test('deep namespace', () => {
      expect(entityToCsvFileName('a.b.c.d.MyTable')).toBe('a.b.c.d-MyTable.csv');
    });
  });
});
