/**
 * estoque-xml.js - Integracao Compras <-> Estoque (contrato XML v2, /xml/estoque.xsd)
 *
 * Saida (Compras -> Estoque): recebimentos viram <movimentacoes><compra>, com external_id
 *   idempotente (reenviar o mesmo recebimento nao duplica entrada: indice (origem, external_id)).
 * Entrada (Estoque -> Compras): le <produtos>, devolve itens com estoque baixo como sugestao de pedido.
 *
 * Contratos do Compras, no padrao Finanweb (pasta /compras/contratos):
 *   gerarRecebimentos()  recebimento-v1.xsd        <movimento tipo="RECEBIMENTO">
 *   gerarPrevisoes()     previsao-entrega-v1.xsd   <movimento tipo="PREVISAO_ENTREGA">
 *   lerComprasEstoque()  le a confirmacao-recebimento-v1 do Estoque; aplicarConfirmacao() atualiza os recebimentos
 *   gerarConfirmacao()   gera a confirmacao (para o Estoque usar ou para testes)
 *
 * Disponibilidade (mesmo contrato que o Estoque responde ao Patrimonio, sem namespace):
 *   gerarConsultaDisponibilidade()  <consultaDisponibilidade>
 *   lerRespostaDisponibilidade()    <respostaDisponibilidade> com produto ou erro
 *
 * Uso no navegador: tag script com src="estoque-xml.js" -> window.EstoqueXML
 * Uso no Node:      const EstoqueXML = require('./estoque-xml.js')
 */
(function (root) {
  'use strict';

  const ORIGEM = 'COMPRAS';
  const SISTEMAS = ['ESTOQUE', 'COMPRAS', 'VENDAS', 'FINANCEIRO', 'MARKETING', 'RH', 'SAC', 'PATRIMONIO'];
  const MAX_INT = 2147483647;
  const RE_SKU = /^[A-Z0-9]+(-[A-Z0-9]+)*$/;
  const RE_DATA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

  // ---------------------------------------------------------------- utilitarios
  const esc = (v) => String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  const colapsar = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const agoraISO = () => new Date().toISOString(); // sempre com Z

  /** Normaliza um SKU digitado ("notebook 001" -> "NOTEBOOK-001"). */
  function normalizarSku(s) {
    return String(s ?? '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  /** Converte "1.234,56" | "1234.56" | 1234.56 -> "1234.56" (string com 2 casas). */
  function numeroPreco(v) {
    let s = String(v ?? '').trim().replace(/[R$\s]/g, '');
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    const n = s === '' ? NaN : Number(s);
    return Number.isFinite(n) ? n : null;
  }
  function formatarPreco(v) {
    const n = numeroPreco(v);
    return n === null ? null : n.toFixed(2);
  }

  // ---------------------------------------------------------------- validacoes (espelham o XSD)
  function vSku(v, ctx, e) {
    if (!RE_SKU.test(v || '') || v.length > 40) e.push(`${ctx}: SKU inv\u00e1lido "${v}" (A-Z, 0-9 e h\u00edfen, at\u00e9 40)`);
  }
  function vTexto(v, ctx, min, max, e) {
    const c = colapsar(v);
    if (c.length < min || c.length > max) e.push(`${ctx}: deve ter entre ${min} e ${max} caracteres`);
  }
  function vInteiro(v, ctx, minimo, e) {
    if (!Number.isInteger(v) || v < minimo || v > MAX_INT) e.push(`${ctx}: inteiro ${minimo === 0 ? '\u2265 0' : '> 0'} esperado, recebido "${v}"`);
  }
  function vPreco(v, ctx, e) {
    const n = numeroPreco(v);
    if (n === null || n < 0) return e.push(`${ctx}: pre\u00e7o inv\u00e1lido "${v}"`);
    if (Math.abs(Math.round(n * 100) - n * 100) > 1e-6) e.push(`${ctx}: pre\u00e7o com mais de 2 casas decimais`);
    if (n.toFixed(2).replace('.', '').replace(/^0+/, '').length > 12) e.push(`${ctx}: pre\u00e7o excede 12 d\u00edgitos`);
  }
  function vData(v, ctx, e) {
    if (!RE_DATA.test(v || '') || isNaN(Date.parse(v))) e.push(`${ctx}: data/hora ISO 8601 com fuso esperada, recebido "${v}"`);
  }

  // ---------------------------------------------------------------- geracao (Compras -> Estoque)
  /**
   * Gera o XML v2. Lanca Error({ erros: [...] }) se algo violar o contrato.
   * @param {object} lote
   *   { geradoEm?, loteId?, sistemaOrigem? = 'COMPRAS',
   *     produtos?: [{ sku, nome, descricao?, quantidade, preco, estoqueMinimo, finalidade? }],
   *     movimentacoes?: [{ tipo: 'compra'|'venda'|'ajuste', operacao?: 'ENTRADA'|'SAIDA',
   *                        sku, quantidade, origem?, externalId?, registradoEm? }] }
   */
  function gerarXml(lote) {
    const e = [];
    const sistema = lote.sistemaOrigem || ORIGEM;
    const geradoEm = lote.geradoEm || agoraISO();
    const produtos = lote.produtos || [];
    const movs = lote.movimentacoes || [];

    if (!SISTEMAS.includes(sistema)) e.push(`cabecalho: sistema_origem inv\u00e1lido "${sistema}"`);
    vData(geradoEm, 'cabecalho.gerado_em', e);
    if (lote.loteId != null) vTexto(lote.loteId, 'cabecalho.lote_id', 1, 100, e);

    const skus = new Set();
    produtos.forEach((p, i) => {
      const c = `produto[${i + 1}]`;
      vSku(p.sku, c, e);
      if (skus.has(p.sku)) e.push(`${c}: SKU ${p.sku} repetido no arquivo`);
      skus.add(p.sku);
      vTexto(p.nome, `${c}.nome`, 1, 120, e);
      if (p.descricao != null && p.descricao !== '') vTexto(p.descricao, `${c}.descricao`, 1, 500, e);
      vInteiro(p.quantidade, `${c}.quantidade`, 0, e);
      vPreco(p.preco, `${c}.preco`, e);
      vInteiro(p.estoqueMinimo, `${c}.estoque_minimo`, 0, e);
      if (p.finalidade && !['VENDA', 'USO_INTERNO'].includes(p.finalidade)) e.push(`${c}.finalidade inv\u00e1lida "${p.finalidade}"`);
    });

    const eventos = new Set();
    movs.forEach((m, i) => {
      const c = `movimentacao[${i + 1}]`;
      if (!['compra', 'venda', 'ajuste'].includes(m.tipo)) e.push(`${c}: tipo inv\u00e1lido "${m.tipo}"`);
      if (m.tipo === 'ajuste' && !['ENTRADA', 'SAIDA'].includes(m.operacao)) e.push(`${c}: ajuste exige operacao ENTRADA ou SAIDA`);
      if (m.tipo !== 'ajuste' && m.operacao) e.push(`${c}: ${m.tipo} n\u00e3o aceita operacao`);
      vSku(m.sku, c, e);
      vInteiro(m.quantidade, `${c}.quantidade`, 1, e);
      vTexto(m.origem || ORIGEM, `${c}.origem`, 1, 60, e);
      if (m.externalId != null) {
        vTexto(m.externalId, `${c}.external_id`, 1, 100, e);
        const k = `${colapsar(m.origem || ORIGEM)}|${colapsar(m.externalId)}`;
        if (eventos.has(k)) e.push(`${c}: evento (origem, external_id) repetido: ${k}`);
        eventos.add(k);
      }
      if (m.registradoEm) vData(m.registradoEm, `${c}.registrado_em`, e);
    });

    if (e.length) throw Object.assign(new Error('XML fora do contrato:\n- ' + e.join('\n- ')), { erros: e });

    const L = ['<?xml version="1.0" encoding="UTF-8"?>', '<estoque versao="2">', '  <cabecalho>',
      `    <sistema_origem>${sistema}</sistema_origem>`, `    <gerado_em>${geradoEm}</gerado_em>`];
    if (lote.loteId != null) L.push(`    <lote_id>${esc(colapsar(lote.loteId))}</lote_id>`);
    L.push('  </cabecalho>');

    if (produtos.length) {
      L.push('  <produtos>');
      for (const p of produtos) {
        L.push('    <produto>', `      <sku>${p.sku}</sku>`, `      <nome>${esc(colapsar(p.nome))}</nome>`);
        if (p.descricao) L.push(`      <descricao>${esc(colapsar(p.descricao))}</descricao>`);
        L.push(`      <quantidade>${p.quantidade}</quantidade>`,
          `      <preco moeda="BRL">${formatarPreco(p.preco)}</preco>`,
          `      <estoque_minimo>${p.estoqueMinimo}</estoque_minimo>`);
        if (p.finalidade) L.push(`      <finalidade>${p.finalidade}</finalidade>`);
        L.push('    </produto>');
      }
      L.push('  </produtos>');
    }

    if (movs.length) {
      L.push('  <movimentacoes>');
      for (const m of movs) {
        L.push(m.tipo === 'ajuste' ? `    <ajuste operacao="${m.operacao}">` : `    <${m.tipo}>`,
          `      <produto_sku>${m.sku}</produto_sku>`, `      <quantidade>${m.quantidade}</quantidade>`,
          `      <origem>${esc(colapsar(m.origem || ORIGEM))}</origem>`);
        if (m.externalId != null) L.push(`      <external_id>${esc(colapsar(m.externalId))}</external_id>`);
        if (m.registradoEm) L.push(`      <registrado_em>${m.registradoEm}</registrado_em>`);
        L.push(`    </${m.tipo}>`);
      }
      L.push('  </movimentacoes>');
    }
    L.push('</estoque>');
    return L.join('\n');
  }

  /**
   * Monta o lote a partir dos recebimentos do Compras.
   * Formato esperado (ajuste os nomes dos campos ao seu state):
   *   [{ id, pedidoNumero, recebidoEm, itens: [{ sku, nome, quantidade, preco }] }]
   * Itens do mesmo SKU no mesmo recebimento sao somados (um evento por SKU).
   * opts.incluirProdutos: tambem envia <produto> (quantidade 0) para o Estoque cadastrar SKUs novos,
   *   sem duplicar o saldo - quem soma e a <compra>. Use se o Estoque rejeitar compra de SKU inexistente.
   */
  function loteDeRecebimentos(recebimentos, opts = {}) {
    const movs = [];
    const produtos = new Map();
    for (const r of recebimentos) {
      const porSku = new Map();
      for (const it of r.itens || []) {
        const sku = normalizarSku(it.sku);
        const q = Math.trunc(Number(it.quantidade));
        if (!sku || !(q > 0)) continue;
        porSku.set(sku, (porSku.get(sku) || 0) + q);
        if (opts.incluirProdutos && !produtos.has(sku)) {
          produtos.set(sku, { sku, nome: it.nome || sku, quantidade: 0, preco: it.preco ?? 0,
            estoqueMinimo: 0, finalidade: it.finalidade || undefined });
        }
      }
      for (const [sku, quantidade] of porSku) {
        movs.push({ tipo: 'compra', sku, quantidade, origem: ORIGEM,
          externalId: `REC-${r.id ?? r.pedidoNumero}-${sku}`,
          registradoEm: r.recebidoEm ? new Date(r.recebidoEm).toISOString() : undefined });
      }
    }
    return {
      loteId: opts.loteId || `COMPRAS-${Date.now()}`,
      produtos: [...produtos.values()],
      movimentacoes: movs,
    };
  }

  // ---------------------------------------------------------------- leitura (Estoque -> Compras)
  /** Le o XML v2 (navegador: DOMParser). Retorna { cabecalho, produtos, movimentacoes }. */
  function lerXml(xmlString) {
    const doc = new DOMParser().parseFromString(xmlString, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('XML mal formado');
    const raiz = doc.documentElement;
    if (raiz.nodeName !== 'estoque') throw new Error('Raiz deve ser <estoque>');
    if (raiz.getAttribute('versao') !== '2') throw new Error('S\u00f3 a vers\u00e3o 2 do contrato \u00e9 aceita');

    const txt = (el, tag) => { const n = el.getElementsByTagName(tag)[0]; return n ? n.textContent.trim() : undefined; };
    const filhos = (el, tag) => el ? [...el.children].filter((c) => !tag || c.nodeName === tag) : [];
    const grupo = (tag) => filhos(raiz, tag)[0];

    const cab = grupo('cabecalho');
    if (!cab) throw new Error('<cabecalho> obrigat\u00f3rio');

    return {
      cabecalho: { sistemaOrigem: txt(cab, 'sistema_origem'), geradoEm: txt(cab, 'gerado_em'), loteId: txt(cab, 'lote_id') },
      produtos: filhos(grupo('produtos'), 'produto').map((p) => ({
        sku: txt(p, 'sku'), nome: txt(p, 'nome'), descricao: txt(p, 'descricao'),
        quantidade: parseInt(txt(p, 'quantidade'), 10), preco: Number(txt(p, 'preco')),
        estoqueMinimo: parseInt(txt(p, 'estoque_minimo'), 10), finalidade: txt(p, 'finalidade') || 'VENDA',
      })),
      movimentacoes: filhos(grupo('movimentacoes')).map((m) => ({
        tipo: m.nodeName, operacao: m.getAttribute('operacao') || undefined,
        sku: txt(m, 'produto_sku'), quantidade: parseInt(txt(m, 'quantidade'), 10),
        origem: txt(m, 'origem'), externalId: txt(m, 'external_id'), registradoEm: txt(m, 'registrado_em'),
      })),
    };
  }

  /**
   * Produtos com estoque baixo -> itens sugeridos para pedido de compra.
   * Repoe ate alvo = estoqueMinimo * fator (padrao 2). So finalidade VENDA, a menos que opts.todos.
   */
  function sugestoesDeCompra(produtos, opts = {}) {
    const fator = opts.fator ?? 2;
    return produtos
      .filter((p) => (opts.todos || p.finalidade !== 'USO_INTERNO') && p.quantidade <= p.estoqueMinimo)
      .map((p) => ({
        sku: p.sku, nome: p.nome, preco: p.preco,
        saldoAtual: p.quantidade, estoqueMinimo: p.estoqueMinimo,
        quantidade: Math.max(1, Math.ceil(p.estoqueMinimo * fator) - p.quantidade),
      }));
  }

  // ================================================================ CONTRATOS DO COMPRAS (padrao Finanweb)
  // recebimento-v1.xsd (urn:compras:recebimento:1.0)           Compras -> Estoque
  // previsao-entrega-v1.xsd (urn:compras:previsao-entrega:1.0) Compras -> Estoque
  // confirmacao-recebimento-v1.xsd (urn:compras:confirmacao-recebimento:1.0) Estoque -> Compras

  const NS_RECEB = 'urn:compras:recebimento:1.0';
  const NS_PREV = 'urn:compras:previsao-entrega:1.0';
  const NS_CONF = 'urn:compras:confirmacao-recebimento:1.0';
  const UNIDADES = ['UN', 'CX', 'PCT', 'KG', 'G', 'L', 'ML', 'M', 'PAR'];
  const ARMAZENAGENS = ['AMBIENTE', 'REFRIGERADO', 'CONGELADO', 'FRAGIL', 'INFLAMAVEL'];
  const MOTIVOS_AVARIA = ['QUEBRADO', 'VENCIDO', 'EMBALAGEM_VIOLADA', 'PRODUTO_ERRADO', 'OUTRO'];
  const STATUS_RECEB = ['TOTAL', 'PARCIAL', 'CANCELADO'];
  const STATUS_ENTREGA = ['AGUARDANDO', 'EM_TRANSITO', 'ATRASADA', 'CANCELADA'];
  const PRIORIDADES = ['BAIXA', 'NORMAL', 'URGENTE'];
  const RE_REF = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,59}$/;
  const RE_ORIGEM = /^[a-z][a-z0-9-]{1,29}$/;
  const digitosCE = (v) => String(v ?? '').replace(/\D/g, '');
  const maiusc = (v) => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim().replace(/[\s-]+/g, '_');

  /** Data local AAAA-MM-DD. Aceita "10/11/2026", "2026-11-10", ISO com hora ou Date. */
  function dataSimples(v) {
    if (v == null || v === '') return null;
    if (!(v instanceof Date)) {
      const s = String(v).trim();
      let m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      if (m) return dataSimples(`${m[3]}-${m[2]}-${m[1]}`);
      m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m) {
        const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
        return d.getUTCDate() === +m[3] && d.getUTCMonth() === +m[2] - 1 ? s : null;
      }
      v = new Date(s);
    }
    if (isNaN(v)) return null;
    return new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }
  const hojeLocal = () => dataSimples(new Date());

  /** <tag>valor</tag> indentado; ignora vazios. */
  const tagCE = (ind, nome, valor, attrs = '') =>
    (valor === undefined || valor === null || valor === '') ? [] : [`${' '.repeat(ind)}<${nome}${attrs}>${esc(colapsar(valor))}</${nome}>`];

  function falharCE(e) { if (e.length) throw Object.assign(new Error('XML fora do contrato:\n- ' + e.join('\n- ')), { erros: e }); }
  function vTxt(v, ctx, max, e) { const c = colapsar(v); if (!c || c.length > max) e.push(`${ctx}: obrigat\u00f3rio, at\u00e9 ${max} caracteres`); }
  function vRef(v, ctx, e) { if (!RE_REF.test(String(v ?? ''))) e.push(`${ctx}: refer\u00eancia inv\u00e1lida "${v}" (letras, d\u00edgitos, . _ / -, sem espa\u00e7os, at\u00e9 60)`); }
  function enumOpc(v, lista, ctx, e) {
    if (v == null || v === '') return undefined;
    const n = maiusc(v);
    if (!lista.includes(n)) e.push(`${ctx}: valor inv\u00e1lido "${v}" (use ${lista.join(', ')})`);
    return n;
  }
  function dataOpc(v, ctx, e) {
    if (v == null || v === '') return undefined;
    const d = dataSimples(v);
    if (!d) e.push(`${ctx}: data inv\u00e1lida "${v}"`);
    return d;
  }
  function intOpc(v, ctx, minimo, e) {
    if (v == null || v === '') return undefined;
    const n = Number(v); vInteiro(n, ctx, minimo, e); return n;
  }

  /** Cabecalho igual ao do Finanweb: empresa, cnpj, origem, dataArquivo, usuario (todos obrigatorios). */
  function cabecalhoCE(opts, e) {
    const emp = opts.empresa || {};
    const empresa = typeof emp === 'string' ? emp : (emp.razaoSocial || emp.empresa || emp.nome);
    const cnpj = digitosCE(typeof emp === 'string' ? opts.cnpj : (emp.cnpj || opts.cnpj));
    const origem = opts.origem || 'compras';
    const dataArquivo = dataSimples(opts.dataArquivo) || hojeLocal();
    vTxt(empresa, 'cabecalho.empresa', 120, e);
    if (!/^\d{14}$/.test(cnpj)) e.push('cabecalho.cnpj: CNPJ da empresa com 14 d\u00edgitos');
    if (!RE_ORIGEM.test(origem)) e.push(`cabecalho.origem inv\u00e1lida "${origem}"`);
    vTxt(opts.usuario, 'cabecalho.usuario', 120, e);
    return ['  <cabecalho>', ...tagCE(4, 'empresa', empresa), `    <cnpj>${cnpj}</cnpj>`, `    <origem>${origem}</origem>`,
      `    <dataArquivo>${dataArquivo}</dataArquivo>`, ...tagCE(4, 'usuario', opts.usuario), '  </cabecalho>'];
  }

  function fornecedorCE(f, ind, ctx, e) {
    vTxt(f?.nome, `${ctx}.fornecedor`, 120, e);
    const doc = digitosCE(f?.documento);
    if (f?.documento && doc.length !== 11 && doc.length !== 14) e.push(`${ctx}.fornecedor@documento: CPF (11) ou CNPJ (14) d\u00edgitos`);
    return [`${' '.repeat(ind)}<fornecedor${doc ? ` documento="${doc}"` : ''}>${esc(colapsar(f?.nome))}</fornecedor>`];
  }

  /** Soma itens com o mesmo SKU (R13: um SKU por registro). */
  function agruparPorSku(itens) {
    const m = new Map();
    for (const it of itens || []) {
      const sku = normalizarSku(it.sku);
      const q = Number(it.quantidade) || 0;
      const atual = m.get(sku);
      if (!atual) { m.set(sku, { ...it, sku, quantidade: q, avaria: it.avaria ? { ...it.avaria } : undefined }); continue; }
      atual.quantidade += q;
      if (it.quantidadePedida != null) atual.quantidadePedida = (Number(atual.quantidadePedida) || 0) + Number(it.quantidadePedida);
      if (it.avaria) atual.avaria = atual.avaria
        ? { ...atual.avaria, quantidade: Number(atual.avaria.quantidade) + Number(it.avaria.quantidade) } : { ...it.avaria };
    }
    return [...m.values()];
  }

  function cabecaItem(it, ind, ctx, e) {
    const sku = normalizarSku(it.sku);
    vSku(sku, ctx, e);
    const produto = it.produto || it.nome;
    vTxt(produto, `${ctx}.produto`, 120, e);
    return { sku, linhas: [...tagCE(ind, 'sku', sku), ...tagCE(ind, 'produto', produto)] };
  }

  /**
   * recebimento-v1 (Compras -> Estoque).
   * lote: { empresa:{razaoSocial, cnpj}, usuario, recebimentos:[{
   *   referencia (ou externalId), pedido (ou pedidoNumero), status (ou tipo): TOTAL|PARCIAL|CANCELADO,
   *   dataRecebimento (ou recebidoEm), fornecedor:{nome, documento?},
   *   notaFiscal?:{numero, serie?, chaveAcesso?, dataEmissao?}, conferente?, observacao?,
   *   itens:[{ sku, produto (ou nome), unidade?, ean?, finalidade?, armazenagem?, quantidade, quantidadePedida?,
   *            custoUnitario?, avaria?:{quantidade, motivo, descricao?}, lote?:{codigo, fabricacao?, validade?},
   *            localizacaoSugerida? }] }] }
   * Retorna { xml, qtdRegistros, quantidadeTotal }.
   */
  function gerarRecebimentos(lote) {
    const e = [];
    const cab = cabecalhoCE(lote, e);
    const lista = lote.recebimentos || [];
    if (!lista.length) e.push('recebimentos: nenhum recebimento para enviar');
    const L = ['  <recebimentos>'];
    const refs = new Set();
    let total = 0;
    lista.forEach((r, i) => {
      const ctx = `recebimento[${i + 1}]`;
      const ref = r.referencia || r.externalId || (r.id != null ? `REC-${r.id}` : '');
      vRef(ref, `${ctx}@referencia`, e);
      if (refs.has(ref)) e.push(`${ctx}: refer\u00eancia ${ref} repetida no arquivo`); refs.add(ref);
      const itens = agruparPorSku(r.itens);
      if (!itens.length) e.push(`${ctx}: sem itens`);
      const st = enumOpc(r.status || r.tipo, STATUS_RECEB, `${ctx}@status`, e)
        || (itens.every((it) => it.quantidadePedida == null || it.quantidade >= Number(it.quantidadePedida)) ? 'TOTAL' : 'PARCIAL');
      const pedido = r.pedido || r.pedidoNumero;
      vRef(pedido, `${ctx}.pedido`, e);
      const data = dataSimples(r.dataRecebimento || r.recebidoEm) || hojeLocal();
      if (r.conferente) vTxt(r.conferente, `${ctx}.conferente`, 120, e);
      if (r.observacao) vTxt(r.observacao, `${ctx}.observacao`, 500, e);

      L.push(`    <recebimento referencia="${esc(ref)}" status="${st}">`, ...tagCE(6, 'pedido', pedido),
        ...fornecedorCE(r.fornecedor, 6, ctx, e), `      <dataRecebimento>${data}</dataRecebimento>`);
      const nf = r.notaFiscal;
      if (nf && nf.numero) {
        const num = digitosCE(nf.numero), serie = digitosCE(nf.serie), chave = digitosCE(nf.chaveAcesso);
        if (!/^\d{1,9}$/.test(num)) e.push(`${ctx}.notaFiscal.numero: at\u00e9 9 d\u00edgitos`);
        if (nf.serie && !/^\d{1,3}$/.test(serie)) e.push(`${ctx}.notaFiscal.serie: at\u00e9 3 d\u00edgitos`);
        if (nf.chaveAcesso && chave.length !== 44) e.push(`${ctx}.notaFiscal.chaveAcesso: 44 d\u00edgitos`);
        const emi = dataOpc(nf.dataEmissao || nf.emitidaEm, `${ctx}.notaFiscal.dataEmissao`, e);
        L.push('      <notaFiscal>', ...tagCE(8, 'numero', num), ...tagCE(8, 'serie', serie),
          ...tagCE(8, 'chaveAcesso', chave), ...tagCE(8, 'dataEmissao', emi), '      </notaFiscal>');
      }
      L.push(...tagCE(6, 'conferente', r.conferente), '      <itens>');
      itens.forEach((it, j) => {
        const c2 = `${ctx}.item[${j + 1}]`;
        const cab2 = cabecaItem(it, 10, c2, e);
        const unidade = enumOpc(it.unidade, UNIDADES, `${c2}.unidade`, e);
        const ean = digitosCE(it.ean);
        if (it.ean && !/^(\d{8}|\d{12,14})$/.test(ean)) e.push(`${c2}.ean: 8, 12, 13 ou 14 d\u00edgitos`);
        const finalidade = enumOpc(it.finalidade, ['VENDA', 'USO_INTERNO'], `${c2}.finalidade`, e);
        const armazenagem = enumOpc(it.armazenagem, ARMAZENAGENS, `${c2}.armazenagem`, e);
        vInteiro(it.quantidade, `${c2}.quantidade`, 1, e);
        total += Number(it.quantidade) || 0;
        const qPed = intOpc(it.quantidadePedida, `${c2}.quantidadePedida`, 1, e);
        L.push('        <item>', ...cab2.linhas, ...tagCE(10, 'unidade', unidade), ...tagCE(10, 'ean', ean),
          ...tagCE(10, 'finalidade', finalidade), ...tagCE(10, 'armazenagem', armazenagem),
          ...tagCE(10, 'quantidade', it.quantidade), ...tagCE(10, 'quantidadePedida', qPed));
        if (it.custoUnitario != null && it.custoUnitario !== '') {
          vPreco(it.custoUnitario, `${c2}.custoUnitario`, e);
          L.push(`          <custoUnitario>${formatarPreco(it.custoUnitario)}</custoUnitario>`);
        }
        if (it.avaria && Number(it.avaria.quantidade) > 0) {
          const qa = Number(it.avaria.quantidade);
          vInteiro(qa, `${c2}.avaria.quantidade`, 1, e);
          const motivo = enumOpc(it.avaria.motivo || 'OUTRO', MOTIVOS_AVARIA, `${c2}.avaria.motivo`, e);
          if (it.avaria.descricao) vTxt(it.avaria.descricao, `${c2}.avaria.descricao`, 500, e);
          L.push('          <avaria>', ...tagCE(12, 'quantidade', qa), ...tagCE(12, 'motivo', motivo),
            ...tagCE(12, 'descricao', it.avaria.descricao), '          </avaria>');
        }
        if (it.lote && it.lote.codigo) {
          vTxt(it.lote.codigo, `${c2}.lote.codigo`, 120, e);
          const fab = dataOpc(it.lote.dataFabricacao || it.lote.fabricacao, `${c2}.lote.dataFabricacao`, e);
          const val = dataOpc(it.lote.dataValidade || it.lote.validade, `${c2}.lote.dataValidade`, e);
          if (fab && val && val < fab) e.push(`${c2}.lote: validade antes da fabrica\u00e7\u00e3o`);
          L.push('          <lote>', ...tagCE(12, 'codigo', it.lote.codigo), ...tagCE(12, 'dataFabricacao', fab),
            ...tagCE(12, 'dataValidade', val), '          </lote>');
        }
        if (it.localizacaoSugerida) vTxt(it.localizacaoSugerida, `${c2}.localizacaoSugerida`, 120, e);
        L.push(...tagCE(10, 'localizacaoSugerida', it.localizacaoSugerida), '        </item>');
      });
      L.push('      </itens>', ...tagCE(6, 'observacao', r.observacao), '    </recebimento>');
    });
    L.push('  </recebimentos>', '  <totalizador>', `    <qtdRegistros>${lista.length}</qtdRegistros>`,
      `    <quantidadeTotal>${total}</quantidadeTotal>`, '  </totalizador>');
    falharCE(e);
    const xml = ['<?xml version="1.0" encoding="UTF-8"?>',
      `<movimento xmlns="${NS_RECEB}" versao="1.0" tipo="RECEBIMENTO">`, ...cab, ...L, '</movimento>'].join('\n');
    return { xml, qtdRegistros: lista.length, quantidadeTotal: total };
  }

  /**
   * previsao-entrega-v1 (Compras -> Estoque).
   * lote: { empresa, usuario, previsoes:[{ referencia (ou pedidoNumero), status (ou situacao),
   *   fornecedor:{nome, documento?}, dataPedido?, dataPrevista, prioridade?, observacao?,
   *   itens:[{ sku, produto (ou nome), unidade?, armazenagem?, quantidade }] }] }
   */
  function gerarPrevisoes(lote) {
    const e = [];
    const cab = cabecalhoCE(lote, e);
    const lista = lote.previsoes || [];
    if (!lista.length) e.push('entregas: nenhuma previs\u00e3o para enviar');
    const L = ['  <entregas>'];
    const refs = new Set();
    let total = 0;
    lista.forEach((p, i) => {
      const ctx = `entrega[${i + 1}]`;
      const ref = p.referencia || p.pedido || p.pedidoNumero;
      vRef(ref, `${ctx}@referencia`, e);
      if (refs.has(ref)) e.push(`${ctx}: refer\u00eancia ${ref} repetida no arquivo`); refs.add(ref);
      const st = enumOpc(p.status || p.situacao || 'AGUARDANDO', STATUS_ENTREGA, `${ctx}@status`, e);
      const dp = dataOpc(p.dataPrevista, `${ctx}.dataPrevista`, e);
      if (!p.dataPrevista) e.push(`${ctx}.dataPrevista obrigat\u00f3ria`);
      const dped = dataOpc(p.dataPedido, `${ctx}.dataPedido`, e);
      const prioridade = enumOpc(p.prioridade, PRIORIDADES, `${ctx}.prioridade`, e);
      if (p.observacao) vTxt(p.observacao, `${ctx}.observacao`, 500, e);
      L.push(`    <entrega referencia="${esc(ref)}" status="${st}">`, ...fornecedorCE(p.fornecedor, 6, ctx, e),
        ...tagCE(6, 'dataPedido', dped), ...tagCE(6, 'dataPrevista', dp), ...tagCE(6, 'prioridade', prioridade), '      <itens>');
      const itens = agruparPorSku(p.itens);
      if (!itens.length) e.push(`${ctx}: sem itens`);
      itens.forEach((it, j) => {
        const c2 = `${ctx}.item[${j + 1}]`;
        const cab2 = cabecaItem(it, 10, c2, e);
        const unidade = enumOpc(it.unidade, UNIDADES, `${c2}.unidade`, e);
        const armazenagem = enumOpc(it.armazenagem, ARMAZENAGENS, `${c2}.armazenagem`, e);
        vInteiro(it.quantidade, `${c2}.quantidade`, 1, e);
        total += Number(it.quantidade) || 0;
        L.push('        <item>', ...cab2.linhas, ...tagCE(10, 'unidade', unidade), ...tagCE(10, 'armazenagem', armazenagem),
          ...tagCE(10, 'quantidade', it.quantidade), '        </item>');
      });
      L.push('      </itens>', ...tagCE(6, 'observacao', p.observacao), '    </entrega>');
    });
    L.push('  </entregas>', '  <totalizador>', `    <qtdRegistros>${lista.length}</qtdRegistros>`,
      `    <quantidadeTotal>${total}</quantidadeTotal>`, '  </totalizador>');
    falharCE(e);
    const xml = ['<?xml version="1.0" encoding="UTF-8"?>',
      `<movimento xmlns="${NS_PREV}" versao="1.0" tipo="PREVISAO_ENTREGA">`, ...cab, ...L, '</movimento>'].join('\n');
    return { xml, qtdRegistros: lista.length, quantidadeTotal: total };
  }

  /**
   * confirmacao-recebimento-v1 (Estoque -> Compras), para o Estoque gerar ou para testes.
   * resultados: [{ referencia, status, divergencias?:[{sku, quantidadeInformada, quantidadeContada, motivo?}], mensagem? }]
   * opts: { origem = 'estoque', dataProcessamento?, erro? }
   */
  function gerarConfirmacao(resultados, opts = {}) {
    const e = [];
    const origem = opts.origem || 'estoque';
    if (!RE_ORIGEM.test(origem)) e.push(`origem inv\u00e1lida "${origem}"`);
    const L = ['<?xml version="1.0" encoding="UTF-8"?>', `<confirmacaoRecebimento xmlns="${NS_CONF}" versao="1.0">`,
      `  <origem>${origem}</origem>`, `  <dataProcessamento>${dataSimples(opts.dataProcessamento) || hojeLocal()}</dataProcessamento>`];
    if (opts.erro) { vTxt(opts.erro, 'erro', 500, e); L.push(...tagCE(2, 'erro', opts.erro)); }
    else {
      if (!(resultados || []).length) e.push('resultados: nenhum resultado');
      L.push('  <resultados>');
      (resultados || []).forEach((r, i) => {
        const ctx = `resultado[${i + 1}]`;
        vRef(r.referencia, `${ctx}@referencia`, e);
        const st = enumOpc(r.status, ['ACEITO', 'DIVERGENTE', 'REJEITADO', 'DUPLICADO'], `${ctx}@status`, e);
        L.push(`    <resultado referencia="${esc(r.referencia)}" status="${st}">`);
        (r.divergencias || []).forEach((d) => {
          L.push('      <divergencia>', ...tagCE(8, 'sku', normalizarSku(d.sku)), ...tagCE(8, 'quantidadeInformada', d.quantidadeInformada),
            ...tagCE(8, 'quantidadeContada', d.quantidadeContada), ...tagCE(8, 'motivo', d.motivo), '      </divergencia>');
        });
        L.push(...tagCE(6, 'mensagem', r.mensagem), '    </resultado>');
      });
      const aceitos = (resultados || []).filter((r) => maiusc(r.status) === 'ACEITO').length;
      L.push('  </resultados>', '  <totalizador>', `    <qtdRegistros>${(resultados || []).length}</qtdRegistros>`,
        `    <qtdAceitos>${aceitos}</qtdAceitos>`, '  </totalizador>');
    }
    L.push('</confirmacaoRecebimento>');
    falharCE(e);
    return L.join('\n');
  }

  /**
   * Le qualquer mensagem dos contratos do Compras.
   * confirmacaoRecebimento -> { tipo:'confirmacao', origem, dataProcessamento, erro?, resultados:[{ externalId, referencia,
   *   status, processadoEm, divergencias, mensagem }] }
   * movimento RECEBIMENTO / PREVISAO_ENTREGA -> { tipo:'recebimentos'|'previsoes', cabecalho, registros }
   */
  function lerComprasEstoque(xmlString, Parser = root.DOMParser) {
    const doc = typeof xmlString === 'string' ? new Parser().parseFromString(xmlString.replace(/^\uFEFF/, ''), 'application/xml') : xmlString;
    if (doc.getElementsByTagName('parsererror').length) throw new Error('XML mal formado');
    const raiz = doc.documentElement;
    const nome = (n) => n.localName || n.nodeName.replace(/^.*:/, '');
    const filhos = (el) => (el ? Array.from(el.childNodes).filter((n) => n.nodeType === 1) : []);
    const filho = (el, t) => filhos(el).find((n) => nome(n) === t);
    const txt = (el, t) => { const n = filho(el, t); return n ? n.textContent.trim() : undefined; };
    const int = (el, t) => { const v = txt(el, t); return v == null ? undefined : parseInt(v, 10); };
    const ns = raiz.namespaceURI;

    if (nome(raiz) === 'confirmacaoRecebimento') {
      if (ns !== NS_CONF) throw new Error(`Namespace esperado ${NS_CONF}`);
      if (raiz.getAttribute('versao') !== '1.0') throw new Error('S\u00f3 a vers\u00e3o 1.0 da confirma\u00e7\u00e3o \u00e9 aceita');
      const dataProc = txt(raiz, 'dataProcessamento');
      const erro = txt(raiz, 'erro');
      return { tipo: 'confirmacao', origem: txt(raiz, 'origem'), dataProcessamento: dataProc, erro,
        resultados: erro ? [] : filhos(filho(raiz, 'resultados')).map((r) => ({
          externalId: r.getAttribute('referencia'), referencia: r.getAttribute('referencia'), status: r.getAttribute('status'),
          processadoEm: dataProc, mensagem: txt(r, 'mensagem'),
          divergencias: filhos(r).filter((n) => nome(n) === 'divergencia').map((d) => ({
            sku: txt(d, 'sku'), quantidadeInformada: int(d, 'quantidadeInformada'),
            quantidadeContada: int(d, 'quantidadeContada'), motivo: txt(d, 'motivo') })) })) };
    }
    if (nome(raiz) === 'movimento' && (ns === NS_RECEB || ns === NS_PREV)) {
      const cab = filho(raiz, 'cabecalho');
      const grupo = filho(raiz, ns === NS_RECEB ? 'recebimentos' : 'entregas');
      const itens = (el) => filhos(filho(el, 'itens')).map((it) => ({ sku: txt(it, 'sku'), produto: txt(it, 'produto'), quantidade: int(it, 'quantidade') }));
      return { tipo: ns === NS_RECEB ? 'recebimentos' : 'previsoes',
        cabecalho: { empresa: txt(cab, 'empresa'), cnpj: txt(cab, 'cnpj'), origem: txt(cab, 'origem'), dataArquivo: txt(cab, 'dataArquivo'), usuario: txt(cab, 'usuario') },
        registros: filhos(grupo).map((r) => ({ referencia: r.getAttribute('referencia'), status: r.getAttribute('status'),
          fornecedor: txt(r, 'fornecedor'), itens: itens(r) })) };
    }
    throw new Error('XML n\u00e3o \u00e9 de um contrato do Compras (movimento de recebimento ou previs\u00e3o, ou confirmacaoRecebimento)');
  }

  /**
   * Aplica a confirmacao nos recebimentos do Compras (muta e devolve as mudancas para o log).
   * Cada recebimento ganha statusEstoque, confirmadoEm, divergencias e mensagemEstoque.
   */
  function aplicarConfirmacao(recebimentos, confirmacao) {
    const porId = new Map(recebimentos.map((r) => [r.externalId || r.referencia || `REC-${r.id ?? r.pedidoNumero}`, r]));
    return (confirmacao.resultados || []).map((res) => {
      const r = porId.get(res.externalId);
      if (!r) return { externalId: res.externalId, aviso: 'recebimento n\u00e3o existe no Compras' };
      const antes = r.statusEstoque;
      Object.assign(r, { statusEstoque: res.status, confirmadoEm: res.processadoEm,
        divergencias: res.divergencias, mensagemEstoque: res.mensagem });
      return { externalId: res.externalId, de: antes, para: res.status, divergencias: res.divergencias.length };
    });
  }

  // ================================================================ DISPONIBILIDADE (contrato do Estoque com o Patrimonio)
  // Mesmo formato que o Estoque ja responde ao Patrimonio, sem namespace:
  //   <consultaDisponibilidade><idConsulta/><produtoCodigo/></consultaDisponibilidade>
  //   <respostaDisponibilidade><idConsulta/><produtoCodigo/>(<produto><nome/><quantidadeDisponivel/></produto> | <erro/>)</respostaDisponibilidade>

  /** Gera a consulta. Lanca Error({erros}) se o codigo ou o id forem invalidos. */
  function gerarConsultaDisponibilidade(produtoCodigo, idConsulta) {
    const e = [];
    const sku = normalizarSku(produtoCodigo);
    vSku(sku, 'produtoCodigo', e);
    const id = colapsar(idConsulta);
    if (!id || id.length > 100) e.push('idConsulta: obrigat\u00f3rio, at\u00e9 100 caracteres');
    if (e.length) throw Object.assign(new Error('XML fora do contrato:\n- ' + e.join('\n- ')), { erros: e });
    return ['<?xml version="1.0" encoding="UTF-8"?>', '<consultaDisponibilidade>', `  <idConsulta>${esc(id)}</idConsulta>`,
      `  <produtoCodigo>${sku}</produtoCodigo>`, '</consultaDisponibilidade>'].join('\n');
  }

  /** Para o Estoque (ou testes): resposta com produto ou com erro. */
  function gerarRespostaDisponibilidade(idConsulta, produtoCodigo, r = {}) {
    const L = ['<?xml version="1.0" encoding="UTF-8"?>', '<respostaDisponibilidade>', `  <idConsulta>${esc(colapsar(idConsulta))}</idConsulta>`,
      `  <produtoCodigo>${esc(colapsar(produtoCodigo))}</produtoCodigo>`];
    if (r.erro) L.push(`  <erro>${esc(colapsar(r.erro))}</erro>`);
    else L.push('  <produto>', `    <nome>${esc(colapsar(r.nome))}</nome>`, `    <quantidadeDisponivel>${Math.max(0, parseInt(r.quantidadeDisponivel, 10) || 0)}</quantidadeDisponivel>`, '  </produto>');
    L.push('</respostaDisponibilidade>');
    return L.join('\n');
  }

  /**
   * Le a resposta do Estoque. Retorna { idConsulta, produtoCodigo, nome?, quantidadeDisponivel?, erro? }.
   * Recusa DTD/entidades, raiz errada, campos vazios, produto e erro juntos e quantidade negativa ou nao inteira.
   */
  function lerRespostaDisponibilidade(xmlString, Parser = root.DOMParser) {
    const t = String(xmlString || '').replace(/^\uFEFF/, '');
    if (/<!DOCTYPE|<!ENTITY/i.test(t)) throw new Error('XML com DTD ou entidades n\u00e3o \u00e9 aceito');
    const doc = new Parser().parseFromString(t, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('XML mal formado');
    const raiz = doc.documentElement;
    const nome = (n) => n.localName || n.nodeName.replace(/^.*:/, '');
    if (nome(raiz) !== 'respostaDisponibilidade') throw new Error('A raiz deve ser <respostaDisponibilidade>');
    const filhos = (el) => (el ? Array.from(el.childNodes).filter((n) => n.nodeType === 1) : []);
    const filho = (el, tg) => filhos(el).find((n) => nome(n) === tg);
    const txt = (el, tg) => { const n = filho(el, tg); return n ? n.textContent.trim() : ''; };
    const idConsulta = txt(raiz, 'idConsulta'), produtoCodigo = txt(raiz, 'produtoCodigo');
    if (!idConsulta) throw new Error('Resposta sem idConsulta');
    if (!produtoCodigo) throw new Error('Resposta sem produtoCodigo');
    const prod = filho(raiz, 'produto'), erro = filho(raiz, 'erro');
    if (prod && erro) throw new Error('A resposta traz produto e erro juntos');
    if (erro) {
      if (!erro.textContent.trim()) throw new Error('Erro vazio na resposta');
      return { idConsulta, produtoCodigo, erro: erro.textContent.trim() };
    }
    if (!prod) throw new Error('A resposta n\u00e3o traz produto nem erro');
    const q = txt(prod, 'quantidadeDisponivel');
    if (!/^\d+$/.test(q)) throw new Error(`quantidadeDisponivel inv\u00e1lida "${q}" (inteiro maior ou igual a zero)`);
    const n = txt(prod, 'nome');
    if (!n) throw new Error('Resposta sem nome do produto');
    return { idConsulta, produtoCodigo, nome: n, quantidadeDisponivel: parseInt(q, 10) };
  }

  // ---------------------------------------------------------------- HTTP com a API do Estoque
  /** Valida no Estoque (POST /api/xml/validar) e, se ok, importa (POST /api/xml). */
  async function enviarParaEstoque(baseUrl, xml, { somenteValidar = false } = {}) {
    const post = async (path) => {
      const r = await fetch(baseUrl.replace(/\/$/, '') + path, {
        method: 'POST', headers: { 'Content-Type': 'application/xml' }, body: xml,
      });
      const corpo = await r.text();
      let dados; try { dados = JSON.parse(corpo); } catch { dados = corpo; }
      if (!r.ok) throw Object.assign(new Error(`Estoque respondeu ${r.status} em ${path}`), { status: r.status, dados });
      return dados;
    };
    const validacao = await post('/api/xml/validar');
    if (somenteValidar) return { validacao };
    return { validacao, importacao: await post('/api/xml') };
  }

  /** Busca o XML gerado pelo Estoque (GET /api/xml) e ja faz o parse. */
  async function buscarDoEstoque(baseUrl) {
    const r = await fetch(baseUrl.replace(/\/$/, '') + '/api/xml', { headers: { Accept: 'application/xml' } });
    if (!r.ok) throw new Error(`Estoque respondeu ${r.status} em GET /api/xml`);
    const xml = await r.text();
    return { xml, ...lerXml(xml) };
  }

  /** Dispara download do XML no navegador. */
  function baixarXml(xml, nome = `compras-estoque-${new Date().toISOString().slice(0, 10)}.xml`) {
    const url = URL.createObjectURL(new Blob([xml], { type: 'application/xml' }));
    Object.assign(document.createElement('a'), { href: url, download: nome }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const api = { gerarXml, loteDeRecebimentos, lerXml, sugestoesDeCompra, enviarParaEstoque,
    buscarDoEstoque, baixarXml, normalizarSku, formatarPreco,
    gerarPrevisoes, gerarRecebimentos, gerarConfirmacao, lerComprasEstoque, aplicarConfirmacao,
    gerarConsultaDisponibilidade, gerarRespostaDisponibilidade, lerRespostaDisponibilidade };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.EstoqueXML = api;
})(typeof window !== 'undefined' ? window : globalThis);
