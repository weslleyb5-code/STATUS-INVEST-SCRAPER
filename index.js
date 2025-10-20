// index.js - versão que chama diretamente o endpoint advancedsearchresultpaginated
// RODAR: node index.js
// ==================================================
// 1) Abre a página para obter cookies/estado do site (e fechar banners).
// 2) Chama diretamente o endpoint /category/advancedsearchresultpaginated paginando.
// 3) Extrai os dados do JSON e grava (limpando) a aba SHEET_TAB.
// 4) Se falhar, tenta extrair do DOM como fallback.
// ==================================================

const { chromium } = require('playwright');
const { google } = require('googleapis');

async function getServiceAccount() {
  const raw = process.env.GOOGLE_CREDENTIALS;
  if (!raw) throw new Error('Env GOOGLE_CREDENTIALS não configurado');
  try {
    if (raw.trim().startsWith('{')) return JSON.parse(raw);
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch (err) {
    throw new Error('Não foi possível ler GOOGLE_CREDENTIALS (esperado JSON ou base64(JSON)): ' + err.message);
  }
}

function normalizeRows(rows) {
  return rows.map(r => {
    if (Array.isArray(r)) return r.map(c => (c === null || c === undefined) ? '' : String(c));
    return [String(r)];
  });
}

async function writeFreshToSheet(valuesWithHeader) {
  const spreadsheetId = process.env.SHEET_ID;
  const tab = process.env.SHEET_TAB || 'Sheet1';
  if (!spreadsheetId) throw new Error('Env SHEET_ID não configurado');

  const serviceAccount = await getServiceAccount();
  const client = new google.auth.JWT(
    serviceAccount.client_email,
    null,
    serviceAccount.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  const sheets = google.sheets({ version: 'v4', auth: client });

  console.log(`Limpando aba "${tab}" da planilha ${spreadsheetId}...`);
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${tab}`
  }).catch(err => {
    console.warn('Aviso ao limpar aba:', err.message || err);
  });

  console.log(`Escrevendo ${valuesWithHeader.length} linhas em ${tab}...`);
  const res = await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tab}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: valuesWithHeader }
  });
  return res.data;
}

// tenta interpretar vários formatos comuns de JSON retornado pela API
function extractRowsFromJsonCandidate(json) {
  if (!json) return null;
  if (Array.isArray(json)) {
    if (json.length === 0) return null;
    const keys = Object.keys(json[0]);
    const header = keys;
    const rows = json.map(item => keys.map(k => item[k]));
    return { header, rows };
  }
  const candidates = ['data', 'items', 'results', 'response', 'content', 'Data'];
  for (const c of candidates) {
    if (json[c] && Array.isArray(json[c]) && json[c].length > 0) {
      const keys = Object.keys(json[c][0]);
      const header = keys;
      const rows = json[c].map(item => keys.map(k => item[k]));
      return { header, rows };
    }
  }
  // se o objeto contém um array em alguma propriedade
  for (const k of Object.keys(json)) {
    if (Array.isArray(json[k]) && json[k].length > 0 && typeof json[k][0] === 'object') {
      const keys = Object.keys(json[k][0]);
      return { header: keys, rows: json[k].map(it => keys.map(x => it[x])) };
    }
  }
  // fallback: se for um objeto simples
  if (typeof json === 'object') {
    const keys = Object.keys(json).filter(k => typeof json[k] !== 'object');
    if (keys.length) return { header: keys, rows: [keys.map(k => json[k])] };
  }
  return null;
}

function buildSearchJsonForTake(take) {
  // base inspirada no curl que você colou — deixamos filtros vazios, só ajustamos my_range
  const template = {
    Segment: "",
    Gestao: "",
    my_range: `0;${take}`,
    dy: { Item1: null, Item2: null },
    p_vp: { Item1: null, Item2: null },
    percentualcaixa: { Item1: null, Item2: null },
    numerocotistas: { Item1: null, Item2: null },
    dividend_cagr: { Item1: null, Item2: null },
    cota_cagr: { Item1: null, Item2: null },
    liquidezmediadiaria: { Item1: null, Item2: null },
    patrimonio: { Item1: null, Item2: null },
    valorpatrimonialcota: { Item1: null, Item2: null },
    numerocotas: { Item1: null, Item2: null },
    lastdividend: { Item1: null, Item2: null }
  };
  return JSON.stringify(template);
}

async function fetchViaApiUsingPageContext(page) {
  // monta cookies do contexto atual para enviar ao endpoint (algumas respostas podem depender de cookie/session)
  const cookies = await page.context().cookies();
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  // endpoint base
  const base = 'https://statusinvest.com.br/category/advancedsearchresultpaginated';
  const take = 100; // tentar 100 por página (ajusta se quiser)
  let pageIndex = 0;
  let allRows = [];
  let headerFromJson = null;
  console.log('Iniciando fetch direto ao endpoint advancedsearchresultpaginated...');

  while (true) {
    const searchParam = encodeURIComponent(buildSearchJsonForTake(take));
    const fetchUrl = `${base}?search=${searchParam}&orderColumn=&isAsc=&page=${pageIndex}&take=${take}&CategoryType=2`;
    console.log(`Buscando página ${pageIndex} -> ${fetchUrl}`);

    const resp = await page.request.get(fetchUrl, {
      headers: {
        accept: 'application/json, text/javascript, */*; q=0.01',
        'x-requested-with': 'XMLHttpRequest',
        referer: 'https://statusinvest.com.br/fundos-imobiliarios/busca-avancada',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
        cookie: cookieHeader
      },
      timeout: 30_000
    }).catch(err => {
      console.warn('Erro na requisição fetch:', err && (err.message || err));
      return null;
    });

    if (!resp) break;
    if (!resp.ok()) {
      const txt = await resp.text().catch(()=>'<no-text>');
      console.warn(`Resposta HTTP ${resp.status()} ao buscar página ${pageIndex}. Corpo (amostra):`, txt.slice(0,500));
      break;
    }

    // tenta parse JSON
    let j;
    try {
      j = await resp.json();
    } catch (e) {
      const txt = await resp.text().catch(()=>'<no-text>');
      console.warn('Resposta não JSON ao chamar API (mostrando amostra):', txt.slice(0,500));
      break;
    }

    // tenta extrair a lista de items do JSON
    const parsed = extractRowsFromJsonCandidate(j);
    if (!parsed || !parsed.rows || parsed.rows.length === 0) {
      console.log('JSON recebido mas sem lista reconhecível nesta página. Saindo da paginação.');
      break;
    }

    // se header ainda não definido, pega do parsed.header quando houver
    if (!headerFromJson && parsed.header && parsed.header.length) headerFromJson = parsed.header;

    // concatena rows
    allRows = allRows.concat(parsed.rows);
    console.log(`Página ${pageIndex} trouxe ${parsed.rows.length} itens — total até agora: ${allRows.length}`);

    // se trouxer menos que 'take', chegou ao fim
    if (parsed.rows.length < take) break;

    // evita laço infinito: limite de páginas (por segurança)
    pageIndex++;
    if (pageIndex > 40) { // 40 * 100 = 4000 itens limite prático
      console.log('Limite de páginas alcançado (safety), parando paginação.');
      break;
    }
  }

  if (allRows.length === 0) return null;
  return { header: headerFromJson || [], rows: allRows };
}

async function tryAcceptCookiesAndCloseModals(page) {
  const cookieButtons = [
    'button:has-text("Aceitar")',
    'button:has-text("Aceito")',
    'button:has-text("Concordo")',
    'button:has-text("OK")',
    'button:has-text("Fechar")'
  ];
  for (const sel of cookieButtons) {
    try {
      const el = page.locator(sel);
      if (await el.count() > 0) {
        await el.first().click({ timeout: 3000 }).catch(()=>{});
      }
    } catch(e){ /* não interrompe */ }
  }
}

async function scrapeStatusInvest() {
  const url = 'https://statusinvest.com.br/fundos-imobiliarios/busca-avancada';
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: true
  });
  const page = await browser.newPage();

  console.log('Abrindo página para obter contexto (cookies/JS)...', url);
  await page.goto(url, { waitUntil: 'networkidle' }).catch(()=>{});

  // tenta fechar cookies / modais
  await tryAcceptCookiesAndCloseModals(page);

  // tenta clicar "Buscar" (pode não ser necessário se vamos chamar a API diretamente,
  // mas alguns sites só inicializam certos cookies/params quando o botão é pressionado)
  try {
    const buscarLoc = page.locator('xpath=//button[contains(translate(normalize-space(string(.)),"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"), "buscar")]');
    if (await buscarLoc.count() > 0) {
      console.log('Clicando botão Buscar (se existir)...');
      await buscarLoc.first().click().catch(()=>{});
      // aguarda um instante para que qualquer JS seja executado
      await page.waitForTimeout(1200);
    } else {
      console.log('Botão Buscar não encontrado (ok). Vamos consultar a API diretamente.');
    }
  } catch(e) {
    console.warn('Erro ao tentar clicar Buscar:', e.message || e);
  }

  // TENTATIVA PRINCIPAL: buscar via API replicando endpoint que você mostrou no curl
  let apiResult = null;
  try {
    apiResult = await fetchViaApiUsingPageContext(page);
    if (apiResult) console.log(`API trouxe ${apiResult.rows.length} linhas (header length: ${apiResult.header.length})`);
    else console.log('API não trouxe dados reconhecíveis.');
  } catch (e) {
    console.warn('Erro ao buscar via API:', e && e.message ? e.message : e);
  }

  let extracted = { header: [], rows: [] };

  if (apiResult && apiResult.rows && apiResult.rows.length > 0) {
    extracted = apiResult;
  } else {
    // fallback: tentar extrair do DOM
    console.log('Fazendo fallback para extração via DOM (tabela / cards)...');
    try {
      await page.waitForSelector('table, [role="row"], .list-item, .asset-card, .fund-card', { timeout: 10_000 }).catch(()=>{});
      const domExtract = await page.evaluate(() => {
        function textOf(el) { return el ? el.innerText.trim().replace(/\s+/g, ' ') : ''; }
        const table = document.querySelector('table');
        if (table) {
          const headerEls = Array.from(table.querySelectorAll('thead th'));
          let header = headerEls.length ? headerEls.map(h => textOf(h)) : [];
          const bodyRows = Array.from(table.querySelectorAll('tbody tr'));
          const rows = bodyRows.map(tr => Array.from(tr.querySelectorAll('th,td')).map(td => textOf(td)));
          if (!header.length) {
            const firstThs = Array.from(table.querySelectorAll('tr:first-child th'));
            if (firstThs.length) header = firstThs.map(h => textOf(h));
          }
          return { header, rows };
        }
        const roleRows = Array.from(document.querySelectorAll('[role="row"]'));
        if (roleRows.length) {
          const headerEls = Array.from(document.querySelectorAll('[role="columnheader"]'));
          const header = headerEls.length ? headerEls.map(h => textOf(h)) : [];
          const rows = roleRows.map(r => {
            const cells = Array.from(r.querySelectorAll('[role="cell"],div,span')).map(c => textOf(c)).filter(Boolean);
            return cells;
          }).filter(r => r.length > 0);
          return { header, rows };
        }
        const cardSelectors = ['.list-item', '.result-item', '.card', '.asset-card', '.fund-card'];
        for (const sel of cardSelectors) {
          const cards = Array.from(document.querySelectorAll(sel));
          if (cards.length) {
            const rows = cards.map(c => {
              const titleEl = c.querySelector('h2, h3, .title, .name');
              const title = titleEl ? textOf(titleEl) : '';
              const txt = c.innerText.replace(/\s+/g, ' ').trim();
              return [title || txt];
            });
            return { header: ['raw_text'], rows };
          }
        }
        return { header: [], rows: [] };
      });
      extracted = domExtract;
    } catch (e) {
      console.warn('Erro no fallback DOM:', e && e.message ? e.message : e);
    }
  }

  await browser.close();

  console.log('Header detectado:', extracted.header);
  console.log('Quantidade de linhas capturadas:', extracted.rows.length);

  if (!extracted.rows || extracted.rows.length === 0) {
    throw new Error('Nenhuma linha capturada — mesmo após tentar API e DOM. Cole os logs para eu ajustar seletores/endpoint.');
  }

  const normalizedRows = normalizeRows(extracted.rows);
  const valuesToWrite = (extracted.header && extracted.header.length)
    ? [extracted.header, ...normalizedRows]
    : normalizedRows;

  const res = await writeFreshToSheet(valuesToWrite);
  return res;
}

// Execução principal
(async () => {
  try {
    console.log('Iniciando scraping e envio ao Google Sheets...');
    const result = await scrapeStatusInvest();
    console.log('Sucesso! Resultado da API do Sheets:', JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    console.error('Erro:', err && err.message ? err.message : err);
    process.exit(1);
  }
})();
