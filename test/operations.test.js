'use strict';

const { applyOperation, tableExists, columnExists } = require('../src/operations');

describe('operations', () => {
  // Mock pg client
  function createMockClient(queryResults = {}) {
    const queries = [];
    return {
      queries,
      query: jest.fn(async (sql, params) => {
        queries.push({ sql, params });
        // Return matching mock result or default
        for (const [pattern, result] of Object.entries(queryResults)) {
          if (sql.includes(pattern)) return result;
        }
        return { rows: [{ exists: false }], rowCount: 0 };
      }),
    };
  }

  describe('tableExists', () => {
    test('returns true when table exists', async () => {
      const client = createMockClient({
        'information_schema.tables': { rows: [{ exists: true }] },
      });
      const result = await tableExists(client, 'my_schema', 'my_table');
      expect(result).toBe(true);
    });

    test('returns false when table does not exist', async () => {
      const client = createMockClient({
        'information_schema.tables': { rows: [{ exists: false }] },
      });
      const result = await tableExists(client, 'my_schema', 'no_table');
      expect(result).toBe(false);
    });
  });

  describe('columnExists', () => {
    test('returns true when column exists', async () => {
      const client = createMockClient({
        'information_schema.columns': { rows: [{ exists: true }] },
      });
      const result = await columnExists(client, 'my_schema', 'my_table', 'my_col');
      expect(result).toBe(true);
    });

    test('returns false when column does not exist', async () => {
      const client = createMockClient({
        'information_schema.columns': { rows: [{ exists: false }] },
      });
      const result = await columnExists(client, 'my_schema', 'my_table', 'no_col');
      expect(result).toBe(false);
    });
  });

  describe('applyOperation', () => {
    const schema = 'test_schema';
    const opts = { log: () => {} };

    test('drop_column executes ALTER TABLE DROP COLUMN', async () => {
      const client = createMockClient({
        'information_schema.columns': { rows: [{ exists: true }] },
      });
      const op = { drop_column: { table: 'my_table', column: 'old_col', down: 'SELECT NULL' } };
      await applyOperation(client, schema, op, opts);
      const dropQuery = client.queries.find(q => q.sql.includes('DROP COLUMN'));
      expect(dropQuery).toBeDefined();
      expect(dropQuery.sql).toContain('"my_table"');
      expect(dropQuery.sql).toContain('"old_col"');
    });

    test('drop_column skips non-existent column', async () => {
      const client = createMockClient();
      const op = { drop_column: { table: 'my_table', column: 'missing', down: 'SELECT NULL' } };
      await applyOperation(client, schema, op, opts);
      const dropQuery = client.queries.find(q => q.sql.includes('DROP COLUMN'));
      expect(dropQuery).toBeUndefined();
    });

    test('drop_table executes DROP TABLE IF EXISTS', async () => {
      const client = createMockClient({
        'information_schema.tables': { rows: [{ exists: true }] },
      });
      const op = { drop_table: { table: 'old_table' } };
      await applyOperation(client, schema, op, opts);
      const dropQuery = client.queries.find(q => q.sql.includes('DROP TABLE'));
      expect(dropQuery).toBeDefined();
      expect(dropQuery.sql).toContain('"old_table"');
    });

    test('rename_column executes RENAME COLUMN', async () => {
      const client = createMockClient();
      const op = { rename_column: { table: 't', from: 'old_name', to: 'new_name' } };
      await applyOperation(client, schema, op, opts);
      const renameQuery = client.queries.find(q => q.sql.includes('RENAME COLUMN'));
      expect(renameQuery).toBeDefined();
      expect(renameQuery.sql).toContain('"old_name"');
      expect(renameQuery.sql).toContain('"new_name"');
    });

    test('rename_table executes ALTER TABLE RENAME', async () => {
      const client = createMockClient({
        'information_schema.tables': { rows: [{ exists: true }] },
      });
      const op = { rename_table: { from: 'old_t', to: 'new_t' } };
      await applyOperation(client, schema, op, opts);
      const renameQuery = client.queries.find(q => q.sql.includes('RENAME TO'));
      expect(renameQuery).toBeDefined();
      expect(renameQuery.sql).toContain('"old_t"');
      expect(renameQuery.sql).toContain('"new_t"');
    });

    test('set_not_null executes SET NOT NULL', async () => {
      const client = createMockClient({
        'information_schema.columns': { rows: [{ exists: true }] },
      });
      const op = { set_not_null: { table: 't', column: 'c' } };
      await applyOperation(client, schema, op, opts);
      const query = client.queries.find(q => q.sql.includes('SET NOT NULL'));
      expect(query).toBeDefined();
    });

    test('drop_not_null executes DROP NOT NULL', async () => {
      const client = createMockClient({
        'information_schema.columns': { rows: [{ exists: true }] },
      });
      const op = { drop_not_null: { table: 't', column: 'c' } };
      await applyOperation(client, schema, op, opts);
      const query = client.queries.find(q => q.sql.includes('DROP NOT NULL'));
      expect(query).toBeDefined();
    });

    test('raw_sql executes the provided SQL', async () => {
      const client = createMockClient();
      const op = { raw_sql: { up: 'CREATE INDEX idx ON my_table(col)' } };
      await applyOperation(client, schema, op, opts);
      const query = client.queries.find(q => q.sql.includes('CREATE INDEX'));
      expect(query).toBeDefined();
    });

    test('unknown operation type logs warning', async () => {
      const client = createMockClient();
      const warnings = [];
      const op = { unknown_op: { table: 't' } };
      await applyOperation(client, schema, op, { log: (msg) => warnings.push(msg) });
      expect(warnings.some(w => w.includes('Unknown'))).toBe(true);
    });
  });
});
