[1mdiff --git a/server.js b/server.js[m
[1mindex c64be50..33d9b5f 100644[m
[1m--- a/server.js[m
[1m+++ b/server.js[m
[36m@@ -12,7 +12,217 @@[m [mapp.use('/webhooks/shopify', express.raw({ type: '*/*' }));[m
 app.use(express.json());[m
 app.use(express.static(path.join(__dirname, 'public')));[m
 [m
[31m-// 👇 AICI PUI CODUL[m
[32m+[m[32mlet oblioToken = null;[m
[32m+[m[32mlet oblioTokenExpiresAt = 0;[m
[32m+[m
[32m+[m[32mfunction getOblioClientId() {[m
[32m+[m[32m  return process.env.OBLIO_CLIENT_ID;[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32mfunction getOblioClientSecret() {[m
[32m+[m[32m  return process.env.OBLIO_CLIENT_SECRET;[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32mfunction getOblioCif() {[m
[32m+[m[32m  return process.env.OBLIO_CIF;[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32mfunction sleep(ms) {[m
[32m+[m[32m  return new Promise(resolve => setTimeout(resolve, ms));[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32masync function getOblioToken() {[m
[32m+[m[32m  if (oblioToken && Date.now() < oblioTokenExpiresAt - 60000) {[m
[32m+[m[32m    return oblioToken;[m
[32m+[m[32m  }[m
[32m+[m
[32m+[m[32m  const params = new URLSearchParams();[m
[32m+[m[32m  params.append('client_id', getOblioClientId());[m
[32m+[m[32m  params.append('client_secret', getOblioClientSecret());[m
[32m+[m
[32m+[m[32m  const response = await axios.post([m
[32m+[m[32m    'https://www.oblio.eu/api/authorize/token',[m
[32m+[m[32m    params,[m
[32m+[m[32m    {[m
[32m+[m[32m      headers: {[m
[32m+[m[32m        'Content-Type': 'application/x-www-form-urlencoded'[m
[32m+[m[32m      },[m
[32m+[m[32m      timeout: 15000[m
[32m+[m[32m    }[m
[32m+[m[32m  );[m
[32m+[m
[32m+[m[32m  const accessToken = response.data?.access_token;[m
[32m+[m[32m  const expiresIn = Number(response.data?.expires_in || 3600);[m
[32m+[m
[32m+[m[32m  if (!accessToken) {[m
[32m+[m[32m    throw new Error('Oblio access_token lipsa');[m
[32m+[m[32m  }[m
[32m+[m
[32m+[m[32m  oblioToken = accessToken;[m
[32m+[m[32m  oblioTokenExpiresAt = Date.now() + (expiresIn * 1000);[m
[32m+[m
[32m+[m[32m  return oblioToken;[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32masync function listOblioInvoicesForOrder(orderName) {[m
[32m+[m[32m  const token = await getOblioToken();[m
[32m+[m
[32m+[m[32m  const response = await axios.get([m
[32m+[m[32m    'https://www.oblio.eu/api/docs/invoice/list',[m
[32m+[m[32m    {[m
[32m+[m[32m      headers: {[m
[32m+[m[32m        Authorization: `Bearer ${token}`[m
[32m+[m[32m      },[m
[32m+[m[32m      params: {[m
[32m+[m[32m        cif: getOblioCif()[m
[32m+[m[32m      },[m
[32m+[m[32m      timeout: 15000[m
[32m+[m[32m    }[m
[32m+[m[32m  );[m
[32m+[m
[32m+[m[32m  const invoices = Array.isArray(response.data?.data) ? response.data.data : [];[m
[32m+[m
[32m+[m[32m  return invoices.filter(inv => {[m
[32m+[m[32m    const mentions = String(inv?.mentions || '');[m
[32m+[m[32m    const clientName = String(inv?.client?.name || '');[m
[32m+[m[32m    const noticeNumber = String(inv?.noticeNumber || '');[m
[32m+[m[32m    const orderNumber = String(inv?.number || '');[m
[32m+[m
[32m+[m[32m    return ([m
[32m+[m[32m      mentions.includes(orderName) ||[m
[32m+[m[32m      noticeNumber.includes(orderName) ||[m
[32m+[m[32m      clientName.includes(orderName) ||[m
[32m+[m[32m      orderNumber === orderName.replace('#', '')[m
[32m+[m[32m    );[m
[32m+[m[32m  });[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32masync function getOblioInvoiceDetails(seriesName, number) {[m
[32m+[m[32m  const token = await getOblioToken();[m
[32m+[m
[32m+[m[32m  const response = await axios.get([m
[32m+[m[32m    'https://www.oblio.eu/api/docs/invoice',[m
[32m+[m[32m    {[m
[32m+[m[32m      headers: {[m
[32m+[m[32m        Authorization: `Bearer ${token}`[m
[32m+[m[32m      },[m
[32m+[m[32m      params: {[m
[32m+[m[32m        cif: getOblioCif(),[m
[32m+[m[32m        seriesName,[m
[32m+[m[32m        number[m
[32m+[m[32m      },[m
[32m+[m[32m      timeout: 15000[m
[32m+[m[32m    }[m
[32m+[m[32m  );[m
[32m+[m
[32m+[m[32m  return response.data?.data || null;[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32mfunction oblioInvoiceAlreadyCollected(invoiceDetails) {[m
[32m+[m[32m  const collects = Array.isArray(invoiceDetails?.collects) ? invoiceDetails.collects : [];[m
[32m+[m[32m  return collects.length > 0;[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32masync function collectOblioInvoice(invoice, order) {[m
[32m+[m[32m  const token = await getOblioToken();[m
[32m+[m
[32m+[m[32m  const form = new URLSearchParams();[m
[32m+[m[32m  form.append('cif', getOblioCif());[m
[32m+[m[32m  form.append('seriesName', String(invoice.seriesName));[m
[32m+[m[32m  form.append('number', String(invoice.number));[m
[32m+[m[32m  form.append('collect[type]', 'Card');[m
[32m+[m[32m  form.append('collect[documentNumber]', `Shopify ${order.name || ('#' + order.order_number)}`);[m
[32m+[m[32m  form.append('collect[issueDate]', new Date().toISOString().slice(0, 10));[m
[32m+[m
[32m+[m[32m  await axios.put([m
[32m+[m[32m    'https://www.oblio.eu/api/docs/invoice/collect',[m
[32m+[m[32m    form,[m
[32m+[m[32m    {[m
[32m+[m[32m      headers: {[m
[32m+[m[32m        Authorization: `Bearer ${token}`,[m
[32m+[m[32m        'Content-Type': 'application/x-www-form-urlencoded'[m
[32m+[m[32m      },[m
[32m+[m[32m      timeout: 15000[m
[32m+[m[32m    }[m
[32m+[m[32m  );[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32masync function handleOblioCollectForPaidOrder(order) {[m
[32m+[m[32m  const orderName = String(order?.name || `#${order?.order_number || ''}`).trim();[m
[32m+[m
[32m+[m[32m  if (!orderName || orderName === '#') {[m
[32m+[m[32m    logError('OBLIO_COLLECT', 'order name lipsa', {[m
[32m+[m[32m      orderId: order?.id || null[m
[32m+[m[32m    });[m
[32m+[m[32m    return;[m
[32m+[m[32m  }[m
[32m+[m
[32m+[m[32m  for (let attempt = 1; attempt <= 5; attempt++) {[m
[32m+[m[32m    try {[m
[32m+[m[32m      logInfo('OBLIO_COLLECT', 'search invoice attempt', {[m
[32m+[m[32m        orderId: order.id,[m
[32m+[m[32m        orderName,[m
[32m+[m[32m        attempt[m
[32m+[m[32m      });[m
[32m+[m
[32m+[m[32m      const invoices = await listOblioInvoicesForOrder(orderName);[m
[32m+[m
[32m+[m[32m      if (!invoices.length) {[m
[32m+[m[32m        logInfo('OBLIO_COLLECT', 'invoice not found yet', {[m
[32m+[m[32m          orderId: order.id,[m
[32m+[m[32m          orderName,[m
[32m+[m[32m          attempt[m
[32m+[m[32m        });[m
[32m+[m
[32m+[m[32m        await sleep(15000);[m
[32m+[m[32m        continue;[m
[32m+[m[32m      }[m
[32m+[m
[32m+[m[32m      const invoice = invoices[0];[m
[32m+[m
[32m+[m[32m      const invoiceDetails = await getOblioInvoiceDetails([m
[32m+[m[32m        invoice.seriesName,[m
[32m+[m[32m        invoice.number[m
[32m+[m[32m      );[m
[32m+[m
[32m+[m[32m      if (oblioInvoiceAlreadyCollected(invoiceDetails)) {[m
[32m+[m[32m        logInfo('OBLIO_COLLECT', 'invoice already collected - skip', {[m
[32m+[m[32m          orderId: order.id,[m
[32m+[m[32m          orderName,[m
[32m+[m[32m          seriesName: invoice.seriesName,[m
[32m+[m[32m          number: invoice.number[m
[32m+[m[32m        });[m
[32m+[m[32m        return;[m
[32m+[m[32m      }[m
[32m+[m
[32m+[m[32m      await collectOblioInvoice(invoice, order);[m
[32m+[m
[32m+[m[32m      logInfo('OBLIO_COLLECT', 'invoice collected successfully', {[m
[32m+[m[32m        orderId: order.id,[m
[32m+[m[32m        orderName,[m
[32m+[m[32m        seriesName: invoice.seriesName,[m
[32m+[m[32m        number: invoice.number[m
[32m+[m[32m      });[m
[32m+[m
[32m+[m[32m      return;[m
[32m+[m[32m    } catch (err) {[m
[32m+[m[32m      logError('OBLIO_COLLECT', 'attempt failed', {[m
[32m+[m[32m        orderId: order?.id || null,[m
[32m+[m[32m        orderName,[m
[32m+[m[32m        attempt,[m
[32m+[m[32m        message: err.message,[m
[32m+[m[32m        response: err.response?.data || null[m
[32m+[m[32m      });[m
[32m+[m
[32m+[m[32m      await sleep(10000);[m
[32m+[m[32m    }[m
[32m+[m[32m  }[m
[32m+[m
[32m+[m[32m  logError('OBLIO_COLLECT', 'failed after retries', {[m
[32m+[m[32m    orderId: order?.id || null,[m
[32m+[m[32m    orderName[m
[32m+[m[32m  });[m
[32m+[m[32m}[m
 [m
 let shopifyToken = null;[m
 let shopifyTokenExpiresAt = 0;[m
[36m@@ -2230,6 +2440,8 @@[m [masync function getProductDetailsFromFan(productCode) {[m
   return response.data;[m
 }[m
 [m
[32m+[m
[32m+[m
 async function validateProductUOMInFan(productCode) {[m
   const response = await getProductUnitsOfMeasureFromFan(productCode);[m
 [m
[36m@@ -2915,6 +3127,13 @@[m [mapp.post('/webhooks/shopify/orders/paid', async (req, res) => {[m
 [m
     logInfo('SHOPIFY_ORDER_PAID', 'fan response received', fanResponse);[m
 [m
[32m+[m[32mhandleOblioCollectForPaidOrder(order).catch(err => {[m
[32m+[m[32m  logError('SHOPIFY_ORDER_PAID', 'oblio collect async error', {[m
[32m+[m[32m    orderId: order.id,[m
[32m+[m[32m    message: err.message,[m
[32m+[m[32m    response: err.response?.data || null[m
[32m+[m[32m  });[m
[32m+[m[32m});[m
     return res.status(200).send('OK');[m
   } catch (err) {[m
     logError('SHOPIFY_ORDER_PAID', 'webhook error', {[m
