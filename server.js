require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const crypto = require('crypto');
const COUNTER_FILE = path.join(__dirname, 'inbound-counter.json');

const app = express();
app.use('/webhooks/shopify', express.raw({ type: '*/*' }));
app.use(express.json());

app.use('/fan', requireAdminBasicAuth);
app.use('/shopify', requireAdminBasicAuth);
app.use('/sync', requireAdminBasicAuth);
app.use('/reconcile', requireAdminBasicAuth);
app.use('/fan-to-shopify', requireAdminBasicAuth);

app.get('/', requireAdminBasicAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/index.html', requireAdminBasicAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

let oblioToken = null;
let oblioTokenExpiresAt = 0;

function getOblioClientId() {
  return process.env.OBLIO_CLIENT_ID;
}

function getOblioClientSecret() {
  return process.env.OBLIO_CLIENT_SECRET;
}

function getOblioCif() {
  return process.env.OBLIO_CIF;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getOblioToken() {
  if (oblioToken && Date.now() < oblioTokenExpiresAt - 60000) {
    return oblioToken;
  }

  const params = new URLSearchParams();
  params.append('client_id', getOblioClientId());
  params.append('client_secret', getOblioClientSecret());

  const response = await axios.post(
    'https://www.oblio.eu/api/authorize/token',
    params,
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 15000
    }
  );

  const accessToken = response.data?.access_token;
  const expiresIn = Number(response.data?.expires_in || 3600);

  if (!accessToken) {
    throw new Error('Oblio access_token lipsa');
  }

  oblioToken = accessToken;
  oblioTokenExpiresAt = Date.now() + (expiresIn * 1000);

  return oblioToken;
}

async function listOblioInvoicesForOrder(orderName) {
  const token = await getOblioToken();

  const response = await axios.get(
    'https://www.oblio.eu/api/docs/invoice/list',
    {
      headers: {
        Authorization: `Bearer ${token}`
      },
      params: {
        cif: getOblioCif()
      },
      timeout: 15000
    }
  );

  const invoices = Array.isArray(response.data?.data) ? response.data.data : [];

  return invoices.filter(inv => {
    const mentions = String(inv?.mentions || '');
    const clientName = String(inv?.client?.name || '');
    const noticeNumber = String(inv?.noticeNumber || '');
    const orderNumber = String(inv?.number || '');

    return (
      mentions.includes(orderName) ||
      noticeNumber.includes(orderName) ||
      clientName.includes(orderName) ||
      orderNumber === orderName.replace('#', '')
    );
  });
}

async function getOblioInvoiceDetails(seriesName, number) {
  const token = await getOblioToken();

  const response = await axios.get(
    'https://www.oblio.eu/api/docs/invoice',
    {
      headers: {
        Authorization: `Bearer ${token}`
      },
      params: {
        cif: getOblioCif(),
        seriesName,
        number
      },
      timeout: 15000
    }
  );

  return response.data?.data || null;
}

function oblioInvoiceAlreadyCollected(invoiceDetails) {
  const collects = Array.isArray(invoiceDetails?.collects) ? invoiceDetails.collects : [];
  return collects.length > 0;
}

async function collectOblioInvoice(invoice, order) {
  const token = await getOblioToken();

  const form = new URLSearchParams();
  form.append('cif', getOblioCif());
  form.append('seriesName', String(invoice.seriesName));
  form.append('number', String(invoice.number));
  form.append('collect[type]', 'Card');
  form.append('collect[documentNumber]', `Shopify ${order.name || ('#' + order.order_number)}`);
  form.append('collect[issueDate]', new Date().toISOString().slice(0, 10));

  await axios.put(
    'https://www.oblio.eu/api/docs/invoice/collect',
    form,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 15000
    }
  );
}

async function handleOblioCollectForPaidOrder(order) {
  const orderName = String(order?.name || `#${order?.order_number || ''}`).trim();

  if (!orderName || orderName === '#') {
    logError('OBLIO_COLLECT', 'order name lipsa', {
      orderId: order?.id || null
    });
    return;
  }

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      logInfo('OBLIO_COLLECT', 'search invoice attempt', {
        orderId: order.id,
        orderName,
        attempt
      });

      const invoices = await listOblioInvoicesForOrder(orderName);

      if (!invoices.length) {
        logInfo('OBLIO_COLLECT', 'invoice not found yet', {
          orderId: order.id,
          orderName,
          attempt
        });

        await sleep(15000);
        continue;
      }

      const invoice = invoices[0];

      const invoiceDetails = await getOblioInvoiceDetails(
        invoice.seriesName,
        invoice.number
      );

      if (oblioInvoiceAlreadyCollected(invoiceDetails)) {
        logInfo('OBLIO_COLLECT', 'invoice already collected - skip', {
          orderId: order.id,
          orderName,
          seriesName: invoice.seriesName,
          number: invoice.number
        });
        return;
      }

      await collectOblioInvoice(invoice, order);

      logInfo('OBLIO_COLLECT', 'invoice collected successfully', {
        orderId: order.id,
        orderName,
        seriesName: invoice.seriesName,
        number: invoice.number
      });

      return;
    } catch (err) {
      logError('OBLIO_COLLECT', 'attempt failed', {
        orderId: order?.id || null,
        orderName,
        attempt,
        message: err.message,
        response: err.response?.data || null
      });

      await sleep(10000);
    }
  }

  logError('OBLIO_COLLECT', 'failed after retries', {
    orderId: order?.id || null,
    orderName
  });
}

let shopifyToken = null;
let shopifyTokenExpiresAt = 0;
let FAN_PRODUCTS_CACHE = new Set();
const processedOrders = new Set();
const processedOrdersFile = path.join(__dirname, 'processed_orders.json');
const processedReturns = new Set();
const processedReturnsFile = path.join(__dirname, 'processed_returns.json');
const processedProductWebhooks = new Set();
const processedProductWebhooksFile = path.join(__dirname, 'processed_product_webhooks.json');
const shopifyProductSkuMapFile = path.join(__dirname, 'shopify_product_sku_map.json');
const shopifyInventoryItemMapFile = path.join(__dirname, 'shopify_inventory_item_map.json');
const shopifyLastSyncedStockFile = path.join(__dirname, 'shopify_last_synced_stock.json');

let shopifyProductSkuMap = {};
let shopifyInventoryItemMap = {};
let shopifyLastSyncedStock = {};
function logInfo(scope, message, extra = null) {
  if (extra) {
    console.log(`[INFO] [${scope}] ${message}`, extra);
    return;
  }

  console.log(`[INFO] [${scope}] ${message}`);
}

function logError(scope, message, extra = null) {
  if (extra) {
    console.error(`[ERROR] [${scope}] ${message}`, extra);
    return;
  }

  console.error(`[ERROR] [${scope}] ${message}`);
}
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];

  if (!key || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}
function requireAdminBasicAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';

  if (!authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).send('Authentication required');
  }

  const base64Credentials = authHeader.split(' ')[1];
  const credentials = Buffer.from(base64Credentials, 'base64').toString('utf8');

  const [username, password] = credentials.split(':');

  if (
    username !== process.env.ADMIN_USER ||
    password !== process.env.ADMIN_PASSWORD
  ) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).send('Unauthorized');
  }

  next();
}
function loadProcessedOrders() {
  if (!fs.existsSync(processedOrdersFile)) {
    return;
  }

  const raw = fs.readFileSync(processedOrdersFile, 'utf8');
  const orders = JSON.parse(raw);

  orders.forEach(orderId => {
    processedOrders.add(String(orderId));
  });

  console.log('[PROCESSED ORDERS LOADED]', processedOrders.size);
}

async function getShopifyToken() {
  if (shopifyToken && Date.now() < shopifyTokenExpiresAt - 60000) {
    return shopifyToken;
  }
  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('client_id', process.env.SHOPIFY_CLIENT_ID);
  params.append('client_secret', process.env.SHOPIFY_CLIENT_SECRET);

  const response = await axios.post(
    `https://${process.env.SHOPIFY_SHOP}.myshopify.com/admin/oauth/access_token`,
    params,
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 15000
    }
  );

  shopifyToken = response.data.access_token;
  shopifyTokenExpiresAt = Date.now() + (24 * 60 * 60 * 1000); // 24h

  return shopifyToken;
}

async function tagOrderAsSynced(orderId) {
  const token = await getShopifyToken();

  // 1. luam comanda
  const response = await axios.get(
    `https://${process.env.SHOPIFY_SHOP}.myshopify.com/admin/api/2023-10/orders/${orderId}.json`,
    {
      headers: {
        'X-Shopify-Access-Token': token
      }
    }
  );

  const order = response.data.order;
  const existingTags = order.tags ? order.tags.split(',').map(t => t.trim()) : [];

  if (!existingTags.includes('fan-awb-done')) {
    existingTags.push('fan-awb-done');
  }

  // 2. update tags
  await axios.put(
    `https://${process.env.SHOPIFY_SHOP}.myshopify.com/admin/api/2023-10/orders/${orderId}.json`,
    {
      order: {
        id: orderId,
        tags: existingTags.join(', ')
      }
    },
    {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      }
    }
  );
}

async function getShopifyVariantInventoryBySku(sku) {
  const token = await getShopifyToken();

  const query = `
    query getVariantBySku($query: String!) {
      productVariants(first: 1, query: $query) {
        edges {
          node {
            id
            sku
            inventoryItem {
              id
            }
          }
        }
      }
    }
  `;

  const response = await axios.post(
    `https://${process.env.SHOPIFY_SHOP}.myshopify.com/admin/api/2023-10/graphql.json`,
    {
      query,
      variables: {
        query: `sku:${sku}`
      }
    },
    {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    }
  );

  const edge = response.data?.data?.productVariants?.edges?.[0];

  if (!edge) {
    return null;
  }

  const variantGid = edge.node.id;
  const inventoryItemGid = edge.node.inventoryItem?.id || null;

  return {
    sku: edge.node.sku,
    variant_id: variantGid ? variantGid.split('/').pop() : null,
    inventory_item_id: inventoryItemGid ? inventoryItemGid.split('/').pop() : null
  };
}

async function getShopifyFulfillmentOrdersByOrderId(orderId) {
  const token = await getShopifyToken();

  const query = `
    query getOrderFulfillmentOrders($id: ID!) {
      order(id: $id) {
        id
        name
        displayFulfillmentStatus
        fulfillmentOrders(first: 10) {
          edges {
            node {
              id
              status
              requestStatus
              assignedLocation {
                location {
                  id
                  name
                }
              }
              lineItems(first: 20) {
                edges {
                  node {
                    id
                    totalQuantity
                    remainingQuantity
                    lineItem {
                      id
                      sku
                      name
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const response = await axios.post(
    `https://${process.env.SHOPIFY_SHOP}.myshopify.com/admin/api/2026-01/graphql.json`,
    {
      query,
      variables: {
        id: `gid://shopify/Order/${orderId}`
      }
    },
    {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    }
  );

  const edges = response.data?.data?.order?.fulfillmentOrders?.edges || [];

const simplified = edges.map(e => {
  const fo = e.node;

  return {
    fulfillmentOrderId: fo.id,
    status: fo.status,
    requestStatus: fo.requestStatus,
    location: fo.assignedLocation?.location?.name,
    items: fo.lineItems.edges.map(i => ({
      sku: i.node.lineItem.sku,
      remainingQuantity: i.node.remainingQuantity,
      totalQuantity: i.node.totalQuantity
    }))
  };
});

return simplified;
}

function getFulfillableItems(fulfillmentOrders) {
  const result = [];

  for (const fo of fulfillmentOrders) {
    if (fo.status !== 'OPEN') {
      continue;
    }

    const itemsToFulfill = fo.items
      .filter(i => 
        i.remainingQuantity > 0 &&
        i.sku && 
        i.sku !== 'SGR'
     )
      .map(i => ({
        sku: i.sku,
        quantity: i.remainingQuantity
      }));
console.log('[FULFILLABLE FILTER CHECK]', JSON.stringify({
  fulfillmentOrderId: fo.fulfillmentOrderId,
  rawItems: fo.items,
  filteredItems: itemsToFulfill
}, null, 2));
    if (itemsToFulfill.length === 0) {
      continue;
    }

    result.push({
      fulfillmentOrderId: fo.fulfillmentOrderId,
      items: itemsToFulfill
    });
  }

  return result;
}

async function createShopifyFulfillment(fulfillmentOrderId, trackingNumber, trackingCompany, trackingUrl = null) {
  const token = await getShopifyToken();

  const mutation = `
    mutation fulfillmentCreateV2($fulfillment: FulfillmentV2Input!) {
      fulfillmentCreateV2(fulfillment: $fulfillment) {
        fulfillment {
          id
          status
          trackingInfo(first: 10) {
            company
            number
            url
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    fulfillment: {
      notifyCustomer: false,
      trackingInfo: {
        company: trackingCompany,
        number: trackingNumber,
        url: trackingUrl
      },
      lineItemsByFulfillmentOrder: [
        {
          fulfillmentOrderId: fulfillmentOrderId
        }
      ]
    }
  };

  const response = await axios.post(
    `https://${process.env.SHOPIFY_SHOP}.myshopify.com/admin/api/2026-01/graphql.json`,
    {
      query: mutation,
      variables
    },
    {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    }
  );

  const result = response.data?.data?.fulfillmentCreateV2;

  if (!result) {
    throw new Error('Shopify fulfillmentCreateV2 a returnat raspuns gol');
  }

  if (result.userErrors && result.userErrors.length > 0) {
    throw new Error(`Shopify fulfillmentCreateV2 userErrors: ${JSON.stringify(result.userErrors)}`);
  }

  return result.fulfillment;
}

async function createShopifyFulfillmentForOrder(orderId, trackingNumber, trackingCompany, trackingUrl = null) {
  const fulfillmentOrders = await getShopifyFulfillmentOrdersByOrderId(orderId);
  const fulfillable = getFulfillableItems(fulfillmentOrders);
  
if (!fulfillable.length) {
  return {
    alreadyFulfilled: true,
    orderId
  };
}

  const targetFulfillmentOrder = fulfillable[0];

  return await createShopifyFulfillment(
    targetFulfillmentOrder.fulfillmentOrderId,
    trackingNumber,
    trackingCompany,
    trackingUrl
  );
}

async function autoFulfillSGR(orderId) {
  const fulfillmentOrders = await getShopifyFulfillmentOrdersByOrderId(orderId);

  for (const fo of fulfillmentOrders) {
  if (fo.status !== 'OPEN') continue;

  const hasSGR = fo.items.some(i => 
    i.sku === 'SGR' &&
    i.remainingQuantity > 0
  );

  // 🔒 skip daca nu mai e nimic de facut
  if (!hasSGR) {
    console.log('[SGR SKIP] Already fulfilled or no quantity');
    continue;
  }

  console.log('[SGR AUTO FULFILL] Found SGR fulfillmentOrder', fo.fulfillmentOrderId);

  await createShopifyFulfillment(
    fo.fulfillmentOrderId,
    null,
    null,
    null
  );
}
}

async function getShopifyInventoryLevel(inventoryItemId, locationId) {
  const token = await getShopifyToken();

  const response = await axios.get(
    `https://${process.env.SHOPIFY_SHOP}.myshopify.com/admin/api/2023-10/inventory_levels.json`,
    {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      params: {
        inventory_item_ids: inventoryItemId,
        location_ids: locationId
      },
      timeout: 15000
    }
  );

  return response.data;
}

function extractAwbFromFanResponse(fanOrder) {
  if (!fanOrder) return null;

  // Variante posibile FAN
  return (
    fanOrder.awb ||
    fanOrder.AWB ||
    fanOrder.trackingNumber ||
    fanOrder.tracking_number ||
    fanOrder.shipmentNumber ||
    fanOrder.shipment_number ||
    fanOrder.deliveryNumber ||
    null
  );
}

async function setShopifyInventoryLevel(inventoryItemId, locationId, available) {
  const token = await getShopifyToken();

  const response = await axios.post(
    `https://${process.env.SHOPIFY_SHOP}.myshopify.com/admin/api/2023-10/inventory_levels/set.json`,
    {
      location_id: locationId,
      inventory_item_id: inventoryItemId,
      available: available
    },
    {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    }
  );

  return response.data;
}

function loadProcessedReturns() {
  if (!fs.existsSync(processedReturnsFile)) {
    return;
  }

  const raw = fs.readFileSync(processedReturnsFile, 'utf8');
  const returns = JSON.parse(raw);

  returns.forEach(returnId => {
    processedReturns.add(String(returnId));
  });

  console.log('[PROCESSED RETURNS LOADED]', processedReturns.size);
}
app.get('/shopify/orders/:id', async (req, res) => {
  try {
    const token = await getShopifyToken();

    const response = await axios.get(
      `https://${process.env.SHOPIFY_SHOP}.myshopify.com/admin/api/2023-10/orders/${req.params.id}.json`,
      {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        }
      }
    );
const products = extractProductsForWMS(response.data.order);

const fanPayload = buildFanOrderPayload(response.data.order);
console.log('FAN PAYLOAD:', JSON.stringify(fanPayload, null, 2));

console.log('WMS PRODUCTS:', products);
res.json(response.data);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Shopify fetch failed' });
  }
});

function loadProcessedProductWebhooks() {
  if (!fs.existsSync(processedProductWebhooksFile)) {
    return;
  }

  const raw = fs.readFileSync(processedProductWebhooksFile, 'utf8');
  const items = JSON.parse(raw);

  items.forEach(key => {
    processedProductWebhooks.add(String(key));
  });

  console.log('[PROCESSED PRODUCT WEBHOOKS LOADED]', processedProductWebhooks.size);
}

function saveProcessedProductWebhooks() {
  fs.writeFileSync(
    processedProductWebhooksFile,
    JSON.stringify(Array.from(processedProductWebhooks), null, 2)
  );
}

function loadShopifyProductSkuMap() {
  if (!fs.existsSync(shopifyProductSkuMapFile)) {
    shopifyProductSkuMap = {};
    return;
  }

  const raw = fs.readFileSync(shopifyProductSkuMapFile, 'utf8');
  shopifyProductSkuMap = JSON.parse(raw || '{}');
}

function saveShopifyProductSkuMap() {
  fs.writeFileSync(
    shopifyProductSkuMapFile,
    JSON.stringify(shopifyProductSkuMap, null, 2)
  );
}

function loadShopifyInventoryItemMap() {
  if (!fs.existsSync(shopifyInventoryItemMapFile)) {
    shopifyInventoryItemMap = {};
    return;
  }

  const raw = fs.readFileSync(shopifyInventoryItemMapFile, 'utf8');
  shopifyInventoryItemMap = JSON.parse(raw || '{}');
}

function saveShopifyInventoryItemMap() {
  fs.writeFileSync(
    shopifyInventoryItemMapFile,
    JSON.stringify(shopifyInventoryItemMap, null, 2)
  );
}

function getSavedInventoryItemIdBySku(sku) {
  return shopifyInventoryItemMap[String(sku || '').trim()] || null;
}

function saveInventoryItemIdBySku(sku, inventoryItemId) {
  const cleanSku = String(sku || '').trim();
  const cleanInventoryItemId = String(inventoryItemId || '').trim();

  if (!cleanSku || !cleanInventoryItemId) {
    return;
  }

  shopifyInventoryItemMap[cleanSku] = cleanInventoryItemId;
  saveShopifyInventoryItemMap();
}

function loadShopifyLastSyncedStock() {
  if (!fs.existsSync(shopifyLastSyncedStockFile)) {
    shopifyLastSyncedStock = {};
    return;
  }

  const raw = fs.readFileSync(shopifyLastSyncedStockFile, 'utf8');
  shopifyLastSyncedStock = JSON.parse(raw || '{}');
}

function saveShopifyLastSyncedStock() {
  fs.writeFileSync(
    shopifyLastSyncedStockFile,
    JSON.stringify(shopifyLastSyncedStock, null, 2)
  );
}

function getLastSyncedStockBySku(sku) {
  const cleanSku = String(sku || '').trim();

  if (!cleanSku) {
    return null;
  }

  return Object.prototype.hasOwnProperty.call(shopifyLastSyncedStock, cleanSku)
    ? Number(shopifyLastSyncedStock[cleanSku])
    : null;
}

function saveLastSyncedStockBySku(sku, quantity) {
  const cleanSku = String(sku || '').trim();

  if (!cleanSku) {
    return;
  }

  shopifyLastSyncedStock[cleanSku] = Number(quantity);
  saveShopifyLastSyncedStock();
}

function saveProductSkusFromShopifyProduct(product) {
  const productId = String(product?.id || '').trim();

  if (!productId) {
    return;
  }

  const variants = Array.isArray(product?.variants) ? product.variants : [];

  const skus = variants
    .map(v => String(v?.sku || '').trim())
    .filter(Boolean);

  shopifyProductSkuMap[productId] = skus;
  saveShopifyProductSkuMap();
}

function getSavedSkusByProductId(productId) {
  return shopifyProductSkuMap[String(productId)] || [];
}

function removeSavedSkusByProductId(productId) {
  delete shopifyProductSkuMap[String(productId)];
  saveShopifyProductSkuMap();
}

function buildProductWebhookDedupKey(topic, productId, updatedAt) {
  return `${topic}:${productId}:${updatedAt || 'no-updated-at'}`;
}

app.get('/shopify/fulfillment-orders/:id', async (req, res) => {
  try {
    const data = await getShopifyFulfillmentOrdersByOrderId(req.params.id);
    const fulfillable = getFulfillableItems(data);

    console.log('[FULFILLMENT ORDERS RAW]', JSON.stringify(data, null, 2));

    res.json(fulfillable);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({
      error: 'Fulfillment orders fetch failed'
    });
  }
});

app.post('/shopify/fulfill', async (req, res) => {
  try {
    const { fulfillmentOrderId, trackingNumber, trackingCompany, trackingUrl } = req.body;

    if (!fulfillmentOrderId || !trackingNumber || !trackingCompany) {
      return res.status(400).json({
        error: 'fulfillmentOrderId, trackingNumber si trackingCompany sunt obligatorii'
      });
    }

    const fulfillment = await createShopifyFulfillment(
      fulfillmentOrderId,
      trackingNumber,
      trackingCompany,
      trackingUrl || null
    );

    res.json({
      success: true,
      fulfillment
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({
      error: err.message || 'Shopify fulfillment create failed'
    });
  }
});

app.post('/shopify/fulfill-order', async (req, res) => {
  try {
    const { orderId, trackingNumber, trackingCompany, trackingUrl } = req.body;

    if (!orderId || !trackingNumber || !trackingCompany) {
      return res.status(400).json({
        error: 'orderId, trackingNumber si trackingCompany sunt obligatorii'
      });
    }

    const fulfillment = await createShopifyFulfillmentForOrder(
      orderId,
      trackingNumber,
      trackingCompany,
      trackingUrl || null
    );

    res.json({
      success: true,
      fulfillment
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({
      error: err.message || 'Shopify fulfillment create by order failed'
    });
  }
});

app.post('/fan-to-shopify', async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({
        error: 'orderId este obligatoriu'
      });
    }

    const result = await syncFanShipmentToShopify(orderId);

    if (!result.success) {
      return res.json(result);
    }

    res.json(result);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({
      error: err.message || 'FAN to Shopify fulfillment failed'
    });
  }
});
app.get('/fan/shipment-data/:orderNumber', async (req, res) => {
  try {
    const shipmentData = await getFanShipmentData(req.params.orderNumber);

    res.json(shipmentData);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({
      error: err.message || 'FAN shipment data fetch failed'
    });
  }
});

app.post('/reconcile/orders', async (req, res) => {
  try {
    const token = await getShopifyToken();

    const response = await axios.get(
      `https://${process.env.SHOPIFY_SHOP}.myshopify.com/admin/api/2023-10/orders.json`,
      {
        headers: {
          'X-Shopify-Access-Token': token
        },
        params: {
          status: 'any',
          limit: 50,
          order: 'created_at desc'
        }
      }
    );

    const orders = response.data.orders || [];

    let sent = 0;
    let skipped = 0;

    for (const order of orders) {
      if (processedOrders.has(String(order.id))) {
        skipped++;
        continue;
      }

      console.log('[RECONCILE SEND]', order.id);

      await sendOrderToFan(order);

      processedOrders.add(String(order.id));
      sent++;
    }

    fs.writeFileSync(
      processedOrdersFile,
      JSON.stringify(Array.from(processedOrders), null, 2)
    );

    res.json({
      total: orders.length,
      sent,
      skipped
    });

  } catch (err) {
    console.error('[RECONCILE ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/shopify/locations', async (req, res) => {
  try {
    const token = await getShopifyToken();

    const response = await axios.get(
      `https://${process.env.SHOPIFY_SHOP}.myshopify.com/admin/api/2023-10/locations.json`,
      {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        }
      }
    );

    res.json(response.data);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Shopify locations fetch failed' });
  }
});

app.get('/shopify/variant-by-sku/:sku', async (req, res) => {
  try {
    const result = await getShopifyVariantInventoryBySku(req.params.sku);

    if (!result) {
      return res.status(404).json({
        error: 'SKU negasit in Shopify'
      });
    }

    res.json(result);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({
      error: 'Shopify variant lookup failed'
    });
  }
});

app.get('/shopify/inventory-level', async (req, res) => {
  try {
    const { inventoryItemId, locationId } = req.query;

    if (!inventoryItemId || !locationId) {
      return res.status(400).json({
        error: 'inventoryItemId si locationId sunt obligatorii'
      });
    }

    const result = await getShopifyInventoryLevel(inventoryItemId, locationId);

    res.json(result);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({
      error: 'Shopify inventory level fetch failed'
    });
  }
});

app.post('/shopify/set-inventory', async (req, res) => {
  try {
    const { inventoryItemId, locationId, available } = req.body;

    if (
      inventoryItemId === undefined ||
      locationId === undefined ||
      available === undefined
    ) {
      return res.status(400).json({
        error: 'inventoryItemId, locationId si available sunt obligatorii'
      });
    }

    const result = await setShopifyInventoryLevel(
      inventoryItemId,
      locationId,
      available
    );

    res.json(result);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({
      error: 'Shopify inventory set failed'
    });
  }
});

app.post('/sync/stock', async (req, res) => {
  try {
    const { locationId } = req.body;

    if (!locationId) {
      return res.status(400).json({
        error: 'locationId este obligatoriu'
      });
    }

    await syncStockFromFanToShopify(locationId);

    res.json({ success: true });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({
      error: 'Sync failed'
    });
  }
});

app.get('/fan/send-order/:id', async (req, res) => {
  try {
    const token = await getShopifyToken();

    const shopifyResponse = await axios.get(
      `https://${process.env.SHOPIFY_SHOP}.myshopify.com/admin/api/2023-10/orders/${req.params.id}.json`,
      {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        }
      }
    );

    const order = shopifyResponse.data.order;

    const fanResponse = await sendOrderToFan(order);

    console.log('FAN RESPONSE:', JSON.stringify(fanResponse, null, 2));

    res.json(fanResponse);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'FAN send failed' });
  }
});

function extractProductsForWMS(order) {
  return order.line_items
    .filter(item => item.requires_shipping)
    .map(item => {
      const productCode = item.sku;

      if (!productCode) {
        throw new Error(`SKU lipsa pentru produs`);
      }

      if (!FAN_PRODUCTS_CACHE.has(productCode)) {
        throw new Error(`SKU NU EXISTA IN FAN: ${productCode}`);
      }

      return {
        sku: item.sku,
        productCode,
        quantity: item.quantity
      };
    });
}

function buildFanOrderPayload(order) {
  const shipping = order.shipping_address;

if (!shipping) {
    throw new Error('Comanda nu are shipping_address');
  }

  if (!shipping.first_name && !shipping.last_name) {
  throw new Error('Outbound: customerName este obligatoriu');
}

if (!shipping.address1) {
  throw new Error('Outbound: customerAddress este obligatoriu');
}

if (!shipping.city) {
  throw new Error('Outbound: customerCity este obligatoriu');
}

if (!shipping.phone) {
  throw new Error('Outbound: customerPhone este obligatoriu');
}

  const products = extractProductsForWMS(order);
if (!Array.isArray(products) || products.length === 0) {
  throw new Error('Outbound: orderDetails trebuie sa contina cel putin un produs');
}

  const isPaid = order.financial_status === 'paid';
  const isCod = !isPaid;
  const cashOnDelivery = isCod ? Number(order.total_outstanding || 0) : null;

  return {
    orderNumber: String(order.id),
    orderDate: new Date(order.created_at).toISOString().slice(0, 19).replace('T', ' '),

    customerName: `${shipping.first_name || ''} ${shipping.last_name || ''}`.trim(),
    customerContactPerson: `${shipping.first_name || ''} ${shipping.last_name || ''}`.trim(),
    customerAddress: [shipping.address1, shipping.address2].filter(Boolean).join(', '),
    customerCountryCode: shipping.country_code || process.env.DEFAULT_COUNTRY_CODE,
    customerCity: (shipping.city || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
    customerCounty: (shipping.province || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
    customerPhone: shipping.phone || '',
    customerEmail: order.email || '',
    carrier: 'FAN',
    service: isCod ? 'Cont colector' : 'Standard',
    cashOnDelivery: cashOnDelivery,
    paymentType: isCod ? 'cash' : 'card',
    transportPayment: 'expeditor',
    currency: order.currency || 'RON',
    deliveryMode: 'rutier',
    contentType: 'non document',
    action: 'save',

    orderDetails: products.map(p => ({
      productCode: p.productCode,
      quantity: p.quantity,
      unitOfMeasure: 'BUC',
      action: 'save'
    }))
  };
}

function buildFanInboundPayload(data) {
  if (!data.orderDate) {
    throw new Error('Inbound: orderDate este obligatoriu');
  }

  if (!data.orderNumber) {
    throw new Error('Inbound: orderNumber este obligatoriu');
  }

  if (!data.supplier) {
    throw new Error('Inbound: supplier este obligatoriu');
  }

  if (!data.supplierName) {
    throw new Error('Inbound: supplierName este obligatoriu');
  }

  if (!Array.isArray(data.items) || data.items.length === 0) {
    throw new Error('Inbound: items trebuie sa fie un array cu cel putin un produs');
  }

  return {
    orderDate: data.orderDate,
    orderNumber: data.orderNumber,
    erpOrderNumber: null,
    isReturn: data.isReturn === true,
    deliveryDate: data.deliveryDate,
    supplier: data.supplier,
    supplierName: data.supplierName,
    orderDetails: data.items.map(item => {
      if (!item.productCode) {
        throw new Error('Inbound: productCode este obligatoriu pentru fiecare produs');
      }

      if (!Number.isInteger(item.quantity) || item.quantity < 1) {
        throw new Error(`Inbound: quantity invalida pentru productCode ${item.productCode}`);
      }

      const detail = {
        productCode: item.productCode,
        unitOfMeasure: 'BUC',
        quantity: item.quantity
      };

      if (item.expirationDate) {
        detail.expirationDate = item.expirationDate;
      }

      if (item.lot) {
        detail.lot = item.lot;
      }

      return detail;
    })
  };
}

const SKU_TO_FAN_PRODUCT_CODE = {};

function mapSkuToFanProductCode(sku) {
  return sku; // folosim direct SKU-ul ca productCode
}
let fanToken = null;
let fanTokenFetchedAt = null;

const FAN_TOKEN_TTL_MS = 55 * 60 * 1000;

/**
 * TOKEN HELPERS
 */
function isFanTokenValid() {
  if (!fanToken || !fanTokenFetchedAt) return false;

  const now = Date.now();
  const expires = new Date(fanTokenFetchedAt).getTime();

  return now < expires;
}

function verifyShopifyWebhook(req) {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];

  if (!hmacHeader) {
    return false;
  }

  const digest = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(req.body)
    .digest('base64');

  return crypto.timingSafeEqual(
    Buffer.from(digest, 'utf8'),
    Buffer.from(hmacHeader, 'utf8')
  );
}

function isNetopiaOrder(order) {
  const gatewayNames = [
    ...(Array.isArray(order?.payment_gateway_names) ? order.payment_gateway_names : []),
    ...(Array.isArray(order?.gateway_names) ? order.gateway_names : [])
  ].map(x => String(x || '').toLowerCase());

  return gatewayNames.some(name => name.includes('netopia'));
}

function isCodOrder(order) {
  const gatewayNames = [
    ...(Array.isArray(order?.payment_gateway_names) ? order.payment_gateway_names : []),
    ...(Array.isArray(order?.gateway_names) ? order.gateway_names : [])
  ].map(x => String(x || '').toLowerCase());

  return gatewayNames.some(name =>
    name.includes('cash on delivery') ||
    name.includes('(cod)') ||
    name === 'cod' ||
    name.includes('ramburs')
  );
}

function isPaidOrder(order) {
  return String(order?.financial_status || '').toLowerCase() === 'paid';
}

function readInboundCounter() {
  try {
    if (!fs.existsSync(COUNTER_FILE)) {
      return 0;
    }

    const raw = fs.readFileSync(COUNTER_FILE, 'utf-8');
    const data = JSON.parse(raw);

    return Number(data.counter) || 0;
  } catch (err) {
    console.error('Eroare citire counter inbound', err);
    return 0;
  }
}

function writeInboundCounter(counter) {
  try {
    fs.writeFileSync(
      COUNTER_FILE,
      JSON.stringify({ counter }, null, 2)
    );
  } catch (err) {
    console.error('Eroare salvare counter inbound', err);
  }
}

function generateInboundOrderNumber(counter) {
  const padded = String(counter).padStart(2, '0');
  return `PDVtoFAN_${padded}`;
}

async function getFanToken(forceRefresh = false) {
  if (!forceRefresh && isFanTokenValid()) {
    console.log('[FAN TOKEN] reuse');
    return fanToken;
  }

  const response = await axios.post(
    `${process.env.FAN_WMS_BASE_URL}/login`,
    {
      username: process.env.FAN_WMS_USERNAME,
      password: process.env.FAN_WMS_PASSWORD
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    }
  );

  const token =
    response.data.token ||
    response.data.access_token ||
    response.data.jwt ||
    response.data.data?.token;

  if (!token) throw new Error('Token lipsa');

  fanToken = token;

  if (response.data.expiresAt) {
  fanTokenFetchedAt = new Date(response.data.expiresAt).toISOString();
} else {
  fanTokenFetchedAt = new Date(Date.now() + FAN_TOKEN_TTL_MS).toISOString();
}

  return fanToken;
}

async function getAllProductDetailsFromFan() {
  const token = await getFanToken();

  const response = await axios.get(
    `${process.env.FAN_WMS_BASE_URL}/products/details/all`,
    {
      headers: {
        Authorization: `Bearer ${token}`
      },
      params: {
        clientId: Number(process.env.FAN_WMS_CLIENT_ID),
        version: process.env.FAN_WMS_VERSION
      }
    }
  );

  return response.data;
}

async function loadFanProductsCache() {
  const response = await getAllProductDetailsFromFan();

  const items = response.items || response.products || [];

  FAN_PRODUCTS_CACHE = new Set(items.map(p => p.productCode));  

  console.log('[FAN CACHE LOADED]', FAN_PRODUCTS_CACHE.size);
}

async function fanRequestWithRetry(requestFn, maxAttempts = 3) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await requestFn();
    } catch (err) {
      lastError = err;

      const status = err.response?.status || null;
      const isRetryable =
        !status ||
        status >= 500 ||
        status === 408 ||
        status === 429;

      logError(
        'FAN_RETRY',
        `attempt=${attempt}/${maxAttempts} status=${status || 'no-response'} retryable=${isRetryable}`
      );

      if (!isRetryable || attempt === maxAttempts) {
        throw err;
      }

      await new Promise(resolve => setTimeout(resolve, attempt * 1000));
    }
  }

  throw lastError;
}

async function sendOrderToFan(order) {
  const token = await getFanToken();

// await validateStockBeforeSending(order);
  const payload = {
  clientId: Number(process.env.FAN_WMS_CLIENT_ID),
  version: process.env.FAN_WMS_VERSION,
  orders: [buildFanOrderPayload(order)]
};

const response = await fanRequestWithRetry(() =>
  axios.post(
    `${process.env.FAN_WMS_BASE_URL}/orders/out`,
    payload,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 20000
    }
  )
);

// console.log('FAN PAYLOAD:', JSON.stringify(payload, null, 2));

  return response.data;
}
async function sendInboundToFan(data) {
  const token = await getFanToken();

  const payload = {
    clientId: Number(process.env.FAN_WMS_CLIENT_ID),
    version: process.env.FAN_WMS_VERSION,
    orders: [buildFanInboundPayload(data)]
  };

  const response = await fanRequestWithRetry(() =>
  axios.post(
    `${process.env.FAN_WMS_BASE_URL}/orders/in`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      timeout: 20000
    }
  )
);

  return response.data;
}
async function importShopifyProductToFan(product) {
  const { validProducts, skippedVariants } = extractValidFanProductsFromShopifyProduct(product);

  if (!validProducts.length) {
    return {
      success: false,
      importedCount: 0,
      skippedCount: skippedVariants.length,
      skippedVariants,
      reason: 'NO_VALID_VARIANTS'
    };
  }
  const { newProducts, existingProducts } = filterOutProductsAlreadyInFan(validProducts);

  if (!newProducts.length) {
    return {
      success: true,
      importedCount: 0,
      skippedCount: skippedVariants.length,
      skippedVariants,
      existingProducts,
      reason: 'ALL_PRODUCTS_ALREADY_IN_FAN'
    };
  }
  const token = await getFanToken();
  const payload = buildFanProductsImportPayload(newProducts);

  const response = await fanRequestWithRetry(() =>
    axios.post(
      `${process.env.FAN_WMS_BASE_URL}/products`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 20000
      }
    )
  );
  return {
    success: true,
    importedCount: newProducts.length,
    skippedCount: skippedVariants.length,
    skippedVariants,
    existingProducts,
    fanResponse: response.data
  };
}
async function importShopifyProductUpdateToFan(product) {
  const { validProducts, skippedVariants } = extractValidFanProductsFromShopifyProduct(product);

  if (!validProducts.length) {
    return {
      success: false,
      importedCount: 0,
      skippedCount: skippedVariants.length,
      skippedVariants,
      reason: 'NO_VALID_VARIANTS'
    };
  }

  const token = await getFanToken();
  const payload = buildFanProductsImportPayload(validProducts);

  const response = await fanRequestWithRetry(() =>
    axios.post(
      `${process.env.FAN_WMS_BASE_URL}/products`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 20000
      }
    )
  );

  return {
    success: true,
    importedCount: validProducts.length,
    skippedCount: skippedVariants.length,
    skippedVariants,
    fanResponse: response.data
  };
}
/**
 * PRODUCTS PAYLOAD
 */
function buildFanProductsPayload(products) {
  return products
    .filter(p => {
      const sku = String(p.sku || '').trim();
      const title = String(p.title || '').trim();
      const barcode = String(p.barcode || '').trim().replace(/^'+/, '');
      return sku && title && barcode;
    })
    .map(p => {
      const sku = String(p.sku || '').trim();
      const title = String(p.title || '').replace(/<[^>]*>/g, '').trim();
      const rawWeightKg = (Number(p.grams) || 0) / 1000;
      const weightKg = Math.max(rawWeightKg, 0.01);
      const barcode = String(p.barcode || '').trim().replace(/^'+/, '');

      return {
        productCode: sku,
        description: title,
        barCodes: [String(barcode || '').trim()],

        isActive: true,
        hasInventoryTracking: true,
        isLotControlled: false,
        productType: 'Simplu',
        storageTemplate: 'BUC',

        unitsOfMeasure: [
          {
            quantityUnit: 'BUC',
            conversionQuantity: 1,
            isBaseUnit: true,

            dimensionsUnit: 'cm',
            length: 10,
            width: 10,
            height: 30,

            weight: weightKg,
            weightUnit: 'kg',

            treatAsLoose: true,
            treatFullPercentage: 100,

            barCodes: [String(barcode || '').trim()],

            action: 'save'
  }
],

        action: 'save'
      };
    });
}
function normalizeBarcode(barcode) {
  return String(barcode || '').trim().replace(/^'+/, '');
}

function sanitizeHtmlToText(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function isValidShopifyVariantForFan(variant, product) {
  const sku = String(variant?.sku || '').trim();
  const barcode = normalizeBarcode(variant?.barcode);
  const title = sanitizeHtmlToText(product?.title || '');

  if (!sku) {
    return false;
  }

  if (!barcode) {
    return false;
  }

  if (!title) {
    return false;
  }

  return true;
}

function mapShopifyVariantToFanProduct(variant, product) {
  const sku = String(variant?.sku || '').trim();
  const barcode = normalizeBarcode(variant?.barcode);
  const title = sanitizeHtmlToText(product?.title || '');
  const rawWeightKg = (Number(variant?.grams) || 0) / 1000;
  const weightKg = Math.max(rawWeightKg, 0.01);

  return {
    productCode: sku,
    description: title,
    barCodes: [barcode],

    isActive: true,
    hasInventoryTracking: true,
    isLotControlled: false,
    productType: 'Simplu',
    storageTemplate: 'BUC',

    unitsOfMeasure: [
      {
        quantityUnit: 'BUC',
        conversionQuantity: 1,
        isBaseUnit: true,

        dimensionsUnit: 'cm',
        length: 10,
        width: 10,
        height: 30,

        weight: weightKg,
        weightUnit: 'kg',

        treatAsLoose: true,
        treatFullPercentage: 100,

        barCodes: [barcode],

        action: 'save'
      }
    ],

    action: 'save'
  };
}

function extractValidFanProductsFromShopifyProduct(product) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];

  const validProducts = [];
  const skippedVariants = [];

  for (const variant of variants) {
    if (!isValidShopifyVariantForFan(variant, product)) {
      skippedVariants.push({
        variantId: variant?.id || null,
        sku: String(variant?.sku || '').trim() || null,
        barcode: normalizeBarcode(variant?.barcode),
        reason: 'missing_required_fields'
      });
      continue;
    }

    validProducts.push(mapShopifyVariantToFanProduct(variant, product));
  }

  return {
    validProducts,
    skippedVariants
  };
}

function filterOutProductsAlreadyInFan(products) {
  const newProducts = [];
  const existingProducts = [];

  for (const product of products) {
    const productCode = String(product?.productCode || '').trim();

    if (!productCode) {
      continue;
    }

    if (FAN_PRODUCTS_CACHE.has(productCode)) {
      existingProducts.push(productCode);
      continue;
    }

    newProducts.push(product);
  }

  return {
    newProducts,
    existingProducts
  };
}

function buildFanProductsImportPayload(products) {
  return {
    clientId: Number(process.env.FAN_WMS_CLIENT_ID),
    version: process.env.FAN_WMS_VERSION,
    products
  };
}
/**
 * PRODUCTS IMPORT
 */
app.post('/fan/products/test', async (req, res) => {
  try {
    const filePath = path.join(__dirname, 'products_export.csv');

    const products = [];

    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row) => {
        products.push({
          sku: row['Variant SKU'],
          title: row['Title'],
          grams: row['Variant Grams'],
          barcode: row['Variant Barcode']
        });
      })
      .on('end', async () => {
  console.log('[CSV PRODUCTS COUNT RAW]', products.length);

  const cleanProducts = products.filter(p => {
    const sku = String(p.sku || '').trim();
    const title = String(p.title || '').trim();
    const barcode = String(p.barcode || '').trim().replace(/^'+/, '');
    return sku && title && barcode;
  });

    console.log('[CSV PRODUCTS COUNT RAW]', products.length);
    console.log('[CSV PRODUCTS COUNT CLEAN]', cleanProducts.length);
    console.log('[FIRST 5 RAW]', products.slice(0, 5));

  console.log('[CSV PRODUCTS COUNT CLEAN]', cleanProducts.length);
  console.log('[FIRST 5 CLEAN]', cleanProducts.slice(0, 5));
  console.log('[FIRST 5 BARCODES RAW]', cleanProducts.slice(0, 5).map(p => p.barcode));

  const fanProducts = buildFanProductsPayload(cleanProducts);

  console.log('[FIRST 5 PAYLOAD]', JSON.stringify(fanProducts.slice(0, 5), null, 2));

  console.log('[PAYLOAD COUNT]', fanProducts.length);

  const fanPayload = {
    clientId: Number(process.env.FAN_WMS_CLIENT_ID),
    version: process.env.FAN_WMS_VERSION,
    products: fanProducts
  };
        const token = await getFanToken();
console.log('[SEND TO FAN] start request...');
        const response = await axios.post(
          `${process.env.FAN_WMS_BASE_URL}/products`,
          fanPayload,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json'
            }
          }
        );

        console.log('[FAN RESPONSE]', response.data);

        res.json(response.data);
      });

  } catch (err) {
    console.error('[FAN ERROR FULL]', {
  message: err.message,
  data: err.response?.data,
  status: err.response?.status
});

    res.status(500).json({
      success: false,
      error: err.response?.data || err.message
    });
  }
});
/**
 * ORDERS TEST
 */
app.post('/fan/inbound/test', async (req, res) => {
  try {
    const data = req.body;
    const orderNumber = String(data?.orderNumber || '').trim();

    if (!orderNumber) {
      return res.status(400).json({
        success: false,
        code: 'MISSING_ORDER_NUMBER',
        error: 'orderNumber este obligatoriu'
      });
    }

    const alreadyExists = await inboundExistsInFan(orderNumber);

    if (alreadyExists) {
      return res.status(409).json({
        success: false,
        code: 'INBOUND_DUPLICATE',
        error: `Inbound-ul cu orderNumber ${orderNumber} exista deja in FAN`,
        orderNumber
      });
    }

    const response = await sendInboundToFan(data);

    let counter = readInboundCounter();
    counter += 1;
    writeInboundCounter(counter);

    console.log('[FAN INBOUND RESPONSE]', JSON.stringify(response, null, 2));

    res.json(response);
  } catch (err) {
    console.error('[FAN INBOUND ERROR]', err.response?.data || err.message);
    res.status(500).json({
      success: false,
      code: 'INBOUND_CREATE_FAILED',
      error: err.response?.data || err.message
    });
  }
});

app.post('/fan/returns/test', async (req, res) => {
  try {
    const data = req.body;

    data.isReturn = true;

    const response = await sendInboundToFan(data);

    console.log('[FAN RETURN RESPONSE]', JSON.stringify(response, null, 2));

    res.json(response);
  } catch (err) {
    console.error('[FAN RETURN ERROR]', err.response?.data || err.message);
    res.status(500).json(err.response?.data || err.message);
  }
});

/**
 * GET PRODUCTS FROM FAN
 */
app.get('/fan/products/all', async (req, res) => {
  try {
    const token = await getFanToken();

    const response = await axios.get(
      `${process.env.FAN_WMS_BASE_URL}/products/details/all`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        },
        params: {
          clientId: Number(process.env.FAN_WMS_CLIENT_ID),
          version: process.env.FAN_WMS_VERSION
        }
      }
    );

    console.log('[PRODUCTS TOTAL]', response.data.products?.length || response.data.items?.length || 0);

res.json(response.data);

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json(err.response?.data || err.message);
  }
});

async function getOutboundFromFan(orderNumber) {
  const token = await getFanToken();

  const response = await axios.get(
    `${process.env.FAN_WMS_BASE_URL}/orders/out`,
    {
      headers: {
        Authorization: `Bearer ${token}`
      },
      params: {
        clientId: Number(process.env.FAN_WMS_CLIENT_ID),
        version: process.env.FAN_WMS_VERSION,
        orderNumber: orderNumber
      }
    }
  );

  return response.data;
}

async function getInboundFromFan(orderNumber) {
  const token = await getFanToken();

  const response = await axios.get(
    `${process.env.FAN_WMS_BASE_URL}/orders/in`,
    {
      headers: {
        Authorization: `Bearer ${token}`
      },
      params: {
        clientId: Number(process.env.FAN_WMS_CLIENT_ID),
        version: process.env.FAN_WMS_VERSION,
        orderNumber: orderNumber
      }
    }
  );

  return response.data;
}

async function inboundExistsInFan(orderNumber) {
  try {
    const response = await getInboundFromFan(orderNumber);

    if (!response) {
      return false;
    }

    if (Array.isArray(response.orders) && response.orders.length > 0) {
      return response.orders.some(order => String(order.orderNumber) === String(orderNumber));
    }

    if (Array.isArray(response.items) && response.items.length > 0) {
      return response.items.some(order => String(order.orderNumber) === String(orderNumber));
    }

    if (response.orderNumber && String(response.orderNumber) === String(orderNumber)) {
      return true;
    }

    return false;
  } catch (err) {
    const status = err.response?.status;

    if (status === 404) {
      return false;
    }

    const responseData = err.response?.data;
    const responseText =
      typeof responseData === 'string'
        ? responseData.toLowerCase()
        : JSON.stringify(responseData || {}).toLowerCase();

    if (
      responseText.includes('not found') ||
      responseText.includes('nu exista') ||
      responseText.includes('order not found') ||
      responseText.includes('no data')
    ) {
      return false;
    }

    throw err;
  }
}

async function getInboundReportFromFan(startDate = null, endDate = null, orderNumber = null) {
  const token = await getFanToken();

  const params = {
    clientId: Number(process.env.FAN_WMS_CLIENT_ID),
    version: process.env.FAN_WMS_VERSION
  };

  if (orderNumber) {
    params.orderNumber = orderNumber;
  } else {
    if (startDate) {
      params.startDate = startDate;
    }

    if (endDate) {
      params.endDate = endDate;
    }
  }

  const response = await axios.get(
    `${process.env.FAN_WMS_BASE_URL}/orders/reports/inbound`,
    {
      headers: {
        Authorization: `Bearer ${token}`
      },
      params
    }
  );

  return response.data;
}

async function getReturnFromFan(orderNumber) {
  const token = await getFanToken();

  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - 30);

  const formatDate = (date) => {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
  };

  const response = await axios.get(
    `${process.env.FAN_WMS_BASE_URL}/orders/reports/return`,
    {
      headers: {
        Authorization: `Bearer ${token}`
      },
      params: {
        clientId: Number(process.env.FAN_WMS_CLIENT_ID),
        version: process.env.FAN_WMS_VERSION,
        orderNumber: orderNumber,
        startDate: formatDate(start),
        endDate: formatDate(now)
      }
    }
  );

  return response.data;
}

async function getReturnReportFromFan(startDate, endDate, orderNumber = null) {
  const token = await getFanToken();

  const params = {
    clientId: Number(process.env.FAN_WMS_CLIENT_ID),
    version: process.env.FAN_WMS_VERSION,
    startDate,
    endDate
  };

  if (orderNumber) {
    params.orderNumber = orderNumber;
  }

  const response = await axios.get(
    `${process.env.FAN_WMS_BASE_URL}/orders/reports/return`,
    {
      headers: {
        Authorization: `Bearer ${token}`
      },
      params
    }
  );

  return response.data;
}

async function getOutboundReportFromFan(startDate, endDate, orderNumber = null, awb = null, orderType = null) {
  const token = await getFanToken();

  const params = {
    clientId: Number(process.env.FAN_WMS_CLIENT_ID),
    version: process.env.FAN_WMS_VERSION
  };

  if (orderNumber) {
    params.orderNumber = orderNumber;
  } else {
    params.startDate = startDate;
    params.endDate = endDate;
  }

  if (awb) {
    params.awb = awb;
  }

  if (orderType) {
    params.orderType = orderType;
  }

  const response = await axios.get(
    `${process.env.FAN_WMS_BASE_URL}/orders/reports/outbound`,
    {
      headers: {
        Authorization: `Bearer ${token}`
      },
      params
    }
  );

  return response.data;
}

async function getOutboundOrderStatus(orderNumber) {
  const now = new Date();
  const startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} 00:00:00`;
  const endDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} 23:59:59`;

  const response = await getOutboundReportFromFan(startDate, endDate, orderNumber);
  const orders = response.orders || [];

  const order = orders.find(o => String(o.orderNumber) === String(orderNumber));

  return order || null;
}

async function getFanShipmentData(orderNumber) {
  const fanOrder = await getOutboundOrderStatus(orderNumber);

if (!fanOrder) {
  return {
    found: false,
    ready: false,
    reason: 'Comanda nu exista in FAN'
  };
}

  const awb = extractAwbFromFanResponse(fanOrder);

  if (!awb) {
    return {
      found: true,
      ready: false,
      reason: 'AWB nu este inca disponibil'
    };
  }

  return {
    found: true,
    ready: true,
    awb,
    raw: fanOrder
  };
}

async function syncFanShipmentToShopify(orderId) {
  const shipmentData = await getFanShipmentData(orderId);

  if (!shipmentData.found) {
    return {
      success: false,
      orderId,
      reason: 'Comanda nu exista in FAN'
    };
  }

  if (!shipmentData.ready) {
    return {
      success: false,
      orderId,
      reason: shipmentData.reason
    };
  }

  const awb = shipmentData.awb;

  const result = await createShopifyFulfillmentForOrder(
  orderId,
  awb,
  'FAN Courier',
  `https://www.fancourier.ro/awb-tracking/?tracking=${awb}`
);

  // 🔥 AICI ESTE MODIFICAREA
  await autoFulfillSGR(orderId);

  if (result.alreadyFulfilled) {
    return {
      success: true,
      orderId,
      ready: true,
      alreadyFulfilled: true
    };
  }

  return {
    success: true,
    orderId,
    ready: true,
    awb,
    fulfillment: result
  };
}
async function cancelOutboundOrdersInFan(orderNumbers) {
  const token = await getFanToken();

  const params = new URLSearchParams();
  params.append('clientId', Number(process.env.FAN_WMS_CLIENT_ID));
  params.append('version', process.env.FAN_WMS_VERSION);

  for (const orderNumber of orderNumbers) {
    params.append('orderNumbers[]', orderNumber);
  }

  const response = await axios.delete(
    `${process.env.FAN_WMS_BASE_URL}/orders/out/cancel`,
    {
      headers: {
        Authorization: `Bearer ${token}`
      },
      params
    }
  );

  return response.data;
}

async function getProductStockFromFan(stateId = null) {
  const token = await getFanToken();

  const params = {
    clientId: Number(process.env.FAN_WMS_CLIENT_ID),
    version: process.env.FAN_WMS_VERSION
  };

  if (stateId) {
    params.stateId = stateId;
  }

  const response = await fanRequestWithRetry(() =>
  axios.get(
    `${process.env.FAN_WMS_BASE_URL}/products`,
    {
      headers: {
        Authorization: `Bearer ${token}`
      },
      params
    }
  )
);

  return response.data;
}

async function getProductBarcodesFromFan(barCode = null, productCode = null) {
  const token = await getFanToken();

  const params = {
    clientId: Number(process.env.FAN_WMS_CLIENT_ID),
    version: process.env.FAN_WMS_VERSION
  };

  if (barCode) {
    params.barCode = barCode;
  }

  if (productCode) {
    params.productCode = productCode;
  }

  const response = await axios.get(
    `${process.env.FAN_WMS_BASE_URL}/products/barcodes`,
    {
      headers: {
        Authorization: `Bearer ${token}`
      },
      params
    }
  );

  return response.data;
}

async function validateProductBarcodeInFan(productCode, expectedBarcode) {
  const response = await getProductBarcodesFromFan(null, productCode);

  const barcodes = response.barCodes || [];

  const match = barcodes.find(b => 
    b.barCode === expectedBarcode &&
    b.unitOfMeasure === 'BUC'
  );

  if (!match) {
    console.error('[BARCODE MISMATCH]', {
      productCode,
      expectedBarcode,
      found: barcodes
    });

    return false;
  }

  console.log('[BARCODE OK]', productCode);

  return true;
}

async function getProductUnitsOfMeasureFromFan(productCode = null) {
  const token = await getFanToken();

  const params = {
    clientId: Number(process.env.FAN_WMS_CLIENT_ID),
    version: process.env.FAN_WMS_VERSION
  };

  if (productCode) {
    params.productCode = productCode;
  }

  const response = await axios.get(
    `${process.env.FAN_WMS_BASE_URL}/products/units-of-measure`,
    {
      headers: {
        Authorization: `Bearer ${token}`
      },
      params
    }
  );

  return response.data;
}

async function getProductDetailsFromFan(productCode) {
  const token = await getFanToken();

  const response = await axios.get(
    `${process.env.FAN_WMS_BASE_URL}/products/details`,
    {
      headers: {
        Authorization: `Bearer ${token}`
      },
      params: {
        clientId: Number(process.env.FAN_WMS_CLIENT_ID),
        version: process.env.FAN_WMS_VERSION,
        productCode
      }
    }
  );

  return response.data;
}



async function validateProductUOMInFan(productCode) {
  const response = await getProductUnitsOfMeasureFromFan(productCode);

  const units = response.unitsOfMeasure || [];

  const buc = units.find(u => u.unitOfMeasure === 'BUC');

  if (!buc) {
    console.error('[UOM MISSING BUC]', productCode, units);
    return false;
  }

  console.log('[UOM OK]', {
    productCode,
    weight: buc.weight,
    dimensions: {
      l: buc.length,
      w: buc.width,
      h: buc.height
    }
  });

  return true;
}

async function syncStockFromFanToShopify(locationId) {
  const allDetailsData = await getAllProductDetailsFromFan();
  const availableStockData = await getProductStockFromFan(1);

  const allProducts = allDetailsData.items || allDetailsData.products || [];
  const availableProducts = availableStockData.products || availableStockData.items || [];

  console.log('[FAN DETAILS ALL PRODUCTS]', allProducts.length);
  console.log('[FAN AVAILABLE STOCK PRODUCTS]', availableProducts.length);

  const availableBySku = new Map();

  for (const p of availableProducts) {
    const sku = String(p.productCode || '').trim();
    if (!sku) {
      continue;
    }

    const qty = Number(p.quantity || 0);
    availableBySku.set(sku, qty);
  }

  for (const p of allProducts) {
    try {
      const sku = String(p.productCode || '').trim();

      if (!sku) {
        continue;
      }

      const isActive = Number(p.isActive) === 1;
      const hasInventoryTracking = Number(p.hasInventoryTracking) === 1;

      if (!isActive || !hasInventoryTracking) {
        console.log('[SYNC SKIP FAN FLAGS]', {
          sku,
          isActive: p.isActive,
          hasInventoryTracking: p.hasInventoryTracking
        });
        continue;
      }

      const rawQuantity = availableBySku.has(sku) ? Number(availableBySku.get(sku)) : 0;
      const quantity = rawQuantity;

      let inventoryItemId = getSavedInventoryItemIdBySku(sku);

      if (!inventoryItemId) {
        const shopifyData = await getShopifyVariantInventoryBySku(sku);

        if (!shopifyData || !shopifyData.inventory_item_id) {
          console.log('[SKU NOT FOUND IN SHOPIFY]', sku);
          continue;
        }

        inventoryItemId = String(shopifyData.inventory_item_id);
        saveInventoryItemIdBySku(sku, inventoryItemId);

        console.log('[SHOPIFY INVENTORY MAP SAVED]', {
          sku,
          inventoryItemId
        });
      } else {
        console.log('[SHOPIFY INVENTORY MAP HIT]', {
          sku,
          inventoryItemId
        });
      }

            await setShopifyInventoryLevel(
        inventoryItemId,
        locationId,
        quantity
      );

      saveLastSyncedStockBySku(sku, quantity);

      console.log(`[SYNC OK] ${sku} -> raw=${rawQuantity}, shopify=${quantity}`);
    } catch (err) {
      console.error('[SYNC ERROR]', err.message);
    }
  }
}

async function pollFanReturnReports() {
  const now = new Date();

  const startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} 00:00:00`;
  const endDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} 23:59:59`;

  const response = await getReturnReportFromFan(startDate, endDate);

  if (response.orders && response.orders.length > 0) {
  console.log('[FAN RETURNS FOUND]', response.orders.length);

  for (const r of response.orders) {
    const returnId = `${r.orderNumber}-${r.productCode}`;

    if (processedReturns.has(returnId)) {
      continue;
    }

    processedReturns.add(returnId);

    console.log(
      `[NEW RETURN] order=${r.orderNumber} product=${r.productCode} qty=${r.quantity} damaged=${r.isDamaged}`
    );

try {
  const token = await getShopifyToken();

  const shopifyResponse = await axios.get(
    `https://${process.env.SHOPIFY_SHOP}.myshopify.com/admin/api/2023-10/orders/${r.orderNumber}.json`,
    {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      }
    }
  );

  console.log('[SHOPIFY ORDER FOUND]', shopifyResponse.data.order.id);
} catch (err) {
  console.error('[SHOPIFY ORDER NOT FOUND]', r.orderNumber);
}

    fs.writeFileSync(
      processedReturnsFile,
      JSON.stringify(Array.from(processedReturns), null, 2)
    );
}
}

  return response;
}

/**
 * GET ORDER FROM FAN
 */
app.get('/fan/orders/:orderNumber', async (req, res) => {
  try {
    const response = await getInboundFromFan(req.params.orderNumber);

    res.json(response);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json(err.response?.data || err.message);
  }
});

app.get('/fan/inbound/next-order-number', (req, res) => {
  try {
    const counter = readInboundCounter();
    const nextCounter = counter + 1;
    const orderNumber = generateInboundOrderNumber(nextCounter);

    res.json({
      orderNumber
    });
  } catch (err) {
    console.error('Eroare next inbound order number', err);

    res.status(500).json({
      error: 'Nu am putut genera orderNumber'
    });
  }
});

app.get('/fan/inbound/:orderNumber', async (req, res) => {
  try {
    const response = await getInboundFromFan(req.params.orderNumber);
    res.json(response);
  } catch (err) {
    console.error('[FAN INBOUND GET ERROR]', err.response?.data || err.message);
    res.status(500).json(err.response?.data || err.message);
  }
});

app.get('/fan/returns/report/:orderNumber', async (req, res) => {
  try {
    const response = await getReturnFromFan(req.params.orderNumber);

    res.json(response);
  } catch (err) {
    console.error('[FAN RETURN GET ERROR]', err.response?.data || err.message);
    res.status(500).json(err.response?.data || err.message);
  }
});

app.get('/fan/returns/report', async (req, res) => {
  try {
    const { startDate, endDate, orderNumber } = req.query;

    if (!orderNumber && (!startDate || !endDate)) {
      return res.status(400).json({
        error: 'Trebuie sa trimiti fie orderNumber, fie startDate + endDate'
      });
    }

    const response = await getReturnReportFromFan(startDate, endDate, orderNumber);

    res.json(response);
  } catch (err) {
    console.error('[FAN RETURN REPORT ERROR]', err.response?.data || err.message);
    res.status(500).json(err.response?.data || err.message);
  }
});

app.get('/fan/inbound/report', async (req, res) => {
  try {
    const { startDate, endDate, orderNumber } = req.query;

    if (!orderNumber && (!startDate || !endDate)) {
      return res.status(400).json({
        error: 'Trebuie sa trimiti fie orderNumber, fie startDate + endDate'
      });
    }

    const response = await getInboundReportFromFan(
      startDate,
      endDate,
      orderNumber
    );

    res.json(response);
  } catch (err) {
    console.error('[FAN INBOUND REPORT ERROR]', err.response?.data || err.message);
    res.status(500).json(err.response?.data || err.message);
  }
});

app.get('/fan/outbound/:orderNumber', async (req, res) => {
  try {
    const response = await getOutboundFromFan(req.params.orderNumber);

    res.json(response);
  } catch (err) {
    console.error('[FAN OUTBOUND GET ERROR]', err.response?.data || err.message);
    res.status(500).json(err.response?.data || err.message);
  }
});

app.get('/fan/outbound/report', async (req, res) => {
  try {
    const { startDate, endDate, orderNumber, awb, orderType } = req.query;

    if (!orderNumber && (!startDate || !endDate)) {
      return res.status(400).json({
        error: 'Trebuie sa trimiti fie orderNumber, fie startDate + endDate'
      });
    }

    const response = await getOutboundReportFromFan(
      startDate,
      endDate,
      orderNumber,
      awb,
      orderType
    );

    res.json(response);
  } catch (err) {
    console.error('[FAN OUTBOUND REPORT ERROR]', err.response?.data || err.message);
    res.status(500).json(err.response?.data || err.message);
  }
});

app.get('/fan/outbound/status/:orderNumber', async (req, res) => {
  try {
    const order = await getOutboundOrderStatus(req.params.orderNumber);

    if (!order) {
      return res.status(404).json({
        found: false,
        orderNumber: req.params.orderNumber
      });
    }

    res.json({
      found: true,
      order
    });
  } catch (err) {
    console.error('[FAN OUTBOUND STATUS ERROR]', err.response?.data || err.message);
    res.status(500).json(err.response?.data || err.message);
  }
});

app.delete('/fan/outbound/cancel', async (req, res) => {
  try {
    const { orderNumbers } = req.body;

    if (!Array.isArray(orderNumbers) || orderNumbers.length === 0) {
      return res.status(400).json({
        error: 'orderNumbers trebuie sa fie un array cu cel putin un orderNumber'
      });
    }

    const response = await cancelOutboundOrdersInFan(orderNumbers);

    res.json(response);
  } catch (err) {
    console.error('[FAN OUTBOUND CANCEL ERROR]', err.response?.data || err.message);
    res.status(500).json(err.response?.data || err.message);
  }
});

app.get('/fan/products/stock', async (req, res) => {
  try {
    const { stateId } = req.query;

    const response = await getProductStockFromFan(stateId);

    res.json(response);
  } catch (err) {
    console.error('[FAN PRODUCT STOCK ERROR]', err.response?.data || err.message);
    res.status(500).json(err.response?.data || err.message);
  }
});

app.get('/fan/products/barcodes', async (req, res) => {
  try {
    const { barCode, productCode } = req.query;

    const response = await getProductBarcodesFromFan(barCode, productCode);

    res.json(response);
  } catch (err) {
    console.error('[FAN PRODUCT BARCODES ERROR]', err.response?.data || err.message);
    res.status(500).json(err.response?.data || err.message);
  }
});

app.get('/fan/products/units-of-measure', async (req, res) => {
  try {
    const { productCode } = req.query;

    const response = await getProductUnitsOfMeasureFromFan(productCode);

    res.json(response);
  } catch (err) {
    console.error('[FAN PRODUCT UOM ERROR]', err.response?.data || err.message);
    res.status(500).json(err.response?.data || err.message);
  }
});

app.get('/fan/products/details', async (req, res) => {
  try {
    const { productCode } = req.query;

    if (!productCode) {
      return res.status(400).json({
        error: 'productCode este obligatoriu'
      });
    }

    const response = await getProductDetailsFromFan(productCode);

    res.json(response);
  } catch (err) {
    console.error('[FAN PRODUCT DETAILS ERROR]', err.response?.data || err.message);
    res.status(500).json(err.response?.data || err.message);
  }
});


/**
 * SHOPIFY WEBHOOK - PRODUCT CREATE
 */
app.post('/webhooks/shopify/products/create', async (req, res) => {
  try {
    if (!verifyShopifyWebhook(req)) {
      logError('SHOPIFY_PRODUCT_CREATE', 'invalid hmac');
      return res.status(401).send('Invalid signature');
    }

    const topic = 'products/create';
    const product = JSON.parse(req.body.toString('utf8'));
    const dedupKey = buildProductWebhookDedupKey(topic, product.id, product.updated_at);

    logInfo('SHOPIFY_PRODUCT_CREATE', 'received', {
      productId: product.id,
      title: product.title,
      updatedAt: product.updated_at
    });

    if (processedProductWebhooks.has(dedupKey)) {
      logInfo('SHOPIFY_PRODUCT_CREATE', 'duplicate blocked', dedupKey);
      return res.status(200).send('Duplicate ignored');
    }

    const result = await importShopifyProductToFan(product);
    saveProductSkusFromShopifyProduct(product);

    processedProductWebhooks.add(dedupKey);
    saveProcessedProductWebhooks();

    logInfo('SHOPIFY_PRODUCT_CREATE', 'import result', {
      productId: product.id,
      importedCount: result.importedCount,
      skippedCount: result.skippedCount,
      success: result.success,
      reason: result.reason || null
    });

    try {
      await loadFanProductsCache();
    } catch (cacheErr) {
      logError('SHOPIFY_PRODUCT_CREATE', 'fan cache refresh failed', cacheErr.message);
    }

    return res.status(200).send('OK');
  } catch (err) {
    logError(
      'SHOPIFY_PRODUCT_CREATE',
      'webhook error',
      err.response?.data || err.message
    );

    return res.status(500).send('Webhook error');
  }
});

/**
 * SHOPIFY WEBHOOK - PRODUCT UPDATE
 */
app.post('/webhooks/shopify/products/update', async (req, res) => {
  try {
    if (!verifyShopifyWebhook(req)) {
      logError('SHOPIFY_PRODUCT_UPDATE', 'invalid hmac');
      return res.status(401).send('Invalid signature');
    }

    const topic = 'products/update';
    const product = JSON.parse(req.body.toString('utf8'));
    const dedupKey = buildProductWebhookDedupKey(topic, product.id, product.updated_at);

    logInfo('SHOPIFY_PRODUCT_UPDATE', 'received', {
      productId: product.id,
      title: product.title,
      updatedAt: product.updated_at
    });

    if (processedProductWebhooks.has(dedupKey)) {
      logInfo('SHOPIFY_PRODUCT_UPDATE', 'duplicate blocked', dedupKey);
      return res.status(200).send('Duplicate ignored');
    }

    const result = await importShopifyProductToFan(product);
    saveProductSkusFromShopifyProduct(product);

    processedProductWebhooks.add(dedupKey);
    saveProcessedProductWebhooks();

    logInfo('SHOPIFY_PRODUCT_UPDATE', 'import result', {
      productId: product.id,
      importedCount: result.importedCount,
      skippedCount: result.skippedCount,
      success: result.success,
      reason: result.reason || null
    });

    try {
      await loadFanProductsCache();
    } catch (cacheErr) {
      logError('SHOPIFY_PRODUCT_UPDATE', 'fan cache refresh failed', cacheErr.message);
    }

    return res.status(200).send('OK');
  } catch (err) {
    logError(
      'SHOPIFY_PRODUCT_UPDATE',
      'webhook error',
      err.response?.data || err.message
    );

    return res.status(500).send('Webhook error');
  }
});

/**
 * SHOPIFY WEBHOOK - PRODUCT DELETE
 */
app.post('/webhooks/shopify/products/delete', async (req, res) => {
  try {
    if (!verifyShopifyWebhook(req)) {
      logError('SHOPIFY_PRODUCT_DELETE', 'invalid hmac');
      return res.status(401).send('Invalid signature');
    }

    const product = JSON.parse(req.body.toString('utf8'));
    const productId = String(product?.id || '').trim();

    logInfo('SHOPIFY_PRODUCT_DELETE', 'received', { productId });

    return res.status(200).send('OK');
  } catch (err) {
    logError(
      'SHOPIFY_PRODUCT_DELETE',
      'webhook error',
      err.response?.data || err.message
    );

    return res.status(500).send('Webhook error');
  }
});/**
 * SHOPIFY WEBHOOK - ORDER CREATE
 */
app.post('/webhooks/shopify/orders/create', async (req, res) => {
  let currentOrderId = null;

  try {
    if (!verifyShopifyWebhook(req)) {
      logError('SHOPIFY_WEBHOOK', 'invalid hmac');
      return res.status(401).send('Invalid signature');
    }

    const webhookOrder = JSON.parse(req.body.toString('utf8'));
    currentOrderId = webhookOrder?.id || null;

    logInfo('SHOPIFY_WEBHOOK', 'received');
    logInfo('SHOPIFY_WEBHOOK', 'order id', webhookOrder.id);

    if (processedOrders.has(String(webhookOrder.id))) {
      logInfo('SHOPIFY_WEBHOOK', 'duplicate order blocked', webhookOrder.id);
      return res.status(200).send('Duplicate ignored');
    }

    const token = await getShopifyToken();

    const shopifyResponse = await axios.get(
      `https://${process.env.SHOPIFY_SHOP}.myshopify.com/admin/api/2023-10/orders/${webhookOrder.id}.json`,
      {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        }
      }
    );

    const order = shopifyResponse.data.order;

    console.log('[PAYMENT DEBUG]', {
      orderId: order.id,
      financial_status: order.financial_status,
      total_outstanding: order.total_outstanding,
      payment_gateway_names: order.payment_gateway_names,
      gateway_names: order.gateway_names
    });

    if (isNetopiaOrder(order) && !isPaidOrder(order)) {
      logInfo('SHOPIFY_WEBHOOK', 'netopia order not paid yet - skip FAN send for now', {
        orderId: order.id,
        financialStatus: order.financial_status,
        gateways: order.payment_gateway_names || order.gateway_names || []
      });

      return res.status(200).send('Netopia order pending payment - ignored for now');
    }

    logInfo('SHOPIFY_WEBHOOK', 'sending order to FAN', {
      orderId: order.id
    });

    const fanResponse = await sendOrderToFan(order);

logInfo('SHOPIFY_WEBHOOK', 'fan raw response', {
  orderId: order.id,
  fanResponse
});

if (!(fanResponse.successful && fanResponse.successful.includes(String(order.id)))) {
  logError('SHOPIFY_WEBHOOK', 'FAN did not confirm order as successful', {
    orderId: order.id,
    fanResponse
  });
}

    if (fanResponse.successful && fanResponse.successful.includes(String(order.id))) {
      processedOrders.add(String(order.id));
      logInfo('SHOPIFY_WEBHOOK', 'order marked as processed', order.id);

      fs.writeFileSync(
        processedOrdersFile,
        JSON.stringify(Array.from(processedOrders), null, 2)
      );
    }

    logInfo('SHOPIFY_WEBHOOK', 'fan response received', fanResponse);

    res.status(200).send('OK');
  } catch (err) {
    logError('SHOPIFY_WEBHOOK', 'webhook error', {
      orderId: currentOrderId,
      message: err.message,
      response: err.response?.data || null
    });

    res.status(500).send('Webhook error');
  }
});

app.post('/webhooks/shopify/orders/paid', async (req, res) => {
  let currentOrderId = null;

  try {
    if (!verifyShopifyWebhook(req)) {
      logError('SHOPIFY_ORDER_PAID', 'invalid hmac');
      return res.status(401).send('Invalid signature');
    }

    const webhookOrder = JSON.parse(req.body.toString('utf8'));
    currentOrderId = webhookOrder?.id || null;

    logInfo('SHOPIFY_ORDER_PAID', 'received', {
      orderId: webhookOrder.id
    });

    const order = webhookOrder;
    const alreadyProcessedInFan = processedOrders.has(String(order.id));

    console.log('[ORDER PAID DEBUG]', {
      orderId: order.id,
      financial_status: order.financial_status,
      total_outstanding: order.total_outstanding,
      payment_gateway_names: order.payment_gateway_names,
      gateway_names: order.gateway_names,
      alreadyProcessedInFan
    });

if (isCodOrder(order)) {
  logInfo('SHOPIFY_ORDER_PAID', 'skip FAN send - COD order paid later in Shopify', {
    orderId: order.id,
    gateways: order.payment_gateway_names || order.gateway_names || []
  });

  return res.status(200).send('COD order paid update - ignored for FAN send');
}

    if (alreadyProcessedInFan) {
      logInfo('SHOPIFY_ORDER_PAID', 'skip FAN send - already processed', {
        orderId: order.id
      });
    } else {
      logInfo('SHOPIFY_ORDER_PAID', 'sending order to FAN', {
        orderId: order.id
      });

      const fanResponse = await sendOrderToFan(order);

      logInfo('SHOPIFY_ORDER_PAID', 'fan raw response', {
        orderId: order.id,
        fanResponse
      });

      if (!(fanResponse.successful && fanResponse.successful.includes(String(order.id)))) {
        logError('SHOPIFY_ORDER_PAID', 'FAN did not confirm order as successful', {
          orderId: order.id,
          fanResponse
        });
      }

      if (fanResponse.successful && fanResponse.successful.includes(String(order.id))) {
        processedOrders.add(String(order.id));
        logInfo('SHOPIFY_ORDER_PAID', 'order marked as processed', order.id);

        fs.writeFileSync(
          processedOrdersFile,
          JSON.stringify(Array.from(processedOrders), null, 2)
        );
      }

      logInfo('SHOPIFY_ORDER_PAID', 'fan response received', fanResponse);
    }

    if (isNetopiaOrder(order)) {
      handleOblioCollectForPaidOrder(order).catch(err => {
        logError('SHOPIFY_ORDER_PAID', 'oblio collect async error', {
          orderId: order.id,
          message: err.message,
          response: err.response?.data || null
        });
      });
    } else {
      logInfo('SHOPIFY_ORDER_PAID', 'oblio collect skipped - non-netopia order', {
        orderId: order.id,
        gateways: order.payment_gateway_names || order.gateway_names || []
      });
    }

    return res.status(200).send('OK');
  } catch (err) {
    logError('SHOPIFY_ORDER_PAID', 'webhook error', {
      orderId: currentOrderId,
      message: err.message,
      response: err.response?.data || null
    });

    return res.status(500).send('Webhook error');
  }
});
/**
 * HEALTH
 */
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;

loadProcessedOrders();
loadProcessedReturns();
loadProcessedProductWebhooks();
loadShopifyProductSkuMap();
loadShopifyInventoryItemMap();
loadShopifyLastSyncedStock();
(async () => {
  try {
    console.log('[STARTUP] FAN cache load start');
    await loadFanProductsCache();
    console.log('[STARTUP] FAN cache load done');
  } catch (err) {
    console.error('[STARTUP] FAN cache load failed', err.message);
  }
})();

pollFanReturnReports();
setInterval(pollFanReturnReports, 5 * 60 * 1000);
let isSyncRunning = false;
let isFanSyncRunning = false;

setInterval(async () => {
  if (isFanSyncRunning) {
    console.log('[FAN SYNC SKIPPED - STILL RUNNING]');
    return;
  }

  try {
    isFanSyncRunning = true;
    console.log('[FAN SYNC START]');

    // aici vei pune lista de comenzi recente
    const token = await getShopifyToken();

    const response = await axios.get(
      `https://${process.env.SHOPIFY_SHOP}.myshopify.com/admin/api/2023-10/orders.json`,
      {
        headers: {
          'X-Shopify-Access-Token': token
        },
        params: {
          fulfillment_status: 'unfulfilled',
          limit: 20,
          order: 'created_at desc'
        }
      }
    );

    const orders = response.data.orders || [];

    for (const order of orders) {
  if (order.tags && String(order.tags).includes('fan-awb-done')) {
    continue;
  }

  try {
    const result = await syncFanShipmentToShopify(order.id);

    if (result.success && result.ready) {
      if (!result.alreadyFulfilled) {
        console.log(`[FULFILLMENT CREATED] ${order.id} AWB=${result.awb}`);
      } else {
        console.log(`[FULFILLMENT ALREADY DONE] ${order.id}`);
      }

      try {
        await tagOrderAsSynced(order.id);
        console.log('[FAN AWB TAG ADDED]', order.id);
      } catch (err) {
        console.error('[FAN AWB TAG ERROR]', {
          orderId: order.id,
          message: err.message,
          status: err.response?.status || null,
          response: err.response?.data || null
        });
      }
    }

  } catch (err) {
    console.error('[SYNC ERROR ORDER]', order.id, err.message);
  }
}

    console.log('[FAN SYNC DONE]');

  } catch (err) {
  console.error('[FAN SYNC ERROR]', err.message);
} finally {
  isFanSyncRunning = false;
}
}, 2 * 60 * 1000); // la 2 minute

setInterval(async () => {
  if (isSyncRunning) {
    console.log('[SYNC SKIPPED - STILL RUNNING]');
    return;
  }

  try {
    isSyncRunning = true;

    console.log('[AUTO SYNC STOCK START]');
    await syncStockFromFanToShopify(process.env.SHOPIFY_LOCATION_ID);
    console.log('[AUTO SYNC STOCK DONE]');
  } catch (err) {
    console.error('[AUTO SYNC ERROR]', err.message);
  } finally {
    isSyncRunning = false;
  }
}, 5 * 60 * 1000);
(async () => {
  try {
    console.log('[INITIAL SYNC STOCK START]');
    await syncStockFromFanToShopify(process.env.SHOPIFY_LOCATION_ID);
    console.log('[INITIAL SYNC STOCK DONE]');
  } catch (err) {
    console.error('[INITIAL SYNC ERROR]', err.message);
  }
})();

setInterval(async () => {
  try {
    console.log('[FAN PRODUCTS CACHE REFRESH START]');
    await loadFanProductsCache();
    console.log('[FAN PRODUCTS CACHE REFRESH DONE]');
  } catch (err) {
    console.error('[FAN PRODUCTS CACHE ERROR]', err.message);
  }
}, 10 * 60 * 1000); // la 10 minute

app.listen(PORT, () => console.log('Server running on ' + PORT));