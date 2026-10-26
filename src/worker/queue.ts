import type { Db, Queryable } from "../db/index.js";

export type Job = {
  id: string;
  contact_id: string | null;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
};

export const MAX_ATTEMPTS = 5;

export async function enqueue(q: Queryable, kind: string, payload: unknown, runAt?: Date): Promise<void> {
  await q.query("INSERT INTO scheduled_jobs (kind, payload, run_at) VALUES ($1, $2, $3)", [
    kind,
    JSON.stringify(payload),
    (runAt ?? new Date()).toISOString(),
  ]);
}

/** Pega o próximo job vencido. SKIP LOCKED permite vários workers sem pegar o mesmo job. */
export async function claimNext(db: Db): Promise<Job | null> {
  return db.tx(async (q) => {
    const { rows } = await q.query<{ id: string }>(
      `SELECT id FROM scheduled_jobs
        WHERE status = 'pending' AND run_at <= NOW(3)
        ORDER BY run_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
    );
    const id = rows[0]?.id;
    if (!id) return null;
    await q.query(
      "UPDATE scheduled_jobs SET status = 'running', locked_at = NOW(3), attempts = attempts + 1 WHERE id = $1",
      [id],
    );
    const job = await q.query<Job>("SELECT id, contact_id, kind, payload, attempts FROM scheduled_jobs WHERE id = $1", [id]);
    return job.rows[0] ?? null;
  });
}

export async function complete(db: Db, jobId: string): Promise<void> {
  await db.query("UPDATE scheduled_jobs SET status = 'done', locked_at = NULL WHERE id = $1", [jobId]);
}

/** Backoff exponencial: 2s, 4s, 8s, 16s; depois disso o job fica `failed`. */
export async function fail(db: Db, job: Job, error: unknown, retryable: boolean): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  if (retryable && job.attempts < MAX_ATTEMPTS) {
    const runAt = new Date(Date.now() + 1000 * 2 ** job.attempts);
    await db.query(
      "UPDATE scheduled_jobs SET status = 'pending', locked_at = NULL, last_error = $2, run_at = $3 WHERE id = $1",
      [job.id, message, runAt.toISOString()],
    );
  } else {
    await db.query("UPDATE scheduled_jobs SET status = 'failed', locked_at = NULL, last_error = $2 WHERE id = $1", [
      job.id,
      message,
    ]);
  }
}

/** Jobs presos em `running` (worker morreu no meio) voltam para a fila. */
export async function releaseStale(db: Db, olderThanSeconds = 300): Promise<void> {
  await db.query(
    `UPDATE scheduled_jobs SET status = 'pending', locked_at = NULL
      WHERE status = 'running' AND locked_at < NOW(3) - INTERVAL $1 SECOND`,
    [olderThanSeconds],
  );
}
