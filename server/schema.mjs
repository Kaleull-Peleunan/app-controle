/**
 * Schemas por dialeto.
 *
 * As duas definições descrevem o MESMO modelo. A diferença é só de tipo:
 * `text` guarda o JSON no SQLite; no Postgres é `jsonb` (consultável).
 * O store fala um só dialeto de SQL e o driver traduz — ver drivers.mjs.
 */

export const SCHEMA_SQLITE = `

create table if not exists lojas (
  id text primary key,
  nome text not null,
  discount_limit real not null default 10,
  service_fee_pct real not null default 10,
  config text,
  created_at text not null
);

create table if not exists usuarios (
  id text primary key,
  loja_id text not null,
  nome text not null,
  role text not null,
  pin_hash text,
  ativo integer not null default 1,
  created_at text not null
);

create table if not exists produtos (
  id text primary key,
  loja_id text not null,
  nome text not null,
  preco real not null,
  categoria text,
  setor text,
  ativo integer not null default 1
);

create table if not exists comandas (
  id text primary key,
  loja_id text not null,
  seq integer,
  mesa integer,
  status text not null,
  aberta_em text not null,
  fechada_em text,
  version integer not null default 0,
  updated_at text not null,
  total real not null default 0,
  pago real not null default 0,
  saldo real not null default 0,
  doc text not null
);
create index if not exists ix_comandas_loja_status on comandas(loja_id, status);

create table if not exists avisos (
  id text primary key,
  loja_id text not null,
  at text not null,
  doc text not null
);

create table if not exists mutacoes_aplicadas (
  mutation_id text primary key,
  loja_id text not null,
  device_id text,
  tipo text not null,
  resultado text not null,
  aplicada_em text not null
);

create table if not exists auditoria (
  id integer primary key autoincrement,
  loja_id text not null,
  at text not null,
  tipo text not null,
  usuario_id text,
  usuario_nome text,
  papel text,
  detalhe text,
  mutation_id text,
  device_id text
);
create index if not exists ix_auditoria_loja on auditoria(loja_id, id desc);

create table if not exists sync_log (
  cursor integer primary key autoincrement,
  loja_id text not null,
  colecao text not null,
  doc_id text not null,
  at text not null
);
create index if not exists ix_sync_loja on sync_log(loja_id, cursor);
`;

export const SCHEMA_PG = `
create table if not exists lojas (
  id                text primary key,
  nome              text not null,
  discount_limit    numeric(5,2) not null default 10,
  service_fee_pct   numeric(5,2) not null default 10,
  created_at        timestamptz not null default now()
);

create table if not exists usuarios (
  id          text primary key,
  loja_id     text not null references lojas(id) on delete cascade,
  nome        text not null,
  role        text not null check (role in ('admin','gerente','operador')),
  pin_hash    text,
  ativo       boolean not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists ix_usuarios_loja on usuarios(loja_id);

create table if not exists produtos (
  id        text primary key,
  loja_id   text not null references lojas(id) on delete cascade,
  nome      text not null,
  preco     numeric(10,2) not null,
  categoria text,
  setor     text,
  ativo     boolean not null default true
);
create index if not exists ix_produtos_loja on produtos(loja_id);

create table if not exists comandas (
  id          text primary key,
  loja_id     text not null references lojas(id) on delete cascade,
  seq         integer,
  mesa        integer,
  status      text not null,
  aberta_em   timestamptz not null,
  fechada_em  timestamptz,
  version     integer not null default 0,
  updated_at  timestamptz not null,
  total       numeric(12,2) not null default 0,
  pago        numeric(12,2) not null default 0,
  saldo       numeric(12,2) not null default 0,
  doc         jsonb not null
);
create index if not exists ix_comandas_loja_status on comandas(loja_id, status);
create index if not exists ix_comandas_loja_mesa  on comandas(loja_id, mesa) where status = 'open';

create table if not exists avisos (
  id      text primary key,
  loja_id text not null references lojas(id) on delete cascade,
  at      timestamptz not null,
  doc     jsonb not null
);
create index if not exists ix_avisos_loja on avisos(loja_id, at desc);


create table if not exists mutacoes_aplicadas (
  mutation_id  text primary key,
  loja_id      text not null references lojas(id) on delete cascade,
  device_id    text,
  tipo         text not null,
  resultado    jsonb not null,
  aplicada_em  timestamptz not null default now()
);
create index if not exists ix_mutacoes_loja on mutacoes_aplicadas(loja_id, aplicada_em desc);


create table if not exists auditoria (
  id            bigserial primary key,
  loja_id       text not null references lojas(id) on delete cascade,
  at            timestamptz not null default now(),
  tipo          text not null,
  usuario_id    text,
  usuario_nome  text,
  papel         text,
  detalhe       text,
  mutation_id   text,
  device_id     text
);
create index if not exists ix_auditoria_loja on auditoria(loja_id, id desc);


create table if not exists sync_log (
  cursor   bigserial primary key,
  loja_id  text not null references lojas(id) on delete cascade,
  colecao  text not null,
  doc_id   text not null,
  at       timestamptz not null default now()
);
create index if not exists ix_sync_loja on sync_log(loja_id, cursor);



create table if not exists tentativas_login (
  loja_id     text not null,
  usuario_id  text not null,
  n           integer not null default 0,
  bloqueado_ate timestamptz,
  primary key (loja_id, usuario_id)
);`;

/** SQLite: abre, liga foreign keys, cria o schema e aplica migrações defensivas. */
export async function abrirSqlite(DatabaseSync, caminho) {
  const db = new DatabaseSync(caminho);
  db.exec('pragma foreign_keys = on');
  db.exec(SCHEMA_SQLITE);
  try { db.exec('alter table lojas add column config text'); } catch { /* já existe */ }
  return db;
}

/**
 * Postgres: cria o schema e a migração equivalente.
 * O DDL tem vários comandos num texto só: o PGlite precisa do `exec` dele
 * (não prepara multi-comando); o node-postgres aceita pelo protocolo simples.
 */
export async function migrarPg(queryable) {
  const executar = sql => (typeof queryable.exec === 'function' ? queryable.exec(sql) : queryable.query(sql));
  await executar(SCHEMA_PG);
  try { await executar('alter table lojas add column if not exists config jsonb'); } catch { /* já existe */ }
}
