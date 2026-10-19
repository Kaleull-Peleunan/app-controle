/**
 * Camada de dados do restaurante OS.
 *
 * Referência executável com SQLite embutido do Node (zero dependências).
 * Em produção o mesmo schema roda em Postgres — `server/schema.pg.sql`
 * traz o DDL equivalente e só os tipos mudam.
 *
 * Garantias que o protótipo NÃO tinha:
 *  · transação por mutação (ou aplica tudo, ou nada);
 *  · idempotência por mutation_id (retry de rede não duplica cobrança);
 *  · trilha de auditoria append-only, gravada pelo SERVIDOR;
 *  · dinheiro recalculado aqui, nunca aceito do cliente;
 *  · cursor de sincronização para o cliente puxar só o que mudou.
 */

import { DatabaseSync } from 'node:sqlite';
import { applyMutation, DomainError, totalOf, paidTotal, remainingOf } from '../packages/domain/index.mjs';
import { SCHEMA_SQLITE, SCHEMA_PG, migrarPg } from './schema.mjs';
import { driverPg, driverSqlite } from './drivers.mjs';

/**
 * O mesmo campo `doc` é `text` no SQLite e `jsonb` no Postgres. O driver pg já
 * devolve objeto; o SQLite devolve string. Uma função resolve os dois.
 */
const lerDoc = v => (typeof v === 'string' ? JSON.parse(v) : v);

/** Garante o schema do dialeto do driver (idempotente). */
async function garantirSchema(drv) {
  if (drv.dialect === 'pg') {
    await migrarPg(drv.bruto);
    return;
  }
  const db = drv.bruto;
  db.exec('pragma foreign_keys = on');
  db.exec(SCHEMA_SQLITE);
  try { db.exec('alter table lojas add column config text'); } catch { /* já existe */ }
}

/** SQLite para desenvolvimento e para a versão de um aparelho só. */
export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('pragma foreign_keys = on');
  db.exec(SCHEMA_SQLITE);
  try { db.exec('alter table lojas add column config text'); } catch { /* já existe */ }
  return db;
}

/* Auditoria: o servidor decide o que é sensível, não o cliente. */
const AUDITAVEIS = {
  'discount.set': v => (v.token ? 'desconto_autorizado' : 'desconto_aplicado'),
  'payment.remove': () => 'pagamento_estornado',
  'comanda.merge': () => 'mesas_juntadas',
  'comanda.transfer': () => 'mesa_transferida',
  'item.dispatch': () => 'item_despachado',
  'item.sent': () => 'pedido_enviado',
  'comanda.close': () => 'comanda_encerrada',
  'comanda.cancel': () => 'comanda_cancelada',
  'produto.remover': () => 'produto_removido',
  'usuario.salvar': () => 'usuario_salvo',
  'usuario.remover': () => 'usuario_removido',
  'config.salvar': () => 'configuracoes_alteradas',
};

const nowIso = () => new Date().toISOString();

/**
 * Cria o store sobre um banco: SQLite (DatabaseSync), Postgres (pool do `pg`
 * ou PGlite — qualquer coisa com `.query`) ou, sem argumento, SQLite em memória.
 * O schema do dialeto é aplicado aqui, então o mesmo modelo vale nos dois.
 */
export async function createStore(entrada) {
  let drv;
  if (entrada && entrada.dialect && typeof entrada.all === 'function') {
    drv = entrada;                                   // já é um driver (ver drivers.mjs)
  } else if (entrada && typeof entrada.query === 'function') {
    drv = driverPg(entrada);                         // pool do pg ou instância do PGlite
  } else if (entrada && typeof entrada.prepare === 'function') {
    drv = driverSqlite(entrada);
  } else {
    drv = driverSqlite(openDb(entrada?.arquivo || ':memory:'));
  }
  // O schema é idempotente (create table if not exists) e é aplicado SEMPRE:
  // quem monta o driver à mão não deveria precisar lembrar deste passo.
  await garantirSchema(drv);
  /* ---------- loja e cadastros ---------- */

  async function criarLoja({ id, nome, discountLimit = 10, serviceFeePct = 10, config = {} }) {
    await drv.run('insert into lojas (id, nome, discount_limit, service_fee_pct, config, created_at) values (?,?,?,?,?,?)', [id, nome, discountLimit, serviceFeePct, JSON.stringify(config), nowIso()] );
  }

  // `ativo` é BOOLEANO no domínio: o driver traduz para o tipo do banco.
  async function criarUsuario({ id, lojaId, nome, role, pinHash = null, ativo = true }) {
    await drv.run('insert into usuarios (id, loja_id, nome, role, pin_hash, ativo, created_at) values (?,?,?,?,?,?,?)', [id, lojaId, nome, role, pinHash, !!ativo, nowIso()] );
  }

  async function criarProduto({ id, lojaId, nome, preco, categoria, setor, ativo = true }) {
    await drv.run('insert into produtos (id, loja_id, nome, preco, categoria, setor, ativo) values (?,?,?,?,?,?,?)', [id, lojaId, nome, preco, categoria, setor, !!ativo] );
  }

  const getLoja = async (id, tx = drv) => await tx.get('select * from lojas where id = ?', [id] );
  const getUsuario = async (lojaId, id, tx = drv) => await tx.get('select * from usuarios where loja_id = ? and id = ?', [lojaId, id] );
  const listarUsuarios = async (lojaId, tx = drv) =>
    await tx.all('select id, nome, role, ativo, (pin_hash is not null) as tem_pin from usuarios where loja_id = ? order by nome', [lojaId] );
  // ATENÇÃO: o domínio fala em { name, price, sector, active }.
  // A tradução do banco (português) para o domínio acontece AQUI, num só lugar.
  const listarProdutos = async (lojaId, tx = drv) =>
    (await tx.all('select id, nome, preco, categoria, setor, ativo from produtos where loja_id = ? order by nome', [lojaId] )).map(p => ({
        id: p.id, name: p.nome, price: Number(p.preco) || 0,
        category: p.categoria, sector: p.setor, active: !!p.ativo,
      }));

  /* ---------- estado para o reducer ---------- */

  async function carregarComandas(lojaId, tx = drv) {
    return (await tx.all('select doc from comandas where loja_id = ?', [lojaId] )).map(r => lerDoc(r.doc));
  }

  const listarUsuariosDoc = async (lojaId, tx = drv) =>
    await tx.all('select id, nome, role, ativo from usuarios where loja_id = ? order by nome', [lojaId] );

  async function configDaLoja(lojaId, tx = drv) {
    const loja = await getLoja(lojaId, tx);
    const extra = loja?.config ? lerDoc(loja.config) : {};
    return {
      nome: loja?.nome ?? 'Minha loja',
      discountLimit: loja?.discount_limit ?? 10,
      serviceFeePct: loja?.service_fee_pct ?? 10,
      tables: extra.tables ?? 12,
      allowDiscount: extra.allowDiscount !== false,
      requireWaiter: extra.requireWaiter !== false,
      sectors: extra.sectors || ['Cozinha', 'Bar'],
      serviceFeeDefault: extra.serviceFeeDefault === true,
      perm: extra.perm || { products: false, toggleProducts: false, settings: false },
    };
  }

  async function estadoDaLoja(lojaId, tx = drv) {
    const usuarios = await listarUsuariosDoc(lojaId, tx);
    return {
      lojaId,
      seq: (await tx.get('select coalesce(max(seq),0) as s from comandas where loja_id = ?', [lojaId] )).s,
      products: await listarProdutos(lojaId, tx),
      waiters: usuarios.map(u => ({ id: u.id, name: u.nome, role: u.role, active: !!u.ativo })),
      comandas: await carregarComandas(lojaId),
      notices: (await tx.all('select doc from avisos where loja_id = ? order by at desc limit 200', [lojaId] )).map(r => lerDoc(r.doc)),
      config: await configDaLoja(lojaId),
    };
  }

  async function persistirComanda(lojaId, c, tx = drv) {
    await tx.run(`insert into comandas (id, loja_id, seq, mesa, status, aberta_em, fechada_em, version, updated_at, total, pago, saldo, doc)
                values (?,?,?,?,?,?,?,?,?,?,?,?,?)
                on conflict(id) do update set
                  seq = excluded.seq, mesa = excluded.mesa, status = excluded.status,
                  fechada_em = excluded.fechada_em, version = excluded.version,
                  updated_at = excluded.updated_at, total = excluded.total,
                  pago = excluded.pago, saldo = excluded.saldo, doc = excluded.doc`, [c.id, lojaId, c.seq ?? null, c.table ?? null, c.status, c.openedAt,
           c.closedAt ?? null, Number(c.version) || 0, c.updatedAt,
           totalOf(c), paidTotal(c), remainingOf(c), JSON.stringify(c)] );
    await marcarSync(lojaId, 'comandas', c.id, tx);
  }

  async function persistirProduto(lojaId, p, tx = drv) {
    await tx.run(`insert into produtos (id, loja_id, nome, preco, categoria, setor, ativo) values (?,?,?,?,?,?,?)
                on conflict(id) do update set nome=excluded.nome, preco=excluded.preco,
                  categoria=excluded.categoria, setor=excluded.setor, ativo=excluded.ativo`, [p.id, lojaId, p.name, p.price, p.category ?? null, p.sector ?? null, p.active !== false] );
    await marcarSync(lojaId, 'produtos', p.id, tx);
  }

  async function removerProduto(lojaId, id, tx = drv) {
    await tx.run('delete from produtos where loja_id = ? and id = ?', [lojaId, id] );
    await marcarSync(lojaId, 'produtos', id, tx);
  }

  async function persistirUsuario(lojaId, u, tx = drv) {
    await tx.run(`insert into usuarios (id, loja_id, nome, role, ativo, created_at) values (?,?,?,?,?,?)
                on conflict(id) do update set nome=excluded.nome, role=excluded.role, ativo=excluded.ativo`, [u.id, lojaId, u.name, u.role, u.active !== false, nowIso()] );
    await marcarSync(lojaId, 'usuarios', u.id, tx);
  }

  async function removerUsuario(lojaId, id, tx = drv) {
    await tx.run('delete from usuarios where loja_id = ? and id = ?', [lojaId, id] );
    await marcarSync(lojaId, 'usuarios', id, tx);
  }

  async function persistirConfig(lojaId, cfg, tx = drv) {
    await tx.run('update lojas set nome = ?, discount_limit = ?, service_fee_pct = ?, config = ? where id = ?', [cfg.nome, cfg.discountLimit, cfg.serviceFeePct, JSON.stringify({
        tables: cfg.tables, allowDiscount: cfg.allowDiscount, requireWaiter: cfg.requireWaiter,
        sectors: cfg.sectors, serviceFeeDefault: cfg.serviceFeeDefault, perm: cfg.perm,
      }), lojaId] );
    await marcarSync(lojaId, 'config', lojaId, tx);
  }

  /**
   * O PIN nunca entra no log de sincronização: ele é definido por um endpoint
   * próprio, é hasheado aqui e não é devolvido para nenhum aparelho.
   */
  async function definirPin(lojaId, usuarioId, pinHash) {
    const info = await drv.run('update usuarios set pin_hash = ? where loja_id = ? and id = ?', [pinHash, lojaId, usuarioId] );
    return info.changes > 0;
  }

  async function persistirAviso(lojaId, n, tx = drv) {
    await tx.run('insert into avisos (id, loja_id, at, doc) values (?,?,?,?) on conflict(id) do update set doc = excluded.doc', [n.id, lojaId, n.at, JSON.stringify(n)] );
    await marcarSync(lojaId, 'avisos', n.id, tx);
  }

  async function marcarSync(lojaId, colecao, docId, tx = drv) {
    await tx.run('insert into sync_log (loja_id, colecao, doc_id, at) values (?,?,?,?)', [lojaId, colecao, docId, nowIso()] );
  }

  async function cursorAtual(lojaId, tx = drv) {
    return (await tx.get('select coalesce(max(cursor),0) as c from sync_log where loja_id = ?', [lojaId] )).c;
  }

  async function registrarAuditoria({ lojaId, tipo, actor, detalhe, mutationId, deviceId }, tx = drv) {
    await tx.run(`insert into auditoria (loja_id, at, tipo, usuario_id, usuario_nome, papel, detalhe, mutation_id, device_id)
                values (?,?,?,?,?,?,?,?,?)`, [lojaId, nowIso(), tipo, actor?.id ?? null, actor?.name ?? 'sistema', actor?.role ?? null,
           detalhe ?? '', mutationId ?? null, deviceId ?? null] );
  }

  async function listarAuditoria(lojaId, limite = 50) {
    return await drv.all('select * from auditoria where loja_id = ? order by id desc limit ?', [lojaId, limite] );
  }

  /* ---------- o coração: aplicar mutação ---------- */

  /**
   * Aplica UMA mutação de forma atômica e idempotente.
   * Devolve sempre um objeto serializável (nunca lança por erro de domínio):
   * o cliente precisa saber distinguir "recusado" de "erro de rede".
   */
  async function aplicarMutacao({ lojaId, deviceId, mutation, actor }) {
    const jaAplicada = await drv.get('select resultado from mutacoes_aplicadas where mutation_id = ?', [mutation.id]);
    if (jaAplicada) {
      // Reenvio do mesmo lote (a resposta se perdeu): nada acontece duas vezes.
      return { ...lerDoc(jaAplicada.resultado), idempotent: true };
    }

    /**
     * Tudo numa transação — e, no Postgres, numa MESMA conexão (`tx`), senão o
     * `begin` valeria para uma conexão e o `commit` para outra. No SQLite a
     * transação é o próprio banco.
     */
    return await drv.transacao(async tx => {
      const state = await estadoDaLoja(lojaId, tx);
      const ctx = {
        products: state.products,
        waiters: state.waiters,
        actor,
        isAdmin: actor?.role === 'admin',
        discountLimit: state.config.discountLimit,
        feePct: state.config.serviceFeePct,
        feeDefault: state.config.serviceFeeDefault === true,
        now: nowIso(),
      };

      let novo, info;
      try {
        ({ state: novo, info } = applyMutation(state, mutation, ctx));
      } catch (err) {
        if (!(err instanceof DomainError)) throw err;      // erro real: desfaz tudo
        // Recusa de negócio é resultado, não exceção: registra e COMMITA.
        await registrarAuditoria({
          lojaId, tipo: 'mutacao_recusada', actor,
          detalhe: `${mutation.type}: ${err.code} — ${err.message}`,
          mutationId: mutation.id, deviceId,
        }, tx);
        const recusa = {
          ok: false, mutationId: mutation.id, type: mutation.type,
          error: err.code, message: err.message, cursor: await cursorAtual(lojaId, tx),
        };
        await tx.run(`insert into mutacoes_aplicadas (mutation_id, loja_id, device_id, tipo, resultado, aplicada_em)
                      values (?,?,?,?,?,?)`,
          [mutation.id, lojaId, deviceId ?? null, mutation.type, JSON.stringify(recusa), nowIso()]);
        return recusa;
      }

      const tocadas = [...new Set((info.comandaIds || []).filter(Boolean))];
      for (const id of tocadas) {
        const c = novo.comandas.find(x => x.id === id);
        if (c) await persistirComanda(lojaId, c, tx);
      }

      // coleções administrativas: o reducer devolve o estado novo, o store grava
      if (mutation.type === 'produto.salvar') {
        const p = novo.products.find(x => x.id === mutation.payload.productId);
        if (p) await persistirProduto(lojaId, p, tx);
      } else if (mutation.type === 'produto.remover') {
        await removerProduto(lojaId, mutation.payload.productId, tx);
      } else if (mutation.type === 'usuario.salvar') {
        const u = novo.waiters.find(x => x.id === mutation.payload.usuarioId);
        if (u) await persistirUsuario(lojaId, u, tx);
      } else if (mutation.type === 'usuario.remover') {
        await removerUsuario(lojaId, mutation.payload.usuarioId, tx);
      } else if (mutation.type === 'config.salvar') {
        await persistirConfig(lojaId, novo.config, tx);
      }
      if (mutation.type === 'notice.send' || mutation.type === 'notice.read') {
        for (const n of novo.notices) {
          const antes = state.notices.find(x => x.id === n.id);
          if (!antes || JSON.stringify(antes) !== JSON.stringify(n)) await persistirAviso(lojaId, n, tx);
        }
      }

      const tipoAuditoria = AUDITAVEIS[mutation.type]?.(mutation.payload || {});
      if (tipoAuditoria) {
        await registrarAuditoria({
          lojaId, tipo: tipoAuditoria, actor,
          detalhe: info.summary || mutation.type,
          mutationId: mutation.id, deviceId,
        }, tx);
      }

      const resultado = {
        ok: true,
        mutationId: mutation.id,
        type: mutation.type,
        comandaIds: tocadas,
        skipped: info.skipped ?? null,
        summary: info.summary ?? '',
        cursor: await cursorAtual(lojaId, tx),
      };
      await tx.run(`insert into mutacoes_aplicadas (mutation_id, loja_id, device_id, tipo, resultado, aplicada_em)
                    values (?,?,?,?,?,?)`,
        [mutation.id, lojaId, deviceId ?? null, mutation.type, JSON.stringify(resultado), nowIso()]);
      return resultado;
    });
  }


  /** Aplica um lote na ordem recebida. A ordem importa: é a ordem em que o usuário agiu. */
  async function aplicarLote({ lojaId, deviceId, mutations, actor }) {
    const resultados = [];
    for (const m of mutations || []) {
      resultados.push(await aplicarMutacao({ lojaId, deviceId, mutation: m, actor }));
    }
    return resultados;
  }

  /* ---------- sincronização de saída ---------- */

  async function pull(lojaId, since = 0) {
    const linhas = await drv.all('select cursor, colecao, doc_id from sync_log where loja_id = ? and cursor > ? order by cursor', [lojaId, since] );
    const porColecao = {};
    for (const l of linhas) (porColecao[l.colecao] = porColecao[l.colecao] || new Set()).add(l.doc_id);

    const comandas = [];
    for (const id of porColecao.comandas || []) {
      const r = await drv.get('select doc from comandas where loja_id = ? and id = ?', [lojaId, id] );
      if (r) comandas.push(lerDoc(r.doc));
    }
    const avisos = [];
    for (const id of porColecao.avisos || []) {
      const r = await drv.get('select doc from avisos where loja_id = ? and id = ?', [lojaId, id] );
      if (r) avisos.push(lerDoc(r.doc));
    }
    // Catálogo, equipe e configuração só entram na resposta se MUDARAM desde o
    // cursor. Devolver lista vazia quando nada mudou faria o aparelho apagar o
    // catálogo local — ausente significa "inalterado", vazio significa "apagado".
    const out = { cursor: await cursorAtual(lojaId), comandas, avisos };
    if (porColecao.produtos) out.produtos = await listarProdutos(lojaId);
    if (porColecao.usuarios) out.usuarios = await listarUsuarios(lojaId);
    if (porColecao.config) out.config = [await configDaLoja(lojaId)];
    return out;
  }

  /** Só os ids existentes: usado na reconciliação quando o servidor recusa algo. */
  async function idsDaLoja(lojaId) {
    return (await drv.all('select id from comandas where loja_id = ?', [lojaId] )).map(r => r.id);
  }

  async function bootstrap(lojaId) {
    return {
      loja: await getLoja(lojaId),
      usuarios: await listarUsuarios(lojaId),
      produtos: await listarProdutos(lojaId),
      comandas: await carregarComandas(lojaId),
      avisos: (await drv.all('select doc from avisos where loja_id = ? order by at desc limit 200', [lojaId] )).map(r => lerDoc(r.doc)),
      config: await configDaLoja(lojaId),
      cursor: await cursorAtual(lojaId),
    };
  }

  return {
    drv, bruto: drv.bruto, criarLoja, criarUsuario, criarProduto, getLoja, getUsuario, listarUsuarios, listarProdutos,
    estadoDaLoja, aplicarMutacao, aplicarLote, pull, bootstrap, cursorAtual, registrarAuditoria, listarAuditoria, idsDaLoja,
    definirPin, configDaLoja,
  };
}
