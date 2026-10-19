# Restaurante OS — migração para app real

Este repositório é a **fundação** do sistema, criada a partir do protótipo de arquivo único
(`comandas-mesas.html`), preservando o que funcionava e atacando os pontos críticos de
**dados, segurança e pagamento** — começando pela prioridade escolhida:
**multi-dispositivo e queda de internet**.

Sem dependências no caminho principal: roda com `node` puro (22.5+; testado no 24).
`node:sqlite`, `node:http`, `node:crypto` e `node:test` — **inclusive o WebSocket**, que é
implementado no próprio repositório (`server/ws.mjs`). `pg` é opcional e só entra quando
`DATABASE_URL` está definido.

```bash
node server/server.mjs          # API + cliente em http://127.0.0.1:8787
node --test                     # 41 testes contra SQLite em memória
BANCO=postgres node --test      # os MESMOS 41 testes contra Postgres
docker compose up --build       # banco + API em http://localhost:8787
```

Abra **http://127.0.0.1:8787** — é o cliente servido pelo próprio backend.

Usuários da loja de demonstração: `u-ana/4321` (admin), `u-carla/2222` (gerente),
`u-bruno/1111` (operador).

---

## O que já está de pé

```
packages/domain/     regras puras (dinheiro, quantidade, permissões) — a FONTE DA VERDADE
server/store.mjs     persistência transacional, idempotência, auditoria, cursor de sync
server/drivers.mjs   os dois bancos atrás de uma interface (SQLite e Postgres)
server/schema.mjs    o mesmo modelo nos dois dialetos
server/auth.mjs      PIN com scrypt, sessão assinada, bloqueio por tentativas, RBAC
server/app.mjs       API HTTP + serve o cliente + dispara o aviso de mudança
server/ws.mjs        WebSocket (RFC 6455) escrito à mão, sem dependência
client/sync-engine   motor offline-first: fila persistente, reenvio, push em tempo real
client/index.html    A MESMA interface do protótipo, agora ligada ao motor
client/app.js        a UI do protótipo com as escritas trocadas por engine.dispatch(...)
server/schema.pg.sql DDL de produção (PostgreSQL)
docker-compose.yml   banco + API para subir local
```

**41 testes passando**, nos dois bancos. Incluindo o que importa: dois aparelhos no mesmo
salão, um deles sem internet, convergindo sem perder lançamento e sem cobrar duas vezes —
e a mudança de um chegando no outro **em menos de 1 segundo**.

---

## As decisões que tornam isto um sistema, não uma tela

### 1. O cliente nunca decide dinheiro

O arquivo de domínio é **o mesmo** dos dois lados. O cliente aplica para dar resposta
imediata; o servidor reaplica para decidir. Preço e setor saem sempre do catálogo —
um teste envia `price: 0.01` e o item entra com R$ 22.

### 2. Toda ação é uma mutação idempotente

Cada ação vira `{ id, type, payload }`. O servidor guarda `mutation_id` numa tabela com
chave primária: reenviar o mesmo lote (rede caiu depois do envio) **não cobra duas vezes**.
É o que permite retry agressivo sem medo.

### 3. A fila vive no aparelho

O garçom continua lançando offline. As mutações ficam numa outbox persistente, sobem
**em ordem** quando a rede volta, e o cursor avança só no *pull* — regra que um teste
pegou de forma explícita: avançar o cursor pelo *push* pularia mudanças de outros
aparelhos que este ainda não tinha visto.

### 4. Recusa tem tratamento, não silêncio

Se o servidor recusa (mesa tomada por outro aparelho), o aparelho **descarta o efeito
otimista** — senão fica uma comanda fantasma que nunca existiu no banco. O teste cobre
exatamente esse caso.

### 5. Segurança deixou de ser cosmética

| No protótipo | Aqui |
|---|---|
| PIN em texto claro no `localStorage` | hash scrypt + salt por usuário |
| Sessão = um id no navegador | token assinado com validade |
| Sem limite de tentativas | bloqueio após 5 erros |
| Permissão checada na tela | checada no endpoint, com o papel vindo do token |
| Auditoria no mesmo JSON do app | tabela append-only, gravada pelo servidor |
| Quem agiu = o que o cliente disse | quem agiu = usuário do token |

---

## Push em tempo real (WebSocket)

O polling de 5 s foi **substituído** por um canal de aviso. O desenho é deliberadamente
simples, e a simplicidade é o ponto:

```
aparelho A lança → servidor grava → publica { tipo: 'mudou', cursor, por } na loja
                                            ↓
aparelho B recebe o aviso → chama GET /sync/pull → aplica o que mudou
```

**O socket não transporta dado — só o sinal.** Quem decide o que pode ser visto continua
sendo o `GET /sync/pull`, com a sessão validada, permissão e cursor. Se o aviso vazasse
para a loja errada, o pior que aconteceria é um pull inútil; se o *dado* vazasse, seria
um vazamento. O teste `o aviso é um sinal, não o dado` verifica exatamente isso: inspeciona
o que trafega no socket e exige que não haja comanda, item ou produto.

**O WebSocket é escrito à mão** (`server/ws.mjs`, ~180 linhas): handshake RFC 6455 com
`Sec-WebSocket-Accept`, frames de texto e de controle, máscara do cliente. Não é um
servidor WebSocket genérico e o arquivo diz isso em voz alta — sem binário, sem
fragmentação, sem `permessage-deflate`. Para um aviso de 40 bytes, é o suficiente, e
evita uma dependência no caminho crítico.

**Reconexão automática** com espera crescente (0,5 s → 15 s) e um pouco de aleatoriedade,
para cem aparelhos não baterem no servidor no mesmo instante. O canal volta sozinho depois
de queda de rede, troca de aba ou suspensão — há um teste que derruba o socket do aparelho
e exige que ele reconecte e volte a receber sem nenhuma intervenção.

**Vigia de 30 s** como rede de segurança: se o socket morrer em silêncio (proxy, rede
móvel, aba suspensa), o aparelho ainda sincroniza. Não é o mecanismo principal — é a
diferença entre "quase sempre instantâneo" e "sempre correto".

### O que a medição mostra

```
✔ dois aparelhos: a mudança chega no outro em menos de 1 segundo
      → o Bruno recebeu a comanda da mesa 3 em 13ms
      → a Ana recebeu o item do Bruno em 6ms
```

O teste mede o relógio **antes** do lançamento e espera o estado do outro aparelho
refletir a mudança — não é uma simulação: são dois motores de sincronização, dois
WebSockets e HTTP de verdade contra o servidor.

### Um bug que o polling escondia

Ao trocar o polling pelo push, um teste da UI começou a falhar: lançamentos feitos
*enquanto* um `sincronizar()` estava em voo ficavam presos na fila — o `sincronizar()`
seguinte recebia a promise do ciclo anterior e não empurrava nada. Com o polling de 5 s
o próximo ciclo resolvia sozinho; sem ele, o item podia não subir nunca. A correção foi
drenar a fila ao fim de cada ciclo (`agendarDrenagem`) quando ainda há item pendente.
Está no `client/sync-engine.mjs` e o comentário no código explica o porquê.

## Postgres

O **mesmo store** roda nos dois bancos. Existe uma só implementação das regras de
persistência; o que muda é o driver (`server/drivers.mjs`):

| | SQLite | Postgres |
|---|---|---|
| driver | `node:sqlite` (síncrono) | `pg` ou PGlite |
| `doc` | `text` com JSON | `jsonb` |
| placeholders | `?` | `?` traduzido para `$1, $2…` |
| transação | o próprio arquivo | **uma conexão dedicada** por transação |
| bloqueio de login | em memória | tabela `tentativas_login` |

O ponto que não é óbvio: **no Postgres a transação precisa da sua conexão**. Num pool,
duas consultas seguidas podem cair em conexões diferentes, e o `begin` de uma não valeria
para a outra. Por isso o driver expõe `transacao(fn)` e o store passa um `tx` explícito
para todas as funções que escrevem — a transação de uma mutação inteira vive numa conexão
só, e o `commit` fecha o que o `begin` abriu.

### Subir local

```bash
docker compose up --build
# API em http://localhost:8787, Postgres em localhost:5432
```

### Rodar a suíte contra Postgres

```bash
BANCO=postgres node --test                                  # PGlite (Postgres em WASM)
DATABASE_URL=postgres://... node --test                     # um Postgres de verdade
docker compose run --rm api sh -c 'BANCO=postgres node --test'
```

Os **41 testes passam nos dois**. Isso é o que dá sentido ao adaptador: se as regras só
passassem no SQLite, elas não estariam testadas — estariam testadas *no SQLite*.

Os testes não usam um banco falso: usam o mesmo driver de produção, contra um motor
Postgres de verdade. No modo `BANCO=postgres` é o **PGlite** (PostgreSQL compilado para
WASM, o mesmo motor, sem servidor para instalar); com `DATABASE_URL` é um servidor
Postgres comum, que é o que o `docker-compose` sobe.

### O schema de produção

`server/schema.pg.sql` é o DDL de produção e é o mesmo modelo que o `server/schema.mjs`
aplica. O app **não roda como superusuário** e a trilha de auditoria é append-only —
o endurecimento recomendado está comentado no fim do arquivo:

```sql
revoke update, delete on auditoria from app_user;
grant  insert, select on auditoria to app_user;
```

---

## A interface ligada ao motor

`client/index.html` é a **mesma UI** do protótipo (`comandas-mesas.html`), com a camada
de estado trocada. O render não foi tocado: ele continua lendo um objeto `state`, só que
esse objeto agora é um **espelho do motor**, atualizado a cada sincronização.

| Antes (protótipo) | Agora (cliente conectado) |
|---|---|
| `state.comandas.push(nc)` | `engine.abrirComanda({ table })` |
| `c.items[idx].qty += 1` | `engine.definirQtd({ iid, qty })` |
| `c.payments.push({...})` | `engine.pagar({ amount, method, card })` |
| `c.discount = {...}` | `engine.aplicarDesconto({ ... })` |
| `state.notices.unshift(n)` | `engine.enviarAviso({ ... })` |
| `state.waiters.push(u)` / `pin` no objeto | `engine.salvarUsuario(...)` + `POST /usuarios/pin` |
| `save()` (localStorage) | o motor persiste e sincroniza |
| `function subtotal(c){}` local | `DOMINIO.subtotal(c)` — **o mesmo arquivo que o servidor roda** |
| `assignSeq()` no aparelho | numeração atribuída pelo servidor |
| `auditLog()` escrevendo a própria trilha | trilha gravada pelo servidor, a partir do token |

O que continua **local, de propósito**: som e vibração do alerta e a maquininha
conectada — são preferências **deste** aparelho, não da loja. Mesas, desconto, setores,
catálogo, equipe e configuração vivem no servidor e chegam pelo motor.

**PIN nunca passa pelo sync.** Ele vai por `POST /usuarios/pin`, é hasheado no servidor e
não entra no log de sincronização — senão o segredo viajaria para todos os aparelhos.

## Contrato de sincronização

```
POST /auth/login   { lojaId, usuarioId, pin }        → { token, usuario }
GET  /bootstrap                                       → estado completo + cursor
POST /sync/push    { deviceId, mutations: [...] }     → resultado por mutação
GET  /sync/pull    ?since=<cursor>                    → só o que mudou
GET  /sync/ids                                        → ids existentes (reconciliação)
GET  /ws/estatisticas                                 → conexões abertas por loja
GET  /auditoria                                       → trilha (admin/gerente)
GET  /auth/usuarios?loja=                             → quem pode entrar (sem PIN)
POST /usuarios/pin { usuarioId, pin }                 → define PIN (hasheado aqui)
GET  /                                                → serve o cliente (PWA)
GET  /ws?token=<sessão>                               → upgrade para WebSocket (avisos)
```

Cada mutação devolve `{ ok, idempotent?, error?, summary, cursor }`. `error` de domínio
(`table_busy`, `has_balance`, `discount_needs_auth`) é recusa de negócio, não falha de rede —
o cliente reconcilia e o servidor registra a tentativa na auditoria.

O token vai na query string do WebSocket porque o navegador **não permite** cabeçalhos em
`new WebSocket(url)`. Isso torna o TLS obrigatório em produção (`wss://`), e é por isso
que o servidor avisa quando sobe sem `SESSION_SECRET`.

---

## Do protótipo para cá

| Protótipo | Aqui |
|---|---|
| `localStorage` (1 aparelho) | SQLite/Postgres + API + sync offline-first |
| `state.comandas[]` | tabela `comandas` com `doc` jsonb + colunas derivadas para consulta |
| `sentQty` / `dispatchedQty` nas linhas | preservados: fila da cozinha e envio impresso continuam separados |
| `audit[]` (200 itens, no app) | tabela `auditoria` append-only, com `mutation_id` e `device_id` |
| Permissões na tela | RBAC no servidor (`can(role, acao)`) |
| `settings.discountLimit` | coluna na `lojas`, aplicada no domínio com autorização registrada |
| Polling de 5 s | WebSocket com aviso + reconexão automática |

As regras de valor foram portadas com paridade: taxa sobre o valor **com desconto**,
desconto limitado ao subtotal, rateio por item carregando desconto e taxa
proporcionalmente, junção de mesas somando desconto e o que já saiu, e comanda
`merged` **fora da receita** para não contar a venda duas vezes.

---

## O que ainda NÃO está pronto (honestamente)

1. **O protótipo standalone continua existindo** (`comandas-mesas.html`) e **não** foi
   reescrito: ele segue sendo a versão de um aparelho só, com `localStorage`. O cliente
   conectado é o `client/`. Os dados antigos do protótipo **não migram sozinhos** para o
   servidor — seria preciso um importador.
2. **Pagamento real continua não existindo.** O bridge do POS já tem contrato
   (`POST /charge`, `window.POSBridge`), mas sem contrato com adquirente/PSP não há
   transação. Pix é o começo mais barato; cartão exige TEF ou SDK do SmartPOS.
3. **Fiscal (NFC-e) não começou** — depende de certificado A1, contador e provedor.
4. **Bloqueio por tentativas** já é compartilhado no Postgres (`tentativas_login`), mas
   **ainda é em memória no SQLite** — o modo SQLite serve um processo só.
5. **Impressão** continua pelo diálogo do navegador; impressora térmica de rede exige
   um agente local ESC/POS.
6. **Sem TTL de token nem refresh**: hoje o token dura 12 h e não há renovação.
7. **Sem escala horizontal**: o aviso do WebSocket é publicado na memória do processo.
   Duas instâncias da API precisariam de um barramento (Redis pub/sub, `LISTEN/NOTIFY`
   do Postgres). Com uma instância, funciona.
8. **O WebSocket é mínimo**: sem binário, sem fragmentação, sem compressão. Se algum dia
   o socket transportar dado, trocar por `ws` passa a fazer sentido.

---

## Próximos passos, na ordem

1. Fechamento de caixa por turno (sangria, suprimento, conferência por forma de pagamento).
2. `LISTEN/NOTIFY` do Postgres para o aviso valer entre instâncias da API.
3. Pix com webhook idempotente; depois cartão via TEF/SmartPOS.
4. Fiscal via provedor homologado.
5. Refresh de token + expiração por inatividade.
