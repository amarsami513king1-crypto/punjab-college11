require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('./db');

(async () => {
  const [username, password, email] = process.argv.slice(2);
  if (!username || !password || password.length < 12) {
    console.error('Usage: npm run admin:create -- <username> <password-at-least-12-chars> [email]');
    process.exitCode = 1;
    await pool.end();
    return;
  }
  try {
    const hash = await bcrypt.hash(password, 12);
    const role = await pool.query("SELECT role_id FROM roles WHERE role_name='Administrator'");
    await pool.query(
      `INSERT INTO admin_accounts(username,email,password_hash,role_id)
       VALUES ($1,$2,$3,$4)`,
      [username, email || null, hash, role.rows[0].role_id]
    );
    console.log(`Administrator '${username}' created. Keep the password private.`);
  } catch (e) {
    console.error('Could not create administrator:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
