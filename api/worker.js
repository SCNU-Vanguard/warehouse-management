let cachedToken = null;
let cachedTokenExpiresAt = 0;
let cachedDataSource = null;

const FEISHU_HOST = "https://open.feishu.cn";

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env, request) });
    }

    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (request.method === "GET" && path === "/api/health") {
        return json({ ok: true, service: "warehouse-api", config: publicConfig(env) }, env, request);
      }

      if (request.method === "GET" && path === "/api/items") {
        const items = await getItems(env);
        return json({ ok: true, items }, env, request);
      }

      if (request.method === "GET" && path.startsWith("/api/items/")) {
        const code = decodeURIComponent(path.slice("/api/items/".length));
        const item = await findItemByCode(env, code);
        if (!item) return json({ ok: false, error: "Item not found" }, env, request, 404);
        return json({ ok: true, item }, env, request);
      }

      if (request.method === "GET" && path === "/api/records") {
        const records = await getRecords(env);
        return json({ ok: true, records }, env, request);
      }

      if (request.method === "GET" && path === "/api/debug/sheets") {
        const sheets = await getSheetDebugInfo(env);
        return json({ ok: true, ...sheets }, env, request);
      }

      if (request.method === "GET" && path === "/api/debug/record-fields") {
        const debug = await getRecordFieldDebugInfo(env);
        return json({ ok: true, ...debug }, env, request);
      }

      if (request.method === "POST" && path === "/api/inbound") {
        const payload = await readJson(request);
        const result = await createMovement(env, "inbound", payload);
        return json({ ok: true, ...result }, env, request);
      }

      if (request.method === "POST" && path === "/api/outbound") {
        const payload = await readJson(request);
        const result = await createMovement(env, "outbound", payload);
        return json({ ok: true, ...result }, env, request);
      }

      return json({ ok: false, error: "Not found" }, env, request, 404);
    } catch (error) {
      return json({ ok: false, error: error.message || "Internal error" }, env, request, 500);
    }
  }
};

async function createMovement(env, type, payload) {
  const code = String(payload.code || "").trim();
  const recordId = String(payload.recordId || "").trim();
  const quantity = Number(payload.quantity);
  const reason = String(payload.reason || "").trim();
  const detail = String(payload.detail || "").trim();
  const operator = String(payload.operator || "").trim();

  if (!code && !recordId) throw new Error("code or recordId is required");
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error("quantity must be a positive integer");
  if (!operator) throw new Error("operator is required");
  if (type === "outbound" && (!reason || !detail)) {
    throw new Error("reason and detail are required for outbound movements");
  }

  const item = await findItem(env, { code, recordId });
  if (!item) throw new Error("item not found");

  const currentStock = Number(item.stock || 0);
  if (type === "outbound" && quantity > currentStock) {
    throw new Error("outbound quantity exceeds current stock");
  }

  const nextStock = type === "inbound" ? currentStock + quantity : currentStock - quantity;
  const fields = fieldNames(env);
  await updateInventoryRow(env, item, stockUpdateFields(env, type, item, quantity, nextStock, fields));

  let recordWarning = "";
  if (env.FEISHU_RECORDS_TABLE_ID) {
    try {
      await createMovementRecordWithFallback(env, fields, type, item, quantity, reason, detail, operator);
    } catch (error) {
      recordWarning = `库存已更新，但出入库记录写入失败：${error.message || "unknown error"}`;
    }
  }

  return {
    item: { ...item, stock: nextStock },
    movement: { code: item.code, type, quantity, reason, detail, operator, time: new Date().toISOString() },
    warning: recordWarning
  };
}

async function createMovementRecordWithFallback(env, fields, type, item, quantity, reason, detail, operator) {
  const now = new Date();
  const variants = [
    movementRecordFields(fields, type, item, quantity, reason, detail, operator, { quantity, time: now.getTime() }),
    movementRecordFields(fields, type, item, quantity, reason, detail, operator, { quantity: String(quantity), time: now.getTime() }),
    movementRecordFields(fields, type, item, quantity, reason, detail, operator, { quantity: String(quantity), time: formatLocalDateTime(now) }),
    movementRecordFields(fields, type, item, quantity, reason, detail, operator, { quantity: String(quantity), time: null })
  ];

  let lastError = null;
  for (const variant of variants) {
    try {
      return await createMovementRecord(env, variant);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("record write failed");
}

function movementRecordFields(fields, type, item, quantity, reason, detail, operator, overrides = {}) {
  const record = {
    [fields.recordCode]: item.code || "",
    [fields.recordName]: item.name || "",
    [fields.recordType]: type === "inbound" ? "入库" : "出库",
    [fields.recordQuantity]: overrides.quantity ?? quantity,
    [fields.reason]: reason || "",
    [fields.detail]: detail || "",
    [fields.operator]: operator || ""
  };
  if (overrides.time !== null) {
    record[fields.time] = overrides.time ?? Date.now();
  }
  return record;
}

async function getItems(env) {
  requireEnv(env);
  const source = await getDataSource(env);
  const fields = fieldNames(env);

  if (source.type === "sheet") {
    const rows = await listSheetRows(env, source);
    return rows.map((row) => normalizeItem(row, fields)).filter((item) => item.code || item.name);
  }

  const tableId = env.FEISHU_ITEMS_TABLE_ID || source.tableId;
  if (!tableId) throw new Error("Missing environment variable: FEISHU_ITEMS_TABLE_ID");
  const rows = await listBitableRecords(env, source.token, tableId);
  return rows.map((row) => normalizeItem(row, fields));
}

async function getRecords(env) {
  requireEnv(env);
  if (!env.FEISHU_RECORDS_TABLE_ID) return [];
  const source = await getDataSource(env);
  if (source.type !== "bitable") return [];

  const fields = fieldNames(env);
  const rows = await listBitableRecords(env, source.token, env.FEISHU_RECORDS_TABLE_ID);
  return rows.map((row) => normalizeMovement(row, fields)).sort((a, b) => Date.parse(b.time || "") - Date.parse(a.time || ""));
}

async function findItemByCode(env, code) {
  return findItem(env, { code });
}

async function findItem(env, { code = "", recordId = "" }) {
  const items = await getItems(env);
  return items.find((item) => (recordId && item.recordId === recordId) || (code && item.code === code)) || null;
}

function normalizeItem(row, fields) {
  const data = row.fields || {};
  return {
    recordId: row.record_id,
    code: textValue(data[fields.code]),
    name: textValue(data[fields.name]),
    sn: textValue(data[fields.sn]),
    stock: numberValue(data[fields.stock]),
    inboundTotal: numberValue(data[fields.inQuantity]),
    outboundTotal: numberValue(data[fields.outQuantity]),
    owner: textValue(data[fields.owner]),
    unit: textValue(data[fields.unit]),
    category: textValue(data[fields.category]),
    qr: textValue(data[fields.qr]),
    note: textValue(data[fields.note]),
    meta: row.meta || null
  };
}

function normalizeMovement(row, fields) {
  const data = row.fields || {};
  const typeText = textValue(data[fields.recordType]);
  return {
    recordId: row.record_id,
    code: textValue(data[fields.recordCode]),
    name: textValue(data[fields.recordName]),
    type: typeText === "入库" || typeText === "inbound" ? "inbound" : "outbound",
    quantity: numberValue(data[fields.recordQuantity]),
    reason: textValue(data[fields.reason]),
    detail: textValue(data[fields.detail]),
    operator: textValue(data[fields.operator]),
    time: timeValue(data[fields.time]) || row.created_time || row.create_time || ""
  };
}

function stockUpdateFields(env, type, item, quantity, nextStock, fields) {
  if (env.STOCK_WRITE_MODE === "stock") {
    return { [fields.stock]: nextStock };
  }

  if (type === "inbound") {
    return { [fields.inQuantity]: item.inboundTotal + quantity };
  }

  return { [fields.outQuantity]: item.outboundTotal + quantity };
}

async function updateInventoryRow(env, item, fields) {
  const source = await getDataSource(env);

  if (source.type === "sheet") {
    return updateSheetRow(env, source, item, fields);
  }

  return updateBitableRecord(env, source.token, env.FEISHU_ITEMS_TABLE_ID || source.tableId, item.recordId, fields);
}

async function createMovementRecord(env, fields) {
  const source = await getDataSource(env);
  if (source.type !== "bitable") return null;
  return createBitableRecord(env, source.token, env.FEISHU_RECORDS_TABLE_ID, fields);
}

async function listBitableRecords(env, appToken, tableId) {
  const records = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({ page_size: "500" });
    if (pageToken) params.set("page_token", pageToken);
    const result = await feishu(env, `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?${params}`);
    records.push(...(result.data?.items || []));
    pageToken = result.data?.has_more ? result.data.page_token : "";
  } while (pageToken);
  return records;
}

async function updateBitableRecord(env, appToken, tableId, recordId, fields) {
  return feishu(env, `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`, {
    method: "PUT",
    body: JSON.stringify({ fields })
  });
}

async function createBitableRecord(env, appToken, tableId, fields) {
  return feishu(env, `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`, {
    method: "POST",
    body: JSON.stringify({ fields })
  });
}

async function listBitableFields(env, appToken, tableId) {
  const result = await feishu(env, `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields?page_size=100`);
  return result.data?.items || [];
}

async function getSheetDebugInfo(env) {
  const source = await getDataSource(env);
  if (source.type !== "sheet") {
    return { type: source.type, sheets: [] };
  }

  const result = await feishu(env, `/open-apis/sheets/v2/spreadsheets/${source.token}/metainfo`);
  return {
    type: "sheet",
    configuredSheetId: env.FEISHU_SHEET_ID || "",
    data: result.data || {}
  };
}

async function getRecordFieldDebugInfo(env) {
  requireEnv(env);
  if (!env.FEISHU_RECORDS_TABLE_ID) {
    return { hasRecordsTableId: false, fields: [] };
  }
  const source = await getDataSource(env);
  if (source.type !== "bitable") {
    return { hasRecordsTableId: true, sourceType: source.type, fields: [] };
  }
  const fields = await listBitableFields(env, source.token, env.FEISHU_RECORDS_TABLE_ID);
  return {
    hasRecordsTableId: true,
    recordsTableId: env.FEISHU_RECORDS_TABLE_ID,
    fields: fields.map((field) => ({
      fieldName: field.field_name || field.fieldName,
      fieldId: field.field_id || field.fieldId,
      type: field.type,
      uiType: field.ui_type || field.uiType
    }))
  };
}
async function listSheetRows(env, source) {
  if (!source.sheetId) {
    throw new Error("Missing environment variable: FEISHU_SHEET_ID. Use the value after sheet= in the Feishu URL, for example 81kyme.");
  }

  const range = `${source.sheetId}!A1:Z1000`;
  const params = new URLSearchParams({ ranges: range, valueRenderOption: "ToString" });
  const result = await feishu(env, `/open-apis/sheets/v2/spreadsheets/${source.token}/values_batch_get?${params}`);
  const valueRange = result.data?.valueRanges?.[0] || result.data?.value_ranges?.[0] || result.data?.valueRange || {};
  const values = valueRange.values || [];
  if (values.length < 2) return [];

  const headers = values[0].map((value) => textValue(value).trim());
  return values.slice(1).map((valuesRow, index) => {
    const fields = {};
    headers.forEach((header, columnIndex) => {
      if (header) fields[header] = valuesRow[columnIndex] ?? "";
    });
    return {
      record_id: String(index + 2),
      fields,
      meta: { rowNumber: index + 2, headers }
    };
  });
}

async function updateSheetRow(env, source, item, fields) {
  const headers = item.meta?.headers || [];
  const rowNumber = item.meta?.rowNumber;
  if (!rowNumber) throw new Error("sheet row number not found");

  for (const [fieldName, value] of Object.entries(fields)) {
    const columnIndex = headers.indexOf(fieldName);
    if (columnIndex < 0) throw new Error(`sheet field not found: ${fieldName}`);
    const columnName = columnLetters(columnIndex + 1);
    await feishu(env, `/open-apis/sheets/v2/spreadsheets/${source.token}/values`, {
      method: "PUT",
      body: JSON.stringify({
        valueRange: {
          range: `${source.sheetId}!${columnName}${rowNumber}:${columnName}${rowNumber}`,
          values: [[value]]
        }
      })
    });
  }
}

async function getDataSource(env) {
  requireEnv(env);
  if (env.FEISHU_APP_TOKEN) {
    return { type: "bitable", token: env.FEISHU_APP_TOKEN };
  }
  if (cachedDataSource) {
    return cachedDataSource.type === "sheet"
      ? { ...cachedDataSource, sheetId: env.FEISHU_SHEET_ID }
      : cachedDataSource;
  }

  const result = await feishu(env, `/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(env.FEISHU_WIKI_TOKEN)}`);
  const node = result.data?.node || result.data || {};
  const objType = node.obj_type || node.objType;
  const objToken = node.obj_token || node.objToken;

  if (!objToken) throw new Error("failed to resolve Feishu wiki token");
  if (objType === "bitable") cachedDataSource = { type: "bitable", token: objToken };
  else if (objType === "sheet") cachedDataSource = await resolveSheetBackedSource(env, objToken);
  else throw new Error(`unsupported wiki node type: ${objType || "unknown"}`);

  return cachedDataSource.type === "sheet"
    ? { ...cachedDataSource, sheetId: env.FEISHU_SHEET_ID }
    : cachedDataSource;
}

async function resolveSheetBackedSource(env, spreadsheetToken) {
  const result = await feishu(env, `/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/metainfo`);
  const sheets = result.data?.sheets || [];
  const bitableSheet = sheets.find((sheet) => sheet.blockInfo?.blockType === "BITABLE_BLOCK" && sheet.blockInfo?.blockToken);

  if (!bitableSheet) {
    return { type: "sheet", token: spreadsheetToken };
  }

  const blockToken = String(bitableSheet.blockInfo.blockToken);
  const tableMarkerIndex = blockToken.lastIndexOf("_tbl");
  if (tableMarkerIndex < 0) {
    throw new Error(`unsupported bitable block token: ${blockToken}`);
  }

  return {
    type: "bitable",
    token: blockToken.slice(0, tableMarkerIndex),
    tableId: blockToken.slice(tableMarkerIndex + 1)
  };
}
async function feishu(env, path, options = {}) {
  const token = await getTenantToken(env);
  const response = await fetch(`${FEISHU_HOST}${path}`, {
    ...options,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.code !== 0) {
    const details = [
      data.code != null ? `code=${data.code}` : "",
      data.msg ? `msg=${data.msg}` : "",
      data.error ? `error=${JSON.stringify(data.error)}` : "",
      data.data?.error ? `data.error=${JSON.stringify(data.data.error)}` : ""
    ].filter(Boolean).join(" ");
    throw new Error(details || `Feishu API failed: ${response.status}`);
  }
  return data;
}

async function getTenantToken(env) {
  requireEnv(env);
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt) {
    return cachedToken;
  }

  const response = await fetch(`${FEISHU_HOST}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.code !== 0 || !data.tenant_access_token) {
    throw new Error(data.msg || "failed to get tenant_access_token");
  }
  cachedToken = data.tenant_access_token;
  cachedTokenExpiresAt = now + Math.max(60, Number(data.expire || 7200) - 300) * 1000;
  return cachedToken;
}

function fieldNames(env) {
  return {
    code: env.FIELD_CODE || "货物编号",
    name: env.FIELD_NAME || "货品",
    stock: env.FIELD_STOCK || "现有库存数量",
    sn: env.FIELD_SN || "SN码",
    inQuantity: env.FIELD_IN_QTY || "入库数量",
    outQuantity: env.FIELD_OUT_QTY || "出库数量",
    owner: env.FIELD_OWNER || "负责人",
    unit: env.FIELD_UNIT || "单位",
    category: env.FIELD_CATEGORY || "分类",
    qr: env.FIELD_QR || "二维码链接",
    note: env.FIELD_NOTE || "备注",
    recordCode: env.FIELD_RECORD_CODE || env.FIELD_CODE || "货物编号",
    recordName: env.FIELD_RECORD_NAME || env.FIELD_NAME || "货品",
    recordType: env.FIELD_RECORD_TYPE || "类型",
    recordQuantity: env.FIELD_RECORD_QTY || "数量",
    reason: env.FIELD_REASON || "出库原因",
    detail: env.FIELD_DETAIL || "具体信息",
    operator: env.FIELD_OPERATOR || "操作人",
    time: env.FIELD_TIME || "操作时间"
  };
}

function requireEnv(env) {
  const required = ["FEISHU_APP_ID", "FEISHU_APP_SECRET"];
  const missing = required.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }
  if (!env.FEISHU_APP_TOKEN && !env.FEISHU_WIKI_TOKEN) {
    throw new Error("Missing environment variables: FEISHU_APP_TOKEN or FEISHU_WIKI_TOKEN");
  }
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new Error("invalid JSON body");
  }
}

function textValue(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(", ");
  if (typeof value === "object") {
    if (value.text) return textValue(value.text);
    if (value.name) return textValue(value.name);
    if (value.link) return textValue(value.link);
  }
  return String(value);
}

function numberValue(value) {
  const number = Number(textValue(value));
  return Number.isFinite(number) ? number : 0;
}

function timeValue(value) {
  if (!value) return "";
  if (typeof value === "number") return new Date(value).toISOString();
  const text = textValue(value);
  const maybeNumber = Number(text);
  if (Number.isFinite(maybeNumber) && maybeNumber > 0) return new Date(maybeNumber).toISOString();
  return text;
}

function formatLocalDateTime(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function columnLetters(index) {
  let letters = "";
  while (index > 0) {
    const mod = (index - 1) % 26;
    letters = String.fromCharCode(65 + mod) + letters;
    index = Math.floor((index - mod) / 26);
  }
  return letters;
}

function publicConfig(env) {
  return {
    hasWikiToken: Boolean(env.FEISHU_WIKI_TOKEN),
    hasSheetId: Boolean(env.FEISHU_SHEET_ID),
    sheetIdLength: env.FEISHU_SHEET_ID ? String(env.FEISHU_SHEET_ID).length : 0,
    hasItemsTableId: Boolean(env.FEISHU_ITEMS_TABLE_ID),
    hasAppToken: Boolean(env.FEISHU_APP_TOKEN),
    hasAppId: Boolean(env.FEISHU_APP_ID),
    hasAppSecret: Boolean(env.FEISHU_APP_SECRET)
  };
}
function json(body, env, request, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(env, request)
    }
  });
}

function corsHeaders(env, request) {
  const requestOrigin = request.headers.get("Origin") || "*";
  const allowed = env.ALLOWED_ORIGIN || "*";
  const origin = allowed === "*" || allowed === requestOrigin ? requestOrigin : allowed;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}








