// index.js (usa PLAYWRIGHT_STORAGE se disponível)
// ------------------------------------------------
// Lê PLAYWRIGHT_STORAGE (JSON cru ou base64); cria contexto com storageState.
// Faz window.fetch para endpoint advancedsearchresultpaginated (paginação).
// Se tudo ok, grava (substitui) a aba SHEET_TAB na planilha definida.
// ------------------------------------------------

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

function extractRowsFromJsonCandidate(json) {
  if (!json) return null;
  if (Array.isArray(json)) {
    if (json.length === 0) return null;
    const keys = Object.keys(json[0]);
    const header = keys;
    const rows = json.map(item => keys.map(k => item[k]));
    return { header, rows };
  }
  const candidates = ['data', 'items', 'results', 'response', 'content', 'Data', 'Items'];
  for (const c of candidates) {
    if (json[c] && Array.isArray(json[c]) && json[c].length > 0) {
      const keys = Object.keys(json[c][0]);
      const header = keys;
      const rows = json[c].map(item => keys.map(k => item[k]));
      return { header, rows };
    }
  }
  for (const k of Object.keys(json)) {
    if (Array.isArray(json[k]) && json[k].length > 0 && typeof json[k][0] === 'object') {
      const keys = Object.keys(json[k][0]);
      return { header: keys, rows: json[k].map(it => keys.map(x => it[x])) };
    }
  }
  if (typeof json === 'object') {
    const keys = Object.keys(json).filter(k => typeof json[k] !== 'object');
    if (keys.length) return { header: keys, rows: [keys.map(k => json[k])] };
  }
  return null;
}

function buildSearchJsonForTake(take) {
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

// cria browser/context usando PLAYWRIGHT_STORAGE (JSON cru ou base64)
// retorna { browser, context, page }
async function createBrowserAndPageWithStorage() {
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: true
  });

  let context;
  const raw = process.env.PLAYWRIGHT_STORAGE;
  if (raw) {
    try {
      // tenta decodificar base64 primeiro
      let parsed = null;
      try {
        const maybe = Buffer.from(raw, 'base64').toString('utf8');
        parsed = JSON.parse(maybe);
        console.log('PLAYWRIGHT_STORAGE lido como base64(JSON).');
      } catch (_) {
        // não era base64 -> tenta JSON cru
        parsed = JSON.parse(raw);
        console.log('PLAYWRIGHT_STORAGE lido como JSON cru.');
      }
      context = await browser.newContext({ storageState: parsed });
    } catch (e) {
      console.warn('PLAYWRIGHT_STORAGE inválido — criando contexto limpo:', e.message || e);
      context = await browser.newContext();
    }
  } else {
    context = await browser.newContext();
    console.log('PLAYWRIGHT_STORAGE não fornecido — contexto limpo criado.');
  }

  const page = await context.newPage();
  return { browser, context, page };
}

// Faz fetch dentro do contexto do browser (window.fetch) e pagina
async function fetchViaWindowFetch(page) {
  const base = 'https://statusinvest.com.br/category/advancedsearchresultpaginated';
  const take = 100;
  let pageIndex = 0;
  let allRows = [];
  let headerFromJson = null;
  console.log('Iniciando fetch via window.fetch (page.evaluate) para advancedsearchresultpaginated...');

  while (true) {
    const searchParam = encodeURIComponent(buildSearchJsonForTake(take));
    const fetchUrl = `${base}?search=${searchParam}&orderColumn=&isAsc=&page=${pageIndex}&take=${take}&CategoryType=2`;
    console.log(`(browser) fetch page ${pageIndex} -> ${fetchUrl}`);

    const resp = await page.evaluate(async (url) => {
      try {
        const r = await fetch(url, {
          method: 'GET',
          credentials: 'same-origin',
          headers: {
            'accept': 'application/json, text/javascript, */*; q=0.01',
            'x-requested-with': 'XMLHttpRequest'
          }
        });
        const status = r.status;
        const text = await r.text();
        try {
          const json = JSON.parse(text);
          return { ok: true, status, json };
        } catch (e) {
          return { ok: false, status, text };
        }
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }, fetchUrl);

    if (!resp) {
      console.warn('Resposta vazia do evaluate fetch — parando.');
      break;
    }
    if (resp.error) {
      console.warn('Erro no fetch dentro do browser:', resp.error);
      break;
    }
    if (!resp.ok) {
      console.warn(`Resposta não-JSON ou status ${resp.status} do fetch dentro do browser. Amostra:`, (resp.text || '').slice(0,400));
      break;
    }

    const parsed = extractRowsFromJsonCandidate(resp.json);
    if (!parsed || !parsed.rows || parsed.rows.length === 0) {
      console.log('JSON retornado no browser não contém lista reconhecível nesta página. Saindo da paginação.');
      break;
    }

    if (!headerFromJson && parsed.header && parsed.header.length) headerFromJson = parsed.header;
    allRows = allRows.concat(parsed.rows);
    console.log(`Página ${pageIndex} trouxe ${parsed.rows.length} itens — total até agora: ${allRows.length}`);

    if (parsed.rows.length < take) break;
    pageIndex++;
    if (pageIndex > 60) {
      console.log('Safety limit de páginas alcançado, parando paginação.');
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
    } catch(e){ /* ignore */ }
  }
}

async function scrapeStatusInvest() {
  const url = 'https://statusinvest.com.br/fundos-imobiliarios/busca-avancada';
  const { browser, page } = await createBrowserAndPageWithStorage();

  console.log('Abrindo página para obter contexto (cookies/JS)...', url);
  await page.goto(url, { waitUntil: 'networkidle' }).catch(()=>{});

  // espera um pouco para eventuais JS de proteção
  await page.waitForTimeout(1200);
  await tryAcceptCookiesAndCloseModals(page);

  // tenta clicar buscar (não obrigatório)
  try {
    const buscarLoc = page.locator('xpath=//button[contains(translate(normalize-space(string(.)),"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"), "buscar")]');
    if (await buscarLoc.count() > 0) {
      await buscarLoc.first().click().catch(()=>{});
      await page.waitForTimeout(600);
    }
  } catch(e){}

  // principal: window.fetch via page.evaluate (usa cookies do contexto)
  let apiResult = null;
  try {
    apiResult = await fetchViaWindowFetch(page);
    if (apiResult) console.log(`API via window.fetch trouxe ${apiResult.rows.length} linhas (header length: ${apiResult.header.length})`);
    else console.log('API via window.fetch não trouxe dados reconhecíveis.');
  } catch (e) {
    console.warn('Erro na tentativa window.fetch:', e && (e.message || e));
  }

  let extracted = { header: [], rows: [] };

  if (apiResult && apiResult.rows && apiResult.rows.length > 0) {
    extracted = apiResult;
  } else {
    // fallback DOM
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
    throw new Error('Nenhuma linha capturada — mesmo após tentar window.fetch e DOM. Cole os logs para eu ajustar.');
  }

  const normalizedRows = normalizeRows(extracted.rows);
  const valuesToWrite = (extracted.header && extracted.header.length)
    ? [extracted.header, ...normalizedRows]
    : normalizedRows;

  const res = await writeFreshToSheet(valuesToWrite);
  return res;
}

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
