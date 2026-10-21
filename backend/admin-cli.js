#!/usr/bin/env node
// ============================================================
// Medical Premium Illustrator — admin account command line (Phase 4)
//
//   node admin-cli.js list
//   node admin-cli.js create <username>
//   node admin-cli.js set-password <username>
//   node admin-cli.js remove <username>
//
// For adding a second admin, resetting a forgotten password, or removing
// someone who has left. Run it ON THE SERVER, pointing at the same
// database as the running app (same DB_PATH, if you set one) — having
// access to the server is deliberately the proof of identity needed here.
//
// The password is read from the ADMIN_CLI_PASSWORD environment variable,
// or typed at a prompt (hidden). It is never taken as a command-line
// argument, where it would show up in shell history and process lists.
//
// Changing a password signs that admin out everywhere.
// ============================================================

const readline = require('readline');
const adminAuth = require('./admin-auth.js');

function promptHidden(question) {
  return new Promise((resolve) => {
    const hide = !!process.stdin.isTTY;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: hide });
    if (hide) rl._writeToOutput = (str) => { if (str.includes(question)) process.stdout.write(str); };
    rl.question(question, (answer) => { rl.close(); if (hide) process.stdout.write('\n'); resolve(answer); });
  });
}

async function readPassword() {
  if (process.env.ADMIN_CLI_PASSWORD) return process.env.ADMIN_CLI_PASSWORD;
  return promptHidden('Password (at least 8 characters): ');
}

function usage() {
  console.log('Usage:\n  node admin-cli.js list\n  node admin-cli.js create <username>\n  node admin-cli.js set-password <username>\n  node admin-cli.js remove <username>\n\nPassword comes from ADMIN_CLI_PASSWORD, or is prompted for.');
}

async function main() {
  const [command, username] = process.argv.slice(2);
  try {
    if (command === 'list') {
      const admins = adminAuth.listAdmins();
      if (!admins.length) console.log('No admin accounts yet.');
      admins.forEach(a => console.log(`${a.username}  (${a.role})  created ${a.createdAt}  last sign-in ${a.lastLoginAt || 'never'}`));
    } else if (command === 'create' && username) {
      adminAuth.createAdmin(username, await readPassword());
      console.log(`Created admin account "${username}".`);
    } else if (command === 'set-password' && username) {
      adminAuth.setPassword(username, await readPassword());
      console.log(`Password changed for "${username}". They have been signed out everywhere.`);
    } else if (command === 'remove' && username) {
      adminAuth.removeAdmin(username);
      console.log(`Removed admin account "${username}".`);
    } else {
      usage();
      process.exitCode = command ? 2 : 0;
    }
  } catch (e) {
    const msg = /UNIQUE/i.test(e.message) ? `An admin account named "${username}" already exists.` : e.message;
    console.error('Error: ' + msg);
    process.exitCode = 1;
  }
}

main();
