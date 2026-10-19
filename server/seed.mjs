import { hashPin } from './auth.mjs';

/**
 * Semente de uma loja completa — usada nos testes e no `server.mjs` de demonstração.
 * No protótipo isto eram ~24 produtos e 2 usuários guardados no localStorage;
 * aqui viram linhas de banco com PIN hasheado.
 */
export async function semearDemo(store, { lojaId = 'loja-1', nome = 'Bar do Zé' } = {}) {
  await store.criarLoja({ id: lojaId, nome, discountLimit: 10, serviceFeePct: 10 });

  const usuarios = [
    { id: 'u-ana',   nome: 'Ana Souza',   role: 'admin',    pin: '4321' },
    { id: 'u-carla', nome: 'Carla Dias',  role: 'gerente',  pin: '2222' },
    { id: 'u-bruno', nome: 'Bruno Lima',  role: 'operador', pin: '1111' },
  ];
  for (const u of usuarios) {
    await store.criarUsuario({ id: u.id, lojaId, nome: u.nome, role: u.role, pinHash: hashPin(u.pin) });
  }

  const produtos = [
    ['p-agua',     'Água mineral',      5,  'Bebidas',    'Bar'],
    ['p-refri',    'Refrigerante lata', 7,  'Bebidas',    'Bar'],
    ['p-cerveja',  'Cerveja 600ml',     22, 'Cervejas',   'Bar'],
    ['p-long',     'Cerveja long neck', 12, 'Cervejas',   'Bar'],
    ['p-chopp',    'Chopp 300ml',       10, 'Cervejas',   'Bar'],
    ['p-caipi',    'Caipirinha',        22, 'Drinks',     'Bar'],
    ['p-frita',    'Batata frita',      28, 'Petiscos',   'Cozinha'],
    ['p-calab',    'Calabresa acebolada', 32, 'Petiscos', 'Cozinha'],
    ['p-file',     'Filé à parmegiana', 62, 'Pratos',     'Cozinha'],
    ['p-picanha',  'Picanha na chapa',  89, 'Pratos',     'Cozinha'],
    ['p-pudim',    'Pudim',             14, 'Sobremesas', 'Cozinha'],
  ];
  for (const [id, n, preco, categoria, setor] of produtos) {
    await store.criarProduto({ id, lojaId, nome: n, preco, categoria, setor });
  }

  return { lojaId, usuarios, produtos: produtos.map(p => p[0]) };
}
