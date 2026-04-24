import Database from 'better-sqlite3';

try {
  const db = new Database('immunibaby.db'); // database file
  db.prepare('CREATE TABLE IF NOT EXISTS test (id INTEGER PRIMARY KEY, name TEXT)').run();
  console.log('✅ SQLite connection works!');
} catch (err) {
  console.error('❌ SQLite connection failed:', err);
}