'use strict';

function toUser(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    createdAt: row.created_at,
  };
}

/** Data access for users. All queries are static and parameterised. */
function createUserRepository(db) {
  const insert = db.prepare('INSERT INTO users (email, password_hash, role) VALUES (:email, :passwordHash, :role)');
  const byId = db.prepare('SELECT * FROM users WHERE id = ?');
  const byEmail = db.prepare('SELECT * FROM users WHERE email = ?');

  return {
    create({ email, passwordHash, role = 'user' }) {
      const { lastInsertRowid } = insert.run({ email, passwordHash, role });
      return toUser(byId.get(Number(lastInsertRowid)));
    },
    findById(id) {
      return toUser(byId.get(id));
    },
    findByEmail(email) {
      return toUser(byEmail.get(email));
    },
  };
}

module.exports = { createUserRepository };
