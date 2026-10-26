import { randomUUID } from "node:crypto";
import type { Queryable } from "../db/index.js";
import type { InstagramEvent } from "../instagram/normalize.js";
import { enqueue } from "./queue.js";

/** Grava os eventos (ignorando repetidos) e enfileira o processamento. Usado pelo webhook e pelo simulador. */
export async function ingestInstagramEvents(q: Queryable, events: InstagramEvent[]): Promise<number> {
  let queued = 0;
  for (const event of events) {
    // Idempotência: a Meta pode entregar o mesmo evento mais de uma vez. affectedRows = 0 → já existia.
    // (INSERT IGNORE e não ON DUPLICATE KEY: com a flag FOUND_ROWS do mysql2, o segundo conta 1 mesmo sem inserir.)
    const eventId = randomUUID();
    const { affectedRows } = await q.query(
      "INSERT IGNORE INTO events_raw (id, channel, dedupe_key, payload) VALUES ($1, 'instagram', $2, $3)",
      [eventId, event.dedupeKey, JSON.stringify(event)],
    );
    if (affectedRows === 1) {
      await enqueue(q, "process_event", { channel: "instagram", eventId, event });
      queued++;
    }
  }
  return queued;
}
