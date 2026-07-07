const DEMO_ITEMS = [
  { recordId: "demo-1", code: "WZ-0001", name: "电源适配器 12V", sn: "SN-DEMO-001（日常使用）", stock: 36, unit: "个", category: "电子", owner: "张三", note: "常用备件" },
  { recordId: "demo-2", code: "WZ-0002", name: "网线 2m", sn: "SN-DEMO-002", stock: 120, unit: "根", category: "耗材", owner: "李四", note: "蓝色" },
  { recordId: "demo-3", code: "WZ-0003", name: "开发板", sn: "SN-DEMO-003（测试台架）", stock: 18, unit: "块", category: "设备", owner: "王五", note: "研发借用" },
  { recordId: "demo-4", code: "WZ-0004", name: "M3 螺丝包", sn: "", stock: 240, unit: "包", category: "五金", owner: "", note: "每包 100 颗" }
];

const DEMO_RECORDS = [
  { code: "WZ-0001", name: "电源适配器 12V", type: "outbound", quantity: 2, reason: "项目使用", detail: "A 项目设备维护", operator: "张三", time: new Date().toISOString() },
  { code: "WZ-0002", name: "网线 2m", type: "inbound", quantity: 30, reason: "", detail: "补充库存", operator: "李四", time: new Date().toISOString() },
  { code: "WZ-0003", name: "开发板", type: "outbound", quantity: 1, reason: "借用", detail: "测试台架", operator: "王五", time: new Date().toISOString() }
];

const CLOUDFLARE_API_BASE = "https://warehouse-api.hoanglinh4586359.workers.dev";
const CLOUDFLARE_FRONTEND_HOST = "scnu-vanguard.github.io";

function defaultApiBase() {
  const host = window.location.hostname;
  if (host === CLOUDFLARE_FRONTEND_HOST) return CLOUDFLARE_API_BASE;
  if (host.endsWith(".github.io") || host === "localhost" || host === "127.0.0.1" || window.location.protocol === "file:") return "";
  return window.location.origin;
}

const state = {
  items: [],
  records: [],
  selectedKey: null,
  selectedSn: [],
  pendingLink: null,
  stream: null,
  scanTimer: null,
  apiBase: defaultApiBase()
};

const $ = (id) => document.getElementById(id);

const els = {
  metricItems: $("metricItems"),
  metricStock: $("metricStock"),
  metricInbound: $("metricInbound"),
  metricOutbound: $("metricOutbound"),
  itemList: $("itemList"),
  searchInput: $("searchInput"),
  refreshButton: $("refreshButton"),
  scanButton: $("scanButton"),
  scannerPanel: $("scannerPanel"),
  scannerVideo: $("scannerVideo"),
  scannerStatus: $("scannerStatus"),
  manualCodeInput: $("manualCodeInput"),
  manualCodeButton: $("manualCodeButton"),
  stopScanButton: $("stopScanButton"),
  emptyDetail: $("emptyDetail"),
  itemDetail: $("itemDetail"),
  detailCode: $("detailCode"),
  detailName: $("detailName"),
  detailStock: $("detailStock"),
  detailUnit: $("detailUnit"),
  detailCategory: $("detailCategory"),
  detailOwner: $("detailOwner"),
  detailNote: $("detailNote"),
  detailSn: $("detailSn"),
  detailSnCount: $("detailSnCount"),
  editItemButton: $("editItemButton"),
  itemEditDialog: $("itemEditDialog"),
  itemEditForm: $("itemEditForm"),
  editCodeInput: $("editCodeInput"),
  editNameInput: $("editNameInput"),
  editSnInput: $("editSnInput"),
  editUnitInput: $("editUnitInput"),
  editCategoryInput: $("editCategoryInput"),
  editOwnerInput: $("editOwnerInput"),
  editNoteInput: $("editNoteInput"),
  editItemStatus: $("editItemStatus"),
  closeEditDialogButton: $("closeEditDialogButton"),
  cancelEditDialogButton: $("cancelEditDialogButton"),
  qrButton: $("qrButton"),
  qrDialog: $("qrDialog"),
  printQrButton: $("printQrButton"),
  qrLabelSheet: $("qrLabelSheet"),
  movementSnField: $("movementSnField"),
  movementSnInput: $("movementSnInput"),
  inboundTab: $("inboundTab"),
  outboundTab: $("outboundTab"),
  movementType: $("movementType"),
  movementForm: $("movementForm"),
  quantityInput: $("quantityInput"),
  reasonField: $("reasonField"),
  reasonInput: $("reasonInput"),
  detailInput: $("detailInput"),
  operatorInput: $("operatorInput"),
  formStatus: $("formStatus"),
  stockChart: $("stockChart"),
  recordList: $("recordList"),
  dataModeLabel: $("dataModeLabel")
};

function apiUrl(path) {
  return `${state.apiBase.replace(/\/$/, "")}${path}`;
}

async function requestJson(path, options = {}) {
  if (!state.apiBase) {
    throw new Error("API base is not configured");
  }
  const response = await fetch(apiUrl(path), {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
}

async function loadData() {
  setStatus("正在加载数据...");
  if (!state.apiBase) {
    state.items = structuredClone(DEMO_ITEMS);
    state.records = structuredClone(DEMO_RECORDS);
    els.dataModeLabel.textContent = "演示数据";
    applyPendingLink();
    renderAll();
    setStatus("");
    return;
  }

  try {
    const [itemsData, recordsData] = await Promise.all([
      requestJson("/api/items"),
      requestJson("/api/records").catch(() => ({ records: [] }))
    ]);
    state.items = itemsData.items || [];
    state.records = recordsData.records || [];
    els.dataModeLabel.textContent = "飞书数据";
    applyPendingLink();
    renderAll();
    setStatus("");
  } catch (error) {
    state.items = structuredClone(DEMO_ITEMS);
    state.records = structuredClone(DEMO_RECORDS);
    els.dataModeLabel.textContent = "接口失败，显示演示数据";
    renderAll();
    setStatus(error.message, true);
  }
}

function renderAll() {
  renderMetrics();
  renderItems();
  renderDetail();
  renderRecords();
  renderChart();
}

function renderMetrics() {
  const today = new Date().toDateString();
  const todayRecords = state.records.filter((record) => new Date(record.time).toDateString() === today);
  els.metricItems.textContent = state.items.length;
  els.metricStock.textContent = state.items.reduce((sum, item) => sum + Number(item.stock || 0), 0);
  els.metricInbound.textContent = todayRecords
    .filter((record) => record.type === "inbound")
    .reduce((sum, record) => sum + Number(record.quantity || 0), 0);
  els.metricOutbound.textContent = todayRecords
    .filter((record) => record.type === "outbound")
    .reduce((sum, record) => sum + Number(record.quantity || 0), 0);
}

function renderItems() {
  const query = els.searchInput.value.trim().toLowerCase();
  const template = $("itemTemplate");
  els.itemList.replaceChildren();

  state.items
    .filter((item) => {
      const haystack = `${item.code} ${item.name} ${item.sn || ""} ${item.owner || ""} ${item.category || ""} ${item.note || ""}`.toLowerCase();
      return haystack.includes(query);
    })
    .forEach((item) => {
      const node = template.content.firstElementChild.cloneNode(true);
      node.dataset.key = itemKey(item);
      node.classList.toggle("active", isSelectedItem(item));
      node.querySelector(".itemName").textContent = item.name;
      node.querySelector(".itemCode").textContent = item.code || "未设置货物编号";
      node.querySelector(".itemQty").textContent = `${item.stock}${item.unit || ""}`;
      node.addEventListener("click", () => selectItem(item));
      els.itemList.appendChild(node);
    });
}

function renderDetail() {
  const item = getSelectedItem();
  els.emptyDetail.classList.toggle("hidden", Boolean(item));
  els.itemDetail.classList.toggle("hidden", !item);
  if (!item) return;

  els.detailCode.textContent = item.code;
  els.detailName.textContent = item.name;
  els.detailStock.textContent = item.stock;
  els.detailUnit.textContent = item.unit || "-";
  els.detailCategory.textContent = item.category || "-";
  els.detailOwner.textContent = item.owner || "-";
  els.detailNote.textContent = item.note || "-";
  renderSnList(item);
}

function renderSnList(item) {
  const snLines = splitLines(item.sn);
  els.detailSnCount.textContent = `${snLines.length} 条`;
  els.detailSn.replaceChildren();
  if (snLines.length === 0) {
    els.detailSn.textContent = "-";
    return;
  }

  snLines.forEach((sn) => {
    const button = document.createElement("button");
    button.className = "snChoice";
    button.type = "button";
    button.textContent = sn;
    button.classList.toggle("active", state.selectedSn.includes(sn));
    button.addEventListener("click", () => toggleSnSelection(sn));
    els.detailSn.appendChild(button);
  });
}

function toggleSnSelection(sn) {
  if (state.selectedSn.includes(sn)) {
    state.selectedSn = state.selectedSn.filter((entry) => entry !== sn);
  } else {
    state.selectedSn = [...state.selectedSn, sn];
  }
  els.movementSnInput.value = state.selectedSn.join("\n");
  renderDetail();
}

function renderRecords() {
  els.recordList.replaceChildren();
  state.records.slice(0, 50).forEach((record) => {
    const row = document.createElement("div");
    row.className = "recordRow";
    const type = document.createElement("span");
    type.className = `recordType ${record.type}`;
    type.textContent = record.type === "inbound" ? "入库" : "出库";

    const text = document.createElement("span");
    text.className = "recordText";
    const title = document.createElement("strong");
    title.textContent = `${record.name || record.code} · ${record.operator || "未填写"}`;
    const small = document.createElement("small");
    const snText = record.sn ? `SN：${record.sn}` : "";
    small.textContent = [formatTime(record.time), record.reason, snText, record.detail].filter(Boolean).join(" / ");
    text.append(title, small);

    const qty = document.createElement("strong");
    qty.className = "recordQty";
    qty.textContent = `${record.type === "inbound" ? "+" : "-"}${record.quantity}`;
    row.append(type, text, qty);
    els.recordList.appendChild(row);
  });
}

function renderChart() {
  const canvas = els.stockChart;
  const ctx = canvas.getContext("2d");
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(320, Math.floor(rect.width * ratio));
  canvas.height = Math.floor(260 * ratio);
  ctx.scale(ratio, ratio);

  const width = rect.width;
  const height = 260;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#0b0b0d";
  ctx.fillRect(0, 0, width, height);

  const items = [...state.items].sort((a, b) => Number(b.stock || 0) - Number(a.stock || 0)).slice(0, 8);
  const max = Math.max(1, ...items.map((item) => Number(item.stock || 0)));
  const barGap = 10;
  const left = 96;
  const top = 22;
  const barHeight = Math.max(18, (height - top - 24 - barGap * items.length) / Math.max(items.length, 1));

  ctx.font = "12px system-ui";
  ctx.textBaseline = "middle";

  items.forEach((item, index) => {
    const y = top + index * (barHeight + barGap);
    const barWidth = (width - left - 48) * (Number(item.stock || 0) / max);
    ctx.fillStyle = "#95a0ae";
    ctx.fillText(item.name.slice(0, 8), 10, y + barHeight / 2);
    ctx.fillStyle = "#24262d";
    ctx.fillRect(left, y, width - left - 48, barHeight);
    ctx.fillStyle = index % 2 === 0 ? "#2997ff" : "#64d2ff";
    ctx.fillRect(left, y, barWidth, barHeight);
    ctx.fillStyle = "#eef2f8";
    ctx.fillText(String(item.stock), left + barWidth + 8, y + barHeight / 2);
  });
}

function selectItem(itemOrCode) {
  const item = typeof itemOrCode === "object"
    ? itemOrCode
    : state.items.find((entry) => entry.code === itemOrCode);
  if (!item) {
    setStatus(`未找到物资：${itemOrCode}`, true);
    return;
  }
  state.selectedKey = itemKey(item);
  state.selectedSn = [];
  const url = new URL(window.location.href);
  url.searchParams.delete("code");
  url.searchParams.delete("rid");
  if (item.code) url.searchParams.set("code", item.code);
  else if (item.recordId) url.searchParams.set("rid", item.recordId);
  history.replaceState(null, "", url);
  renderItems();
  renderDetail();
}

function getSelectedItem() {
  if (!state.selectedKey) return null;
  if (state.selectedKey.startsWith("code:")) {
    const code = state.selectedKey.slice("code:".length);
    if (!code) return null;
    return state.items.find((item) => item.code === code) || null;
  }
  return state.items.find((item) => itemKey(item) === state.selectedKey) || null;
}

function itemKey(item) {
  return item.recordId || `code:${item.code}`;
}

function isSelectedItem(item) {
  if (!state.selectedKey) return false;
  if (state.selectedKey.startsWith("code:")) {
    const code = state.selectedKey.slice("code:".length);
    return Boolean(code) && item.code === code;
  }
  return itemKey(item) === state.selectedKey;
}

function splitLines(value) {
  return String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function normalizeSnLine(value) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

function findDuplicateSn(snLines, existingLines = []) {
  const seen = new Set(existingLines.map(normalizeSnLine).filter(Boolean));
  const requestSeen = new Set();
  for (const sn of snLines) {
    const key = normalizeSnLine(sn);
    if (!key) continue;
    if (seen.has(key) || requestSeen.has(key)) return sn;
    requestSeen.add(key);
  }
  return "";
}

function setMovementType(type) {
  els.movementType.value = type;
  els.inboundTab.classList.toggle("active", type === "inbound");
  els.outboundTab.classList.toggle("active", type === "outbound");
  els.reasonField.classList.toggle("hidden", type !== "outbound");
  els.reasonInput.required = type === "outbound";
  els.detailInput.required = type === "outbound";
  els.movementSnInput.placeholder = type === "outbound" ? "填写本次出库的SN，一行一个" : "填写本次入库新增的SN，一行一个";
  if (type === "inbound") {
    state.selectedSn = [];
    els.movementSnInput.value = "";
    renderDetail();
  }
  els.formStatus.textContent = "";
  els.formStatus.className = "formStatus";
}

async function submitMovement(event) {
  event.preventDefault();
  const item = getSelectedItem();
  if (!item) return;

  const type = els.movementType.value;
  const quantity = Number(els.quantityInput.value);
  const snLines = splitLines(els.movementSnInput.value);
  const payload = {
    code: item.code,
    recordId: item.recordId,
    quantity,
    sn: snLines,
    reason: els.reasonInput.value.trim(),
    detail: els.detailInput.value.trim(),
    operator: els.operatorInput.value.trim()
  };

  if (!Number.isInteger(quantity) || quantity <= 0) {
    setFormStatus("数量必须是正整数", true);
    return;
  }
  if (type === "outbound" && quantity > Number(item.stock || 0)) {
    setFormStatus("出库数量不能超过当前库存", true);
    return;
  }
  if (type === "outbound" && (!payload.reason || !payload.detail)) {
    setFormStatus("出库原因和具体信息必须填写", true);
    return;
  }
  const itemSnLines = splitLines(item.sn);
  if (type === "outbound" && itemSnLines.length > 0 && snLines.length !== quantity) {
    setFormStatus(`该物资有SN码，请填写 ${quantity} 个本次出库SN`, true);
    return;
  }
  if (type === "inbound" && snLines.length > 0 && snLines.length !== quantity) {
    setFormStatus(`填写了SN码时，SN数量需要等于入库数量：${quantity} 个`, true);
    return;
  }
  const duplicateSn = type === "inbound" ? findDuplicateSn(snLines, itemSnLines) : findDuplicateSn(snLines);
  if (duplicateSn) {
    setFormStatus(type === "inbound" ? `该SN已在库存中，不能重复入库：${duplicateSn}` : `本次出库SN重复：${duplicateSn}`, true);
    return;
  }

  setFormStatus("正在提交...");
  try {
    let submitWarning = "";
    if (state.apiBase) {
      const result = await requestJson(type === "inbound" ? "/api/inbound" : "/api/outbound", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      await loadData();
      selectItem(item.recordId ? state.items.find((entry) => entry.recordId === item.recordId) || item.code : item.code);
      submitWarning = result.warning || "";
    } else {
      applyDemoMovement(type, payload);
      renderAll();
    }
    els.movementForm.reset();
    state.selectedSn = [];
    els.movementType.value = type;
    setMovementType(type);
    setFormStatus(submitWarning || "已提交", Boolean(submitWarning));
  } catch (error) {
    setFormStatus(error.message, true);
  }
}

function applyDemoMovement(type, payload) {
  const item = getSelectedItem();
  const delta = type === "inbound" ? payload.quantity : -payload.quantity;
  item.stock = Number(item.stock || 0) + delta;
  state.records.unshift({
    code: item.code,
    name: item.name,
    type,
    quantity: payload.quantity,
    reason: payload.reason,
    detail: payload.detail,
    operator: payload.operator,
    time: new Date().toISOString()
  });
}

async function startScanner() {
  els.scannerPanel.classList.remove("hidden");
  if (!("BarcodeDetector" in window)) {
    els.scannerStatus.textContent = "当前浏览器不支持摄像头扫码，请手动输入编号。";
    return;
  }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    els.scannerVideo.srcObject = state.stream;
    await els.scannerVideo.play();
    const detector = new BarcodeDetector({ formats: ["qr_code", "code_128", "ean_13"] });
    els.scannerStatus.textContent = "正在识别...";
    scanLoop(detector);
  } catch (error) {
    els.scannerStatus.textContent = `无法打开摄像头：${error.message}`;
  }
}

async function scanLoop(detector) {
  if (!state.stream) return;
  try {
    const codes = await detector.detect(els.scannerVideo);
    if (codes.length > 0) {
      const code = extractItemCode(codes[0].rawValue);
      stopScanner();
      openCode(code);
      return;
    }
  } catch (error) {
    els.scannerStatus.textContent = error.message;
  }
  state.scanTimer = requestAnimationFrame(() => scanLoop(detector));
}

function stopScanner() {
  if (state.scanTimer) cancelAnimationFrame(state.scanTimer);
  state.scanTimer = null;
  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
  }
  state.stream = null;
  els.scannerVideo.srcObject = null;
  els.scannerPanel.classList.add("hidden");
}

function openCode(raw) {
  const link = parseQrPayload(raw);
  if (!link.code && !link.recordId && link.snLines.length === 0) return;
  if (!applyDeepLink(link, true)) {
    state.pendingLink = link;
  }
}

function extractItemCode(raw) {
  return parseQrPayload(raw).code;
}

function parseQrPayload(raw) {
  const value = String(raw || "").trim();
  const empty = { code: "", recordId: "", snLines: [], type: "" };
  if (!value) return empty;
  try {
    const url = new URL(value);
    const type = String(url.searchParams.get("type") || url.searchParams.get("mode") || url.searchParams.get("action") || "").trim();
    return {
      code: String(url.searchParams.get("code") || url.searchParams.get("item") || "").trim(),
      recordId: String(url.searchParams.get("rid") || url.searchParams.get("recordId") || "").trim(),
      snLines: splitLines(url.searchParams.get("sn") || url.searchParams.get("serial") || ""),
      type: normalizeMovementType(type)
    };
  } catch {
    return { ...empty, code: value };
  }
}

function normalizeMovementType(value) {
  if (value === "out" || value === "outbound" || value === "出库") return "outbound";
  if (value === "in" || value === "inbound" || value === "入库") return "inbound";
  return "";
}

function applyPendingLink() {
  if (!state.pendingLink) return;
  if (applyDeepLink(state.pendingLink, false)) {
    state.pendingLink = null;
  }
}

function applyDeepLink(link, updateUrl) {
  const item = findDeepLinkItem(link);
  if (!item) {
    setStatus("未找到二维码对应物资", true);
    return false;
  }

  state.selectedKey = itemKey(item);
  state.selectedSn = matchSnLines(item, link.snLines);
  if (updateUrl) updateItemUrl(item, link);
  if (link.type) setMovementType(link.type);
  if (state.selectedSn.length > 0) {
    els.movementSnInput.value = state.selectedSn.join("\n");
    els.quantityInput.value = state.selectedSn.length;
    if (!link.type) setMovementType("outbound");
  }
  renderItems();
  renderDetail();
  return true;
}

function findDeepLinkItem(link) {
  if (link.recordId) {
    const byRecordId = state.items.find((item) => item.recordId === link.recordId);
    if (byRecordId) return byRecordId;
  }
  if (link.code) {
    const byCode = state.items.find((item) => item.code === link.code);
    if (byCode) return byCode;
  }
  if (link.snLines.length > 0) {
    return state.items.find((item) => matchSnLines(item, link.snLines).length > 0) || null;
  }
  return null;
}

function matchSnLines(item, wantedLines) {
  const available = splitLines(item.sn);
  return wantedLines
    .map((wanted) => available.find((line) => normalizeSnLine(line) === normalizeSnLine(wanted)) || wanted)
    .filter(Boolean);
}

function updateItemUrl(item, link = {}) {
  const url = new URL(window.location.href);
  url.searchParams.delete("code");
  url.searchParams.delete("rid");
  url.searchParams.delete("sn");
  url.searchParams.delete("type");
  url.searchParams.delete("mode");
  url.searchParams.delete("action");
  if (item.code) url.searchParams.set("code", item.code);
  else if (item.recordId) url.searchParams.set("rid", item.recordId);
  if (link.snLines?.length) url.searchParams.set("sn", link.snLines.join("\n"));
  if (link.type) url.searchParams.set("type", link.type);
  history.replaceState(null, "", url);
}

function appBaseUrl() {
  return `${window.location.origin}${window.location.pathname}`;
}

function itemQrUrl(item) {
  const url = new URL(appBaseUrl());
  if (item.code) url.searchParams.set("code", item.code);
  else if (item.recordId) url.searchParams.set("rid", item.recordId);
  return url.toString();
}

function snQrUrl(item, sn) {
  const url = new URL(itemQrUrl(item));
  url.searchParams.set("sn", sn);
  url.searchParams.set("type", "outbound");
  return url.toString();
}

function formatLabelNumber(value) {
  return Number.isFinite(Number(value)) ? String(Number(value)) : "0";
}

function qrLabelLines(item, sn = "") {
  return [
    `编号：${item.code || "未设置"}`,
    sn ? `SN：${sn}` : "SN：-",
    `库存：${formatLabelNumber(item.stock)}${item.unit ? ` ${item.unit}` : ""}`,
    `负责人：${item.owner || "-"}`,
    `分类：${item.category || "-"}`,
    `备注：${item.note || "-"}`
  ];
}

function renderQrLabels() {
  const item = getSelectedItem();
  els.qrLabelSheet.replaceChildren();
  if (!item) return;

  const snLines = splitLines(item.sn);
  const labels = snLines.length
    ? snLines.map((sn) => ({
        kind: "SN物资码",
        title: item.name || "未命名物资",
        lines: qrLabelLines(item, sn),
        value: snQrUrl(item, sn)
      }))
    : [{
        kind: "物资码",
        title: item.name || "未命名物资",
        lines: qrLabelLines(item),
        value: itemQrUrl(item)
      }];

  labels.forEach((label) => els.qrLabelSheet.appendChild(createQrLabel(label)));
}

function createQrLabel(label) {
  const node = document.createElement("article");
  node.className = "qrLabel";

  const qrBox = document.createElement("div");
  qrBox.className = "qrCode";
  qrBox.innerHTML = qrSvg(label.value);

  const text = document.createElement("div");
  text.className = "qrLabelText";
  const kind = document.createElement("span");
  kind.textContent = label.kind;
  const title = document.createElement("strong");
  title.textContent = label.title;
  const details = document.createElement("small");
  details.textContent = label.lines.join("\n");
  text.append(kind, title, details);

  node.append(qrBox, text);
  return node;
}

function qrSvg(value) {
  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();
  return qr.createSvgTag(3, 2);
}

function openQrDialog() {
  renderQrLabels();
  els.qrDialog.showModal();
}

function printQrLabels() {
  renderQrLabels();
  window.print();
}

function setStatus(message, isError = false) {
  els.dataModeLabel.textContent = message || (state.apiBase ? "飞书数据" : "演示数据");
  els.dataModeLabel.style.color = isError ? "#d14343" : "";
}

function setFormStatus(message, isError = false) {
  els.formStatus.textContent = message;
  els.formStatus.className = `formStatus ${isError ? "error" : "ok"}`;
}

function setEditStatus(message, isError = false) {
  els.editItemStatus.textContent = message;
  els.editItemStatus.className = `formStatus ${isError ? "error" : "ok"}`;
}

function openEditDialog() {
  const item = getSelectedItem();
  if (!item) return;
  els.editCodeInput.value = item.code || "";
  els.editNameInput.value = item.name || "";
  els.editSnInput.value = item.sn || "";
  els.editUnitInput.value = item.unit || "";
  els.editCategoryInput.value = item.category || "";
  els.editOwnerInput.value = item.owner || "";
  els.editNoteInput.value = item.note || "";
  setEditStatus("");
  els.itemEditDialog.showModal();
}

async function submitItemEdit(event) {
  event.preventDefault();
  const item = getSelectedItem();
  if (!item) return;

  const snLines = splitLines(els.editSnInput.value);
  const duplicateSn = findDuplicateSn(snLines);
  if (duplicateSn) {
    setEditStatus(`SN重复：${duplicateSn}`, true);
    return;
  }

  const payload = {
    code: item.code,
    recordId: item.recordId,
    nextCode: els.editCodeInput.value.trim(),
    name: els.editNameInput.value.trim(),
    sn: snLines,
    unit: els.editUnitInput.value.trim(),
    category: els.editCategoryInput.value.trim(),
    owner: els.editOwnerInput.value.trim(),
    note: els.editNoteInput.value.trim()
  };

  if (!payload.nextCode && !payload.name) {
    setEditStatus("货物编号和货品至少保留一个", true);
    return;
  }

  setEditStatus("正在保存...");
  try {
    if (state.apiBase) {
      await requestJson("/api/items/update", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      await loadData();
      const updated = payload.recordId
        ? state.items.find((entry) => entry.recordId === payload.recordId)
        : state.items.find((entry) => entry.code === payload.nextCode);
      if (updated) selectItem(updated);
    } else {
      Object.assign(item, {
        code: payload.nextCode,
        name: payload.name,
        sn: snLines.join("\n"),
        unit: payload.unit,
        category: payload.category,
        owner: payload.owner,
        note: payload.note
      });
      renderAll();
      selectItem(item);
    }
    els.itemEditDialog.close();
    setStatus("物资信息已保存");
  } catch (error) {
    setEditStatus(error.message || "保存失败", true);
  }
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function initFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const link = parseQrPayload(window.location.href);
  if (link.recordId) state.selectedKey = link.recordId;
  else if (link.code) state.selectedKey = `code:${link.code}`;
  if (link.snLines.length > 0 || link.type) state.pendingLink = link;
  else if (!link.code && !link.recordId && (params.has("code") || params.has("item") || params.has("rid"))) {
    params.delete("code");
    params.delete("item");
    params.delete("rid");
    const url = new URL(window.location.href);
    url.search = params.toString();
    history.replaceState(null, "", url);
  }
}

function bindEvents() {
  els.refreshButton.addEventListener("click", loadData);
  els.searchInput.addEventListener("input", renderItems);
  els.editItemButton.addEventListener("click", openEditDialog);
  els.itemEditForm.addEventListener("submit", submitItemEdit);
  els.closeEditDialogButton.addEventListener("click", () => els.itemEditDialog.close());
  els.cancelEditDialogButton.addEventListener("click", () => els.itemEditDialog.close());
  els.qrButton.addEventListener("click", openQrDialog);
  els.printQrButton.addEventListener("click", printQrLabels);
  els.inboundTab.addEventListener("click", () => setMovementType("inbound"));
  els.outboundTab.addEventListener("click", () => setMovementType("outbound"));
  els.movementForm.addEventListener("submit", submitMovement);
  els.scanButton.addEventListener("click", startScanner);
  els.stopScanButton.addEventListener("click", stopScanner);
  els.manualCodeButton.addEventListener("click", () => openCode(els.manualCodeInput.value));
  els.manualCodeInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") openCode(els.manualCodeInput.value);
  });
  window.addEventListener("resize", renderChart);
}

initFromUrl();
bindEvents();
setMovementType("inbound");
loadData();



