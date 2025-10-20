// index.js - Scraper FundsExplorer ranking -> Google Sheets
// Substitua no repo e rode o workflow do GitHub Actions.
// -----------------------------------------------------

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

// cria browser/context usando PLAYWRIGHT_STORAGE (opcional)
async function createBrowserAndPageWithStorage() {
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: true
  });

  let context;
  const raw = process.env.PLAYWRIGHT_STORAGE;
  if (raw) {
    try {
      // tenta decodificar base64 primeiro, senão JSON cru
      let parsed = null;
      try {
        const maybe = Buffer.from(raw, 'base64').toString('utf8');
        parsed = JSON.parse(maybe);
        console.log('PLAYWRIGHT_STORAGE lido como base64(JSON).');
      } catch (_) {
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

async function scrapeFundsExplorer() {
  const url = 'https://www.fundsexplorer.com.br/ranking';
  const { browser, page } = await createBrowserAndPageWithStorage();

  console.log('Abrindo página:', url);
  await page.goto(url, { waitUntil: 'networkidle' }).catch(()=>{});
  // espera por tabela carregar (15s)
  try {
    await page.waitForSelector('table, .table-responsive, tbody tr', { timeout: 15_000 });
  } catch (e) {
    console.log('Aviso: seletor de tabela não apareceu rápido — vamos tentar mesmo assim.');
  }

  // extrai cabeçalho e linhas da primeira tabela visível na página
  const extracted = await page.evaluate(() => {
    function textOf(el) { return el ? el.innerText.trim().replace(/\s+/g, ' ') : ''; }

    // tenta encontrar a tabela principal de ranking (mais provável)
    const tables = Array.from(document.querySelectorAll('table'));
    let target = null;
    if (tables.length === 1) {
      target = tables[0];
    } else if (tables.length > 1) {
      // heurística: procurar tabela que contenha Ticker ou Código no header
      for (const t of tables) {
        const headerText = (t.querySelector('thead') && t.querySelector('thead').innerText) ? t.querySelector('thead').innerText.toLowerCase() : '';
        if (headerText.includes('ticker') || headerText.includes('código') || headerText.includes('dy')) { target = t; break; }
      }
      if (!target) target = tables[0];
    }

    if (!target) return { header: [], rows: [] };

    // header
    let headerEls = Array.from(target.querySelectorAll('thead th'));
    let header = headerEls.length ? headerEls.map(h => textOf(h)) : [];

    // body rows
    const bodyRows = Array.from(target.querySelectorAll('tbody tr'));
    const rows = bodyRows.map(tr => {
      // pega colunas visíveis (td)
      const cols = Array.from(tr.querySelectorAll('td')).map(td => textOf(td));
      return cols;
    }).filter(r => r.length > 0);

    return { header, rows };
  });

  await browser.close();

  console.log('Header detectado:', extracted.header);
  console.log('Quantidade de linhas capturadas:', extracted.rows.length);

  if (!extracted.rows || extracted.rows.length === 0) {
    throw new Error('Nenhuma linha capturada — a estrutura pode ter mudado. Cole os logs para eu ajustar.');
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
    console.log('Iniciando scraping FundsExplorer -> Google Sheets...');
    const result = await scrapeFundsExplorer();
    console.log('Sucesso! Resultado da API do Sheets:', JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    console.error('Erro:', err && err.message ? err.message : err);
    process.exit(1);
  }
})();
