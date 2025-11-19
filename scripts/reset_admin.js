const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const db = new Database(path.join(__dirname, '..', 'data.sqlite'));

const email = 'admin@local';
const normalized = email.toLowerCase().trim();
const user = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(normalized);
const hash = bcrypt.hashSync('adminpass', 10);
if (user) {
  db.prepare('UPDATE users SET role = ?, password = ? WHERE id = ?').run('admin', hash, user.id);
  console.log('Updated existing user to admin:', user.id, user.email);
} else {
  const info = db.prepare('INSERT INTO users (name,email,password,role) VALUES (?,?,?,?)').run('Admin', normalized, hash, 'admin');
  console.log('Inserted admin user with id:', info.lastInsertRowid);
}
process.exit(0);
