// Create (or reset) an admin account (from saturday-sprint). Works against the local database or production (set DATABASE_URL).
//   npm run create-admin -- --email you@example.com --name "Your Name" --super
//   npm run create-admin -- --email you@example.com --reset      (new temporary password + re-enrol authenticator)
import { ready, one, run, close } from '../db.js';
import { hashPassword, generatePassword } from '../security.js';

const args = process.argv.slice(2);
const flag = (n) => args.includes('--' + n);
const val = (n) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : undefined; };

const email = String(val('email') || '').trim().toLowerCase();
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error('Usage: npm run create-admin -- --email you@example.com [--name "Your Name"] [--super] [--reset]');
  process.exit(1);
}
await ready();
const temp = val('password') || generatePassword();
const existing = await one('SELECT * FROM admins WHERE email = ?', email);

if (existing) {
  if (!flag('reset')) { console.error(`Admin ${email} already exists. Add --reset to issue a new temporary password.`); await close(); process.exit(1); }
  await run('UPDATE admins SET password_hash = ?, must_change_pw = 1, totp_enabled = 0, totp_secret = NULL, totp_last_step = 0, failed_logins = 0, locked_until = 0, status = ?' +
    (flag('super') ? ", role = 'super_admin'" : '') + ' WHERE id = ?', hashPassword(temp), 'active', existing.id);
  await run("DELETE FROM sessions WHERE kind = 'admin' AND subject_id = ?", existing.id);
  console.log(`\nReset admin ${email}.`);
} else {
  const role = flag('super') || !(await one('SELECT 1 AS x FROM admins LIMIT 1')) ? 'super_admin' : 'admin';
  await run('INSERT INTO admins (email, name, role, password_hash, must_change_pw, created_at) VALUES (?, ?, ?, ?, 1, ?)',
    email, String(val('name') || '').trim(), role, hashPassword(temp), Date.now());
  console.log(`\nCreated ${role} ${email}.`);
}
console.log(`Temporary password: ${temp}`);
console.log('Log in at /admin, enrol an authenticator app, then set your own password.\n');
await close();
