import { loadConfig } from "../config.js";
import { createDb } from "./index.js";
import { migrate } from "./migrate.js";

const config = loadConfig();
const db = createDb({ databaseUrl: config.databaseUrl, sslCaPath: config.databaseSslCa });
const applied = await migrate(db);
console.log(applied.length ? `Aplicadas: ${applied.join(", ")}` : "Nada a aplicar.");
await db.close();
