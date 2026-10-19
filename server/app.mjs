/**
 * API HTTP do restaurante OS — sem dependências (node:http).
 *
 * Contrato de sincronização:
 *   POST /auth/login   { lojaId, usuarioId, pin }        -> { token, usuario }
 *   GET  /bootstrap                                       -> estado inicial completo + cursor
 *   POST /sync/push    { deviceId, mutations: [...] }     -> resultados por mutação
 *   GET  /sync/pull    ?since=<cursor>                    -> o que mudou desde o cursor
 *   GET  /auditoria                                       -> trilha (admin/gerente)
 *   GET  /health
 *
 * Regras que a API garante:
 *   · dinheiro é recalculado no servidor (o cliente não manda total);
 *   · mutação repetida (mesmo id) não tem efeito duas vezes;
 *   · toda mutação é atômica;
 *   · autorização por papel é conferida aqui.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize } from 'node:path';
import { createSession, verifySession, hashPin, verifyPin, createLoginGuard, can } from './auth.mjs';
import { anexarWebSocket } from './ws.mjs';

const RAIZ = fileURLToPath(new URL('..', import.meta.url));   // raiz do repositório
const MIMES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

/**
 * Serve o cliente (PWA) do próprio backend. Sem CDN e sem passo de build:
 * o navegador carrega o MESMO módulo de domínio que o servidor executa.
 */
async function servirEstatico(res, caminho) {
  const seguro = normalize(caminho).replace(/^([.][.][/\\])+/, '');
  const alvo = join(RAIZ, seguro);
  if (!alvo.startsWith(RAIZ)) return responder(res, 403, { erro: 'fora_da_raiz' });
  try {
    const conteudo = await readFile(alvo);
    res.writeHead(200, { 'content-type': MIMES[extname(alvo)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(conteudo);
  } catch {
    responder(res, 404, { erro: 'arquivo_nao_encontrado', caminho: seguro });
  }
}

const LIMITE_CORPO = 2 * 1024 * 1024;   // 2 MB: um lote de mutações não deve passar disso

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let tamanho = 0;
    const partes = [];
    req.on('data', c => {
      tamanho += c.length;
      if (tamanho > LIMITE_CORPO) { reject(Object.assign(new Error('payload_too_large'), { status: 413 })); req.destroy(); return; }
      partes.push(c);
    });
    req.on('end', () => {
      if (!partes.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(partes).toString('utf8'))); }
      catch { reject(Object.assign(new Error('json_invalido'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function responder(res, status, dados) {
  const corpo = JSON.stringify(dados);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(corpo),
  });
  res.end(corpo);
}

export function createApp({ store, secret = 'troque-este-segredo', guard = createLoginGuard(), now = () => Date.now(), hub = null }) {
  const rotas = [];
  const on = (metodo, caminho, handler) => rotas.push({ metodo, caminho, handler });

  /* ---------- público ---------- */

  on('GET', '/health', async () => ({ status: 200, body: { ok: true, hora: new Date(now()).toISOString() } }));

  /**
   * Quem pode entrar nesta loja. Devolve id, nome e perfil para a tela de
   * login montar a lista — nunca o PIN, nem seu hash. É público de propósito:
   * o segredo que protege a entrada é o PIN, não o nome das pessoas.
   */
  on('GET', '/auth/usuarios', async ({ query }) => {
    const loja = query.get('loja');
    if (!loja) return { status: 400, body: { erro: 'loja_obrigatoria' } };
    if (!await store.getLoja(loja)) return { status: 404, body: { erro: 'loja_inexistente' } };
    return { status: 200, body: { usuarios: ((await store.listarUsuarios(loja))).map(u => ({
      id: u.id, nome: u.nome, role: u.role, ativo: !!u.ativo, temPin: !!u.tem_pin,
    })) } };
  });

  on('POST', '/auth/login', async ({ body }) => {
    const { lojaId, usuarioId, pin } = body || {};
    if (!lojaId || !usuarioId) return { status: 400, body: { erro: 'loja_e_usuario_obrigatorios' } };

    const espera = guard.bloqueado(lojaId, usuarioId, now());
    if (espera) return { status: 429, body: { erro: 'bloqueado', esperar_segundos: espera } };

    const u = await store.getUsuario(lojaId, usuarioId);
    // mesma resposta para usuário inexistente e PIN errado: não entrega quem existe
    const ok = u && u.ativo && (!u.pin_hash || verifyPin(pin, u.pin_hash));
    if (!ok) {
      const restante = guard.falhou(lojaId, usuarioId, now());
      return { status: 401, body: { erro: 'credenciais_invalidas', bloqueado_em: restante || null } };
    }
    guard.acertou(lojaId, usuarioId);
    const token = createSession({ userId: u.id, lojaId, role: u.role, secret, now: now() });
    return { status: 200, body: { token, usuario: { id: u.id, nome: u.nome, role: u.role, lojaId } } };
  });

  /* ---------- autenticado ---------- */

  function autenticar(req) {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    return verifySession(token, secret, now());
  }

  on('GET', '/bootstrap', async ({ sessao }) => {
    if (!sessao) return { status: 401, body: { erro: 'nao_autenticado' } };
    const u = await store.getUsuario(sessao.loja, sessao.sub);
    if (!u || !u.ativo) return { status: 401, body: { erro: 'sessao_invalida' } };
    return { status: 200, body: { ...(await store.bootstrap(sessao.loja)), usuario: { id: u.id, nome: u.nome, role: u.role } } };
  });

  on('POST', '/sync/push', async ({ body, sessao }) => {
    if (!sessao) return { status: 401, body: { erro: 'nao_autenticado' } };
    const u = await store.getUsuario(sessao.loja, sessao.sub);
    if (!u || !u.ativo) return { status: 401, body: { erro: 'sessao_invalida' } };

    const mutations = Array.isArray(body?.mutations) ? body.mutations : [];
    if (mutations.length > 500) return { status: 413, body: { erro: 'lote_grande_demais' } };

    // o ATOR vem do token, nunca do payload
    const actor = { id: u.id, name: u.nome, role: u.role };
    const resultados = await store.aplicarLote({ lojaId: sessao.loja, deviceId: body?.deviceId, mutations, actor });
    const aceitas = resultados.filter(r => r.ok).length;

    // Avisa os OUTROS aparelhos da mesma loja. O aviso é só um sinal: quem
    // recebe puxa o que mudou por HTTP, onde a sessão é validada de verdade.
    if (hub && aceitas > 0) {
      hub.publicar(sessao.loja, {
        tipo: 'mudou',
        cursor: await store.cursorAtual(sessao.loja),
        deviceId: body?.deviceId ?? null,
        por: u.nome,
      });
    }
    return {
      status: 200,
      body: {
        deviceId: body?.deviceId ?? null,
        recebidas: mutations.length,
        aceitas,
        recusadas: mutations.length - aceitas,
        resultados,
        cursor: await store.cursorAtual(sessao.loja),
      },
    };
  });

  on('GET', '/sync/pull', async ({ query, sessao }) => {
    if (!sessao) return { status: 401, body: { erro: 'nao_autenticado' } };
    const since = Math.max(0, Number(query.get('since') || 0) || 0);
    return { status: 200, body: await store.pull(sessao.loja, since) };
  });

  /** Diagnóstico do canal de push (útil para operação e para os testes). */
  on('GET', '/ws/estatisticas', async () => ({
    status: 200,
    body: hub ? { ok: true, ...hub.estatisticas() } : { ok: false, motivo: 'push_desligado' },
  }));

  /**
   * O PIN tem endpoint próprio, de propósito: ele NUNCA passa pelo log de
   * sincronização (senão o segredo viajaria para todos os aparelhos).
   */
  on('POST', '/usuarios/pin', async ({ body, sessao }) => {
    if (!sessao) return { status: 401, body: { erro: 'nao_autenticado' } };
    if (!can(sessao.role, 'equipe.*')) return { status: 403, body: { erro: 'sem_permissao' } };
    const { usuarioId, pin } = body || {};
    if (!usuarioId) return { status: 400, body: { erro: 'usuario_obrigatorio' } };
    const limpo = String(pin ?? '').replace(/\D/g, '').slice(0, 6);
    const ok = await store.definirPin(sessao.loja, usuarioId, limpo ? hashPin(limpo) : null);
    if (!ok) return { status: 404, body: { erro: 'usuario_inexistente' } };
    const quem = await store.getUsuario(sessao.loja, sessao.sub) || {};
    await store.registrarAuditoria({ lojaId: sessao.loja, tipo: limpo ? 'pin_definido' : 'pin_removido',
      actor: { id: sessao.sub, name: quem.nome, role: sessao.role }, detalhe: `usuário ${usuarioId}` });
    return { status: 200, body: { ok: true, temPin: !!limpo } };
  });

  on('GET', '/sync/ids', async ({ sessao }) => {
    if (!sessao) return { status: 401, body: { erro: 'nao_autenticado' } };
    return { status: 200, body: { comandas: await store.idsDaLoja(sessao.loja) } };
  });

  on('GET', '/auditoria', async ({ sessao }) => {
    if (!sessao) return { status: 401, body: { erro: 'nao_autenticado' } };
    if (!can(sessao.role, 'auditoria.ver')) return { status: 403, body: { erro: 'sem_permissao' } };
    return { status: 200, body: { itens: await store.listarAuditoria(sessao.loja, 100) } };
  });

  /* ---------- servidor ---------- */

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const rota = rotas.find(r => r.metodo === req.method && r.caminho === url.pathname);
    if (!rota) {
      if (req.method === 'GET') {
        const caminho = url.pathname === '/' ? '/client/index.html' : url.pathname;
        if (/^\/(client|packages|assets)\//.test(caminho)) return servirEstatico(res, caminho);
      }
      return responder(res, 404, { erro: 'rota_inexistente' });
    }
    try {
      const body = req.method === 'POST' ? await lerCorpo(req) : null;
      const sessao = autenticar(req);
      const out = await rota.handler({ body, query: url.searchParams, sessao, req });
      responder(res, out.status ?? 200, out.body);
    } catch (err) {
      responder(res, err.status || 500, { erro: err.message || 'erro_interno' });
    }
  });

  if (hub) {
    anexarWebSocket(server, { hub, validarToken: t => verifySession(t, secret, now()) });
  }

  return { server, rotas, RAIZ, hub };
}

/** Sobe o servidor e devolve a porta + uma função de encerramento (usado nos testes). */
export function listen(app, port = 0) {
  return new Promise(resolve => {
    app.server.listen(port, '127.0.0.1', () => {
      const { port: p } = app.server.address();
      resolve({
        port: p,
        url: `http://127.0.0.1:${p}`,
        close: () => new Promise(r => {
          // Um socket WebSocket aberto impede o close() de concluir. O hub
          // derruba os seus e o closeAllConnections limpa o resto (keep-alive).
          app.hub?.fecharTodas?.();
          app.server.close(r);
          app.server.closeAllConnections?.();
        }),
      });
    });
  });
}

export { hashPin };
