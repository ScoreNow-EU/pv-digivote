import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDatabasePool } from "./index.js";

async function migrate(): Promise<void> {
  const database = getDatabasePool();
  if (!database) throw new Error("DATABASE_URL ist nicht gesetzt.");

  const packageDir = path.dirname(fileURLToPath(import.meta.url));
  const migrationDir = path.resolve(packageDir, "../../../infrastructure/postgres/migrations");
  const files = (await readdir(migrationDir)).filter((file) => file.endsWith(".sql")).sort();

  await database.query(`
    create table if not exists schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  for (const filename of files) {
    const applied = await database.query<{ exists: boolean }>(
      "select exists(select 1 from schema_migrations where filename = $1) as exists",
      [filename]
    );
    if (applied.rows[0]?.exists) continue;

    const sql = await readFile(path.join(migrationDir, filename), "utf8");
    const client = await database.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into schema_migrations(filename) values ($1)", [filename]);
      await client.query("commit");
      process.stdout.write(`Migration angewendet: ${filename}\n`);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

migrate().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
