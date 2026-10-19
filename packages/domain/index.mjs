/**
 * @licence Domínio do Restaurante OS — regras puras.
 *
 * ESTE MÓDULO É A FONTE DA VERDADE do dinheiro.
 * Ele roda nos DOIS lados (servidor e cliente) e é o mesmo arquivo: é isso que
 * torna o modo offline seguro — o cliente aplica a regra para dar resposta
 * imediata, e o servidor reaplica a MESMA regra para decidir o valor oficial.
 *
 * Nada aqui toca rede, banco, DOM ou relógio global: recebe `now` quando precisa
 * de tempo, para ser determinístico e testável.
 */

/* ============================================================
   REGRAS DE VALOR (paridade 1:1 com o protótipo)
   ============================================================ */

const cents = n => Math.round((Number(n) || 0) * 100) / 100;

export function subtotal(c) {
  return cents((c.items || []).reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.qty) || 0), 0));
}

export function discountAmount(c) {
  const d = c.discount;
  if (!d || !d.value) return 0;
  const st = subtotal(c);
  const raw = d.type === 'percent' ? st * (Number(d.value) / 100) : Number(d.value);
  return cents(Math.max(0, Math.min(st, raw)));
}

/** Taxa de serviço incide sobre o valor JÁ com desconto. */
export function feeAmount(c) {
  if (!c.fee || !c.fee.on) return 0;
  const base = Math.max(0, subtotal(c) - discountAmount(c));
  return cents(base * (Number(c.fee.pct) || 0) / 100);
}

export function totalOf(c) {
  return Math.max(0, cents(subtotal(c) - discountAmount(c) + feeAmount(c)));
}

export function paidTotal(c) {
  return cents((c.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0));
}

export function remainingOf(c) {
  return Math.max(0, cents(totalOf(c) - paidTotal(c)));
}

/** Fator usado no rateio por item: mantém desconto e taxa proporcionais. */
export function discFactor(c) {
  const st = subtotal(c);
  return st > 0 ? totalOf(c) / st : 1;
}

export function sentQtyOf(it) { return Math.max(0, Number(it.sentQty) || 0); }
export function dispatchedQtyOf(it) { return Math.max(0, Number(it.dispatchedQty) || 0); }
/** Falta imprimir/enviar à produção. */
export function pendingQty(it) { return Math.max(0, (Number(it.qty) || 0) - sentQtyOf(it)); }
/** Falta a cozinha entregar (inclui o que ainda nem foi impresso). */
export function toDispatchQty(it) { return Math.max(0, (Number(it.qty) || 0) - dispatchedQtyOf(it)); }
/** Pode ser despachado agora: só o que já foi enviado à produção. */
export function dispatchableQty(it) {
  return Math.max(0, Math.min(Number(it.qty) || 0, sentQtyOf(it)) - dispatchedQtyOf(it));
}

export function methodLabel(c) {
  const ms = [...new Set((c.payments || []).map(p => p.method).filter(Boolean))];
  if (ms.length > 1) return `Múltiplo · ${c.payments.length} pagamentos`;
  if (ms.length === 1) return c.payments.length > 1 ? `${ms[0]} · ${c.payments.length} pagamentos` : ms[0];
  return c.payment?.method || '—';
}

/** Receita reconhecida: comanda encerrada. "merged" NÃO entra (evita contar 2x). */
export function isRevenue(c) { return c.status === 'closed'; }

/* ============================================================
   RECÁLCULO — sempre no servidor, nunca confiando no cliente
   ============================================================ */

export function recompute(c) {
  c.subtotal = subtotal(c);
  c.discountValue = discountAmount(c);
  c.feeAmount = feeAmount(c);
  c.total = totalOf(c);
  c.paidTotal = paidTotal(c);
  c.remaining = remainingOf(c);
  return c;
}

export function newComanda({ id, seq, table, waiterId, waiterName, openedAt, feePct = 0, feeDefault = false }) {
  return recompute({
    id, seq, table, status: 'open',
    openedAt, closedAt: null,
    waiterId: waiterId ?? null, waiterName: waiterName ?? 'Sem garçom',
    items: [],
    discount: { type: 'percent', value: 0 },
    discountAuth: null,
    fee: { pct: feePct, on: !!feeDefault },
    payments: [],
    transfers: [], mergedFrom: [], mergedInto: null,
    version: 0, updatedAt: openedAt,
  });
}

/* ============================================================
   MUTAÇÕES — a unidade de sincronização
   ------------------------------------------------------------
   Toda alteração vira uma mutação imutável, com id próprio.
   O cliente aplica local (resposta instantânea) e enfileira para o
   servidor. O servidor aplica a MESMA função e é ele quem decide.
   ============================================================ */

export class DomainError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function sectorDoNome(categoria) {
  const c = String(categoria || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return /bebida|cerveja|drink|vinho|chopp|suco|refrigerante|agua/.test(c) ? 'Bar' : 'Cozinha';
}

function ultimoAdmin(state, excluindoId) {
  return !(state.waiters || []).some(w => w.id !== excluindoId && w.active !== false && w.role === 'admin');
}

function mustComanda(state, comandaId) {
  const c = (state.comandas || []).find(x => x.id === comandaId);
  if (!c) throw new DomainError('comanda_not_found', `Comanda ${comandaId} não existe`);
  return c;
}

/**
 * Aplica uma mutação ao estado. Puro: devolve um novo estado (cópia) + resumo.
 * `ctx.products` é o catálogo OFICIAL — preço e setor saem daqui, nunca do payload.
 * `ctx.actor` é quem executa (para autoria e limites).
 */
export function applyMutation(state, m, ctx = {}) {
  const next = structuredClone(state);
  const products = ctx.products || next.products || [];
  const actor = ctx.actor || null;
  const now = ctx.now || new Date().toISOString();
  next.comandas = next.comandas || [];
  const info = { comandaIds: [], summary: '' };

  const touch = c => { c.version = (Number(c.version) || 0) + 1; c.updatedAt = now; recompute(c); return c; };

  switch (m.type) {
    case 'comanda.open': {
      const ja = next.comandas.find(c => c.status === 'open' && c.table === m.payload.table);
      if (ja) throw new DomainError('table_busy', `Mesa ${m.payload.table} já está ocupada`);
      next.seq = (Number(next.seq) || 1) + 1;
      const c = newComanda({
        id: m.payload.comandaId, seq: next.seq, table: m.payload.table,
        waiterId: actor?.id ?? null, waiterName: actor?.name ?? 'Sem garçom',
        openedAt: now, feePct: ctx.feePct ?? 0, feeDefault: ctx.feeDefault ?? false,
      });
      next.comandas.push(c);
      info.comandaIds.push(c.id);
      info.summary = `Comanda #${c.seq} aberta na mesa ${c.table}`;
      break;
    }

    case 'item.add': {
      const c = mustComanda(next, m.payload.comandaId);
      if (c.status !== 'open') throw new DomainError('comanda_closed', 'Comanda não está aberta');
      const p = products.find(x => x.id === m.payload.productId);
      if (!p) throw new DomainError('product_not_found', 'Produto inexistente');
      if (p.active === false) throw new DomainError('product_inactive', 'Produto inativo');
      const authorId = actor?.id ?? null;
      const qty = Math.max(1, Math.floor(Number(m.payload.qty) || 1));
      // mesmo produto + mesmo autor = mesma linha; autores diferentes = linhas separadas
      const igual = c.items.find(i => i.pid === p.id && ((i.addedBy?.id ?? null) === authorId));
      if (igual) {
        igual.qty += qty;
      } else {
        c.items.push({
          iid: m.payload.iid, pid: p.id, name: p.name,
          price: Number(p.price) || 0,                       // PREÇO DO CATÁLOGO, não do cliente
          sector: p.sector || 'Cozinha',
          qty, sentQty: 0, dispatchedQty: 0,
          addedBy: actor ? { id: actor.id, name: actor.name } : null,
          addedAt: now,
        });
      }
      touch(c);
      info.comandaIds.push(c.id);
      info.summary = `${qty}x ${p.name}`;
      break;
    }

    case 'item.setQty': {
      const c = mustComanda(next, m.payload.comandaId);
      const it = c.items.find(i => i.iid === m.payload.iid);
      if (!it) { info.skipped = 'item_not_found'; break; }   // alguém já removeu: estado do servidor vence
      const qty = Math.max(0, Math.floor(Number(m.payload.qty) || 0));
      if (qty === 0) c.items = c.items.filter(i => i.iid !== it.iid);
      else it.qty = qty;
      touch(c);
      info.comandaIds.push(c.id);
      break;
    }

    case 'item.remove': {
      const c = mustComanda(next, m.payload.comandaId);
      const antes = c.items.length;
      c.items = c.items.filter(i => i.iid !== m.payload.iid);
      if (c.items.length === antes) { info.skipped = 'item_not_found'; break; }
      touch(c);
      info.comandaIds.push(c.id);
      info.summary = `item removido da mesa ${c.table}`;
      break;
    }

    case 'item.sent': {   // garçom manda para a produção (por linha)
      const c = mustComanda(next, m.payload.comandaId);
      let n = 0;
      for (const envio of m.payload.items || []) {
        const it = c.items.find(i => i.iid === envio.iid);
        if (!it) continue;
        const q = Math.min(pendingQty(it), Math.max(0, Math.floor(Number(envio.qty) || 0)));
        if (q > 0) { it.sentQty = sentQtyOf(it) + q; n += q; }
      }
      if (!n) { info.skipped = 'nothing_pending'; break; }
      touch(c);
      info.comandaIds.push(c.id);
      info.summary = `${n} item(ns) para a produção · mesa ${c.table}`;
      break;
    }

    case 'item.dispatch': {   // cozinha marca o que entregou
      const c = mustComanda(next, m.payload.comandaId);
      const it = c.items.find(i => i.iid === m.payload.iid);
      if (!it) { info.skipped = 'item_not_found'; break; }
      const q = m.payload.qty != null ? Math.min(dispatchableQty(it), Math.floor(Number(m.payload.qty)))
                                      : dispatchableQty(it);
      if (q <= 0) { info.skipped = 'not_dispatched_by_waiter'; break; }   // nada despachado sem ter sido enviado
      it.dispatchedQty = dispatchedQtyOf(it) + q;
      touch(c);
      info.comandaIds.push(c.id);
      info.summary = `${q}x ${it.name} despachado · mesa ${c.table}`;
      break;
    }

    case 'payment.add': {
      const c = mustComanda(next, m.payload.comandaId);
      if (c.status !== 'open') throw new DomainError('comanda_closed', 'Comanda não está aberta');
      let amount = cents(m.payload.amount);
      if (amount <= 0) throw new DomainError('invalid_amount', 'Valor inválido');
      const rem = remainingOf(c);
      if (rem <= 0) throw new DomainError('nothing_to_pay', 'Conta já está quitada');
      if (amount > rem) amount = rem;                       // servidor limita: nunca cobra além do que falta
      c.payments.push({
        id: m.payload.paymentId, at: now, amount,
        method: m.payload.method || 'Dinheiro',
        mode: m.payload.mode || 'final',
        label: m.payload.label || '',
        card: m.payload.card || null,
        byId: actor?.id ?? null, byName: actor?.name ?? null,
      });
      touch(c);
      info.comandaIds.push(c.id);
      info.summary = `${amount.toFixed(2)} em ${c.payments.at(-1).method} · mesa ${c.table}`;
      break;
    }

    case 'payment.remove': {
      const c = mustComanda(next, m.payload.comandaId);
      const antes = c.payments.length;
      c.payments = c.payments.filter(p => p.id !== m.payload.paymentId);
      if (c.payments.length === antes) { info.skipped = 'payment_not_found'; break; }
      touch(c);
      info.comandaIds.push(c.id);
      info.summary = `estorno na mesa ${c.table}`;
      break;
    }

    case 'discount.set': {
      const c = mustComanda(next, m.payload.comandaId);
      const tipo = m.payload.dtype === 'value' ? 'value' : 'percent';
      let v = Math.max(0, cents(m.payload.value));
      const st = subtotal(c);
      if (tipo === 'percent' && v > 100) v = 100;
      if (tipo === 'value' && v > st) v = st;
      const pct = tipo === 'percent' ? v : (st > 0 ? v / st * 100 : 0);
      const limite = Number(ctx.discountLimit ?? 0);
      // Quem não é admin acima do limite precisa de autorização REGISTRADA
      if (!ctx.isAdmin && pct > limite + 1e-6) {
        if (!m.payload.auth) throw new DomainError('discount_needs_auth', 'Desconto acima do limite exige autorização');
        const adm = (next.waiters || []).find(w => w.id === m.payload.auth.byId && w.role === 'admin' && w.active !== false);
        if (!adm) throw new DomainError('discount_auth_invalid', 'Autorizador inválido');
        c.discountAuth = { byId: adm.id, byName: adm.name, at: now, pct: cents(pct) };
      } else {
        c.discountAuth = null;
      }
      c.discount = { type: tipo, value: v };
      touch(c);
      info.comandaIds.push(c.id);
      info.summary = `desconto ${pct.toFixed(1)}% · mesa ${c.table}`;
      break;
    }

    case 'fee.set': {
      const c = mustComanda(next, m.payload.comandaId);
      c.fee = { pct: Math.max(0, Math.min(100, Number(m.payload.pct) || 0)), on: !!m.payload.on };
      touch(c);
      info.comandaIds.push(c.id);
      break;
    }

    case 'comanda.transfer': {
      const c = mustComanda(next, m.payload.comandaId);
      if (next.comandas.some(x => x.status === 'open' && x.table === m.payload.to && x.id !== c.id))
        throw new DomainError('table_busy', `Mesa ${m.payload.to} está ocupada`);
      const from = c.table;
      c.table = m.payload.to;
      c.transfers.push({ from, to: m.payload.to, at: now, byId: actor?.id ?? null, byName: actor?.name ?? null });
      touch(c);
      info.comandaIds.push(c.id);
      info.summary = `mesa ${from} → ${m.payload.to}`;
      break;
    }

    case 'comanda.merge': {
      const sobre = mustComanda(next, m.payload.comandaId);
      const absorvida = mustComanda(next, m.payload.absorbId);
      if (sobre.id === absorvida.id) throw new DomainError('invalid_merge', 'Não é possível juntar a comanda com ela mesma');
      if (absorvida.status !== 'open' || sobre.status !== 'open')
        throw new DomainError('comanda_closed', 'Só comandas abertas podem ser juntadas');

      const descS = discountAmount(sobre), descA = discountAmount(absorvida);
      const totalA = totalOf(absorvida), pagoA = paidTotal(absorvida);
      const itensA = absorvida.items.reduce((s, i) => s + i.qty, 0);

      for (const it of absorvida.items) {
        const igual = sobre.items.find(x => x.pid === it.pid && ((x.addedBy?.id ?? null) === (it.addedBy?.id ?? null)));
        if (igual) {
          igual.qty += it.qty;
          igual.sentQty = Math.min(igual.qty, sentQtyOf(igual) + sentQtyOf(it));
          igual.dispatchedQty = Math.min(igual.qty, dispatchedQtyOf(igual) + dispatchedQtyOf(it));
        } else {
          sobre.items.push(structuredClone(it));
        }
      }
      for (const p of absorvida.payments) {
        sobre.payments.push({ ...p, id: p.id + ':moved:' + sobre.id,
          movedFrom: { comandaId: absorvida.id, seq: absorvida.seq, table: absorvida.table } });
      }
      const soma = cents(descS + descA);
      if (soma > 0) sobre.discount = { type: 'value', value: Math.min(subtotal(sobre), soma) };

      sobre.mergedFrom.push({
        comandaId: absorvida.id, seq: absorvida.seq, table: absorvida.table,
        at: now, items: itensA, total: totalA, paid: pagoA,
        byId: actor?.id ?? null, byName: actor?.name ?? null,
      });

      absorvida.status = 'merged';          // FORA da receita, para não contar a venda 2x
      absorvida.mergedInto = sobre.id;
      absorvida.mergedAt = now;
      absorvida.version = (Number(absorvida.version) || 0) + 1;
      absorvida.updatedAt = now;

      touch(sobre);
      info.comandaIds.push(sobre.id, absorvida.id);
      info.summary = `mesa ${absorvida.table} juntada na mesa ${sobre.table}`;
      break;
    }

    case 'comanda.close': {
      const c = mustComanda(next, m.payload.comandaId);
      if (c.status !== 'open') throw new DomainError('comanda_closed', 'Comanda já está encerrada');
      if (remainingOf(c) > 0 && !m.payload.force)
        throw new DomainError('has_balance', 'Ainda há saldo a receber');
      c.status = 'closed';
      c.closedAt = now;
      c.closedById = actor?.id ?? null;
      c.closedByName = actor?.name ?? null;
      c.payment = { method: methodLabel(c), received: null, change: 0 };
      touch(c);
      info.comandaIds.push(c.id);
      info.summary = `comanda #${c.seq} encerrada · ${totalOf(c).toFixed(2)}`;
      break;
    }

    case 'comanda.cancel': {
      const c = mustComanda(next, m.payload.comandaId);
      if (c.status !== 'open') throw new DomainError('comanda_closed', 'Só comandas abertas podem ser canceladas');
      c.status = 'cancelled';                      // fica registrada para auditoria, fora da operação
      c.cancelledAt = now;
      c.cancelledById = actor?.id ?? null;
      c.cancelledByName = actor?.name ?? null;
      touch(c);
      info.comandaIds.push(c.id);
      info.summary = `comanda #${c.seq} cancelada · mesa ${c.table} · ${totalOf(c).toFixed(2)}`;
      break;
    }

    case 'produto.salvar': {
      next.products = next.products || [];
      const p = next.products.find(x => x.id === m.payload.productId);
      const dados = {
        name: String(m.payload.nome || '').trim(),
        price: Math.max(0, cents(m.payload.preco)),
        category: (m.payload.categoria || '').trim() || 'Sem categoria',
        sector: (m.payload.setor || '').trim() || sectorDoNome(m.payload.categoria),
        active: m.payload.ativo !== false,
      };
      if (!dados.name) throw new DomainError('nome_obrigatorio', 'Informe o nome do produto');
      if (p) Object.assign(p, dados);
      else next.products.push({ id: m.payload.productId, ...dados });
      info.summary = `produto ${dados.name} ${p ? 'atualizado' : 'cadastrado'}`;
      break;
    }

    case 'produto.remover': {
      const antes = (next.products || []).length;
      next.products = (next.products || []).filter(x => x.id !== m.payload.productId);
      if (next.products.length === antes) { info.skipped = 'product_not_found'; break; }
      info.summary = 'produto excluído';           // comandas já lançadas não mudam: o item guarda nome e preço
      break;
    }

    case 'usuario.salvar': {
      next.waiters = next.waiters || [];
      const u = next.waiters.find(x => x.id === m.payload.usuarioId);
      const nome = String(m.payload.nome || '').trim();
      const papel = ['admin', 'gerente', 'operador'].includes(m.payload.role) ? m.payload.role : 'operador';
      if (!nome) throw new DomainError('nome_obrigatorio', 'Informe o nome');
      if (u) {
        const eraAdmin = u.active !== false && u.role === 'admin';
        const seraAdmin = m.payload.ativo !== false && papel === 'admin';
        if (eraAdmin && !seraAdmin && ultimoAdmin(next, u.id))
          throw new DomainError('ultimo_admin', 'É preciso manter ao menos um administrador ativo');
        Object.assign(u, { name: nome, role: papel, active: m.payload.ativo !== false });
      } else {
        next.waiters.push({ id: m.payload.usuarioId, name: nome, role: papel, active: m.payload.ativo !== false });
      }
      info.summary = `usuário ${nome} salvo como ${papel}`;
      break;
    }

    case 'usuario.remover': {
      const u = (next.waiters || []).find(x => x.id === m.payload.usuarioId);
      if (!u) { info.skipped = 'user_not_found'; break; }
      if (u.active !== false && u.role === 'admin' && ultimoAdmin(next, u.id))
        throw new DomainError('ultimo_admin', 'É preciso manter ao menos um administrador ativo');
      next.waiters = next.waiters.filter(x => x.id !== u.id);
      info.summary = `usuário ${u.name} removido`;
      break;
    }

    case 'config.salvar': {
      next.config = next.config || {};
      const permitido = ['nome', 'tables', 'allowDiscount', 'requireWaiter', 'sectors',
                         'serviceFeePct', 'serviceFeeDefault', 'discountLimit'];
      for (const k of permitido) {
        if (m.payload[k] === undefined) continue;
        next.config[k] = m.payload[k];
      }
      if (next.config.tables != null) next.config.tables = Math.max(1, Math.min(200, Math.floor(Number(next.config.tables) || 1)));
      if (m.payload.perm) next.config.perm = { ...(next.config.perm || {}), ...m.payload.perm };
      info.summary = 'configurações atualizadas';
      break;
    }

    case 'notice.send': {
      next.notices = next.notices || [];
      const n = {
        id: m.payload.noticeId, at: now,
        fromId: actor?.id ?? null, fromName: actor?.name ?? 'Operador',
        toId: m.payload.toId ?? null,
        table: m.payload.table ?? null, comandaId: m.payload.comandaId ?? null,
        text: String(m.payload.text || '').slice(0, 160),
        kind: m.payload.text ? 'texto' : 'chamada',
        readBy: actor?.id ? [actor.id] : [],
        readAt: {},
      };
      next.notices.unshift(n);
      if (next.notices.length > 200) next.notices.length = 200;
      info.comandaIds.push(n.comandaId);
      info.summary = `aviso ${n.kind} · mesa ${n.table}`;
      break;
    }

    case 'notice.read': {
      const n = (next.notices || []).find(x => x.id === m.payload.noticeId);
      if (!n) { info.skipped = 'notice_not_found'; break; }
      const key = actor?.id || '__anon__';
      n.readBy = n.readBy || [];
      n.readAt = n.readAt || {};
      if (!n.readBy.includes(key)) n.readBy.push(key);
      if (!n.readAt[key]) n.readAt[key] = now;
      break;
    }

    default:
      throw new DomainError('unknown_mutation', `Mutação desconhecida: ${m.type}`);
  }

  return { state: next, info };
}

export const MUTATION_TYPES = [
  'comanda.open', 'item.add', 'item.setQty', 'item.remove', 'item.sent', 'item.dispatch',
  'payment.add', 'payment.remove', 'discount.set', 'fee.set',
  'comanda.transfer', 'comanda.merge', 'comanda.close', 'comanda.cancel',
  'produto.salvar', 'produto.remover', 'usuario.salvar', 'usuario.remover', 'config.salvar',
  'notice.send', 'notice.read',
];
