/**
 * Motor de sincronização offline-first.
 *
 * COMO FUNCIONA
 *   1. Toda ação do usuário vira uma MUTAÇÃO (id próprio, imutável).
 *   2. A mutação é aplicada LOCALMENTE na hora (mesma regra do servidor,
 *      mesmo arquivo de domínio) → resposta instantânea, sem esperar rede.
 *   3. A mutação entra numa FILA PERSISTENTE (outbox) no aparelho.
 *   4. Quando há rede, a fila é enviada EM ORDEM. O servidor é a autoridade:
 *      recalcula o dinheiro e diz o que aceitou.
 *   5. Depois do envio, o aparelho PUXA o que mudou desde o cursor dele e
 *      substitui as cópias locais. Isso vale para o que este aparelho fez e
 *      para o que os outros fizeram.
 *
 *   Consequência prática: a internet pode cair no meio do salão. O garçom
 *   continua lançando; quando volta, tudo sobe sem duplicar (a idempotência
 *   do servidor protege o reenvio) e os outros aparelhos convergem.
 *
 * O QUE ESTE MOTOR NÃO FAZ (e é honesto dizer)
 *   · não resolve edição simultânea do MESMO campo em duas mesas: quem chega
 *     depois ganha, e o aparelho perdedor recebe a versão do servidor;
 *   · a fila é serial por comanda (a ordem importa), não por loja.
 */

import { applyMutation, DomainError } from '../packages/domain/index.mjs';

const novoId = () => (globalThis.crypto?.randomUUID?.() ?? `x-${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function storageMemoria() {
  const m = new Map();
  return {
    get: k => (m.has(k) ? JSON.parse(m.get(k)) : null),
    set: (k, v) => m.set(k, JSON.stringify(v)),
    clear: () => m.clear(),
  };
}

export function createSyncEngine({ api, storage = storageMemoria(), deviceId = novoId(), lojaId, urlPush = null, onEvent = () => {} }) {
  let dados = storage.get('restaurant-os') || {
    lojaId: lojaId || null,
    token: null,
    usuario: null,
    produtos: [],
    usuarios: [],
    comandas: [],
    avisos: [],
    cursor: 0,
    outbox: [],
    config: { discountLimit: 10, serviceFeePct: 10 },
  };
  let online = true;
  let emVoo = false;
  let voo = null;
  let drenagem = null;
  let precisaReconciliar = false;
  let socketPush = null;
  let timerPush = null;
  let tentativasPush = 0;
  let pushEstado = urlPush ? 'desconectado' : 'desligado';

  const persistir = () => storage.set('restaurant-os', dados);
  const emitir = (tipo, info = {}) => onEvent({ tipo, ...info });
  const contexto = () => {
    const cfg = dados.config || {};
    return {
      config: cfg,
      products: dados.produtos,
      waiters: dados.usuarios,
      actor: dados.usuario ? { id: dados.usuario.id, name: dados.usuario.nome, role: dados.usuario.role } : null,
      isAdmin: dados.usuario?.role === 'admin',
      discountLimit: cfg.discountLimit ?? 10,
      feePct: cfg.serviceFeePct ?? 10,
      feeDefault: cfg.serviceFeeDefault === true,
      now: new Date().toISOString(),
    };
  };

  /* ---------- sessão ---------- */

  async function login({ usuarioId, pin }) {
    const r = await api.login({ lojaId: dados.lojaId, usuarioId, pin });
    if (!r.ok) return r;
    dados.token = r.token;
    dados.usuario = r.usuario;
    persistir();
    emitir('login', { usuario: r.usuario });
    conectarPush();
    return { ok: true, usuario: r.usuario };
  }

  async function bootstrap() {
    const r = await api.bootstrap(dados.token);
    if (!r.ok) return r;
    dados.produtos = r.produtos;
    dados.usuarios = r.usuarios.map(u => ({ id: u.id, name: u.nome, role: u.role, active: !!u.ativo, temPin: !!u.tem_pin }));
    dados.comandas = r.comandas;
    dados.avisos = r.avisos;
    dados.config = r.config || dados.config;
    dados.cursor = r.cursor;
    persistir();
    emitir('bootstrap');
    return { ok: true };
  }

  /* ---------- ação do usuário ---------- */

  /**
   * Aplica localmente e enfileira. Devolve na hora.
   * Se a própria regra local recusar (mesa ocupada, produto inativo), nada
   * entra na fila — o erro é de negócio, não de rede.
   */
  function dispatch(type, payload) {
    const mutation = { id: novoId(), type, payload: { ...payload }, criadaEm: new Date().toISOString() };
    let resultado;
    try {
      resultado = applyMutation(
        { ...estadoParaReducer(), comandas: dados.comandas, notices: dados.avisos },
        mutation,
        contexto(),
      );
    } catch (err) {
      if (err instanceof DomainError) return { ok: false, error: err.code, message: err.message, local: true };
      throw err;
    }

    dados.comandas = resultado.state.comandas;
    dados.avisos = resultado.state.notices;
    if (resultado.state.products) dados.produtos = resultado.state.products;
    if (resultado.state.waiters) dados.usuarios = resultado.state.waiters;
    if (resultado.state.config) dados.config = resultado.state.config;
    dados.outbox.push(mutation);
    persistir();
    emitir('local', { mutation, summary: resultado.info.summary });

    if (online) sincronizar().catch(() => {});
    return { ok: true, mutationId: mutation.id, summary: resultado.info.summary };
  }

  function estadoParaReducer() {
    return {
      seq: 0, products: dados.produtos, waiters: dados.usuarios,
      comandas: [], notices: [], config: dados.config || {},
    };
  }

  /* ---------- sincronização ---------- */

  /**
   * Se já existe uma sincronização em andamento, devolve A MESMA promessa.
   * Desistir com "em andamento" faria quem chamou acreditar que terminou —
   * e é justamente aí que o app pensa que subiu quando ainda não subiu.
   */
  async function sincronizar() {
    if (voo) return voo;
    if (!online || !dados.token) return { ok: false, motivo: 'offline_ou_sem_sessao' };
    voo = executarSincronizacao();
    try {
      const r = await voo;
      // Se entrou lançamento na fila ENQUANTO este ciclo rodava, o chamador que
      // chegou durante o voo recebeu a promise antiga e não empurrou nada. Sem
      // drenar aqui, o item só subiria no próximo aviso — ou nunca.
      if (r && r.ok && online && dados.outbox.length) agendarDrenagem();
      return r;
    } finally { voo = null; }
  }

  /** Um segundo ciclo curto depois do atual, para esvaziar o que chegou em voo. */
  function agendarDrenagem(){
    if (drenagem) return;
    drenagem = setTimeout(function(){
      drenagem = null;
      sincronizar().catch(function(){});
    }, 50);
    drenagem?.unref?.();
  }

  async function executarSincronizacao() {
    emVoo = true;
    try {
      const enviados = [];
      // envia a fila em ordem; o que for recusado sai da fila (o servidor manda no estado)
      while (dados.outbox.length) {
        const lote = dados.outbox.slice(0, 100);
        const r = await api.push({ token: dados.token, deviceId, mutations: lote });
        if (!r.ok) throw Object.assign(new Error('push_falhou'), { retry: true });

        const porId = new Map(r.resultados.map(x => [x.mutationId, x]));
        const recusadas = r.resultados.filter(x => !x.ok);
        if (recusadas.length) {
          // Ex.: mesa tomada por outro aparelho. O efeito otimista local precisa
          // ser desfeito, senão fica uma comanda fantasma que nunca existiu.
          precisaReconciliar = true;
          emitir('recusadas', { recusadas });
        }

        // só remove da fila o que o servidor confirmou (aceito ou recusado com motivo)
        dados.outbox = dados.outbox.filter(m => !porId.has(m.id));
        enviados.push(...r.resultados);
        // O CURSOR NÃO AVANÇA AQUI. O cursor do push é o topo do log do servidor,
        // e nele já estão mudanças de OUTROS aparelhos que este ainda não puxou.
        // Avançar por ele pularia essas mudanças. Quem avança o cursor é o pull.
        persistir();
      }

      await puxar();
      if (precisaReconciliar) await reconciliar();
      emitir('sincronizado', { enviados: enviados.length });
      return { ok: true, enviados: enviados.length };
    } catch (err) {
      dados.ultimoErro = String(err.message || err);
      persistir();
      emitir('erro', { erro: dados.ultimoErro });
      return { ok: false, motivo: 'falha_de_rede', erro: dados.ultimoErro };
    } finally {
      emVoo = false;
    }
  }

  async function puxar() {
    if (!dados.token) return { ok: false };
    const r = await api.pull({ token: dados.token, since: dados.cursor });
    if (!r.ok) return { ok: false };
    const porId = new Map(dados.comandas.map(c => [c.id, c]));
    for (const c of r.comandas) porId.set(c.id, c);        // servidor vence
    dados.comandas = [...porId.values()];

    const avisos = new Map(dados.avisos.map(a => [a.id, a]));
    for (const a of r.avisos || []) avisos.set(a.id, a);
    dados.avisos = [...avisos.values()];

    // catálogo, equipe e configuração também chegam pelos outros aparelhos
    if (r.produtos) dados.produtos = r.produtos;
    if (r.usuarios) dados.usuarios = r.usuarios.map(u => ({ id: u.id, name: u.nome, role: u.role, active: !!u.ativo, temPin: !!u.tem_pin }));
    if (r.config && r.config.length) dados.config = r.config[0];

    dados.cursor = r.cursor;
    persistir();
    emitir('pull', { comandas: r.comandas.length });
    return { ok: true };
  }

  /**
   * Descarta comandas locais que o servidor não conhece e que não têm mais
   * nada na fila — ou seja, criações que o servidor recusou. Sem isto, um
   * "mesa ocupada" recusado deixaria o aparelho mostrando uma comanda falsa.
   */
  async function reconciliar() {
    precisaReconciliar = false;
    if (!dados.token) return { ok: false };
    const r = await api.idsDaLoja(dados.token);
    if (!r.ok) { precisaReconciliar = true; return { ok: false }; }
    const noServidor = new Set(r.comandas);
    const pendentes = new Set(dados.outbox.flatMap(m => [m.payload?.comandaId, m.payload?.absorbId]).filter(Boolean));
    const antes = dados.comandas.length;
    dados.comandas = dados.comandas.filter(c => noServidor.has(c.id) || pendentes.has(c.id));
    if (dados.comandas.length !== antes) {
      emitir('reconciliado', { descartadas: antes - dados.comandas.length });
      persistir();
    }
    return { ok: true };
  }

  /* ---------- push em tempo real (WebSocket) ---------- */

  /**
   * Canal de aviso: o servidor diz "mudou" e este aparelho puxa por HTTP.
   * O dado NUNCA vem pelo socket — quem decide o que pode ser visto continua
   * sendo o GET /sync/pull, com a sessão validada.
   */
  function conectarPush(){
    if(!urlPush || !dados.token || typeof WebSocket === 'undefined') return;
    fecharPush(false);
    const sep = urlPush.includes('?') ? '&' : '?';
    let ws;
    try { ws = new WebSocket(urlPush + sep + 'token=' + encodeURIComponent(dados.token)); }
    catch(e){ agendarReconexao(); return; }
    pushEstado = 'conectando';
    socketPush = ws;

    ws.onopen = () => {
      pushEstado = 'conectado';
      tentativasPush = 0;
      emitir('push_conectado');
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if(msg.tipo === 'mudou'){
        // Aviso de OUTRO aparelho (o servidor não devolve ao autor): o que
        // interessa aqui é o dado, então puxa e reconcilia.
        emitir('push_mudou', { por: msg.por });
        sincronizar().catch(() => {});
      }
    };
    ws.onclose = () => {
      if(socketPush === ws) socketPush = null;
      pushEstado = online ? 'reconectando' : 'offline';
      agendarReconexao();
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  /** Reconexão com espera crescente (0,5s..15s) e um pouco de aleatoriedade. */
  function agendarReconexao(){
    if(!urlPush || !online) return;
    clearTimeout(timerPush);
    const base = Math.min(15000, 500 * Math.pow(2, tentativasPush++));
    timerPush = setTimeout(conectarPush, base + Math.random() * 250);
    // No Node o timer não deve segurar o processo vivo; no navegador é um número.
    timerPush?.unref?.();
  }

  function fecharPush(reagendar = true){
    clearTimeout(timerPush);
    if(!reagendar) tentativasPush = 0;
    const ws = socketPush;
    socketPush = null;
    if(ws){
      try { ws.onclose = null; ws.close(); } catch {}
    }
    if(!urlPush) return;
    // Fechar de propósito deixa o canal "desconectado" — e a reconexão já
    // está agendada, então ele volta sozinho.
    pushEstado = reagendar ? 'desconectado' : 'desligado';
    if(reagendar && online) agendarReconexao();
  }

  /* ---------- estado de rede ---------- */

  function definirOnline(v) {
    const antes = online;
    online = !!v;
    if(!antes && online){
      emitir('reconectado');
      sincronizar().catch(() => {});
      conectarPush();                    // volta o canal de aviso junto com a rede
    } else if(antes && !online){
      emitir('offline');
      fecharPush();                      // sem rede o socket não tem o que fazer
      clearTimeout(timerPush);
      pushEstado = 'offline';
    }
    return online;
  }

  /** Liga o motor ao navegador (no teste fica desligado). */
  function observarRede(alvo = globalThis) {
    if (!alvo?.addEventListener) return;
    alvo.addEventListener('online', () => definirOnline(true));
    alvo.addEventListener('offline', () => definirOnline(false));
    definirOnline(alvo.navigator?.onLine !== false);
    conectarPush();
  }

  return {
    get estado() { return dados; },
    get pendentes() { return dados.outbox.length; },
    get online() { return online; },
    get cursor() { return dados.cursor; },
    login, bootstrap, dispatch, sincronizar, puxar, reconciliar, definirOnline, observarRede,
    conectarPush, fecharPush,
    get pushEstado(){ return pushEstado; },
    // atalhos legíveis para a UI
    abrirComanda: ({ table, comandaId }) => dispatch('comanda.open', { table, comandaId }),
    adicionarItem: ({ comandaId, productId, qty = 1, iid = novoId() }) =>
      dispatch('item.add', { comandaId, productId, qty, iid }),
    definirQtd: ({ comandaId, iid, qty }) => dispatch('item.setQty', { comandaId, iid, qty }),
    removerItem: ({ comandaId, iid }) => dispatch('item.remove', { comandaId, iid }),
    enviarProducao: ({ comandaId, items }) => dispatch('item.sent', { comandaId, items }),
    despachar: ({ comandaId, iid, qty }) => dispatch('item.dispatch', { comandaId, iid, qty }),
    pagar: ({ comandaId, amount, method, paymentId = novoId(), mode = 'final', label = '' }) =>
      dispatch('payment.add', { comandaId, amount, method, paymentId, mode, label }),
    estornarPagamento: ({ comandaId, paymentId }) => dispatch('payment.remove', { comandaId, paymentId }),
    aplicarDesconto: ({ comandaId, dtype, value, auth }) => dispatch('discount.set', { comandaId, dtype, value, auth }),
    ligarTaxa: ({ comandaId, on, pct }) => dispatch('fee.set', { comandaId, on, pct }),
    transferir: ({ comandaId, to }) => dispatch('comanda.transfer', { comandaId, to }),
    juntar: ({ comandaId, absorbId }) => dispatch('comanda.merge', { comandaId, absorbId }),
    encerrarComanda: ({ comandaId, force }) => dispatch('comanda.close', { comandaId, force }),
    enviarAviso: ({ toId, table, comandaId, text }) =>
      dispatch('notice.send', { toId, table, comandaId, text, noticeId: novoId() }),
    lerAviso: ({ noticeId }) => dispatch('notice.read', { noticeId }),
    cancelarComanda: ({ comandaId }) => dispatch('comanda.cancel', { comandaId }),

    // administração (produtos, equipe, configuração)
    salvarProduto: ({ produtoId = novoId(), nome, preco, categoria, setor, ativo }) =>
      dispatch('produto.salvar', { produtoId, nome, preco, categoria, setor, ativo }),
    removerProduto: ({ produtoId }) => dispatch('produto.remover', { produtoId }),
    salvarUsuario: ({ usuarioId = novoId(), nome, role, ativo }) =>
      dispatch('usuario.salvar', { usuarioId, nome, role, ativo }),
    removerUsuario: ({ usuarioId }) => dispatch('usuario.remover', { usuarioId }),
    salvarConfig: ({ ...campos }) => dispatch('config.salvar', campos),

    /** PIN não passa pelo sync: vai por endpoint próprio, hasheado no servidor. */
    async definirPin({ usuarioId, pin }) {
      const r = await api.definirPin({ token: dados.token, usuarioId, pin });
      if (r.ok) {
        const u = dados.usuarios.find(x => x.id === usuarioId);
        if (u) u.temPin = r.temPin;
        persistir();
      }
      return r;
    },
    sair() {
      fecharPush(false);
      dados.token = null;
      dados.usuario = null;
      persistir();
      emitir('logout');
    },
  };
}

/** Cliente HTTP mínimo do motor (troque por fetch direto se preferir). */
export function clienteHttp(baseUrl) {
  const chamar = async (caminho, { metodo = 'GET', corpo, token } = {}) => {
    const res = await fetch(baseUrl + caminho, {
      method: metodo,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    return { ok: res.ok, status: res.status, ...(await res.json().catch(() => ({}))) };
  };
  return {
    login: ({ lojaId, usuarioId, pin }) => chamar('/auth/login', { metodo: 'POST', corpo: { lojaId, usuarioId, pin } }),
    /** Lista pública de quem pode entrar (sem PIN). Devolve null se o servidor não responder. */
    async usuariosDaLoja(lojaId) {
      try {
        const r = await chamar(`/auth/usuarios?loja=${encodeURIComponent(lojaId)}`);
        return r.ok && Array.isArray(r.usuarios) ? r.usuarios : null;
      } catch { return null; }
    },
    bootstrap: token => chamar('/bootstrap', { token }),
    push: ({ token, deviceId, mutations }) => chamar('/sync/push', { metodo: 'POST', corpo: { deviceId, mutations }, token }),
    pull: ({ token, since }) => chamar(`/sync/pull?since=${since}`, { token }),
    idsDaLoja: token => chamar('/sync/ids', { token }),
    definirPin: ({ token, usuarioId, pin }) => chamar('/usuarios/pin', { metodo: 'POST', corpo: { usuarioId, pin }, token }),
    auditoria: token => chamar('/auditoria', { token }),
  };
}
