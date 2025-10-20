// index.js
// RODAR: node index.js
// ==================================================
// Script: abre StatusInvest (busca avançada de FIIs), clica em "Buscar",
// captura resultados e sobrescreve a aba especificada na Google Sheets.
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

  // limpa a aba inteira (range por nome da aba)
  console.log(`Limpando aba "${tab}" da planilha ${spreadsheetId}...`);
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${tab}`
  }).catch(err => {
    // Em alguns casos range vazio pode dar erro se aba não existir
    console.warn('Aviso ao limpar aba:', err.message || err);
  });

  // escreve os valores a partir de A1
  console.log(`Escrevendo ${valuesWithHeader.length} linhas em ${tab}...`);
  const res = await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tab}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: valuesWithHeader }
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

  console.log('Abrindo página...', url);
  await page.goto(url, { waitUntil: 'networkidle' });

  // tenta localizar e clicar no botão "Buscar"
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
    console.warn('Não achou botão Buscar — continuando (talvez resultados já estejam visíveis).');
  }

  // Espera um pouco para o resultado carregar (tenta por seletor de tabela ou por rede)
  try {
    await page.waitForSelector('table, .list-item, [role="row"]', { timeout: 12_000 });
  } catch (e) {
    console.log('Aviso: resultados não detectados rapidamente, continuando mesmo assim...');
  }

  // Avalia a página e tenta extrair header + linhas (de forma robusta)
  const extracted = await page.evaluate(() => {
    function textOf(el) {
      return el ? el.innerText.trim().replace(/\s+/g, ' ') : '';
    }

    // Caso 1: tabela HTML com thead + tbody
    const table = document.querySelector('table');
    if (table) {
      // header
      const headerEls = Array.from(table.querySelectorAll('thead th'));
      let header = headerEls.length ? headerEls.map(h => textOf(h)) : [];
      // linhas
      const bodyRows = Array.from(table.querySelectorAll('tbody tr'));
      const rows = bodyRows.map(tr => Array.from(tr.querySelectorAll('th,td')).map(td => textOf(td)));
      // Se não há thead, tente extrair header da primeira linha se tiver th
      if (!header.length) {
        const firstThs = Array.from(table.querySelectorAll('tr:first-child th'));
        if (firstThs.length) header = firstThs.map(h => textOf(h));
      }
      return { header, rows };
    }

    // Caso 2: linhas com role=row
    const roleRows = Array.from(document.querySelectorAll('[role="row"]'));
    if (roleRows.length) {
      // tenta extrair header de elementos com role=columnheader
      const headerEls = Array.from(document.querySelectorAll('[role="columnheader"]'));
      const header = headerEls.length ? headerEls.map(h => textOf(h)) : [];
      const rows = roleRows.map(r => {
        const cells = Array.from(r.querySelectorAll('[role="cell"],div,span')).map(c => textOf(c)).filter(Boolean);
        return cells;
      }).filter(r => r.length > 0);
      return { header, rows };
    }

    // Caso 3: cartões / lista (captura textos dos itens)
    const cardSelectors = ['.list-item', '.result-item', '.card', '.asset-card', '.fund-card'];
    for (const sel of cardSelectors) {
      const cards = Array.from(document.querySelectorAll(sel));
      if (cards.length) {
        const rows = cards.map(c => {
          // tenta extrair título e subinfo
          const title = c.querySelector('h2, h3, .title, .name') ? (c.querySelector('h2, h3, .title, .name').innerText || '').trim() : '';
          const txt = c.innerText.replace(/\s+/g, ' ').trim();
          return [title || txt];
        });
        return { header: ['raw_text'], rows };
      }
    }

    // Caso 4: fallback — captura linhas de texto perto do título "Resultado da busca"
    const headerEl = Array.from(document.querySelectorAll('*')).find(el => el.textContent && el.textContent.includes('Resultado da busca'));
    if (headerEl) {
      let sibling = headerEl.nextElementSibling || headerEl.parentElement;
      if (sibling) {
        const lines = sibling.innerText.split('\n').map(l => l.trim()).filter(Boolean);
        const rows = lines.map(l => [l]);
        return { header: ['raw_text'], rows };
      }
    }

    // default: vazio
    return { header: [], rows: [] };
  });

  await browser.close();

  const { header, rows } = extracted;
  console.log('Header detectado:', header);
  console.log('Quantidade de linhas capturadas:', rows.length);

  if (!rows || rows.length === 0) {
    throw new Error('Nenhuma linha capturada — verifique manualmente a estrutura do site ou os logs do workflow.');
  }

  // Prepara valores a enviar: se houve header não vazio, coloca header como primeira linha.
  const normalizedRows = normalizeRows(rows);
  const valuesToWrite = (header && header.length)
    ? [header, ...normalizedRows]
    : normalizedRows; // se sem header, grava apenas rows

  // escreve tudo na planilha (limpa antes)
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
