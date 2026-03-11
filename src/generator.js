'use strict';

/**
 * pgroll Migration Generator
 *
 * Interactive CLI tool to generate pgroll migration JSON files from the CDS model.
 * Integrates with CAP's native schema evolution — generates migrations only for
 * operations that @cap-js/postgres cannot handle (DROP, RENAME).
 *
 * @module src/generator
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { cdsTypeToSql } = require('./types');
const { entityToTableName, entityToCsvFileName } = require('./naming');

/**
 * Create interactive readline interface.
 * @returns {readline.Interface}
 */
function createReadlineInterface() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

/**
 * Prompt user for input.
 * @param {readline.Interface} rl
 * @param {string} question
 * @returns {Promise<string>}
 */
function prompt(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

/**
 * Display migration type menu and get selection.
 * @param {readline.Interface} rl
 * @returns {Promise<number>}
 */
async function showMenu(rl) {
  console.log('\n  Select migration type:\n');
  console.log('  1.  drop_column     - Remove a column from a table');
  console.log('  2.  drop_table      - Remove an entire table');
  console.log('  3.  rename_column   - Rename a column');
  console.log('  4.  rename_table    - Rename a table');
  console.log('  5.  alter_column    - Change column type');
  console.log('  6.  add_column      - Add a new column');
  console.log('  7.  set_not_null    - Add NOT NULL constraint');
  console.log('  8.  drop_not_null   - Remove NOT NULL constraint');
  console.log('  9.  set_default     - Set column default value');
  console.log('  10. drop_default    - Remove column default');
  console.log('  11. create_table    - Create a new table (from schema.cds)');
  console.log('  12. auto_detect     - Compare CDS model with snapshot');
  console.log('  0.  exit            - Cancel and exit\n');
  const choice = await prompt(rl, 'Enter your choice (0-12): ');
  return parseInt(choice, 10);
}

/**
 * Load CDS model and extract available entities with column info.
 *
 * @param {Object} cds - CAP CDS module (require('@sap/cds'))
 * @param {string} schemaPath - Path to db/schema.cds
 * @returns {Promise<Array>} Array of { name, tableName, columns }
 */
async function getAvailableEntities(cds, schemaPath) {
  const model = await cds.load(schemaPath);
  const reflection = cds.reflect(model);
  const entities = [];

  for (const [name, def] of Object.entries(reflection.definitions)) {
    if (def.kind !== 'entity' || def.query || def['@cds.persistence.skip']) continue;

    const columns = [];
    for (const [elemName, elem] of Object.entries(def.elements || {})) {
      if (elem.virtual) continue;
      columns.push({
        name: elemName,
        columnName: elemName.toLowerCase(),
        type: elem.type,
        sqlType: cdsTypeToSql(elem.type, elem),
        key: !!elem.key,
        nullable: !elem.notNull,
        default: elem.default?.val,
      });
    }

    entities.push({
      name,
      tableName: entityToTableName(name, def),
      columns,
    });
  }

  return entities.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Interactive entity selection menu.
 */
async function selectEntity(rl, entities, promptText = 'Select table') {
  console.log(`\n  ${promptText}:\n`);
  entities.forEach((entity, i) => {
    console.log(`  ${i + 1}. ${entity.tableName}  (${entity.name}, ${entity.columns.length} cols)`);
  });
  console.log('  0. Cancel\n');
  const choice = parseInt(await prompt(rl, `Choice (0-${entities.length}): `), 10);
  if (choice === 0 || isNaN(choice) || choice > entities.length) return null;
  return entities[choice - 1];
}

/**
 * Interactive column selection menu.
 */
async function selectColumn(rl, entity, promptText = 'Select column') {
  console.log(`\n  ${promptText} from ${entity.tableName}:\n`);
  entity.columns.forEach((col, i) => {
    const markers = [col.key ? 'KEY' : '', !col.nullable ? 'NOT NULL' : ''].filter(Boolean).join(', ');
    console.log(`  ${i + 1}. ${col.columnName} : ${col.sqlType}${markers ? ` [${markers}]` : ''}`);
  });
  console.log('  0. Cancel\n');
  const choice = parseInt(await prompt(rl, `Choice (0-${entity.columns.length}): `), 10);
  if (choice === 0 || isNaN(choice) || choice > entity.columns.length) return null;
  return entity.columns[choice - 1];
}

/**
 * Read CSV data for an entity (seed data for create_table).
 *
 * @param {string} entityName - Full CDS entity name
 * @param {string} dataDir - Path to db/data/ directory
 * @returns {Object|null} { headers, rows } or null
 */
function readCsvData(entityName, dataDir) {
  const csvFileName = entityToCsvFileName(entityName);
  const csvPath = path.join(dataDir, csvFileName);
  if (!fs.existsSync(csvPath)) return null;

  try {
    const content = fs.readFileSync(csvPath, 'utf-8');
    const lines = content.trim().split('\n');
    if (lines.length < 1) return null;

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    const rows = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const values = parseCSVLine(line);
      if (values.length === headers.length) {
        const row = {};
        headers.forEach((header, idx) => { row[header] = values[idx]; });
        rows.push(row);
      }
    }
    return { headers, rows };
  } catch {
    return null;
  }
}

/** Parse a CSV line handling quoted values (RFC 4180 compliant). */
function parseCSVLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"'; i++; // escaped double-quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}

/**
 * Generate a timestamped migration filename.
 * @param {string} name - Human-readable migration name
 * @returns {string} Filename like "20260311_153045_my_migration.json"
 */
function generateMigrationFileName(name) {
  const ts = new Date().toISOString()
    .replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return `${ts}_${safeName}.json`;
}

/**
 * Save current CDS model as a schema snapshot for future diffing.
 *
 * @param {Object} cds - CAP CDS module
 * @param {string} schemaPath - Path to db/schema.cds
 * @param {string} snapshotPath - Where to save the snapshot JSON
 */
async function saveSnapshot(cds, schemaPath, snapshotPath) {
  const model = await cds.load(schemaPath);
  const reflection = cds.reflect(model);
  const snapshot = { generatedAt: new Date().toISOString(), definitions: {} };

  for (const [name, def] of Object.entries(reflection.definitions)) {
    if (def.kind !== 'entity' || def.query || def['@cds.persistence.skip']) continue;

    snapshot.definitions[name] = {
      kind: 'entity',
      tableName: entityToTableName(name, def),
      elements: {},
    };

    for (const [elemName, elem] of Object.entries(def.elements || {})) {
      if (elem.virtual) continue;
      snapshot.definitions[name].elements[elemName] = {
        type: elem.type,
        sqlType: cdsTypeToSql(elem.type, elem),
        nullable: !elem.notNull,
        key: !!elem.key,
        default: elem.default?.val,
        length: elem.length,
        precision: elem.precision,
        scale: elem.scale,
      };
    }
  }

  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
  console.log(`  Snapshot saved: ${snapshotPath}`);
  return snapshot;
}

/**
 * Compare previous snapshot with current CDS model to generate operations.
 *
 * @param {Object} previousSnapshot - Saved snapshot JSON
 * @param {Object} cds - CAP CDS module
 * @param {string} schemaPath - Path to db/schema.cds
 * @returns {Promise<Array>} Array of pgroll operations
 */
async function generateOperationsFromSnapshot(previousSnapshot, cds, schemaPath) {
  const model = await cds.load(schemaPath);
  const current = cds.reflect(model);
  const operations = [];

  // Build current entity map
  const currentEntities = new Map();
  for (const [name, def] of Object.entries(current.definitions)) {
    if (def.kind !== 'entity' || def.query || def['@cds.persistence.skip']) continue;
    currentEntities.set(name, def);
  }

  // Check for removed entities/elements
  for (const [entityName, prevEntity] of Object.entries(previousSnapshot.definitions || {})) {
    const currEntity = currentEntities.get(entityName);
    const tableName = prevEntity.tableName;

    if (!currEntity) {
      console.log(`  DROP TABLE: ${tableName}`);
      operations.push({ drop_table: { table: tableName } });
      continue;
    }

    for (const [elemName, prevElem] of Object.entries(prevEntity.elements || {})) {
      const currElem = currEntity.elements?.[elemName];
      const columnName = elemName.toLowerCase();

      if (!currElem) {
        console.log(`  DROP COLUMN: ${tableName}.${columnName}`);
        operations.push({
          drop_column: {
            table: tableName,
            column: columnName,
            down: prevElem.default !== undefined ? `SELECT ${JSON.stringify(prevElem.default)}` : 'SELECT NULL',
          },
        });
        continue;
      }

      // Detect type changes
      const currSqlType = cdsTypeToSql(currElem.type, currElem);
      if (prevElem.sqlType !== currSqlType) {
        console.log(`  ALTER COLUMN TYPE: ${tableName}.${columnName} (${prevElem.sqlType} -> ${currSqlType})`);
        operations.push({
          alter_column: {
            table: tableName,
            column: columnName,
            type: currSqlType,
            up: `CAST(${columnName} AS ${currSqlType})`,
            down: `CAST(${columnName} AS ${prevElem.sqlType})`,
          },
        });
      }
    }

    // Check for new columns
    for (const [elemName, currElem] of Object.entries(currEntity.elements || {})) {
      if (currElem.virtual) continue;
      const columnName = elemName.toLowerCase();
      if (prevEntity.elements?.[elemName]) continue;

      const sqlType = cdsTypeToSql(currElem.type, currElem);
      console.log(`  ADD COLUMN: ${tableName}.${columnName} (${sqlType})`);
      operations.push({
        add_column: {
          table: tableName,
          column: {
            name: columnName,
            type: sqlType,
            nullable: !currElem.notNull,
            default: currElem.default?.val !== undefined ? String(currElem.default.val) : null,
          },
          up: currElem.default?.val !== undefined ? `SELECT ${JSON.stringify(currElem.default.val)}` : 'SELECT NULL',
        },
      });
    }
  }

  // Log new entities (handled by CDS deploy, not pgroll)
  for (const [entityName] of currentEntities) {
    if (!previousSnapshot.definitions?.[entityName]) {
      console.log(`  [info] New entity ${entityName} — will be handled by CDS deploy`);
    }
  }

  return operations;
}

/**
 * Create a pgroll operation interactively based on user's menu choice.
 *
 * @param {readline.Interface} rl
 * @param {number} choice - Menu choice (1-11)
 * @param {Array} entities - Available entities from getAvailableEntities()
 * @param {string} [dataDir] - Path to db/data/ for CSV seed data
 * @returns {Promise<{operations: Array, migrationName: string}|null>}
 */
async function createOperationInteractively(rl, choice, entities, dataDir) {
  const operations = [];
  let migrationName = '';

  if (entities.length === 0) {
    console.log('  No entities found in CDS model');
    return null;
  }

  switch (choice) {
    case 1: { // drop_column
      const entity = await selectEntity(rl, entities, 'Select table to drop column from');
      if (!entity) return null;
      const column = await selectColumn(rl, entity, 'Select column to drop');
      if (!column) return null;
      const downDefault = await prompt(rl, 'Default value for rollback (Enter for NULL): ');
      operations.push({
        drop_column: {
          table: entity.tableName,
          column: column.columnName,
          down: downDefault ? `SELECT '${downDefault}'` : 'SELECT NULL',
        },
      });
      migrationName = `drop_${column.columnName}_from_${entity.tableName.split('_').pop()}`;
      break;
    }

    case 2: { // drop_table
      const entity = await selectEntity(rl, entities, 'Select table to drop');
      if (!entity) return null;
      operations.push({ drop_table: { table: entity.tableName } });
      migrationName = `drop_table_${entity.tableName.split('_').pop()}`;
      break;
    }

    case 3: { // rename_column
      const entity = await selectEntity(rl, entities, 'Select table');
      if (!entity) return null;
      const column = await selectColumn(rl, entity, 'Select column to rename');
      if (!column) return null;
      const toCol = await prompt(rl, 'New column name: ');
      if (!toCol) return null;
      operations.push({
        rename_column: { table: entity.tableName, from: column.columnName, to: toCol.toLowerCase() },
      });
      migrationName = `rename_${column.columnName}_to_${toCol.toLowerCase()}`;
      break;
    }

    case 4: { // rename_table
      const entity = await selectEntity(rl, entities, 'Select table to rename');
      if (!entity) return null;
      const toTable = await prompt(rl, 'New table name: ');
      if (!toTable) return null;
      operations.push({
        rename_table: { from: entity.tableName, to: toTable.toLowerCase() },
      });
      migrationName = `rename_table_to_${toTable.toLowerCase()}`;
      break;
    }

    case 5: { // alter_column
      const entity = await selectEntity(rl, entities, 'Select table');
      if (!entity) return null;
      const column = await selectColumn(rl, entity, 'Select column to alter');
      if (!column) return null;
      console.log(`  Current type: ${column.sqlType}`);
      const newType = await prompt(rl, 'New PostgreSQL type (e.g., VARCHAR(500), INTEGER): ');
      if (!newType) return null;
      operations.push({
        alter_column: {
          table: entity.tableName, column: column.columnName,
          type: newType.toUpperCase(),
          up: `CAST(${column.columnName} AS ${newType.toUpperCase()})`,
          down: `CAST(${column.columnName} AS ${column.sqlType})`,
        },
      });
      migrationName = `alter_${column.columnName}_type`;
      break;
    }

    case 6: { // add_column
      const entity = await selectEntity(rl, entities, 'Select table to add column to');
      if (!entity) return null;
      console.log('\n  Columns defined in schema.cds:');
      entity.columns.forEach(col => {
        console.log(`   ${col.columnName}: ${col.sqlType}${col.key ? ' [KEY]' : ''}${!col.nullable ? ' [NOT NULL]' : ''}`);
      });
      const columnName = await prompt(rl, '\nColumn name (must exist in schema.cds): ');
      if (!columnName) return null;
      const existingCol = entity.columns.find(c => c.columnName === columnName.toLowerCase() || c.name === columnName);
      if (!existingCol) {
        console.log(`  Column "${columnName}" not found in schema.cds. Add it to db/schema.cds first.`);
        return null;
      }
      const defaultVal = await prompt(rl, 'Default value for existing rows (Enter for NULL): ');
      const colDef = { name: existingCol.columnName, type: existingCol.sqlType, nullable: existingCol.nullable };
      if (defaultVal) colDef.default = `'${defaultVal}'`;
      operations.push({
        add_column: { table: entity.tableName, column: colDef, up: defaultVal ? `SELECT '${defaultVal}'` : 'SELECT NULL' },
      });
      migrationName = `add_${existingCol.columnName}_to_${entity.tableName.split('_').pop()}`;
      break;
    }

    case 7: { // set_not_null
      const entity = await selectEntity(rl, entities, 'Select table');
      if (!entity) return null;
      const column = await selectColumn(rl, entity, 'Select column to set NOT NULL');
      if (!column) return null;
      operations.push({ set_not_null: { table: entity.tableName, column: column.columnName } });
      migrationName = `set_not_null_${column.columnName}`;
      break;
    }

    case 8: { // drop_not_null
      const entity = await selectEntity(rl, entities, 'Select table');
      if (!entity) return null;
      const column = await selectColumn(rl, entity, 'Select column');
      if (!column) return null;
      operations.push({ drop_not_null: { table: entity.tableName, column: column.columnName } });
      migrationName = `drop_not_null_${column.columnName}`;
      break;
    }

    case 9: { // set_default
      const entity = await selectEntity(rl, entities, 'Select table');
      if (!entity) return null;
      const column = await selectColumn(rl, entity, 'Select column');
      if (!column) return null;
      const defaultVal = await prompt(rl, 'Default value: ');
      if (!defaultVal) return null;
      operations.push({ set_default: { table: entity.tableName, column: column.columnName, default: defaultVal } });
      migrationName = `set_default_${column.columnName}`;
      break;
    }

    case 10: { // drop_default
      const entity = await selectEntity(rl, entities, 'Select table');
      if (!entity) return null;
      const column = await selectColumn(rl, entity, 'Select column');
      if (!column) return null;
      operations.push({ drop_default: { table: entity.tableName, column: column.columnName } });
      migrationName = `drop_default_${column.columnName}`;
      break;
    }

    case 11: { // create_table
      const entity = await selectEntity(rl, entities, 'Select entity to create as table');
      if (!entity) return null;
      console.log(`\n  Table: ${entity.tableName}`);
      entity.columns.forEach(col => {
        const markers = [col.key ? 'PK' : '', !col.nullable ? 'NOT NULL' : ''].filter(Boolean).join(', ');
        console.log(`   - ${col.columnName}: ${col.sqlType}${markers ? ` [${markers}]` : ''}`);
      });

      let csvData = null;
      if (dataDir) csvData = readCsvData(entity.name, dataDir);

      const confirm = await prompt(rl, '\nCreate this table? (y/n): ');
      if (confirm.toLowerCase() !== 'y') return null;

      const createOp = {
        create_table: {
          table: entity.tableName,
          columns: entity.columns.map(col => ({
            name: col.columnName,
            type: col.sqlType,
            primaryKey: col.key,
            nullable: col.nullable,
            default: col.default || null,
          })),
        },
      };
      if (csvData?.rows?.length > 0) {
        createOp.create_table.data = csvData.rows;
        console.log(`  Will seed ${csvData.rows.length} rows from CSV`);
      }
      operations.push(createOp);
      migrationName = `create_table_${entity.tableName.split('_').pop()}`;
      break;
    }

    default:
      return null;
  }

  const customName = await prompt(rl, `Migration name (default: ${migrationName}): `);
  if (customName) migrationName = customName;

  return { operations, migrationName };
}

/**
 * Run the interactive migration generator.
 *
 * @param {Object} options
 * @param {string} options.schemaPath - Path to db/schema.cds
 * @param {string} options.migrationsDir - Path to migrations directory
 * @param {string} [options.dataDir] - Path to db/data/ for CSV seed data
 * @param {string} [options.snapshotPath] - Path to .schema-snapshot.json
 * @param {boolean} [options.init] - Initialize snapshot only
 * @param {Object} [options.cds] - CAP CDS module (auto-loaded if omitted)
 */
async function generate(options) {
  const {
    schemaPath,
    migrationsDir,
    dataDir,
    snapshotPath = path.join(migrationsDir, '.schema-snapshot.json'),
    init = false,
  } = options;

  const cds = options.cds || require('@sap/cds');

  // Ensure migrations directory exists
  if (!fs.existsSync(migrationsDir)) {
    fs.mkdirSync(migrationsDir, { recursive: true });
  }

  console.log('  pgroll Migration Generator\n');

  if (init) {
    console.log('  Creating schema snapshot...\n');
    await saveSnapshot(cds, schemaPath, snapshotPath);
    console.log('\n  Snapshot created. Make schema.cds changes, then run generate again.');
    return;
  }

  const entities = await getAvailableEntities(cds, schemaPath);
  const rl = createReadlineInterface();

  try {
    const choice = await showMenu(rl);

    if (choice === 0) {
      console.log('  Cancelled.');
      rl.close();
      return;
    }

    if (choice === 12) {
      // Auto-detect from snapshot
      const previousSnapshot = fs.existsSync(snapshotPath)
        ? JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'))
        : null;
      if (!previousSnapshot) {
        console.log('  No snapshot found. Run with --init first.');
        rl.close();
        return;
      }
      console.log('\n  Comparing schemas...\n');
      const operations = await generateOperationsFromSnapshot(previousSnapshot, cds, schemaPath);
      if (operations.length === 0) {
        console.log('\n  No changes detected that require pgroll.');
        rl.close();
        return;
      }
      const name = await prompt(rl, 'Migration name: ');
      if (!name) { rl.close(); return; }
      const fileName = generateMigrationFileName(name);
      const migration = { name: fileName.replace('.json', ''), operations };
      const migrationPath = path.join(migrationsDir, fileName);
      fs.writeFileSync(migrationPath, JSON.stringify(migration, null, 2));
      console.log(`\n  Migration generated: ${migrationPath}`);
      rl.close();
      return;
    }

    // Manual operation (1-11)
    const result = await createOperationInteractively(rl, choice, entities, dataDir);
    if (!result) {
      console.log('  Cancelled.');
      rl.close();
      return;
    }

    const fileName = generateMigrationFileName(result.migrationName);
    const migration = { name: fileName.replace('.json', ''), operations: result.operations };
    const migrationPath = path.join(migrationsDir, fileName);
    fs.writeFileSync(migrationPath, JSON.stringify(migration, null, 2));

    console.log(`\n  Migration generated: ${migrationPath}`);
    console.log(JSON.stringify(migration, null, 2));
    console.log('\n  Next steps:');
    console.log('    1. Review the migration file');
    console.log('    2. Deploy: cf deploy');
    console.log('    3. Or apply locally: npx cds-pgroll apply');

    rl.close();
  } catch (error) {
    rl.close();
    throw error;
  }
}

module.exports = {
  generate,
  getAvailableEntities,
  saveSnapshot,
  generateOperationsFromSnapshot,
  generateMigrationFileName,
  readCsvData,
  parseCSVLine,
  createOperationInteractively,
};
