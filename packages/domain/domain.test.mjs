import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMutation, newComanda, subtotal, discountAmount, feeAmount, totalOf, remainingOf,
  paidTotal, discFactor, pendingQty, dispatchableQty, toDispatchQty, isRevenue, DomainError,
} from './index.mjs';

/* ---------- Fixtures ---------- */

const CATALOGO = [
  { id: 'p1', name: 'Cerveja 600ml', price: 10, category: 'Cervejas', sector: 'Bar', active: true },
  { id: 'p2', name: 'Pudim', price: 14, category: 'Sobremesas', sector: 'Cozinha', active: true },
  { id: 'p3', name: 'Filé', price: 62, category: 'Pratos', sector: 'Cozinha', active: false },
];

const ANA = { id: 'u1', name: 'Ana Souza', role: 'admin' };
const BRUNO = { id: 'u2', name: 'Bruno Lima', role: 'operador' };

const baseState = () => ({
  seq: 0, products: CATALOGO, waiters: [ANA, BRUNO], comandas: [], notices: [], audit: [],
});

let contador = 0;
const mid = () => `m${++contador}`;
const ctx = (extra = {}) => ({ products: CATALOGO, now: '2026-03-10T18:00:00.000Z', ...extra });

function aplicar(state, m, c = {}) {
  return applyMutation(state, { id: mid(), type: m.type, payload: m.payload }, c);
}

function comandaCom(itens = []) {
  let st = baseState();
  let r = aplicar(st, { type: 'comanda.open', payload: { comandaId: 'c1', table: 5 } }, ctx({ actor: ANA }));
  st = r.state;
  itens.forEach(({ pid, qty }, i) => {
    r = aplicar(st, { type: 'item.add', payload: { comandaId: 'c1', productId: pid, qty, iid: `i${i}` } }, ctx({ actor: ANA }));
    st = r.state;
  });
  return st;
}

/* ---------- Valor: paridade com o protótipo ---------- */

test('subtotal, desconto, taxa e total', () => {
  const st = comandaCom([{ pid: 'p1', qty: 2 }, { pid: 'p2', qty: 1 }]);   // 20 + 14 = 34
  const c = st.comandas[0];
  assert.equal(subtotal(c), 34);
  assert.equal(totalOf(c), 34);
});

test('taxa de serviço incide sobre o valor COM desconto', () => {
  let st = comandaCom([{ pid: 'p1', qty: 2 }]);          // 20
  st = aplicar(st, { type: 'fee.set', payload: { comandaId: 'c1', on: true, pct: 10 } }, ctx()).state;
  let c = st.comandas[0];
  assert.equal(feeAmount(c), 2);
  assert.equal(totalOf(c), 22);

  st = aplicar(st, { type: 'discount.set', payload: { comandaId: 'c1', dtype: 'percent', value: 10 } }, ctx({ isAdmin: true })).state;
  c = st.comandas[0];
  assert.equal(discountAmount(c), 2);
  assert.equal(feeAmount(c), 1.8, '10% de 18, não de 20');
  assert.equal(totalOf(c), 19.8);
});

test('desconto é limitado ao subtotal', () => {
  let st = comandaCom([{ pid: 'p1', qty: 1 }]);          // 10
  st = aplicar(st, { type: 'discount.set', payload: { comandaId: 'c1', dtype: 'value', value: 999 } }, ctx({ isAdmin: true })).state;
  assert.equal(discountAmount(st.comandas[0]), 10);
  assert.equal(totalOf(st.comandas[0]), 0);
});

test('fator de rateio carrega desconto e taxa proporcionalmente', () => {
  let st = comandaCom([{ pid: 'p1', qty: 2 }]);          // 20
  st = aplicar(st, { type: 'fee.set', payload: { comandaId: 'c1', on: true, pct: 10 } }, ctx()).state;
  const c = st.comandas[0];
  assert.equal(c.total, 22);
  assert.equal(discFactor(c), 1.1, 'cada item carrega 10% da taxa no rateio');
});

/* ---------- Quantidades de produção ---------- */

test('pendente, a despachar e despachável', () => {
  let st = comandaCom([{ pid: 'p1', qty: 3 }]);
  const it = () => st.comandas[0].items[0];
  assert.equal(pendingQty(it()), 3);
  assert.equal(toDispatchQty(it()), 3);
  assert.equal(dispatchableQty(it()), 0, 'nada despachável antes de ser enviado');

  st = aplicar(st, { type: 'item.sent', payload: { comandaId: 'c1', items: [{ iid: 'i0', qty: 1 }] } }, ctx()).state;
  assert.equal(pendingQty(it()), 2);
  assert.equal(dispatchableQty(it()), 1);
  assert.equal(toDispatchQty(it()), 3, 'a fila da cozinha continua com tudo que falta sair');

  st = aplicar(st, { type: 'item.dispatch', payload: { comandaId: 'c1', iid: 'i0' } }, ctx()).state;
  assert.equal(it().dispatchedQty, 1);
  assert.equal(dispatchableQty(it()), 0, 'não dá para despachar o que não foi enviado');
  assert.equal(toDispatchQty(it()), 2);
});

test('despacho é bloqueado sem envio e não fica negativo ao reduzir quantidade', () => {
  let st = comandaCom([{ pid: 'p1', qty: 3 }]);
  const r = aplicar(st, { type: 'item.dispatch', payload: { comandaId: 'c1', iid: 'i0' } }, ctx());
  assert.equal(r.info.skipped, 'not_dispatched_by_waiter');

  st = aplicar(st, { type: 'item.sent', payload: { comandaId: 'c1', items: [{ iid: 'i0', qty: 3 }] } }, ctx()).state;
  st = aplicar(st, { type: 'item.dispatch', payload: { comandaId: 'c1', iid: 'i0' } }, ctx()).state;
  assert.equal(st.comandas[0].items[0].dispatchedQty, 3);
  st = aplicar(st, { type: 'item.setQty', payload: { comandaId: 'c1', iid: 'i0', qty: 2 } }, ctx()).state;
  assert.equal(toDispatchQty(st.comandas[0].items[0]), 0, 'sem pendência negativa');
});

/* ---------- Autoridade do servidor sobre o dinheiro ---------- */

test('preço e setor vêm do catálogo, nunca do payload do cliente', () => {
  const st = comandaCom([]);
  const r = aplicar(st, {
    type: 'item.add',
    payload: { comandaId: 'c1', productId: 'p2', qty: 1, iid: 'x1', price: 0.01, sector: 'Bar' },
  }, ctx());
  const it = r.state.comandas[0].items[0];
  assert.equal(it.price, 14, 'cliente tentou pagar 1 centavo');
  assert.equal(it.sector, 'Cozinha', 'cliente tentou desviar a via');
});

test('produto inativo é recusado', () => {
  const st = comandaCom([]);
  assert.throws(
    () => aplicar(st, { type: 'item.add', payload: { comandaId: 'c1', productId: 'p3', qty: 1, iid: 'x' } }, ctx()),
    e => e instanceof DomainError && e.code === 'product_inactive',
  );
});

test('pagamento nunca passa do que falta', () => {
  let st = comandaCom([{ pid: 'p1', qty: 1 }]);          // 10
  st = aplicar(st, { type: 'payment.add', payload: { comandaId: 'c1', paymentId: 'pg1', amount: 999, method: 'PIX' } }, ctx({ actor: BRUNO })).state;
  const c = st.comandas[0];
  assert.equal(paidTotal(c), 10, 'cobrança limitada ao total');
  assert.equal(remainingOf(c), 0);
  assert.throws(
    () => aplicar(st, { type: 'payment.add', payload: { comandaId: 'c1', paymentId: 'pg2', amount: 5 } }, ctx()),
    e => e.code === 'nothing_to_pay',
  );
});

test('comanda só encerra quitada (ou com força explícita)', () => {
  let st = comandaCom([{ pid: 'p1', qty: 1 }]);
  assert.throws(() => aplicar(st, { type: 'comanda.close', payload: { comandaId: 'c1' } }, ctx()), e => e.code === 'has_balance');
  st = aplicar(st, { type: 'payment.add', payload: { comandaId: 'c1', paymentId: 'pg1', amount: 10, method: 'PIX' } }, ctx()).state;
  st = aplicar(st, { type: 'comanda.close', payload: { comandaId: 'c1' } }, ctx({ actor: ANA })).state;
  assert.equal(st.comandas[0].status, 'closed');
  assert.equal(st.comandas[0].closedByName, 'Ana Souza');
});

/* ---------- Limite de desconto por perfil ---------- */

test('operador acima do limite exige autorização de administrador', () => {
  const st = comandaCom([{ pid: 'p1', qty: 2 }]);        // 20
  assert.throws(
    () => aplicar(st, { type: 'discount.set', payload: { comandaId: 'c1', dtype: 'percent', value: 30 } },
      ctx({ actor: BRUNO, isAdmin: false, discountLimit: 10 })),
    e => e.code === 'discount_needs_auth',
  );
  const r = aplicar(st, { type: 'discount.set', payload: { comandaId: 'c1', dtype: 'percent', value: 30, auth: { byId: 'u1' } } },
    ctx({ actor: BRUNO, isAdmin: false, discountLimit: 10 }));
  assert.equal(r.state.comandas[0].discountAuth.byName, 'Ana Souza');
  assert.equal(r.state.comandas[0].discountAuth.pct, 30);
});

test('autorizador precisa ser admin ativo', () => {
  const st = comandaCom([{ pid: 'p1', qty: 2 }]);
  assert.throws(
    () => aplicar(st, { type: 'discount.set', payload: { comandaId: 'c1', dtype: 'percent', value: 30, auth: { byId: 'u2' } } },
      ctx({ actor: BRUNO, isAdmin: false, discountLimit: 10 })),
    e => e.code === 'discount_auth_invalid',
  );
});

test('desconto dentro do limite limpa autorização antiga', () => {
  let st = comandaCom([{ pid: 'p1', qty: 2 }]);
  st = aplicar(st, { type: 'discount.set', payload: { comandaId: 'c1', dtype: 'percent', value: 30, auth: { byId: 'u1' } } },
    ctx({ actor: BRUNO, isAdmin: false, discountLimit: 10 })).state;
  assert.ok(st.comandas[0].discountAuth);
  st = aplicar(st, { type: 'discount.set', payload: { comandaId: 'c1', dtype: 'percent', value: 5 } },
    ctx({ actor: BRUNO, isAdmin: false, discountLimit: 10 })).state;
  assert.equal(st.comandas[0].discountAuth, null);
});

/* ---------- Junção de mesas ---------- */

test('junção preserva itens, autoria, pagamentos e sai da receita', () => {
  let st = baseState();
  st = aplicar(st, { type: 'comanda.open', payload: { comandaId: 'c1', table: 5 } }, ctx({ actor: ANA })).state;
  st = aplicar(st, { type: 'item.add', payload: { comandaId: 'c1', productId: 'p1', qty: 1, iid: 'a1' } }, ctx({ actor: ANA })).state;
  st = aplicar(st, { type: 'comanda.open', payload: { comandaId: 'c2', table: 7 } }, ctx({ actor: BRUNO })).state;
  st = aplicar(st, { type: 'item.add', payload: { comandaId: 'c2', productId: 'p1', qty: 1, iid: 'b1' } }, ctx({ actor: BRUNO })).state;
  st = aplicar(st, { type: 'item.add', payload: { comandaId: 'c2', productId: 'p2', qty: 1, iid: 'b2' } }, ctx({ actor: BRUNO })).state;
  st = aplicar(st, { type: 'payment.add', payload: { comandaId: 'c2', paymentId: 'pg1', amount: 5, method: 'PIX' } }, ctx({ actor: BRUNO })).state;
  st = aplicar(st, { type: 'comanda.merge', payload: { comandaId: 'c1', absorbId: 'c2' } }, ctx({ actor: ANA })).state;

  const sobre = st.comandas.find(c => c.id === 'c1');
  const absorvida = st.comandas.find(c => c.id === 'c2');

  assert.equal(absorvida.status, 'merged');
  assert.equal(absorvida.mergedInto, 'c1');
  assert.equal(isRevenue(absorvida), false, 'comanda absorvida NÃO conta como venda');
  assert.equal(sobre.items.length, 3, 'cerveja da Ana, cerveja do Bruno (mesmo produto, autores diferentes) e o pudim');
  assert.equal(sobre.items[0].addedBy.name, 'Ana Souza');
  assert.equal(sobre.items[1].addedBy.name, 'Bruno Lima');
  assert.equal(sobre.payments.length, 1);
  assert.equal(sobre.payments[0].movedFrom.table, 7);
  assert.equal(sobre.total, 34, '10 da mesa 5 + 24 da mesa 7');
  assert.equal(sobre.paidTotal, 5, 'pagamento parcial transferido');
  assert.equal(sobre.remaining, 29);
  assert.equal(sobre.mergedFrom[0].table, 7);
});

test('junção soma descontos e o que já saiu para a produção', () => {
  let st = baseState();
  st = aplicar(st, { type: 'comanda.open', payload: { comandaId: 'c1', table: 5 } }, ctx({ actor: ANA })).state;
  st = aplicar(st, { type: 'item.add', payload: { comandaId: 'c1', productId: 'p1', qty: 2, iid: 'a1' } }, ctx({ actor: ANA })).state;
  st = aplicar(st, { type: 'discount.set', payload: { comandaId: 'c1', dtype: 'percent', value: 10 } }, ctx({ actor: ANA, isAdmin: true })).state;
  st = aplicar(st, { type: 'item.sent', payload: { comandaId: 'c1', items: [{ iid: 'a1', qty: 2 }] } }, ctx({ actor: ANA })).state;

  st = aplicar(st, { type: 'comanda.open', payload: { comandaId: 'c2', table: 7 } }, ctx({ actor: ANA })).state;
  st = aplicar(st, { type: 'item.add', payload: { comandaId: 'c2', productId: 'p1', qty: 1, iid: 'b1' } }, ctx({ actor: ANA })).state;
  st = aplicar(st, { type: 'discount.set', payload: { comandaId: 'c2', dtype: 'value', value: 3 } }, ctx({ actor: ANA, isAdmin: true })).state;

  st = aplicar(st, { type: 'comanda.merge', payload: { comandaId: 'c1', absorbId: 'c2' } }, ctx({ actor: ANA })).state;
  const c = st.comandas.find(x => x.id === 'c1');
  assert.equal(c.items.length, 1, 'mesmo produto e mesmo autor somam a linha');
  assert.equal(c.items[0].qty, 3);
  assert.equal(c.items[0].sentQty, 2, 'não remanda à cozinha o que já saiu');
  assert.equal(pendingQty(c.items[0]), 1);
  assert.equal(c.discountValue, 5, '2,00 + 3,00');
  assert.equal(c.total, 25);
});

/* ---------- Mesas ---------- */

test('não abre duas comandas na mesma mesa e a transferência libera a origem', () => {
  let st = baseState();
  st = aplicar(st, { type: 'comanda.open', payload: { comandaId: 'c1', table: 5 } }, ctx({ actor: ANA })).state;
  assert.throws(() => aplicar(st, { type: 'comanda.open', payload: { comandaId: 'c9', table: 5 } }, ctx()), e => e.code === 'table_busy');

  st = aplicar(st, { type: 'comanda.transfer', payload: { comandaId: 'c1', to: 8 } }, ctx({ actor: ANA })).state;
  assert.equal(st.comandas[0].table, 8);
  assert.equal(st.comandas[0].transfers[0].from, 5);

  // mesa 3 ocupada: recusa e mantém a comanda onde estava
  st = aplicar(st, { type: 'comanda.open', payload: { comandaId: 'c3', table: 3 } }, ctx({ actor: ANA })).state;
  assert.throws(
    () => aplicar(st, { type: 'comanda.transfer', payload: { comandaId: 'c1', to: 3 } }, ctx()),
    e => e.code === 'table_busy',
  );
  assert.equal(st.comandas.find(c => c.id === 'c1').table, 8, 'transferência recusada não move a comanda');
});

test('remover item que já não existe é ignorado, sem quebrar a sincronização', () => {
  let st = comandaCom([{ pid: 'p1', qty: 1 }]);
  st = aplicar(st, { type: 'item.remove', payload: { comandaId: 'c1', iid: 'i0' } }, ctx()).state;
  const r = aplicar(st, { type: 'item.remove', payload: { comandaId: 'c1', iid: 'i0' } }, ctx());
  assert.equal(r.info.skipped, 'item_not_found');
  assert.equal(r.state.comandas[0].items.length, 0);
});

test('mutação desconhecida é recusada', () => {
  const st = baseState();
  assert.throws(() => aplicar(st, { type: 'hack.everything', payload: {} }, ctx()), e => e.code === 'unknown_mutation');
});
