import { IgApiError } from "../instagram/client.js";
import type { InstagramEvent } from "../instagram/normalize.js";
import { claimNext, complete, fail, releaseStale, type Job } from "./queue.js";
import { processDataDeletion, type DeletionSummary } from "./data-deletion.js";
import { processInstagramEvent, type ProcessOutcome, type WorkerDeps } from "./process-event.js";
import { refreshDueTokens, type TokenRefreshDeps } from "./token-refresh.js";

type Logger = { info: (obj: object, msg?: string) => void; error: (obj: object, msg?: string) => void };

export type JobOutcome = ProcessOutcome | { status: "data_deleted"; summary: DeletionSummary | null };

async function dispatch(deps: WorkerDeps, job: Job): Promise<JobOutcome> {
  if (job.kind === "process_event") {
    const { eventId, event } = job.payload as { eventId: string; event: InstagramEvent };
    return processInstagramEvent(deps, eventId, event);
  }
  if (job.kind === "data_deletion") {
    const { confirmationCode } = job.payload as { confirmationCode: string };
    return { status: "data_deleted", summary: await processDataDeletion(deps.db, confirmationCode) };
  }
  throw new Error(`tipo de job desconhecido: ${job.kind}`);
}

/** Processa no máximo um job. Retorna null se a fila estava vazia. */
export async function runOnce(deps: WorkerDeps, log?: Logger): Promise<JobOutcome | "failed" | null> {
  const job = await claimNext(deps.db);
  if (!job) return null;
  try {
    const outcome = await dispatch(deps, job);
    await complete(deps.db, job.id);
    log?.info({ jobId: job.id, outcome }, "job processado");
    return outcome;
  } catch (err) {
    const retryable = !(err instanceof IgApiError) || err.retryable;
    await fail(deps.db, job, err, retryable);
    log?.error({ jobId: job.id, err, retryable }, "job falhou");
    return "failed";
  }
}

/** Esvazia a fila (útil em testes e scripts). */
export async function drain(deps: WorkerDeps, log?: Logger): Promise<(JobOutcome | "failed")[]> {
  const outcomes: (JobOutcome | "failed")[] = [];
  for (let r = await runOnce(deps, log); r !== null; r = await runOnce(deps, log)) outcomes.push(r);
  return outcomes;
}

const TOKEN_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

export function startWorker(
  deps: WorkerDeps,
  log?: Logger,
  opts: { pollMs?: number; tokenRefresh?: TokenRefreshDeps } = {},
): { stop: () => Promise<void> } {
  const pollMs = opts.pollMs ?? 500;
  let stopped = false;
  let lastStaleCheck = 0;
  let lastTokenRefresh = 0;
  const loop = (async () => {
    while (!stopped) {
      try {
        if (Date.now() - lastStaleCheck > 60_000) {
          await releaseStale(deps.db);
          lastStaleCheck = Date.now();
        }
        if (opts.tokenRefresh && Date.now() - lastTokenRefresh > TOKEN_REFRESH_INTERVAL_MS) {
          lastTokenRefresh = Date.now();
          const outcomes = await refreshDueTokens(opts.tokenRefresh);
          if (outcomes.length) log?.info({ outcomes }, "renovação de tokens do Instagram");
        }
        if ((await runOnce(deps, log)) === null) await new Promise((r) => setTimeout(r, pollMs));
      } catch (err) {
        log?.error({ err }, "erro no loop do worker");
        await new Promise((r) => setTimeout(r, pollMs * 4));
      }
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
    },
  };
}
