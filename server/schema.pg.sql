-- Schema de PRODUÇÃO (PostgreSQL).
-- Mesma forma do schema SQLite usado na referência (server/store.mjs).
-- Diferenças: tipos, jsonb, e concorrência real entre instâncias.

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

-- Idempotência: a chave primária é o que impede cobrança dupla em retry.
create table if not exists mutacoes_aplicadas (
  mutation_id  text primary key,
  loja_id      text not null references lojas(id) on delete cascade,
  device_id    text,
  tipo         text not null,
  resultado    jsonb not null,
  aplicada_em  timestamptz not null default now()
);
create index if not exists ix_mutacoes_loja on mutacoes_aplicadas(loja_id, aplicada_em desc);

-- Trilha append-only: revogar UPDATE/DELETE é parte do desenho.
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

-- Cursor de sincronização: bigserial como relógio lógico por loja.
create table if not exists sync_log (
  cursor   bigserial primary key,
  loja_id  text not null references lojas(id) on delete cascade,
  colecao  text not null,
  doc_id   text not null,
  at       timestamptz not null default now()
);
create index if not exists ix_sync_loja on sync_log(loja_id, cursor);

-- Bloqueio por tentativas precisa ser COMPARTILHADO entre instâncias
-- (na referência fica em memória, o que não escala).
create table if not exists tentativas_login (
  loja_id     text not null,
  usuario_id  text not null,
  n           integer not null default 0,
  bloqueado_ate timestamptz,
  primary key (loja_id, usuario_id)
);

-- Endurecimento da auditoria em produção:
--   revoke update, delete on auditoria from app_user;
--   grant  insert, select on auditoria to app_user;
-- E o app nunca roda como superusuário.
