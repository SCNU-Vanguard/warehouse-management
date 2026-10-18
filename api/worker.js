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

      if (request.method === "POST" && path === "/api/items/update") {
        const payload = await readJson(request);
        const result = await updateItemProfile(env, payload);
        return json({ ok: true, ...result }, env, request);
      }

      if (request.method === "POST" && path === "/api/items/create") {
        const payload = await readJson(request);
        const result = await createInventoryItem(env, payload);
        return json({ ok: true, ...result }, env, request);
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
  const snLines = parseSnPayload(payload.sn ?? payload.snText);

  if (!code && !recordId) throw new Error("code or recordId is required");
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error("quantity must be a positive integer");
  if (!operator) throw new Error("operator is required");
  if (type === "outbound" && (!reason || !detail)) {
    throw new Error("reason and detail are required for outbound movements");
  }

  const items = await getItems(env);
  const recordItem = recordId && items.find((entry) => entry.recordId === recordId);
  const codeItem = code && items.find((entry) => itemMatchesCode(entry, code));
  if (recordItem && code && !itemMatchesCode(recordItem, code)) {
    throw new Error(`货物编号不属于所选物资：${code}`);
  }
  let item = recordItem || codeItem;
  if (!item) throw new Error("item not found");
  const fields = fieldNames(env);
  item = await splitLegacySnRows(env, item, fields);
  if (type === "inbound" && snLines.length > 0) ensureSnNotUsedByOtherItems(items, item, snLines);

  const currentStock = Number(item.stock || 0);
  if (type === "outbound" && quantity > currentStock) {
    throw new Error("outbound quantity exceeds current stock");
  }

  const allSnLines = splitSnLines(item.sn);
  const currentSnLines = availableSnLines(item);
  if (type === "inbound") {
    const duplicate = snLines.find((sn) => allSnLines.some((existing) => sameSnLine(existing, sn)));
    if (duplicate) throw new Error(`SN 已登记过，不能重复入库：${duplicate}`);
  }
  if (allSnLines.length > 0 && currentSnLines.length !== currentStock) {
    throw new Error(`当前库存数量（${currentStock}）与在库 SN 数量（${currentSnLines.length}）不一致，请先在编辑信息中校正 SN`);
  }
  if (type === "inbound" && allSnLines.length === 0 && currentStock > 0 && snLines.length > 0) {
    throw new Error("该物资已有无 SN 库存；请先在编辑信息中为现有库存补齐全部 SN，再继续入库");
  }

  const nextStock = type === "inbound" ? currentStock + quantity : currentStock - quantity;
  const serialTracked = allSnLines.length > 0 || snLines.length > 0;
  const nextSnLines = nextInventorySnLines(type, currentSnLines, snLines, quantity, serialTracked);
  const useSnStatus = sourceUsesSnStatus(item);
  if (useSnStatus && snLines.length > 0) {
    const availableFields = await getInventoryFieldNameSet(env, item);
    const serialFields = [fields.sn, fields.inStock];
    if (!sourceIsSheet(env, item)) serialFields.push(fields.parent, fields.code);
    const missingField = serialFields.find((fieldName) => !availableFields.has(fieldName));
    if (missingField) throw new Error(`Feishu field not found: ${missingField}`);
  }
  const inventoryUpdates = {
    ...stockUpdateFields(env, type, item, quantity, nextStock, fields),
    ...(useSnStatus ? {} : (shouldUpdateSn(type, snLines, currentSnLines) ? { [fields.sn]: nextSnLines.join("\n") } : {}))
  };
  await updateInventoryRow(env, item, inventoryUpdates);
  if (useSnStatus && snLines.length > 0) {
    let snJournal = null;
    try {
      snJournal = await updateSnStatus(env, item, snLines, type === "outbound" ? "是" : "否", fields);
    } catch (error) {
      const rollbackErrors = [];
      try {
        await updateInventoryRow(env, item, stockRollbackFields(env, type, item, fields));
      } catch (rollbackError) {
        rollbackErrors.push(`库存回滚失败：${rollbackError.message || "unknown error"}`);
      }
      try {
        await rollbackMovementSnStatus(env, item, fields, error.snJournal || snJournal);
      } catch (rollbackError) {
        rollbackErrors.push(`SN状态回滚失败：${rollbackError.message || "unknown error"}`);
      }
      if (rollbackErrors.length > 0) {
        throw new Error(`SN 状态更新失败：${error.message || "unknown error"}；${rollbackErrors.join("；")}`);
      }
      throw error;
    }
  }

  let recordWarning = "";
  if (env.FEISHU_RECORDS_TABLE_ID) {
    try {
      await createMovementRecordWithFallback(env, fields, type, item, quantity, reason, detail, operator, snLines);
    } catch (error) {
      recordWarning = `库存已更新，但出入库记录写入失败：${error.message || "unknown error"}`;
    }
  }

  const responseSnLines = useSnStatus && type === "inbound"
    ? [...allSnLines, ...snLines.filter((sn) => !allSnLines.some((existing) => sameSnLine(existing, sn)))]
    : (useSnStatus ? allSnLines : nextSnLines);
  const responseItem = {
    ...item,
    stock: nextStock,
    sn: responseSnLines.join("\n"),
    availableSn: nextSnLines,
    ...(env.STOCK_WRITE_MODE === "stock"
      ? {}
      : type === "inbound"
        ? { inboundTotal: item.inboundTotal + quantity }
        : { outboundTotal: item.outboundTotal + quantity })
  };
  return {
    item: responseItem,
    movement: { code: item.code, type, quantity, reason, detail, operator, sn: snLines, time: new Date().toISOString() },
    warning: recordWarning
  };
}

async function updateItemProfile(env, payload) {
  const code = String(payload.code || "").trim();
  const recordId = String(payload.recordId || "").trim();
  if (!code && !recordId) throw new Error("code or recordId is required");

  const items = await getItems(env);
  const recordItem = recordId && items.find((entry) => entry.recordId === recordId);
  const codeItem = code && items.find((entry) => itemMatchesCode(entry, code));
  if (recordItem && code && !itemMatchesCode(recordItem, code)) {
    throw new Error(`货物编号不属于所选物资：${code}`);
  }
  let item = recordItem || codeItem;
  if (!item) throw new Error("item not found");

  const fields = fieldNames(env);
  item = await splitLegacySnRows(env, item, fields);
  const availableFields = await getInventoryFieldNameSet(env, item);
  const skippedFields = [];
  const updates = {};
  const textFields = [
    ["nextCode", "code", fields.code, true],
    ["name", "name", fields.name, true],
    ["owner", "owner", fields.owner, false],
    ["note", "note", fields.note, false]
  ];

  textFields.forEach(([payloadKey, itemKey, fieldName, required]) => {
    if (Object.prototype.hasOwnProperty.call(payload, payloadKey)) {
      const nextValue = String(payload[payloadKey] || "").trim();
      if (payloadKey === "nextCode" && nextValue && codeBelongsToOtherItem(items, item, nextValue)) {
        throw new Error(`货物编号已属于其他物资：${nextValue}`);
      }
      if (!availableFields.has(fieldName)) {
        if (required) throw new Error(`Feishu field not found: ${fieldName}`);
        if (nextValue !== String(item[itemKey] || "")) skippedFields.push(fieldName);
        return;
      }
      if (nextValue !== String(item[itemKey] || "")) updates[fieldName] = nextValue;
    }
  });

  let groupedSnUpdate = null;
  if (Object.prototype.hasOwnProperty.call(payload, "sn")) {
    if (sourceUsesSnStatus(item)) {
      const serialFields = [fields.sn, fields.inStock, ...(sourceIsSheet(env, item) ? [] : [fields.parent])];
      const missingField = serialFields.find((fieldName) => !availableFields.has(fieldName));
      if (missingField) throw new Error(`Feishu field not found: ${missingField}`);
    }
    const snLines = parseSnPayload(payload.sn);
    ensureUniqueSnLines(snLines);
    ensureSnNotUsedByOtherItems(items, item, snLines);
    const nextSn = snLines.join("\n");
    if (nextSn !== String(item.sn || "")) {
      validateSnMaintenance(item, snLines);
      if (sourceUsesSnStatus(item)) {
        groupedSnUpdate = snLines;
      } else {
        if (!availableFields.has(fields.sn)) throw new Error(`Feishu field not found: ${fields.sn}`);
        updates[fields.sn] = nextSn;
      }
    }
  }

  const addCodes = Object.prototype.hasOwnProperty.call(payload, "addCodes")
    ? parseSnPayload(payload.addCodes)
    : [];
  ensureUniqueTextLines(addCodes, "货物编号");
  const newCodes = addCodes.filter((nextCode) => !itemHasNormalizedCode(item, nextCode));
  const nextPrimaryCode = updates[fields.code] ?? item.code;
  if (itemHasNormalizedCode(item, nextPrimaryCode) && normalizeGroupKey(nextPrimaryCode) !== normalizeGroupKey(item.code)) {
    throw new Error(`主编号与此物资已有编号重复：${nextPrimaryCode}`);
  }
  if (newCodes.some((nextCode) => normalizeGroupKey(nextCode) === normalizeGroupKey(nextPrimaryCode))) {
    throw new Error("新增编号不能与主编号重复");
  }
  newCodes.forEach((nextCode) => {
    if (codeBelongsToOtherItem(items, item, nextCode)) {
      throw new Error(`货物编号已属于其他物资：${nextCode}`);
    }
  });
  if (newCodes.length > 0 && !sourceIsSheet(env, item) && !availableFields.has(fields.parent)) {
    throw new Error(`Feishu field not found: ${fields.parent}`);
  }

  if (Object.keys(updates).length === 0 && groupedSnUpdate === null && newCodes.length === 0) return { item, skippedFields };

  if (Object.keys(updates).length > 0) await updateInventoryRow(env, item, updates);
  const itemAfterProfile = { ...item, ...profilePatchFromUpdates(fields, updates) };
  let groupedSnResult = null;
  if (groupedSnUpdate !== null) {
    groupedSnResult = await updateGroupedSn(env, itemAfterProfile, groupedSnUpdate, fields);
  }
  if (newCodes.length > 0) {
    await appendItemCodes(env, itemAfterProfile, newCodes, fields, availableFields);
  }
  const nextItem = itemAfterProfile;
  if (Object.prototype.hasOwnProperty.call(updates, fields.code)) {
    const codes = (item.codes || [item.code]).filter((entry) => normalizeGroupKey(entry) !== normalizeGroupKey(item.code));
    nextItem.codes = [...new Set([updates[fields.code], ...codes].filter(Boolean))];
  }
  if (newCodes.length > 0) nextItem.codes = [...new Set([...(item.codes || []), ...newCodes])];
  if (groupedSnResult) {
    nextItem.sn = groupedSnResult.sn.join("\n");
    nextItem.availableSn = groupedSnResult.availableSn;
  }
  return { item: nextItem, skippedFields };
}

async function createInventoryItem(env, payload) {
  const code = String(payload.code || "").trim();
  const name = String(payload.name || "").trim();
  const owner = String(payload.owner || "").trim();
  const note = String(payload.note || "").trim();
  if (!code || !name) throw new Error("货物编号和货品名称都必须填写");

  const items = await getItems(env);
  if (codeBelongsToOtherItem(items, null, code)) throw new Error(`货物编号已存在：${code}`);

  const source = await getDataSource(env);
  const fields = fieldNames(env);
  const tableId = env.FEISHU_ITEMS_TABLE_ID || source.tableId;
  if (source.type === "bitable" && !tableId) throw new Error("Missing environment variable: FEISHU_ITEMS_TABLE_ID");
  const fieldSet = source.type === "sheet"
    ? new Set(await getSheetHeaders(env, source))
    : new Set((await listBitableFields(env, source.token, tableId))
      .map((field) => field.field_name || field.fieldName).filter(Boolean));
  const requiredFields = [fields.code, fields.name, fields.sn, fields.inStock];
  if (source.type === "bitable") requiredFields.push(fields.parent);
  requiredFields.push(...(env.STOCK_WRITE_MODE === "stock"
    ? [fields.stock]
    : [fields.inQuantity, fields.outQuantity]));
  for (const required of requiredFields) {
    if (!fieldSet.has(required)) throw new Error(`Feishu field not found: ${required}`);
  }
  if (source.type === "sheet" && items.some((item) => normalizeGroupKey(item.name) === normalizeGroupKey(name))) {
    throw new Error("飞书表格按货品名称归类，已存在同名物资；请使用已有物资并新增编号");
  }

  const createFields = {
    [fields.code]: code,
    [fields.name]: name,
    [fields.sn]: "",
    [fields.inStock]: "否"
  };
  if (owner && fieldSet.has(fields.owner)) createFields[fields.owner] = owner;
  if (note && fieldSet.has(fields.note)) createFields[fields.note] = note;
  if (env.STOCK_WRITE_MODE === "stock") createFields[fields.stock] = 0;
  else {
    createFields[fields.inQuantity] = 0;
    createFields[fields.outQuantity] = 0;
  }

  if (source.type === "sheet") {
    await appendSheetRow(env, source, await getSheetHeaders(env, source), createFields);
  } else {
    await createBitableRecord(env, source.token, tableId, createFields);
  }

  const created = await getItems(env);
  const item = created.find((entry) => itemMatchesCode(entry, code));
  if (!item) throw new Error("物资已写入飞书，但重新读取时未找到；请刷新页面确认");
  return { item };
}

function validateSnMaintenance(item, desiredSn) {
  const currentSn = splitSnLines(item.sn);
  const available = availableSnLines(item);
  if (currentSn.length === 0 && desiredSn.length === 0) return;

  const availableKeys = new Set(available.map(normalizeSnLine));
  const usedSn = currentSn.filter((sn) => !availableKeys.has(normalizeSnLine(sn)));
  const expectedTotal = usedSn.length + Math.max(0, Number(item.stock || 0));
  if (desiredSn.length !== expectedTotal) {
    throw new Error(`SN维护后在库SN数必须等于当前库存 ${Number(item.stock || 0)}，已出库SN需保留`);
  }
  const desiredKeys = new Set(desiredSn.map(normalizeSnLine));
  const removedUsed = usedSn.find((sn) => !desiredKeys.has(normalizeSnLine(sn)));
  if (removedUsed) throw new Error(`SN 已出库，不能从网页删除：${removedUsed}`);
}

async function getInventoryFieldNameSet(env, item) {
  const source = await getDataSource(env);
  if (source.type === "sheet") return new Set(item.meta?.headers || []);

  const tableId = env.FEISHU_ITEMS_TABLE_ID || source.tableId;
  if (!tableId) throw new Error("Missing environment variable: FEISHU_ITEMS_TABLE_ID");
  const fields = await listBitableFields(env, source.token, tableId);
  return new Set(fields.map((field) => field.field_name || field.fieldName).filter(Boolean));
}

function ensureSnNotUsedByOtherItems(items, currentItem, snLines) {
  const wanted = new Set(snLines.map(normalizeSnLine).filter(Boolean));
  if (wanted.size === 0) return;
  for (const item of items) {
    const sameItem = currentItem?.recordId
      ? item.recordId === currentItem.recordId
      : currentItem
        ? itemMatchesCode(item, currentItem.code)
        : false;
    if (sameItem) continue;
    const duplicate = splitSnLines(item.sn).find((sn) => wanted.has(normalizeSnLine(sn)));
    if (duplicate) throw new Error(`SN already used by another item: ${duplicate}`);
  }
}

function ensureUniqueTextLines(lines, label) {
  const seen = new Set();
  for (const line of lines) {
    const key = normalizeGroupKey(line);
    if (seen.has(key)) throw new Error(`${label}重复：${line}`);
    seen.add(key);
  }
}

function itemHasNormalizedCode(item, code) {
  const wanted = normalizeGroupKey(code);
  if (!wanted) return false;
  const codes = Array.isArray(item?.codes) ? item.codes : [item?.code];
  return codes.some((entry) => normalizeGroupKey(entry) === wanted);
}

function codeBelongsToOtherItem(items, currentItem, code) {
  return items.some((item) => {
    if (currentItem?.recordId && item.recordId === currentItem.recordId) return false;
    if (!currentItem?.recordId && currentItem && itemMatchesCode(item, currentItem.code)) return false;
    return itemHasNormalizedCode(item, code);
  });
}

function profilePatchFromUpdates(fields, updates) {
  const patch = {};
  const map = [
    ["code", fields.code],
    ["name", fields.name],
    ["sn", fields.sn],
    ["owner", fields.owner],
    ["note", fields.note]
  ];
  map.forEach(([key, fieldName]) => {
    if (Object.prototype.hasOwnProperty.call(updates, fieldName)) patch[key] = updates[fieldName];
  });
  return patch;
}

function nextInventorySnLines(type, currentSnLines, movementSnLines, quantity, serialTracked = false) {
  ensureUniqueSnLines(movementSnLines);
  const requiresSn = serialTracked || movementSnLines.length > 0;

  if (type === "inbound") {
    if (requiresSn && movementSnLines.length !== quantity) {
      throw new Error(`SN count must equal inbound quantity: ${quantity}`);
    }
    const duplicate = movementSnLines.find((sn) => currentSnLines.some((line) => sameSnLine(line, sn)));
    if (duplicate) {
      throw new Error(`SN already exists in inventory: ${duplicate}`);
    }
    return [...currentSnLines, ...movementSnLines];
  }

  if (requiresSn && movementSnLines.length !== quantity) {
    throw new Error(`SN count must equal outbound quantity: ${quantity}`);
  }
  if (movementSnLines.length === 0) return currentSnLines;

  const remaining = [...currentSnLines];
  for (const sn of movementSnLines) {
    const index = remaining.findIndex((line) => sameSnLine(line, sn));
    if (index < 0) throw new Error(`SN not found in inventory: ${sn}`);
    remaining.splice(index, 1);
  }
  return remaining;
}

function ensureUniqueSnLines(snLines) {
  const seen = new Set();
  for (const sn of snLines) {
    const key = normalizeSnLine(sn);
    if (seen.has(key)) throw new Error(`Duplicate SN in request: ${sn}`);
    seen.add(key);
  }
}

function shouldUpdateSn(type, movementSnLines, currentSnLines) {
  return movementSnLines.length > 0 || (type === "outbound" && currentSnLines.length > 0);
}

function stockRollbackFields(env, type, item, fields) {
  if (env.STOCK_WRITE_MODE === "stock") {
    return { [fields.stock]: Number(item.stock || 0) };
  }

  return type === "inbound"
    ? { [fields.inQuantity]: Number(item.inboundTotal || 0) }
    : { [fields.outQuantity]: Number(item.outboundTotal || 0) };
}

function parseSnPayload(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry || "").trim()).filter(Boolean);
  return splitSnLines(value);
}

function splitSnLines(value) {
  return String(value || "").split(/[\r\n,，;；]+/).map((line) => line.trim()).filter(Boolean);
}

function sameSnLine(a, b) {
  return normalizeSnLine(a) === normalizeSnLine(b);
}

function normalizeSnLine(value) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

async function createMovementRecordWithFallback(env, fields, type, item, quantity, reason, detail, operator, snLines) {
  const now = new Date();
  const variants = [
    movementRecordFields(fields, type, item, quantity, reason, detail, operator, snLines, { quantity, time: now.getTime() }),
    movementRecordFields(fields, type, item, quantity, reason, detail, operator, snLines, { quantity: String(quantity), time: now.getTime() }),
    movementRecordFields(fields, type, item, quantity, reason, detail, operator, snLines, { quantity: String(quantity), time: formatLocalDateTime(now) }),
    movementRecordFields(fields, type, item, quantity, reason, detail, operator, snLines, { quantity: String(quantity), time: null })
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

function movementRecordFields(fields, type, item, quantity, reason, detail, operator, snLines, overrides = {}) {
  const record = {
    [fields.recordCode]: item.code || "",
    [fields.recordName]: item.name || "",
    [fields.recordType]: type === "inbound" ? "入库" : "出库",
    [fields.recordQuantity]: overrides.quantity ?? quantity,
    [fields.reason]: reason || "",
    [fields.detail]: detailWithSn(detail, snLines),
    [fields.operator]: operator || ""
  };
  if (fields.recordSn && snLines.length > 0) record[fields.recordSn] = snLines.join("\n");
  if (overrides.time !== null) {
    record[fields.time] = overrides.time ?? Date.now();
  }
  return record;
}

function detailWithSn(detail, snLines) {
  if (snLines.length === 0) return detail || "";
  return [detail || "", `SN: ${snLines.join("\n")}`].filter(Boolean).join("\n");
}

async function getItems(env) {
  requireEnv(env);
  const source = await getDataSource(env);
  const fields = fieldNames(env);

  if (source.type === "sheet") {
    const rows = await listSheetRows(env, source);
    return normalizeSheetItems(rows, fields);
  }

  const tableId = env.FEISHU_ITEMS_TABLE_ID || source.tableId;
  if (!tableId) throw new Error("Missing environment variable: FEISHU_ITEMS_TABLE_ID");
  const rows = await listBitableRecords(env, source.token, tableId);
  return normalizeBitableItems(rows, fields);
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
  return (recordId && items.find((item) => item.recordId === recordId))
    || (code && items.find((item) => itemMatchesCode(item, code)))
    || null;
}

function itemMatchesCode(item, code) {
  return itemHasNormalizedCode(item, code);
}

function normalizeItem(row, fields) {
  const data = row.fields || {};
  const code = textValue(data[fields.code]);
  return {
    recordId: row.record_id,
    code,
    codes: code ? [code] : [],
    name: textValue(data[fields.name]),
    sn: textValue(data[fields.sn]),
    inStock: textValue(data[fields.inStock]),
    stock: numberValue(data[fields.stock]),
    inboundTotal: numberValue(data[fields.inQuantity]),
    outboundTotal: numberValue(data[fields.outQuantity]),
    owner: textValue(data[fields.owner]),
    qr: textValue(data[fields.qr]),
    note: textValue(data[fields.note]),
    meta: row.meta || null
  };
}

function rowAvailableSn(item) {
  return isInStockValue(item.inStock) ? splitSnLines(item.sn) : [];
}

function isInStockValue(value) {
  const text = String(value || "").trim().toLowerCase();
  return !["是", "yes", "y", "true", "1"].includes(text);
}

function availableSnLines(item) {
  if (Array.isArray(item.availableSn)) return item.availableSn;
  return splitSnLines(item.sn);
}

function sourceIsSheet(env, item) {
  return item.meta?.sourceType === "sheet";
}

function sourceIsGrouped(item) {
  return item.meta?.grouped === true;
}

function sourceUsesSnStatus(item) {
  return sourceIsGrouped(item) || item.meta?.sourceType === "bitable";
}

// Sheets are commonly maintained in either of two forms: one row per item
// with newline-separated SNs, or one row per physical item. In the latter
// form the category name is written only on the first row while child rows
// contain the code and SN. Use the category name as the identity and carry
// it through the child rows; a category may contain more than one code.
function normalizeSheetItems(rows, fields) {
  return normalizeGroupedItems(rows, fields, "sheet");
}

function normalizeBitableItems(rows, fields) {
  return normalizeGroupedItems(rows, fields, "bitable");
}

function normalizeGroupedItems(rows, fields, sourceType) {
  const items = [];
  const byKey = new Map();
  const rowsById = new Map(rows.filter((row) => row.record_id).map((row) => [String(row.record_id), row]));
  const rowsByName = new Map();
  const linkedParentIds = new Set();

  rows.forEach((row) => {
    const name = textValue((row.fields || {})[fields.name]).trim();
    if (name && !rowsByName.has(normalizeGroupKey(name))) rowsByName.set(normalizeGroupKey(name), row);
  });
  rows.forEach((row) => {
    if (sourceType === "bitable") {
      const relation = relationInfo((row.fields || {})[fields.parent], rowsById);
      relation.recordIds.forEach((recordId) => linkedParentIds.add(recordId));
      relation.labels.forEach((label) => {
        const parentRow = rowsByName.get(normalizeGroupKey(label));
        if (parentRow?.record_id) linkedParentIds.add(String(parentRow.record_id));
      });
    }
  });

  let activeName = "";

  rows.forEach((row) => {
    const item = normalizeItem(row, fields);
    const rowFields = row.fields || {};
    const relation = sourceType === "bitable" ? relationInfo(rowFields[fields.parent], rowsById) : { recordIds: [], labels: [] };
    const hasParent = relation.recordIds.length > 0 || relation.labels.length > 0;
    const parentRecordId = relation.recordIds.find((recordId) => rowsById.has(recordId)) || relation.recordIds[0] || "";
    const parentRow = parentRecordId ? resolveRootRow(parentRecordId, rowsById, fields) : null;
    const parentLabel = parentRow
      ? rowCategoryName(parentRow, rowsById, fields)
      : relation.labels[0] || "";
    const namedParentRow = parentLabel ? rowsByName.get(normalizeGroupKey(parentLabel)) : null;
    const rootRow = parentRow || namedParentRow || (!hasParent ? row : null);
    const categoryName = sourceType === "sheet"
      ? item.name || activeName
      : hasParent
        ? parentLabel || item.name
        : item.name;

    if (sourceType === "sheet" && !item.code && !item.name && !item.sn) {
      activeName = "";
      return;
    }
    if (!item.code && !item.name && !item.sn && !categoryName) {
      return;
    }

    if (item.name) activeName = item.name;
    // Use the linked parent record as identity. Names and product codes are
    // labels here: neither is guaranteed to map one-to-one to a category.
    const rowRecordId = String(row.record_id || "");
    const hasLinkedGroup = hasParent || linkedParentIds.has(rowRecordId);
    const rootRecordId = String(rootRow?.record_id || (hasLinkedGroup ? parentRecordId : row.record_id) || "");
    const key = sourceType === "sheet"
      ? categoryName
        ? `name:${normalizeGroupKey(categoryName)}`
        : item.code
          ? `code:${normalizeGroupKey(item.code)}`
          : `record:${row.record_id || items.length}`
      : hasLinkedGroup && rootRecordId
        ? `record:${rootRecordId}`
        : `record:${row.record_id || items.length}`;
    const primaryItem = rootRow ? normalizeItem(rootRow, fields) : item;
    const primaryRowNumber = sourceType === "sheet"
      ? (item.name ? item.meta?.rowNumber : null)
      : rootRow?.meta?.rowNumber || null;
    const primaryRecordId = sourceType === "bitable"
      ? String(rootRecordId || row.record_id || "")
      : "";
    const grouped = sourceType === "sheet" || hasLinkedGroup;
    const existing = byKey.get(key);
    if (!existing) {
      const normalized = {
        ...item,
        recordId: primaryRecordId || row.record_id,
        code: primaryItem.code || item.code,
        codes: [...new Set([primaryItem.code, item.code].filter(Boolean))],
        name: categoryName,
        availableSn: rowAvailableSn(item),
        meta: {
          ...(item.meta || {}),
          rowNumbers: [item.meta?.rowNumber].filter(Boolean),
          primaryRowNumber,
          primaryRecordId,
          fallbackRecordId: row.record_id || "",
          grouped,
          sourceType,
          sourceRows: [row],
          sourceToken: row.meta?.sourceToken || "",
          sheetId: row.meta?.sheetId || ""
        }
      };
      byKey.set(key, normalized);
      items.push(normalized);
      return;
    }

    if (!existing.name && categoryName) existing.name = categoryName;
    if (primaryItem.code && !existing.meta.primaryRecordId) existing.code = primaryItem.code;
    if (!existing.code && item.code) existing.code = item.code;
    if (item.code && !existing.codes.includes(item.code)) existing.codes.push(item.code);
    if (primaryRecordId && !existing.meta.primaryRecordId) {
      existing.recordId = primaryRecordId;
      existing.meta.primaryRowNumber = primaryRowNumber;
      existing.meta.primaryRecordId = primaryRecordId;
    }
    existing.meta.grouped ||= grouped;

    const currentSn = splitSnLines(existing.sn);
    const nextSn = splitSnLines(item.sn);
    nextSn.forEach((sn) => {
      if (!currentSn.some((line) => sameSnLine(line, sn))) currentSn.push(sn);
    });
    existing.sn = currentSn.join("\n");
    const available = availableSnLines(existing);
    const nextAvailable = rowAvailableSn(item);
    nextAvailable.forEach((sn) => {
      if (!available.some((line) => sameSnLine(line, sn))) available.push(sn);
    });
    existing.availableSn = available;
    existing.meta.rowNumbers.push(item.meta?.rowNumber);
    existing.meta.sourceRows.push(row);
    existing.stock = mergeSheetNumber(existing.stock, item.stock, existing.meta.sourceRows, fields.stock);
    existing.inboundTotal = mergeSheetNumber(existing.inboundTotal, item.inboundTotal, existing.meta.sourceRows, fields.inQuantity);
    existing.outboundTotal = mergeSheetNumber(existing.outboundTotal, item.outboundTotal, existing.meta.sourceRows, fields.outQuantity);
    existing.owner ||= item.owner;
    existing.qr ||= item.qr;
    existing.note ||= item.note;
  });

  return items;
}

function mergeSheetNumber(current, next, sourceRows, fieldName) {
  if (!Number.isFinite(next) || next === 0) return current;
  const values = sourceRows.map((row) => numberValue((row.fields || {})[fieldName]));
  // Repeated totals are usually copied down the sheet; keep one value.
  if (values.length > 1 && values.every((value) => value === values[0])) return values[0];
  return current + next;
}

function normalizeGroupKey(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function relationInfo(value, rowsById) {
  const recordIds = [];
  const labels = [];
  const addId = (entry) => {
    if (entry == null || entry === "") return;
    const id = String(entry).trim();
    if (id && !recordIds.includes(id)) recordIds.push(id);
  };
  const addLabel = (entry) => {
    if (entry == null || entry === "") return;
    const label = String(entry).trim();
    if (label && !rowsById.has(label) && !labels.includes(label)) labels.push(label);
  };
  const visit = (entry) => {
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    if (entry == null || entry === "") return;
    if (typeof entry === "string" || typeof entry === "number") {
      const text = String(entry).trim();
      if (rowsById.has(text)) addId(text);
      else addLabel(text);
      return;
    }
    if (typeof entry !== "object") return;

    const rawIds = [entry.record_id, entry.recordId, entry.record_ids, entry.recordIds, entry.link_record_ids, entry.linkRecordIds];
    rawIds.flatMap((ids) => Array.isArray(ids) ? ids : [ids]).forEach(addId);
    [entry.text, entry.name, entry.title, entry.display_name, entry.displayName].forEach(addLabel);
    if (entry.value != null) visit(entry.value);
  };

  visit(value);
  return { recordIds, labels };
}

function resolveRootRow(recordId, rowsById, fields, visited = new Set()) {
  if (!recordId || visited.has(recordId)) return null;
  visited.add(recordId);
  const row = rowsById.get(recordId);
  if (!row) return null;
  const parentInfo = relationInfo((row.fields || {})[fields.parent], rowsById);
  const parentId = parentInfo.recordIds.find((id) => rowsById.has(id) && id !== recordId);
  return parentId ? resolveRootRow(parentId, rowsById, fields, visited) || row : row;
}

function rowCategoryName(row, rowsById, fields, visited = new Set()) {
  const recordId = String(row.record_id || "");
  if (recordId && visited.has(recordId)) return "";
  if (recordId) visited.add(recordId);
  const data = row.fields || {};
  const name = textValue(data[fields.name]);
  if (name) return name;
  const relation = relationInfo(data[fields.parent], rowsById);
  const parentId = relation.recordIds.find((id) => rowsById.has(id));
  const parentRow = parentId ? rowsById.get(parentId) : null;
  return parentRow ? rowCategoryName(parentRow, rowsById, fields, visited) : relation.labels[0] || "";
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
    sn: fields.recordSn ? textValue(data[fields.recordSn]) : "",
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

  const recordId = item.meta?.primaryRecordId || item.meta?.fallbackRecordId || item.recordId;
  return updateBitableRecord(env, source.token, env.FEISHU_ITEMS_TABLE_ID || source.tableId, recordId, fields);
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
    const items = result.data?.items || [];
    records.push(...items.map((row) => ({
      ...row,
      meta: {
        ...(row.meta || {}),
        sourceType: "bitable",
        sourceToken: appToken,
        tableId
      }
    })));
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
      meta: { rowNumber: index + 2, headers, sourceToken: source.token, sheetId: source.sheetId }
    };
  });
}

async function updateSheetRow(env, source, item, fields) {
  const headers = item.meta?.headers || [];
  const rowNumbers = item.meta?.rowNumbers || [item.meta?.rowNumber];
  const rowNumber = item.meta?.primaryRowNumber || rowNumbers.find(Boolean);
  if (!rowNumber) throw new Error("sheet row number not found");

  for (const [fieldName, value] of Object.entries(fields)) {
    const columnIndex = headers.indexOf(fieldName);
    if (columnIndex < 0) throw new Error(`sheet field not found: ${fieldName}`);
    const columnName = columnLetters(columnIndex + 1);
    // Keep aggregate edits on the group’s first row. Per-SN child rows stay
    // intact so the new status-based layout is never flattened by profile edit.
    const targetRows = [rowNumber];
    for (const [index, targetRow] of targetRows.entries()) {
      await feishu(env, `/open-apis/sheets/v2/spreadsheets/${source.token}/values`, {
        method: "PUT",
        body: JSON.stringify({
          valueRange: {
            range: `${source.sheetId}!${columnName}${targetRow}:${columnName}${targetRow}`,
            values: [[value]]
          }
        })
      });
    }
  }
}

async function getSheetHeaders(env, source) {
  if (!source.sheetId) throw new Error("Missing environment variable: FEISHU_SHEET_ID");
  const params = new URLSearchParams({ ranges: `${source.sheetId}!A1:Z1`, valueRenderOption: "ToString" });
  const result = await feishu(env, `/open-apis/sheets/v2/spreadsheets/${source.token}/values_batch_get?${params}`);
  const valueRange = result.data?.valueRanges?.[0] || result.data?.value_ranges?.[0] || result.data?.valueRange || {};
  return (valueRange.values?.[0] || []).map((value) => textValue(value).trim());
}

async function appendSheetRow(env, source, headers, fields) {
  const lastColumn = columnLetters(headers.length);
  if (!lastColumn) throw new Error("sheet headers not found");
  const values = headers.map((header) => fields[header] ?? "");
  await feishu(env, `/open-apis/sheets/v2/spreadsheets/${source.token}/values_append?insertDataOption=INSERT_ROWS`, {
    method: "POST",
    body: JSON.stringify({ valueRange: { range: `${source.sheetId}!A1:${lastColumn}1`, values: [values] } })
  });
}

async function appendItemCodes(env, item, codes, fields, availableFields) {
  const source = await getDataSource(env);
  if (source.type === "sheet") {
    const headers = item.meta?.headers || await getSheetHeaders(env, source);
    for (const code of codes) {
      await appendSheetRow(env, source, headers, {
        [fields.name]: item.name || "",
        [fields.code]: code,
        [fields.sn]: "",
        [fields.inStock]: "否"
      });
    }
    return;
  }

  const tableId = env.FEISHU_ITEMS_TABLE_ID || source.tableId;
  const parentRecordId = item.meta?.primaryRecordId || item.recordId;
  if (!tableId) throw new Error("Missing environment variable: FEISHU_ITEMS_TABLE_ID");
  if (!availableFields.has(fields.parent)) throw new Error(`Feishu field not found: ${fields.parent}`);
  if (!parentRecordId) throw new Error("parent record not found; cannot add product codes");
  for (const code of codes) {
    await createBitableRecord(env, source.token, tableId, {
      [fields.code]: code,
      ...(availableFields.has(fields.inStock) ? { [fields.inStock]: "否" } : {}),
      [fields.parent]: [parentRecordId]
    });
  }
}

async function updateSheetCells(env, source, headers, rowNumber, fields) {
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

async function appendSheetSnRow(env, source, item, sn, fields, status = "否") {
  const headers = item.meta?.headers || [];
  const values = headers.map((header) => {
    if (header === fields.name) return item.name || "";
    if (header === fields.code) return item.code || "";
    if (header === fields.sn) return sn;
    if (header === fields.inStock) return status;
    return "";
  });
  const lastColumn = columnLetters(headers.length);
  if (!lastColumn) throw new Error("sheet headers not found");
  await feishu(env, `/open-apis/sheets/v2/spreadsheets/${source.token}/values_append?insertDataOption=INSERT_ROWS`, {
    method: "POST",
    body: JSON.stringify({
      valueRange: {
        range: `${source.sheetId}!A1:${lastColumn}1`,
        values: [values]
      }
    })
  });
}

async function splitLegacySnRows(env, item, fields) {
  const multiSnRows = snCandidateRows(item, fields.sn).filter((row) =>
    splitSnLines(textValue((row.fields || {})[fields.sn])).length > 1
  );
  if (multiSnRows.length === 0) return item;

  const source = await getDataSource(env);
  const statusFieldPresent = source.type === "sheet"
    ? (item.meta?.headers || []).includes(fields.inStock)
    : (await getInventoryFieldNameSet(env, item)).has(fields.inStock);
  if (!statusFieldPresent) throw new Error(`Feishu field not found: ${fields.inStock}`);

  if (source.type === "sheet") {
    const headers = item.meta?.headers || [];
    const emptyRows = snCandidateRows(item, fields.sn).filter((row) =>
      splitSnLines(textValue((row.fields || {})[fields.sn])).length === 0
    );
    for (const row of multiSnRows) {
      const snLines = splitSnLines(textValue((row.fields || {})[fields.sn]));
      const status = textValue((row.fields || {})[fields.inStock]) || "否";
      await updateSheetCells(env, source, headers, row.meta.rowNumber, { [fields.sn]: snLines[0] });
      for (const sn of snLines.slice(1)) {
        const emptyRow = emptyRows.shift();
        if (emptyRow) {
          await updateSheetCells(env, source, headers, emptyRow.meta.rowNumber, {
            [fields.name]: item.name || "",
            [fields.code]: item.code || "",
            [fields.sn]: sn,
            [fields.inStock]: status
          });
        } else {
          await appendSheetSnRow(env, source, item, sn, fields, status);
        }
      }
    }
  } else {
    const tableId = env.FEISHU_ITEMS_TABLE_ID || source.tableId;
    const availableFields = await getInventoryFieldNameSet(env, item);
    const parentRecordId = item.meta?.primaryRecordId || item.recordId;
    if (!tableId) throw new Error("Missing environment variable: FEISHU_ITEMS_TABLE_ID");
    if (!availableFields.has(fields.parent)) throw new Error(`Feishu field not found: ${fields.parent}`);
    if (!parentRecordId) throw new Error("parent record not found; cannot split multiple SN");

    for (const row of multiSnRows) {
      const snLines = splitSnLines(textValue((row.fields || {})[fields.sn]));
      const status = textValue((row.fields || {})[fields.inStock]) || "否";
      await updateBitableRecord(env, source.token, tableId, row.record_id, { [fields.sn]: snLines[0] });
      for (const sn of snLines.slice(1)) {
        await createBitableRecord(env, source.token, tableId, {
          [fields.code]: item.code || "",
          [fields.sn]: sn,
          [fields.inStock]: status,
          [fields.parent]: [parentRecordId]
        });
      }
    }
  }

  const updatedItems = await getItems(env);
  return updatedItems.find((entry) => entry.recordId === item.recordId)
    || updatedItems.find((entry) => itemMatchesCode(entry, item.code))
    || item;
}

async function updateSheetSnStatus(env, item, snLines, status, fields) {
  const journal = [];
  const headers = item.meta?.headers || [];
  const columnIndex = headers.indexOf(fields.inStock);
  if (columnIndex < 0) throw new Error(`sheet field not found: ${fields.inStock}`);
  const source = await getDataSource(env);
  const candidates = snCandidateRows(item, fields.sn);
  const emptyRows = candidates.filter((row) => splitSnLines(textValue((row.fields || {})[fields.sn])).length === 0);

  try {
    for (const sn of snLines) {
      const matchingRows = candidates.filter((row) =>
        splitSnLines(textValue((row.fields || {})[fields.sn])).some((entry) => sameSnLine(entry, sn))
      );
      if (matchingRows.some((row) => splitSnLines(textValue((row.fields || {})[fields.sn])).length > 1)) {
        throw new Error("请先将一行多个 SN 拆分为每行一个，再办理出入库");
      }
      if (matchingRows.length > 1) throw new Error(`SN 在物资中重复：${sn}`);

      const row = matchingRows[0];
      if (row) {
        const previousStatus = (row.fields || {})[fields.inStock] ?? "";
        if (status === "是" && !isInStockValue(textValue(previousStatus))) {
          throw new Error(`SN not found in inventory: ${sn}`);
        }
        journal.push({ kind: "restore", sourceType: "sheet", rowNumber: row.meta?.rowNumber, fields: { [fields.inStock]: textValue(previousStatus) } });
        await updateSheetCells(env, source, headers, row.meta.rowNumber, { [fields.inStock]: status });
        continue;
      }

      if (status !== "否") throw new Error(`SN not found in inventory: ${sn}`);
      const emptyRow = emptyRows.shift();
      if (emptyRow) {
        journal.push({
          kind: "restore",
          sourceType: "sheet",
          rowNumber: emptyRow.meta?.rowNumber,
          fields: {
            [fields.sn]: textValue((emptyRow.fields || {})[fields.sn]),
            [fields.inStock]: textValue((emptyRow.fields || {})[fields.inStock])
          }
        });
        await updateSheetCells(env, source, headers, emptyRow.meta.rowNumber, {
          [fields.sn]: sn,
          [fields.inStock]: status
        });
      } else {
        journal.push({ kind: "clear-created", sourceType: "sheet", sn });
        await appendSheetSnRow(env, source, item, sn, fields, status);
      }
    }
    return journal;
  } catch (error) {
    error.snJournal = journal;
    throw error;
  }
}

async function updateBitableSnStatus(env, item, snLines, status, fields) {
  const journal = [];
  const source = await getDataSource(env);
  const tableId = env.FEISHU_ITEMS_TABLE_ID || source.tableId;
  const candidates = snCandidateRows(item, fields.sn);
  const emptyRows = candidates.filter((row) => splitSnLines(textValue((row.fields || {})[fields.sn])).length === 0);
  const parentRecordId = item.meta?.primaryRecordId || item.recordId;
  if (!tableId) throw new Error("Missing environment variable: FEISHU_ITEMS_TABLE_ID");
  if (!parentRecordId) throw new Error("parent record not found; cannot create SN rows");

  try {
    for (const sn of snLines) {
      const matchingRows = candidates.filter((row) =>
        splitSnLines(textValue((row.fields || {})[fields.sn])).some((entry) => sameSnLine(entry, sn))
      );
      if (matchingRows.some((row) => splitSnLines(textValue((row.fields || {})[fields.sn])).length > 1)) {
        throw new Error("请先将一行多个 SN 拆分为每行一个，再办理出入库");
      }
      if (matchingRows.length > 1) throw new Error(`SN 在物资中重复：${sn}`);

      const row = matchingRows[0];
      if (row) {
        const previousStatus = (row.fields || {})[fields.inStock] ?? "";
        if (status === "是" && !isInStockValue(textValue(previousStatus))) {
          throw new Error(`SN not found in inventory: ${sn}`);
        }
        const recordId = String(row.record_id || "");
        if (!recordId) throw new Error(`SN record id missing: ${sn}`);
        journal.push({ kind: "restore", sourceType: "bitable", recordId, fields: { [fields.inStock]: textValue(previousStatus) } });
        await updateBitableRecord(env, source.token, tableId, recordId, { [fields.inStock]: status });
        continue;
      }

      if (status !== "否") throw new Error(`SN not found in inventory: ${sn}`);
      const emptyRow = emptyRows.shift();
      if (emptyRow) {
        const recordId = String(emptyRow.record_id || "");
        if (!recordId) throw new Error(`SN record id missing: ${sn}`);
        journal.push({
          kind: "restore",
          sourceType: "bitable",
          recordId,
          fields: {
            [fields.sn]: textValue((emptyRow.fields || {})[fields.sn]),
            [fields.inStock]: textValue((emptyRow.fields || {})[fields.inStock])
          }
        });
        await updateBitableRecord(env, source.token, tableId, recordId, {
          [fields.sn]: sn,
          [fields.inStock]: status
        });
      } else {
        const entry = { kind: "clear-created", sourceType: "bitable", sn };
        journal.push(entry);
        const result = await createBitableRecord(env, source.token, tableId, {
          [fields.code]: item.code || "",
          [fields.sn]: sn,
          [fields.inStock]: status,
          [fields.parent]: [parentRecordId]
        });
        entry.recordId = String(result.data?.record?.record_id || "");
      }
    }
    return journal;
  } catch (error) {
    error.snJournal = journal;
    throw error;
  }
}

async function updateSnStatus(env, item, snLines, status, fields) {
  return sourceIsSheet(env, item)
    ? updateSheetSnStatus(env, item, snLines, status, fields)
    : updateBitableSnStatus(env, item, snLines, status, fields);
}

async function rollbackMovementSnStatus(env, item, fields, journal = []) {
  if (!Array.isArray(journal) || journal.length === 0) return;
  const source = await getDataSource(env);
  const tableId = env.FEISHU_ITEMS_TABLE_ID || source.tableId;
  const rollbackErrors = [];
  let freshItem = null;
  if (journal.some((entry) => entry.kind === "clear-created" && !entry.recordId)) {
    const freshItems = await getItems(env);
    freshItem = freshItems.find((entry) => entry.recordId === item.recordId)
      || freshItems.find((entry) => itemMatchesCode(entry, item.code));
  }

  for (const entry of [...journal].reverse()) {
    try {
      if (entry.kind === "restore") {
        if (entry.sourceType === "sheet") {
          const headers = item.meta?.headers || [];
          await updateSheetCells(env, source, headers, entry.rowNumber, entry.fields);
        } else {
          await updateBitableRecord(env, source.token, tableId, entry.recordId, entry.fields);
        }
        continue;
      }

      if (entry.kind !== "clear-created") continue;
      if (entry.sourceType === "bitable" && entry.recordId) {
        await updateBitableRecord(env, source.token, tableId, entry.recordId, {
          [fields.code]: "",
          [fields.sn]: "",
          [fields.inStock]: "否"
        });
        continue;
      }

      if (!freshItem) {
        const freshItems = await getItems(env);
        freshItem = freshItems.find((candidate) => candidate.recordId === item.recordId)
          || freshItems.find((candidate) => itemMatchesCode(candidate, item.code));
      }
      const rows = snCandidateRows(freshItem || item, fields.sn).filter((row) =>
        splitSnLines(textValue((row.fields || {})[fields.sn])).some((sn) => sameSnLine(sn, entry.sn))
      );
      for (const row of rows) {
        if (entry.sourceType === "sheet") {
          await updateSheetCells(env, source, item.meta?.headers || [], row.meta?.rowNumber, {
            [fields.name]: "",
            [fields.code]: "",
            [fields.sn]: "",
            [fields.inStock]: ""
          });
        } else {
          await updateBitableRecord(env, source.token, tableId, row.record_id, {
            [fields.code]: "",
            [fields.sn]: "",
            [fields.inStock]: "否"
          });
        }
      }
    } catch (error) {
      rollbackErrors.push(error.message || "unknown error");
    }
  }

  if (rollbackErrors.length > 0) throw new Error(rollbackErrors.join("；"));
}

async function updateGroupedSn(env, item, desiredSn, fields) {
  const source = await getDataSource(env);
  if (source.type === "sheet") {
    return updateSheetGroupedSn(env, item, desiredSn, fields);
  }

  const tableId = env.FEISHU_ITEMS_TABLE_ID || source.tableId;
  const parentRecordId = item.meta?.primaryRecordId || item.recordId;
  const rowsWithSn = snCandidateRows(item, fields.sn).map((row) => ({
    row,
    sn: splitSnLines(textValue((row.fields || {})[fields.sn]))
  }));
  if (rowsWithSn.some((entry) => entry.sn.length > 1)) {
    const existing = rowsWithSn.flatMap((entry) => entry.sn);
    if (sameSnCollection(existing, desiredSn)) {
      return { sn: desiredSn, availableSn: availableSnLines(item) };
    }
    throw new Error("请先将一行多个 SN 拆分为每行一个，再通过网页维护 SN");
  }

  const desiredKeys = new Set(desiredSn.map(normalizeSnLine));
  const removedUsed = rowsWithSn
    .flatMap((entry) => entry.sn.map((sn) => ({ sn, row: entry.row })))
    .find((entry) => !desiredKeys.has(normalizeSnLine(entry.sn)) && !isInStockValue(textValue((entry.row.fields || {})[fields.inStock])));
  if (removedUsed) throw new Error(`SN 已出库，不能从网页删除：${removedUsed.sn}`);

  const remaining = [...rowsWithSn];
  const retained = new Map();
  for (const sn of desiredSn) {
    const matchIndex = remaining.findIndex((entry) => sameSnLine(entry.sn[0], sn));
    if (matchIndex >= 0) {
      const [match] = remaining.splice(matchIndex, 1);
      retained.set(normalizeSnLine(sn), isInStockValue(textValue((match.row.fields || {})[fields.inStock])));
      continue;
    }
    const reusableIndex = remaining.findIndex((entry) => entry.sn.length === 0 || isInStockValue(textValue((entry.row.fields || {})[fields.inStock])));
    const reusableRow = reusableIndex >= 0 ? remaining.splice(reusableIndex, 1)[0] : null;
    if (reusableRow) {
      await updateBitableRecord(env, source.token, tableId, reusableRow.row.record_id, {
        [fields.sn]: sn,
        [fields.inStock]: "否"
      });
    } else {
      if (!parentRecordId) throw new Error("parent record not found; cannot create SN rows");
      await createBitableRecord(env, source.token, tableId, {
        [fields.code]: item.code || "",
        [fields.sn]: sn,
        [fields.inStock]: "否",
        [fields.parent]: [parentRecordId]
      });
    }
    retained.set(normalizeSnLine(sn), true);
  }

  for (const entry of remaining) {
    if (entry.sn.length === 0) continue;
    await updateBitableRecord(env, source.token, tableId, entry.row.record_id, {
      [fields.sn]: "",
      [fields.inStock]: "否"
    });
  }
  return {
    sn: desiredSn,
    availableSn: desiredSn.filter((sn) => retained.get(normalizeSnLine(sn)) !== false)
  };
}

async function updateSheetGroupedSn(env, item, desiredSn, fields) {
  const source = await getDataSource(env);
  const rowsWithSn = snCandidateRows(item, fields.sn).map((row) => ({
    row,
    sn: splitSnLines(textValue((row.fields || {})[fields.sn]))
  }));
  if (rowsWithSn.some((entry) => entry.sn.length > 1)) {
    const existing = rowsWithSn.flatMap((entry) => entry.sn);
    if (sameSnCollection(existing, desiredSn)) {
      return { sn: desiredSn, availableSn: availableSnLines(item) };
    }
    throw new Error("请先将一行多个 SN 拆分为每行一个，再通过网页维护 SN");
  }

  const desiredKeys = new Set(desiredSn.map(normalizeSnLine));
  const removedUsed = rowsWithSn
    .flatMap((entry) => entry.sn.map((sn) => ({ sn, row: entry.row })))
    .find((entry) => !desiredKeys.has(normalizeSnLine(entry.sn)) && !isInStockValue(textValue((entry.row.fields || {})[fields.inStock])));
  if (removedUsed) throw new Error(`SN 已出库，不能从网页删除：${removedUsed.sn}`);

  const headers = item.meta?.headers || [];
  const remaining = [...rowsWithSn];
  const retained = new Map();
  for (const sn of desiredSn) {
    const matchIndex = remaining.findIndex((entry) => sameSnLine(entry.sn[0], sn));
    if (matchIndex >= 0) {
      const [match] = remaining.splice(matchIndex, 1);
      retained.set(normalizeSnLine(sn), isInStockValue(textValue((match.row.fields || {})[fields.inStock])));
      continue;
    }

    const reusableIndex = remaining.findIndex((entry) => entry.sn.length === 0 || isInStockValue(textValue((entry.row.fields || {})[fields.inStock])));
    const reusableRow = reusableIndex >= 0 ? remaining.splice(reusableIndex, 1)[0] : null;
    if (reusableRow) {
      await updateSheetCells(env, source, headers, reusableRow.row.meta.rowNumber, {
        [fields.sn]: sn,
        [fields.inStock]: "否"
      });
    } else {
      await appendSheetSnRow(env, source, item, sn, fields);
    }
    retained.set(normalizeSnLine(sn), true);
  }

  for (const entry of remaining) {
    if (entry.sn.length === 0) continue;
    await updateSheetCells(env, source, headers, entry.row.meta.rowNumber, {
      [fields.sn]: "",
      [fields.inStock]: "否"
    });
  }
  return {
    sn: desiredSn,
    availableSn: desiredSn.filter((sn) => retained.get(normalizeSnLine(sn)) !== false)
  };
}

function snCandidateRows(item, snField) {
  const rows = item.meta?.sourceRows || [];
  const primaryId = String(item.meta?.primaryRecordId || "");
  const primaryRowNumber = String(item.meta?.primaryRowNumber || "");
  const childRows = rows.filter((row) => {
    const rowId = String(row.record_id || "");
    const rowNumber = String(row.meta?.rowNumber || "");
    return !(primaryId && rowId === primaryId) && !(primaryRowNumber && rowNumber === primaryRowNumber);
  });
  const primaryRowsWithSn = rows.filter((row) => {
    const rowId = String(row.record_id || "");
    const rowNumber = String(row.meta?.rowNumber || "");
    const isPrimary = (primaryId && rowId === primaryId) || (primaryRowNumber && rowNumber === primaryRowNumber);
    return isPrimary && splitSnLines(textValue((row.fields || {})[snField])).length > 0;
  });
  return [...childRows, ...primaryRowsWithSn];
}

function sameSnCollection(current, desired) {
  const currentKeys = current.map(normalizeSnLine);
  const desiredKeys = desired.map(normalizeSnLine);
  return currentKeys.length === desiredKeys.length
    && new Set(currentKeys).size === currentKeys.length
    && new Set(desiredKeys).size === desiredKeys.length
    && currentKeys.every((key) => desiredKeys.includes(key));
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
    parent: env.FIELD_PARENT || "父记录",
    stock: env.FIELD_STOCK || "现有库存数量",
    sn: env.FIELD_SN || "SN码",
    inStock: env.FIELD_IN_STOCK || "是否被使用",
    inQuantity: env.FIELD_IN_QTY || "入库数量",
    outQuantity: env.FIELD_OUT_QTY || "出库数量",
    owner: env.FIELD_OWNER || "负责人",
    qr: env.FIELD_QR || "二维码链接",
    note: env.FIELD_NOTE || "备注",
    recordCode: env.FIELD_RECORD_CODE || env.FIELD_CODE || "货物编号",
    recordName: env.FIELD_RECORD_NAME || env.FIELD_NAME || "货品",
    recordType: env.FIELD_RECORD_TYPE || "类型",
    recordQuantity: env.FIELD_RECORD_QTY || "数量",
    recordSn: env.FIELD_RECORD_SN || "SN码",
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






