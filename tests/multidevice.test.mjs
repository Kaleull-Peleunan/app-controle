import test from 'node:test';
import assert from 'node:assert/strict';
import { bancoDeTeste } from './apoio.mjs';
import { semearDemo } from '../server/seed.mjs';
import { createApp, listen } from '../server/app.mjs';
import { createSyncEngine, clienteHttp, storageMemoria } from '../client/sync-engine.mjs';

/**
 * O TESTE QUE IMPORTA: dois aparelhos no mesmo salão, um deles sem internet.
 *
 * Cobre exatamente a prioridade escolhida — multi-dispositivo e queda de rede:
 *   · o garçom continua trabalhando offline e ninguém perde o que ele lançou;
 *   · o reenvio (retry) não cobra duas vezes;
 *   · os aparelhos convergem quando a rede volta;
 *   · o que o servidor recusa não deixa lixo no aparelho.
 */

async function montarLoja() {
  const { store } = await bancoDeTeste();
  await semearDemo(store);
  const app = createApp({ store, secret: 'segredo-sync' });
  const srv = await listen(app);
  const api = clienteHttp(srv.url);

  const aparelho = async (usuarioId, pin, storage = storageMemoria()) => {
    const eng = createSyncEngine({ api, storage, lojaId: 'loja-1', deviceId: `dev-${usuarioId}`, onEvent: () => {} });
    await eng.login({ usuarioId, pin });
    await eng.bootstrap();
    return eng;
  };

  return { ...srv, store, api, aparelho };
}

const totalDa = (eng, comandaId) => eng.estado.comandas.find(c => c.id === comandaId)?.total;
const porMesa = (eng, mesa) => eng.estado.comandas.filter(c => c.table === mesa && c.status === 'open');

test('garçom offline continua lançando e sobe tudo ao reconectar', async () => {
  const { url, close, aparelho, store } = await montarLoja();
  try {
    const ana = await aparelho('u-ana', '4321');
    const bruno = await aparelho('u-bruno', '1111');

    /* ---- A (Ana) perde a internet ---- */
    ana.definirOnline(false);
    assert.equal(ana.online, false);

    const aberta = ana.abrirComanda({ table: 5, comandaId: 'c-mesa5' });
    assert.equal(aberta.ok, true, 'abre a comanda mesmo offline');
    ana.adicionarItem({ comandaId: 'c-mesa5', productId: 'p-cerveja', qty: 2, iid: 'i1' });
    ana.adicionarItem({ comandaId: 'c-mesa5', productId: 'p-frita', qty: 1, iid: 'i2' });
    ana.pagar({ comandaId: 'c-mesa5', amount: 40, method: 'PIX', paymentId: 'pg-1', mode: 'resto' });

    assert.equal(ana.estado.comandas.length, 1);
    assert.equal(totalDa(ana, 'c-mesa5'), 72, '44 da cerveja + 28 da frita');
    assert.equal(ana.estado.comandas[0].paidTotal, 40);
    assert.equal(ana.pendentes, 4, 'quatro mutações na fila do aparelho');
    assert.equal((await store.estadoDaLoja('loja-1')).comandas.length, 0, 'o servidor ainda não sabe de nada');

    /* ---- B (Bruno), online, trabalha em outra mesa ---- */
    bruno.abrirComanda({ table: 7, comandaId: 'c-mesa7' });
    bruno.adicionarItem({ comandaId: 'c-mesa7', productId: 'p-picanha', qty: 1, iid: 'j1' });
    await bruno.sincronizar();
    assert.equal(bruno.estado.comandas.length, 1, 'Bruno ainda não vê a mesa 5');

    /* ---- A volta a internet ---- */
    ana.definirOnline(true);
    await ana.sincronizar();

    assert.equal(ana.pendentes, 0, 'fila esvaziou');
    assert.equal((await store.estadoDaLoja('loja-1')).comandas.length, 2, 'as duas comandas chegaram');
    const noServidor = (await store.estadoDaLoja('loja-1')).comandas.find(c => c.id === 'c-mesa5');
    assert.equal(noServidor.total, 72, 'servidor recalculou o mesmo total');
    assert.equal(noServidor.paidTotal, 40);
    assert.equal(noServidor.remaining, 32);

    /* ---- convergência: os dois aparelhos enxergam o mesmo ---- */
    await bruno.sincronizar();
    for (const eng of [ana, bruno]) {
      const ids = eng.estado.comandas.map(c => c.id).sort();
      assert.deepEqual(ids, ['c-mesa5', 'c-mesa7'], 'mesmo conjunto de comandas');
      assert.equal(totalDa(eng, 'c-mesa5'), 72);
      assert.equal(totalDa(eng, 'c-mesa7'), 89);
    }
  } finally { await close(); }
});

test('reenvio depois de queda NÃO cobra duas vezes', async () => {
  const { url, close, aparelho, store, api } = await montarLoja();
  try {
    const ana = await aparelho('u-ana', '4321');

    ana.abrirComanda({ table: 5, comandaId: 'c-1' });
    ana.adicionarItem({ comandaId: 'c-1', productId: 'p-cerveja', qty: 2, iid: 'i1' });
    ana.pagar({ comandaId: 'c-1', amount: 44, method: 'PIX', paymentId: 'pg-1' });

    // a resposta se perdeu: o aparelho reenvia o MESMO lote (ids idênticos)
    const lote = ana.estado.outbox.slice();
    await ana.sincronizar();
    const reenvio = await api.push({ token: ana.estado.token, deviceId: 'dev-u-ana', mutations: lote });

    assert.equal(reenvio.ok, true);
    assert.ok(reenvio.resultados.every(r => r.idempotent), 'servidor reconhece o que já aplicou');

    const c = (await store.estadoDaLoja('loja-1')).comandas.find(x => x.id === 'c-1');
    assert.equal(c.payments.length, 1, 'um pagamento, não dois');
    assert.equal(c.paidTotal, 44, 'cobrado uma vez');
    assert.equal(c.items[0].qty, 2, 'quantidade não dobrou');
  } finally { await close(); }
});

test('mesa tomada por outro aparelho: servidor recusa e o fantasma é descartado', async () => {
  const { close, aparelho } = await montarLoja();
  try {
    const ana = await aparelho('u-ana', '4321');
    const bruno = await aparelho('u-bruno', '1111');

    // Ana abre a mesa 5 e sincroniza
    ana.abrirComanda({ table: 5, comandaId: 'c-ana' });
    await ana.sincronizar();

    // Bruno está offline e abre a MESMA mesa sem saber
    bruno.definirOnline(false);
    const r = bruno.abrirComanda({ table: 5, comandaId: 'c-bruno' });
    assert.equal(r.ok, true, 'localmente passa — ele ainda não sabe');
    assert.equal(bruno.estado.comandas.length, 1, 'aparelho mostra a comanda otimista');

    // volta a rede: o servidor recusa e o aparelho se corrige
    const recusas = [];
    bruno.definirOnline(true);
    await bruno.sincronizar();

    assert.equal(bruno.estado.comandas.length, 1);
    assert.equal(bruno.estado.comandas[0].id, 'c-ana', 'a comanda fantasma sumiu e a real apareceu');
    assert.equal(bruno.pendentes, 0, 'a mutação recusada saiu da fila');
  } finally { await close(); }
});

test('alterações concorrentes na mesma comanda convergem', async () => {
  const { close, aparelho } = await montarLoja();
  try {
    const ana = await aparelho('u-ana', '4321');
    const bruno = await aparelho('u-bruno', '1111');

    ana.abrirComanda({ table: 5, comandaId: 'c-1' });
    await ana.sincronizar();
    await bruno.sincronizar();

    // os dois lançam itens sem sincronizar entre si
    ana.definirOnline(false);
    bruno.definirOnline(false);
    ana.adicionarItem({ comandaId: 'c-1', productId: 'p-cerveja', qty: 2, iid: 'a-1' });   // Ana
    bruno.adicionarItem({ comandaId: 'c-1', productId: 'p-cerveja', qty: 1, iid: 'b-1' }); // Bruno

    assert.equal(ana.estado.comandas[0].items.length, 1);
    assert.equal(bruno.estado.comandas[0].items.length, 1);

    ana.definirOnline(true); bruno.definirOnline(true);
    await ana.sincronizar();
    await bruno.sincronizar();
    await ana.sincronizar();

    for (const eng of [ana, bruno]) {
      const c = eng.estado.comandas.find(x => x.id === 'c-1');
      assert.equal(c.items.length, 2, 'mesmo produto, autores diferentes: duas linhas');
      assert.equal(c.total, 66, '3 cervejas de R$ 22');
      assert.deepEqual(c.items.map(i => i.addedBy.name).sort(), ['Ana Souza', 'Bruno Lima']);
    }
  } finally { await close(); }
});

test('a fila sobrevive a fechar e reabrir o aplicativo', async () => {
  const { close, api } = await montarLoja();
  try {
    const storage = storageMemoria();
    const eng1 = createSyncEngine({ api, storage, lojaId: 'loja-1', deviceId: 'dev-x', onEvent: () => {} });
    await eng1.login({ usuarioId: 'u-ana', pin: '4321' });
    await eng1.bootstrap();

    eng1.definirOnline(false);
    eng1.abrirComanda({ table: 5, comandaId: 'c-1' });
    eng1.adicionarItem({ comandaId: 'c-1', productId: 'p-pudim', qty: 2, iid: 'i1' });
    assert.equal(eng1.pendentes, 2);

    // "fecha o app": nova instância sobre o MESMO armazenamento
    const eng2 = createSyncEngine({ api, storage, lojaId: 'loja-1', deviceId: 'dev-x', onEvent: () => {} });
    assert.equal(eng2.pendentes, 2, 'a fila foi preservada no aparelho');
    assert.equal(eng2.estado.comandas.length, 1, 'e o estado local também');

    await eng2.sincronizar();
    assert.equal(eng2.pendentes, 0);
    assert.equal(eng2.estado.comandas[0].total, 28, '2 pudins');
  } finally { await close(); }
});

test('a regra do servidor vale mesmo para um aparelho desatualizado', async () => {
  const { close, aparelho, store, api } = await montarLoja();
  try {
    const ana = await aparelho('u-ana', '4321');
    ana.abrirComanda({ table: 5, comandaId: 'c-1' });
    ana.adicionarItem({ comandaId: 'c-1', productId: 'p-picanha', qty: 1, iid: 'i1' });
    await ana.sincronizar();

    // A própria regra local já barra encerrar devendo — o aparelho não deixa
    // nem chegar no servidor, o que é a melhor defesa.
    const local = ana.encerrarComanda({ comandaId: 'c-1' });
    assert.equal(local.ok, false);
    assert.equal(local.error, 'has_balance');

    // Mas um cliente desatualizado (que não viu o pagamento de outro aparelho)
    // poderia insistir. O servidor recusa do mesmo jeito:
    const forca = await api.push({ token: ana.estado.token, deviceId: 'dev-x', mutations: [
      { id: 'forcado-1', type: 'comanda.close', payload: { comandaId: 'c-1' } },
    ] });
    assert.equal(forca.resultados[0].ok, false);
    assert.equal(forca.resultados[0].error, 'has_balance');
    assert.equal((await store.estadoDaLoja('loja-1')).comandas.find(x => x.id === 'c-1').status, 'open');

    // quita e encerra de verdade
    ana.pagar({ comandaId: 'c-1', amount: 89, method: 'PIX', paymentId: 'pg-1' });
    ana.encerrarComanda({ comandaId: 'c-1' });
    await ana.sincronizar();
    const fechada = (await store.estadoDaLoja('loja-1')).comandas.find(x => x.id === 'c-1');
    assert.equal(fechada.status, 'closed');
    assert.equal(fechada.closedByName, 'Ana Souza', 'autoria do encerramento vem do token, no servidor');
  } finally { await close(); }
});
