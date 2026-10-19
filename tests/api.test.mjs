import test from 'node:test';
import assert from 'node:assert/strict';
import { bancoDeTeste } from './apoio.mjs';
import { semearDemo } from '../server/seed.mjs';
import { createApp, listen } from '../server/app.mjs';

/**
 * Testes da API: as garantias que o protótipo não tinha.
 * Sobe um servidor real em porta aleatória e conversa por HTTP.
 */

async function subir() {
  const { store } = await bancoDeTeste();
  const { lojaId } = await semearDemo(store);
  const app = createApp({ store, secret: 'segredo-de-teste' });
  const srv = await listen(app);
  return { ...srv, store, lojaId };
}

const post = (base, caminho, corpo, token) => fetch(base + caminho, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(corpo ?? {}),
});
const get = (base, caminho, token) => fetch(base + caminho, {
  headers: token ? { authorization: `Bearer ${token}` } : {},
});

const mut = (type, payload, id) => ({ id: id || `m-${Math.random().toString(36).slice(2)}`, type, payload });

test('login, bloqueio por tentativas e sessão', async () => {
  const { url, close } = await subir();
  try {
    assert.equal((await get(url, '/health')).status, 200);

    const errado = await post(url, '/auth/login', { lojaId: 'loja-1', usuarioId: 'u-bruno', pin: '0000' });
    assert.equal(errado.status, 401);
    assert.equal((await errado.json()).erro, 'credenciais_invalidas');

    const semToken = await get(url, '/bootstrap');
    assert.equal(semToken.status, 401, 'bootstrap exige sessão');

    const ok = await post(url, '/auth/login', { lojaId: 'loja-1', usuarioId: 'u-bruno', pin: '1111' });
    assert.equal(ok.status, 200);
    const { token, usuario } = await ok.json();
    assert.equal(usuario.role, 'operador');
    assert.ok(token.includes('.'), 'token assinado');

    const adulterado = await get(url, '/bootstrap', token.slice(0, -3) + 'abc');
    assert.equal(adulterado.status, 401, 'token adulterado não passa');

    const boot = await get(url, '/bootstrap', token);
    assert.equal(boot.status, 200);
    const dados = await boot.json();
    assert.equal(dados.produtos.length, 11);
    assert.equal(dados.lojas, undefined);
    assert.ok(dados.cursor >= 0);
  } finally { await close(); }
});

test('5 tentativas erradas bloqueiam o usuário', async () => {
  const { url, close } = await subir();
  try {
    for (let i = 0; i < 5; i++) await post(url, '/auth/login', { lojaId: 'loja-1', usuarioId: 'u-ana', pin: '0000' });
    const bloqueado = await post(url, '/auth/login', { lojaId: 'loja-1', usuarioId: 'u-ana', pin: '4321' });
    assert.equal(bloqueado.status, 429, 'mesmo com o PIN certo, fica bloqueado');
    const corpo = await bloqueado.json();
    assert.ok(corpo.esperar_segundos > 0);
  } finally { await close(); }
});

test('sincronização aplica, é idempotente e o preço vem do catálogo', async () => {
  const { url, close } = await subir();
  try {
    const { token } = await (await post(url, '/auth/login', { lojaId: 'loja-1', usuarioId: 'u-ana', pin: '4321' })).json();

    const abertura = mut('comanda.open', { comandaId: 'c-1', table: 5 }, 'mx-1');
    const item = mut('item.add', { comandaId: 'c-1', productId: 'p-cerveja', qty: 2, iid: 'i-1', price: 0.01 }, 'mx-2');

    const r1 = await (await post(url, '/sync/push', { deviceId: 'dev-A', mutations: [abertura, item] }, token)).json();
    assert.equal(r1.aceitas, 2);
    assert.equal(r1.recusadas, 0);

    // retry do MESMO lote (rede caiu depois de enviar): nada duplica
    const r2 = await (await post(url, '/sync/push', { deviceId: 'dev-A', mutations: [abertura, item] }, token)).json();
    assert.equal(r2.aceitas, 2);
    assert.ok(r2.resultados.every(x => x.idempotent === true), 'reconhece que já aplicou');

    const { comandas } = await (await get(url, '/sync/pull?since=0', token)).json();
    assert.equal(comandas.length, 1, 'não criou comanda duplicada');
    assert.equal(comandas[0].items.length, 1);
    assert.equal(comandas[0].items[0].qty, 2, 'não somou de novo');
    assert.equal(comandas[0].items[0].price, 22, 'preço do catálogo, não os 1 centavo enviados');
    assert.equal(comandas[0].total, 44);
  } finally { await close(); }
});

test('recusa de domínio volta estruturada e com auditoria', async () => {
  const { url, close, store } = await subir();
  try {
    const { token } = await (await post(url, '/auth/login', { lojaId: 'loja-1', usuarioId: 'u-bruno', pin: '1111' })).json();

    await post(url, '/sync/push', { deviceId: 'd', mutations: [mut('comanda.open', { comandaId: 'c-1', table: 5 })] }, token);
    const abrirDeNovo = await (await post(url, '/sync/push',
      { deviceId: 'd', mutations: [mut('comanda.open', { comandaId: 'c-2', table: 5 })] }, token)).json();
    assert.equal(abrirDeNovo.recusadas, 1);
    assert.equal(abrirDeNovo.resultados[0].error, 'table_busy', 'mesa ocupada é recusada sem derrubar o lote');

    await post(url, '/sync/push', { deviceId: 'd', mutations: [
      mut('item.add', { comandaId: 'c-1', productId: 'p-file', qty: 1, iid: 'i-1' }),
    ] }, token);

    const descontoAlto = await (await post(url, '/sync/push', { deviceId: 'd', mutations: [
      mut('discount.set', { comandaId: 'c-1', dtype: 'percent', value: 30 }),
    ] }, token)).json();
    assert.equal(descontoAlto.resultados[0].error, 'discount_needs_auth', 'operador não passa do limite');

    const log = await store.listarAuditoria('loja-1', 20);
    assert.ok(log.some(l => l.tipo === 'mutacao_recusada'));
    assert.ok(log.some(l => l.tipo === 'pedido_enviado') === false);
  } finally { await close(); }
});

test('auditoria é do servidor e respeita o papel', async () => {
  const { url, close, store } = await subir();
  try {
    const op = await (await post(url, '/auth/login', { lojaId: 'loja-1', usuarioId: 'u-bruno', pin: '1111' })).json();
    const admin = await (await post(url, '/auth/login', { lojaId: 'loja-1', usuarioId: 'u-ana', pin: '4321' })).json();

    await post(url, '/sync/push', { deviceId: 'd', mutations: [
      mut('comanda.open', { comandaId: 'c-1', table: 5 }),
      mut('item.add', { comandaId: 'c-1', productId: 'p-cerveja', qty: 1, iid: 'i-1' }),
      mut('item.sent', { comandaId: 'c-1', items: [{ iid: 'i-1', qty: 1 }] }),
      mut('payment.add', { comandaId: 'c-1', paymentId: 'pg-1', amount: 22, method: 'PIX' }),
      mut('comanda.close', { comandaId: 'c-1' }),
    ] }, op.token);

    assert.equal((await get(url, '/auditoria', op.token)).status, 403, 'operador não vê a trilha');
    const r = await get(url, '/auditoria', admin.token);
    assert.equal(r.status, 200);
    const { itens } = await r.json();
    assert.ok(itens.some(i => i.tipo === 'pedido_enviado'));
    assert.ok(itens.some(i => i.tipo === 'comanda_encerrada'));
    assert.equal(itens[0].usuario_nome, 'Bruno Lima', 'quem agiu foi o Bruno (do token), não o cliente');
    assert.equal((await store.estadoDaLoja('loja-1')).comandas[0].status, 'closed');
  } finally { await close(); }
});

test('pull entrega só o que mudou desde o cursor', async () => {
  const { url, close } = await subir();
  try {
    const { token } = await (await post(url, '/auth/login', { lojaId: 'loja-1', usuarioId: 'u-ana', pin: '4321' })).json();
    const r1 = await (await post(url, '/sync/push', { deviceId: 'd', mutations: [
      mut('comanda.open', { comandaId: 'c-1', table: 5 }),
    ] }, token)).json();

    const vazio = await (await get(url, `/sync/pull?since=${r1.cursor}`, token)).json();
    assert.equal(vazio.comandas.length, 0, 'nada mudou desde então');

    const r2 = await (await post(url, '/sync/push', { deviceId: 'd', mutations: [
      mut('comanda.open', { comandaId: 'c-2', table: 7 }),
    ] }, token)).json();
    const delta = await (await get(url, `/sync/pull?since=${r1.cursor}`, token)).json();
    assert.equal(delta.comandas.length, 1, 'só a comanda nova');
    assert.equal(delta.comandas[0].id, 'c-2');
    assert.ok(r2.cursor > r1.cursor);
  } finally { await close(); }
});
