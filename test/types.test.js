'use strict';

const { cdsTypeToSql, formatDefault, CDS_TO_PG } = require('../src/types');

describe('types', () => {
  describe('cdsTypeToSql', () => {
    test('UUID maps to VARCHAR(36)', () => {
      expect(cdsTypeToSql('cds.UUID')).toBe('VARCHAR(36)');
    });

    test('String with length', () => {
      expect(cdsTypeToSql('cds.String', { length: 100 })).toBe('VARCHAR(100)');
    });

    test('String without length defaults to 255', () => {
      expect(cdsTypeToSql('cds.String', {})).toBe('VARCHAR(255)');
    });

    test('LargeString maps to TEXT', () => {
      expect(cdsTypeToSql('cds.LargeString')).toBe('TEXT');
    });

    test('Integer types', () => {
      expect(cdsTypeToSql('cds.Integer')).toBe('INTEGER');
      expect(cdsTypeToSql('cds.Int')).toBe('INTEGER');
      expect(cdsTypeToSql('cds.Int32')).toBe('INTEGER');
      expect(cdsTypeToSql('cds.Int64')).toBe('BIGINT');
      expect(cdsTypeToSql('cds.UInt8')).toBe('SMALLINT');
      expect(cdsTypeToSql('cds.UInt16')).toBe('INTEGER');
      expect(cdsTypeToSql('cds.UInt32')).toBe('BIGINT');
    });

    test('Decimal with precision and scale', () => {
      expect(cdsTypeToSql('cds.Decimal', { precision: 10, scale: 3 })).toBe('DECIMAL(10, 3)');
    });

    test('Decimal defaults', () => {
      expect(cdsTypeToSql('cds.Decimal', {})).toBe('DECIMAL(18, 2)');
    });

    test('Double and Float map to FLOAT8', () => {
      expect(cdsTypeToSql('cds.Double')).toBe('FLOAT8');
      expect(cdsTypeToSql('cds.Float')).toBe('FLOAT8');
    });

    test('Boolean maps to BOOLEAN', () => {
      expect(cdsTypeToSql('cds.Boolean')).toBe('BOOLEAN');
    });

    test('Date/Time types', () => {
      expect(cdsTypeToSql('cds.Date')).toBe('DATE');
      expect(cdsTypeToSql('cds.Time')).toBe('TIME');
      expect(cdsTypeToSql('cds.DateTime')).toBe('TIMESTAMP');
      expect(cdsTypeToSql('cds.Timestamp')).toBe('TIMESTAMP');
    });

    test('Binary types', () => {
      expect(cdsTypeToSql('cds.Binary')).toBe('BYTEA');
      expect(cdsTypeToSql('cds.LargeBinary')).toBe('BYTEA');
    });

    test('Unknown type falls back to VARCHAR', () => {
      expect(cdsTypeToSql('cds.Unknown', { length: 50 })).toBe('VARCHAR(50)');
      expect(cdsTypeToSql('cds.Unknown', {})).toBe('VARCHAR(255)');
    });

    test('Null/undefined type falls back', () => {
      expect(cdsTypeToSql(null)).toBe('VARCHAR(255)');
      expect(cdsTypeToSql(undefined)).toBe('VARCHAR(255)');
    });
  });

  describe('formatDefault', () => {
    test('no default returns empty string', () => {
      expect(formatDefault({})).toBe('');
      expect(formatDefault({ default: undefined })).toBe('');
      expect(formatDefault({ default: null })).toBe('');
    });

    test('boolean defaults', () => {
      expect(formatDefault({ default: true })).toBe(' DEFAULT TRUE');
      expect(formatDefault({ default: false })).toBe(' DEFAULT FALSE');
    });

    test('number defaults', () => {
      expect(formatDefault({ default: 42 })).toBe(' DEFAULT 42');
      expect(formatDefault({ default: 3.14 })).toBe(' DEFAULT 3.14');
    });

    test('string defaults with single quote escaping', () => {
      expect(formatDefault({ default: 'hello' })).toBe(" DEFAULT 'hello'");
      expect(formatDefault({ default: "it's" })).toBe(" DEFAULT 'it''s'");
    });

    test('CDS default object { val: ... }', () => {
      expect(formatDefault({ default: { val: 'active' } })).toBe(" DEFAULT 'active'");
      expect(formatDefault({ default: { val: 42 } })).toBe(' DEFAULT 42');
      expect(formatDefault({ default: { val: true } })).toBe(' DEFAULT TRUE');
      expect(formatDefault({ default: { val: null } })).toBe(' DEFAULT NULL');
    });
  });

  describe('CDS_TO_PG map', () => {
    test('contains all expected CDS types', () => {
      const expectedTypes = [
        'cds.String', 'cds.LargeString', 'cds.Integer', 'cds.Int', 'cds.Int32',
        'cds.Int64', 'cds.UInt8', 'cds.UInt16', 'cds.UInt32', 'cds.Decimal',
        'cds.DecimalFloat', 'cds.Double', 'cds.Float', 'cds.Boolean',
        'cds.Date', 'cds.Time', 'cds.DateTime', 'cds.Timestamp',
        'cds.UUID', 'cds.Binary', 'cds.LargeBinary',
      ];
      for (const type of expectedTypes) {
        expect(CDS_TO_PG[type]).toBeDefined();
        expect(typeof CDS_TO_PG[type]).toBe('function');
      }
    });
  });
});
