const output = document.getElementById('output');

let inboundItems = [];
let fanProductsCache = [];
let isSubmittingInbound = false;
let returnItems = [];
let isSubmittingReturn = false;
let returnOrderCounter = 1;

const FAN_SUPPLIER_MAX_LENGTH = 20;
const SUPPLIER_PRIMARY = 'PovesteDeVin - Eight Sigma';
const SUPPLIER_FALLBACK = 'PDV - Eight Sigma';

function byId(id) {
  return document.getElementById(id);
}

function showResult(title, data) {
  if (!output) return;

  output.textContent =
    `=== ${title} ===\n\n` +
    JSON.stringify(data, null, 2);
}

function showError(title, err) {
  if (!output) return;

  let message = err?.responseBody || err?.message || 'Eroare necunoscuta';

  try {
    const parsed =
      typeof message === 'string'
        ? JSON.parse(message)
        : message;

    if (parsed?.code === 'INBOUND_DUPLICATE') {
      message = `Inbound duplicat blocat.\n\n${parsed.error}`;
    } else if (parsed?.error) {
      message = parsed.error;
    } else {
      message = typeof parsed === 'string'
        ? parsed
        : JSON.stringify(parsed, null, 2);
    }
  } catch {
    // pastram mesajul original daca nu este JSON
  }

  output.textContent =
    `=== ${title} - EROARE ===\n\n` +
    message;
}

async function apiRequest(title, url, options = {}) {
  try {
    const response = await fetch(url, options);
    const text = await response.text();

    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      throw {
        message: `HTTP ${response.status}`,
        responseBody: JSON.stringify(data, null, 2)
      };
    }

    showResult(title, data);
    return data;
  } catch (err) {
    showError(title, err);
    throw err;
  }
}

async function apiRequestSilent(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();

  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw {
      message: `HTTP ${response.status}`,
      responseBody: JSON.stringify(data, null, 2)
    };
  }

  return data;
}

function value(id) {
  const element = byId(id);
  return element ? element.value.trim() : '';
}

function setValue(id, newValue) {
  const element = byId(id);
  if (!element) return;
  element.value = newValue;
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function createEmptyInboundItem() {
  return {
    productCode: '',
    quantity: ''
  };
}

function createEmptyReturnItem() {
  return {
    productCode: '',
    quantity: ''
  };
}

function getDuplicateReturnProductCodes() {
  const counts = {};

  returnItems.forEach(item => {
    const code = String(item.productCode || '').trim();

    if (!code) return;

    counts[code] = (counts[code] || 0) + 1;
  });

  return Object.keys(counts).filter(code => counts[code] > 1);
}

function getReturnHeaderValidationErrors() {
  const errors = [];

  if (!value('returnOrderDate')) {
    errors.push('Completeaza orderDate pentru retur.');
  }

  if (!value('returnOrderNumber')) {
    errors.push('Lipseste orderNumber pentru retur.');
  }

  if (!value('returnDeliveryDate')) {
    errors.push('Completeaza deliveryDate pentru retur.');
  }

  if (!value('returnSupplier')) {
    errors.push('Lipseste supplier pentru retur.');
  }

  if (!value('returnSupplierName')) {
    errors.push('Completeaza supplierName pentru retur.');
  }

  return errors;
}

function validateReturnItems() {
  const errors = [];
  const duplicates = getDuplicateReturnProductCodes();

  if (!returnItems.length) {
    errors.push('Adauga cel putin un produs in retur.');
  }

  returnItems.forEach((item, index) => {
    const rowNumber = index + 1;
    const productCode = String(item.productCode || '').trim();
    const quantity = Number(item.quantity);

    if (!productCode) {
      errors.push(`Retur linia ${rowNumber}: selecteaza un produs.`);
    }

    if (!Number.isInteger(quantity) || quantity < 1) {
      errors.push(`Retur linia ${rowNumber}: cantitatea trebuie sa fie un numar intreg mai mare ca 0.`);
    }
  });

  duplicates.forEach(code => {
    errors.push(`Produs duplicat in retur: ${code}. Un produs poate aparea o singura data.`);
  });

  return {
    isValid: errors.length === 0,
    errors
  };
}

function getReturnFormValidation() {
  const headerErrors = getReturnHeaderValidationErrors();
  const itemsValidation = validateReturnItems();

  const errors = [...headerErrors, ...itemsValidation.errors];

  return {
    isValid: errors.length === 0,
    errors
  };
}

function getReturnSummary() {
  const validItems = returnItems.filter(item => {
    const productCode = String(item.productCode || '').trim();
    const quantity = Number(item.quantity);

    return productCode && Number.isInteger(quantity) && quantity > 0;
  });

  const totalLines = validItems.length;
  const totalQuantity = validItems.reduce((sum, item) => sum + Number(item.quantity), 0);

  return {
    totalLines,
    totalQuantity,
    items: validItems.map(item => ({
      productCode: String(item.productCode).trim(),
      quantity: Number(item.quantity)
    }))
  };
}

function getInboundProductLabel(productCode) {
  const product = fanProductsCache.find(item => item.productCode === productCode);

  if (!product) {
    return productCode;
  }

  return `${product.productCode}${product.description ? ' - ' + product.description : ''}`;
}

function getDuplicateInboundProductCodes() {
  const counts = {};

  inboundItems.forEach(item => {
    const code = String(item.productCode || '').trim();

    if (!code) return;

    counts[code] = (counts[code] || 0) + 1;
  });

  return Object.keys(counts).filter(code => counts[code] > 1);
}

function getInboundHeaderValidationErrors() {
  const errors = [];

  if (!value('inboundOrderDate')) {
    errors.push('Completeaza orderDate.');
  }

  if (!value('inboundOrderNumber')) {
    errors.push('Lipseste orderNumber.');
  }

  if (!value('inboundDeliveryDate')) {
    errors.push('Completeaza deliveryDate.');
  }

  if (!value('inboundSupplier')) {
    errors.push('Lipseste supplier.');
  }

  if (!value('inboundSupplierName')) {
    errors.push('Completeaza supplierName.');
  }

  return errors;
}

function validateInboundItems() {
  const errors = [];
  const duplicates = getDuplicateInboundProductCodes();

  if (!inboundItems.length) {
    errors.push('Adauga cel putin un produs.');
  }

  inboundItems.forEach((item, index) => {
    const rowNumber = index + 1;
    const productCode = String(item.productCode || '').trim();
    const quantity = Number(item.quantity);

    if (!productCode) {
      errors.push(`Linia ${rowNumber}: selecteaza un produs.`);
    }

    if (!Number.isInteger(quantity) || quantity < 1) {
      errors.push(`Linia ${rowNumber}: cantitatea trebuie sa fie un numar intreg mai mare ca 0.`);
    }
  });

  duplicates.forEach(code => {
    errors.push(`Produs duplicat: ${code}. Un produs poate aparea o singura data.`);
  });

  return {
    isValid: errors.length === 0,
    errors
  };
}

function getInboundFormValidation() {
  const headerErrors = getInboundHeaderValidationErrors();
  const itemsValidation = validateInboundItems();

  const errors = [...headerErrors, ...itemsValidation.errors];

  return {
    isValid: errors.length === 0,
    errors
  };
}

function getInboundSummary() {
  const validItems = inboundItems.filter(item => {
    const productCode = String(item.productCode || '').trim();
    const quantity = Number(item.quantity);

    return productCode && Number.isInteger(quantity) && quantity > 0;
  });

  const totalLines = validItems.length;
  const totalQuantity = validItems.reduce((sum, item) => sum + Number(item.quantity), 0);

  return {
    totalLines,
    totalQuantity,
    items: validItems.map(item => ({
      productCode: String(item.productCode).trim(),
      quantity: Number(item.quantity)
    }))
  };
}

function updateInboundSubmitState() {
  const button = byId('btn-create-inbound');

  if (!button) return;

  const validation = getInboundFormValidation();
  button.disabled = isSubmittingInbound || !validation.isValid;
}

function renderInboundSummary() {
  const container = byId('inboundSummaryContainer');

  if (!container) return;

  const validation = getInboundFormValidation();
  const summary = getInboundSummary();

  const errorsHtml = validation.errors.length
    ? `
      <div class="inbound-summary-errors">
        ${validation.errors.map(error => `<div>${escapeHtml(error)}</div>`).join('')}
      </div>
    `
    : '<div class="inbound-summary-valid">Totul este valid.</div>';

  const itemsHtml = summary.items.length
    ? summary.items.map(item => `
        <div class="inbound-summary-item">
          <strong>${escapeHtml(item.productCode)}</strong>
          <span>${fanProductsCache.length ? ` - ${escapeHtml(getInboundProductLabel(item.productCode).replace(`${item.productCode} - `, ''))}` : ''}</span>
          <span> - cantitate: ${escapeHtml(item.quantity)}</span>
        </div>
      `).join('')
    : '<div>Nu ai produse valide inca.</div>';

  container.innerHTML = `
    <div><strong>Pozitii valide:</strong> ${summary.totalLines}</div>
    <div><strong>Total bucati:</strong> ${summary.totalQuantity}</div>
    <div style="margin-top:8px;"><strong>Ce pleaca spre depozit:</strong></div>
    <div>${itemsHtml}</div>
    <div style="margin-top:10px;"><strong>Validare:</strong></div>
    ${errorsHtml}
  `;
}

function renderInboundItems() {
  const container = byId('inboundItemsContainer');

  if (!container) return;

  if (!inboundItems.length) {
    inboundItems = [createEmptyInboundItem()];
  }

  const duplicateCodes = getDuplicateInboundProductCodes();

  container.innerHTML = inboundItems
    .map((item, index) => {
      const quantityValue = item.quantity === '' ? '' : item.quantity;
      const hasDuplicate = item.productCode && duplicateCodes.includes(item.productCode);

      const optionsHtml = [
        '<option value="">Selecteaza produs</option>',
        ...fanProductsCache
          .slice()
          .sort((a, b) => String(a.productCode || '').localeCompare(String(b.productCode || '')))
          .map(product => {
            const selected = product.productCode === item.productCode ? 'selected' : '';
            const label = `${product.productCode}${product.description ? ' - ' + product.description : ''}`;

            return `<option value="${escapeHtml(product.productCode)}" ${selected}>${escapeHtml(label)}</option>`;
          })
      ].join('');

      return `
        <div class="inbound-item-row" data-index="${index}">
          <select class="inbound-item-product">
            ${optionsHtml}
          </select>

          <input
            class="inbound-item-quantity"
            type="number"
            min="1"
            step="1"
            placeholder="Cantitate"
            value="${escapeHtml(quantityValue)}"
          />

          <button class="inbound-item-remove" data-index="${index}" type="button">
            Sterge
          </button>

          <div class="inbound-item-inline-error">
            ${hasDuplicate ? 'Produsul este deja adaugat pe alta linie.' : ''}
          </div>
        </div>
      `;
    })
    .join('');

  container.querySelectorAll('.inbound-item-product').forEach((select, index) => {
    select.addEventListener('change', event => {
      inboundItems[index].productCode = event.target.value;
      renderInboundItems();
    });
  });

  container.querySelectorAll('.inbound-item-quantity').forEach((input, index) => {
    input.addEventListener('input', event => {
      inboundItems[index].quantity = event.target.value.trim();
      renderInboundSummary();
      updateInboundSubmitState();
    });
  });

  container.querySelectorAll('.inbound-item-remove').forEach(button => {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.index);
      inboundItems.splice(index, 1);

      if (!inboundItems.length) {
        inboundItems.push(createEmptyInboundItem());
      }

      renderInboundItems();
    });
  });

  renderInboundSummary();
  updateInboundSubmitState();
}

function updateReturnSubmitState() {
  const button = byId('btn-create-return');

  if (!button) return;

  const validation = getReturnFormValidation();
  button.disabled = isSubmittingReturn || !validation.isValid;
}

function renderReturnSummary() {
  const container = byId('returnSummaryContainer');

  if (!container) return;

  const validation = getReturnFormValidation();
  const summary = getReturnSummary();

  const errorsHtml = validation.errors.length
    ? `
      <div class="inbound-summary-errors">
        ${validation.errors.map(error => `<div>${escapeHtml(error)}</div>`).join('')}
      </div>
    `
    : '<div class="inbound-summary-valid">Totul este valid.</div>';

  const itemsHtml = summary.items.length
    ? summary.items.map(item => `
        <div class="inbound-summary-item">
          <strong>${escapeHtml(item.productCode)}</strong>
          <span>${fanProductsCache.length ? ` - ${escapeHtml(getInboundProductLabel(item.productCode).replace(`${item.productCode} - `, ''))}` : ''}</span>
          <span> - cantitate: ${escapeHtml(item.quantity)}</span>
        </div>
      `).join('')
    : '<div>Nu ai produse valide inca.</div>';

  container.innerHTML = `
    <div><strong>Pozitii valide:</strong> ${summary.totalLines}</div>
    <div><strong>Total bucati:</strong> ${summary.totalQuantity}</div>
    <div style="margin-top:8px;"><strong>Ce pleaca spre depozit ca retur:</strong></div>
    <div>${itemsHtml}</div>
    <div style="margin-top:10px;"><strong>Validare:</strong></div>
    ${errorsHtml}
  `;
}

function renderReturnItems() {
  const container = byId('returnItemsContainer');

  if (!container) return;

  if (!returnItems.length) {
    returnItems = [createEmptyReturnItem()];
  }

  const duplicateCodes = getDuplicateReturnProductCodes();

  container.innerHTML = returnItems
    .map((item, index) => {
      const quantityValue = item.quantity === '' ? '' : item.quantity;
      const hasDuplicate = item.productCode && duplicateCodes.includes(item.productCode);

      const optionsHtml = [
        '<option value="">Selecteaza produs</option>',
        ...fanProductsCache
          .slice()
          .sort((a, b) => String(a.productCode || '').localeCompare(String(b.productCode || '')))
          .map(product => {
            const selected = product.productCode === item.productCode ? 'selected' : '';
            const label = `${product.productCode}${product.description ? ' - ' + product.description : ''}`;

            return `<option value="${escapeHtml(product.productCode)}" ${selected}>${escapeHtml(label)}</option>`;
          })
      ].join('');

      return `
        <div class="inbound-item-row" data-index="${index}">
          <select class="return-item-product">
            ${optionsHtml}
          </select>

          <input
            class="return-item-quantity"
            type="number"
            min="1"
            step="1"
            placeholder="Cantitate"
            value="${escapeHtml(quantityValue)}"
          />

          <button class="return-item-remove" data-index="${index}" type="button">
            Sterge
          </button>

          <div class="inbound-item-inline-error">
            ${hasDuplicate ? 'Produsul este deja adaugat pe alta linie de retur.' : ''}
          </div>
        </div>
      `;
    })
    .join('');

  container.querySelectorAll('.return-item-product').forEach((select, index) => {
    select.addEventListener('change', event => {
      returnItems[index].productCode = event.target.value;
      renderReturnItems();
    });
  });

  container.querySelectorAll('.return-item-quantity').forEach((input, index) => {
    input.addEventListener('input', event => {
      returnItems[index].quantity = event.target.value.trim();
      renderReturnSummary();
      updateReturnSubmitState();
    });
  });

  container.querySelectorAll('.return-item-remove').forEach(button => {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.index);
      returnItems.splice(index, 1);

      if (!returnItems.length) {
        returnItems.push(createEmptyReturnItem());
      }

      renderReturnItems();
    });
  });

  renderReturnSummary();
  updateReturnSubmitState();
}

function addReturnItemRow() {
  returnItems.push(createEmptyReturnItem());
  renderReturnItems();
}

function addInboundItemRow() {
  inboundItems.push(createEmptyInboundItem());
  renderInboundItems();
}

async function loadInboundProducts() {
  try {
    const response = await fetch('/fan/products/all');
    const text = await response.text();

    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }

    if (!response.ok) {
      throw new Error('Nu am putut incarca produsele FAN');
    }

    const products = data.items || data.products || [];
    fanProductsCache = products;

    if (!inboundItems.length) {
  inboundItems = [createEmptyInboundItem()];
}

if (!returnItems.length) {
  returnItems = [createEmptyReturnItem()];
}

renderInboundItems();
renderReturnItems();

    showResult('Incarcare produse FAN', {
      loaded: products.length
    });
  } catch (err) {
    showError('Incarcare produse FAN', err);
  }
}

function getNowForDatetimeLocal() {
  const now = new Date();
  const pad = number => String(number).padStart(2, '0');

  const year = now.getFullYear();
  const month = pad(now.getMonth() + 1);
  const day = pad(now.getDate());
  const hours = pad(now.getHours());
  const minutes = pad(now.getMinutes());

  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function formatDatetimeLocalToFan(value) {
  if (!value) return '';

  const [datePart, timePart = '00:00'] = value.split('T');
  const [hours = '00', minutes = '00'] = timePart.split(':');

  return `${datePart} ${hours}:${minutes}:00`;
}

function formatDateToFan(date) {
  const pad = number => String(number).padStart(2, '0');

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function getEffectiveSupplierValue() {
  const primary = SUPPLIER_PRIMARY.trim();
  const fallback = SUPPLIER_FALLBACK.trim();

  if (primary.length <= FAN_SUPPLIER_MAX_LENGTH) {
    return primary;
  }

  if (fallback.length <= FAN_SUPPLIER_MAX_LENGTH) {
    return fallback;
  }

  return fallback.slice(0, FAN_SUPPLIER_MAX_LENGTH);
}

function initializeInboundDefaults() {
  setValue('inboundOrderDate', getNowForDatetimeLocal());
  setValue('inboundSupplier', getEffectiveSupplierValue());
  renderInboundSummary();
  updateInboundSubmitState();
}

async function loadNextInboundOrderNumber() {
  try {
    const data = await apiRequest('Next inbound order number', '/fan/inbound/next-order-number');

    const orderNumber =
      data?.orderNumber ||
      data?.nextOrderNumber ||
      data?.value ||
      '';

    if (!orderNumber) {
      throw new Error('Backend-ul nu a returnat orderNumber');
    }

    setValue('inboundOrderNumber', orderNumber);
  } catch (err) {
    console.error(err);
  }
}

function attachInboundHeaderListeners() {
  [
    'inboundOrderDate',
    'inboundOrderNumber',
    'inboundDeliveryDate',
    'inboundSupplier',
    'inboundSupplierName'
  ].forEach(id => {
    const element = byId(id);

    if (!element) return;

    element.addEventListener('input', () => {
      renderInboundSummary();
      updateInboundSubmitState();
    });

    element.addEventListener('change', () => {
      renderInboundSummary();
      updateInboundSubmitState();
    });
  });
}

function attachReturnHeaderListeners() {
  [
    'returnOrderDate',
    'returnOrderNumber',
    'returnDeliveryDate',
    'returnSupplier',
    'returnSupplierName',
    'returnOriginalOrderNumber',
    'returnAwb'
  ].forEach(id => {    const element = byId(id);

    if (!element) return;

    element.addEventListener('input', () => {
      renderReturnSummary();
      updateReturnSubmitState();
    });

    element.addEventListener('change', () => {
      renderReturnSummary();
      updateReturnSubmitState();
    });
  });
}

function resetInboundFormAfterSuccess() {
  inboundItems = [createEmptyInboundItem()];

  setValue('inboundOrderDate', getNowForDatetimeLocal());
  setValue('inboundDeliveryDate', '');
  setValue('inboundSupplier', getEffectiveSupplierValue());
  setValue('inboundSupplierName', '');

  renderInboundItems();
}

function bindClickById(id, handler) {
  const nodes = document.querySelectorAll(`[id="${id}"]`);

  if (!nodes.length) {
    return;
  }

  nodes.forEach(node => {
    node.addEventListener('click', handler);
  });
}

function initTabs() {
  const tabButtons = document.querySelectorAll('[data-tab-target]');
  const tabPanels = document.querySelectorAll('[data-tab-panel]');

  if (!tabButtons.length || !tabPanels.length) {
    return;
  }

  function activateTab(target) {
    if (!target) return;

    tabButtons.forEach(button => {
      const isActive = button.getAttribute('data-tab-target') === target;
      button.classList.toggle('is-active', isActive);
    });

    tabPanels.forEach(panel => {
      const isActive = panel.getAttribute('data-tab-panel') === target;
      panel.hidden = !isActive;
      panel.classList.toggle('is-active', isActive);
    });
  }

  tabButtons.forEach(button => {
    button.addEventListener('click', event => {
      event.preventDefault();
      const target = button.getAttribute('data-tab-target');
      activateTab(target);
    });
  });

  const activeButton =
    document.querySelector('[data-tab-target].is-active') ||
    tabButtons[0];

  activateTab(activeButton?.getAttribute('data-tab-target'));
}

function getProductDescriptionByCode(productCode) {
  const product = fanProductsCache.find(item => String(item.productCode || '') === String(productCode || ''));
  return product?.description || '';
}

function getProductDisplayName(productCode) {
  const description = getProductDescriptionByCode(productCode);

  if (description) {
    return description;
  }

  return productCode || '-';
}

function renderModuleLoading(containerId, message) {
  const container = byId(containerId);
  if (!container) return;

  container.innerHTML = `<div class="module-placeholder">${escapeHtml(message)}</div>`;
}

function renderModuleError(containerId, message) {
  const container = byId(containerId);
  if (!container) return;

  container.innerHTML = `<div class="module-placeholder">${escapeHtml(message)}</div>`;
}

function renderSimpleTable(containerId, columns, rows, emptyMessage) {
  const container = byId(containerId);
  if (!container) return;

  if (!rows.length) {
    container.innerHTML = `<div class="module-placeholder">${escapeHtml(emptyMessage)}</div>`;
    return;
  }

  const headHtml = columns
    .map(column => `<th>${escapeHtml(column.label)}</th>`)
    .join('');

  const bodyHtml = rows
    .map(row => {
      const cells = columns
        .map(column => `<td>${escapeHtml(row[column.key])}</td>`)
        .join('');

      return `<tr>${cells}</tr>`;
    })
    .join('');

  container.innerHTML = `
    <table class="module-table">
      <thead>
        <tr>${headHtml}</tr>
      </thead>
      <tbody>
        ${bodyHtml}
      </tbody>
    </table>
  `;
}

async function ensureFanProductsCacheLoaded() {
  if (fanProductsCache.length) {
    return fanProductsCache;
  }

  const data = await apiRequestSilent('/fan/products/all');
  fanProductsCache = data.items || data.products || [];
  return fanProductsCache;
}

async function loadRealStockModule() {
  try {
    renderModuleLoading('realStockModule', 'Se incarca stocurile reale...');

    await ensureFanProductsCacheLoaded();

    const stockData = await apiRequestSilent('/fan/products/stock?stateId=1');
    const stockItems = stockData.items || stockData.products || [];

    const rows = stockItems
      .map(item => {
        const productCode = String(item.productCode || '').trim();
        const stockReal = Number(item.quantity ?? item.available ?? 0);

        return {
          denumireProdus: getProductDisplayName(productCode),
          stockReal
        };
      })
      .sort((a, b) => String(a.denumireProdus).localeCompare(String(b.denumireProdus), 'ro'));

    renderSimpleTable(
      'realStockModule',
      [
        { key: 'denumireProdus', label: 'Denumire produs' },
        { key: 'stockReal', label: 'Stock real' }
      ],
      rows,
      'Nu exista stocuri de afisat.'
    );
  } catch (err) {
    console.error(err);
    renderModuleError('realStockModule', 'Nu am putut incarca stocurile reale.');
  }
}

async function loadDamagedProductsModule() {
  try {
    renderModuleLoading('damagedProductsModule', 'Se incarca produsele deteriorate...');

    await ensureFanProductsCacheLoaded();

    const now = new Date();
    const start = new Date(now);
    start.setDate(start.getDate() - 30);

    const startDate = encodeURIComponent(formatDateToFan(start));
    const endDate = encodeURIComponent(formatDateToFan(now));

    const data = await apiRequestSilent(`/fan/returns/report?startDate=${startDate}&endDate=${endDate}`);
    const items = data.orders || data.items || [];

    const damagedRows = items
      .filter(item => item && item.isDamaged === true)
      .map(item => {
        const productCode = String(item.productCode || '').trim();
        const quantity = Number(item.quantity || 0);
        const orderNumber = String(item.orderNumber || '').trim();

        return {
          denumireProdus: getProductDisplayName(productCode),
          productCode: productCode || '-',
          cantitate: quantity,
          orderNumber: orderNumber || '-'
        };
      })
      .sort((a, b) => String(a.denumireProdus).localeCompare(String(b.denumireProdus), 'ro'));

    renderSimpleTable(
      'damagedProductsModule',
      [
        { key: 'denumireProdus', label: 'Denumire produs' },
        { key: 'productCode', label: 'Cod produs' },
        { key: 'cantitate', label: 'Cantitate' },
        { key: 'orderNumber', label: 'Order number' }
      ],
      damagedRows,
      'Nu exista produse deteriorate in ultimele 30 de zile.'
    );
  } catch (err) {
    console.error(err);
    renderModuleError('damagedProductsModule', 'Nu am putut incarca produsele deteriorate.');
  }
}

async function loadDashboardModules() {
  await Promise.allSettled([
    loadRealStockModule(),
    loadDamagedProductsModule()
  ]);
}

function attachGlobalButtonListeners() {
  bindClickById('btn-clear-output', () => {
    if (!output) return;
    output.textContent = 'Aici vor aparea raspunsurile JSON...';
  });

  bindClickById('btn-load-inbound-products', () => {
    loadInboundProducts();
  });

  bindClickById('btn-add-inbound-item', () => {
    addInboundItemRow();
  });

bindClickById('btn-add-return-item', () => {
  addReturnItemRow();
});

  bindClickById('btn-health', () => {
    apiRequest('Health', '/health');
  });

  bindClickById('btn-refresh-real-stock', () => {
    loadRealStockModule();
  });

  bindClickById('btn-refresh-damaged-products', () => {
    loadDamagedProductsModule();
  });

  bindClickById('btn-products-all', () => {
    apiRequest('Products all', '/fan/products/all');
  });

  bindClickById('btn-product-details', () => {
    const productCode = value('productCodeDetails');
    apiRequest('Product details', `/fan/products/details?productCode=${encodeURIComponent(productCode)}`);
  });

  bindClickById('btn-product-barcodes', () => {
    const productCode = value('productCodeBarcodes');
    apiRequest('Product barcodes', `/fan/products/barcodes?productCode=${encodeURIComponent(productCode)}`);
  });

  bindClickById('btn-product-uom', () => {
    const productCode = value('productCodeUom');
    apiRequest('Product units of measure', `/fan/products/units-of-measure?productCode=${encodeURIComponent(productCode)}`);
  });

  bindClickById('btn-product-stock', () => {
    const stateId = value('productStockStateId');
    apiRequest('Product stock', `/fan/products/stock?stateId=${encodeURIComponent(stateId)}`);
  });

  bindClickById('btn-send-order', () => {
    const orderId = value('outboundOrderId');
    apiRequest('Send order to FAN', `/fan/send-order/${encodeURIComponent(orderId)}`);
  });

  bindClickById('btn-get-outbound', () => {
    const orderNumber = value('getOutboundOrderNumber');
    apiRequest('Get outbound', `/fan/outbound/${encodeURIComponent(orderNumber)}`);
  });

  bindClickById('btn-outbound-report', () => {
    const orderNumber = value('outboundReportOrderNumber');
    apiRequest('Outbound report', `/fan/outbound/report?orderNumber=${encodeURIComponent(orderNumber)}`);
  });

  bindClickById('btn-cancel-outbound', () => {
    const orderNumber = value('cancelOutboundOrderNumber');
    apiRequest('Cancel outbound', '/fan/outbound/cancel', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        orderNumbers: [orderNumber]
      })
    });
  });

  bindClickById('btn-create-inbound', async () => {
  const formValidation = getInboundFormValidation();

  const payload = {
    orderDate: formatDatetimeLocalToFan(value('inboundOrderDate')),
    orderNumber: value('inboundOrderNumber'),
    deliveryDate: formatDatetimeLocalToFan(value('inboundDeliveryDate')),
    supplier: value('inboundSupplier'),
    supplierName: value('inboundSupplierName'),
    items: getInboundSummary().items
  };

  if (!formValidation.isValid) {
    showError('Create inbound', { message: formValidation.errors.join('\n') });
    return;
  }

  if (isSubmittingInbound) {
    return;
  }

  isSubmittingInbound = true;
  updateInboundSubmitState();

  try {
    await apiRequest('Create inbound', '/fan/inbound/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    resetInboundFormAfterSuccess();
    await loadNextInboundOrderNumber();
  } catch (err) {
    try {
      const parsed =
        typeof err?.responseBody === 'string'
          ? JSON.parse(err.responseBody)
          : err?.responseBody;

      if (parsed?.code === 'INBOUND_DUPLICATE') {
        setValue('inboundOrderNumber', parsed.orderNumber || payload.orderNumber);
      }
    } catch {
      // nu facem nimic suplimentar
    }
  } finally {
    isSubmittingInbound = false;
    updateInboundSubmitState();
  }
});

bindClickById('btn-create-return', async () => {
  const formValidation = getReturnFormValidation();

  const payload = {
    orderDate: formatDatetimeLocalToFan(value('returnOrderDate')),
    orderNumber: value('returnOrderNumber'),
    deliveryDate: formatDatetimeLocalToFan(value('returnDeliveryDate')),
    supplier: value('returnSupplier'),
    supplierName: value('returnSupplierName'),
    originalOrderNumber: value('returnOriginalOrderNumber'),
    awb: value('returnAwb'),
    items: getReturnSummary().items
  };

  if (!formValidation.isValid) {
    showError('Create return', { message: formValidation.errors.join('\n') });
    return;
  }

  if (isSubmittingReturn) {
    return;
  }

  isSubmittingReturn = true;
  updateReturnSubmitState();

  try {
    await apiRequest('Create return', '/fan/returns/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    returnItems = [createEmptyReturnItem()];
    setValue('returnOrderDate', getNowForDatetimeLocal());
    setValue('returnDeliveryDate', '');
    setValue('returnSupplier', getEffectiveSupplierValue());
    setValue('returnSupplierName', '');
    setValue('returnOrderNumber', '');
    setValue('returnOriginalOrderNumber', '');
    setValue('returnAwb', '');

    renderReturnItems();
  } catch (err) {
  } finally {
    isSubmittingReturn = false;
    updateReturnSubmitState();
  }
});

  bindClickById('btn-get-inbound', () => {
    const orderNumber = value('getInboundOrderNumber');
    apiRequest('Get inbound', `/fan/inbound/${encodeURIComponent(orderNumber)}`);
  });

  bindClickById('btn-inbound-report', () => {
    const orderNumber = value('inboundReportOrderNumber');
    apiRequest('Inbound report', `/fan/inbound/report?orderNumber=${encodeURIComponent(orderNumber)}`);
  });

  bindClickById('btn-shipment-data', () => {
    const orderNumber = value('shipmentOrderNumber');
    apiRequest('Shipment data', `/fan/shipment-data/${encodeURIComponent(orderNumber)}`);
  });

  bindClickById('btn-fan-to-shopify', () => {
    const orderId = value('fanToShopifyOrderId');

    apiRequest('FAN to Shopify', '/fan-to-shopify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ orderId })
    });
  });

  bindClickById('btn-return-report', () => {
  const orderNumber = value('returnOrderNumberSearch');
  apiRequest('Return report', `/fan/returns/report/${encodeURIComponent(orderNumber)}`);
});
}

function initApp() {
  initTabs();

  inboundItems = [createEmptyInboundItem()];
  renderInboundItems();

  returnItems = [createEmptyReturnItem()];
  renderReturnItems();

  attachInboundHeaderListeners();
  attachReturnHeaderListeners();
  attachGlobalButtonListeners();

  initializeInboundDefaults();

  setValue('returnOrderDate', getNowForDatetimeLocal());
  setValue('returnSupplier', getEffectiveSupplierValue());
  renderReturnSummary();
  updateReturnSubmitState();

  loadNextInboundOrderNumber();
  loadDashboardModules();
}
initApp();