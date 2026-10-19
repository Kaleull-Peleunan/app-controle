import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import { bancoDeTeste } from './apoio.mjs';
import { semearDemo } from '../server/seed.mjs';
import { createApp, listen } from '../server/app.mjs';
import { criarHub } from '../server/ws.mjs';

import * as DOMINIO from '../packages/domain/index.mjs';
import * as SYNC from '../client/sync-engine.mjs';

/**
 * A interface do protótipo, agora ligada ao motor de sincronização.
 *
 * Este teste NÃO simula a API: ele carrega o `client/index.html` servido pelo
 * backend, deixa o app.js rodar e conversa por HTTP de verdade. O que se prova:
 *   · a mesma UI, com o estado vindo do servidor;
 *   · duas "telas" (dois aparelhos) enxergando os mesmos dados;
 *   · offline no meio do atendimento, sem perder lançamento.
 */

const espera = ms => new Promise(r => setTimeout(r, ms));

async function ate(condicao, { timeout = 5000, intervalo = 40, oq = 'condição' } = {}) {
  const limite = Date.now() + timeout;
  while (Date.now() < limite) {
    const v = await condicao();
    if (v) return v;
    await espera(intervalo);
  }
  throw new Error('tempo esgotado esperando ' + oq);
}

async function subirServidor() {
  const { store } = await bancoDeTeste();
  await semearDemo(store);
  // Com hub: a UI usa push de verdade entre as duas telas.
  const srv = await listen(createApp({ store, secret: 'segredo-ui', hub: criarHub() }));
  return { ...srv, store };
}

/** Abre uma "tela" (aparelho) carregando o cliente do servidor. */
async function abrirTela(url, { loja = 'loja-1' } = {}) {
  const base = url + '/client/index.html';
  const html = await (await fetch(base)).text();
  const erros = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { if (!/not implemented/i.test(e.message)) erros.push(e.message); });

  const dom = new JSDOM(html, {
    url: base,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(win) {
      // Em navegador o domínio chega por módulo; o jsdom não executa modules,
      // então injetamos os MESMOS módulos antes do app.js rodar.
      win.DOMINIO = DOMINIO;
      win.SYNC = SYNC;
      win.fetch = (input, init) => fetch(input, init);
      win.WebSocket = WebSocket;          // o jsdom não traz WebSocket utilizável
      win.confirm = () => true;
      win.print = () => {};
      win.scrollTo = () => {};
      win.localStorage.setItem('creao_loja', loja);
      win.localStorage.removeItem('creao_ui_v1');
    },
  });

  const doc = dom.window.document;
  const api = {
    dom, win: dom.window, doc, erros,
    $: s => doc.querySelector(s),
    $$: s => Array.from(doc.querySelectorAll(s)),
    txt: s => (doc.querySelector(s)?.textContent || '').trim(),
    click(el) { if (!el) throw new Error('clique em elemento inexistente'); el.dispatchEvent(new dom.window.Event('click', { bubbles: true })); },
    setVal(el, v) { el.value = v; el.dispatchEvent(new dom.window.Event('input', { bubbles: true })); },
    money: s => (doc.querySelector(s)?.textContent || '').replace(/\u00a0/g, ' ').trim(),
    async login(usuarioId, pin) {
      await ate(() => doc.querySelector('#wlList .waiter-pick'), { oq: 'a lista de usuários' });
      const alvo = api.$$('#wlList .waiter-pick').find(b => b.dataset.w === usuarioId);
      assert.ok(alvo, 'usuário ' + usuarioId + ' na lista de login');
      api.click(alvo);
      await ate(() => doc.querySelector('#wlPinBox').hidden === false, { oq: 'o campo de PIN' });
      api.setVal(doc.querySelector('#wlPin'), pin);
      api.click(doc.querySelector('#wlConfirm'));
      await ate(() => doc.querySelector('#modalWaiterLogin').hidden === true, { oq: 'o login concluir' });
      await ate(() => doc.querySelectorAll('#gridTables .table-card').length > 0, { oq: 'o mapa de mesas' });
    },
    async abrirMesa(n) {
      api.click(doc.querySelector(`#gridTables .table-card[data-table="${n}"]`));
      await ate(() => doc.querySelector('#modalComanda').hidden === false, { oq: 'a comanda abrir' });
    },
    async adicionarProduto(nome) {
      api.setVal(doc.querySelector('#cmdSearch'), nome);
      await ate(() => api.$$('#cmdPicks .pick').some(p => p.textContent.includes(nome)), { oq: 'o produto na lista' });
      const pick = api.$$('#cmdPicks .pick').find(p => p.textContent.includes(nome));
      api.click(pick);
      await ate(() => api.txt('#cmdItems').includes(nome), { oq: 'o item na comanda' });
      api.setVal(doc.querySelector('#cmdSearch'), '');
    },
    engine() { return dom.window.APP.engine; },
    estado() { return dom.window.APP.estado; },
    fechar() {
      // Fecha o canal ANTES da janela: um aviso que chegasse depois do close()
      // encontraria um DOM morto e explodiria dentro do handler do motor.
      try { dom.window.APP?.engine?.fecharPush?.(false); } catch { /* já foi */ }
      dom.window.close();
    },
  };
  return api;
}

test('a UI carrega do servidor, exige login e mostra o estado da loja', async () => {
  const { url, close, store } = await subirServidor();
  let tela;
  try {
    tela = await abrirTela(url);
    await ate(() => tela.$('#wlList .waiter-pick'), { oq: 'a tela de login' });

    const nomes = tela.$$('#wlList .waiter-pick').map(b => b.textContent);
    assert.equal(nomes.length, 3, 'a equipe vem do servidor');
    assert.ok(nomes.some(n => n.includes('Ana Souza')));

    await tela.login('u-ana', '4321');
    assert.equal(tela.$('#modalComanda').hidden, true);
    assert.equal(tela.$$('#gridTables .table-card').length, 12, '12 mesas vindas da configuração da loja');
    assert.match(tela.txt('#syncEstado'), /sincronizado/);
    assert.equal(tela.txt('#brandName'), 'Bar do Zé', 'nome da loja veio do servidor');
    assert.equal((await store.estadoDaLoja('loja-1')).comandas.length, 0);
    assert.equal(tela.erros.length, 0, tela.erros.join(' | '));
  } finally { tela?.fechar(); await close(); }
});

test('abrir mesa e lançar item pela UI grava no servidor com o preço do catálogo', async () => {
  const { url, close, store } = await subirServidor();
  let tela;
  try {
    tela = await abrirTela(url);
    await tela.login('u-ana', '4321');

    await tela.abrirMesa(5);
    await tela.adicionarProduto('Cerveja 600ml');
    await tela.adicionarProduto('Cerveja 600ml');       // mesma linha
    await tela.adicionarProduto('Batata frita');

    assert.equal(tela.money('#cmdTotal'), 'R$ 72,00', '44 da cerveja + 28 da frita');

    const noServidor = await ate(async () => {
      const c = (await store.estadoDaLoja('loja-1')).comandas.find(x => x.table === 5);
      return c && c.items.length === 2 ? c : null;
    }, { oq: 'a comanda chegar ao servidor' });

    assert.equal(noServidor.items[0].price, 22, 'o preço é do catálogo do servidor');
    assert.equal(noServidor.items[0].qty, 2);
    assert.equal(noServidor.total, 72);
    assert.equal(noServidor.waiterName, 'Ana Souza', 'a autoria vem do token');
    assert.ok(tela.erros.length === 0, tela.erros.join(' | '));
  } finally { tela?.fechar(); await close(); }
});

test('duas telas enxergam as mesmas comandas (multi-dispositivo pela UI)', async () => {
  const { url, close } = await subirServidor();
  let a, b;
  try {
    a = await abrirTela(url);
    b = await abrirTela(url);
    await a.login('u-ana', '4321');
    await b.login('u-bruno', '1111');

    // Ana abre a mesa 3 e lança
    await a.abrirMesa(3);
    await a.adicionarProduto('Cerveja 600ml');
    await ate(() => /R\$ 22,00/.test(a.money('#cmdTotal')), { oq: 'o total na tela da Ana' });

    // O mapa do Bruno precisa receber a mesa ocupada sem ele fazer nada
    await ate(async () => {
      const card = b.doc.querySelector('#gridTables .table-card[data-table="3"]');
      return card && card.classList.contains('busy');
    }, { timeout: 15000, oq: 'a mesa 3 aparecer ocupada na tela do Bruno' });

    const cardB = b.doc.querySelector('#gridTables .table-card[data-table="3"]');
    assert.match(cardB.textContent, /22,00/, 'o Bruno vê o valor lançado pela Ana');

    // Bruno lança na MESMA comanda (chegou pelo sync) e a Ana vê o item dele
    b.click(b.doc.querySelector('#gridTables .table-card[data-table="3"]'));
    await ate(() => b.doc.querySelector('#modalComanda').hidden === false, { oq: 'a comanda no Bruno' });
    await b.adicionarProduto('Pudim');

    await ate(() => /R\$ 36,00/.test(a.money('#cmdTotal')), { oq: 'o total somado na tela da Ana' });

    const c = a.estado().comandas.find(x => x.table === 3);
    assert.equal(c.items.length, 2, 'duas linhas');
    assert.deepEqual(c.items.map(i => i.addedBy.name).sort(), ['Ana Souza', 'Bruno Lima'],
      'a autoria de cada item é preservada');
    assert.ok(a.erros.length === 0 && b.erros.length === 0, [...a.erros, ...b.erros].join(' | '));
  } finally { a?.fechar(); b?.fechar(); await close(); }
});

test('queda de internet no meio do atendimento não perde lançamento', async () => {
  const { url, close, store } = await subirServidor();
  let tela;
  try {
    tela = await abrirTela(url);
    await tela.login('u-ana', '4321');
    await tela.abrirMesa(7);
    await tela.adicionarProduto('Cerveja 600ml');
    // Espera a comanda E o item estarem no servidor — senão a rede "cai" com
    // o primeiro lançamento ainda em voo e a conta do teste deixa de bater.
    await ate(async () => {
      const c = (await store.estadoDaLoja('loja-1')).comandas[0];
      return c && c.items.length === 1 ? c : null;
    }, { oq: 'a primeira comanda subir' });

    // ---- a rede cai ----
    tela.engine().definirOnline(false);
    await ate(() => /offline/.test(tela.txt('#syncEstado')), { oq: 'o indicador ficar offline' });

    await tela.adicionarProduto('Cerveja 600ml');   // 2ª cerveja
    await tela.adicionarProduto('Picanha na chapa');
    assert.equal(tela.money('#cmdTotal'), 'R$ 133,00', 'a tela continua respondendo offline');
    assert.equal((await store.estadoDaLoja('loja-1')).comandas[0].items.length, 1,
      'o servidor não recebeu nada enquanto estava offline');
    assert.equal(tela.engine().pendentes, 2, 'dois lançamentos na fila do aparelho');
    assert.match(tela.txt('#syncEstado'), /2 na fila/);

    // ---- a rede volta ----
    tela.engine().definirOnline(true);
    const noServidor = await ate(async () => {
      const c = (await store.estadoDaLoja('loja-1')).comandas[0];
      return c && c.total === 133 ? c : null;
    }, { oq: 'a fila subir' });
    assert.equal(noServidor.items.length, 2, 'os dois lançamentos chegaram');
    assert.equal(noServidor.paidTotal, 0);
    await ate(() => /sincronizado/.test(tela.txt('#syncEstado')), { oq: 'o indicador voltar a sincronizado' });
    assert.ok(tela.erros.length === 0, tela.erros.join(' | '));
  } finally { tela?.fechar(); await close(); }
});

test('fechamento pela UI é validado pelo servidor e encerra a comanda', async () => {
  const { url, close, store } = await subirServidor();
  let tela;
  try {
    tela = await abrirTela(url);
    await tela.login('u-ana', '4321');
    await tela.abrirMesa(2);
    await tela.adicionarProduto('Cerveja 600ml');

    // com saldo, encerrar passa pelo pagamento — e o servidor é quem valida o saldo
    await ate(async () => (await store.estadoDaLoja('loja-1')).comandas.length === 1, { oq: 'a comanda subir' });
    tela.click(tela.$('#btnCloseComanda'));
    await ate(() => tela.$('#modalPay').hidden === false, { oq: 'o modal de pagamento' });
    tela.click(tela.doc.querySelector('#payMethods .pay[data-method="PIX"]'));
    tela.click(tela.$('#btnConfirmPay'));
    await ate(() => tela.$('#modalReceipt').hidden === false, { oq: 'o comprovante' });

    const fechada = await ate(async () => {
      const c = (await store.estadoDaLoja('loja-1')).comandas[0];
      return c.status === 'closed' ? c : null;
    }, { oq: 'o encerramento chegar ao servidor' });
    assert.equal(fechada.total, 22);
    assert.equal(fechada.paidTotal, 22);
    assert.equal(fechada.closedByName, 'Ana Souza');
    assert.match(tela.txt('#receiptContent'), /Cerveja 600ml/);
    assert.ok(tela.erros.length === 0, tela.erros.join(' | '));
  } finally { tela?.fechar(); await close(); }
});

test('o perfil é respeitado pelo servidor, não pela tela', async () => {
  const { url, close, store } = await subirServidor();
  let tela;
  try {
    tela = await abrirTela(url);
    await tela.login('u-bruno', '1111');            // operador
    await tela.abrirMesa(4);
    await tela.adicionarProduto('Cerveja 600ml');

    // desconto de 30% num item de R$ 22 passa do limite de 10%
    tela.setVal(tela.$('#discType'), 'percent');
    tela.$('#discType').dispatchEvent(new tela.win.Event('change', { bubbles: true }));
    tela.setVal(tela.$('#discValue'), '30');

    await ate(() => tela.$('#modalDiscAuth').hidden === false, { oq: 'o pedido de autorização' });
    assert.match(tela.txt('#discAuthInfo'), /acima do limite/);

    // e o servidor também recusaria se um cliente desatualizado insistisse
    const c = await ate(async () => (await store.estadoDaLoja('loja-1')).comandas[0], { oq: 'a comanda no servidor' });
    assert.equal(c.discountValue, 0, 'nada aplicado sem autorização');
    assert.ok(tela.erros.length === 0, tela.erros.join(' | '));
  } finally { tela?.fechar(); await close(); }
});
