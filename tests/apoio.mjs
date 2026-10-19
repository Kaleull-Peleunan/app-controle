/**
 * Escolha do banco nos testes.
 *
 * A MESMA suíte roda contra os dois bancos:
 *
 *   node --test                                   → SQLite em memória (padrão)
 *   BANCO=postgres node --test                    → Postgres real (PGlite, em WASM)
 *   DATABASE_URL=postgres://... node --test       → Postgres de verdade (docker-compose)
 *
 * Isso é o que dá sentido ao adaptador: se as regras de negócio só passassem no
 * SQLite, elas não estariam testadas — estariam testadas *no SQLite*.
 */

import { openDb, createStore } from '../server/store.mjs';
import { driverPg } from '../server/drivers.mjs';

/**
 * Um servidor Postgres por PROCESSO (não por teste): subir um banco por teste
 * custa caro e vaza. O isolamento entre testes vem de recriar o schema public,
 * que é exatamente como se isola um banco compartilhado de verdade.
 */
let pgCompartilhado = null;

async function postgresDoProcesso() {
  if (pgCompartilhado) return pgCompartilhado;
  if (process.env.DATABASE_URL) {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    pgCompartilhado = {
      nome: 'postgres (DATABASE_URL)',
      bruto: pool,
      executar: sql => pool.query(sql),
      fechar: () => pool.end(),
    };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = new PGlite();
    pgCompartilhado = {
      nome: 'postgres (PGlite)',
      bruto: pg,
      executar: sql => pg.exec(sql),
      fechar: () => pg.close(),
    };
  }
  return pgCompartilhado;
}

/** Devolve { store, fechar }. `fechar` só derruba o banco no fim do processo. */
export async function bancoDeTeste() {
  if (process.env.DATABASE_URL || process.env.BANCO === 'postgres') {
    const pg = await postgresDoProcesso();
    // Schema limpo a cada teste — este banco é de teste, nunca de uso.
    await pg.executar('drop schema if exists public cascade; create schema public;');
    const store = await createStore(driverPg(pg.bruto));
    return { store, fechar: async () => {} };
  }

  const db = openDb(':memory:');
  const store = await createStore(db);
  return { store, fechar: async () => { try { db.close(); } catch { /* já fechado */ } } };
}

/** Nome legível do banco em uso, para o cabeçalho do relatório. */
export async function nomeDoBanco() {
  if (process.env.DATABASE_URL || process.env.BANCO === 'postgres') {
    return (await postgresDoProcesso()).nome;
  }
  return 'sqlite (:memory:)';
}
