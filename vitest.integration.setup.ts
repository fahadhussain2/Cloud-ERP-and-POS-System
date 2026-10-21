// Fail loudly instead of skipping: an integration test must never pass by not running.
export default function setup() {
  if (!process.env['DATABASE_URL']) {
    throw new Error(
      'DATABASE_URL is not set. Integration tests need PostgreSQL 17+ (CI provides one; a local one arrives with W0-07).',
    );
  }
}
