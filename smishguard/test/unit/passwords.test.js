'use strict';

const { hashPassword, verifyPassword } = require('../../src/services/passwords');

describe('password hashing (scrypt)', () => {
  test('hashes use the scrypt format with a random salt', async () => {
    const [first, second] = await Promise.all([hashPassword('CorrectHorse42!'), hashPassword('CorrectHorse42!')]);
    expect(first).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(first).not.toBe(second);
  });

  test('verifies the right password and rejects the wrong one', async () => {
    const stored = await hashPassword('CorrectHorse42!');
    await expect(verifyPassword('CorrectHorse42!', stored)).resolves.toBe(true);
    await expect(verifyPassword('WrongHorse42!', stored)).resolves.toBe(false);
  });

  test.each([[undefined], [''], ['bcrypt$1$2$3$4$5'], ['scrypt$only$three']])('rejects malformed stored hash %p', async (stored) => {
    await expect(verifyPassword('anything', stored)).resolves.toBe(false);
  });
});
