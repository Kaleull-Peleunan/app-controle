/**
 * Autenticação e autorização NO SERVIDOR.
 *
 * Diferença crítica em relação ao protótipo: lá o perfil era checado no
 * navegador e o PIN ficava em texto claro no localStorage. Aqui:
 *   · PIN vira hash (scrypt + salt por usuário) — nunca é armazenado legível;
 *   · sessão é um token assinado com validade, não um id solto;
 *   · tentativas erradas bloqueiam temporariamente (6 dígitos sem lockout é
 *     força bruta trivial);
 *   · cada endpoint decide pelo papel do USUÁRIO DO TOKEN, não pelo que o
 *     cliente diz ser.
 */

import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const MAX_TENTATIVAS = 5;
const BLOQUEIO_MS = 5 * 60 * 1000;

/* ---------- PIN ---------- */

export function hashPin(pin) {
  const salt = randomBytes(16).toString('base64url');
  const key = scryptSync(String(pin), salt, SCRYPT.keylen, SCRYPT).toString('base64url');
  return `scrypt$${salt}$${key}`;
}

export function verifyPin(pin, stored) {
  if (!stored) return false;
  const [algo, salt, key] = String(stored).split('$');
  if (algo !== 'scrypt' || !salt || !key) return false;
  const esperado = Buffer.from(key, 'base64url');
  const obtido = scryptSync(String(pin), salt, esperado.length, SCRYPT);
  return esperado.length === obtido.length && timingSafeEqual(esperado, obtido);
}

/* ---------- Sessão (token assinado, sem dependência externa) ---------- */

export function createSession({ userId, lojaId, role, secret, ttlMs = 12 * 60 * 60 * 1000, now = Date.now() }) {
  const payload = { sub: userId, loja: lojaId, role, exp: now + ttlMs, iat: now };
  const corpo = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const assinatura = createHmac('sha256', secret).update(corpo).digest('base64url');
  return `${corpo}.${assinatura}`;
}

export function verifySession(token, secret, now = Date.now()) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [corpo, assinatura] = token.split('.');
  const esperada = createHmac('sha256', secret).update(corpo).digest('base64url');
  const a = Buffer.from(assinatura);
  const b = Buffer.from(esperada);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < now) return null;
    return payload;
  } catch {
    return null;
  }
}

/* ---------- Bloqueio por tentativas ---------- */
/* Em produção isto precisa ser compartilhado (Redis/Postgres) para valer
   entre instâncias; aqui fica em memória para manter a referência simples. */

export function createLoginGuard() {
  const tentativas = new Map();
  const chave = (lojaId, userId) => `${lojaId}:${userId}`;

  function bloqueado(lojaId, userId, now = Date.now()) {
    const t = tentativas.get(chave(lojaId, userId));
    if (!t) return 0;
    if (t.bloqueadoAte && t.bloqueadoAte > now) return Math.ceil((t.bloqueadoAte - now) / 1000);
    return 0;
  }

  function falhou(lojaId, userId, now = Date.now()) {
    const k = chave(lojaId, userId);
    const t = tentativas.get(k) || { n: 0, bloqueadoAte: 0 };
    t.n += 1;
    if (t.n >= MAX_TENTATIVAS) { t.bloqueadoAte = now + BLOQUEIO_MS; t.n = 0; }
    tentativas.set(k, t);
    return bloqueado(lojaId, userId, now);
  }

  function acertou(lojaId, userId) { tentativas.delete(chave(lojaId, userId)); }

  return { bloqueado, falhou, acertou, MAX_TENTATIVAS };
}

/* ---------- Papéis ---------- */

export const PERMISSOES = {
  admin: new Set(['comanda.*', 'produto.*', 'equipe.*', 'caixa.*', 'auditoria.ver', 'config.*', 'desconto.ilimitado', 'terminal.*', 'backup.*']),
  gerente: new Set(['comanda.*', 'produto.*', 'caixa.*', 'auditoria.ver', 'config.geral', 'desconto.limitado']),
  operador: new Set(['comanda.abrir', 'comanda.fechar', 'item.*', 'pagamento.*', 'desconto.limitado', 'producao.*']),
};

/** Checagem no servidor: nenhuma tela decide permissão sozinha. */
export function can(role, acao) {
  const set = PERMISSOES[role];
  if (!set) return false;
  if (set.has(acao)) return true;
  const [grupo] = acao.split('.');
  return set.has(`${grupo}.*`);
}
