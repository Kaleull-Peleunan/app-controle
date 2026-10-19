import test from 'node:test';
import assert from 'node:assert/strict';
import { bancoDeTeste } from './apoio.mjs';
import { semearDemo } from '../server/seed.mjs';
import { createApp, listen } from '../server/app.mjs';
import { criarHub } from '../server/ws.mjs';
import { createSyncEngine, clienteHttp, storageMemoria } from '../client/sync-engine.mjs';

/**
 * Push em tempo real.
 *
 * O que se prova aqui:
 *   · dois aparelhos, um lança e o OUTRO recebe a mudança em menos de 1 segundo;
 *   · o aviso é um SINAL, não o dado (quem decide o que pode ser visto é o pull);
 *   · o canal se reconecta sozinho depois de cair;
 *   · loja não vê dado de outra loja.
 */

const espera = ms => new Promise(r => setTimeout(r, ms));
async function ate(cond, { timeout = 5000, intervalo = 10, oq = 'condição' } = {}) {
  const limite = Date.now() + timeout;
  while (Date.now() < limite) {
    const v = await cond();
    if (v) return v;
    await espera(intervalo);
  }
  throw new Error('tempo esgotado esperando ' + oq);
}

async function montarLoja({ comHub = true } = {}) {
  const { store } = await bancoDeTeste();
  await semearDemo(store);
  await store.criarLoja({ id: 'loja-2', nome: 'Bar Vizinha' });
  const hub = comHub ? criarHub() : null;
  const app = createApp({ store, secret: 'segredo-push', hub });
  const srv = await listen(app);
  const api = clienteHttp(srv.url);
  const urlPush = srv.url.replace(/^http/, 'ws') + '/ws';

  const aparelho = async (usuarioId, pin, loja = 'loja-1', { esperarPush = true } = {}) => {
    const eng = createSyncEngine({ api, storage: storageMemoria(), lojaId: loja, deviceId: `dev-${usuarioId}`, urlPush, onEvent: () => {} });
    await eng.login({ usuarioId, pin });
    await eng.bootstrap();
    eng.observarRede();                 // abre o canal de push
    if (esperarPush) await ate(() => eng.pushEstado === 'conectado', { oq: 'o push conectar' });
    return eng;
  };

  return { ...srv, store, api, aparelho, urlPush, hub };
}

test('o aviso é um sinal, não o dado', async () => {
  const { url, close, urlPush, aparelho, store } = await montarLoja();
  try {
    const ana = await aparelho('u-ana', '4321');

    // Cliente WebSocket cru: mostra exatamente o que trafega no socket.
    const recebidas = [];
    const ws = new WebSocket(`${urlPush}?token=${ana.estado.token}`);
    ws.onmessage = e => recebidas.push(JSON.parse(e.data));
    await ate(() => recebidas.length >= 1, { oq: 'a mensagem de boas-vindas' });

    assert.equal(recebidas[0].tipo, 'pronto');

    ana.abrirComanda({ table: 5, comandaId: 'c-1' });
    await ate(() => recebidas.some(m => m.tipo === 'mudou'), { oq: 'o aviso de mudança' });

    const aviso = recebidas.find(m => m.tipo === 'mudou');
    assert.ok(!aviso.comandas && !aviso.itens && !aviso.produtos,
      'o socket não transporta o dado — só o sinal para puxar');
    assert.equal(typeof aviso.cursor, 'number');
    assert.equal(aviso.por, 'Ana Souza');
    assert.ok(store.estadoDaLoja, 'o dado continua vindo pelo pull autenticado');
    ws.close();
  } finally { await close(); }
});

test('dois aparelhos: a mudança chega no outro em menos de 1 segundo', async () => {
  const { close, aparelho, store } = await montarLoja();
  try {
    const ana = await aparelho('u-ana', '4321');
    const bruno = await aparelho('u-bruno', '1111');

    assert.equal(ana.pushEstado, 'conectado');
    assert.equal(bruno.pushEstado, 'conectado');
    assert.equal(bruno.estado.comandas.length, 0, 'Bruno começa sem nada');

    // ---- o cronômetro começa ANTES de a Ana lançar ----
    const t0 = Date.now();
    ana.abrirComanda({ table: 3, comandaId: 'c-3' });
    ana.adicionarItem({ comandaId: 'c-3', productId: 'p-cerveja', qty: 2, iid: 'i-1' });

    const vista = await ate(() => bruno.estado.comandas.find(c => c.id === 'c-3'), {
      timeout: 3000, intervalo: 5, oq: 'o Bruno receber a comanda',
    });
    const ms = Date.now() - t0;

    assert.equal(vista.table, 3);
    assert.equal(vista.total, 44);
    assert.ok(ms < 1000, `esperado menos de 1s, levou ${ms}ms`);
    console.log(`      → o Bruno recebeu a comanda da mesa 3 em ${ms}ms`);

    // e no sentido contrário também
    const t1 = Date.now();
    bruno.adicionarItem({ comandaId: 'c-3', productId: 'p-pudim', qty: 1, iid: 'i-2' });
    await ate(() => (ana.estado.comandas.find(c => c.id === 'c-3') || {}).items?.length === 2, {
      timeout: 3000, intervalo: 5, oq: 'a Ana receber o item do Bruno',
    });
    const ms2 = Date.now() - t1;
    assert.ok(ms2 < 1000, `esperado menos de 1s no retorno, levou ${ms2}ms`);
    console.log(`      → a Ana recebeu o item do Bruno em ${ms2}ms`);

    const noServidor = await ate(async () => (await store.estadoDaLoja('loja-1')).comandas[0], { oq: 'o servidor gravar' });
    assert.equal(noServidor.total, 58, '3 cervejas... 44 + 14 do pudim');
  } finally { await close(); }
});

test('o canal cai e volta sozinho, sem perder aviso', async () => {
  const { close, aparelho } = await montarLoja();
  try {
    const ana = await aparelho('u-ana', '4321');
    const bruno = await aparelho('u-bruno', '1111');

    // Derruba o socket do Bruno (como faria a rede móvel)
    bruno.fecharPush();
    assert.equal(bruno.pushEstado, 'desconectado');

    // A reconexão é agendada sozinha; não há nada a chamar.
    await ate(() => bruno.pushEstado === 'conectado', { timeout: 5000, oq: 'o push reconectar sozinho' });
    console.log('      → o canal do Bruno reconectou sem intervenção');

    // e volta a receber na hora
    const t0 = Date.now();
    ana.abrirComanda({ table: 9, comandaId: 'c-9' });
    await ate(() => bruno.estado.comandas.find(c => c.id === 'c-9'), { timeout: 3000, intervalo: 5, oq: 'receber depois de reconectar' });
    const ms = Date.now() - t0;
    assert.ok(ms < 1000, `depois de reconectar, levou ${ms}ms`);
  } finally { await close(); }
});

test('o aviso não atravessa loja', async () => {
  const { close, aparelho, store } = await montarLoja();
  try {
    // um usuário da loja-2, sem nenhuma relação com a loja-1
    await store.criarUsuario({ id: 'u-zeca', lojaId: 'loja-2', nome: 'Zeca', role: 'admin', pinHash: null });
    const ana = await aparelho('u-ana', '4321', 'loja-1');
    const zeca = await aparelho('u-zeca', undefined, 'loja-2');
    assert.equal(zeca.pushEstado, 'conectado');

    ana.abrirComanda({ table: 5, comandaId: 'c-1' });
    await ate(async () => (await store.estadoDaLoja('loja-1')).comandas.length === 1, { oq: 'a loja-1 gravar' });
    await espera(300);                                  // dá tempo de um vazamento aparecer

    assert.equal(zeca.estado.comandas.length, 0, 'a loja-2 não recebeu nem viu nada da loja-1');
    assert.equal((await store.estadoDaLoja('loja-2')).comandas.length, 0);
  } finally { await close(); }
});

test('sem hub o servidor continua funcionando (push é opcional)', async () => {
  const { close, aparelho, url } = await montarLoja({ comHub: false });
  try {
    const ana = await aparelho('u-ana', '4321', 'loja-1', { esperarPush: false });
    await espera(200);
    assert.equal(ana.pushEstado, 'reconectando', 'sem canal, o motor fica tentando — e o app segue funcionando');

    const r = await (await fetch(url + '/ws/estatisticas')).json();
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'push_desligado');

    ana.abrirComanda({ table: 2, comandaId: 'c-2' });
    await ana.sincronizar();
    assert.equal(ana.estado.comandas.length, 1, 'os lançamentos continuam subindo pelo push/pull manual');
  } finally { await close(); }
});
