const DEMO_ITEMS = [
  { code: "WZ-0001", name: "电源适配器 12V", stock: 36, unit: "个", category: "电子", note: "常用备件" },
  { code: "WZ-0002", name: "网线 2m", stock: 120, unit: "根", category: "耗材", note: "蓝色" },
  { code: "WZ-0003", name: "开发板", stock: 18, unit: "块", category: "设备", note: "研发借用" },
  { code: "WZ-0004", name: "M3 螺丝包", stock: 240, unit: "包", category: "五金", note: "每包 100 颗" }
];

const DEMO_RECORDS = [
  { code: "WZ-0001", name: "电源适配器 12V", type: "outbound", quantity: 2, reason: "项目使用", detail: "A 项目设备维护", operator: "张三", time: new Date().toISOString() },
  { code: "WZ-0002", name: "网线 2m", type: "inbound", quantity: 30, reason: "", detail: "补充库存", operator: "李四", time: new Date().toISOString() },
  { code: "WZ-0003", name: "开发板", type: "outbound", quantity: 1, reason: "借用", detail: "测试台架", operator: "王五", time: new Date().toISOString() }
];

const state = {
  items: [],
  records: [],
  selectedCode: null,
  stream: null,
  scanTimer: null,
  apiBase: localStorage.getItem("warehouseApiBase") || ""
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
  detailNote: $("detailNote"),
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
      const haystack = `${item.code} ${item.name} ${item.category || ""}`.toLowerCase();
      return haystack.includes(query);
    })
    .forEach((item) => {
      const node = template.content.firstElementChild.cloneNode(true);
      node.dataset.code = item.code;
      node.classList.toggle("active", item.code === state.selectedCode);
      node.querySelector(".itemName").textContent = item.name;
      node.querySelector(".itemCode").textContent = item.code;
      node.querySelector(".itemQty").textContent = `${item.stock}${item.unit || ""}`;
      node.addEventListener("click", () => selectItem(item.code));
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
  els.detailNote.textContent = item.note || "-";
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

function selectItem(code) {
  const item = state.items.find((entry) => entry.code === code);
  if (!item) {
    setStatus(`未找到物资：${code}`, true);
    return;
  }
  state.selectedCode = code;
  const url = new URL(window.location.href);
  url.searchParams.set("code", code);
  history.replaceState(null, "", url);
  renderItems();
  renderDetail();
}

function getSelectedItem() {
  return state.items.find((item) => item.code === state.selectedCode) || null;
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
    if (state.apiBase) {
      await requestJson(type === "inbound" ? "/api/inbound" : "/api/outbound", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      await loadData();
      selectItem(item.code);
    } else {
      applyDemoMovement(type, payload);
      renderAll();
    }
    els.movementForm.reset();
    els.movementType.value = type;
    setMovementType(type);
    setFormStatus("已提交", false);
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
    return url.searchParams.get("code") || url.searchParams.get("item") || value;
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
  const code = params.get("code") || params.get("item");
  if (code) state.selectedCode = code;
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


