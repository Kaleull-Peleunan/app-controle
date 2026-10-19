/**
 * WebSocket mínimo (RFC 6455) — sem dependências.
 *
 * Por que não usar `ws`: o produto não tem dependências e este uso é estreito.
 * O servidor só precisa EMPURRAR um aviso curto ("mudou, puxe") e responder a
 * ping/close. O cliente busca os dados por HTTP, onde já existe toda a
 * validação de sessão, permissão e idempotência.
 *
 * Limites assumidos (documentados, não escondidos):
 *   · somente frames de texto e de controle — sem binário;
 *   · sem fragmentação (continuation) e sem permessage-deflate;
 *   · o cliente só envia ping/pong/close, então o parser é pequeno.
 */

import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_TEXT = 0x1, OP_CLOSE = 0x8, OP_PING = 0x9, OP_PONG = 0xa;

/** Codifica um frame do servidor para o cliente (sem máscara, como manda a RFC). */
function frame(texto) {
  const dados = Buffer.from(texto, 'utf8');
  const n = dados.length;
  let cabecalho;
  if (n < 126) {
    cabecalho = Buffer.from([0x80 | OP_TEXT, n]);
  } else if (n < 65536) {
    cabecalho = Buffer.alloc(4);
    cabecalho[0] = 0x80 | OP_TEXT;
    cabecalho[1] = 126;
    cabecalho.writeUInt16BE(n, 2);
  } else {
    cabecalho = Buffer.alloc(10);
    cabecalho[0] = 0x80 | OP_TEXT;
    cabecalho[1] = 127;
    cabecalho.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([cabecalho, dados]);
}

function frameControle(op) {
  return Buffer.from([0x80 | op, 0]);
}

/**
 * Acumula bytes e devolve os frames completos.
 * Devolve { frames, resto } para o próximo pedaço que chegar.
 */
function lerFrames(buffer, aoTexto, aoControle) {
  let p = 0;
  while (p + 2 <= buffer.length) {
    const b1 = buffer[p];
    const b2 = buffer[p + 1];
    const op = b1 & 0x0f;
    const mascarado = (b2 & 0x80) === 0x80;
    let tam = b2 & 0x7f;
    let off = p + 2;

    if (tam === 126) {
      if (off + 2 > buffer.length) break;
      tam = buffer.readUInt16BE(off); off += 2;
    } else if (tam === 127) {
      if (off + 8 > buffer.length) break;
      tam = Number(buffer.readBigUInt64BE(off)); off += 8;
    }

    let mascara = null;
    if (mascarado) {
      if (off + 4 > buffer.length) break;
      mascara = buffer.subarray(off, off + 4); off += 4;
    }
    if (off + tam > buffer.length) break;                 // frame incompleto: espera mais

    let dados = buffer.subarray(off, off + tam);
    if (mascara) {
      const limpo = Buffer.allocUnsafe(tam);
      for (let i = 0; i < tam; i++) limpo[i] = dados[i] ^ mascara[i % 4];
      dados = limpo;
    }
    p = off + tam;

    if (op === OP_TEXT) aoTexto(dados.toString('utf8'));
    else aoControle(op, dados);
  }
  return buffer.subarray(p);
}

/**
 * Hub de assinaturas: quem está interessado em qual loja.
 * O aviso é só um sinal — o cliente puxa o que mudou por HTTP.
 */
export function criarHub({ validarToken } = {}) {
  const porLoja = new Map();     // lojaId -> Set<cliente>
  const todos = new Set();       // todos os sockets vivos (para o shutdown)

  function assinar(lojaId, cliente) {
    if (!porLoja.has(lojaId)) porLoja.set(lojaId, new Set());
    porLoja.get(lojaId).add(cliente);
    todos.add(cliente);
    return () => {
      todos.delete(cliente);
      const set = porLoja.get(lojaId);
      if (set) { set.delete(cliente); if (!set.size) porLoja.delete(lojaId); }
    };
  }

  /**
   * Encerra todos os sockets. Sem isso, um servidor HTTP com WebSocket aberto
   * nunca termina o `close()` — o processo de teste ficaria pendurado.
   */
  function fecharTodas() {
    for (const cliente of [...todos]) {
      try { cliente.fechar(); } catch { /* já morto */ }
    }
    todos.clear();
    porLoja.clear();
  }

  function publicar(lojaId, dados) {
    const set = porLoja.get(lojaId);
    if (!set || !set.size) return 0;
    const texto = JSON.stringify(dados);
    let n = 0;
    for (const cliente of set) {
      try { cliente.enviar(texto); n++; } catch { /* socket já morreu */ }
    }
    return n;
  }

  const estatisticas = () => ({
    lojas: porLoja.size,
    conexoes: [...porLoja.values()].reduce((s, set) => s + set.size, 0),
  });

  return { assinar, publicar, estatisticas, fecharTodas };
}

/**
 * Faz o upgrade da conexão HTTP para WebSocket e registra no hub.
 * O token vem na query string porque o navegador não permite cabeçalhos
 * em `new WebSocket(url)` — por isso o transporte tem de ser TLS (wss://).
 */
export function anexarWebSocket(servidor, { hub, validarToken }) {
  servidor.on('upgrade', (req, socket) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return socket.destroy(); }
    if (url.pathname !== '/ws') return socket.destroy();

    const chave = req.headers['sec-websocket-key'];
    if (!chave || (req.headers.upgrade || '').toLowerCase() !== 'websocket') return socket.destroy();

    const sessao = validarToken ? validarToken(url.searchParams.get('token')) : null;
    if (!sessao) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const aceite = createHash('sha1').update(chave + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${aceite}\r\n\r\n`,
    );
    socket.setNoDelay(true);

    const cliente = {
      loja: sessao.loja,
      usuario: sessao.sub,
      enviar(texto) { socket.write(frame(texto)); },
      fechar() { try { socket.write(frameControle(OP_CLOSE)); } catch {} socket.end(); },
    };

    const cancelar = hub.assinar(sessao.loja, cliente);
    cliente.enviar(JSON.stringify({ tipo: 'pronto', loja: sessao.loja }));

    let resto = Buffer.alloc(0);
    socket.on('data', pedaco => {
      resto = Buffer.concat([resto, pedaco]);
      resto = lerFrames(resto,
        () => {},
        (op) => {
          if (op === OP_PING) socket.write(Buffer.from([0x80 | OP_PONG, 0]));
          if (op === OP_CLOSE) { cancelar(); socket.end(); }
        });
    });
    const encerrar = () => { cancelar(); };
    socket.on('close', encerrar);
    socket.on('error', encerrar);
  });
}
