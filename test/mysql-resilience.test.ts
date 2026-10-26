import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb, poolOptions } from "../src/db/index.js";
import { createTestDb } from "./mysql-test-db.js";

describe("MySQL real", () => {
  it("sobrevive quando o servidor derruba uma conexão do pool (reinício do MySQL, queda de rede)", async () => {
    const testDb = await createTestDb();
    const lost: Error[] = [];
    const db = createDb({ databaseUrl: testDb.url, onIdleError: (err) => lost.push(err) });

    const { rows } = await db.query<{ id: number }>("SELECT CONNECTION_ID() AS id");
    const threadId = rows[0]!.id;

    // Mesmo efeito de reiniciar o serviço: o servidor encerra a conexão que ficou parada no pool.
    const killer = await mysql.createConnection(poolOptions({ databaseUrl: testDb.url }) as mysql.ConnectionOptions);
    await killer.query("KILL ?", [threadId]);
    await killer.end();
    await new Promise((r) => setTimeout(r, 300));

    expect(lost.length).toBeGreaterThan(0);
    // O pool abre uma conexão nova e segue funcionando.
    const again = await db.query<{ ok: number }>("SELECT 1 AS ok");
    expect(again.rows[0]!.ok).toBe(1);

    await db.close();
    await testDb.drop();
  });
});
