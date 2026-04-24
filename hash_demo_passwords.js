import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';

const db = new Database('immunibaby.db');

const users = db.prepare('SELECT * FROM users').all();

users.forEach(user => {
  if (!user.password.startsWith('$2a$')) {
    const hashed = bcrypt.hashSync(user.password, 10);
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashed, user.id);
    console.log(`Hashed password for ${user.email}`);
  }
});

console.log('All existing passwords hashed.');