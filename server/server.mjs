/**
 * Sobe a API + o cliente (PWA) + o canal de push.
 *
 *   node server/server.mjs                          → SQLite em ./dados/restaurante.db
 *   DB_FILE=:memory: node server/server.mjs         → SQLite volátil (demonstração)
 *   DATABASE_URL=postgres://... node server/server.mjs → Postgres (exige `npm install pg`)
 *
 * Na primeira execução cria a loja de demonstração com Ana (admin/4321),
 * Carla (gerente/2222) e Bruno (operador/1111).
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createStore } from './store.mjs';
import { abrirDriver } from './drivers.mjs';
import { semearDemo } from './seed.mjs';
import { createApp, listen } from './app.mjs';
import { criarHub } from './ws.mjs';

const { driver, descricao } = await abrirDriver();
if (descricao.startsWith('sqlite') && !descricao.includes(':memory:')) {
  mkdirSync(dirname(process.env.DB_FILE || './dados/restaurante.db'), { recursive: true });
}

const porta = Number(process.env.PORT || 8787);
const segredo = process.env.SESSION_SECRET;

if (!segredo) {
  if (process.env.NODE_ENV === 'production') {
    console.error('[erro] Defina SESSION_SECRET em produção. Sem ele, qualquer um forja um token.');
    process.exit(1);
  }
  console.warn('[aviso] SESSION_SECRET não definido — usando segredo de desenvolvimento. NÃO use assim em produção.');
}
if (descricao.startsWith('postgres') && !process.env.DATABASE_URL?.includes('sslmode')) {
  console.warn('[aviso] Postgres sem parâmetro de SSL na URL — confirme o TLS com o provedor.');
}

const store = await createStore(driver);

if (!(await store.getLoja('loja-1'))) {
  await semearDemo(store);
  console.log('[info] Loja de demonstração criada (loja-1).');
}

const hub = criarHub();
const app = createApp({ store, secret: segredo || 'segredo-de-desenvolvimento', hub });
const srv = await listen(app, porta);

console.log(`[ok] API no ar em ${srv.url}  (banco: ${descricao})`);
console.log('     push: WebSocket em /ws  (avisos de mudança por loja)');
console.log('     usuários: u-ana/4321 (admin) · u-carla/2222 (gerente) · u-bruno/1111 (operador)');

const encerrar = async () => { await srv.close(); await driver.fechar(); process.exit(0); };
process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);

await new Promise(() => {});
