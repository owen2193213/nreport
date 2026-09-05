import { Pool } from "pg";

import { ACCOUNT_SCHEMA_SQL } from "./accounts.js";
import { REPORT_SCHEMA_SQL } from "./report-repository.js";

export class PostgresDatabase {
  public readonly pool: Pool;

  public constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 10 });
  }

  public async migrate(): Promise<void> {
    await this.pool.query(ACCOUNT_SCHEMA_SQL);
    await this.pool.query(REPORT_SCHEMA_SQL);
  }

  public async healthcheck(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}
