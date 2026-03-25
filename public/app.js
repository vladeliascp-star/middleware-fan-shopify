const output = document.getElementById('output');

let inboundItems = [];
let fanProductsCache = [];
let isSubmittingInbound = false;

const FAN_SUPPLIER_MAX_LENGTH = 20;
const SUPPLIER_PRIMARY = 'PovesteDeVin - Eight Sigma';
const SUPPLIER_FALLBACK = 'PDV - Eight Sigma';

function showResult(title, data) {
  output.textContent =
    `=== ${title} ===\n\n` +
    JSON.stringify(data, null, 2);
}

function showError(title, err) {
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

function value(id) {
  return document.getElementById(id).value.trim();
}

function setValue(id, newValue) {
  const element = document.getElementById(id);
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
  const button = document.getElementById('btn-create-inbound');

  if (!button) return;

  const validation = getInboundFormValidation();
  button.disabled = isSubmittingInbound || !validation.isValid;
}

function renderInboundSummary() {
  const container = document.getElementById('inboundSummaryContainer');

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
  const container = document.getElementById('inboundItemsContainer');

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

    renderInboundItems();

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

    console.log('DEBUG order number:', data);

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
    const element = document.getElementById(id);

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

function resetInboundFormAfterSuccess() {
  inboundItems = [createEmptyInboundItem()];

  setValue('inboundOrderDate', getNowForDatetimeLocal());
  setValue('inboundDeliveryDate', '');
  setValue('inboundSupplier', getEffectiveSupplierValue());
  setValue('inboundSupplierName', '');

  renderInboundItems();
}

document.getElementById('btn-clear-output').addEventListener('click', () => {
  output.textContent = 'Aici vor aparea raspunsurile JSON...';
});

document.getElementById('btn-load-inbound-products').addEventListener('click', () => {
  loadInboundProducts();
});

document.getElementById('btn-add-inbound-item').addEventListener('click', () => {
  addInboundItemRow();
});

document.getElementById('btn-health').addEventListener('click', () => {
  apiRequest('Health', '/health');
});

document.getElementById('btn-products-all').addEventListener('click', () => {
  apiRequest('Products all', '/fan/products/all');
});

document.getElementById('btn-product-details').addEventListener('click', () => {
  const productCode = value('productCodeDetails');
  apiRequest('Product details', `/fan/products/details?productCode=${encodeURIComponent(productCode)}`);
});

document.getElementById('btn-product-barcodes').addEventListener('click', () => {
  const productCode = value('productCodeBarcodes');
  apiRequest('Product barcodes', `/fan/products/barcodes?productCode=${encodeURIComponent(productCode)}`);
});

document.getElementById('btn-product-uom').addEventListener('click', () => {
  const productCode = value('productCodeUom');
  apiRequest('Product units of measure', `/fan/products/units-of-measure?productCode=${encodeURIComponent(productCode)}`);
});

document.getElementById('btn-product-stock').addEventListener('click', () => {
  const stateId = value('productStockStateId');
  apiRequest('Product stock', `/fan/products/stock?stateId=${encodeURIComponent(stateId)}`);
});

document.getElementById('btn-send-order').addEventListener('click', () => {
  const orderId = value('outboundOrderId');
  apiRequest('Send order to FAN', `/fan/send-order/${encodeURIComponent(orderId)}`);
});

document.getElementById('btn-get-outbound').addEventListener('click', () => {
  const orderNumber = value('getOutboundOrderNumber');
  apiRequest('Get outbound', `/fan/outbound/${encodeURIComponent(orderNumber)}`);
});

document.getElementById('btn-outbound-report').addEventListener('click', () => {
  const orderNumber = value('outboundReportOrderNumber');
  apiRequest('Outbound report', `/fan/outbound/report?orderNumber=${encodeURIComponent(orderNumber)}`);
});

document.getElementById('btn-cancel-outbound').addEventListener('click', () => {
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

document.getElementById('btn-create-inbound').addEventListener('click', async () => {
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

document.getElementById('btn-get-inbound').addEventListener('click', () => {
  const orderNumber = value('getInboundOrderNumber');
  apiRequest('Get inbound', `/fan/inbound/${encodeURIComponent(orderNumber)}`);
});

document.getElementById('btn-inbound-report').addEventListener('click', () => {
  const orderNumber = value('inboundReportOrderNumber');
  apiRequest('Inbound report', `/fan/inbound/report?orderNumber=${encodeURIComponent(orderNumber)}`);
});

document.getElementById('btn-shipment-data').addEventListener('click', () => {
  const orderNumber = value('shipmentOrderNumber');
  apiRequest('Shipment data', `/fan/shipment-data/${encodeURIComponent(orderNumber)}`);
});

document.getElementById('btn-fan-to-shopify').addEventListener('click', () => {
  const orderId = value('fanToShopifyOrderId');

  apiRequest('FAN to Shopify', '/fan-to-shopify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ orderId })
  });
});

document.getElementById('btn-return-report').addEventListener('click', () => {
  const orderNumber = value('returnOrderNumber');
  apiRequest('Return report', `/fan/returns/report/${encodeURIComponent(orderNumber)}`);
});

inboundItems = [createEmptyInboundItem()];
renderInboundItems();
attachInboundHeaderListeners();
initializeInboundDefaults();
loadNextInboundOrderNumber();