// A minimal supabase-js stand-in over node-postgres: exactly the query-builder surface that
// SupabaseStore uses (from().insert/select/update/match/eq/order/limit/single, rpc). It lets the
// integration suite run the real service + SupabaseStore + the harbor_* SQL functions against a
// real Postgres with the Harbor migrations applied. Each call is one autocommit statement, like a
// PostgREST request. Values are shaped like PostgREST JSON: bigint -> number, timestamptz -> ISO
// string, date -> "YYYY-MM-DD", jsonb -> parsed. Errors come back as { message, details, code }.
import pg from "pg";

const parseTimestamptz = pg.types.getTypeParser(pg.types.builtins.TIMESTAMPTZ);
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, (v) =>
  (parseTimestamptz(v) as Date).toISOString(),
);
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

type Row = Record<string, unknown>;
export interface PgResult<T = unknown> {
  data: T;
  error: { message: string; details?: string; code?: string } | null;
}

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`unsafe identifier ${s}`);
  return `"${s}"`;
};

class Query implements PromiseLike<PgResult<any>> {
  private filters: [string, unknown][] = [];
  private orderBy?: { col: string; asc: boolean };
  private lim?: number;
  private wantSingle = false;
  private columns = "*";

  constructor(
    private db: PgSupabase,
    private table: string,
    private op: "select" | "insert" | "update",
    private payload?: Row,
  ) {}

  select(columns = "*") {
    if (this.op === "select") this.columns = columns;
    return this;
  }
  single() {
    this.wantSingle = true;
    return this;
  }
  match(m: Row) {
    for (const [k, v] of Object.entries(m)) this.filters.push([k, v]);
    return this;
  }
  eq(k: string, v: unknown) {
    this.filters.push([k, v]);
    return this;
  }
  order(col: string, o: { ascending?: boolean } = {}) {
    this.orderBy = { col, asc: o.ascending !== false };
    return this;
  }
  limit(n: number) {
    this.lim = n;
    return this;
  }

  then<A = PgResult<any>, B = never>(
    ok?: ((v: PgResult<any>) => A | PromiseLike<A>) | null,
    err?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.run().then(ok, err);
  }

  private where(params: unknown[], prefix = ""): string {
    if (!this.filters.length) return "";
    return (
      " where " +
      this.filters
        .map(([k, v]) => {
          if (v === null) return `${prefix}${ident(k)} is null`;
          params.push(v);
          return `${prefix}${ident(k)} = $${params.length}`;
        })
        .join(" and ")
    );
  }

  private async run(): Promise<PgResult<any>> {
    try {
      const params: unknown[] = [];
      let sql: string;
      if (this.op === "insert") {
        const types = await this.db.columnTypes(this.table);
        const cols = Object.keys(this.payload!);
        const vals = cols.map((c) => {
          const v = this.payload![c];
          params.push(
            types[c] === "jsonb" && v !== null && v !== undefined ? JSON.stringify(v) : (v ?? null),
          );
          return `$${params.length}`;
        });
        sql = `insert into ${ident(this.table)} (${cols.map(ident).join(", ")}) values (${vals.join(", ")}) returning *`;
      } else if (this.op === "update") {
        const types = await this.db.columnTypes(this.table);
        const sets = Object.entries(this.payload!).map(([c, v]) => {
          params.push(
            types[c] === "jsonb" && v !== null && v !== undefined ? JSON.stringify(v) : (v ?? null),
          );
          return `${ident(c)} = $${params.length}`;
        });
        sql = `update ${ident(this.table)} set ${sets.join(", ")}${this.where(params)}`;
      } else if (this.table === "ledger_lines" && this.columns.includes("ledger_txns(")) {
        // SupabaseStore.ledger(): lines with the embedded parent txn (kind, ref, created_at).
        sql = `select l.txn_id, l.account, l.party, l.debit, l.credit,
                      json_build_object('kind', t.kind, 'ref', t.ref, 'created_at', t.created_at) as ledger_txns
                 from ledger_lines l join ledger_txns t on t.id = l.txn_id${this.where(params, "l.")}`;
        if (this.orderBy)
          sql += ` order by l.${ident(this.orderBy.col)} ${this.orderBy.asc ? "asc" : "desc"}`;
        if (this.lim !== undefined) sql += ` limit ${Number(this.lim)}`;
      } else {
        if (this.columns.trim() !== "*")
          throw new Error(`pg-supabase: unsupported select "${this.columns}"`);
        sql = `select * from ${ident(this.table)}${this.where(params)}`;
        if (this.orderBy)
          sql += ` order by ${ident(this.orderBy.col)} ${this.orderBy.asc ? "asc" : "desc"}`;
        if (this.lim !== undefined) sql += ` limit ${Number(this.lim)}`;
      }
      const r = await this.db.pool.query(sql, params);
      if (this.op === "update") return { data: null, error: null };
      if (this.wantSingle) {
        if (r.rows.length !== 1)
          return { data: null, error: { message: `expected 1 row, got ${r.rows.length}` } };
        return { data: r.rows[0], error: null };
      }
      return { data: r.rows, error: null };
    } catch (e) {
      return { data: null, error: pgError(e) };
    }
  }
}

function pgError(e: unknown) {
  const x = e as { message?: string; detail?: string; code?: string };
  return { message: x.message ?? String(e), details: x.detail, code: x.code };
}

export class PgSupabase {
  private types = new Map<string, Record<string, string>>();
  constructor(public pool: pg.Pool) {}

  async columnTypes(table: string): Promise<Record<string, string>> {
    const cached = this.types.get(table);
    if (cached) return cached;
    const r = await this.pool.query(
      "select column_name, udt_name from information_schema.columns where table_schema = 'public' and table_name = $1",
      [table],
    );
    const t: Record<string, string> = Object.fromEntries(
      r.rows.map((x) => [x.column_name, x.udt_name]),
    );
    this.types.set(table, t);
    return t;
  }

  from(table: string) {
    return {
      select: (columns = "*") => new Query(this, table, "select").select(columns),
      insert: (row: Row) => new Query(this, table, "insert", row),
      update: (patch: Row) => new Query(this, table, "update", patch),
    };
  }

  /** Named-argument call, like PostgREST /rpc/<fn>. Objects/arrays are passed as jsonb. */
  async rpc(fn: string, args: Row): Promise<PgResult<any>> {
    try {
      const params: unknown[] = [];
      const named = Object.entries(args).map(([k, v]) => {
        if (v !== null && typeof v === "object") {
          params.push(JSON.stringify(v));
          return `${ident(k)} => $${params.length}::jsonb`;
        }
        params.push(v ?? null);
        return `${ident(k)} => $${params.length}`;
      });
      const r = await this.pool.query(`select ${ident(fn)}(${named.join(", ")}) as result`, params);
      return { data: r.rows[0]?.result ?? null, error: null };
    } catch (e) {
      return { data: null, error: pgError(e) };
    }
  }
}
