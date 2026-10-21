// Database migrations, run by every deploy before the new version starts (D-075).
// If this exits non-zero, the deploy stops and the old version keeps running.
// The database and the first migrations arrive in W0-07.
// TEMP rehearsal (W0-04): a failing migration. Never merged.
console.error('migrate: simulated failure');
process.exit(1);
