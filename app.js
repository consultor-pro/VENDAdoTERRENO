/* =========================================================
   Venda do Terreno — Controle de Recebíveis (PWA, só local)
   Dados: localStorage | Comprovantes: armazenamento local do navegador (IndexedDB)
   ========================================================= */
'use strict';

const LS_DADOS = 'rt_dados_v1';
const LS_AUTH = 'rt_auth_v1';
const LS_SESSAO = 'rt_sessao_v1';
const LS_TENT = 'rt_tentativas_v1';
const SESSAO_MS = 6 * 60 * 60 * 1000; // 6 horas

/* ---------- Termos extraídos dos contratos ---------- */
const CONTRATO = {
  imovel: 'Rua Topázio, 110 – Bairro Washington Pires – Ibirité/MG – CEP 32.424-180 · Lote 344, Quadra 76 · 200 m² · Índice cadastral 03.1.076.0344.001',
  administradora: 'J Lima Immobile Ltda (CNPJ 52.386.093/0001-38)',
  dataContrato: '2026-10-29',
  precoTotal: 85000,
  sinal: 14900,
  corretagem: 5100,
  qtdParcelas: 22,
  valorParcela: 2500,
  diaVencimento: 15,
  primeiroVenc: '2026-11-15',
  balao: { valor: 10000, venc: '2027-10-15' },
  multaAtraso: 0.10,   // 10% multa de mora
  jurosMes: 0.01,      // 1% ao mês
  taxaAdm: 0.10,       // 10% sobre o valor arrecadado (contrato de administração)
  diasRepasse: 5,      // dias úteis após compensação
  diasRescisao: 90,    // inadimplência > 90 dias permite restituição do imóvel
  repasse: 'conta do vendedor indicada na cláusula 5.2 do contrato de administração'
};

/* ---------- Utilidades ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const pad = n => String(n).padStart(2, '0');
const brl = v => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
const parseData = s => { if (!s) return null; const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const hojeISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const fmtData = s => { const d = parseData(s); return d ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}` : '—'; };
const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const diffDias = (a, b) => Math.round((parseData(a) - parseData(b)) / 86400000); // a - b
const mesAno = s => { const d = parseData(s); return d.toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' }).replace('.', ''); };
const fmtTam = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
function addDiasUteis(iso, n) {
  const d = parseData(iso); let c = 0;
  while (c < n) { d.setDate(d.getDate() + 1); const w = d.getDay(); if (w !== 0 && w !== 6) c++; }
  return toISO(d);
}
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

/* ---------- Hash de senha ---------- */
async function hashSenha(senha, salt) {
  const txt = salt + '::' + senha;
  if (window.crypto && crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(txt));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // fallback (cyrb53) para contextos sem crypto.subtle
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let k = 0; k < 2000; k++) for (let i = 0; i < txt.length; i++) {
    const ch = txt.charCodeAt(i) + k;
    h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 'f' + (h2 >>> 0).toString(16) + (h1 >>> 0).toString(16);
}
const novoSalt = () => { const a = new Uint8Array(16); (crypto.getRandomValues ? crypto.getRandomValues(a) : a.forEach((_, i) => a[i] = Math.random() * 256)); return [...a].map(b => b.toString(16).padStart(2, '0')).join(''); };

/* ---------- Armazenamento local no IndexedDB (dados + comprovantes + contratos) ---------- */
const arq = {
  db: null,
  abrir() {
    return new Promise((res, rej) => {
      if (this.db) return res(this.db);
      const r = indexedDB.open('rt_comprovantes', 2);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('f')) db.createObjectStore('f', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  async tx(modo, fn, store = 'f') {
    const db = await this.abrir();
    return new Promise((res, rej) => {
      const t = db.transaction(store, modo); const st = t.objectStore(store);
      let out; const req = fn(st); if (req) req.onsuccess = () => out = req.result;
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  },
  put(o) { return this.tx('readwrite', s => s.put(o)); },
  get(id) { return this.tx('readonly', s => s.get(id)); },
  del(id) { return this.tx('readwrite', s => s.delete(id)); },
  todos() { return this.tx('readonly', s => s.getAll()); },
  limpar() { return this.tx('readwrite', s => s.clear()); },
  kvGet(k) { return this.tx('readonly', s => s.get(k), 'kv'); },
  kvPut(k, v) { return this.tx('readwrite', s => s.put(v, k), 'kv'); },
  kvLimpar() { return this.tx('readwrite', s => s.clear(), 'kv'); }
};

// Comprovantes: reduz para no máx. 1600 px no lado maior (texto segue legível) e JPEG 72%.
// Recibos muito compridos (prints de PIX) mantêm ao menos 900 px de largura para não borrar as letras.
async function comprimirImagem(file) {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;
  try {
    const img = await createImageBitmap(file);
    const ladoMaior = Math.max(img.width, img.height), ladoMenor = Math.min(img.width, img.height);
    let s = Math.min(1, 1600 / ladoMaior);
    if (ladoMenor * s < 900) s = Math.min(1, 900 / ladoMenor);
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.72));
    return blob && blob.size < file.size ? blob : file;
  } catch { return file; }
}

/* ---------- Dados ---------- */
function novoItem(base) {
  return Object.assign({
    pago: false, dataPg: '', multa: 0, juros: 0, valorPago: null,
    repassado: false, dataRepasse: '', valorRepasse: null,
    formaPg: '', obs: '', anexos: { pg: [], rep: [] }
  }, base);
}
function gerarCronograma() {
  const itens = [
    novoItem({ id: 'sinal', tipo: 'sinal', rotulo: 'Sinal de negócio', venc: CONTRATO.dataContrato, valor: CONTRATO.sinal }),
    novoItem({ id: 'corretagem', tipo: 'corretagem', rotulo: 'Intermediação (corretagem)', venc: CONTRATO.dataContrato, valor: CONTRATO.corretagem })
  ];
  let n = 0, [y, m] = CONTRATO.primeiroVenc.split('-').map(Number);
  const [by, bm] = CONTRATO.balao.venc.split('-').map(Number);
  while (n < CONTRATO.qtdParcelas) {
    if (y === by && m === bm) {
      // Cláusula 2ª, item 4: o balão NÃO acumula com a parcela mensal desse mês
      itens.push(novoItem({ id: 'balao', tipo: 'balao', rotulo: 'Parcela única (balão)', venc: CONTRATO.balao.venc, valor: CONTRATO.balao.valor }));
    } else {
      n++;
      itens.push(novoItem({ id: 'p' + n, tipo: 'mensal', num: n, rotulo: `Parcela ${n}/${CONTRATO.qtdParcelas}`, venc: `${y}-${pad(m)}-${pad(CONTRATO.diaVencimento)}`, valor: CONTRATO.valorParcela }));
    }
    m++; if (m > 12) { m = 1; y++; }
  }
  return itens;
}
let DADOS = null;
async function carregarDados() {
  DADOS = await arq.kvGet('dados').catch(() => null);
  if (!DADOS) { // migra versão antiga que usava localStorage
    try { DADOS = JSON.parse(localStorage.getItem(LS_DADOS)); } catch { DADOS = null; }
  }
  if (!DADOS || !Array.isArray(DADOS.itens)) DADOS = { versao: 1, criadoEm: new Date().toISOString(), itens: gerarCronograma() };
  await arq.kvPut('dados', DADOS);
  localStorage.removeItem(LS_DADOS);
}
let filaGravacao = Promise.resolve();
function salvarDados() {
  const copia = JSON.parse(JSON.stringify(DADOS));
  filaGravacao = filaGravacao.then(() => arq.kvPut('dados', copia)).catch(e => alert('Não foi possível salvar os dados neste aparelho. ' + (e?.message || '')));
  return true;
}
const item = id => DADOS.itens.find(i => i.id === id);
const cobradoPelaAdm = it => it.tipo === 'mensal' || it.tipo === 'balao'; // itens 3 e 4

/* ---------- Cálculos ---------- */
function encargos(it, dataPg) {
  const dias = diffDias(dataPg || hojeISO(), it.venc);
  if (dias <= 0 || !cobradoPelaAdm(it)) return { dias: Math.max(0, dias), multa: 0, juros: 0 };
  return { dias, multa: r2(it.valor * CONTRATO.multaAtraso), juros: r2(it.valor * CONTRATO.jurosMes * dias / 30) };
}
function totalPago(it) { return it.valorPago != null && it.valorPago !== '' ? Number(it.valorPago) : r2(it.valor + Number(it.multa || 0) + Number(it.juros || 0)); }
function taxa(it) { return cobradoPelaAdm(it) && it.pago ? r2(totalPago(it) * CONTRATO.taxaAdm) : 0; }
function liquido(it) { return it.pago ? r2(totalPago(it) - taxa(it)) : 0; }

function status(it) {
  if (it.tipo === 'corretagem') return it.pago ? { k: 'pago', t: 'Pago à J Lima' } : { k: 'info', t: 'Corretagem' };
  if (it.pago) {
    if (cobradoPelaAdm(it) && !it.repassado) return { k: 'hoje', t: 'Pago · aguardando repasse' };
    return { k: 'pago', t: cobradoPelaAdm(it) ? 'Pago e repassado' : 'Pago' };
  }
  if (it.tipo === 'sinal') return { k: 'info', t: 'Confirmar pagamento' };
  const d = diffDias(hojeISO(), it.venc);
  if (d > CONTRATO.diasRescisao) return { k: 'critico', t: `${d} dias em atraso` };
  if (d > 0) return { k: 'atrasado', t: `Atrasada ${d} dia${d > 1 ? 's' : ''}` };
  if (d === 0) return { k: 'hoje', t: 'Vence hoje' };
  if (d >= -5) return { k: 'hoje', t: `Vence em ${-d} dia${d < -1 ? 's' : ''}` };
  return { k: 'pendente', t: 'Pendente' };
}

function resumo() {
  const vend = DADOS.itens.filter(i => i.tipo !== 'corretagem');
  const parc = DADOS.itens.filter(cobradoPelaAdm);
  const hoje = hojeISO();
  const recebidoBruto = vend.filter(i => i.pago).reduce((s, i) => s + totalPago(i), 0);
  const principalPago = DADOS.itens.filter(i => i.pago).reduce((s, i) => s + i.valor, 0);
  const aReceber = vend.filter(i => !i.pago).reduce((s, i) => s + i.valor, 0);
  const atrasadas = parc.filter(i => !i.pago && diffDias(hoje, i.venc) > 0);
  const emAtraso = atrasadas.reduce((s, i) => s + i.valor, 0);
  const taxas = parc.reduce((s, i) => s + taxa(i), 0);
  const repassado = parc.filter(i => i.repassado).reduce((s, i) => s + (i.valorRepasse != null && i.valorRepasse !== '' ? Number(i.valorRepasse) : liquido(i)), 0);
  const aguardandoRepasse = parc.filter(i => i.pago && !i.repassado);
  const proxima = parc.filter(i => !i.pago).sort((a, b) => a.venc.localeCompare(b.venc))[0];
  const pagasParc = parc.filter(i => i.pago).length;
  return { recebidoBruto, principalPago, aReceber, atrasadas, emAtraso, taxas, repassado, aguardandoRepasse, proxima, pagasParc, totalParc: parc.length };
}

/* ---------- Autenticação & sessão ---------- */
// Acesso padrão (somente o hash da senha fica no código)
const AUTH_PADRAO = { usuario: 'Paulocesar', salt: 'vt-ibirite-344-76', hash: 'd5cc1c7116a4c5c99e6cfa1a506b64ad19b1d17a85dd2e7dfd092d97e44acd6e', hashF: 'ffa66d11cff32afbf', padrao: true };
const getAuth = () => { try { return JSON.parse(localStorage.getItem(LS_AUTH)) || AUTH_PADRAO; } catch { return AUTH_PADRAO; } };
const confereSenha = async (senha, a) => { const h = await hashSenha(senha, a.salt); return h === a.hash || (!!a.hashF && h === a.hashF); };
const getSessao = () => { try { return JSON.parse(localStorage.getItem(LS_SESSAO)); } catch { return null; } };
function sessaoValida() { const s = getSessao(); return !!(s && s.loginEm && Date.now() - s.loginEm < SESSAO_MS && Date.now() >= s.loginEm); }

function mostrarLogin(msg) {
  $('#app').classList.add('hidden'); fecharModal();
  $('#tela-login').classList.remove('hidden');
  const primeiro = false; // acesso padrão já definido (Paulocesar)
  $('#login-titulo').textContent = primeiro ? 'Criar acesso' : 'Entrar';
  $('#login-sub').textContent = primeiro ? 'Primeiro acesso: defina o usuário e a senha que serão usados para entrar.' : 'Controle de recebíveis — Lote 344, Qd. 76 · Ibirité/MG';
  $('#wrap-confirma').classList.toggle('hidden', !primeiro);
  $('#lg-confirma').required = primeiro;
  $('#lg-senha').autocomplete = primeiro ? 'new-password' : 'current-password';
  $('#btn-login').textContent = primeiro ? 'Criar e entrar' : 'Entrar';
  $('#btn-esqueci').classList.toggle('hidden', primeiro);
  const e = $('#login-erro'); e.classList.toggle('hidden', !msg); e.textContent = msg || '';
  $('#lg-senha').value = ''; $('#lg-confirma').value = '';
}

async function onLogin(ev) {
  ev.preventDefault();
  const u = $('#lg-usuario').value.trim(), s = $('#lg-senha').value;
  const erro = m => { const e = $('#login-erro'); e.textContent = m; e.classList.remove('hidden'); };
  const auth = getAuth();
  {
    const t = JSON.parse(localStorage.getItem(LS_TENT) || '{"n":0,"ate":0}');
    if (t.ate > Date.now()) return erro(`Muitas tentativas. Aguarde ${Math.ceil((t.ate - Date.now()) / 1000)} segundos.`);
    const ok = u.toLowerCase() === auth.usuario.toLowerCase() && await confereSenha(s, auth);
    if (!ok) {
      t.n++; if (t.n >= 5) { t.ate = Date.now() + 60000; t.n = 0; }
      localStorage.setItem(LS_TENT, JSON.stringify(t));
      return erro('Usuário ou senha incorretos.');
    }
    localStorage.removeItem(LS_TENT);
  }
  localStorage.setItem(LS_SESSAO, JSON.stringify({ usuario: u, loginEm: Date.now() }));
  entrarApp();
}

function sair(msg) { localStorage.removeItem(LS_SESSAO); mostrarLogin(msg); }

function verificarSessao() {
  if ($('#app').classList.contains('hidden')) return;
  if (!sessaoValida()) return sair('Sua sessão expirou (limite de 6 horas). Entre novamente.');
  const rest = SESSAO_MS - (Date.now() - getSessao().loginEm);
  const h = Math.floor(rest / 3600000), m = Math.floor(rest % 3600000 / 60000);
  $('#topo-sessao').textContent = `Sessão expira em ${h}h${pad(m)}`;
}

async function esqueciSenha() {
  const r = prompt('Sem servidor não há como recuperar a senha.\n\nPara voltar ao acesso padrão, TODOS os dados e comprovantes deste aparelho serão apagados (se tiver backup, poderá restaurar depois).\n\nDigite APAGAR para confirmar:');
  if (r !== 'APAGAR') return;
  await apagarTudo(); mostrarLogin(); toast('Dados apagados. Acesso padrão restaurado.');
}

/* ---------- Instalação (PWA) ---------- */
let promptInstalacao = null;
const estaInstalado = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function atualizarBotoesInstalar() { $$('.btn-instalar').forEach(b => b.classList.toggle('hidden', estaInstalado())); }
async function instalar() {
  if (promptInstalacao) {
    promptInstalacao.prompt();
    const { outcome } = await promptInstalacao.userChoice;
    promptInstalacao = null;
    if (outcome === 'accepted') toast('Aplicativo instalado!');
    return;
  }
  abrirModal('Instalar aplicativo', `
    <p>Para instalar no <b>Android (Chrome)</b>:</p>
    <ol class="termos"><li>Toque no menu <b>⋮</b> no canto superior direito.</li>
    <li>Escolha <b>“Instalar app”</b> ou <b>“Adicionar à tela inicial”</b>.</li><li>Confirme em <b>Instalar</b>.</li></ol>
    <p style="margin-top:1rem">No <b>PC (Chrome/Edge)</b>: clique no ícone de instalar (⊕) na barra de endereço.</p>
    <p class="muted pequeno">Se a opção não aparecer, verifique se o sistema está aberto pelo endereço https (ex.: GitHub Pages) e não como arquivo local.</p>
    <div class="acoes-modal"><button class="btn btn-primario" data-fechar>Entendi</button></div>`);
}
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); promptInstalacao = e; atualizarBotoesInstalar(); });
window.addEventListener('appinstalled', () => { promptInstalacao = null; atualizarBotoesInstalar(); toast('Aplicativo instalado!'); });

/* ---------- Navegação ---------- */
let VIEW = 'inicio', FILTRO = 'todas';
const TITULOS = { inicio: 'Início', parcelas: 'Parcelas', contratos: 'Contratos', ajustes: 'Ajustes' };
function irPara(v) {
  VIEW = v;
  $$('.nav-inferior button').forEach(b => b.classList.toggle('ativo', b.dataset.view === v));
  $('#topo-titulo').textContent = TITULOS[v];
  render(); window.scrollTo({ top: 0 });
}
function render() {
  const c = $('#conteudo');
  ({ inicio: renderInicio, parcelas: renderParcelas, contratos: renderContratos, ajustes: renderAjustes })[VIEW](c);
}

function itemHTML(it) {
  const st = status(it);
  const ico = { sinal: 'S', corretagem: 'C', balao: '★', mensal: it.num }[it.tipo];
  const nAnexos = (it.anexos.pg.length + it.anexos.rep.length);
  const valor = it.pago ? totalPago(it) : it.valor;
  return `<button class="item" data-abrir="${it.id}">
    <div class="item-ico ico-${st.k}">${ico}</div>
    <div class="item-meio"><strong>${esc(it.rotulo)}</strong>
      <span>Venc. ${fmtData(it.venc)}${it.pago && it.dataPg ? ' · pago ' + fmtData(it.dataPg) : ''}</span>
      ${nAnexos ? `<div class="clip">📎 ${nAnexos} comprovante${nAnexos > 1 ? 's' : ''}</div>` : ''}</div>
    <div class="item-dir"><b>${brl(valor)}</b><span class="tag st-${st.k}">${st.t}</span></div>
  </button>`;
}

function renderInicio(c) {
  const r = resumo();
  const pct = Math.min(100, r.principalPago / CONTRATO.precoTotal * 100);
  const alertas = [];
  ['sinal', 'corretagem'].map(item).filter(i => !i.pago).forEach(i => alertas.push(`<div class="alerta azul" data-abrir="${i.id}">ℹ️<div>Confirme o pagamento de <b>${esc(i.rotulo)}</b> (${brl(i.valor)}) e anexe o comprovante.</div></div>`));
  r.atrasadas.forEach(i => {
    const d = diffDias(hojeISO(), i.venc);
    alertas.push(`<div class="alerta vermelho" data-abrir="${i.id}">⚠️<div><b>${esc(i.rotulo)}</b> em atraso há ${d} dias (${brl(i.valor)}).${d > CONTRATO.diasRescisao ? ' <b>Mais de 90 dias: cabe restituição do imóvel (Cláusula 3ª, §1º).</b>' : ' Multa de 10% + juros de 1% a.m.'}</div></div>`);
  });
  r.aguardandoRepasse.forEach(i => {
    const lim = addDiasUteis(i.dataPg || hojeISO(), CONTRATO.diasRepasse);
    const venc = diffDias(hojeISO(), lim) > 0;
    alertas.push(`<div class="alerta ${venc ? 'vermelho' : 'amarelo'}" data-abrir="${i.id}">🔁<div>Repasse de <b>${esc(i.rotulo)}</b> (${brl(liquido(i))} líquido) ${venc ? 'atrasado — prazo era' : 'previsto até'} ${fmtData(lim)}.</div></div>`);
  });
  const p = r.proxima;
  c.innerHTML = `
    <div class="grid-kpi">
      <div class="kpi verde"><small>Recebido</small><b>${brl(r.recebidoBruto)}</b></div>
      <div class="kpi"><small>A receber</small><b>${brl(r.aReceber)}</b></div>
      <div class="kpi vermelho"><small>Em atraso</small><b>${brl(r.emAtraso)}</b></div>
      <div class="kpi azul"><small>Repassado (líq.)</small><b>${brl(r.repassado)}</b></div>
    </div>
    <div class="inicio-grid">
      <div>
        ${p ? `<div class="card destaque">
          <div class="linha"><small class="muted"><b>PRÓXIMO VENCIMENTO</b></small><span class="tag st-${status(p).k}">${status(p).t}</span></div>
          <h2 style="margin:.4rem 0 0">${esc(p.rotulo)}</h2>
          <div class="linha" style="margin:.3rem 0 .8rem"><span class="muted">${fmtData(p.venc)}</span><b style="font-size:1.35rem">${brl(p.valor)}</b></div>
          <button class="btn btn-primario btn-bloco" data-abrir="${p.id}">✓ Registrar pagamento</button>
        </div>` : `<div class="card destaque"><h2>🎉 Todas as parcelas foram pagas!</h2><p class="muted">Emitir a declaração de quitação (Cláusula 4ª, item 2).</p></div>`}
        ${alertas.length ? `<div class="card"><h3>Atenção</h3>${alertas.join('')}</div>` : ''}
      </div>
      <div>
        <div class="card">
          <div class="linha"><h3 style="margin:0">Progresso da venda</h3><b>${pct.toFixed(0)}%</b></div>
          <div class="barra"><div style="width:${pct}%"></div></div>
          <div class="linha pequeno muted"><span>${brl(r.principalPago)} quitado</span><span>de ${brl(CONTRATO.precoTotal)}</span></div>
          <div class="resumo">
            <div class="linha"><span>Parcelas pagas</span><b>${r.pagasParc} de ${r.totalParc}</b></div>
            <div class="linha"><span>Taxa adm. J Lima (10%)</span><b>${brl(r.taxas)}</b></div>
            <div class="linha"><span>Aguardando repasse</span><b>${r.aguardandoRepasse.length}</b></div>
          </div>
        </div>
        <button class="btn btn-verde btn-bloco" data-enviar-link style="margin-bottom:.9rem">🟢 Enviar atualização pelo WhatsApp</button>
        <div class="card pequeno muted"><b>Imóvel:</b> ${esc(CONTRATO.imovel)}</div>
      </div>
    </div>`;
}

const FILTROS = {
  todas: ['Todas', () => true],
  pendentes: ['A vencer', i => !i.pago && diffDias(hojeISO(), i.venc) <= 0],
  atrasadas: ['Atrasadas', i => !i.pago && cobradoPelaAdm(i) && diffDias(hojeISO(), i.venc) > 0],
  pagas: ['Pagas', i => i.pago],
  repasse: ['Repasse pendente', i => i.pago && cobradoPelaAdm(i) && !i.repassado],
  entrada: ['Entrada', i => i.tipo === 'sinal' || i.tipo === 'corretagem']
};
function renderParcelas(c) {
  const lista = DADOS.itens.filter(FILTROS[FILTRO][1]);
  c.innerHTML = `
    <div class="chips">${Object.entries(FILTROS).map(([k, [t, f]]) => `<button class="chip ${k === FILTRO ? 'ativo' : ''}" data-filtro="${k}">${t} (${DADOS.itens.filter(f).length})</button>`).join('')}</div>
    <div class="lista">${lista.length ? lista.map(itemHTML).join('') : '<div class="card muted" style="text-align:center">Nenhum item neste filtro.</div>'}</div>`;
}

// Contratos ficam salvos só no aparelho (não vão para o site público)
const CONTRATOS_ARQ = { promessa: 'Contrato_Promessa_Compra_Venda.pdf', adm: 'Contrato_Administracao_Cobranca.pdf' };
let contratosSalvos = {};
function acoesContrato(k) {
  const f = contratosSalvos[k];
  if (!f) return `<div class="alerta azul" style="margin-top:.7rem">📎<div>Contrato ainda não anexado neste aparelho.</div></div>
    <div class="acoes"><button class="btn btn-primario btn-peq" data-contrato="${k}">📎 Anexar PDF do contrato</button></div>`;
  return `<p class="pequeno muted" style="margin:.6rem 0 0">✅ ${esc(f.nome)} · ${fmtTam(f.blob.size)}</p>
    <div class="acoes"><button class="btn btn-primario btn-peq" data-ver="contrato-${k}">Abrir PDF</button>
    <button class="btn btn-cinza btn-peq" data-baixar="contrato-${k}">Baixar</button>
    <button class="btn btn-cinza btn-peq" data-contrato="${k}">Substituir</button></div>`;
}
async function renderContratos(c) {
  for (const k of Object.keys(CONTRATOS_ARQ)) {
    contratosSalvos[k] = await arq.get('contrato-' + k).catch(() => null);
  }
  if (VIEW !== 'contratos') return;
  c.innerHTML = `
    <p class="pequeno muted" style="margin:0 0 .8rem">🔒 Os PDFs anexados ficam salvos só neste aparelho e vão junto no backup.</p>
    <div class="contratos-grid">
      <div class="card contrato-card">
        <h2>📄 Promessa de Compra e Venda</h2>
        <p class="muted pequeno">Assinado em 29/10/2026 · Ibirité/MG</p>
        <ul class="termos">
          <li>Preço total: <b>${brl(CONTRATO.precoTotal)}</b> (venda <i>ad corpus</i>, terreno de posse)</li>
          <li>Sinal: <b>${brl(CONTRATO.sinal)}</b> direto ao vendedor</li>
          <li>Corretagem: <b>${brl(CONTRATO.corretagem)}</b> à J Lima Immobile</li>
          <li><b>22 parcelas de ${brl(CONTRATO.valorParcela)}</b>, todo dia 15, a partir de 15/11/2026</li>
          <li>Parcela única de <b>${brl(CONTRATO.balao.valor)}</b> em 15/10/2027 (não acumula com a mensal)</li>
          <li>Atraso: multa de 10% + juros de 1% ao mês</li>
          <li>Atraso &gt; 90 dias: restituição do imóvel, multa de 35% (Cl. 3ª)</li>
          <li>Cessão a terceiro: 5% do valor da venda ao vendedor (Cl. 6ª)</li>
        </ul>
        ${acoesContrato('promessa')}
      </div>
      <div class="card contrato-card">
        <h2>📄 Administração e Cobrança</h2>
        <p class="muted pequeno">Contratada: ${esc(CONTRATO.administradora)}</p>
        <ul class="termos">
          <li>Taxa de administração: <b>10%</b> sobre o valor efetivamente arrecadado em cada parcela</li>
          <li>Repasse líquido em até <b>5 dias úteis</b> após a compensação</li>
          <li>Conta de repasse: ${esc(CONTRATO.repasse)}</li>
          <li>Relatório mensal de recebimentos e inadimplência</li>
          <li>Sem garantia de pagamento — risco de inadimplência é do vendedor</li>
          <li>Custas de protesto e notificações por conta da J Lima</li>
          <li>Vigência: 22 meses, prorrogável</li>
        </ul>
        ${acoesContrato('adm')}
      </div>
    </div>`;
}

async function renderAjustes(c) {
  const a = getAuth(), s = getSessao();
  c.innerHTML = `
    <div class="card">
      <h3>Conta</h3>
      <div class="ajuste"><div><b>${esc(a?.usuario)}</b><br><span class="pequeno muted">Login em ${new Date(s.loginEm).toLocaleString('pt-BR')} · expira ${new Date(s.loginEm + SESSAO_MS).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span></div></div>
      <div class="ajuste"><div>Alterar usuário e senha</div><button class="btn btn-cinza btn-peq" id="aj-senha">Alterar</button></div>
      <div class="ajuste"><div>Sair agora</div><button class="btn btn-perigo btn-peq" id="aj-sair">Sair</button></div>
    </div>
    <div class="card">
      <h3>Aplicativo</h3>
      <div class="ajuste"><div>${estaInstalado() ? '✅ Instalado neste aparelho' : 'Instalar na tela inicial'}</div>${estaInstalado() ? '' : '<button class="btn btn-primario btn-peq btn-instalar">📲 Instalar</button>'}</div>
      <div class="ajuste"><div>Espaço usado<br><span class="pequeno muted" id="aj-espaco">calculando…</span></div></div>
    </div>
    <div class="card">
      <h3>Backup</h3>
      <p class="pequeno muted">Tudo fica salvo só neste aparelho. O backup leva parcelas, comprovantes, contratos anexados e o login — use para guardar uma cópia ou passar para outro celular/PC.</p>
      <div class="ajuste"><div><b>Enviar atualização por link</b><br><span class="pequeno muted">Mais fácil: quem recebe só toca no link (sem comprovantes)</span></div><button class="btn btn-verde btn-peq" data-enviar-link>Enviar</button></div>
      <div class="ajuste"><div>Baixar backup<br><span class="pequeno muted">Salva o arquivo .json em Downloads</span></div><button class="btn btn-verde btn-peq" id="aj-exportar">Baixar</button></div>
      ${navigator.canShare ? `<div class="ajuste"><div>Enviar para outro aparelho<br><span class="pequeno muted">WhatsApp, Drive, e-mail…</span></div><button class="btn btn-verde btn-peq" id="aj-compartilhar">Enviar</button></div>` : ''}
      <div class="ajuste"><div>Importar backup<br><span class="pequeno muted">No aparelho novo: escolha o arquivo .json</span></div><button class="btn btn-cinza btn-peq" id="aj-importar">Importar</button></div>
      <p class="pequeno muted" style="margin:.4rem 0 0">Último backup: ${localStorage.getItem('rt_ultimo_backup') ? new Date(+localStorage.getItem('rt_ultimo_backup')).toLocaleString('pt-BR') : 'nunca'}</p>
    </div>
    <div class="card">
      <h3>Zona de perigo</h3>
      <div class="ajuste"><div>Apagar todos os dados e o acesso</div><button class="btn btn-perigo btn-peq" id="aj-apagar">Apagar</button></div>
    </div>
    <p class="pequeno muted" style="text-align:center">Venda do Terreno · v1.6</p>`;
  atualizarBotoesInstalar();
  $$('.btn-instalar', c).forEach(b => b.onclick = instalar);
  $('#aj-senha').onclick = modalSenha;
  $('#aj-sair').onclick = () => sair();
  $('#aj-exportar').onclick = () => exportarBackup(false);
  if ($('#aj-compartilhar')) $('#aj-compartilhar').onclick = () => exportarBackup(true);
  $('#aj-importar').onclick = () => $('#input-backup').click();
  $('#aj-apagar').onclick = async () => {
    if (prompt('Isso apaga TODOS os dados, comprovantes e o login deste aparelho.\nDigite APAGAR para confirmar:') !== 'APAGAR') return;
    await apagarTudo(); mostrarLogin(); toast('Tudo apagado.');
  };
  try {
    const ls = new Blob([JSON.stringify(DADOS)]).size;
    const fs = (await arq.todos()).reduce((s, f) => s + (f.blob?.size || 0), 0);
    let txt = `Dados: ${fmtTam(ls)} · Comprovantes e contratos: ${fmtTam(fs)}`;
    if (navigator.storage?.estimate) { const e = await navigator.storage.estimate(); txt += ` · Disponível: ${fmtTam(Math.max(0, e.quota - e.usage))}`; }
    const el = $('#aj-espaco'); if (el) el.textContent = txt;
  } catch { }
}

function modalSenha() {
  const a = getAuth();
  abrirModal('Alterar acesso', `
    <form id="f-senha" class="form-grid">
      <label>Senha atual<input type="password" id="s-atual" required autocomplete="current-password"></label>
      <label>Novo usuário<input type="text" id="s-user" value="${esc(a.usuario)}" required autocapitalize="none" minlength="3"></label>
      <label>Nova senha<input type="password" id="s-nova" required minlength="4" autocomplete="new-password"></label>
      <label>Confirmar nova senha<input type="password" id="s-conf" required minlength="4" autocomplete="new-password"></label>
      <p class="erro hidden" id="s-erro"></p>
      <div class="acoes-modal"><button type="button" class="btn btn-cinza" data-fechar>Cancelar</button><button class="btn btn-primario">Salvar</button></div>
    </form>`);
  $('#f-senha').onsubmit = async e => {
    e.preventDefault();
    const err = m => { $('#s-erro').textContent = m; $('#s-erro').classList.remove('hidden'); };
    if (!(await confereSenha($('#s-atual').value, a))) return err('Senha atual incorreta.');
    if ($('#s-nova').value !== $('#s-conf').value) return err('As novas senhas não conferem.');
    const salt = novoSalt();
    localStorage.setItem(LS_AUTH, JSON.stringify({ usuario: $('#s-user').value.trim(), salt, hash: await hashSenha($('#s-nova').value, salt), criadoEm: a.criadoEm }));
    fecharModal(); toast('Acesso atualizado.'); render();
  };
}

/* ---------- Modal ---------- */
function abrirModal(titulo, html) {
  $('#modal-titulo').textContent = titulo; $('#modal-corpo').innerHTML = html;
  $('#modal').classList.remove('hidden'); document.body.style.overflow = 'hidden';
  $('#modal-corpo').scrollTop = 0;
}
function fecharModal() { $('#modal').classList.add('hidden'); document.body.style.overflow = ''; }

/* ---------- Detalhe / registro de pagamento ---------- */
let EDIT = null;
function abrirItem(id) {
  const it = item(id); if (!it) return;
  EDIT = id;
  const adm = cobradoPelaAdm(it);
  const nota = { sinal: 'Pago diretamente ao vendedor (PagBank/PIX). Sem taxa de administração.', corretagem: 'Valor devido à J Lima Immobile pela intermediação. Não é receita do vendedor — apenas registro.', balao: 'Cláusula 2ª, item 4: no mês de outubro/2027 vale só esta parcela (não acumula com a mensal).', mensal: '' }[it.tipo];
  abrirModal(it.rotulo, `
    <div class="linha"><span class="muted">Vencimento <b style="color:var(--texto)">${fmtData(it.venc)}</b></span><span class="tag st-${status(it).k}">${status(it).t}</span></div>
    <div class="linha" style="margin-top:.3rem"><span class="muted">Valor do contrato</span><b style="font-size:1.25rem">${brl(it.valor)}</b></div>
    ${nota ? `<p class="pequeno muted" style="margin:.5rem 0 0">${nota}</p>` : ''}

    <div class="secao">
      <h3>💵 Pagamento</h3>
      <label class="switch">Pago<input type="checkbox" id="e-pago" ${it.pago ? 'checked' : ''}></label>
      <div id="bloco-pg" class="form-grid ${it.pago ? '' : 'hidden'}">
        <div class="dois">
          <label>Data do pagamento<input type="date" id="e-dataPg" value="${it.dataPg || hojeISO()}"></label>
          <label>Forma<select id="e-forma">${['', 'PIX', 'Boleto', 'Transferência', 'Dinheiro', 'Depósito'].map(f => `<option ${f === it.formaPg ? 'selected' : ''} value="${f}">${f || 'Selecione'}</option>`).join('')}</select></label>
        </div>
        ${adm ? `<div class="dois">
          <label>Multa (10%)<input type="number" step="0.01" min="0" inputmode="decimal" id="e-multa" value="${it.multa || 0}"></label>
          <label>Juros (1% a.m.)<input type="number" step="0.01" min="0" inputmode="decimal" id="e-juros" value="${it.juros || 0}"></label>
        </div>
        <button type="button" class="btn btn-cinza btn-peq" id="e-calc">↻ Calcular encargos pela data</button>` : ''}
        <label>Valor efetivamente pago<input type="number" step="0.01" min="0" inputmode="decimal" id="e-valorPago" value="${it.pago ? totalPago(it) : it.valor}"></label>
        <div class="resumo" id="e-resumo"></div>
        <div><b class="pequeno">Comprovantes de pagamento</b>
          <div class="anexos" id="anx-pg"></div>
          <button type="button" class="btn btn-outline btn-peq" style="margin-top:.5rem" data-anexar="pg">📎 Anexar comprovante</button></div>
      </div>
    </div>

    ${adm ? `<div class="secao" id="sec-rep">
      <h3>🔁 Repasse ao vendedor</h3>
      <p class="pequeno muted" style="margin:0 0 .3rem">J Lima repassa o líquido (−10%) em até 5 dias úteis: ${esc(CONTRATO.repasse)}</p>
      <label class="switch">Repasse recebido<input type="checkbox" id="e-rep" ${it.repassado ? 'checked' : ''}></label>
      <div id="bloco-rep" class="form-grid ${it.repassado ? '' : 'hidden'}">
        <div class="dois">
          <label>Data do repasse<input type="date" id="e-dataRep" value="${it.dataRepasse || hojeISO()}"></label>
          <label>Valor repassado<input type="number" step="0.01" min="0" inputmode="decimal" id="e-valorRep" value="${it.valorRepasse ?? liquido(it)}"></label>
        </div>
        <div><b class="pequeno">Comprovantes de repasse</b>
          <div class="anexos" id="anx-rep"></div>
          <button type="button" class="btn btn-outline btn-peq" style="margin-top:.5rem" data-anexar="rep">📎 Anexar comprovante</button></div>
      </div>
    </div>` : ''}

    <div class="secao"><label>Observações<textarea id="e-obs" placeholder="Ex.: boleto enviado por WhatsApp, acordo de atraso…">${esc(it.obs)}</textarea></label></div>

    <div class="acoes-modal"><button class="btn btn-cinza" data-fechar>Cancelar</button><button class="btn btn-primario" id="e-salvar">Salvar</button></div>
  `);

  const atualizarResumo = () => {
    const vp = Number($('#e-valorPago').value) || 0;
    const tx = adm ? r2(vp * CONTRATO.taxaAdm) : 0;
    $('#e-resumo').innerHTML = `
      <div class="linha"><span>Valor da parcela</span><span>${brl(it.valor)}</span></div>
      ${adm ? `<div class="linha"><span>Multa + juros</span><span>${brl((Number($('#e-multa').value) || 0) + (Number($('#e-juros').value) || 0))}</span></div>` : ''}
      <div class="linha"><span>Total pago</span><b>${brl(vp)}</b></div>
      ${adm ? `<div class="linha"><span>Taxa adm. J Lima (10%)</span><span>− ${brl(tx)}</span></div>
      <div class="linha total"><span>Líquido a repassar</span><span>${brl(vp - tx)}</span></div>
      <div class="linha pequeno muted"><span>Repasse até</span><span>${fmtData(addDiasUteis($('#e-dataPg').value || hojeISO(), CONTRATO.diasRepasse))}</span></div>` : ''}`;
  };
  const somarTotal = () => { $('#e-valorPago').value = r2(it.valor + (Number($('#e-multa')?.value) || 0) + (Number($('#e-juros')?.value) || 0)).toFixed(2); atualizarResumo(); };
  const calcular = () => { const e = encargos(it, $('#e-dataPg').value); $('#e-multa').value = e.multa.toFixed(2); $('#e-juros').value = e.juros.toFixed(2); somarTotal(); if (e.dias > 0) toast(`${e.dias} dia(s) de atraso: multa ${brl(e.multa)} + juros ${brl(e.juros)}`); };

  $('#e-pago').onchange = e => { $('#bloco-pg').classList.toggle('hidden', !e.target.checked); if (e.target.checked && adm && !it.pago) calcular(); };
  if (adm) {
    $('#e-calc').onclick = calcular;
    $('#e-multa').oninput = somarTotal; $('#e-juros').oninput = somarTotal;
    $('#e-rep').onchange = e => { $('#bloco-rep').classList.toggle('hidden', !e.target.checked); if (e.target.checked) $('#e-valorRep').value = r2((Number($('#e-valorPago').value) || 0) * (1 - CONTRATO.taxaAdm)).toFixed(2); };
  }
  $('#e-valorPago').oninput = atualizarResumo;
  $('#e-dataPg').onchange = () => { if (adm) calcular(); else atualizarResumo(); };
  $('#e-salvar').onclick = salvarItem;
  atualizarResumo();
  renderAnexos(it);
}

function salvarItem() {
  const it = item(EDIT); if (!it) return;
  const adm = cobradoPelaAdm(it);
  it.pago = $('#e-pago').checked;
  if (it.pago) {
    it.dataPg = $('#e-dataPg').value || hojeISO();
    it.formaPg = $('#e-forma').value;
    it.multa = adm ? r2($('#e-multa').value) : 0;
    it.juros = adm ? r2($('#e-juros').value) : 0;
    it.valorPago = r2($('#e-valorPago').value);
  } else {
    Object.assign(it, { dataPg: '', formaPg: '', multa: 0, juros: 0, valorPago: null, repassado: false, dataRepasse: '', valorRepasse: null });
  }
  if (adm && it.pago) {
    it.repassado = $('#e-rep').checked;
    it.dataRepasse = it.repassado ? ($('#e-dataRep').value || hojeISO()) : '';
    it.valorRepasse = it.repassado ? r2($('#e-valorRep').value) : null;
  }
  it.obs = $('#e-obs').value.trim();
  it.atualizadoEm = new Date().toISOString();
  if (salvarDados()) { fecharModal(); render(); toast('Salvo!'); }
}

async function renderAnexos(it) {
  for (const tipo of ['pg', 'rep']) {
    const box = $('#anx-' + tipo); if (!box) continue;
    const ids = it.anexos[tipo];
    if (!ids.length) { box.innerHTML = '<span class="pequeno muted">Nenhum comprovante anexado.</span>'; continue; }
    const html = [];
    for (const id of ids) {
      const f = await arq.get(id).catch(() => null);
      if (!f) { html.push(`<div class="anexo"><div class="pdf">?</div><span class="anexo-nome muted">Arquivo não encontrado</span><button class="icone-btn" data-remover="${tipo}|${id}">🗑</button></div>`); continue; }
      const isImg = f.tipo.startsWith('image/');
      const thumb = isImg ? `<img src="${URL.createObjectURL(f.blob)}" alt="">` : `<div class="pdf">PDF</div>`;
      html.push(`<div class="anexo">${thumb}<span class="anexo-nome" data-ver="${id}">${esc(f.nome)}<br><span class="muted">${fmtTam(f.blob.size)} · ${new Date(f.criadoEm).toLocaleDateString('pt-BR')}</span></span>
        <button class="icone-btn" data-ver="${id}" title="Ver">👁</button><button class="icone-btn" data-remover="${tipo}|${id}" title="Remover">🗑</button></div>`);
    }
    box.innerHTML = html.join('');
  }
}

let anexarDestino = null;
async function onArquivoEscolhido(e) {
  const file = e.target.files[0]; e.target.value = '';
  if (!file || !anexarDestino) return;
  if (anexarDestino.startsWith('contrato:')) {
    const k = anexarDestino.split(':')[1];
    if (file.type !== 'application/pdf') return toast('Escolha o arquivo PDF do contrato.');
    try {
      await arq.put({ id: 'contrato-' + k, nome: CONTRATOS_ARQ[k], tipo: 'application/pdf', blob: file, categoria: 'contrato', criadoEm: Date.now() });
      toast('Contrato anexado.'); render();
    } catch (err) { alert('Não foi possível salvar o contrato. ' + (err?.message || '')); }
    return;
  }
  const it = item(EDIT); if (!it) return;
  if (!/^image\/|application\/pdf/.test(file.type)) return toast('Envie uma imagem ou PDF.');
  if (file.type === 'application/pdf' && file.size > 8 * 1048576) return toast('PDF muito grande (máx. 8 MB).');
  toast('Salvando comprovante…', 1500);
  const blob = await comprimirImagem(file);
  const tipoFinal = blob === file ? file.type : 'image/jpeg';
  const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  let nome = file.name || (tipoFinal === 'application/pdf' ? 'comprovante.pdf' : 'comprovante.jpg');
  if (tipoFinal === 'image/jpeg' && !/\.jpe?g$/i.test(nome)) nome = nome.replace(/\.[^.]+$/, '') + '.jpg';
  try {
    await arq.put({ id, nome, tipo: tipoFinal, blob, item: it.id, categoria: anexarDestino, criadoEm: Date.now() });
    it.anexos[anexarDestino].push(id); salvarDados();
    renderAnexos(it);
    toast(blob !== file ? `Comprovante anexado (${fmtTam(file.size)} → ${fmtTam(blob.size)})` : 'Comprovante anexado.');
  } catch (err) { alert('Não foi possível salvar o comprovante (sem espaço?). ' + (err?.message || '')); }
}

async function verArquivo(id) {
  const f = await arq.get(id); if (!f) return toast('Arquivo não encontrado.');
  const url = URL.createObjectURL(f.blob);
  if (f.tipo.startsWith('image/')) { $('#visor-img').src = url; $('#visor').classList.remove('hidden'); }
  else { const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; if (/Android/i.test(navigator.userAgent)) a.download = f.nome; a.click(); }
}
async function baixarArquivo(id) {
  const f = await arq.get(id); if (!f) return toast('Arquivo não encontrado.');
  const a = document.createElement('a'); a.href = URL.createObjectURL(f.blob); a.download = f.nome; a.click();
}
async function removerArquivo(tipo, id) {
  if (!confirm('Remover este comprovante?')) return;
  const it = item(EDIT);
  it.anexos[tipo] = it.anexos[tipo].filter(x => x !== id); salvarDados();
  await arq.del(id).catch(() => { });
  renderAnexos(it); toast('Comprovante removido.');
}

/* ---------- Backup ---------- */
const blobParaDataURL = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
async function montarBackup(quando = Date.now()) {
  await filaGravacao;
  const arquivos = [];
  for (const f of await arq.todos()) arquivos.push({ ...f, blob: undefined, data: await blobParaDataURL(f.blob) });
  const authSalvo = localStorage.getItem(LS_AUTH);
  const json = JSON.stringify({ app: 'venda-terreno', versao: 2, exportadoEm: new Date(quando).toISOString(), dados: DADOS, auth: authSalvo ? JSON.parse(authSalvo) : null, arquivos });
  return { json, base: `backup-venda-terreno-${hojeISO()}`, nArquivos: arquivos.length };
}
async function exportarBackup(compartilhar) {
  toast('Gerando backup…');
  const { json, base } = await montarBackup();
  const blob = new Blob([json], { type: 'application/json' });
  const baixar = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = base + '.json'; a.click(); };
  if (compartilhar) {
    // 1º toque: monta o backup. 2º toque (abaixo): abre o compartilhar na hora — o Android exige
    // que o compartilhamento venha direto de um toque, senão nega a permissão.
    const arquivo = new File([json], base + '.txt', { type: 'text/plain' });
    const podeEnviar = navigator.canShare && navigator.canShare({ files: [arquivo] });
    $('#toast').classList.add('hidden');
    abrirModal('Backup pronto', `
      <p style="margin-top:0">Arquivo <b>${base}.txt</b> (${fmtTam(arquivo.size)}) com parcelas, comprovantes, contratos e login.</p>
      ${podeEnviar ? '<button class="btn btn-verde btn-bloco" id="bk-share">📤 Enviar pelo WhatsApp / Drive</button>' :
        '<div class="alerta amarelo">⚠️<div>Este navegador não permite enviar direto. Salve o arquivo e, no WhatsApp, toque no clipe 📎 → <b>Documento</b> e escolha o backup.</div></div>'}
      <button class="btn btn-cinza btn-bloco" id="bk-salvar" style="margin-top:.6rem">💾 Salvar em Downloads</button>
      <p class="pequeno muted">Quem receber abre o app e vai em Ajustes → Importar backup.</p>`);
    $('#bk-salvar').onclick = () => { baixar(); localStorage.setItem('rt_ultimo_backup', Date.now()); toast('Backup salvo em Downloads.'); };
    if (podeEnviar) $('#bk-share').onclick = () => {
      navigator.share({ files: [arquivo], title: 'Backup – Venda do Terreno' })
        .then(() => { localStorage.setItem('rt_ultimo_backup', Date.now()); fecharModal(); toast('Backup enviado.'); })
        .catch(e => { if (e.name !== 'AbortError') alert('O celular não liberou o compartilhamento (' + e.message + ').\nUse "Salvar em Downloads" e anexe no WhatsApp pelo clipe 📎 → Documento.'); });
    };
    return;
  } else baixar();
  localStorage.setItem('rt_ultimo_backup', Date.now());
  toast(`Backup gerado (${fmtTam(blob.size)}).`);
  if (VIEW === 'ajustes') render();
}
async function importarBackup(e) {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  try {
    const b = JSON.parse(await file.text());
    if (b.app !== 'venda-terreno' || !b.dados?.itens) throw new Error('Arquivo de backup inválido.');
    if (!confirm(`Restaurar backup de ${new Date(b.exportadoEm).toLocaleString('pt-BR')}?\nOs dados atuais serão substituídos.`)) return;
    toast('Restaurando…', 4000);
    await restaurarBackup(b, true);
    render(); toast(`Backup restaurado! ${b.dados.itens.filter(i => i.pago).length} pagamentos e ${(b.arquivos || []).length} arquivos.`);
  } catch (err) { alert('Erro ao restaurar: ' + err.message); }
}
async function restaurarBackup(b, comLogin) {
  await arq.limpar();
  for (const f of b.arquivos || []) { const blob = await (await fetch(f.data)).blob(); await arq.put({ ...f, data: undefined, blob }); }
  DADOS = b.dados; DADOS.ultimaAtualizacaoLink = Math.max(DADOS.ultimaAtualizacaoLink || 0, new Date(b.exportadoEm).getTime());
  await arq.kvPut('dados', DADOS);
  if (comLogin) { if (b.auth) localStorage.setItem(LS_AUTH, JSON.stringify(b.auth)); else localStorage.removeItem(LS_AUTH); }
}
async function apagarTudo() {
  [LS_DADOS, LS_AUTH, LS_SESSAO, LS_TENT].forEach(k => localStorage.removeItem(k));
  await arq.limpar().catch(() => { });
  await arq.kvLimpar().catch(() => { });
  await carregarDados();
}

/* ---------- Atualização por link (WhatsApp) ----------
   Vai no link só o estado dos pagamentos (sem comprovantes/contratos). Quem recebe toca no link,
   entra (se a sessão tiver expirado) e o sistema atualiza sozinho. */
const CAMPOS_LINK = ['pago', 'dataPg', 'formaPg', 'multa', 'juros', 'valorPago', 'repassado', 'dataRepasse', 'valorRepasse', 'obs'];
const PADRAO_LINK = { pago: false, dataPg: '', formaPg: '', multa: 0, juros: 0, valorPago: null, repassado: false, dataRepasse: '', valorRepasse: null, obs: '' };
const LS_IMPORT = 'rt_import_pendente';
const b64url = bytes => { let t = ''; bytes.forEach(b => t += String.fromCharCode(b)); return btoa(t).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const deB64url = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
async function compactar(txt) {
  const bytes = new TextEncoder().encode(txt);
  if (!window.CompressionStream) return 'j' + b64url(bytes);
  const buf = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
  return 'z' + b64url(new Uint8Array(buf));
}
async function descompactar(s) {
  const bytes = deB64url(s.slice(1));
  if (s[0] === 'j') return new TextDecoder().decode(bytes);
  return await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
}
async function gerarLinkAtualizacao(quando = Date.now()) {
  await filaGravacao;
  const i = {};
  DADOS.itens.forEach(it => { if (it.pago || it.obs) i[it.id] = CAMPOS_LINK.map(c => it[c]); });
  const cod = await compactar(JSON.stringify({ v: 1, t: quando, i }));
  return location.origin + location.pathname + '#importar=' + cod;
}
async function enviarAtualizacao() {
  toast('Preparando atualização…', 4000);
  const agora = Date.now();
  const url = await gerarLinkAtualizacao(agora);
  const { json, base, nArquivos } = await montarBackup(agora);
  const arquivo = new File([json], base + '.txt', { type: 'text/plain' });
  const podeArquivo = !!(navigator.canShare && navigator.canShare({ files: [arquivo] }));
  const r = resumo();
  const msg = `📋 *Venda do Terreno* – atualização de ${fmtData(hojeISO())}\n${r.pagasParc} de ${r.totalParc} parcelas pagas.\n\n👉 Toque no link para atualizar o sistema:\n${url}\n\n📎 Comprovantes: no arquivo que vou mandar em seguida, segure o dedo › Compartilhar › *Venda Terreno*.`;
  $('#toast').classList.add('hidden');
  abrirModal('Enviar atualização', `
    <p style="margin-top:0">Envie as <b>duas coisas</b> para a mesma conversa:</p>
    <a class="btn btn-verde btn-bloco" href="https://wa.me/?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener" id="lk-wa">1️⃣ Enviar link pelo WhatsApp</a>
    <p class="pequeno muted" style="margin:.3rem 0 .9rem">Atualiza os pagamentos com um toque.</p>
    ${podeArquivo ? `<button class="btn btn-outline btn-bloco" id="lk-arquivo">2️⃣ Enviar arquivo com comprovantes</button>
      <p class="pequeno muted" style="margin:.3rem 0 .9rem">${nArquivos} comprovante(s)/contrato(s) · ${fmtTam(arquivo.size)}. Quem recebe: segura o dedo no arquivo › Compartilhar › Venda Terreno.</p>`
      : `<button class="btn btn-outline btn-bloco" id="lk-baixar">2️⃣ Salvar arquivo com comprovantes</button>
      <p class="pequeno muted" style="margin:.3rem 0 .9rem">Depois, no WhatsApp: clipe 📎 › Documento › escolha o arquivo.</p>`}
    <button class="btn btn-cinza btn-bloco" id="lk-copiar">📋 Copiar mensagem do link</button>`);
  $('#lk-copiar').onclick = () => navigator.clipboard.writeText(msg).then(() => toast('Mensagem copiada. Cole no WhatsApp.')).catch(() => prompt('Copie a mensagem:', msg));
  if ($('#lk-arquivo')) $('#lk-arquivo').onclick = () => navigator.share({ files: [arquivo], text: 'Comprovantes – Venda do Terreno (segure o dedo › Compartilhar › Venda Terreno)' })
    .then(() => { localStorage.setItem('rt_ultimo_backup', Date.now()); toast('Arquivo enviado.'); })
    .catch(e => { if (e.name !== 'AbortError') alert('O celular não liberou o compartilhamento (' + e.message + ').'); });
  if ($('#lk-baixar')) $('#lk-baixar').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(arquivo); a.download = base + '.txt'; a.click(); localStorage.setItem('rt_ultimo_backup', Date.now()); };
}

/* ---------- Receber arquivo compartilhado (WhatsApp › Compartilhar › Venda Terreno) ---------- */
const CACHE_RECEBIDO = 'venda-terreno-recebido';
const chaveRecebido = () => new URL('__backup-recebido', location.href).href;
async function lerBackupRecebido() {
  if (!window.caches) return null;
  const c = await caches.open(CACHE_RECEBIDO); const r = await c.match(chaveRecebido());
  return r ? await r.text() : null;
}
async function limparBackupRecebido() { if (window.caches) await (await caches.open(CACHE_RECEBIDO)).delete(chaveRecebido()); }
async function aplicarBackupRecebido(forcar) {
  const txt = await lerBackupRecebido().catch(() => null); if (!txt || !DADOS) return;
  let b;
  try { b = JSON.parse(txt); if (b.app !== 'venda-terreno' || !b.dados?.itens) throw 0; }
  catch { await limparBackupRecebido(); return abrirModal('Arquivo inválido', '<p>Este arquivo não é um backup do Venda do Terreno.</p><button class="btn btn-primario btn-bloco" data-fechar>OK</button>'); }
  const t = new Date(b.exportadoEm).getTime();
  const quando = new Date(t).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  const editadoDepois = DADOS.itens.some(it => it.atualizadoEm && new Date(it.atualizadoEm).getTime() > t);
  if (!forcar && (editadoDepois || (DADOS.ultimaAtualizacaoLink || 0) > t)) {
    abrirModal('Atenção', `<p>Este arquivo é de <b>${quando}</b> e há informações mais novas neste aparelho. Se continuar, elas serão substituídas.</p>
      <button class="btn btn-primario btn-bloco" id="rb-forcar">Atualizar mesmo assim</button>
      <button class="btn btn-cinza btn-bloco" style="margin-top:.6rem" id="rb-cancelar">Manter como está</button>`);
    $('#rb-forcar').onclick = () => { fecharModal(); aplicarBackupRecebido(true); };
    $('#rb-cancelar').onclick = async () => { await limparBackupRecebido(); fecharModal(); };
    return;
  }
  abrirModal('Recebendo…', '<p>Atualizando pagamentos e comprovantes…</p>');
  await restaurarBackup(b, false);
  await limparBackupRecebido();
  irPara('inicio');
  const r = resumo();
  abrirModal('Sistema atualizado ✅', `<p style="font-size:1.05rem;margin-top:0">Arquivo de <b>${quando}</b> recebido, com <b>${(b.arquivos || []).length}</b> comprovante(s)/contrato(s).</p>
    <p><b>${r.pagasParc} de ${r.totalParc}</b> parcelas pagas · recebido ${brl(r.recebidoBruto)}</p>
    <button class="btn btn-primario btn-bloco" data-fechar>OK</button>`);
}

function capturarLinkImportacao() {
  if (!location.hash.startsWith('#importar=')) return false;
  localStorage.setItem(LS_IMPORT, location.hash.slice(10));
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}
async function aplicarImportacaoPendente(forcar) {
  const cod = localStorage.getItem(LS_IMPORT); if (!cod || !DADOS) return;
  let p;
  try { p = JSON.parse(await descompactar(cod)); if (p.v !== 1 || !p.i) throw 0; }
  catch { localStorage.removeItem(LS_IMPORT); return abrirModal('Link inválido', '<p>Este link de atualização está incompleto ou corrompido. Peça para enviarem de novo.</p><button class="btn btn-primario btn-bloco" data-fechar>OK</button>'); }
  const quando = new Date(p.t).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  if (!forcar && (DADOS.ultimaAtualizacaoLink || 0) > p.t) {
    localStorage.removeItem(LS_IMPORT);
    return abrirModal('Link antigo', `<p>Este link é de <b>${quando}</b>, mais antigo que a última atualização já recebida. Nada foi alterado.</p><button class="btn btn-primario btn-bloco" data-fechar>OK</button>`);
  }
  const editadoDepois = DADOS.itens.some(it => it.atualizadoEm && new Date(it.atualizadoEm).getTime() > p.t);
  if (!forcar && editadoDepois) {
    abrirModal('Atenção', `<p>Há lançamentos feitos <b>neste aparelho</b> depois do envio deste link (${quando}). Se atualizar, eles serão substituídos.</p>
      <button class="btn btn-primario btn-bloco" id="lk-forcar">Atualizar mesmo assim</button>
      <button class="btn btn-cinza btn-bloco" style="margin-top:.6rem" id="lk-cancelar">Manter como está</button>`);
    $('#lk-forcar').onclick = () => { fecharModal(); aplicarImportacaoPendente(true); };
    $('#lk-cancelar').onclick = () => { localStorage.removeItem(LS_IMPORT); fecharModal(); };
    return;
  }
  DADOS.itens.forEach(it => {
    const v = p.i[it.id];
    CAMPOS_LINK.forEach((c, k) => { it[c] = v ? v[k] : PADRAO_LINK[c]; });
    delete it.atualizadoEm; // anexos locais são mantidos
  });
  DADOS.ultimaAtualizacaoLink = p.t;
  salvarDados(); localStorage.removeItem(LS_IMPORT);
  irPara('inicio');
  const r = resumo();
  abrirModal('Sistema atualizado ✅', `<p style="font-size:1.05rem;margin-top:0">Atualização de <b>${quando}</b> recebida.</p>
    <p><b>${r.pagasParc} de ${r.totalParc}</b> parcelas pagas · recebido ${brl(r.recebidoBruto)}</p>
    <button class="btn btn-primario btn-bloco" data-fechar>OK</button>`);
}

/* ---------- Inicialização ---------- */
async function entrarApp() {
  $('#tela-login').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#conteudo').innerHTML = '<p class="muted" style="text-align:center">Carregando…</p>';
  try { await carregarDados(); } catch (e) { alert('Erro ao abrir os dados do aparelho: ' + e.message); }
  verificarSessao(); irPara(VIEW || 'inicio');
  await aplicarImportacaoPendente();
  aplicarBackupRecebido();
}

document.addEventListener('click', e => {
  if (e.target.closest('[data-enviar-link]')) return enviarAtualizacao();
  const t = e.target.closest('[data-abrir],[data-fechar],[data-filtro],[data-view],[data-anexar],[data-ver],[data-remover],[data-contrato],[data-baixar],.btn-instalar,.olho');
  if (!t) return;
  if (t.dataset.contrato) { anexarDestino = 'contrato:' + t.dataset.contrato; $('#input-arquivo').accept = 'application/pdf'; $('#input-arquivo').click(); $('#input-arquivo').accept = 'image/*,application/pdf'; return; }
  if (t.dataset.baixar) return baixarArquivo(t.dataset.baixar);
  if (t.matches('.olho')) { const i = $('#' + t.dataset.alvo); i.type = i.type === 'password' ? 'text' : 'password'; return; }
  if (t.matches('.btn-instalar')) return instalar();
  if (t.dataset.view) return irPara(t.dataset.view);
  if (t.dataset.filtro) { FILTRO = t.dataset.filtro; return render(); }
  if ('fechar' in t.dataset) return fecharModal();
  if (t.dataset.abrir) return abrirItem(t.dataset.abrir);
  if (t.dataset.anexar) { anexarDestino = t.dataset.anexar; return $('#input-arquivo').click(); }
  if (t.dataset.ver) return verArquivo(t.dataset.ver);
  if (t.dataset.remover) { const [tp, id] = t.dataset.remover.split('|'); return removerArquivo(tp, id); }
});
$('#visor').addEventListener('click', () => $('#visor').classList.add('hidden'));
$('#form-login').addEventListener('submit', onLogin);
$('#btn-esqueci').addEventListener('click', esqueciSenha);
$('#btn-sair-topo').addEventListener('click', () => { if (confirm('Sair do sistema?')) sair(); });
$('#input-arquivo').addEventListener('change', onArquivoEscolhido);
$('#input-backup').addEventListener('change', importarBackup);
document.addEventListener('keydown', e => { if (e.key === 'Escape') { $('#visor').classList.add('hidden'); fecharModal(); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden) verificarSessao(); });
window.addEventListener('storage', e => { if (e.key === LS_SESSAO && !sessaoValida()) sair(); });
setInterval(verificarSessao, 20000);

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  // Troca qualquer versão antiga guardada neste endereço (ex.: Elo CRM) pela atual
  // recarrega só quando substitui uma versão anterior (não no primeiro acesso)
  const tinhaVersaoAnterior = !!navigator.serviceWorker.controller;
  let recarregou = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!tinhaVersaoAnterior || recarregou) return;
    if (!$('#app').classList.contains('hidden') && !$('#modal').classList.contains('hidden')) return; // não interrompe um lançamento aberto
    recarregou = true; location.reload();
  });
  navigator.serviceWorker.register('sw.js?v=3', { updateViaCache: 'none' }).then(r => r.update()).catch(() => { });
  if (window.caches) caches.keys().then(ks => ks.filter(k => !k.startsWith('venda-terreno-')).forEach(k => caches.delete(k)));
}
atualizarBotoesInstalar();
let veioPorLink = capturarLinkImportacao();
if (location.hash === '#backup-recebido') { veioPorLink = true; history.replaceState(null, '', location.pathname + location.search); }
window.addEventListener('hashchange', () => { if (capturarLinkImportacao() && sessaoValida() && !$('#app').classList.contains('hidden')) aplicarImportacaoPendente(); });
if (sessaoValida()) entrarApp(); else {
  const havia = !!getSessao(); localStorage.removeItem(LS_SESSAO);
  mostrarLogin(veioPorLink || localStorage.getItem(LS_IMPORT) ? 'Entre com sua senha para receber a atualização.' : (havia ? 'Sua sessão expirou (limite de 6 horas). Entre novamente.' : ''));
}
