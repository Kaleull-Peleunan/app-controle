/**
 * Drivers de banco.
 *
 * O store fala UM dialeto de SQL (placeholders `?`, `on conflict`, `jsonb`) e
 * cada driver traduz o que for preciso. Assim existe uma só implementação das
 * regras de persistência, testada contra os dois bancos.
 *
 *   sqlite  → node:sqlite (síncrono) — desenvolvimento e um aparelho só
 *   pg      → node-postgres (`pg`) ou PGlite (Postgres em WASM) — produção
 *
 * Os dois drivers pg falam a MESMA interface porque ambos expõem
 * `query(sql, params)`: o pool do node-postgres e a instância do PGlite.
 *
 * BOOLEANOS: o store sempre passa `true`/`false` (o domínio é booleano).
 * O Postgres tem coluna `boolean` e aceita; o SQLite declara `integer` e
 * recusa — por isso o driver SQLite converte na entrada. A conversão mora
 * no driver, num lugar só, e não espalhada por cada consulta do store.
 */

/* ---------- SQLite (node:sqlite) ---------- */

/** `true`/`false` -> `1`/`0` (o SQLite não tem tipo booleano). */
const paraSqlite = params => params.map(p => (typeof p === 'boolean' ? (p ? 1 : 0) : p));

export function driverSqlite(db) {
  return {
    dialect: 'sqlite',
    bruto: db,
    async all(sql, params = []) { return db.prepare(sql).all(...paraSqlite(params)); },
    async get(sql, params = []) { return db.prepare(sql).get(...paraSqlite(params)); },
    async run(sql, params = []) {
      const info = db.prepare(sql).run(...paraSqlite(params));
      return { changes: Number(info.changes ?? 0) };
    },
    async exec(sql) { db.exec(sql); },
    // Banco de arquivo único: a transação é a própria conexão.
    async transacao(fn) {
      db.exec('begin immediate');
      try { const r = await fn(this); db.exec('commit'); return r; }
      catch (e) { db.exec('rollback'); throw e; }
    },
    async fechar() { db.close(); },
  };
}

/* ---------- Postgres (pg ou PGlite) ---------- */

/** `?` -> `$1, $2, ...` (nosso SQL não tem `?` dentro de string literal). */
function paraPostgres(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export function driverPg(queryable) {
  const temPool = typeof queryable.connect === 'function';
  let pool = null;

  const executar = async (alvo, sql, params = []) => {
    const r = await alvo.query(paraPostgres(sql), params);
    return r;
  };

  return {
    dialect: 'pg',
    bruto: queryable,
    async all(sql, params = []) { return (await executar(queryable, sql, params)).rows; },
    async get(sql, params = []) { return (await executar(queryable, sql, params)).rows[0]; },
    async run(sql, params = []) {
      const r = await executar(queryable, sql, params);
      // a tag rowCount vem do pg; o PGlite devolve affectedRows
      return { changes: Number(r.rowCount ?? r.affectedRows ?? 0) };
    },
    /**
     * DDL com VÁRIOS comandos no mesmo texto. O node-postgres aceita pelo
     * protocolo simples (query sem parâmetros), mas o PGlite prepara tudo e
     * recusa — ele tem um `exec` próprio para isso.
     */
    async exec(sql) {
      if (typeof queryable.exec === 'function') return queryable.exec(sql);
      await queryable.query(sql);
    },
    /**
     * Cada transação precisa da SUA conexão — em pool, duas consultas seguidas
     * podem cair em conexões diferentes e o `begin` não valeria para ambas.
     * Sem pool (PGlite, um processo só) a própria instância serve.
     */
    async transacao(fn) {
      if (!temPool) {
        await queryable.query('begin');
        try { const r = await fn(this); await queryable.query('commit'); return r; }
        catch (e) { await queryable.query('rollback'); throw e; }
      }
      pool = pool || queryable;
      const cliente = await pool.connect();
      const tx = {
        dialect: 'pg',
        all: async (sql, params = []) => (await cliente.query(paraPostgres(sql), params)).rows,
        get: async (sql, params = []) => (await cliente.query(paraPostgres(sql), params)).rows[0],
        run: async (sql, params = []) => {
          const r = await cliente.query(paraPostgres(sql), params);
          return { changes: Number(r.rowCount ?? 0) };
        },
        exec: async sql => { await cliente.query(sql); },
      };
      try {
        await cliente.query('begin');
        const r = await fn(tx);
        await cliente.query('commit');
        return r;
      } catch (e) {
        await cliente.query('rollback');
        throw e;
      } finally {
        cliente.release();
      }
    },
    async fechar() { if (temPool) await queryable.end(); else await queryable.close?.(); },
  };
}

/* ---------- Escolha do banco por ambiente ---------- */

/**
 * Decide o banco pelo ambiente:
 *   DATABASE_URL=postgres://...  → Postgres
 *   DB_FILE=./dados/x.db|:memory: → SQLite (padrão)
 * Devolve { driver, descricao } para o servidor registrar o que subiu.
 */
export async function abrirDriver({ databaseUrl = process.env.DATABASE_URL, arquivo = process.env.DB_FILE, driverPgExterno = null } = {}) {
  if (databaseUrl) {
    const { Pool } = await import('pg').catch(() => ({ Pool: null }));
    if (!Pool) throw new Error('DATABASE_URL definido, mas o pacote "pg" não está instalado (npm install pg).');
    const pool = new Pool({ connectionString: databaseUrl, max: 10 });
    return { driver: driverPg(pool), descricao: `postgres (${databaseUrl.replace(/:[^:@/]+@/, ':***@')})` };
  }
  const { openDb } = await import('./schema.mjs');
  const db = openDb(arquivo || ':memory:');
  return { driver: driverSqlite(db), descricao: `sqlite (${arquivo || ':memory:'})` };
}
