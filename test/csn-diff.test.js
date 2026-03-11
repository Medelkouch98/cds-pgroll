'use strict';

const { detectSchemaChanges, parseStoredCSN } = require('../src/csn-diff');

describe('csn-diff', () => {
  describe('detectSchemaChanges', () => {
    const silentLog = () => {};

    test('returns empty array for null inputs', () => {
      expect(detectSchemaChanges(null, null)).toEqual([]);
      expect(detectSchemaChanges(null, {})).toEqual([]);
      expect(detectSchemaChanges({}, null)).toEqual([]);
    });

    test('detects dropped entity', () => {
      const oldCSN = {
        definitions: {
          'my.OldEntity': {
            kind: 'entity',
            elements: { id: { type: 'cds.UUID' } },
          },
          'my.KeptEntity': {
            kind: 'entity',
            elements: { id: { type: 'cds.UUID' } },
          },
        },
      };
      const newCSN = {
        definitions: {
          'my.KeptEntity': {
            kind: 'entity',
            elements: { id: { type: 'cds.UUID' } },
          },
        },
      };

      const ops = detectSchemaChanges(oldCSN, newCSN, { log: silentLog });
      expect(ops).toHaveLength(1);
      expect(ops[0]).toEqual({ drop_table: { table: 'my_oldentity' } });
    });

    test('detects dropped column', () => {
      const oldCSN = {
        definitions: {
          'my.Entity': {
            kind: 'entity',
            elements: {
              id: { type: 'cds.UUID' },
              name: { type: 'cds.String' },
              obsolete: { type: 'cds.String' },
            },
          },
        },
      };
      const newCSN = {
        definitions: {
          'my.Entity': {
            kind: 'entity',
            elements: {
              id: { type: 'cds.UUID' },
              name: { type: 'cds.String' },
            },
          },
        },
      };

      const ops = detectSchemaChanges(oldCSN, newCSN, { log: silentLog });
      expect(ops).toHaveLength(1);
      expect(ops[0]).toEqual({
        drop_column: { table: 'my_entity', column: 'obsolete', down: 'SELECT NULL' },
      });
    });

    test('no changes returns empty array', () => {
      const csn = {
        definitions: {
          'my.Entity': {
            kind: 'entity',
            elements: { id: { type: 'cds.UUID' }, name: { type: 'cds.String' } },
          },
        },
      };
      expect(detectSchemaChanges(csn, csn, { log: silentLog })).toEqual([]);
    });

    test('skips views (entities with query)', () => {
      const oldCSN = {
        definitions: {
          'my.View': { kind: 'entity', query: 'SELECT from my.Entity', elements: {} },
        },
      };
      const newCSN = { definitions: {} };
      expect(detectSchemaChanges(oldCSN, newCSN, { log: silentLog })).toEqual([]);
    });

    test('skips entities with @cds.persistence.skip', () => {
      const oldCSN = {
        definitions: {
          'my.SkippedEntity': { kind: 'entity', '@cds.persistence.skip': true, elements: {} },
        },
      };
      const newCSN = { definitions: {} };
      expect(detectSchemaChanges(oldCSN, newCSN, { log: silentLog })).toEqual([]);
    });

    test('skips virtual elements', () => {
      const oldCSN = {
        definitions: {
          'my.Entity': {
            kind: 'entity',
            elements: {
              id: { type: 'cds.UUID' },
              virtualField: { type: 'cds.String', virtual: true },
            },
          },
        },
      };
      const newCSN = {
        definitions: {
          'my.Entity': {
            kind: 'entity',
            elements: {
              id: { type: 'cds.UUID' },
              // virtualField removed but was virtual, shouldn't trigger drop
            },
          },
        },
      };
      expect(detectSchemaChanges(oldCSN, newCSN, { log: silentLog })).toEqual([]);
    });

    test('respects @cds.persistence.name for table naming', () => {
      const oldCSN = {
        definitions: {
          'my.Entity': {
            kind: 'entity',
            '@cds.persistence.name': 'CUSTOM_TABLE',
            elements: { id: { type: 'cds.UUID' } },
          },
        },
      };
      const newCSN = { definitions: {} };

      const ops = detectSchemaChanges(oldCSN, newCSN, { log: silentLog });
      expect(ops[0]).toEqual({ drop_table: { table: 'custom_table' } });
    });

    test('detects multiple drops at once', () => {
      const oldCSN = {
        definitions: {
          'my.Entity1': {
            kind: 'entity',
            elements: { id: { type: 'cds.UUID' }, col1: { type: 'cds.String' }, col2: { type: 'cds.String' } },
          },
          'my.Entity2': {
            kind: 'entity',
            elements: { id: { type: 'cds.UUID' } },
          },
        },
      };
      const newCSN = {
        definitions: {
          'my.Entity1': {
            kind: 'entity',
            elements: { id: { type: 'cds.UUID' } }, // col1 and col2 removed
          },
          // Entity2 removed entirely
        },
      };

      const ops = detectSchemaChanges(oldCSN, newCSN, { log: silentLog });
      expect(ops).toHaveLength(3); // 2 drop_column + 1 drop_table
      expect(ops.filter(op => op.drop_column)).toHaveLength(2);
      expect(ops.filter(op => op.drop_table)).toHaveLength(1);
    });
  });

  describe('parseStoredCSN', () => {
    test('parses JSON string', () => {
      const csn = { definitions: { 'my.Entity': { kind: 'entity' } } };
      const result = parseStoredCSN(JSON.stringify(csn));
      expect(result).toEqual(csn);
    });

    test('returns object as-is', () => {
      const csn = { definitions: {} };
      expect(parseStoredCSN(csn)).toBe(csn);
    });

    test('returns null for null/undefined input', () => {
      expect(parseStoredCSN(null)).toBeNull();
      expect(parseStoredCSN(undefined)).toBeNull();
    });

    test('returns null for invalid JSON string', () => {
      expect(parseStoredCSN('not valid json{{')).toBeNull();
    });

    test('returns null for empty string', () => {
      expect(parseStoredCSN('')).toBeNull();
    });
  });
});
