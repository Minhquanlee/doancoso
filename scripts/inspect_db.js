// Simple DB inspector using better-sqlite3
// Usage: node scripts/inspect_db.js

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.resolve(__dirname, '..', 'data.sqlite');
if (!fs.existsSync(dbPath)) {
  console.error('Error: data.sqlite not found at', dbPath);
  process.exit(2);
}

let db;
try {
  db = new Database(dbPath, { readonly: true });
} catch (err) {
  console.error('Failed to open database:', err.message);
  process.exit(3);
}

try {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
  if (!tables.length) {
    console.log('No user tables found in', dbPath);
    process.exit(0);
  }

  console.log('Found tables:', tables.join(', '));

  for (const t of tables) {
    console.log('\n---');
    console.log('Table:', t);

    const countRow = db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get();
    console.log('Rows:', countRow ? countRow.c : 0);

    const schemaRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t);
    console.log('Schema:');
    console.log(schemaRow && schemaRow.sql ? schemaRow.sql : '(no schema found)');

    console.log('Sample rows (up to 5):');
    const rows = db.prepare(`SELECT * FROM "${t}" LIMIT 5`).all();
    if (!rows || !rows.length) console.log('(no rows)');
    else console.table(rows);
  }
} catch (err) {
  console.error('Error while inspecting DB:', err.message);
  process.exit(4);
} finally {
  db.close();
}

console.log('\nDone.');
