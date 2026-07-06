let cachedToken = null;
let cachedTokenExpiresAt = 0;
let cachedBitableAppToken = null;

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
        return json({ ok: true, service: "warehouse-api" }, env, request);
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
  const quantity = Number(payload.quantity);
  const reason = String(payload.reason || "").trim();
  const detail = String(payload.detail || "").trim();
  const operator = String(payload.operator || "").trim();

  if (!code) throw new Error("code is required");
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error("quantity must be a positive integer");
  if (!operator) throw new Error("operator is required");
  if (type === "outbound" && (!reason || !detail)) {
    throw new Error("reason and detail are required for outbound movements");
  }

  const item = await findItemByCode(env, code);
  if (!item) throw new Error("item not found");

  const currentStock = Number(item.stock || 0);
  if (type === "outbound" && quantity > currentStock) {
    throw new Error("outbound quantity exceeds current stock");
  }

  const nextStock = type === "inbound" ? currentStock + quantity : currentStock - quantity;
  const fields = fieldNames(env);
  await updateRecord(env, env.FEISHU_ITEMS_TABLE_ID, item.recordId, stockUpdateFields(env, type, item, quantity, nextStock, fields));

  if (env.FEISHU_RECORDS_TABLE_ID) {
    await createRecord(env, env.FEISHU_RECORDS_TABLE_ID, {
      [fields.recordCode]: item.code,
      [fields.recordName]: item.name,
      [fields.recordType]: type === "inbound" ? "入库" : "出库",
      [fields.recordQuantity]: quantity,
      [fields.reason]: reason,
      [fields.detail]: detail,
      [fields.operator]: operator,
      [fields.time]: Date.now()
    });
  }

  return {
    item: { ...item, stock: nextStock },
    movement: { code, type, quantity, reason, detail, operator, time: new Date().toISOString() }
  };
}

async function getItems(env) {
  requireEnv(env);
  const fields = fieldNames(env);
  const rows = await listRecords(env, env.FEISHU_ITEMS_TABLE_ID);
  return rows.map((row) => normalizeItem(row, fields));
}

async function getRecords(env) {
  requireEnv(env);
  if (!env.FEISHU_RECORDS_TABLE_ID) return [];
  const fields = fieldNames(env);
  const rows = await listRecords(env, env.FEISHU_RECORDS_TABLE_ID);
  return rows.map((row) => normalizeMovement(row, fields)).sort((a, b) => new Date(b.time) - new Date(a.time));
}

async function findItemByCode(env, code) {
  const items = await getItems(env);
  return items.find((item) => item.code === code) || null;
}

function normalizeItem(row, fields) {
  const data = row.fields || {};
  return {
    recordId: row.record_id,
    code: textValue(data[fields.code]),
    name: textValue(data[fields.name]),
    stock: numberValue(data[fields.stock]),
    inboundTotal: numberValue(data[fields.inQuantity]),
    outboundTotal: numberValue(data[fields.outQuantity]),
    unit: textValue(data[fields.unit]),
    category: textValue(data[fields.category]),
    qr: textValue(data[fields.qr]),
    note: textValue(data[fields.note])
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

async function listRecords(env, tableId) {
  const records = [];
  const appToken = await getBitableAppToken(env);
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

async function updateRecord(env, tableId, recordId, fields) {
  const appToken = await getBitableAppToken(env);
  return feishu(env, `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`, {
    method: "PUT",
    body: JSON.stringify({ fields })
  });
}

async function createRecord(env, tableId, fields) {
  const appToken = await getBitableAppToken(env);
  return feishu(env, `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`, {
    method: "POST",
    body: JSON.stringify({ fields })
  });
}

async function getBitableAppToken(env) {
  requireEnv(env);
  if (env.FEISHU_APP_TOKEN) return env.FEISHU_APP_TOKEN;
  if (cachedBitableAppToken) return cachedBitableAppToken;

  const result = await feishu(env, `/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(env.FEISHU_WIKI_TOKEN)}`);
  const node = result.data?.node || result.data || {};
  const objType = node.obj_type || node.objType;
  const objToken = node.obj_token || node.objToken;

  if (!objToken) {
    throw new Error("failed to resolve Feishu wiki token to app_token");
  }
  if (objType && objType !== "bitable") {
    throw new Error(`wiki node is ${objType}, not bitable`);
  }

  cachedBitableAppToken = objToken;
  return cachedBitableAppToken;
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
    throw new Error(data.msg || `Feishu API failed: ${response.status}`);
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
    inQuantity: env.FIELD_IN_QTY || "入库数量",
    outQuantity: env.FIELD_OUT_QTY || "出库数量",
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
  const required = [
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_ITEMS_TABLE_ID"
  ];
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

