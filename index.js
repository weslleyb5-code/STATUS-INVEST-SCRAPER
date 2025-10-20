// index.js
// RODAR: node index.js
const { chromium } = require('playwright');
const { google } = require('googleapis');

async function getServiceAccount() {
  const raw = process.env.GOOGLE_CREDENTIALS;
  if (!raw) throw new Error('Env GOOGLE_CREDENTIALS não configurado');
  try {
    if (raw.trim().startsWith('{')) return JSON.parse(raw);
    // assume base64
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch (err) {
    throw new Error('Não foi possível ler GOOGLE_CREDENTIALS (esperado JSON ou base64(JSON)):' + err.message);
  }
}

function normalizeRows(rows) {
  // transforma arrays de colunas para valores aceitos pelo Sheets API
  return rows.map(r => {
    if (Array.isArray(r)) return r.map(c => (c === null || c === undefined) ? '' : String(c));
    return [String(r)];
  });
}

async function appendToSheet(values) {
  const spreadsheetId = process.env.SHEET_ID;
  if (!spreadsheetId) throw new Error('Env SHEET_ID não configurado');

  const serviceAccount = await getServiceAccount();
  const client = new google.auth.JWT(
    serviceAccount.client_email,
    null,
    serviceAccount.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  const sheets = google.sheets({ version: 'v4', auth: client });

  // append at Sheet1, adjust range if necessário
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: 'Sheet1!A1',
    valueInputOption: 'RAW',
    requestBody: { values }
  });
  return res.data;
}

async function scrapeStatusInvest() {
  const url = 'https://statusinvest.com.br/fundos-imobiliarios/busca-avancada';
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: true
  });
  const page = await browser.newPage();

  console.log('Abrindo página...');
  await page.goto(url, { waitUntil: 'networkidle' });

  // tenta localizar e clicar no botão "Buscar" de formas alternativas
  const buscarSelectors = [
    'button:has-text("Buscar")',
    'button:has-text("BUSCAR")',
    'button >> text=Buscar',
    'button[aria-label="Buscar"]',
    'text=Buscar'
  ];
  let clicked = false;
  for (const sel of buscarSelectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        console.log('Clicando Buscar com seletor:', sel);
        await el.click();
        clicked = true;
        break;
      }
    } catch (e) {
      /* continue */
    }
  }
  if (!clicked) {
    console.warn('Não achou botão Buscar — continuando sem clicar (talvez resultados já estejam visíveis).');
  }

  // espera por mudança no DOM (área "Resultado da busca") ou por respostas de rede
  try {
    await page.waitForSelector('text=Resultado da busca', { timeout: 12_000 });
  } catch (e) {
    console.log('Aviso: header "Resultado da busca" não apareceu rapidamente, continuando...');
  }

  // tenta capturar os dados de várias formas (tabelas, linhas, cards)
  const rows = await page.evaluate(() => {
    // 1) se houver tabela, pega todas as linhas
    const tableRows = Array.from(document.querySelectorAll('table tbody tr'));
    if (tableRows.length > 0) {
      return tableRows.map(tr => Array.from(tr.querySelectorAll('th,td')).map(td => td.innerText.trim()));
    }

    // 2) procura por elementos com aparência de "linha" (role=row)
    const roleRows = Array.from(document.querySelectorAll('[role="row"]'));
    if (roleRows.length > 0) {
      return roleRows.map(r => {
        const cols = Array.from(r.querySelectorAll('[role="cell"],div,span'));
        return cols.map(c => c.innerText.trim()).filter(Boolean);
      }).filter(r => r.length > 0);
    }

    // 3) cartões / lista — pega títulos + parágrafo
    const cardSelectors = ['.list-item', '.result-item', '.card', '.asset-card'];
    for (const sel of cardSelectors) {
      const cards = Array.from(document.querySelectorAll(sel));
      if (cards.length > 0) return cards.map(c => [c.innerText.replace(/\s+/g, ' ').trim()]);
    }

    // 4) fallback: pega o texto logo após o título "Resultado da busca"
    const header = Array.from(document.querySelectorAll('*')).find(el => el.textContent && el.textContent.includes('Resultado da busca'));
    if (header) {
      let sibling = header.nextElementSibling || header.parentElement;
      if (sibling) {
        const lines = sibling.innerText.split('\n').map(l => l.trim()).filter(Boolean);
        // transforma linhas em arrays single-coluna
        return lines.map(l => [l]);
      }
    }

    // 5) se nada deu, retorna vazio
    return [];
  });

  console.log('Linhas capturadas (amostra):', rows.slice(0, 5));
  await browser.close();

  if (!rows || rows.length === 0) {
    throw new Error('Nenhuma linha capturada — pode ser que o site tenha carregado dinamicamente com outra rota. Verifique manualmente no navegador as classes/estrutura.');
  }

  // normaliza e envia ao Sheets
  const values = normalizeRows(rows);
  const res = await appendToSheet(values);
  return res;
}

// Execução
(async () => {
  try {
    console.log('Iniciando scraping e envio ao Google Sheets...');
    const result = await scrapeStatusInvest();
    console.log('Sucesso! Resultado da API do Sheets:', JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Erro:', err && err.message ? err.message : err);
    process.exit(1);
  }
})();
