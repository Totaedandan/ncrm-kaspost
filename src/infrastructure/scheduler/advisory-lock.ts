import { Client } from 'pg';
import type { JobLockPort, LockHandle } from '../../application/ports/repositories';

/**
 * Session-level Postgres advisory lock on a dedicated connection. If the process dies the
 * connection drops and Postgres releases the lock, so a crashed instance cannot wedge a job.
 */
export class PgAdvisoryLock implements JobLockPort {
  constructor(private readonly connectionString: string) {}

  async tryAcquire(name: string): Promise<LockHandle | null> {
    const client = new Client({ connectionString: this.connectionString });
    // An idle-connection error must not crash the process; it just releases the lock.
    client.on('error', () => undefined);
    await client.connect();

    try {
      const result = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
        [`ncrm-kazpost:${name}`],
      );
      if (result.rows[0]?.locked !== true) {
        await client.end();
        return null;
      }
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }

    return {
      release: async () => {
        try {
          await client.query('SELECT pg_advisory_unlock_all()');
        } finally {
          await client.end().catch(() => undefined);
        }
      },
    };
  }
}
