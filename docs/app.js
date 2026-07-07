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

const DEFAULT_API_BASE = "https://warehouse-api.hoanglinh4586359.workers.dev";

const state = {
  items: [],
  records: [],
  selectedKey: null,
  stream: null,
  scanTimer: null,
  apiBase: localStorage.getItem("warehouseApiBase") || DEFAULT_API_BASE
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
  dataModeLabel: $("dataModeLabel"),
  settingsButton: $("settingsButton"),
  settingsDialog: $("settingsDialog"),
  apiBaseInput: $("apiBaseInput"),
  saveSettingsButton: $("saveSettingsButton")
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
  els.detailSn.textContent = item.sn || "-";
  els.detailSnCount.textContent = `${splitLines(item.sn).length} 条`;
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
    small.textContent = [formatTime(record.time), record.reason, record.detail].filter(Boolean).join(" / ");
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

function setMovementType(type) {
  els.movementType.value = type;
  els.inboundTab.classList.toggle("active", type === "inbound");
  els.outboundTab.classList.toggle("active", type === "outbound");
  els.reasonField.classList.toggle("hidden", type !== "outbound");
  els.reasonInput.required = type === "outbound";
  els.detailInput.required = type === "outbound";
  els.formStatus.textContent = "";
  els.formStatus.className = "formStatus";
}

async function submitMovement(event) {
  event.preventDefault();
  const item = getSelectedItem();
  if (!item) return;

  const type = els.movementType.value;
  const quantity = Number(els.quantityInput.value);
  const payload = {
    code: item.code,
    recordId: item.recordId,
    quantity,
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
  const code = extractItemCode(raw);
  if (!code) return;
  selectItem(code);
}

function extractItemCode(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.searchParams.has("code")) return String(url.searchParams.get("code") || "").trim();
    if (url.searchParams.has("item")) return String(url.searchParams.get("item") || "").trim();
    return value;
  } catch {
    return value;
  }
}

function setStatus(message, isError = false) {
  els.dataModeLabel.textContent = message || (state.apiBase ? "飞书数据" : "演示数据");
  els.dataModeLabel.style.color = isError ? "#d14343" : "";
}

function setFormStatus(message, isError = false) {
  els.formStatus.textContent = message;
  els.formStatus.className = `formStatus ${isError ? "error" : "ok"}`;
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function initFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const code = String(params.get("code") || params.get("item") || "").trim();
  const recordId = String(params.get("rid") || "").trim();
  if (recordId) state.selectedKey = recordId;
  else if (code) state.selectedKey = `code:${code}`;
  else if (params.has("code") || params.has("item") || params.has("rid")) {
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
  els.inboundTab.addEventListener("click", () => setMovementType("inbound"));
  els.outboundTab.addEventListener("click", () => setMovementType("outbound"));
  els.movementForm.addEventListener("submit", submitMovement);
  els.scanButton.addEventListener("click", startScanner);
  els.stopScanButton.addEventListener("click", stopScanner);
  els.manualCodeButton.addEventListener("click", () => openCode(els.manualCodeInput.value));
  els.manualCodeInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") openCode(els.manualCodeInput.value);
  });
  els.settingsButton.addEventListener("click", () => {
    els.apiBaseInput.value = state.apiBase;
    els.settingsDialog.showModal();
  });
  els.saveSettingsButton.addEventListener("click", () => {
    state.apiBase = els.apiBaseInput.value.trim();
    if (state.apiBase) localStorage.setItem("warehouseApiBase", state.apiBase);
    else localStorage.removeItem("warehouseApiBase");
    els.settingsDialog.close();
    loadData();
  });
  window.addEventListener("resize", renderChart);
}

initFromUrl();
bindEvents();
setMovementType("inbound");
loadData();



