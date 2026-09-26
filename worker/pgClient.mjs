// The pg Client handed to auditPolicies(). It connects to the fields we parsed and
// validated ourselves — never the raw connection string, whose query parameters
// (?host=, ?sslkey=…) node-postgres would otherwise honour — and it can't hang a run.

import pg from "pg";
import { databaseUrlToPgConfig } from "../shared/validate.mjs";

const PG_TIMEOUT_MS = 15_000;

export class GuardedPgClient extends pg.Client {
  constructor({ connectionString }) {
    const cfg = databaseUrlToPgConfig(connectionString);
    if (!cfg) throw new Error("stored database URL failed validation; not connecting");
    super({
      ...cfg,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: PG_TIMEOUT_MS,
      query_timeout: PG_TIMEOUT_MS,
      statement_timeout: PG_TIMEOUT_MS,
    });
  }
}
