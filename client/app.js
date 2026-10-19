/**
 * Cliente conectado (PWA) do Restaurante OS.
 *
 * A UI é a mesma do protótipo; o que mudou é de onde vem o estado e por onde
 * ele sai:
 *
 *   ANTES                          AGORA
 *   state.comandas[i].items.push() engine.dispatch('item.add', ...)   → servidor decide
 *   save()  (localStorage)         alimentado pelo motor de sincronização
 *   função local subtotal()        DOMINIO.subtotal()  (MESMO arquivo do servidor)
 *
 * O render não foi tocado: ele continua lendo um objeto `state`, só que esse
 * objeto agora é um ESPELHO do motor, atualizado a cada sincronização.
 */
(function(){
  "use strict";

  const DOMINIO = window.DOMINIO;
  const { createSyncEngine, clienteHttp } = window.SYNC;

  // Mesmo arquivo que roda no servidor: uma única definição de dinheiro.
  const { subtotal, discountAmount, feeAmount, totalOf, remainingOf, discFactor,
          sentQtyOf, dispatchedQtyOf, pendingQty, toDispatchQty, dispatchableQty,
          methodLabel } = DOMINIO;

  /* ============================================================
     PREFERÊNCIAS DESTE APARELHO
     ------------------------------------------------------------
     O que é deste aparelho (som, vibração, maquininha conectada) fica local.
     O que é da loja (mesas, desconto, setores, catálogo, equipe) vive no
     servidor e chega pelo motor de sincronização.
     ============================================================ */
  const KEY = "creao_ui_v1";
  const store = (function(){
    try{
      localStorage.setItem("__probe__","1");
      localStorage.removeItem("__probe__");
      return localStorage;
    }catch(e){
      const mem = {};
      return { getItem:k=>Object.prototype.hasOwnProperty.call(mem,k)?mem[k]:null,
               setItem:(k,v)=>{mem[k]=v;}, removeItem:k=>{delete mem[k];} };
    }
  })();

  const DEFAULT_PRODUCTS = [
    {name:"Água mineral", price:5, category:"Bebidas"},
    {name:"Água com gás", price:6, category:"Bebidas"},
    {name:"Refrigerante lata", price:7, category:"Bebidas"},
    {name:"Suco natural", price:12, category:"Bebidas"},
    {name:"Cerveja long neck", price:12, category:"Cervejas"},
    {name:"Cerveja 600ml", price:22, category:"Cervejas"},
    {name:"Chopp 300ml", price:10, category:"Cervejas"},
    {name:"Caipirinha", price:22, category:"Drinks"},
    {name:"Caipiroska", price:24, category:"Drinks"},
    {name:"Gin tônica", price:28, category:"Drinks"},
    {name:"Cuba libre", price:24, category:"Drinks"},
    {name:"Batata frita", price:28, category:"Petiscos"},
    {name:"Calabresa acebolada", price:32, category:"Petiscos"},
    {name:"Frango a passarinho", price:42, category:"Petiscos"},
    {name:"Isca de tilápia", price:48, category:"Petiscos"},
    {name:"Amendoim", price:12, category:"Petiscos"},
    {name:"Filé à parmegiana", price:62, category:"Pratos"},
    {name:"Picanha na chapa", price:89, category:"Pratos"},
    {name:"Feijoada", price:55, category:"Pratos"},
    {name:"Hambúrguer artesanal", price:38, category:"Pratos"},
    {name:"Pudim", price:14, category:"Sobremesas"},
    {name:"Petit gâteau", price:22, category:"Sobremesas"},
    {name:"Sorvete", price:12, category:"Sobremesas"}
  ];

  let uidCounter = 0;
  function uid(){ uidCounter++; return Date.now().toString(36)+"-"+uidCounter.toString(36)+"-"+Math.random().toString(36).slice(2,7); }

  function defaultState(){
    const t = { id:uid(), label:"Maquininha 1", model:"stone", mode:"sim", endpoint:"http://127.0.0.1:8787", active:true };
    return {
      settings: { name:"Meu Restaurante", tables:12, allowDiscount:true, requireWaiter:true,
                  defaultTerminalId:t.id, alertSound:true, alertVibrate:true,
                  serviceFeePct:10, serviceFeeDefault:false, discountLimit:10,
                  sectors:["Cozinha","Bar"],
                  perm:{ products:false, toggleProducts:false, settings:false } },
      products: DEFAULT_PRODUCTS.map(p=>({ id:uid(), name:p.name, price:p.price, category:p.category })),
      waiters: [],
      currentWaiterId: null,
      terminals: [t],
      notices: [],
      audit: [],
      comandas: [],
      seq: 1
    };
  }

  let state = defaultState();
  let engine = null;
  let usuarioAtual = null;

  /** Espelha o motor no objeto que o render já conhece. */
  function sincronizarEstado(){
    if(!engine) return;
    const e = engine.estado;
    state.comandas = e.comandas || [];
    state.products = e.produtos || [];
    state.waiters = (e.usuarios || []).map(u => ({ id:u.id, name:u.name, role:u.role, active:u.active, pin:u.temPin ? "****" : "" }));
    state.notices = e.avisos || [];
    state.seq = Math.max(0, ...(e.comandas || []).map(c => Number(c.seq) || 0), state.seq || 0);
    state.currentWaiterId = e.usuario ? e.usuario.id : null;
    usuarioAtual = e.usuario || null;
    const cfg = e.config || {};
    state.settings = Object.assign({}, state.settings, {
      name: cfg.nome ?? state.settings.name,
      tables: cfg.tables ?? state.settings.tables,
      allowDiscount: cfg.allowDiscount !== false,
      requireWaiter: cfg.requireWaiter !== false,
      sectors: cfg.sectors || state.settings.sectors,
      serviceFeePct: cfg.serviceFeePct ?? state.settings.serviceFeePct,
      serviceFeeDefault: cfg.serviceFeeDefault === true,
      discountLimit: cfg.discountLimit ?? state.settings.discountLimit,
      perm: cfg.perm || state.settings.perm,
    });
  }

  /** Preferências deste aparelho (o resto vive no servidor). */
  function save(){
    try{ store.setItem(KEY, JSON.stringify({ settings: state.settings, terminals: state.terminals })); }catch(e){}
  }

  /**
   * Ponto único de escrita. TODA alteração de estado passa por aqui: aplica
   * local (resposta imediata) e enfileira para o servidor decidir.
   */
  function despachar(metodo, arg){
    if(!engine) return { ok:false, error:"sem_sessao" };
    const r = engine[metodo](arg);
    if(r && r.ok === false && r.error){
      toast(mensagemDeErro(r));
      return r;
    }
    sincronizarEstado();
    renderAll();
    return r;
  }

  const MENSAGENS = {
    table_busy: "Essa mesa já está ocupada.",
    comanda_closed: "A comanda já foi encerrada em outro aparelho.",
    comanda_not_found: "A comanda não existe mais.",
    product_not_found: "Produto não encontrado no catálogo.",
    product_inactive: "Esse produto está inativo.",
    has_balance: "Ainda há saldo a receber.",
    nothing_to_pay: "A conta já está quitada.",
    discount_needs_auth: "Desconto acima do limite precisa de autorização.",
    ultimo_admin: "É preciso manter ao menos um administrador ativo.",
    nome_obrigatorio: "Informe o nome.",
    sem_permissao: "Seu perfil não permite essa ação.",
  };
  function mensagemDeErro(r){ return MENSAGENS[r.error] || r.message || "Ação recusada."; }

  /* ============================================================
     UTILITÁRIOS
     ============================================================ */
  const $ = (sel,root)=> (root||document).querySelector(sel);
  const $$ = (sel,root)=> Array.prototype.slice.call((root||document).querySelectorAll(sel));

  const BRL = new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"});
  const money = n => BRL.format(isFinite(n)?n:0);

  function esc(s){
    return String(s==null?"":s)
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
      .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
  }
  function dt(iso){
    const d = new Date(iso);
    return d.toLocaleString("pt-BR",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});
  }
  function hm(iso){
    return new Date(iso).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"});
  }
  function startOfDay(d){ const x=new Date(d); x.setHours(0,0,0,0); return x; }
  function elapsed(iso){
    const ms = Date.now() - new Date(iso).getTime();
    const min = Math.max(0, Math.floor(ms/60000));
    if(min < 60) return min + " min";
    const h = Math.floor(min/60), m = min%60;
    return h + "h" + (m?(" "+m+"min"):"");
  }
  let toastTimer = null;
  function toast(msg){
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(()=>t.classList.remove("show"), 2200);
  }

  /* ============================================================
     CÁLCULOS
     ============================================================ */
  // Taxa de serviço: incide sobre o valor já com desconto aplicado
  function feePct(c){ return (c.fee && c.fee.on) ? (Number(c.fee.pct) || 0) : 0; }

  /* ---------- LIMITE DE DESCONTO POR PERFIL ---------- */
  function discountLimitPct(){
    const n = Number(state.settings.discountLimit);
    return (isFinite(n) && n >= 0) ? Math.min(100, n) : 10;
  }
  function discountPctOf(type, value, st){
    if(type === "percent") return Math.max(0, Number(value) || 0);
    return st > 0 ? Math.max(0, (Number(value) || 0) / st * 100) : 0;
  }
  // Só o administrador aplica desconto acima do limite por conta própria
  function discountNeedsAuth(type, value, st){
    if(isAdmin()) return false;
    return discountPctOf(type, value, st) > discountLimitPct() + 0.0001;
  }

  /* ---------- PAGAMENTOS PARCIAIS ---------- */
  function paymentsOf(c){ return Array.isArray(c.payments) ? c.payments : []; }
  function paidTotalLegacy(c){
    if(typeof c.paidTotal === "number") return c.paidTotal;
    return c.payment ? (c.total || 0) : 0;
  }
  function paidTotal(c){
    const sum = paymentsOf(c).reduce((s,p)=> s + (Number(p.amount)||0), 0);
    return Math.round(Math.max(sum, c.status === "closed" ? paidTotalLegacy(c) : 0)*100)/100;
  }
  // Fator de desconto: mantém o rateio proporcional ao aplicar desconto na conta toda
  // Cada LINHA da comanda tem id próprio (iid): permite o mesmo produto em linhas
  // de autores diferentes sem que a quantidade de uma afete a outra.
  function itemKey(it){ return it.iid || it.pid; }
  function paidQtyOf(c, key){
    return paymentsOf(c).reduce(function(s,p){
      return s + (p.items || []).reduce(function(t,it){
        return t + ((it.iid || it.pid) === key ? it.qty : 0);
      }, 0);
    }, 0);
  }
  function authorShort(it){
    if(!it.addedBy || !it.addedBy.name) return "";
    return String(it.addedBy.name).trim().split(/\s+/)[0];
  }
  /* ---------- PRODUÇÃO (COZINHA / BAR) ---------- */
  const SECTOR_BAR_HINTS = ["bebida","cerveja","drink","vinho","cocktail","destilado","suco","refrigerante","agua","chopp"];
  function sectorByCategory(cat){
    const c = foldText(cat || "");
    for(let i=0; i<SECTOR_BAR_HINTS.length; i++){ if(c.indexOf(SECTOR_BAR_HINTS[i]) >= 0) return "Bar"; }
    return "Cozinha";
  }
  function sectorsList(){
    const base = (Array.isArray(state.settings.sectors) && state.settings.sectors.length)
      ? state.settings.sectors.slice() : ["Cozinha", "Bar"];
    (state.products || []).forEach(function(p){ if(p.sector && base.indexOf(p.sector) < 0) base.push(p.sector); });
    return base;
  }
  function productSector(p){ return p && p.sector ? p.sector : sectorByCategory(p && p.category); }
  // Itens antigos não guardam o setor: resolve pelo produto (ou pelo nome)
  function sectorOfItem(it){
    if(it.sector) return it.sector;
    const p = (state.products || []).find(function(x){ return x.id === it.pid; });
    return p ? productSector(p) : sectorByCategory(it.name);
  }
  // toDispatchQty / dispatchableQty vêm do domínio compartilhado.
  function pendingItems(c){
    return (c.items || []).filter(function(it){ return pendingQty(it) > 0; });
  }

  /* ---------- PAINEL DE PRODUÇÃO (KDS) ---------- */
  const PROD_WARN_MIN = 10;   // atenção
  const PROD_LATE_MIN = 20;   // atrasado
  function minutosDesde(iso){
    const ms = Date.now() - new Date(iso).getTime();
    return isFinite(ms) ? Math.floor(Math.max(0, ms) / 60000) : 0;
  }
  // Fila: tudo que ainda NÃO foi enviado, em todas as comandas abertas
  function productionQueue(){
    const out = [];
    (state.comandas || []).filter(function(c){ return c.status === "open"; }).forEach(function(c){
      (c.items || []).forEach(function(it){
        const aDespachar = toDispatchQty(it);
        if(aDespachar > 0){
          const pend = aDespachar;
          out.push({
            comanda: c, item: it, qty: pend, sector: sectorOfItem(it),
            since: it.addedAt || c.openedAt, author: authorShort(it),
            dispatchable: dispatchableQty(it),
            pendingSend: pendingQty(it) > 0,
            table: c.table, seq: c.seq, key: itemKey(it)
          });
        }
      });
    });
    return out;
  }
  function maisAntigoDe(grupo){
    return grupo.reduce(function(min, x){
      const t = new Date(x.since).getTime();
      return (min === null || t < min) ? t : min;
    }, null);
  }
  let prodFilter = "";
  function ordenaSetores(a, b){
    const ordem = sectorsList();
    const ia = ordem.indexOf(a), ib = ordem.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  }

  function renderProduction(){
    const fila = productionQueue();
    const total = fila.reduce(function(s,x){ return s + x.qty; }, 0);
    const mesas = Array.from(new Set(fila.map(function(x){ return x.comanda.id; }))).length;
    $("#prodTotal").textContent = total;
    $("#prodTables").textContent = mesas;
    $("#prodOldest").textContent = fila.length ? elapsed(new Date(maisAntigoDe(fila)).toISOString()) : "—";

    const setoresComFila = sectorsList().filter(function(s){
      return fila.some(function(x){ return x.sector === s; });
    });
    $("#prodSectorChips").innerHTML = ['<button class="chip'+(!prodFilter?" active":"")+'" data-pset="">Todos ('+total+')</button>']
      .concat(setoresComFila.map(function(s){
        const n = fila.filter(function(x){ return x.sector === s; }).reduce(function(a,x){ return a + x.qty; }, 0);
        return '<button class="chip'+(prodFilter===s?" active":"")+'" data-pset="'+esc(s)+'">'+esc(s)+' ('+n+')</button>';
      })).join("");
    $$("#prodSectorChips [data-pset]").forEach(function(b){
      b.addEventListener("click", function(){ prodFilter = b.dataset.pset; renderProduction(); });
    });

    const visiveis = prodFilter ? fila.filter(function(x){ return x.sector === prodFilter; }) : fila;
    if(!visiveis.length){
      $("#prodPanel").innerHTML = '<div class="empty card"><div class="big">✅</div>'+
        '<h3>Nada pendente</h3><p>'+(fila.length ? "Nenhuma pendência neste setor." : "Tudo que foi lançado já saiu para a produção.")+'</p></div>';
      $("#btnPrintPanel").disabled = true;
      return;
    }
    $("#btnPrintPanel").disabled = false;

    const porSetor = {};
    visiveis.forEach(function(x){ (porSetor[x.sector] = porSetor[x.sector] || []).push(x); });

    $("#prodPanel").innerHTML = Object.keys(porSetor).sort(ordenaSetores).map(function(setor){
      const itens = porSetor[setor];
      const porComanda = {};
      itens.forEach(function(x){ (porComanda[x.comanda.id] = porComanda[x.comanda.id] || []).push(x); });
      // a mesa mais atrasada aparece primeiro
      const grupos = Object.keys(porComanda).map(function(k){ return porComanda[k]; })
        .sort(function(a,b){ return maisAntigoDe(a) - maisAntigoDe(b); });
      const unidades = itens.reduce(function(s,x){ return s + x.qty; }, 0);
      return '<div class="prod-sector"><h3>'+esc(setor)+'<span>'+unidades+
          (unidades === 1 ? " item" : " itens")+'</span></h3>'+
        grupos.map(function(g){
          const c = g[0].comanda;
          const maisAntigo = maisAntigoDe(g);
          const mins = minutosDesde(new Date(maisAntigo).toISOString());
          return '<div class="prod-ticket">'+
            '<div class="pt-head" data-goto="'+c.table+'" title="Abrir a comanda desta mesa">'+
              '<b>Mesa '+c.table+'</b>'+
              '<span class="pt-meta">#'+(c.seq || "—")+' · '+esc(c.waiterName || "—")+'</span>'+
              '<span class="pt-ago'+(mins >= PROD_LATE_MIN ? " late" : "")+'">'+elapsed(new Date(maisAntigo).toISOString())+'</span>'+
            '</div>'+
            g.sort(function(a,b){ return new Date(a.since) - new Date(b.since); }).map(function(x){
              const m = minutosDesde(x.since);
              const cls = m >= PROD_LATE_MIN ? " late" : (m >= PROD_WARN_MIN ? " warn" : "");
              const disp = x.dispatchable;
              const pode = disp > 0;
              const mostra = pode ? disp : x.qty;
              const espera = pode
                ? (x.qty > disp ? '<span class="pt-state">+'+(x.qty - disp)+' aguardando envio</span>' : '')
                : '<span class="pt-state">aguardando envio</span>';
              return '<div class="pt-item'+cls+'"><b>'+mostra+'x</b> '+esc(x.item.name)+
                (x.author ? ' <span class="who">'+esc(x.author)+'</span>' : '')+ espera +
                '<span class="pt-time">'+elapsed(x.since)+'</span>'+
                '<button class="pt-dispatch'+(pode ? "" : " off")+'" data-desp="'+esc(x.key)+
                  '" data-cmd="'+esc(c.id)+'"'+(pode ? "" : " disabled")+
                  ' title="'+(pode ? "Marcar como despachado pela cozinha" : "Aguarde o garçom enviar à produção")+'">✓ Despachar'+
                  (disp > 1 ? " "+disp+"x" : "")+'</button>'+
              '</div>';
            }).join("")+
          '</div>';
        }).join("")+'</div>';
    }).join("");

    $$("#prodPanel [data-goto]").forEach(function(el){
      el.addEventListener("click", function(){ goToTable(Number(el.dataset.goto)); });
    });
    $$("#prodPanel [data-desp]").forEach(function(b){
      b.addEventListener("click", function(){ despacharItem(b.dataset.cmd, b.dataset.desp); });
    });
    renderProdUndo();
  }

  /* ---------- Despacho pela cozinha (separado do envio impresso) ---------- */
  let despachosRecentes = [];   // só na sessão: permite desfazer um toque errado

  function despacharItem(comandaId, iid){
    const c = comandaById(comandaId); if(!c) return;
    const it = (c.items || []).find(function(x){ return itemKey(x) === iid; });
    if(!it) return;
    const q = dispatchableQty(it);
    if(q <= 0){
      toast(pendingQty(it) > 0
        ? "Este item ainda não foi enviado à produção — imprima o pedido antes de despachar."
        : "Não há nada a despachar neste item.");
      return;
    }
    // despacho é mutação: o servidor confere que o item já foi enviado e registra quem despachou
    despachar("despachar", { comandaId: c.id, iid: iid, qty: q });
    despachosRecentes.unshift({ comandaId: c.id, iid: iid, qty: q, name: it.name, table: c.table });
    if(despachosRecentes.length > 3) despachosRecentes.length = 3;
    renderProduction(); renderTop();
    if(activeId) renderComanda();
    toast(q + "x " + it.name + " despachado.");
  }

  function renderProdUndo(){
    const box = $("#prodUndo");
    if(!box) return;
    if(!despachosRecentes.length){ box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    box.innerHTML = "✅ Despachado agora:" + despachosRecentes.map(function(d, i){
      return '<button class="undo-desp" data-undo-desp="'+i+'">↩ '+d.qty+'x '+esc(d.name)+' · Mesa '+d.table+'</button>';
    }).join("");
    $$("#prodUndo [data-undo-desp]").forEach(function(b){
      b.addEventListener("click", function(){ desfazerDespacho(Number(b.dataset.undoDesp)); });
    });
  }

  function desfazerDespacho(i){
    const d = despachosRecentes[i];
    if(!d) return;
    const c = comandaById(d.comandaId);
    if(c){
      const it = (c.items || []).find(function(x){ return itemKey(x) === d.iid; });
      if(it){
        // desfazer também é mutação: fica registrado e vale nos outros aparelhos
        despachar("despachar", { comandaId: c.id, iid: d.iid, qty: -d.qty });
      }
    }
    despachosRecentes.splice(i, 1);
    renderProduction(); renderTop();
    if(activeId) renderComanda();
    toast("Despacho desfeito — o item voltou para a fila.");
  }

  function imprimirPainel(){
    const fila = productionQueue();
    if(!fila.length){ toast("Nada pendente para imprimir."); return; }
    const porSetor = {};
    fila.forEach(function(x){ (porSetor[x.sector] = porSetor[x.sector] || []).push(x); });
    const area = $("#printArea");
    area.innerHTML = Object.keys(porSetor).sort(ordenaSetores).map(function(setor){
      const itens = porSetor[setor];
      const porMesa = {};
      itens.forEach(function(x){ (porMesa[x.table] = porMesa[x.table] || []).push(x); });
      return '<div class="ticket">'+
        '<div class="tk-setor">'+esc(String(setor).toUpperCase())+'</div>'+
        '<div class="tk-head">Pendências de produção<br>'+hm(new Date().toISOString())+'</div>'+
        '<div class="tk-itens">'+Object.keys(porMesa).sort(function(a,b){ return a - b; }).map(function(t){
          const g = porMesa[t];
          return '<div class="tk-mesa">Mesa '+t+' · comanda #'+(g[0].seq || "—")+'</div>'+
            g.map(function(x){ return '<div class="tk-it"><b>'+x.qty+'x</b> '+esc(x.item.name)+'</div>'; }).join("");
        }).join("")+'</div>'+
        '<div class="tk-foot">'+itens.reduce(function(s,x){ return s + x.qty; }, 0)+' itens pendentes · '+esc(setor)+'</div>'+
      '</div>';
    }).join("");
    window.print();
    setTimeout(function(){ area.innerHTML = ""; }, 800);
  }
  $("#btnPrintPanel").addEventListener("click", imprimirPainel);

  function itemAuthors(c){
    const nomes = {};
    (c.items || []).forEach(function(i){ if(i.addedBy && i.addedBy.name) nomes[i.addedBy.id || i.addedBy.name] = true; });
    return Object.keys(nomes).length;
  }
  function isPersonPaid(c, i, n){
    return paymentsOf(c).some(p=> p.mode === "pessoa" && p.of === n && p.person === i);
  }
  function personGroupPaid(c, n){
    return paymentsOf(c).filter(p=> p.mode === "pessoa" && p.of === n).reduce((s,p)=> s + p.amount, 0);
  }
  function methodLabelOf(c){
    const pays = paymentsOf(c);
    if(pays.length){
      const ms = Array.from(new Set(pays.map(p=> p.method)));
      if(ms.length > 1) return "Múltiplo · " + pays.length + " pagamentos";
      return ms[0] + (pays.length > 1 ? " · " + pays.length + " pagamentos" : "");
    }
    return (c.payment && c.payment.method) || "—";
  }
  function openByTable(t){ return state.comandas.find(c=>c.status==="open" && c.table===t); }
  function comandaById(id){ return state.comandas.find(c=>c.id===id); }

  /* ---------- GARÇONS ---------- */
  function waiterById(id){ return state.waiters.find(w=>w.id===id) || null; }
  /**
   * Quem está no comando deste aparelho é o usuário da SESSÃO (validada pelo
   * token). Antes bastava escrever `state.currentWaiterId` no armazenamento
   * local — ou seja, o perfil era uma sugestão do cliente.
   */
  function currentWaiter(){
    if(!engine || !engine.estado.usuario) return null;
    const u = engine.estado.usuario;
    return { id:u.id, name:u.nome, role:u.role, active:true };
  }
  function activeWaiters(){
    return state.waiters.filter(w=>w.active !== false).sort((a,b)=> a.name.localeCompare(b.name));
  }
  function waiterLabelOf(id, fallback){
    const w = waiterById(id);
    return w ? w.name : (fallback || "Sem garçom");
  }
  function initials(name){
    const parts = String(name||"").trim().split(/\s+/).filter(Boolean);
    if(!parts.length) return "?";
    return (parts[0][0] + (parts.length>1 ? parts[parts.length-1][0] : "")).toUpperCase();
  }
  function requiresWaiter(){ return state.settings.requireWaiter !== false; }

  /* ---------- PERFIS DE USUÁRIO E PERMISSÕES ---------- */
  const PERM_DEFAULTS = { products:false, toggleProducts:false, settings:false };
  function perms(){ return Object.assign({}, PERM_DEFAULTS, state.settings.perm || {}); }
  function currentUser(){ return currentWaiter(); }
  // Sem usuários cadastrados, o sistema fica em modo de configuração inicial (acesso total).
  // Com usuários cadastrados, quem não se identificou recebe as permissões do OPERADOR
  // (sair do sistema não eleva privilégio).
  function currentRole(){
    const u = currentUser();
    if(u) return (u.role === "admin" || u.role === "gerente") ? u.role : "operador";
    return (state.waiters || []).length ? "operador" : "admin";
  }
  function isAdmin(){ return currentRole() === "admin"; }
  function isManager(){ return currentRole() === "gerente"; }
  // Produtos: admin e gerente sempre; operador só com permissão explícita
  function canManageProducts(){ return isAdmin() || isManager() || perms().products === true; }
  function canToggleProducts(){ return isAdmin() || isManager() || perms().toggleProducts === true; }
  // Configurações gerais (estabelecimento, mesas, desconto, exigir garçom)
  function canOpenSettings(){ return isAdmin() || isManager() || perms().settings === true; }
  // Seções administrativas — o gerente NÃO tem acesso
  function canManageTeam(){ return isAdmin() || perms().settings === true; }
  function canManageTerminals(){ return isAdmin() || perms().settings === true; }
  function canBackup(){ return isAdmin() || perms().settings === true; }
  function roleKey(r){ return (r === "admin" || r === "gerente") ? r : "operador"; }
  function roleLabel(r){
    return r === "admin" ? "Administrador" : (r === "gerente" ? "Gerente" : "Operador");
  }
  function roleTag(r){
    const k = roleKey(r);
    return '<span class="tag '+k+'">'+(k === "admin" ? "ADMIN" : k === "gerente" ? "GERENTE" : "OPERADOR")+'</span>';
  }
  function activeAdminCount(excludeId){
    return (state.waiters || []).filter(w=>
      w.active !== false && (w.role || "operador") === "admin" && w.id !== excludeId).length;
  }

  // Aplica o perfil atual à interface inteira
  function applyPermissions(){
    const role = currentRole();
    const teamTab = $(".tab[data-view='garcons']");
    if(teamTab) teamTab.hidden = !canManageTeam();
    if(currentView === "garcons" && !canManageTeam()) switchView("mesas");

    const tag = $("#roleTag");
    if(tag){
      const u = currentUser();
      tag.hidden = !u;
      if(u){
        tag.textContent = role === "admin" ? "ADMIN" : (role === "gerente" ? "GERENTE" : "OPERADOR");
        tag.className = "role-badge " + roleKey(role);
      }
    }
    applyConfigPermissions();
    const nb = $("#btnNewProduct");
    if(nb) nb.hidden = !canManageProducts();
    const note = $("#prodReadOnly");
    if(note) note.hidden = canManageProducts();
    const wm = $("#wlManage");
    if(wm) wm.hidden = !canManageTeam();
  }

  // Seções do painel de configurações conforme o perfil
  function applyConfigPermissions(){
    const team = $("#cfgTeam"), term = $("#cfgTerminals"), back = $("#cfgBackup");
    if(team) team.hidden = !canManageTeam();
    if(term) term.hidden = !canManageTerminals();
    if(back) back.hidden = !canBackup();
  }

  /* ============================================================
     NAVEGAÇÃO
     ============================================================ */
  let currentView = "mesas";
  function switchView(v){
    if(v === "garcons" && !canManageTeam()){
      toast("Seu perfil não gerencia a equipe.");
      v = "mesas";
    }
    currentView = v;
    $$(".tab").forEach(b=> b.classList.toggle("active", b.dataset.view===v));
    $("#view-mesas").hidden   = v!=="mesas";
    $("#view-producao").hidden= v!=="producao";
    $("#view-produtos").hidden= v!=="produtos";
    $("#view-garcons").hidden = v!=="garcons";
    $("#view-historico").hidden=v!=="historico";
    window.scrollTo({top:0,behavior:"instant" in window ? "instant" : "auto"});
    if(v==="producao") renderProduction();
    if(v==="produtos") renderProducts();
    if(v==="garcons") renderWaiters();
    if(v==="historico") renderHistory();
  }
  $$(".tab").forEach(b=> b.addEventListener("click", ()=> switchView(b.dataset.view)));

  /* ============================================================
     MODAIS
     ============================================================ */
  const REG = {
    comanda:{ modal:"#modalComanda", ov:"#overlayComanda" },
    pay:{ modal:"#modalPay", ov:"#overlayPay" },
    receipt:{ modal:"#modalReceipt", ov:"#overlayReceipt" },
    product:{ modal:"#modalProduct", ov:"#overlayProduct" },
    config:{ modal:"#modalConfig", ov:"#overlayConfig" },
    waiterLogin:{ modal:"#modalWaiterLogin", ov:"#overlayWaiterLogin" },
    waiter:{ modal:"#modalWaiter", ov:"#overlayWaiter" },
    split:{ modal:"#modalSplit", ov:"#overlaySplit" },
    pos:{ modal:"#modalPos", ov:"#overlayPos" },
    terminal:{ modal:"#modalTerminal", ov:"#overlayTerminal" },
    notice:{ modal:"#modalNotice", ov:"#overlayNotice" },
    notices:{ modal:"#modalNotices", ov:"#overlayNotices" },
    discAuth:{ modal:"#modalDiscAuth", ov:"#overlayDiscAuth" },
    move:{ modal:"#modalMove", ov:"#overlayMove" },
    pedido:{ modal:"#modalPedido", ov:"#overlayPedido" }
  };
  function openModal(name){
    Object.keys(REG).forEach(k=>{
      const on = (k===name);
      $(REG[k].modal).hidden = !on;
      $(REG[k].ov).hidden = !on;
    });
    document.body.style.overflow = "hidden";
  }
  function closeModals(){
    Object.keys(REG).forEach(k=>{ $(REG[k].modal).hidden = true; $(REG[k].ov).hidden = true; });
    document.body.style.overflow = "";
  }
  function cancelPendingWaiter(){
    pendingTable = null;
    pendingAssignComanda = null;
  }
  $$("[data-close]").forEach(b=> b.addEventListener("click", ()=>{
    const t = b.dataset.close;
    if(t==="pos"){ cancelPos(); return; }
    if(t==="discAuth"){ cancelDiscAuth(); return; }
    if(t==="comanda"){ committedEdit = false; activeId = null; }
    if(t==="waiterLogin") cancelPendingWaiter();
    closeModals();
    if(t==="receipt" || t==="config") renderAll();
    if((t==="split" || t==="pay") && activeId && getActive()){ renderComanda(); openModal("comanda"); }
  }));
  Object.keys(REG).forEach(k=>{
    $(REG[k].ov).addEventListener("click", ()=>{
      if(k==="pos"){ cancelPos(); return; }
      if(k==="discAuth"){ cancelDiscAuth(); return; }
      if(k==="comanda"){ committedEdit = false; activeId = null; }
      if(k==="waiterLogin") cancelPendingWaiter();
      const backToComanda = (k==="split" || k==="pay") && activeId && getActive();
      closeModals();
      renderAll();
      if(backToComanda){ renderComanda(); openModal("comanda"); }
    });
  });
  document.addEventListener("keydown", e=>{
    if(e.key === "Escape" && !$("#modalPos").hidden){ cancelPos(); return; }
    if(e.key === "Escape" && !$("#modalDiscAuth").hidden){ cancelDiscAuth(); return; }
    if(e.key==="Escape" && !$("#modalComanda").hidden){ committedEdit=false; activeId=null; closeModals(); renderAll(); }
    else if(e.key==="Escape"){ closeModals(); }
  });

  /* ============================================================
     TOPO / RENDER GERAL
     ============================================================ */
  function renderTop(){
    const open = state.comandas.filter(c=>c.status==="open");
    $("#statTables").textContent = open.length + "/" + state.settings.tables;
    const today = startOfDay(new Date()).getTime();
    const sold = state.comandas
      .filter(c=>c.status==="closed" && new Date(c.closedAt).getTime() >= today)
      .reduce((s,c)=> s + c.total, 0);
    $("#statToday").textContent = money(sold);
    $("#brandName").textContent = state.settings.name || "Meu Restaurante";
    document.title = (state.settings.name||"Comandas") + " — Controle de Mesas";
    const badge = open.length;
    $(".tab[data-view='mesas']").innerHTML = "🪑 Mesas" + (badge? '<span class="badge">'+badge+'</span>' : "");

    // Pendências de produção no rótulo da aba (a cozinha vê sem abrir)
    const prodTab = $(".tab[data-view='producao']");
    if(prodTab){
      const pend = productionQueue().reduce(function(s,x){ return s + x.qty; }, 0);
      prodTab.innerHTML = "🍳 Produção" + (pend ? '<span class="badge">'+pend+'</span>' : "");   // fila da cozinha
    }

    // Garçom conectado
    const w = currentWaiter();
    const pill = $("#btnWaiter");
    if(w){
      pill.classList.remove("none");
      $("#waiterAvatar").textContent = initials(w.name);
      $("#waiterLabel").textContent = w.name;
      pill.title = "Garçom conectado: " + w.name;
    }else{
      pill.classList.add("none");
      $("#waiterAvatar").textContent = "?";
      $("#waiterLabel").textContent = activeWaiters().length ? "Entrar" : "Garçom";
      pill.title = "Nenhum garçom identificado";
    }
    applyPermissions();
    checkNotices();
    syncTopbarHeight();
  }

  // Mantém as abas grudadas logo abaixo do topo (a altura varia com o conteúdo)
  function syncTopbarHeight(){
    const tb = document.querySelector(".topbar");
    if(tb) document.documentElement.style.setProperty("--topbar-h", tb.offsetHeight + "px");
  }

  function renderAll(){
    renderTop();
    renderTables();
    if(currentView==="produtos") renderProducts();
    if(currentView==="garcons") renderWaiters();
    if(currentView==="historico") renderHistory();
    if(currentView==="producao") renderProduction();
    if(activeId) renderComanda();
  }

  /* ============================================================
     MESAS
     ============================================================ */
  function renderTables(){
    const grid = $("#gridTables");
    const n = Math.max(1, Number(state.settings.tables)||1);
    let html = "";
    for(let t=1; t<=n; t++){
      const c = openByTable(t);
      if(c){
        html += '<button class="table-card busy" data-table="'+t+'">'+
          '<div class="table-top"><span class="table-num">'+String(t).padStart(2,"0")+'</span>'+
          '<span class="table-badge">Ocupada</span></div>'+
          '<span class="table-total">'+money(remainingOf(c) > 0 ? remainingOf(c) : totalOf(c))+'</span>'+
          '<span class="table-meta">'+c.items.reduce((s,i)=>s+i.qty,0)+' itens · '+elapsed(c.openedAt)+
            (paymentsOf(c).length ? ' · <b style="color:#b45309">pago '+money(paidTotal(c))+'</b>' : '')+'</span>'+
          '</button>';
      }else{
        html += '<button class="table-card free" data-table="'+t+'">'+
          '<div class="table-top"><span class="table-num">'+String(t).padStart(2,"0")+'</span>'+
          '<span class="table-badge">Livre</span></div>'+
          '<span class="table-meta">Toque para abrir comanda</span>'+
          '</button>';
      }
    }
    grid.innerHTML = html;
    $$("#gridTables .table-card").forEach(card=>{
      card.addEventListener("click", ()=> onTableClick(Number(card.dataset.table)));
    });
    const openCount = state.comandas.filter(c=>c.status==="open").length;
    $("#mesasSub").textContent = openCount
      ? openCount + (openCount===1?" mesa ocupada":" mesas ocupadas") + " de " + n + "."
      : "Toque em uma mesa livre para abrir a comanda.";
  }

  let pendingTable = null;          // mesa aguardando identificação do garçom
  let pendingAssignComanda = null;  // comanda cujo garçom será alterado

  function onTableClick(t){
    const c = openByTable(t);
    if(c){ activeId = c.id; committedEdit = false; renderComanda(); openModal("comanda"); return; }
    if(requiresWaiter() && !currentWaiter()){
      pendingTable = t; pendingAssignComanda = null;
      openWaiterLogin();
      toast("Identifique o garçom para abrir a comanda.");
      return;
    }
    openComandaForTable(t);
  }

  function openComandaForTable(t){
    const w = currentWaiter();
    const comandaId = uid();
    // O id nasce aqui para o painel abrir na hora. Quem cria e numera de fato é
    // o servidor: o `seq` é dele, não do aparelho.
    const r = despachar("abrirComanda", { table: t, comandaId });
    if(!r || r.ok === false) return;
    activeId = comandaId; committedEdit = true;
    renderComanda();
    openModal("comanda");
    const c = comandaById(comandaId);
    toast("Comanda" + (c && c.seq ? " #" + c.seq : "") + " aberta na mesa " + t + (w ? " · " + w.name : ""));
  }

  /* ============================================================
     COMANDA (DRAWER)
     ============================================================ */
  let activeId = null;
  let committedEdit = true;
  let cmdSearchTerm = "";

  function getActive(){ return activeId ? comandaById(activeId) : null; }

  function renderComanda(){
    const c = getActive();
    if(!c){ closeModals(); return; }

    $("#cmdTitle").textContent = "Mesa " + c.table;
    const count = c.items.reduce((s,i)=>s+i.qty,0);
    $("#cmdSub").textContent = "Aberta às " + hm(c.openedAt) + " · " + count + (count===1?" item":" itens");
    $("#cmdWaiterName").textContent = c.waiterName || waiterLabelOf(c.waiterId);

    // Seleção de produtos
    const picks = $("#cmdPicks");
    const term = cmdSearchTerm.trim().toLowerCase();
    const terms = searchTerms(term);
    const list = state.products
      .filter(p=> p.active !== false && matchProduct(p, terms))
      .sort((a,b)=> (a.category||"").localeCompare(b.category||"") || a.name.localeCompare(b.name));
    const LIMITE = 60;
    if(!list.length){
      picks.innerHTML = '<div class="pick-empty">Nenhum produto encontrado' + (term ? ' para \u201c'+esc(term)+'\u201d' : '') + "."+
        (canManageProducts() ? ' Cadastre em <b>Produtos</b>.' : '') + '</div>';
    }else{
      picks.innerHTML = list.slice(0, LIMITE).map(p=>
        '<button class="pick" data-pick="'+esc(p.id)+'"><span class="n">'+highlightMatch(p.name, terms)+'</span>'+
        '<span class="p">'+money(p.price)+'</span></button>'
      ).join("") + (list.length > LIMITE
        ? '<div class="pick-empty">Mostrando '+LIMITE+' de '+list.length+' — refine a busca.</div>'
        : "");
      $$("#cmdPicks .pick").forEach(b=> b.addEventListener("click", ()=> addItem(b.dataset.pick)));
    }

    // Itens
    const box = $("#cmdItems");
    if(!c.items.length){
      box.innerHTML = '<div class="empty" style="padding:34px 12px">'+
        '<div class="big">🧾</div><h3>Comanda vazia</h3>'+
        '<p>Toque em um produto acima para adicionar.</p></div>';
    }else{
      const multi = itemAuthors(c) > 1;
      box.innerHTML = c.items.map(i=>{
        const k = itemKey(i);
        const autor = authorShort(i);
        const pend = pendingQty(i);
        const enviado = sentQtyOf(i);
        const despachado = dispatchedQtyOf(i);
        // despachado (cozinha) > na produção (enviado) > N enviados > novo
        const tag = (i.qty > 0 && despachado >= i.qty)
          ? '<span class="sent-tag ok">despachado</span>'
          : (pend > 0
              ? (enviado > 0
                  ? '<span class="sent-tag part">'+enviado+' enviados</span>'
                  : '<span class="sent-tag new">novo</span>')
              : '<span class="sent-tag part">na produção</span>');
        return '<div class="item">'+
          '<div class="item-info"><div class="n">'+esc(i.name)+(autor && multi ? ' <span class="who">'+esc(autor)+'</span>' : '')+tag+'</div>'+
          '<div class="u">'+money(i.price)+' / un'+(autor && !multi ? " · "+esc(autor) : "")+'</div></div>'+
          '<div class="qty">'+
            '<button data-act="dec" data-item="'+esc(k)+'" aria-label="Diminuir">−</button>'+
            '<span class="q">'+i.qty+'</span>'+
            '<button data-act="inc" data-item="'+esc(k)+'" aria-label="Aumentar">+</button>'+
          '</div>'+
          '<div class="item-total">'+money(i.price*i.qty)+'</div>'+
          '<button class="del" data-act="del" data-item="'+esc(k)+'" aria-label="Remover">🗑</button>'+
        '</div>';
      }).join("");
      $$("#cmdItems [data-act]").forEach(b=>{
        b.addEventListener("click", ()=> itemAction(b.dataset.act, b.dataset.item));
      });
    }

    // Desconto
    const allow = !!state.settings.allowDiscount;
    $("#discBlock").hidden = !allow;
    $("#cmdDiscLine").hidden = !allow || discountAmount(c) <= 0;
    $("#discType").value = c.discount ? c.discount.type : "value";
    if(document.activeElement !== $("#discValue")){
      $("#discValue").value = c.discount ? c.discount.value : 0;
    }

    renderComandaTotals(c);
    renderProdBar(c);
  }

  // Barra de produção: só aparece quando há item novo para enviar
  function renderProdBar(c){
    const bar = $("#prodBar");
    if(!bar) return;
    const pend = pendingItems(c);
    if(!pend.length){ bar.hidden = true; return; }
    bar.hidden = false;
    const unidades = pend.reduce(function(s,i){ return s + pendingQty(i); }, 0);
    const setores = Object.keys(pend.reduce(function(m,i){ m[sectorOfItem(i)] = true; return m; }, {}));
    $("#prodBarText").innerHTML = "<b>" + unidades + (unidades === 1 ? " item novo" : " itens novos") + "</b> para " +
      esc(setores.join(" e ")) + " — ainda não enviado à produção";
  }

  // Só o que muda a cada lançamento (usado também ao digitar desconto / ligar a taxa)
  function renderComandaTotals(c){
    if(!c) return;
    $("#cmdSubtotal").textContent = money(subtotal(c));
    $("#cmdDisc").textContent = "- " + money(discountAmount(c));
    $("#cmdDiscLine").hidden = !state.settings.allowDiscount || discountAmount(c) <= 0;

    // Taxa de serviço
    $("#feeBlock").hidden = false;
    $("#feeOn").checked = !!(c.fee && c.fee.on);
    $("#feePctLabel").textContent = (Number(c.fee && c.fee.pct) || 0) + "%";
    $("#cmdFeePct").textContent = feePct(c);
    $("#cmdFee").textContent = "+ " + money(feeAmount(c));
    $("#cmdFeeLine").hidden = feeAmount(c) <= 0;
    $("#cmdTotal").textContent = money(totalOf(c));

    // Aviso/autorização do limite de desconto
    const mostraDica = !!state.settings.allowDiscount && !isAdmin();
    $("#discHintRow").hidden = !mostraDica;
    if(mostraDica){
      $("#discHint").textContent = c.discountAuth
        ? "Desconto autorizado por " + c.discountAuth.byName + " às " + hm(c.discountAuth.at) + "."
        : "Desconto acima de " + discountLimitPct() + "% precisa da autorização de um administrador.";
    }

    const pays = paymentsOf(c);
    const paid = paidTotal(c);
    const rem = remainingOf(c);
    $("#cmdPayBlock").hidden = pays.length === 0;
    $("#cmdPaid").textContent = money(paid);
    $("#cmdPaid").classList.toggle("zero", paid <= 0);
    $("#cmdRemain").textContent = money(rem);
    $("#cmdPayCount").textContent = pays.length ? "(" + pays.length + ")" : "";

    const closeBtn = $("#btnCloseComanda");
    $("#btnSplit").disabled = c.items.length === 0;
    if(c.items.length === 0){
      closeBtn.disabled = true;
      closeBtn.textContent = "Adicione itens para encerrar";
    }else if(rem <= 0){
      closeBtn.disabled = false;
      closeBtn.textContent = "Encerrar comanda";
    }else{
      closeBtn.disabled = false;
      closeBtn.textContent = pays.length ? ("Encerrar e pagar " + money(rem)) : "Encerrar e pagar";
    }
  }

  /* ---------- Desconto com limite por perfil ---------- */
  let pendingDiscount = null;
  function discountAmountFor(c, type, value){
    const st = subtotal(c);
    const d = type === "percent" ? st * (Number(value)||0)/100 : (Number(value)||0);
    return Math.round(Math.max(0, Math.min(st, d))*100)/100;
  }
  function revertDiscountInput(c){
    $("#discType").value = c.discount ? c.discount.type : "value";
    $("#discValue").value = c.discount ? c.discount.value : 0;
  }
  function requestDiscount(type, value){
    const c = getActive(); if(!c) return;
    const st = subtotal(c);
    let v = Number(value) || 0;
    if(v < 0) v = 0;
    if(type === "percent" && v > 100) v = 100;
    if(type === "value" && v > st) v = st;

    if(discountNeedsAuth(type, v, st)){
      if(!activeAdminCount(null)){
        toast("Desconto acima de " + discountLimitPct() + "% exige autorização, mas não há administrador ativo.");
        revertDiscountInput(c);
        return;
      }
      pendingDiscount = { type:type, value:v };
      openDiscAuth(c, discountPctOf(type, v, st), v, type);
      return;
    }
    despachar("aplicarDesconto", { comandaId: c.id, dtype: type, value: v });
    renderComandaTotals(c);
    if(paidTotal(c) > totalOf(c) + 0.001) toast("Atenção: os pagamentos registrados já superam o novo total.");
  }

  function openDiscAuth(c, pct, value, type){
    const admins = (state.waiters || []).filter(function(w){ return w.active !== false && w.role === "admin"; });
    // Mostra sempre as duas leituras: percentual e valor (sem repetir o mesmo número)
    const pctTxt = (Math.round(pct*10)/10) + "%";
    const valTxt = money(discountAmountFor(c, type, value));
    const pedido = (type === "percent")
      ? ("<b>" + pctTxt + "</b> (" + valTxt + ")")
      : ("<b>" + valTxt + "</b> (" + pctTxt + ")");
    $("#discAuthSub").textContent = "Mesa " + c.table + " · comanda #" + (c.seq || "—");
    $("#discAuthInfo").innerHTML = "Desconto de " + pedido +
      " acima do limite de <b>" + discountLimitPct() + "%</b> do seu perfil.<br>Peça a um administrador para autorizar.";
    $("#discAuthWho").innerHTML = admins.map(function(w){
      return '<option value="'+esc(w.id)+'">'+esc(w.name)+(w.pin ? " 🔒" : "")+'</option>';
    }).join("");
    $("#discAuthPin").value = "";
    $("#discAuthErr").style.display = "none";
    updateDiscAuthPin();
    openModal("discAuth");
  }
  function updateDiscAuthPin(){
    const adm = waiterById($("#discAuthWho").value);
    const precisa = !!(adm && adm.pin);
    $("#discAuthPinField").hidden = !precisa;
    if(!precisa) $("#discAuthErr").style.display = "none";
  }
  $("#discAuthWho").addEventListener("change", updateDiscAuthPin);

  $("#btnDiscAuthOk").addEventListener("click", function(){
    const c = getActive(); if(!c || !pendingDiscount) return;
    const adm = waiterById($("#discAuthWho").value);
    if(!adm){ toast("Selecione o administrador que autoriza."); return; }
    if(adm.pin && String($("#discAuthPin").value).trim() !== String(adm.pin)){
      $("#discAuthErr").style.display = "block";
      $("#discAuthPin").value = "";
      $("#discAuthPin").focus();
      return;
    }
    const st = subtotal(c);
    const pct = Math.round(discountPctOf(pendingDiscount.type, pendingDiscount.value, st)*10)/10;
    c.discount = { type: pendingDiscount.type, value: pendingDiscount.value };
    c.discountAuth = { byId: adm.id, byName: adm.name, at: new Date().toISOString(), pct: pct };
    pendingDiscount = null;
    save();
    const quem = currentUser();
    auditLog("desconto_autorizado", "Mesa " + c.table + " · comanda #" + (c.seq || "—") + " · desconto de " + pct + "% (" +
      money(discountAmount(c)) + ") autorizado por " + adm.name +
      (quem && quem.id !== adm.id ? " para " + quem.name : "") + ".");
    closeModals();
    renderComanda();
    toast("Desconto de " + pct + "% autorizado por " + adm.name + ".");
  });

  function cancelDiscAuth(){
    const c = getActive();
    if(pendingDiscount && c){
      const st = subtotal(c);
      const pct = Math.round(discountPctOf(pendingDiscount.type, pendingDiscount.value, st)*10)/10;
      auditLog("desconto_negado", "Mesa " + c.table + " · comanda #" + (c.seq || "—") + " · pedido de desconto de " + pct +
        "% (" + money(discountAmountFor(c, pendingDiscount.type, pendingDiscount.value)) + ") sem autorização.");
      pendingDiscount = null;
    }
    closeModals();
    if(c) revertDiscountInput(c);
  }
  $("#btnDiscAuthCancel").addEventListener("click", cancelDiscAuth);

  $("#feeOn").addEventListener("change", function(){
    const c = getActive(); if(!c) return;
    const pct = Math.max(0, Math.min(100, Number(state.settings.serviceFeePct) || 0));
    despachar("ligarTaxa", { comandaId: c.id, pct: pct, on: $("#feeOn").checked });
    renderComandaTotals(c);
    toast($("#feeOn").checked ? ("Taxa de serviço de " + pct + "% incluída na comanda.") : "Taxa de serviço removida.");
  });

  function addItem(pid){
    const c = getActive(); if(!c) return;
    const p = state.products.find(x=>x.id===pid);
    if(!p) return;
    // Preço, setor e autoria são resolvidos pelo domínio compartilhado: o
    // cliente diz QUAL produto e QUANTO, nunca quanto custa.
    despachar("adicionarItem", { comandaId: c.id, productId: p.id, qty: 1, iid: uid() });
    renderComanda(); renderTables(); renderTop();
  }

  function itemAction(act, key){
    const c = getActive(); if(!c) return;
    const idx = c.items.findIndex(i=> itemKey(i) === key);
    if(idx < 0) return;
    const it = c.items[idx];
    if(act === "inc") despachar("definirQtd", { comandaId: c.id, iid: itemKey(it), qty: it.qty + 1 });
    else if(act === "dec") despachar("definirQtd", { comandaId: c.id, iid: itemKey(it), qty: Math.max(0, it.qty - 1) });
    else if(act === "del") despachar("removerItem", { comandaId: c.id, iid: itemKey(it) });
    renderComanda(); renderTables(); renderTop();
  }

  $("#cmdSearch").addEventListener("input", e=>{ cmdSearchTerm = e.target.value; renderComanda(); });

  // A busca do catálogo estava sem listener: digitar não filtrava nada.
  let prodSearchTerm = "";
  $("#prodSearch").addEventListener("input", e=>{ prodSearchTerm = e.target.value; renderProducts(); });
  $("#prodSearch").addEventListener("keydown", e=>{
    if(e.key === "Escape"){ e.target.value = ""; prodSearchTerm = ""; renderProducts(); }
  });
  $("#discType").addEventListener("change", e=>{
    requestDiscount(e.target.value, Number($("#discValue").value) || 0);
  });
  $("#discValue").addEventListener("input", e=>{
    requestDiscount($("#discType").value, e.target.value);
  });

  $("#btnCancelComanda").addEventListener("click", ()=>{
    const c = getActive(); if(!c) return;
    const pays = paymentsOf(c);
    const aviso = pays.length
      ? "\n\nATENÇÃO: há " + pays.length + " pagamento(s) parcial(is) registrado(s), totalizando " + money(paidTotal(c)) + ". Eles serão perdidos."
      : " Os itens serão descartados e não irão para o histórico.";
    if(!confirm("Cancelar a comanda da mesa " + c.table + "?" + aviso)) return;
    // Cancelar NÃO apaga: vira status "cancelled", fora da operação e da receita,
    // com quem cancelou registrado na trilha de auditoria do servidor.
    despachar("cancelarComanda", { comandaId: c.id });
    activeId = null; committedEdit = false;
    closeModals();
    renderAll();
    toast("Comanda da mesa " + c.table + " cancelada.");
  });

  $("#btnCloseComanda").addEventListener("click", ()=>{
    const c = getActive(); if(!c || !c.items.length) return;
    if(remainingOf(c) <= 0){ finishComanda(null); return; }   // conta já quitada nos parciais
    openPayment();
  });

  /**
   * Encerrar: paga o restante (se houver) e fecha. O servidor é quem encerra —
   * ele recalcula o total, valida o saldo e grava autoria/comprovante. O que o
   * painel mostra depois é o registro oficial, não o que o aparelho achava.
   */
  function finishComanda(finalPay){
    const c = getActive(); if(!c) return;
    if(finalPay){
      const extra = { mode: "final", label: "Fechamento" };
      if(finalPay.card) extra.card = finalPay.card;
      if(!addPayment(c, finalPay.amount, finalPay.method, extra)){
        toast("Não há valor restante a receber.");
        return;
      }
      const comSaldo = comandaById(c.id);
      if(comSaldo && remainingOf(comSaldo) > 0){
        toast("Ainda falta " + money(remainingOf(comSaldo)) + " para encerrar.");
        return;
      }
    }
    const r = despachar("encerrarComanda", { comandaId: c.id });
    if(!r || r.ok === false) return;
    const fechada = comandaById(c.id);
    activeId = null; committedEdit = false;
    closeModals();
    sincronizarEstado();
    renderAll();
    if(fechada) showReceipt(fechada, true);
    toast("Comanda da mesa " + (fechada ? fechada.table : c.table) + " encerrada.");
  }


  /* ============================================================
     PAGAMENTO
     ============================================================ */
  let payMethod = "Dinheiro";
  let pendingCard = null;   // transação aprovada na maquininha aguardando confirmação

  function openPayment(){
    const c = getActive(); if(!c) return;
    payMethod = "Dinheiro";
    pendingCard = null;
    $$("#payMethods .pay").forEach(b=> b.classList.toggle("active", b.dataset.method==="Dinheiro"));
    $("#payReceived").value = "";
    renderPayment();
    openModal("pay");
  }

  function renderPayment(){
    const c = getActive(); if(!c) return;
    const pays = paymentsOf(c).length;
    $("#paySub").textContent = "Mesa " + c.table + " · " + c.items.reduce((s,i)=>s+i.qty,0) + " itens" +
      (pays ? " · " + pays + " pagamento(s) parcial(is)" : "");
    $("#payTotal").textContent = money(remainingOf(c));

    const isCard = (payMethod === "Crédito" || payMethod === "Débito");
    $("#fieldReceived").hidden = (payMethod !== "Dinheiro");
    $("#posBlock").hidden = !isCard;
    if(isCard){
      fillTerminalSelect();
      updateSendPosButton();
      renderPayCardBox();
    }else{
      updateChange();
    }
    $("#btnConfirmPay").textContent = pendingCard ? "Confirmar pagamento e liberar mesa" : "Confirmar pagamento e liberar mesa";
  }

  function fillTerminalSelect(){
    const sel = $("#payTerminalSel");
    const list = activeTerminals();
    sel.innerHTML = list.length
      ? list.map(t=>'<option value="'+esc(t.id)+'">'+esc(t.label)+" · "+esc(posModelName(t.model))+'</option>').join("")
      : '<option value="">Nenhuma maquininha cadastrada</option>';
    if(list.length){
      const def = state.settings.defaultTerminalId;
      sel.value = list.some(t=> t.id === def) ? def : list[0].id;
    }
  }
  function selectedTerminal(){
    const id = $("#payTerminalSel") ? $("#payTerminalSel").value : null;
    return activeTerminals().find(t=> t.id === id) || activeTerminals()[0] || null;
  }

  function updateSendPosButton(){
    const c = getActive(); if(!c) return;
    const btn = $("#btnSendPos");
    const term = selectedTerminal();
    if(!term){
      btn.disabled = true;
      btn.textContent = "Nenhuma maquininha ativa — cadastre em \u2699\ufe0f";
      return;
    }
    const rem = remainingOf(c);
    btn.disabled = rem <= 0;
    btn.textContent = "💳 Enviar " + money(rem) + " à " + term.label;
  }

  function renderPayCardBox(){
    const box = $("#payCardBox");
    if(pendingCard){
      box.innerHTML = '<div class="approve-card"><h4>✅ Transação aprovada</h4>' + cardLines(pendingCard) +
        '<button class="pos-link" id="btnRedoPos">Cobrar novamente na maquininha</button></div>';
      const r = $("#btnRedoPos");
      if(r) r.addEventListener("click", ()=>{ pendingCard = null; renderPayment(); });
      $("#btnManualCard").hidden = true;
      $("#manualCardBox").hidden = true;
      return;
    }
    box.innerHTML = "";
    $("#btnManualCard").hidden = false;
  }

  function cardLines(card){
    if(!card) return "";
    return '<div class="l"><span>Bandeira</span><b>'+esc(card.brand||"—")+'</b></div>'+
      '<div class="l"><span>NSU</span><b>'+esc(card.nsu||"—")+'</b></div>'+
      '<div class="l"><span>Autoriza\u00e7\u00e3o</span><b>'+esc(card.authorizationCode||"—")+'</b></div>'+
      (card.installments > 1 ? '<div class="l"><span>Parcelas</span><b>'+card.installments+'x</b></div>' : '')+
      '<div class="l"><span>Terminal</span><b>'+esc(card.terminalLabel||"—")+'</b></div>'+
      (card.simulated ? '<div class="r-sim">SIMULADO — sem transa\u00e7\u00e3o real</div>' : '')+
      (card.manual ? '<div class="r-sim" style="color:#475569;background:#f1f5f9">REGISTRO MANUAL</div>' : '');
  }

  function currentPayCard(){
    if(pendingCard) return pendingCard;
    if($("#manualCardBox").hidden) return null;
    const term = selectedTerminal();
    return {
      terminalId: term ? term.id : null, terminalLabel: term ? term.label : "—",
      model: term ? term.model : "custom", mode: "manual",
      type: payMethod === "Crédito" ? "credit" : "debit",
      brand: $("#manBrand").value,
      installments: Number($("#manInst").value) || 1,
      nsu: $("#manNsu").value.trim(),
      authorizationCode: $("#manAuth").value.trim(),
      simulated: false, manual: true,
      at: new Date().toISOString()
    };
  }

  $("#btnManualCard").addEventListener("click", ()=>{
    const box = $("#manualCardBox");
    box.hidden = !box.hidden;
    if(!box.hidden && !$("#manBrand").options.length){
      $("#manBrand").innerHTML = CARD_BRANDS.map(b=>'<option>'+esc(b)+'</option>').join("");
    }
  });
  $("#btnSendPos").addEventListener("click", ()=>{
    const c = getActive(); if(!c) return;
    const term = selectedTerminal();
    if(!term){ toast("Cadastre uma maquininha nas configurações."); return; }
    const rem = remainingOf(c);
    if(rem <= 0) return;
    openPos(rem, payMethod, term, (card)=>{ pendingCard = card; }, { returnTo:"pay" });
  });
  function updateChange(){
    const c = getActive(); if(!c) return;
    const t = remainingOf(c);
    const r = Number($("#payReceived").value)||0;
    const ch = Math.max(0, Math.round((r-t)*100)/100);
    $("#payChangeHint").textContent = "Troco: " + money(ch);
  }
  $$("#payMethods .pay").forEach(b=> b.addEventListener("click", ()=>{
    payMethod = b.dataset.method;
    $$("#payMethods .pay").forEach(x=> x.classList.toggle("active", x===b));
    if(payMethod !== "Crédito" && payMethod !== "Débito") pendingCard = null;
    renderPayment();
  }));
  $("#payReceived").addEventListener("input", updateChange);

  $("#btnConfirmPay").addEventListener("click", ()=>{
    const c = getActive(); if(!c) return;
    const t = remainingOf(c);
    let received = null, change = 0;
    if(payMethod === "Dinheiro"){
      received = Number($("#payReceived").value)||0;
      if(received > 0 && received < t){
        toast("Valor recebido menor que o valor restante.");
        return;
      }
      if(!received) received = t;
      change = Math.max(0, Math.round((received-t)*100)/100);
    }
    finishComanda({
      amount: t, method: payMethod, received: received, change: change,
      card: (payMethod === "Crédito" || payMethod === "Débito") ? currentPayCard() : null
    });
  });

  /* ============================================================
     POS / MAQUININHA
     Stone SmartPOS · PagBank Moderninha · Cielo Lio
     ------------------------------------------------------------
     Três caminhos de integração (escolhidos por terminal):
       sdk -> window.POSBridge, injetado por invólucro nativo no SmartPOS
       tef -> bridge HTTP local na máquina do caixa (TEF/Sitef)
       sim -> simulador, somente demonstração/treinamento
     ============================================================ */
  const CARD_BRANDS = ["Mastercard", "Visa", "Elo", "American Express", "Hipercard"];
  const POS_MODELS = {
    stone:   { name:"Stone SmartPOS",       hint:"Android — SDK no próprio terminal" },
    pagbank: { name:"PagBank Moderninha",   hint:"Android — SDK no próprio terminal" },
    cielo:   { name:"Cielo Lio",            hint:"Android — SDK no próprio terminal" },
    custom:  { name:"Outra / TEF genérico", hint:"Bridge local (TEF/Sitef) ou SDK próprio" }
  };
  const POS_MODE_LABELS = { sim:"Simulador", tef:"Bridge TEF", sdk:"SDK do terminal" };
  const POS_STEPS = [
    { key:"connecting", label:"Conectando ao terminal..." },
    { key:"waiting",    label:"Aguardando aproximação ou inserção do cartão..." },
    { key:"processing", label:"Processando transação..." },
    { key:"done",       label:"Transação aprovada!" }
  ];

  function posModelName(m){ return (POS_MODELS[m] || POS_MODELS.custom).name; }
  function modeLabel(m){ return POS_MODE_LABELS[m] || "—"; }
  function activeTerminals(){ return (state.terminals || []).filter(t=> t.active !== false); }
  function terminalById(id){ return (state.terminals || []).find(t=> t.id === id) || null; }
  function activeTerminal(){
    const list = activeTerminals();
    return list.find(t=> t.id === state.settings.defaultTerminalId) || list[0] || null;
  }
  function randDigits(n){ let s = ""; for(let i=0;i<n;i++) s += Math.floor(Math.random()*10); return s; }
  function makeCard(terminal, type, extra){
    return Object.assign({
      terminalId: terminal.id, terminalLabel: terminal.label,
      model: terminal.model, modelName: posModelName(terminal.model),
      mode: terminal.mode, type: type, installments: 1,
      at: new Date().toISOString()
    }, extra || {});
  }

  /* ---------- Estado da cobrança ---------- */
  let posCtx = null, posApproved = null, posError = null, posStep = 0;
  let posBrand = "Mastercard", posSimDecline = false;

  function renderPosBrands(){
    const box = $("#posBrands");
    box.innerHTML = CARD_BRANDS.map(b=>
      '<button type="button" class="brand'+(b === posBrand ? " active" : "")+'" data-brand="'+esc(b)+'">'+esc(b)+'</button>'
    ).join("");
    $$("#posBrands .brand").forEach(b=> b.addEventListener("click", ()=>{
      posBrand = b.dataset.brand;
      state.settings.lastBrand = posBrand; save();
      renderPosBrands();
    }));
  }

  function renderPosSteps(){
    const last = POS_STEPS.length - 1;
    $("#posSteps").innerHTML = POS_STEPS.map((s,i)=>{
      let cls = "pstep", icon = "○";
      if(posError && i === posStep){ cls += " err"; icon = "✕"; }
      else if(i < posStep || (i === posStep && posStep === last && !posError)){ cls += " done"; icon = "✓"; }
      else if(i === posStep){ cls += " active"; icon = '<span class="spin">◌</span>'; }
      return '<div class="'+cls+'"><span class="pi">'+icon+'</span>'+esc(s.label)+'</div>';
    }).join("");
  }
  function posStatus(key){
    const i = POS_STEPS.findIndex(s=> s.key === key);
    if(i >= 0 && i !== posStep){ posStep = i; renderPosSteps(); }
  }

  function openPos(amount, method, terminal, onDone, opts){
    const o = opts || {};
    posCtx = { amount:amount, method:method, terminal:terminal, onDone:onDone,
               returnTo:o.returnTo || null, timers:[] };
    posApproved = null; posError = null; posStep = 0; posSimDecline = false;
    posBrand = CARD_BRANDS.indexOf(state.settings.lastBrand) >= 0 ? state.settings.lastBrand : "Mastercard";

    $("#posAmount").textContent = money(amount);
    $("#posSub").textContent = (method === "Crédito" ? "Crédito" : "Débito") + " · " + terminal.label;
    $("#posTerminal").innerHTML =
      '<span class="ic">💳</span><div class="tx"><b>'+esc(terminal.label)+'</b>'+
      '<small>'+esc(posModelName(terminal.model))+' · '+esc(modeLabel(terminal.mode))+'</small></div>';
    renderPosBrands();
    renderPosSteps();
    $("#posResult").innerHTML = "";
    $("#posContinue").hidden = true;
    $("#posCancel").textContent = "Cancelar";
    $("#posSimNote").innerHTML = terminal.mode === "sim"
      ? '<div class="pos-sim-note">⚠️ <div><b>Simulador</b> — nenhuma transação real é processada. '+
        'Use para treinar a equipe e validar o fluxo. '+
        '<button class="pos-link" id="posSimDecline" style="color:#92400e">Simular recusa</button></div></div>'
      : "";
    const d = $("#posSimDecline");
    if(d) d.addEventListener("click", ()=>{ posSimDecline = true; toast("A próxima resposta será uma recusa."); });

    openModal("pos");
    startPosFlow();
  }

  function startPosFlow(){
    const ctx = posCtx; if(!ctx) return;
    posError = null;
    posRun(ctx.amount, ctx.method, ctx.terminal, posStatus)
      .then(card=>{
        if(posCtx !== ctx) return;
        posApproved = card;
        posStep = POS_STEPS.length - 1;
        renderPosSteps();
        $("#posResult").innerHTML = '<div class="approve-card"><h4>✅ Transação aprovada</h4>'+cardLines(card)+'</div>';
        $("#posContinue").hidden = false;
        $("#posCancel").textContent = "Descartar";
      })
      .catch(err=>{
        if(posCtx !== ctx) return;
        posError = (err && err.message) || "Transação não aprovada.";
        renderPosSteps();
        const manualOk = ctx.returnTo === "pay";
        $("#posResult").innerHTML = '<div class="approve-card" style="border-color:#fecaca;background:#fef2f2">'+
          '<h4 style="color:#991b1b">✕ Não foi possível concluir</h4>'+
          '<div style="font-size:13px;color:#7f1d1d">'+esc(posError)+'</div>'+
          '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">'+
            '<button class="btn sm" id="posRetry">Tentar novamente</button>'+
            (manualOk ? '<button class="btn sm" id="posManual2">Registrar NSU manualmente</button>' : '')+
          '</div></div>';
        const r = $("#posRetry");
        if(r) r.addEventListener("click", ()=>{ posStep = 0; $("#posResult").innerHTML = ""; renderPosSteps(); startPosFlow(); });
        const m = $("#posManual2");
        if(m) m.addEventListener("click", ()=> finishPos(true));
      });
  }

  function returnFromPos(ctx){
    if(ctx.returnTo === "pay" && getActive()){ renderPayment(); openModal("pay"); return true; }
    if(ctx.returnTo === "split" && getActive()){ renderSplit(); openModal("split"); return true; }
    return false;
  }
  function finishPos(openManual){
    const ctx = posCtx; if(!ctx) return;
    const card = posApproved;
    if(ctx.timers) ctx.timers.forEach(clearTimeout);
    posCtx = null; posApproved = null; posError = null;
    closeModals();
    if(card && ctx.onDone) ctx.onDone(card);
    const back = returnFromPos(ctx);
    if(!back) renderAll();
    if(openManual && back){
      const box = $("#manualCardBox");
      box.hidden = false;
      if(!$("#manBrand").options.length) $("#manBrand").innerHTML = CARD_BRANDS.map(b=>'<option>'+esc(b)+'</option>').join("");
      toast("Informe o NSU e a autorização que aparecem na maquininha.");
    }
  }
  function cancelPos(){
    const ctx = posCtx;
    if(ctx && ctx.timers) ctx.timers.forEach(clearTimeout);
    posCtx = null; posApproved = null; posError = null;
    if(ctx && returnFromPos(ctx)) return;
    closeModals();
    renderAll();
  }

  $("#posContinue").addEventListener("click", ()=> finishPos(false));
  $("#posCancel").addEventListener("click", cancelPos);

  /* ---------- Motor de cobrança ---------- */
  function posRun(amount, method, terminal, onStatus){
    const type = method === "Crédito" ? "credit" : "debit";
    if(terminal.mode === "sdk") return posRunSdk(amount, type, terminal, onStatus);
    if(terminal.mode === "tef") return posRunTef(amount, type, terminal, onStatus);
    return posRunSim(amount, type, terminal, onStatus);
  }

  // Simulador: reproduz o tempo de cada etapa. Nunca é uma transação real.
  function posRunSim(amount, type, terminal, onStatus){
    return new Promise((resolve, reject)=>{
      if(!posCtx) return reject(new Error("cancelado"));
      posCtx.timers = [];
      onStatus("connecting");
      posCtx.timers.push(setTimeout(()=> onStatus("waiting"), 650));
      posCtx.timers.push(setTimeout(()=> onStatus("processing"), 2600));
      posCtx.timers.push(setTimeout(()=>{
        if(!posCtx) return reject(new Error("cancelado"));
        if(posSimDecline) return reject(new Error("Transação não autorizada pelo emissor (simulação)."));
        resolve(makeCard(terminal, type, {
          brand: posBrand, simulated: true,
          authorizationCode: randDigits(6), nsu: randDigits(9), installments: 1
        }));
      }, 3600));
    });
  }

  // Bridge local (TEF): POST /charge e, se pendente, GET /status?id=
  function posRunTef(amount, type, terminal, onStatus){
    const base = String(terminal.endpoint || "").replace(/\/+$/, "");
    return new Promise((resolve, reject)=>{
      if(!base){ reject(new Error("Informe o endereço do bridge TEF nas configurações.")); return; }
      onStatus("connecting");
      const c = getActive();
      const ref = "comanda-" + (c ? c.seq : "?") + "-" + Date.now();
      fetch(base + "/charge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: amount, type: type, installments: 1, reference: ref, terminal: terminal.model })
      })
      .then(r=> r.json().catch(()=> { throw new Error("Resposta inválida do bridge TEF (não é JSON)."); }))
      .then(res=>{
        if(!posCtx) throw new Error("cancelado");
        if(res && res.status === "approved") return res;
        if(res && res.status === "pending" && res.transactionId){ onStatus("waiting"); return pollTef(base, res.transactionId, onStatus, Date.now()); }
        throw new Error((res && res.message) || "Transação não aprovada pela maquininha.");
      })
      .then(res=>{
        if(!posCtx) throw new Error("cancelado");
        onStatus("processing");
        resolve(makeCard(terminal, type, {
          brand: res.brand || posBrand,
          authorizationCode: res.authorizationCode || res.auth || "",
          nsu: res.nsu || res.NSU || "",
          installments: res.installments || 1,
          simulated: false
        }));
      })
      .catch(err=>{ if(posCtx) reject(err); });
    });
  }
  function pollTef(base, id, onStatus, startedAt){
    return new Promise((resolve, reject)=>{
      const tick = ()=>{
        if(!posCtx) return reject(new Error("cancelado"));
        if(Date.now() - startedAt > 60000){ reject(new Error("Tempo esgotado aguardando a maquininha (60s).")); return; }
        fetch(base + "/status?id=" + encodeURIComponent(id))
          .then(r=> r.json())
          .then(res=>{
            if(res && res.status === "approved") return resolve(res);
            if(res && (res.status === "declined" || res.status === "error")) return reject(new Error(res.message || "Transação não aprovada."));
            onStatus("waiting");
            posCtx.timers.push(setTimeout(tick, 1500));
          })
          .catch(()=>{ onStatus("waiting"); posCtx.timers.push(setTimeout(tick, 1500)); });
      };
      tick();
    });
  }

  // SDK nativo no SmartPOS: window.POSBridge.charge(...)
  function posRunSdk(amount, type, terminal, onStatus){
    return new Promise((resolve, reject)=>{
      const bridge = window.POSBridge;
      if(!bridge || typeof bridge.charge !== "function"){
        reject(new Error("SDK do terminal não detectado: não existe window.POSBridge nesta página. Em um SmartPOS " +
          "(Stone SmartPOS / PagBank Moderninha / Cielo Lio) o app precisa rodar dentro do invólucro nativo do fabricante."));
        return;
      }
      onStatus("connecting");
      try{
        const p = bridge.charge({ amount: amount, type: type, installments: 1, terminal: terminal.model },
          (s)=> posStatus(s));
        Promise.resolve(p).then(res=>{
          if(!posCtx) return;
          res = res || {};
          resolve(makeCard(terminal, type, {
            brand: res.brand || posBrand,
            authorizationCode: res.authorizationCode || res.auth || "",
            nsu: res.nsu || "",
            installments: res.installments || 1,
            simulated: false
          }));
        }).catch(err=> reject(err instanceof Error ? err : new Error((err && err.message) || String(err))));
      }catch(e){ reject(e); }
    });
  }

  /* ---------- Cadastro de maquininhas ---------- */
  let editingTerminalId = null;
  function renderTerminalList(){
    const box = $("#terminalList");
    if(!box) return;
    const list = state.terminals || [];
    if(!list.length){
      box.innerHTML = '<div class="hint" style="margin:0 0 8px">Nenhuma maquininha cadastrada.</div>';
      return;
    }
    box.innerHTML = '<div style="margin-bottom:10px">' + list.map(t=>
      '<div class="term-row"><span class="ic">💳</span><div class="tx"><b>'+esc(t.label)+'</b>'+
        '<small>'+esc(posModelName(t.model))+' · '+esc(modeLabel(t.mode))+
        (state.settings.defaultTerminalId === t.id ? ' · <b>padrão</b>' : '')+
        (t.active === false ? ' · <b>inativa</b>' : '')+'</small></div>'+
        '<button class="btn sm" data-tedit="'+esc(t.id)+'">Editar</button></div>'
    ).join("") + '</div>';
    $$("#terminalList [data-tedit]").forEach(b=> b.addEventListener("click", ()=> openTerminalModal(b.dataset.tedit)));
  }

  function openTerminalModal(id){
    editingTerminalId = id || null;
    const t = id ? terminalById(id) : null;
    $("#terminalModalTitle").textContent = t ? "Editar maquininha" : "Nova maquininha";
    $("#tModel").innerHTML = Object.keys(POS_MODELS).map(k=>
      '<option value="'+k+'">'+esc(POS_MODELS[k].name)+'</option>').join("");
    $("#tLabel").value = t ? t.label : "";
    $("#tModel").value = t ? t.model : "stone";
    $("#tMode").value = t ? t.mode : "sim";
    $("#tEndpoint").value = t ? (t.endpoint || "") : "http://127.0.0.1:8787";
    $("#tActive").checked = t ? t.active !== false : true;
    $("#tDefault").checked = t ? state.settings.defaultTerminalId === t.id : (state.terminals || []).length === 0;
    $("#btnDeleteTerminal").hidden = !t;
    updateTerminalMode();
    openModal("terminal");
    setTimeout(()=> $("#tLabel").focus(), 120);
  }
  function updateTerminalMode(){
    const mode = $("#tMode").value;
    $("#tEndpointField").hidden = (mode !== "tef");
    $("#tModeHint").textContent = mode === "sdk"
      ? "O app roda dentro do invólucro nativo do terminal, que expõe window.POSBridge.charge({amount, type, installments})."
      : mode === "tef"
      ? "Um agente local no computador do caixa recebe a cobrança e conversa com a maquininha."
      : "Demonstração: simula conexão, cartão e aprovação. Nenhuma transação real é processada.";
  }
  $("#tMode").addEventListener("change", updateTerminalMode);
  $("#btnNewTerminal").addEventListener("click", ()=> openTerminalModal(null));
  $("#btnSaveTerminal").addEventListener("click", ()=>{
    const label = $("#tLabel").value.trim() || "Maquininha";
    const model = $("#tModel").value;
    const mode = $("#tMode").value;
    const endpoint = $("#tEndpoint").value.trim();
    const active = $("#tActive").checked;
    const isDefault = $("#tDefault").checked;
    if(mode === "tef" && !endpoint){ toast("Informe o endereço do bridge TEF."); return; }
    let id = editingTerminalId;
    if(id && terminalById(id)){
      Object.assign(terminalById(id), { label:label, model:model, mode:mode, endpoint:endpoint, active:active });
      toast("Maquininha atualizada.");
    }else{
      const nt = { id:uid(), label:label, model:model, mode:mode, endpoint:endpoint, active:active };
      state.terminals.push(nt);
      id = nt.id;
      toast("Maquininha cadastrada.");
    }
    if(isDefault && active) state.settings.defaultTerminalId = id;
    if(!active && state.settings.defaultTerminalId === id) state.settings.defaultTerminalId = null;
    save(); closeModals(); renderTerminalList();
  });
  $("#btnDeleteTerminal").addEventListener("click", ()=>{
    const t = terminalById(editingTerminalId); if(!t) return;
    if(!confirm('Excluir a maquininha "'+t.label+'"?')) return;
    state.terminals = (state.terminals || []).filter(x=> x.id !== t.id);
    if(state.settings.defaultTerminalId === t.id) state.settings.defaultTerminalId = null;
    save(); closeModals(); renderTerminalList();
    toast("Maquininha excluída.");
  });

  /* ============================================================
     RECIBO
     ============================================================ */
  function receiptHTML(c, opts){
    const o = opts || {};
    const multi = itemAuthors(c) > 1;   // só marca o autor quando há mais de um
    const temDespacho = c.items.some(function(i){ return dispatchedQtyOf(i) > 0; });
    const lines = c.items.map(i=>{
      const naoDespachado = temDespacho && dispatchedQtyOf(i) < i.qty;
      return '<div class="r-line"><span class="l">'+i.qty+'x '+esc(i.name)+
        (multi && authorShort(i) ? ' · '+esc(authorShort(i)) : '')+
        (naoDespachado ? ' <span class="r-flag">não despachado</span>' : '')+'</span><span>'+money(i.price*i.qty)+'</span></div>';
    }).join("");
    const pay = c.payment || {};
    return ''+
      '<div class="r-center"><h3>'+esc(state.settings.name||"Meu Restaurante")+'</h3>'+
      '<div class="small">Comprovante de consumo'+(c.seq?(" · Comanda #"+c.seq):"")+'</div></div>'+
      '<hr>'+
      '<div class="r-line"><span class="l">Mesa</span><span>'+c.table+'</span></div>'+
      '<div class="r-line"><span class="l">Garçom</span><span>'+esc(c.waiterName || waiterLabelOf(c.waiterId))+'</span></div>'+
      ((c.transfers && c.transfers.length)
        ? '<div class="r-line"><span class="l">Transferências de mesa</span><span>'+c.transfers.length+'</span></div>'+
          c.transfers.map(function(t){
            return '<div class="r-card">Mesa '+t.from+' → Mesa '+t.to+' às '+hm(t.at)+(t.byName ? ' por '+esc(t.byName) : '')+'</div>';
          }).join("")
        : '')+
      ((c.mergedFrom && c.mergedFrom.length)
        ? '<div class="r-line"><span class="l">Comandas anexadas</span><span>'+c.mergedFrom.length+'</span></div>'+
          c.mergedFrom.map(function(m){
            return '<div class="r-card">Mesa '+m.table+' (comanda #'+(m.seq || '—')+') · '+m.items+' itens · '+money(m.total)+' às '+hm(m.at)+'</div>';
          }).join("")
        : '')+
      '<div class="r-line"><span class="l">Abertura</span><span>'+dt(c.openedAt)+'</span></div>'+
      '<div class="r-line"><span class="l">Fechamento</span><span>'+dt(c.closedAt)+'</span></div>'+
      '<div class="r-items">'+lines+'</div>'+
      receiptsNotices(c)+
      '<hr>'+
      '<div class="r-line"><span class="l">Subtotal</span><span>'+money(c.subtotal)+'</span></div>'+
      (c.discount > 0
        ? '<div class="r-line"><span class="l">Desconto'+(c.discountInfo && c.discountInfo.type==="percent" ? " ("+c.discountInfo.value+"%)" : "")+'</span><span>- '+money(c.discount)+'</span></div>'+
          (c.discountAuth
            ? '<div class="r-card">Autorizado por '+esc(c.discountAuth.byName)+' às '+hm(c.discountAuth.at)+'</div>'
            : '')
        : '')+
      ((c.serviceFee && c.serviceFee.on && c.serviceFee.amount > 0)
        ? '<div class="r-line"><span class="l">Taxa de serviço ('+c.serviceFee.pct+'%)</span><span>+ '+money(c.serviceFee.amount)+'</span></div>'
        : '')+
      '<div class="r-total"><span>TOTAL</span><span>'+money(c.total)+'</span></div>'+
      '<hr>'+
      (c.payments && c.payments.length
        ? '<div class="r-line"><span class="l"><b>Pagamentos</b></span><span>'+c.payments.length+'</span></div>'+
          c.payments.map(p=> '<div class="r-line"><span class="l">'+hm(p.at)+' · '+esc(p.method)+
            (p.label ? " · "+esc(p.label) : "")+'</span><span>'+money(p.amount)+'</span></div>'+
            (p.card ? '<div class="r-card">'+esc(p.card.brand || "—")+
              ' · NSU '+esc(p.card.nsu || "—")+' · AUT '+esc(p.card.authorizationCode || "—")+
              (p.card.installments > 1 ? " · " + p.card.installments + "x" : "")+
              '<br>'+esc(p.card.terminalLabel || "—")+
              (p.card.simulated ? ' <span class="r-sim">SIMULADO</span>' : '')+
              (p.card.manual ? ' <span class="r-sim" style="color:#475569;background:#f1f5f9">MANUAL</span>' : '')+'</div>'
            : "")).join("")+
          '<div class="r-total" style="font-size:13px"><span>PAGO</span><span>'+
            money(typeof c.paidTotal === "number" ? c.paidTotal : c.total)+'</span></div>'+
          (pay.change > 0 ? '<div class="r-line"><span class="l">Troco</span><span>'+money(pay.change)+'</span></div>' : '')
        : '<div class="r-line"><span class="l">Pagamento</span><span>'+esc(pay.method||"-")+'</span></div>'+
          (pay.method==="Dinheiro" && pay.received!=null
            ? '<div class="r-line"><span class="l">Recebido</span><span>'+money(pay.received)+'</span></div>'+
              '<div class="r-line"><span class="l">Troco</span><span>'+money(pay.change||0)+'</span></div>'
            : ''))+
      '<hr>'+
      '<div class="r-center small">'+esc(o.thanks || "Obrigado pela preferência!")+'</div>';
  }

  // Avisos da mesa no comprovante / detalhe: quem chamou, horário e tempo até ser atendido
  function receiptsNotices(c){
    const avisos = noticesOfComanda(c);
    if(!avisos.length) return "";
    const linhas = avisos.map(function(n){
      const at = noticeAttended(n);
      const para = n.toId ? ((state.waiters || []).find(function(w){ return w.id === n.toId; }) || {}).name : null;
      return '<div class="r-line"><span class="l">'+hm(n.at)+' · '+esc(n.fromName)+
          (para ? " → " + esc(para) : " → Todos")+'</span><span>'+
          (at ? fmtWait(n.at, at.at) : "sem resposta")+'</span></div>'+
        '<div class="r-card">'+
          (n.text ? esc(n.text) : "Chamou na mesa")+
          (at ? ' · atendido às '+hm(at.at)+(at.byName ? " por "+esc(at.byName) : "") : " · não atendido")+
        '</div>';
    }).join("");
    return '<hr>'+
      '<div class="r-line"><span class="l"><b>Avisos desta mesa</b></span><span>'+avisos.length+'</span></div>'+
      linhas;
  }

  function showReceipt(c, justClosed){
    $("#receiptTitle").textContent = justClosed ? "Comanda encerrada 🎉" : "Detalhes da comanda";
    $("#receiptSub").textContent = "Mesa " + c.table + " · " + (c.waiterName || waiterLabelOf(c.waiterId)) + " · " + dt(c.closedAt);
    $("#receiptContent").innerHTML = receiptHTML(c);
    $("#btnPrintReceipt").dataset.cid = c.id;
    openModal("receipt");
  }

  $("#btnPrintReceipt").addEventListener("click", ()=>{
    const cid = $("#btnPrintReceipt").dataset.cid;
    const c = comandaById(cid);
    if(!c) return;
    const area = $("#printArea");
    area.innerHTML = '<div class="receipt">' + receiptHTML(c) + '</div>';
    window.print();
    setTimeout(()=>{ area.innerHTML = ""; }, 500);
  });

  /* ============================================================
     BUSCA DE PRODUTOS (compartilhada pelo catálogo e pela comanda)
     ============================================================ */
  // Sem acento e sem caixa: "agua" encontra "Água", "file" encontra "Filé"
  function foldText(s){
    return String(s == null ? "" : s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  }
  // "cerveja 600" e "600 cerveja" funcionam: todos os termos, em qualquer ordem
  function searchTerms(q){ return foldText(q).split(/\s+/).filter(function(t){ return t.length > 0; }); }
  function matchProduct(p, terms){
    if(!terms.length) return true;
    const alvo = foldText([p.name, p.category, p.code].join(" \u0000 "));
    return terms.every(function(t){ return alvo.indexOf(t) >= 0; });
  }
  // Mapa de índices para destacar o trecho encontrado mesmo com acento
  function normInfo(s){
    let norm = "";
    const map = [];
    for(let i=0; i<s.length; i++){
      const base = foldText(s[i]);
      for(let k=0; k<base.length; k++){ norm += base[k]; map.push(i); }
    }
    return { norm:norm, map:map };
  }
  function highlightMatch(texto, terms){
    const s = String(texto == null ? "" : texto);
    if(!terms || !terms.length) return esc(s);
    const info = normInfo(s);
    const faixas = [];
    terms.forEach(function(t){
      let de = 0, idx;
      while((idx = info.norm.indexOf(t, de)) >= 0){
        const ini = info.map[idx], fim = info.map[idx + t.length - 1];
        if(ini != null && fim != null) faixas.push([ini, fim + 1]);
        de = idx + t.length;
        if(faixas.length > 24) break;
      }
    });
    if(!faixas.length) return esc(s);
    faixas.sort(function(a,b){ return a[0] - b[0]; });
    const juntas = [];
    faixas.forEach(function(f){
      const ult = juntas[juntas.length - 1];
      if(ult && f[0] <= ult[1]) ult[1] = Math.max(ult[1], f[1]);
      else juntas.push([f[0], f[1]]);
    });
    let saida = "", pos = 0;
    juntas.forEach(function(f){
      saida += esc(s.slice(pos, f[0])) + "<mark>" + esc(s.slice(f[0], f[1])) + "</mark>";
      pos = f[1];
    });
    saida += esc(s.slice(pos));
    return saida;
  }

  /* ============================================================
     PRODUTOS
     ============================================================ */
  let prodCatFilter = "";
  function renderProducts(){
    const term = $("#prodSearch").value.trim();
    const terms = searchTerms(term);
    const cats = Array.from(new Set(state.products.map(p=>p.category||"Sem categoria"))).sort((a,b)=>a.localeCompare(b));
    const chips = ["", ...cats];
    $("#prodChips").innerHTML = chips.map(c=>
      '<button class="chip'+(prodCatFilter===c?" active":"")+'" data-cat="'+esc(c)+'">'+ (c? esc(c) : "Todas") +'</button>'
    ).join("");
    $$("#prodChips .chip").forEach(b=> b.addEventListener("click", ()=>{ prodCatFilter = b.dataset.cat; renderProducts(); }));

    const list = state.products.filter(p=>{
      const okCat = !prodCatFilter || (p.category||"Sem categoria")===prodCatFilter;
      return okCat && matchProduct(p, terms);
    }).sort((a,b)=> ((b.active !== false) - (a.active !== false)) ||
                    (a.category||"").localeCompare(b.category||"") || a.name.localeCompare(b.name));

    const contador = $("#prodCount");
    if(contador){
      contador.textContent = list.length
        ? (list.length === 1 ? "1 produto" : list.length + " produtos") +
          (terms.length ? " para \u201c" + term + "\u201d" : "") +
          (prodCatFilter ? " em " + prodCatFilter : "")
        : "";
    }

    const canProd = canManageProducts();
    const canTog = canToggleProducts();
    const grid = $("#gridProducts");
    if(!list.length){
      grid.innerHTML = '<div class="empty card" style="grid-column:1/-1"><div class="big">🔍</div>'+
        '<h3>Nenhum produto encontrado</h3><p>'+
        (term ? 'Nada corresponde a \u201c'+esc(term)+'\u201d. ' : 'Ajuste a busca ou os filtros. ') +
        (canProd ? "Você pode cadastrar um novo produto." : "") + '</p></div>';
    }else{
      grid.innerHTML = list.map(p=>{
        const inativo = p.active === false;
        return '<div class="card prod-card'+(inativo ? " inactive" : "")+'">'+
          '<div class="top"><div><h4>'+highlightMatch(p.name, terms)+(inativo ? ' <span class="prod-tag">Inativo</span>' : '')+'</h4>'+
          '<div class="cat">'+esc(p.category||"Sem categoria")+'</div></div>'+
          '<div class="price">'+money(p.price)+'</div></div>'+
          ((canProd || canTog)
            ? '<div class="prod-actions">'+
                (canProd ? '<button class="btn sm" data-edit="'+esc(p.id)+'">Editar</button>' : '')+
                (canTog ? '<button class="btn sm" data-toggle="'+esc(p.id)+'">'+(inativo ? "Ativar" : "Desativar")+'</button>' : '')+
                (canProd ? '<button class="btn sm danger" data-remove="'+esc(p.id)+'">Excluir</button>' : '')+
              '</div>'
            : '')+
        '</div>';
      }).join("");
      $$("#gridProducts [data-edit]").forEach(b=> b.addEventListener("click", ()=> openProductModal(b.dataset.edit)));
      $$("#gridProducts [data-remove]").forEach(b=> b.addEventListener("click", ()=> removeProduct(b.dataset.remove)));
      $$("#gridProducts [data-toggle]").forEach(b=> b.addEventListener("click", ()=> toggleProduct(b.dataset.toggle)));
    }
    const dl = $("#catList");
    dl.innerHTML = cats.map(c=>'<option value="'+esc(c)+'"></option>').join("");
    const dlSetor = $("#sectorList");
    if(dlSetor) dlSetor.innerHTML = sectorsList().map(function(s){ return '<option value="'+esc(s)+'"></option>'; }).join("");
  }

  let editingProductId = null;
  function openProductModal(id){
    if(!canManageProducts()){ toast("Seu perfil não permite alterar o catálogo."); return; }
    editingProductId = id || null;
    const p = id ? state.products.find(x=>x.id===id) : null;
    $("#productModalTitle").textContent = p ? "Editar produto" : "Novo produto";
    $("#pName").value = p ? p.name : "";
    $("#pPrice").value = p ? p.price : "";
    $("#pCat").value = p ? (p.category||"") : "";
    $("#pSector").value = p ? productSector(p) : (sectorsList()[0] || "Cozinha");
    $("#sectorList").innerHTML = sectorsList().map(function(s){ return '<option value="'+esc(s)+'"></option>'; }).join("");
    const canTog = canToggleProducts();
    $("#pActiveWrap").hidden = !canTog;
    $("#pActive").checked = p ? (p.active !== false) : true;
    $("#btnDeleteProduct").hidden = !p;
    renderProducts();
    openModal("product");
    setTimeout(()=> $("#pName").focus(), 120);
  }

  function toggleProduct(id){
    if(!canToggleProducts()){ toast("Seu perfil não permite ativar/desativar produtos."); return; }
    const p = state.products.find(x=> x.id === id);
    if(!p) return;
    despachar("salvarProduto", {
      produtoId: p.id, nome: p.name, preco: p.price, categoria: p.category,
      setor: p.sector, ativo: (p.active === false),
    });
    renderProducts();
    toast('Produto "' + p.name + '" ' + (p.active === false ? "ativado." : "desativado."));
  }
  $("#btnNewProduct").addEventListener("click", ()=> openProductModal(null));

  $("#btnSaveProduct").addEventListener("click", ()=>{
    if(!canManageProducts()){ toast("Seu perfil não permite alterar o catálogo."); return; }
    const name = $("#pName").value.trim();
    const price = Number($("#pPrice").value);
    const cat = $("#pCat").value.trim() || "Sem categoria";
    if(!name){ toast("Informe o nome do produto."); return; }
    if(!isFinite(price) || price < 0){ toast("Informe um preço válido."); return; }
    despachar("salvarProduto", {
      produtoId: editingProductId || uid(),
      nome: name, preco: Math.round(price*100)/100, categoria: cat,
      setor: $("#pSector").value.trim() || sectorByCategory(cat),
      ativo: canToggleProducts() ? $("#pActive").checked : true,
    });
    closeModals(); renderProducts();
    toast(editingProductId ? "Produto atualizado." : "Produto cadastrado.");
  });

  $("#btnDeleteProduct").addEventListener("click", ()=>{
    if(editingProductId) removeProduct(editingProductId);
  });

  function removeProduct(id){
    if(!canManageProducts()){ toast("Seu perfil não permite excluir produtos."); return; }
    const p = state.products.find(x=>x.id===id);
    if(!p) return;
    if(!confirm('Excluir o produto "'+p.name+'"? Comandas já abertas não serão alteradas.')) return;
    // o item da comanda guarda nome e preço: excluir o produto não reescreve histórico
    despachar("removerProduto", { produtoId: id });
    closeModals(); renderProducts();
    toast("Produto excluído.");
  }

  /* ============================================================
     HISTÓRICO
     ============================================================ */
  let histRange = "today";
  let histWaiter = "";
  function rangeStart(){
    const now = new Date();
    if(histRange==="today") return startOfDay(now).getTime();
    if(histRange==="7")  return startOfDay(new Date(now.getTime() - 6*86400000)).getTime();
    if(histRange==="30") return startOfDay(new Date(now.getTime() - 29*86400000)).getTime();
    return 0;
  }
  function renderWaiterFilter(all){
    const sel = $("#histWaiterFilter");
    const opts = ['<option value="">Todos os garçons</option>']
      .concat(activeWaiters().map(w=>'<option value="'+esc(w.id)+'">'+esc(w.name)+'</option>'))
      .concat(state.waiters.filter(w=>w.active===false).map(w=>'<option value="'+esc(w.id)+'">'+esc(w.name)+' (inativo)</option>'))
      .concat(all.some(c=>!c.waiterId) ? ['<option value="__none__">Sem garçom</option>'] : []);
    sel.innerHTML = opts.join("");
    sel.value = histWaiter;
    if(sel.value !== histWaiter){ sel.value = ""; histWaiter = ""; }
  }

  function renderHistory(){
    $$("#view-historico .chip").forEach(b=> b.classList.toggle("active", b.dataset.range===histRange));
    const from = rangeStart();
    const all = state.comandas
      .filter(c=> c.status==="closed" && new Date(c.closedAt).getTime() >= from);
    renderWaiterFilter(all);

    const list = all
      .filter(c=> !histWaiter || (histWaiter==="__none__" ? !c.waiterId : c.waiterId===histWaiter))
      .sort((a,b)=> new Date(b.closedAt) - new Date(a.closedAt));

    const sold = list.reduce((s,c)=> s + c.total, 0);
    const disc = list.reduce((s,c)=> s + (c.discount||0), 0);
    $("#histCount").textContent = list.length;
    $("#histTotal").textContent = money(sold);
    $("#histDisc").textContent = money(disc);
    $("#histAvg").textContent = money(list.length ? sold/list.length : 0);

    renderWaiterSummary(list);

    const box = $("#histList");
    if(!list.length){
      box.innerHTML = '<div class="empty card"><div class="big">📋</div><h3>Sem comandas encerradas</h3>'+
        '<p>Ajuste o período ou o garçom selecionado.</p></div>';
      return;
    }
    box.innerHTML = list.map(c=>
      '<div class="card hist-item" data-open="'+esc(c.id)+'">'+
        '<div class="hist-id">#'+(c.seq||"—")+'</div>'+
        '<div class="hist-main"><h4>Mesa '+c.table+'</h4>'+
          '<p>'+dt(c.closedAt)+' · '+c.items.reduce((s,i)=>s+i.qty,0)+' itens · '+
          esc(methodLabelOf(c))+
          (c.discount>0 ? ' · desconto '+money(c.discount) : '')+
        '</p>'+
        '<p class="hist-waiter">👤 '+esc(c.waiterName || waiterLabelOf(c.waiterId))+'</p>'+
        (function(){
          const av = noticesOfComanda(c);
          if(!av.length) return "";
          const semResposta = av.filter(function(n){ return !noticeAttended(n); }).length;
          return '<p class="hist-notice">🔔 ' + av.length + (av.length === 1 ? " aviso" : " avisos") +
            (semResposta ? " · " + semResposta + " sem resposta" : " · todos atendidos") + '</p>';
        })()+
        '</div>'+
        '<div class="hist-val"><div class="v">'+money(c.total)+'</div>'+
        '<div class="m">'+(c.openedAt? hm(c.openedAt)+" → "+hm(c.closedAt) : "")+'</div></div>'+
      '</div>'
    ).join("");
    $$("#histList .hist-item").forEach(el=> el.addEventListener("click", ()=>{
      const c = comandaById(el.dataset.open);
      if(c) showReceipt(c, false);
    }));
  }

  function renderWaiterSummary(list){
    const box = $("#waiterSummary");
    const byW = {};
    list.forEach(c=>{
      const key = c.waiterId || "__none__";
      if(!byW[key]) byW[key] = { name: c.waiterName || waiterLabelOf(c.waiterId), n:0, total:0 };
      byW[key].n += 1;
      byW[key].total += c.total;
    });
    const rows = Object.keys(byW).map(k=>byW[k]).sort((a,b)=> b.total - a.total);
    if(!rows.length){ box.innerHTML = ""; return; }
    box.innerHTML = '<div class="card wsum">'+
      '<div class="wsum-head"><h3>Vendas por garçom</h3><p>'+
        rows.length + (rows.length===1 ? " garçom" : " garçons") + ' no período filtrado</p></div>'+
      rows.map(r=> '<div class="wrow">'+
        '<span class="ic">'+esc(initials(r.name))+'</span>'+
        '<span class="nm">'+esc(r.name)+'</span>'+
        '<span class="n">'+r.n+' comanda'+(r.n===1?"":"s")+' · ticket '+money(r.total/r.n)+'</span>'+
        '<span class="v">'+money(r.total)+'</span>'+
      '</div>').join("")+
    '</div>';
  }

  $$("#view-historico .chip").forEach(b=>{
    b.addEventListener("click", ()=>{ histRange = b.dataset.range; renderHistory(); });
  });
  $("#histWaiterFilter").addEventListener("change", e=>{
    histWaiter = e.target.value;
    renderHistory();
  });

  /* ============================================================
     PAGAMENTOS PARCIAIS / DIVISÃO DA CONTA
     ============================================================ */
  let splitMode = "pessoa";
  let splitMethod = "Dinheiro";
  let splitBase = 0;
  let splitN = 2;
  let splitSel = {};

  /**
   * Pagamento: o valor é LIMITADO pelo domínio (nunca cobra além do que falta)
   * e o recibo (NSU, autorização, bandeira) viaja junto com a mutação.
   */
  function addPayment(c, amount, method, extra){
    const e = extra || {};
    const antes = paidTotal(c);
    const r = despachar("pagar", {
      comandaId: c.id, amount: amount, method: method,
      paymentId: uid(), mode: e.mode || "final", label: e.label || "",
      card: e.card || null,
    });
    if(!r || r.ok === false) return false;
    const depois = comandaById(c.id);
    return !depois || paidTotal(depois) > antes;
  }

  function removePayment(id){
    const c = getActive(); if(!c) return;
    // Quem estorna e o registro do estorno ficam no servidor (trilha de auditoria).
    despachar("estornarPagamento", { comandaId: c.id, paymentId: id });
    renderSplit(); renderComanda(); renderTables();
    toast("Pagamento removido.");
  }

  function openSplit(){
    const c = getActive(); if(!c) return;
    const people = paymentsOf(c).filter(p=> p.mode === "pessoa");
    const last = people[people.length-1];
    splitN = last ? last.of : 2;
    splitBase = totalOf(c);
    splitMode = "pessoa";
    splitMethod = "Dinheiro";
    splitSel = {};
    $("#splitN").value = splitN;
    $$("#splitMethods .pay").forEach(b=> b.classList.toggle("active", b.dataset.method === "Dinheiro"));
    setSplitMode("pessoa");
    renderSplit();
    openModal("split");
  }

  function setSplitMode(m){
    splitMode = m;
    $$("#modalSplit .split-tabs .chip").forEach(b=> b.classList.toggle("active", b.dataset.split === m));
    $("#splitPessoa").hidden = m !== "pessoa";
    $("#splitItem").hidden = m !== "item";
  }

  function renderSplit(){
    const c = getActive();
    if(!c){ closeModals(); return; }
    const rem = remainingOf(c);
    $("#splitSub").textContent = "Mesa " + c.table + " · Total " + money(totalOf(c)) + " · Falta " + money(rem);
    $("#splitPaid").textContent = money(paidTotal(c));
    $("#splitRemain").textContent = money(rem);
    $("#splitPayRest").disabled = rem <= 0;
    renderSplitPeople(c, rem);
    renderSplitItems(c, rem);
    renderPayList(c);
    updateSplitPrimary(c);
  }

  function splitEmpty(html, title, msg){
    return '<div class="empty" style="padding:18px 8px"><div class="big">'+html+'</div><h3>'+title+'</h3><p>'+msg+'</p></div>';
  }

  function renderSplitPeople(c, rem){
    const box = $("#splitPeople");
    if(rem <= 0){
      box.innerHTML = splitEmpty("✅", "Conta totalmente paga", "Feche a comanda para liberar a mesa.");
      $("#splitPer").value = money(0);
      return;
    }
    const n = splitN;
    const gPaid = personGroupPaid(c, n);
    const rest = Math.max(0, Math.round((splitBase - gPaid)*100)/100);
    const unpaid = [];
    for(let i=1;i<=n;i++) if(!isPersonPaid(c, i, n)) unpaid.push(i);

    const amounts = {};
    let acc = 0;
    const base = rest > 0 ? rest : rem;
    const per = unpaid.length ? Math.floor((base/unpaid.length)*100)/100 : 0;
    unpaid.forEach((i,k)=>{
      if(k === unpaid.length-1) amounts[i] = Math.round((base - acc)*100)/100;
      else { amounts[i] = per; acc = Math.round((acc + per)*100)/100; }
    });
    $("#splitPer").value = unpaid.length ? money(per) : money(0);

    box.innerHTML = Array.from({length:n}, (_,k)=>{
      const i = k+1;
      if(isPersonPaid(c, i, n)){
        return '<div class="prow done"><span class="pn">Pessoa '+i+'/'+n+'</span><span class="ok">✓ Pago</span></div>';
      }
      return '<div class="prow"><span class="pn">Pessoa '+i+'/'+n+'</span>'+
        '<span class="pv">'+money(amounts[i]||0)+'</span>'+
        '<button class="btn sm primary" data-pessoa="'+i+'">Receber</button></div>';
    }).join("");

    $$("#splitPeople [data-pessoa]").forEach(b=> b.addEventListener("click", ()=>{
      const i = Number(b.dataset.pessoa);
      const amt = amounts[i] || 0;
      chargeAndPay(c, amt, { mode:"pessoa", person:i, of:n, label:"Pessoa "+i+"/"+n }, "Pessoa " + i + "/" + n);
    }));
  }

  function splitSelectedAmount(c){
    const f = discFactor(c);
    return Math.round(c.items.reduce((s,it)=> s + it.price*(splitSel[itemKey(it)]||0)*f, 0)*100)/100;
  }

  function renderSplitItems(c, rem){
    const box = $("#splitItems");
    if(rem <= 0){
      box.innerHTML = splitEmpty("✅", "Conta totalmente paga", "Feche a comanda para liberar a mesa.");
      return;
    }
    if(!c.items.length){
      box.innerHTML = splitEmpty("🧾", "Comanda sem itens", "Adicione itens para dividir por item.");
      return;
    }
    const rows = c.items.map(it=>{
      const k = itemKey(it);
      const paidQ = paidQtyOf(c, k);
      const remQ = Math.max(0, it.qty - paidQ);
      if(splitSel[k] == null) splitSel[k] = 0;
      else if(splitSel[k] > remQ) splitSel[k] = remQ;
      return { it:it, key:k, paidQ:paidQ, remQ:remQ };
    });
    if(!rows.some(r=> r.remQ > 0)){
      box.innerHTML = splitEmpty("✅", "Todos os itens já foram pagos", "Use \"Pagar restante\" ou encerre a comanda.");
      return;
    }
    box.innerHTML = rows.map(r=>{
      const q = splitSel[r.key] || 0;
      const autor = authorShort(r.it);
      if(r.remQ <= 0){
        return '<div class="sitem paid"><span class="ok" style="min-width:18px">✓</span>'+
          '<div class="sn" style="flex:1;min-width:0">'+esc(r.it.name)+(autor ? ' <span class="who">'+esc(autor)+'</span>' : '')+
          '<div class="su">'+r.it.qty+' un · totalmente pago</div></div></div>';
      }
      return '<div class="sitem">'+
        '<input type="checkbox" data-check="'+esc(r.key)+'"'+(q > 0 ? " checked" : "")+'>'+
        '<div class="sn" style="flex:1;min-width:0">'+esc(r.it.name)+(autor ? ' <span class="who">'+esc(autor)+'</span>' : '')+
          '<div class="su">'+money(r.it.price)+' / un · restam '+r.remQ+' de '+r.it.qty+
            (r.paidQ ? " · "+r.paidQ+" já pago" : "")+'</div></div>'+
        '<div class="qty"><button data-q="-1" data-pid="'+esc(r.key)+'">−</button>'+
          '<span class="q">'+q+'</span>'+
          '<button data-q="1" data-pid="'+esc(r.key)+'">+</button></div></div>';
    }).join("");

    $$("#splitItems [data-check]").forEach(el=> el.addEventListener("change", ()=>{
      const k = el.dataset.check;
      const it = c.items.find(i=> itemKey(i) === k);
      if(!it) return;
      splitSel[k] = el.checked ? Math.max(0, it.qty - paidQtyOf(c, k)) : 0;
      renderSplit();
    }));
    $$("#splitItems [data-q]").forEach(b=> b.addEventListener("click", ()=>{
      const k = b.dataset.pid;
      const it = c.items.find(i=> itemKey(i) === k);
      if(!it) return;
      const max = Math.max(0, it.qty - paidQtyOf(c, k));
      splitSel[k] = Math.min(max, Math.max(0, (splitSel[k]||0) + Number(b.dataset.q)));
      renderSplit();
    }));
  }

  // Cobra no POS quando a forma é cartão; caso contrário registra direto.
  function chargeAndPay(c, amount, extra, okLabel, afterPaid){
    const settle = (card)=>{
      const ex = Object.assign({}, extra || {});
      if(card) ex.card = card;
      const antes = remainingOf(c);
      if(!addPayment(c, amount, splitMethod, ex)) return;
      if(afterPaid) afterPaid();
      renderSplit(); renderComanda(); renderTables();
      toast("Recebido " + money(Math.min(amount, antes)) + (okLabel ? " · " + okLabel : ""));
    };
    const isCard = (splitMethod === "Crédito" || splitMethod === "Débito");
    const term = activeTerminal();
    if(isCard && term){
      openPos(amount, splitMethod, term, settle, { returnTo:"split" });
      return;
    }
    if(isCard && !term) toast("Sem maquininha ativa: pagamento registrado sem comprovante de POS.");
    settle(null);
  }

  function updateSplitPrimary(c){
    const btn = $("#splitPaySel");
    if(splitMode !== "item"){ btn.hidden = true; return; }
    btn.hidden = false;
    const amt = splitSelectedAmount(c);
    const n = c.items.filter(it=> (splitSel[itemKey(it)]||0) > 0).length;
    btn.disabled = n === 0;
    btn.textContent = n ? ("Receber " + n + (n===1?" item":" itens") + " · " + money(amt)) : "Selecione os itens";
  }

  function renderPayList(c){
    const box = $("#splitHistory");
    const pays = paymentsOf(c).slice().reverse();
    if(!pays.length){
      box.innerHTML = '<div style="font-size:12.5px; color:var(--muted); text-align:center">Nenhum pagamento registrado ainda.</div>';
      return;
    }
    box.innerHTML = '<div style="font-size:12px; color:var(--muted); font-weight:700; margin-bottom:6px">PAGAMENTOS REGISTRADOS</div>'+
      '<div class="pay-list">' + pays.map(p=>
        '<div class="pay-item"><span class="pm">'+hm(p.at)+' · '+esc(p.method)+
          (p.label ? " · "+esc(p.label) : "")+'</span>'+
        '<span class="pa">'+money(p.amount)+'</span>'+
        '<button class="undo" data-undo="'+esc(p.id)+'" title="Desfazer este pagamento">✕</button></div>'
      ).join("") + '</div>';
    $$("#splitHistory [data-undo]").forEach(b=> b.addEventListener("click", ()=> removePayment(b.dataset.undo)));
  }

  $("#btnSplit").addEventListener("click", openSplit);
  $$("#modalSplit .split-tabs .chip").forEach(b=> b.addEventListener("click", ()=> setSplitMode(b.dataset.split)));
  $$("#splitMethods .pay").forEach(b=> b.addEventListener("click", ()=>{
    splitMethod = b.dataset.method;
    $$("#splitMethods .pay").forEach(x=> x.classList.toggle("active", x === b));
  }));
  $("#splitN").addEventListener("change", e=>{
    let n = parseInt(e.target.value, 10);
    if(!isFinite(n) || n < 2) n = 2;
    if(n > 30) n = 30;
    splitN = n;
    e.target.value = n;
    renderSplit();
  });
  $("#splitPayRest").addEventListener("click", ()=>{
    const c = getActive(); if(!c) return;
    const rem = remainingOf(c);
    if(rem <= 0) return;
    chargeAndPay(c, rem, { mode:"resto", label:"Restante" }, "Restante");
  });
  $("#splitPaySel").addEventListener("click", ()=>{
    const c = getActive(); if(!c) return;
    const f = discFactor(c);
    let gross = 0;
    const items = [], labels = [];
    c.items.forEach(it=>{
      const q = splitSel[itemKey(it)] || 0;
      if(q > 0){
        gross += it.price*q*f;
        items.push({ iid: itemKey(it), pid:it.pid, qty:q, name:it.name });
        labels.push(q + "x " + it.name);
      }
    });
    const amount = Math.round(gross*100)/100;
    if(amount <= 0){ toast("Selecione ao menos um item."); return; }
    chargeAndPay(c, amount, { mode:"item", items:items, label:labels.join(" + ").slice(0,90) }, "", ()=>{ splitSel = {}; });
  });

  /* ---------- Alerta sonoro e vibração ---------- */
  let audioCtx = null;
  function ensureAudio(){
    if(audioCtx) return audioCtx;
    try{
      const AC = window.AudioContext || window.webkitAudioContext;
      if(!AC) return null;
      audioCtx = new AC();
    }catch(e){ audioCtx = null; }
    return audioCtx;
  }
  // Navegadores só liberam áudio após uma interação do usuário
  function unlockAudio(){
    const ac = ensureAudio();
    if(ac && ac.state === "suspended"){ try{ ac.resume(); }catch(e){} }
  }
  // Campainha curta de dois toques — gerada no navegador, sem arquivo externo
  function playAlertSound(){
    const ac = ensureAudio();
    if(!ac) return false;
    try{
      if(ac.state === "suspended"){ ac.resume(); }
      const t0 = ac.currentTime + 0.01;
      [[0, 880], [0.15, 1245]].forEach(function(par){
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.type = "sine";
        osc.frequency.value = par[1];
        gain.gain.setValueAtTime(0.0001, t0 + par[0]);
        gain.gain.exponentialRampToValueAtTime(0.30, t0 + par[0] + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + par[0] + 0.15);
        osc.connect(gain);
        gain.connect(ac.destination);
        osc.start(t0 + par[0]);
        osc.stop(t0 + par[0] + 0.17);
      });
      return true;
    }catch(e){ return false; }
  }
  function vibrateAlert(){
    try{
      if(navigator && typeof navigator.vibrate === "function") return navigator.vibrate([180, 90, 180]);
    }catch(e){}
    return false;
  }

  function alertEnabled(kind){
    return kind === "sound" ? state.settings.alertSound !== false : state.settings.alertVibrate !== false;
  }
  function renderAlertSettings(){
    const pares = [["#cAlertSound", "sound"], ["#alertSound", "sound"],
                   ["#cAlertVibrate", "vibrate"], ["#alertVibrate", "vibrate"]];
    pares.forEach(function(p){
      const el = $(p[0]);
      if(el) el.checked = alertEnabled(p[1]);
    });
  }
  function setAlert(kind, on){
    if(kind === "sound") state.settings.alertSound = on;
    else state.settings.alertVibrate = on;
    save();
    renderAlertSettings();
  }
  function testAlert(){
    unlockAudio();
    const som = playAlertSound();
    const vib = vibrateAlert();
    if(!som) toast("Este navegador bloqueou o áudio. Toque na tela e tente novamente.");
    else if(vib) toast("Som e vibração disparados.");
    else toast("Som disparado. Este dispositivo não tem vibração disponível.");
  }
  (function bindAlert(){
    [["#cAlertSound", "sound"], ["#alertSound", "sound"],
     ["#cAlertVibrate", "vibrate"], ["#alertVibrate", "vibrate"]].forEach(function(p){
      const el = $(p[0]);
      if(el) el.addEventListener("change", function(){ unlockAudio(); setAlert(p[1], el.checked); });
    });
    ["#btnTestAlert", "#btnTestAlert2"].forEach(function(sel){
      const el = $(sel);
      if(el) el.addEventListener("click", testAlert);
    });
    ["click", "keydown", "touchstart"].forEach(function(ev){
      document.addEventListener(ev, unlockAudio, { once:true, passive:true });
    });
    renderAlertSettings();
  })();

  /* ============================================================
     AVISOS ENTRE USUÁRIOS
     ------------------------------------------------------------
     Um botão na comanda envia um aviso (chamado direto ou recado
     escrito) para outro usuário. A entrega acontece neste navegador:
     na mesma aba, em outra aba aberta no mesmo navegador (evento
     "storage") e no próximo acesso de quem recebeu.
     ============================================================ */
  const NOTICE_PRESETS = [
    "Precisa de ajuda aqui",
    "Cliente pedindo a conta",
    "Trazer mais gelo",
    "Trocar o barril",
    "Verificar o caixa"
  ];

  function readerKey(){ const u = currentUser(); return u ? u.id : "__anon__"; }
  function isReadBy(n, key){ return (n.readBy || []).indexOf(key) >= 0; }
  function noticeTargetsMe(n){
    const u = currentUser();
    if(n.toId === null || n.toId === undefined) return true;   // aviso para todos
    return !!u && n.toId === u.id;
  }
  function pendingNotices(){
    const key = readerKey();
    return (state.notices || []).filter(n=> noticeTargetsMe(n) && !isReadBy(n, key));
  }

  function sendNotice(opts){
    const u = currentUser();
    const n = {
      id: uid(),
      at: new Date().toISOString(),
      fromId: u ? u.id : null,
      fromName: u ? u.name : "Operador",
      toId: opts.toId || null,
      table: opts.table || null,
      comandaId: opts.comandaId || null,
      comandaSeq: opts.seq || null,
      text: String(opts.text || "").trim().slice(0, 160),
      kind: opts.kind || (opts.text ? "texto" : "chamada"),
      readBy: u ? [u.id] : []          // quem envia não recebe o próprio aviso
    };
    return n;
  }

  // Grava quem atendeu e QUANDO atendeu (base do tempo de espera no histórico)
  function setNoticeRead(n, key){
    n.readBy = Array.isArray(n.readBy) ? n.readBy : [];
    n.readAt = (n.readAt && typeof n.readAt === "object") ? n.readAt : {};
    let mudou = false;
    if(n.readBy.indexOf(key) < 0){ n.readBy.push(key); mudou = true; }
    if(!n.readAt[key]){ n.readAt[key] = new Date().toISOString(); mudou = true; }
    return mudou;
  }

  function markNoticeRead(id){
    const n = (state.notices || []).find(x=> x.id === id);
    if(!n) return;
    if(alertWatch.id === id) stopAlertWatch();     // atendido: para de repetir
    despachar("lerAviso", { noticeId: id });
    renderNoticesBadge();
    renderNoticePopup();
  }

  // Primeira leitura que não seja de quem enviou = aviso atendido
  function noticeAttended(n){
    const rd = (n.readAt && typeof n.readAt === "object") ? n.readAt : {};
    const quem = Object.keys(rd).filter(function(k){ return k !== n.fromId; })
      .sort(function(a,b){ return new Date(rd[a]) - new Date(rd[b]); });
    if(!quem.length) return null;
    const id = quem[0];
    const u = (state.waiters || []).find(function(w){ return w.id === id; });
    return { at: rd[id], byId: id, byName: u ? u.name : (id === "__anon__" ? "Operador" : null) };
  }

  function fmtWait(deIso, ateIso){
    const ms = new Date(ateIso).getTime() - new Date(deIso).getTime();
    if(!isFinite(ms) || ms < 0) return "—";
    const s = Math.round(ms / 1000);
    if(s < 60) return s + "s";
    const m = Math.floor(s / 60), r = s % 60;
    return m + "min" + (r ? " " + r + "s" : "");
  }

  // Avisos ligados a uma comanda: usa a foto gravada no encerramento
  // ou, se ainda estiver aberta, busca pelo vínculo da comanda.
  function noticesOfComanda(c){
    if(!c) return [];
    if(Array.isArray(c.notices)){
      // A foto garante o registro, mas o atendimento pode acontecer depois do
      // encerramento — então completamos com os horários de leitura atuais.
      return c.notices.slice().sort(function(a,b){ return new Date(a.at) - new Date(b.at); }).map(function(n){
        const vivo = (state.notices || []).find(function(x){ return x.id === n.id; });
        if(!vivo || !vivo.readAt) return n;
        return Object.assign({}, n, {
          readAt: Object.assign({}, n.readAt || {}, vivo.readAt),
          readBy: Array.from(new Set((n.readBy || []).concat(vivo.readBy || [])))
        });
      });
    }
    return (state.notices || []).filter(function(n){
      if(n.comandaId) return n.comandaId === c.id;
      return n.table === c.table && (c.seq == null || n.comandaSeq == null || n.comandaSeq === c.seq);
    }).sort(function(a,b){ return new Date(a.at) - new Date(b.at); });
  }

  function renderNoticesBadge(){
    const b = $("#btnNotices");
    if(!b) return;
    const n = pendingNotices().length;
    b.innerHTML = "🔔" + (n ? '<span class="badge">' + n + '</span>' : "");
    b.classList.toggle("alerta", n > 0);
    b.title = n ? (n + (n === 1 ? " aviso pendente" : " avisos pendentes")) : "Avisos";
  }

  function renderNoticePopup(){
    const box = $("#noticePopup");
    if(!box) return;
    const list = pendingNotices().sort((a,b)=> new Date(a.at) - new Date(b.at));
    if(!list.length){ box.hidden = true; box.innerHTML = ""; return; }
    const n = list[0];
    const mesa = noticeTableNow(n);
    box.hidden = false;
    box.innerHTML =
      '<div class="np-head">🔔 <b>'+esc(n.fromName)+'</b>'+
        (mesa ? '<span class="np-table">Mesa '+mesa+'</span>' : '')+
        (list.length > 1 ? '<span class="np-count">1 de '+list.length+'</span>' : '')+'</div>'+
      '<div class="np-text'+(n.text ? "" : " np-call")+'">'+
        (n.text ? esc(n.text) : "Está chamando na mesa!")+'</div>'+
      (alertWatch.id === n.id && alertMaxRepeats() > 0
        ? '<div class="np-repeat">🔁 '+
            (alertWatch.repeats >= alertMaxRepeats()
              ? alertMaxRepeats() + (alertMaxRepeats() === 1 ? " repetição" : " repetições") + " sem confirmação"
              : "Repete a cada " + Math.round(alertRepeatSec()) + "s · " + alertWatch.repeats + "/" + alertMaxRepeats())+
          '</div>'
        : "")+
      '<div class="np-acts">'+
        (mesa ? '<button class="btn sm primary" data-np="go">Ir para a mesa</button>' : '')+
        '<button class="btn sm" data-np="ok">OK, entendido</button>'+
      '</div>';
    $$("#noticePopup [data-np]").forEach(b=> b.addEventListener("click", ()=>{
      markNoticeRead(n.id);
      if(b.dataset.np === "go") goToTable(noticeTableNow(n));
      renderNoticePopup();
    }));
  }

  /* ---------- Alerta com repetição até alguém atender ---------- */
  const ALERT_REPEAT_SEC = 30;      // padrão pedido: repete a cada 30s
  const ALERT_MAX_REPEATS = 3;      // padrão pedido: no máximo 3 repetições
  let alertWatch = { id:null, repeats:0, timer:null };

  function alertRepeatSec(){
    const s = Number(state.settings.alertRepeatSec);
    return (isFinite(s) && s > 0) ? s : ALERT_REPEAT_SEC;
  }
  function alertRepeatMs(){ return Math.max(20, alertRepeatSec() * 1000); }
  function alertMaxRepeats(){
    const n = Number(state.settings.alertMaxRepeats);
    if(!isFinite(n) || n < 0) return ALERT_MAX_REPEATS;
    return Math.min(10, Math.floor(n));
  }

  function fireAlert(){
    if(alertEnabled("sound")) playAlertSound();
    if(alertEnabled("vibrate")) vibrateAlert();
  }

  function stopAlertWatch(){
    if(alertWatch.timer) clearTimeout(alertWatch.timer);
    alertWatch = { id:null, repeats:0, timer:null };
  }

  // Reagenda enquanto o aviso continuar pendente, até o limite de repetições
  function scheduleAlertRepeat(){
    if(alertWatch.timer) clearTimeout(alertWatch.timer);
    alertWatch.timer = setTimeout(function(){
      alertWatch.timer = null;
      if(!alertWatch.id) return;
      const aindaPendente = pendingNotices().some(function(n){ return n.id === alertWatch.id; });
      if(!aindaPendente){ stopAlertWatch(); renderNoticePopup(); return; }
      if(alertWatch.repeats >= alertMaxRepeats()){ renderNoticePopup(); return; }
      alertWatch.repeats++;
      fireAlert();
      flashNoticePopup();
      renderNoticePopup();
      if(alertWatch.repeats < alertMaxRepeats()) scheduleAlertRepeat();
    }, alertRepeatMs());
  }

  function flashNoticePopup(){
    const box = $("#noticePopup");
    if(!box) return;
    box.classList.remove("repetindo");
    void box.offsetWidth;
    box.classList.add("repetindo");
    setTimeout(function(){ if(box) box.classList.remove("repetindo"); }, 1600);
  }

  // Roda a cada render (checkNotices), mas só toca quando algo muda:
  //  · aviso novo chegou            -> toca uma vez
  //  · o aviso exibido no painel    -> é quem fica repetindo até ser atendido
  let lastRingId = null;
  function alertForNewNotices(){
    const list = pendingNotices().sort((a,b)=> new Date(a.at) - new Date(b.at));
    if(!list.length){ if(alertWatch.id) stopAlertWatch(); return; }
    const maisNovo = list[list.length - 1];
    const naTela = list[0];                      // mesma escolha do painel (fila)

    if(maisNovo.id !== lastRingId){              // chegou aviso novo: toca
      lastRingId = maisNovo.id;
      fireAlert();
    }
    if(naTela.id !== alertWatch.id){             // passa a repetir o que está na tela
      stopAlertWatch();
      alertWatch.id = naTela.id;
      if(alertMaxRepeats() > 0) scheduleAlertRepeat();
    }
  }

  function checkNotices(){ alertForNewNotices(); renderNoticesBadge(); renderNoticePopup(); }

  // A mesa de um aviso pode ter mudado (transferência/junção): vale a comanda viva
  function noticeTableNow(n){
    if(n && n.comandaId){
      const c = comandaById(n.comandaId);
      if(c && c.status === "open") return c.table;
    }
    return n ? n.table : null;
  }

  function goToTable(t){
    const c = openByTable(t);
    if(c){ activeId = c.id; committedEdit = false; renderComanda(); openModal("comanda"); }
    else toast("A mesa " + t + " já está livre.");
  }

  function noticeRecipients(){
    const u = currentUser();
    return (state.waiters || []).filter(w=> w.active !== false && (!u || w.id !== u.id));
  }

  function openNoticeModal(table, seq){
    const u = currentUser();
    const others = noticeRecipients();
    $("#noticeSub").textContent = "Mesa " + table + (u ? " · enviando como " + u.name : "");
    $("#noticeTo").innerHTML = '<option value="">Todos os usuários</option>' +
      others.map(w=> '<option value="'+esc(w.id)+'">'+esc(w.name)+" · "+esc(roleLabel(w.role))+'</option>').join("");
    $("#noticeTo").value = others.length ? others[0].id : "";
    $("#noticeText").value = "";
    $("#btnSendCall").textContent = "🔔 Chamar na mesa " + table;
    $("#noticePresets").innerHTML = NOTICE_PRESETS.map(p=>
      '<button type="button" class="preset" data-preset="'+esc(p)+'">'+esc(p)+'</button>').join("");
    $$("#noticePresets .preset").forEach(b=> b.addEventListener("click", ()=>{
      const t = $("#noticeText");
      t.value = t.value.trim() ? (t.value.trim() + " — " + b.dataset.preset) : b.dataset.preset;
      t.focus();
    }));
    openModal("notice");
  }

  function sendNoticeAndClose(comTexto){
    const c = getActive();
    const table = (c ? c.table : window.__noticeTable) || null;
    const toId = $("#noticeTo").value || null;
    const txt = $("#noticeText").value.trim();
    if(comTexto && !txt){ toast("Escreva um recado ou use o chamado direto."); return; }
    const n = sendNotice({ toId: toId, table: table, seq: c ? c.seq : null, comandaId: c ? c.id : null,
                          text: comTexto ? txt : "", kind: comTexto ? "texto" : "chamada" });
    const dest = toId ? ((state.waiters || []).find(w=> w.id === toId) || {}).name : "todos os usuários";
    closeModals();
    checkNotices();
    toast((n.kind === "chamada" ? "Chamado enviado" : "Recado enviado") + " para " + dest + (table ? " · Mesa " + table : "") + ".");
  }

  $("#btnAvisar").addEventListener("click", ()=>{
    const c = getActive(); if(!c) return;
    openNoticeModal(c.table, c.seq);
  });
  $("#btnSendCall").addEventListener("click", ()=> sendNoticeAndClose(false));
  $("#btnSendText").addEventListener("click", ()=> sendNoticeAndClose(true));

  $("#btnNotices").addEventListener("click", ()=>{
    unlockAudio();
    renderAlertSettings();
    renderNoticeList();
    openModal("notices");
  });
  $("#btnReadAll").addEventListener("click", ()=>{
    const key = readerKey();
    pendingNotices().forEach(n=> setNoticeRead(n, key));
    stopAlertWatch();
    save(); checkNotices(); renderNoticeList();
    toast("Todos os avisos foram marcados como lidos.");
  });

  function renderNoticeList(){
    const box = $("#noticesList");
    if(!box) return;
    const key = readerKey();
    const list = (state.notices || []).slice(0, 40);
    if(!list.length){
      box.innerHTML = '<div class="empty" style="padding:26px 8px"><div class="big">🔔</div>'+
        '<h3>Nenhum aviso</h3><p>Na comanda, use <b>Avisar</b> para chamar alguém.</p></div>';
      return;
    }
    box.innerHTML = list.map(n=>{
      const pend = noticeTargetsMe(n) && !isReadBy(n, key);
      const dest = n.toId ? ((state.waiters || []).find(w=> w.id === n.toId) || {}).name : "Todos";
      const mesa = noticeTableNow(n);
      return '<div class="notif'+(pend ? " pend" : "")+'">'+
        '<div class="nf-top"><b>'+esc(n.fromName)+'</b>'+
          (mesa ? '<span class="np-table">Mesa '+mesa+'</span>' : '')+
          '<span style="font-size:11.5px;color:var(--muted)">para '+esc(dest || "Todos")+'</span>'+
          '<span class="nf-time">'+hm(n.at)+'</span></div>'+
        '<div class="nf-txt">'+(n.text ? esc(n.text) : "Está chamando na mesa.")+'</div>'+
        '<div class="nf-acts">'+
          (mesa ? '<button class="btn sm" data-nf-go="'+esc(mesa)+'">Ir para a mesa</button>' : '')+
          (pend ? '<button class="btn sm" data-nf-ok="'+esc(n.id)+'">Marcar como lido</button>'
                : '<span class="nf-read">✓ lido</span>')+
        '</div></div>';
    }).join("");
    $$("#noticesList [data-nf-go]").forEach(b=> b.addEventListener("click", ()=>{
      const id = b.closest(".notif").querySelector("[data-nf-ok]");
      if(id) markNoticeRead(id.dataset.nfOk);
      closeModals();
      goToTable(Number(b.dataset.nfGo));
    }));
    $$("#noticesList [data-nf-ok]").forEach(b=> b.addEventListener("click", ()=>{
      markNoticeRead(b.dataset.nfOk);
      renderNoticeList();
    }));
  }

  /* ============================================================
     GARÇONS — ACESSO E CADASTRO
     ============================================================ */
  let wlSelected = null;
  let usuariosAtivos = [];
  let editingWaiterId = null;

  async function openWaiterLogin(){
    wlSelected = null;
    $("#wlPinBox").hidden = true;
    $("#wlList").hidden = false;
    $("#wlErr").style.display = "none";
    $("#wlPin").value = "";
    const w = currentWaiter();
    const out = $("#wlLogout");
    out.hidden = !w;
    out.textContent = w ? ("Sair de " + w.name) : "";
    $("#wlManage").hidden = !canManageTeam();
    $("#wlList").innerHTML = '<div class="hint" style="padding:8px">Carregando equipe…</div>';
    openModal("waiterLogin");
    // a lista de quem pode entrar vem do servidor (id + nome + perfil, sem PIN)
    let usuarios = [];
    try{ usuarios = await api.usuariosDaLoja(localStorage.getItem("creao_loja") || "loja-1"); }catch(e){}
    if(usuarios === null){
      $("#wlList").innerHTML = '<div class="empty" style="padding:22px 8px"><div class="big">📡</div>' +
        '<h3>Servidor indisponível</h3><p>Sem o servidor não é possível identificar quem está atendendo. ' +
        'Tente novamente quando a rede voltar.</p></div>';
      return;
    }
    usuariosAtivos = usuarios;
    renderWaiterLoginList();
  }

  function renderWaiterLoginList(){
    const box = $("#wlList");
    const list = usuariosAtivos.filter(u => u.ativo !== false);
    if(!list.length){
      box.innerHTML = '<div class="empty" style="padding:22px 8px"><div class="big">👤</div>' +
        '<h3>Nenhum usuário cadastrado</h3><p>Peça a um administrador para cadastrar a equipe.</p></div>';
      return;
    }
    box.innerHTML = list.map(function(u){
      return '<button class="waiter-pick" data-w="'+esc(u.id)+'">' +
        '<span class="ic">'+esc(initials(u.nome))+'</span>'+esc(u.nome) +
        '<span class="lock">'+esc(String(u.role || "operador").toUpperCase())+(u.temPin ? ' · 🔒 PIN' : '')+'</span>' +
      '</button>';
    }).join("");
    $$("#wlList .waiter-pick").forEach(function(b){ b.addEventListener("click", ()=> pickWaiterForLogin(b.dataset.w)); });
  }

  function pickWaiterForLogin(id){
    const u = usuariosAtivos.find(x => x.id === id);
    if(!u) return;
    if(u.temPin){
      wlSelected = { id: u.id, nome: u.nome };
      $("#wlList").hidden = true;
      $("#wlPinBox").hidden = false;
      $("#wlErr").style.display = "none";
      $("#wlPin").value = "";
      setTimeout(()=> $("#wlPin").focus(), 80);
      return;
    }
    doWaiterLogin({ id: u.id, nome: u.nome });
  }

  async function doWaiterLogin(w){
    $("#wlErr").style.display = "none";
    const r = await entrar(w.id, $("#wlPin").value ? String($("#wlPin").value).trim() : undefined);
    if(!r.ok){
      $("#wlErr").textContent = r.erro === "bloqueado"
        ? ("Muitas tentativas. Tente em " + Math.ceil((r.esperar_segundos||0)/60) + " min.")
        : "PIN incorreto.";
      $("#wlErr").style.display = "block";
      $("#wlPin").value = "";
      $("#wlPin").focus();
      return;
    }
    localStorage.setItem("creao_loja", engine.estado.lojaId);
    closeModals();
    sincronizarEstado();
    renderAll();
    atualizarIndicadorDeSync();
    const table = pendingTable, assign = pendingAssignComanda;
    pendingTable = null; pendingAssignComanda = null;
    if(assign){
      // trocar o garçom da comanda é uma transferência de autoria: quem lança
      // os próximos itens passa a ser o novo usuário
      renderAll();
      const c = comandaById(assign);
      if(c && c.status === "open"){ activeId = c.id; renderComanda(); openModal("comanda"); }
    }else if(table != null){
      openComandaForTable(table);
    }
    toast("Bem-vindo, " + w.nome + ".");
  }

  $("#wlConfirm").addEventListener("click", ()=>{
    if(!wlSelected) return;
    // O PIN não é conferido aqui: quem valida é o servidor (com hash e limite
    // de tentativas). O cliente só transporta o que o usuário digitou.
    doWaiterLogin(wlSelected);
  });
  $("#wlBack").addEventListener("click", ()=>{
    wlSelected = null;
    $("#wlList").hidden = false;
    $("#wlPinBox").hidden = true;
    $("#wlErr").style.display = "none";
  });
  $("#wlPin").addEventListener("keydown", e=>{ if(e.key === "Enter") $("#wlConfirm").click(); });
  $("#wlManage").addEventListener("click", ()=>{ closeModals(); switchView("garcons"); openWaiterModal(null); });
  $("#wlLogout").addEventListener("click", ()=>{
    state.currentWaiterId = null;
    save(); closeModals(); renderAll();
    toast("Garçom desconectado.");
  });
  $("#btnWaiter").addEventListener("click", ()=>{
    pendingTable = null; pendingAssignComanda = null;
    openWaiterLogin();
  });
  $("#cmdWaiterBtn").addEventListener("click", ()=>{
    pendingTable = null; pendingAssignComanda = activeId;
    openWaiterLogin();
  });

  /** PIN vai por endpoint dedicado: é hasheado no servidor e não entra no sync. */
  async function definirPinDe(usuarioId, pin){
    const r = await engine.definirPin({ usuarioId: usuarioId, pin: pin });
    if(!r || r.ok === false) toast("Não foi possível salvar o PIN.");
    sincronizarEstado();
    return r;
  }

  function openWaiterModal(id){
    if(!canManageTeam()){ toast("Seu perfil não gerencia a equipe."); return; }
    editingWaiterId = id || null;
    const w = id ? waiterById(id) : null;
    const semUsuarios = (state.waiters || []).length === 0;
    $("#waiterModalTitle").textContent = w ? "Editar usuário" : "Novo usuário";
    $("#wName").value = w ? w.name : "";
    $("#wPin").value = w ? (w.pin || "") : "";
    $("#wRole").value = w ? (w.role || "operador") : (semUsuarios ? "admin" : "operador");
    $("#wRoleHint").textContent = semUsuarios
      ? "Primeiro usuário do sistema: recomendado como administrador, senão ninguém poderá configurar o sistema depois."
      : "O operador não altera produtos nem configurações administrativas.";
    $("#wActive").checked = w ? (w.active !== false) : true;
    $("#btnDeleteWaiter").hidden = !w;
    renderWaiters();
    openModal("waiter");
    setTimeout(()=> $("#wName").focus(), 120);
  }
  $("#btnNewWaiter").addEventListener("click", ()=> openWaiterModal(null));

  $("#btnSaveWaiter").addEventListener("click", async ()=>{
    if(!canManageTeam()){ toast("Seu perfil não gerencia a equipe."); return; }
    const name = $("#wName").value.trim();
    const pin = String($("#wPin").value || "").replace(/\D/g, "").slice(0, 6);
    const role = roleKey($("#wRole").value);
    const active = $("#wActive").checked;
    if(!name){ toast("Informe o nome."); return; }
    if(editingWaiterId && waiterById(editingWaiterId)){
      const w = waiterById(editingWaiterId);
      // a regra do último administrador é do domínio: se recusar, nada muda
      const r = despachar("salvarUsuario", { usuarioId: w.id, nome: name, role: role, ativo: active });
      if(!r || r.ok === false) return;
      if(role !== "operador" || pin) await definirPinDe(w.id, pin);
      closeModals(); renderWaiters(); renderTop();
      toast("Usuário atualizado.");
    }else{
      const novoId = uid();
      const r = despachar("salvarUsuario", { usuarioId: novoId, nome: name, role: role, ativo: active });
      if(!r || r.ok === false) return;
      if(pin) await definirPinDe(novoId, pin);
      closeModals(); renderWaiters(); renderTop();
      toast("Usuário cadastrado como " + roleLabel(role) + ".");
      const nw = waiterById(novoId);
      if(active && pendingTable != null && !currentWaiter() && nw) doWaiterLogin(nw);
      return;
    }
  });

  $("#btnDeleteWaiter").addEventListener("click", ()=>{ if(editingWaiterId) removeWaiter(editingWaiterId); });

  function removeWaiter(id){
    if(!canManageTeam()){ toast("Seu perfil não gerencia a equipe."); return; }
    const w = waiterById(id); if(!w) return;
    if(w.active !== false && (w.role || "operador") === "admin" && activeAdminCount(w.id) === 0){
      toast("É preciso manter ao menos um administrador ativo.");
      return;
    }
    const openCount = state.comandas.filter(c=> c.status === "open" && c.waiterId === id).length;
    if(openCount){
      toast("Há " + openCount + " comanda(s) aberta(s) com este garçom. Encerre ou troque antes.");
      return;
    }
    if(!confirm('Excluir o usuário "' + w.name + '"? O histórico já registrado será mantido.')) return;
    const r = despachar("removerUsuario", { usuarioId: id });
    if(!r || r.ok === false) return;
    closeModals(); renderWaiters(); renderTop();
    toast("Garçom excluído.");
  }

  function renderWaiters(){
    const grid = $("#gridWaiters");
    if(!grid) return;
    if(!state.waiters.length){
      grid.innerHTML = '<div class="empty card" style="grid-column:1/-1"><div class="big">👤</div>'+
        '<h3>Nenhum usuário cadastrado</h3>'+
        '<p>Cadastre quem acessa o sistema e defina o perfil de cada um.</p></div>';
      return;
    }
    const stats = {};
    state.comandas.filter(c=> c.status === "closed").forEach(c=>{
      const k = c.waiterId || "__none__";
      if(!stats[k]) stats[k] = { n:0, total:0 };
      stats[k].n += 1; stats[k].total += c.total;
    });
    grid.innerHTML = state.waiters.slice().sort((a,b)=> a.name.localeCompare(b.name)).map(w=>{
      const s = stats[w.id] || { n:0, total:0 };
      const online = state.currentWaiterId === w.id && w.active !== false;
      return '<div class="card waiter-card">'+
        '<div class="wtop"><span class="ic">'+esc(initials(w.name))+'</span>'+
          '<div style="flex:1; min-width:0"><h4>'+esc(w.name)+'</h4>'+
          '<div class="meta">'+(w.pin ? "PIN protegido" : "Sem PIN")+' · '+s.n+' comandas · '+money(s.total)+'</div></div>'+
          '<div style="display:flex; flex-direction:column; gap:4px; align-items:flex-end">'+
            roleTag(w.role)+
            '<span class="tag '+(w.active !== false ? "on" : "off")+'">'+(w.active !== false ? "Ativo" : "Inativo")+'</span>'+
          '</div>'+
        '</div>'+
        (online ? '<div style="margin-top:9px; font-size:12px; color:var(--brand); font-weight:700">● Conectado agora</div>' : '')+
        '<div class="prod-actions"><button class="btn sm" data-wedit="'+esc(w.id)+'">Editar</button>'+
        '<button class="btn sm danger" data-wdel="'+esc(w.id)+'">Excluir</button></div>'+
      '</div>';
    }).join("");
    $$("#gridWaiters [data-wedit]").forEach(b=> b.addEventListener("click", ()=> openWaiterModal(b.dataset.wedit)));
    $$("#gridWaiters [data-wdel]").forEach(b=> b.addEventListener("click", ()=> removeWaiter(b.dataset.wdel)));
  }

  /* ============================================================
     MOVER E JUNTAR MESAS
     ------------------------------------------------------------
     Mover: troca a mesa da comanda aberta (itens, pagamentos, avisos
     e autoria de cada item seguem junto).
     Juntar: ESTA comanda absorve a outra; a outra mesa fica livre e a
     comanda absorvida é arquivada como "merged" (não entra no
     faturamento, para não contar a venda duas vezes).
     ============================================================ */
  function comandaResumo(c){
    const n = (c.items || []).reduce(function(s,i){ return s + i.qty; }, 0);
    return n + (n === 1 ? " item" : " itens") + " · " + money(totalOf(c));
  }

  function openMoveModal(){
    const c = getActive(); if(!c) return;
    const total = Math.max(1, Number(state.settings.tables) || 1);
    $("#moveSub").textContent = "Comanda #" + (c.seq || "—") + " · Mesa " + c.table + " · " + comandaResumo(c);
    $("#moveHint").innerHTML = "Escolha uma mesa <b>livre</b> para mover a comanda, ou uma mesa <b>ocupada</b> para juntar " +
      "as duas. Ao juntar, esta comanda (mesa " + c.table + ") absorve a outra e a outra mesa fica livre.";
    let html = "";
    for(let t = 1; t <= total; t++){
      if(t === c.table) continue;
      const outra = openByTable(t);
      if(outra){
        html += '<button class="move-btn busy" data-join="'+t+'"><b>Mesa '+t+'</b><small>'+comandaResumo(outra)+'</small>'+
          '<span class="mv-tag">juntar</span></button>';
      }else{
        html += '<button class="move-btn free" data-move="'+t+'"><b>Mesa '+t+'</b><small>livre</small>'+
          '<span class="mv-tag">mover</span></button>';
      }
    }
    $("#moveGrid").innerHTML = html || '<div class="hint" style="margin:0">Não há outras mesas configuradas.</div>';
    $$("#moveGrid [data-move]").forEach(function(b){
      b.addEventListener("click", function(){ moveComandaTo(c, Number(b.dataset.move)); });
    });
    $$("#moveGrid [data-join]").forEach(function(b){
      b.addEventListener("click", function(){ askMerge(c, openByTable(Number(b.dataset.join))); });
    });
    openModal("move");
  }

  function moveComandaTo(c, destino){
    if(openByTable(destino)){ toast("A mesa " + destino + " está ocupada — use juntar."); return; }
    // a transferência é uma mutação: o servidor registra quem moveu, quando e de onde
    despachar("transferir", { comandaId: c.id, to: destino });
    closeModals();
    renderAll(); renderComanda(); openModal("comanda");
    toast("Comanda movida para a mesa " + destino + ".");
  }

  function askMerge(c, outra){
    if(!outra) return;
    const msg = "Juntar as duas comandas?\n\n" +
      "Mesa " + c.table + " (esta, permanece): " + comandaResumo(c) + "\n" +
      "Mesa " + outra.table + " (entra nesta): " + comandaResumo(outra) + "\n\n" +
      "A mesa " + outra.table + " ficará livre." +
      (paymentsOf(outra).length ? "\n\nPagamentos parciais da mesa " + outra.table + " (" + money(paidTotal(outra)) + ") serão transferidos." : "");
    if(!confirm(msg)) return;
    mergeComandas(c, outra);
  }

  /**
   * Junção: uma mutação só. O domínio compartilhado soma itens (preservando a
   * autoria de cada linha), transfere pagamentos com origem, combina os
   * descontos, reaponta os avisos e marca a absorvida como "merged" — fora da
   * receita, para a venda não contar duas vezes.
   */
  function mergeComandas(survivor, absorbed){
    if(!survivor || !absorbed || survivor.id === absorbed.id) return;
    const r = despachar("juntar", { comandaId: survivor.id, absorbId: absorbed.id });
    if(!r || r.ok === false) return;
    closeModals(); renderAll(); renderComanda(); openModal("comanda");
    toast("Comanda da mesa " + absorbed.table + " juntada à mesa " + survivor.table + ". Mesa " + absorbed.table + " livre.");
  }


  $("#btnMover").addEventListener("click", openMoveModal);

  /* ============================================================
     PEDIDO PARA PRODUÇÃO (COZINHA / BAR)
     ------------------------------------------------------------
     Cada LINHA guarda sentQty (quanto já saiu). O envio manda apenas
     o que falta, agrupado por setor, com uma via por setor.
     ============================================================ */
  let pedidoSel = {};

  function openPedido(){
    const c = getActive(); if(!c) return;
    pedidoSel = {};
    pendingItems(c).forEach(function(it){ pedidoSel[itemKey(it)] = pendingQty(it); });
    renderPedido();
    openModal("pedido");
  }

  function pedidoSelecionado(c){
    const out = {};
    (c.items || []).forEach(function(it){
      const q = Math.min(pendingQty(it), Math.max(0, Number(pedidoSel[itemKey(it)]) || 0));
      if(q > 0){
        const s = sectorOfItem(it);
        (out[s] = out[s] || []).push({ qty:q, name: it.name });
      }
    });
    return out;
  }

  function renderPedido(){
    const c = getActive(); if(!c) return;
    const pend = pendingItems(c);
    $("#pedidoSub").textContent = "Mesa " + c.table + " · comanda #" + (c.seq || "—") + " · " + (c.waiterName || "—");
    $("#pedidoHint").innerHTML = "Só os itens <b>ainda não enviados</b> aparecem aqui — o que já saiu não é reimpresso. " +
      "Cada setor sai em uma via própria.";

    if(!pend.length){
      $("#pedidoList").innerHTML = '<div class="empty" style="padding:26px 8px"><div class="big">✅</div>'+
        '<h3>Nada novo para enviar</h3><p>Todo o consumo desta comanda já foi para a produção.</p></div>';
      $("#btnPedidoPrint").disabled = true;
      $("#btnPedidoPrint").textContent = "Nada para imprimir";
      return;
    }

    const grupos = {};
    pend.forEach(function(it){ const s = sectorOfItem(it); (grupos[s] = grupos[s] || []).push(it); });
    $("#pedidoList").innerHTML = Object.keys(grupos).sort().map(function(setor){
      const itens = grupos[setor];
      return '<div class="pedido-setor"><h4>'+esc(setor)+' <span>'+itens.length+'</span></h4>'+
        itens.map(function(it){
          const k = itemKey(it);
          const max = pendingQty(it);
          const q = Math.min(max, Math.max(0, Number(pedidoSel[k]) || 0));
          return '<div class="pedido-item">'+
            '<input type="checkbox" data-pcheck="'+esc(k)+'"'+(q > 0 ? " checked" : "")+'>'+
            '<div class="pn">'+esc(it.name)+'<div class="pq">'+
              (sentQtyOf(it) > 0 ? sentQtyOf(it)+" já enviados · " : "") + max + " pendentes</div></div>"+
            '<div class="qty"><button data-pq="-1" data-pid="'+esc(k)+'">−</button>'+
              '<span class="q">'+q+'</span>'+
              '<button data-pq="1" data-pid="'+esc(k)+'">+</button></div></div>';
        }).join("") + '</div>';
    }).join("");

    $$("#pedidoList [data-pcheck]").forEach(function(el){
      el.addEventListener("change", function(){
        const k = el.dataset.pcheck;
        const it = c.items.find(function(x){ return itemKey(x) === k; });
        if(!it) return;
        pedidoSel[k] = el.checked ? pendingQty(it) : 0;
        renderPedido();
      });
    });
    $$("#pedidoList [data-pq]").forEach(function(b){
      b.addEventListener("click", function(){
        const k = b.dataset.pid;
        const it = c.items.find(function(x){ return itemKey(x) === k; });
        if(!it) return;
        const max = pendingQty(it);
        pedidoSel[k] = Math.min(max, Math.max(0, (Number(pedidoSel[k]) || 0) + Number(b.dataset.pq)));
        renderPedido();
      });
    });
    updatePedidoBtn();
  }

  function updatePedidoBtn(){
    const c = getActive(); if(!c) return;
    const g = pedidoSelecionado(c);
    const setores = Object.keys(g);
    const total = setores.reduce(function(s,k){
      return s + g[k].reduce(function(t,x){ return t + x.qty; }, 0);
    }, 0);
    const btn = $("#btnPedidoPrint");
    btn.disabled = !total;
    btn.textContent = total
      ? ("Imprimir " + total + (total === 1 ? " item" : " itens") + " · " + setores.length + (setores.length === 1 ? " setor" : " setores"))
      : "Selecione ao menos um item";
  }

  function imprimirPedido(grupos, c){
    const u = currentUser();
    const agora = new Date().toISOString();
    const area = $("#printArea");
    area.innerHTML = Object.keys(grupos).sort().map(function(setor){
      const itens = grupos[setor];
      return '<div class="ticket">'+
        '<div class="tk-setor">'+esc(String(setor).toUpperCase())+'</div>'+
        '<div class="tk-head">Mesa '+c.table+' · comanda #'+(c.seq || "—")+'<br>'+
          hm(agora)+' · '+esc(c.waiterName || "—")+
          (u && u.name !== c.waiterName ? '<br>lançado por '+esc(u.name) : "")+'</div>'+
        '<div class="tk-itens">'+itens.map(function(x){
          return '<div class="tk-it"><b>'+x.qty+'x</b> '+esc(x.name)+'</div>';
        }).join("")+'</div>'+
        '<div class="tk-foot">'+itens.reduce(function(s,x){ return s + x.qty; }, 0)+
          ' itens · '+esc(setor)+'</div>'+
      '</div>';
    }).join("");
    window.print();
    setTimeout(function(){ area.innerHTML = ""; }, 800);
  }

  $("#btnPedido").addEventListener("click", openPedido);
  $("#btnPedidoPrint").addEventListener("click", function(){
    const c = getActive(); if(!c) return;
    const g = pedidoSelecionado(c);
    const setores = Object.keys(g).sort();
    if(!setores.length){ toast("Selecione ao menos um item."); return; }
    let total = 0;
    const envios = [];
    c.items.forEach(function(it){
      const k = itemKey(it);
      const q = Math.min(pendingQty(it), Math.max(0, Number(pedidoSel[k]) || 0));
      if(q > 0){ envios.push({ iid: k, qty: q }); total += q; }
    });
    // marcar como enviado é estado compartilhado: os outros aparelhos param de reimprimir
    despachar("enviarProducao", { comandaId: c.id, items: envios });
    imprimirPedido(g, c);
    closeModals();
    renderComanda(); renderTables();
    toast("Pedido enviado para " + setores.join(" e ") + ".");
  });

  /* ============================================================
     TRILHA DE AUDITORIA
     ============================================================ */
  const AUDIT_TYPES = {
    desconto_autorizado:{ label:"Desconto autorizado", cls:"ok" },
    desconto_negado:    { label:"Desconto sem autorização", cls:"bad" },
    comanda_cancelada:  { label:"Comanda cancelada", cls:"bad" },
    pagamento_estornado:{ label:"Pagamento estornado", cls:"warn" },
    limite_alterado:    { label:"Limite de desconto alterado", cls:"info" },
    mesa_transferida:   { label:"Mesa transferida", cls:"info" },
    mesas_juntadas:     { label:"Mesas juntadas", cls:"info" },
    pedido_enviado:     { label:"Pedido enviado à produção", cls:"info" },
    item_despachado:    { label:"Item despachado pela produção", cls:"ok" },
    despacho_desfeito:  { label:"Despacho desfeito", cls:"warn" }
  };
  /**
   * A trilha de auditoria deixou de ser local. Quem registra é o SERVIDOR, a
   * partir do token de quem agiu — antes o próprio app escrevia a própria
   * auditoria, o que não vale como prova. `state.audit` é só uma cópia de
   * leitura, buscada em `carregarAuditoria()`.
   */
  function auditLog(){ /* no-op proposital: ver server/store.mjs (AUDITAVEIS) */ }

  async function carregarAuditoria(){
    if(!engine || !engine.estado.token) return;
    try{
      const r = await clienteHttp(location.origin).auditoria(engine.estado.token);
      if(r.ok) state.audit = (r.itens || []).map(i => ({
        id: i.id, at: i.at, type: i.tipo, userName: i.usuario_nome, role: i.papel, detail: i.detalhe,
      }));
    }catch(e){ /* painel de auditoria é secundário */ }
  }
  function renderAudit(){
    const box = $("#auditList");
    if(!box) return;
    const list = (state.audit || []).slice(0, 50);
    if(!list.length){
      box.innerHTML = '<div class="hint" style="margin:0">Nenhuma ação sensível registrada até agora.</div>';
      return;
    }
    box.innerHTML = list.map(function(r){
      const t = AUDIT_TYPES[r.type] || { label: r.type, cls: "info" };
      return '<div class="audit-item">'+
        '<div class="a1"><span class="audit-badge '+t.cls+'">'+esc(t.label)+'</span>'+
          '<b>'+esc(r.userName)+'</b><span class="at">'+dt(r.at)+'</span></div>'+
        (r.detail ? '<div class="a2">'+esc(r.detail)+'</div>' : '')+
      '</div>';
    }).join("");
  }

  /* ============================================================
     CONFIGURAÇÕES + BACKUP
     ============================================================ */
  $("#btnConfig").addEventListener("click", ()=>{
    if(!canOpenSettings()){ toast("Seu perfil não acessa as configurações."); return; }
    const p = perms();
    $("#cName").value = state.settings.name || "";
    $("#cTables").value = state.settings.tables || 12;
    $("#cDiscount").checked = !!state.settings.allowDiscount;
    $("#cRequireWaiter").checked = requiresWaiter();
    $("#cFeePct").value = (Number(state.settings.serviceFeePct) || 10);
    $("#cFeeDefault").checked = state.settings.serviceFeeDefault === true;
    $("#cSectors").value = sectorsList().join(", ");
    if(canManageTeam()){
      $("#permProducts").checked = p.products === true;
      $("#permToggleProducts").checked = p.toggleProducts === true;
      $("#permSettings").checked = p.settings === true;
      $("#cDiscLimit").value = discountLimitPct();
      renderPermUsers();
      renderAudit();
    }
    if(canManageTerminals()) renderTerminalList();
    renderAlertSettings();
    applyConfigPermissions();
    openModal("config");
  });

  /* ---------- Perfis de usuário (dentro das configurações) ---------- */
  function renderPermUsers(){
    const box = $("#permUsers");
    if(!box) return;
    const list = (state.waiters || []).slice().sort((a,b)=> a.name.localeCompare(b.name));
    if(!list.length){
      box.innerHTML = '<div class="hint" style="margin:0">Nenhum usuário cadastrado. Sem usuários, o sistema opera em '+
        'modo de configuração inicial (acesso total). Cadastre o primeiro em <b>Equipe</b>.</div>';
      return;
    }
    box.innerHTML = list.map(w=>{
      const k = roleKey(w.role);
      const icone = k === "admin" ? "🛡️" : (k === "gerente" ? "📊" : "👤");
      return '<div class="term-row"><span class="ic">'+icone+'</span>'+
        '<div class="tx"><b>'+esc(w.name)+'</b><small>'+(w.active === false ? "inativo · " : "")+
          esc(roleLabel(w.role || "operador"))+'</small></div>'+
        '<select class="select-inline" data-role="'+esc(w.id)+'" style="max-width:168px">'+
          '<option value="admin"'+(k === "admin" ? " selected" : "")+'>Administrador</option>'+
          '<option value="gerente"'+(k === "gerente" ? " selected" : "")+'>Gerente</option>'+
          '<option value="operador"'+(k === "operador" ? " selected" : "")+'>Operador</option>'+
        '</select></div>';
    }).join("");
    $$("#permUsers [data-role]").forEach(s=> s.addEventListener("change", ()=>{
      const w = waiterById(s.dataset.role);
      if(!w || !setWaiterRole(w, s.value)){ if(w) s.value = w.role || "operador"; renderPermUsers(); }
    }));
  }

  function setWaiterRole(w, role){
    role = roleKey(role);
    const eraAdminAtivo = w.active !== false && (w.role || "operador") === "admin";
    const seraAdminAtivo = w.active !== false && role === "admin";
    if(eraAdminAtivo && !seraAdminAtivo && activeAdminCount(w.id) === 0){
      toast("É preciso manter ao menos um administrador ativo.");
      return false;
    }
    w.role = role;
    save(); renderWaiters(); renderPermUsers(); renderTop();
    toast(w.name + " agora é " + roleLabel(role) + ".");
    return true;
  }

  $("#btnSaveConfig").addEventListener("click", ()=>{
    const name = $("#cName").value.trim() || "Meu Restaurante";
    let n = parseInt($("#cTables").value,10);
    if(!isFinite(n) || n < 1) n = 1;
    if(n > 80) n = 80;
    const occupied = state.comandas.filter(c=>c.status==="open").map(c=>c.table);
    const maxOccupied = occupied.length ? Math.max.apply(null, occupied) : 0;
    if(n < maxOccupied){
      toast("Há uma comanda aberta na mesa " + maxOccupied + ". Encerre antes de reduzir.");
      return;
    }
    const setoresNovos = $("#cSectors").value.split(",").map(function(s){ return s.trim(); }).filter(Boolean);
    // Configuração da loja vive no servidor: muda aqui e chega nos outros aparelhos.
    const campos = {
      nome: name, tables: n,
      allowDiscount: $("#cDiscount").checked,
      requireWaiter: $("#cRequireWaiter").checked,
      sectors: setoresNovos.length ? setoresNovos : state.settings.sectors,
      serviceFeePct: Math.max(0, Math.min(100, Number($("#cFeePct").value) || 0)),
      serviceFeeDefault: $("#cFeeDefault").checked,
    };
    if(canManageTeam()){
      campos.discountLimit = Math.max(0, Math.min(100, Number($("#cDiscLimit").value) || 0));
      campos.perm = {
        products: $("#permProducts").checked,
        toggleProducts: $("#permToggleProducts").checked,
        settings: $("#permSettings").checked,
      };
    }
    despachar("salvarConfig", campos);
    save();                       // preferências deste aparelho
    closeModals(); renderAll();
    carregarAuditoria().then(renderAudit);
    toast("Configurações salvas.");
  });


  $("#btnExport").addEventListener("click", ()=>{
    try{
      const blob = new Blob([JSON.stringify(state,null,2)], {type:"application/json"});
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "backup-comandas-" + new Date().toISOString().slice(0,10) + ".json";
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(()=>URL.revokeObjectURL(url), 1500);
      toast("Backup exportado.");
    }catch(e){ toast("Não foi possível exportar o backup."); }
  });
  $("#btnImport").addEventListener("click", ()=> $("#fileImport").click());
  $("#fileImport").addEventListener("change", e=>{
    const f = e.target.files && e.target.files[0];
    if(!f) return;
    const r = new FileReader();
    r.onload = ()=>{
      try{
        const data = JSON.parse(String(r.result));
        if(!data || !Array.isArray(data.products) || !Array.isArray(data.comandas)) throw new Error("formato");
        if(!confirm("Importar backup? Os dados atuais serão substituídos.")) return;
        state = {
          settings: Object.assign({}, defaultState().settings, data.settings||{}),
          products: data.products,
          waiters: Array.isArray(data.waiters) ? data.waiters : [],
          currentWaiterId: data.currentWaiterId || null,
          terminals: (Array.isArray(data.terminals) && data.terminals.length) ? data.terminals : defaultState().terminals,
          notices: Array.isArray(data.notices) ? data.notices : [],
          audit: Array.isArray(data.audit) ? data.audit : [],
          comandas: data.comandas,
          seq: data.seq || 1
        };
        save(); closeModals(); renderAll();
        toast("Backup importado com sucesso.");
      }catch(err){ toast("Arquivo de backup inválido."); }
    };
    r.readAsText(f);
    e.target.value = "";
  });

  /* ============================================================
     NUMERAÇÃO DE COMANDAS
     ============================================================ */
  function assignSeq(){ /* a numeração agora é atribuída pelo servidor */ }
  /* ============================================================
     INICIALIZAÇÃO
     ============================================================ */
  // Numera comandas antigas sem seq
  state.comandas.forEach(c=> assignSeq(c));
  // Itens gravados antes do controle de autoria não têm id de linha (iid)
  state.comandas.forEach(function(c){ (c.items || []).forEach(function(it){ if(!it.iid) it.iid = it.pid; }); });
  save();

  /* ============================================================
     LIGAÇÃO COM O SERVIDOR
     ============================================================ */
  const api = clienteHttp(location.origin);

  function storageNavegador(){
    return {
      get: k => { try{ return JSON.parse(store.getItem(k)); }catch(e){ return null; } },
      set: (k, v) => { try{ store.setItem(k, JSON.stringify(v)); }catch(e){} },
    };
  }

  function aoEventoDoMotor(ev){
    if(ev.tipo === "offline"){ toast("Sem conexão — continuando offline."); }
    if(ev.tipo === "reconectado"){ toast("Conexão restabelecida — enviando o que ficou na fila."); }
    if(ev.tipo === "sincronizado" && ev.enviados) toast(ev.enviados + " lançamento(s) sincronizado(s).");
    if(ev.tipo === "recusadas"){
      toast("O servidor recusou: " + mensagemDeErro(ev.recusadas[0]));
    }
    if(ev.tipo === "reconciliado" && ev.descartadas){
      toast(ev.descartadas + " comanda(s) descartada(s) — a mesa já estava ocupada.");
    }
    if(ev.tipo === "push_mudou"){
      // outro aparelho mexeu: o `sincronizar()` que segue já atualiza a tela
      atualizarIndicadorDeSync();
    }
    sincronizarEstado();
    renderAll();
    atualizarIndicadorDeSync();
  }

  function atualizarIndicadorDeSync(){
    // Um aviso do socket pode chegar durante o encerramento da página, quando
    // o documento já não existe — sem esta guarda o handler quebraria à toa.
    if(!document || typeof document.getElementById !== "function") return;
    const el = document.getElementById("syncEstado");
    if(!el || !engine) return;
    const pend = engine.pendentes;
    const on = engine.online;
    const push = engine.pushEstado;
    const canal = push === "conectado" ? "tempo real"
                : push === "reconectando" ? "reconectando…"
                : push === "offline" ? "sem rede" : "—";
    el.className = "sync-pill " + (!on ? "off" : (pend ? "pendente" : "ok"));
    el.textContent = !on
      ? "offline" + (pend ? " · " + pend + " na fila" : "")
      : (pend ? pend + " na fila" : "sincronizado") + " · " + canal;
    el.title = "Push: " + push + " · fila: " + pend;
  }

  /** Entra no servidor e traz o estado da loja. */
  async function entrar(usuarioId, pin){
    const r = await engine.login({ usuarioId: usuarioId, pin: pin });
    if(!r.ok) return r;
    const b = await engine.bootstrap();
    if(!b.ok) return b;
    await engine.sincronizar();
    sincronizarEstado();
    atualizarIndicadorDeSync();
    return { ok: true };
  }

  async function iniciar(opcoes){
    const opts = opcoes || {};
    engine = createSyncEngine({
      api: opts.api || api,
      storage: opts.storage || storageNavegador(),
      lojaId: opts.lojaId || localStorage.getItem("creao_loja") || "loja-1",
      // O aviso de mudança chega por WebSocket; o dado continua vindo por HTTP.
      urlPush: opts.urlPush || (location.origin.replace(/^http/, "ws") + "/ws"),
      onEvent: aoEventoDoMotor,
    });
    engine.observarRede();

    // preferências locais deste aparelho
    const pref = (function(){ try{ return JSON.parse(store.getItem(KEY)) || {}; }catch(e){ return {}; } })();
    if(pref.settings) state.settings = Object.assign(state.settings, pref.settings);
    if(Array.isArray(pref.terminals) && pref.terminals.length) state.terminals = pref.terminals;

    switchView("mesas");
    renderAll();

    if(engine.estado.token){
      const b = await engine.bootstrap();
      if(b.ok){ sincronizarEstado(); renderAll(); atualizarIndicadorDeSync(); return { ok:true }; }
    }
    openWaiterLogin();                    // ninguém identificado: pede login no servidor
    return { ok:true, precisaLogin:true };
  }

  function modalAberto(){
    return Object.keys(REG).some(function(k){ return !$(REG[k].modal).hidden; });
  }

  setInterval(function(){
    if(modalAberto()) return;
    if(currentView === "mesas") renderTables();
    if(currentView === "producao") renderProduction();
    renderTop();
    atualizarIndicadorDeSync();
  }, 30000);

  /**
   * Rede de segurança.
   *
   * O caminho normal é o WebSocket: quando outro aparelho lança algo, o
   * servidor avisa e este aparelho puxa na hora. Este vigia de 30s existe só
   * para o caso do socket ter morrido em silêncio (rede móvel, proxy, aba
   * suspensa) — é a diferença entre "quase sempre instantâneo" e "sempre
   * correto". Não é o mecanismo principal.
   */
  const INTERVALO_VIGIA = 30000;
  setInterval(function(){
    if(!engine) return;
    if(engine.online && engine.pushEstado !== "conectado") engine.conectarPush();
    engine.sincronizar().then(function(){
      atualizarIndicadorDeSync();
      if(modalAberto()) return;
      sincronizarEstado();
      if(currentView === "mesas") renderTables();
      if(currentView === "producao") renderProduction();
      if(activeId) renderComanda();
      renderTop();
    }).catch(function(){});
  }, INTERVALO_VIGIA);

  // ao voltar para a aba, sincroniza na hora (sem esperar o ciclo)
  document.addEventListener("visibilitychange", function(){
    if(document.visibilityState === "visible"){ window.dispatchEvent(new Event("focus")); }
  });

  // ao voltar o foco, tenta sincronizar o que ficou na fila
  window.addEventListener("focus", ()=>{ if(engine) engine.sincronizar(); });
  window.addEventListener("resize", syncTopbarHeight);
  window.addEventListener("orientationchange", ()=> setTimeout(syncTopbarHeight, 120));

  window.APP = { iniciar, entrar, get engine(){ return engine; },
                 get estado(){ return state; }, sincronizar: () => engine && engine.sincronizar() };

  // No navegador o domínio chega por módulo (script type=module); nos testes,
  // ele é injetado antes. Em qualquer caso, inicia quando estiver disponível.
  if(window.DOMINIO && window.SYNC) iniciar();
  else window.addEventListener("dominio-pronto", () => iniciar());
})();
