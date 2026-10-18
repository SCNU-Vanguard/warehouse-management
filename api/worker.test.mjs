import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const workerSource = await fs.readFile(new URL("./worker.js", import.meta.url), "utf8");
const workerUrl = `data:text/javascript;base64,${Buffer.from(workerSource).toString("base64")}`;
const { default: worker } = await import(workerUrl);

test("groups by parent record and maintains child SN rows through GitHub Pages API", async () => {
  const fieldNames = ["货品", "货物编号", "父记录", "SN码", "是否被使用", "入库数量", "出库数量", "现有库存数量", "负责人", "备注"];
  let nextId = 1;
  const rows = [
    { record_id: "rec_battery_1", fields: { "货物编号": "0704-A", "SN码": "DJI-001", "是否被使用": "否", "父记录": [{ text: "大疆新电池", record_ids: ["rec_battery"] }] } },
    { record_id: "rec_battery_2", fields: { "货物编号": "0704-B", "SN码": "DJI-002", "是否被使用": "否", "父记录": [{ record_ids: ["rec_battery"] }] } },
    { record_id: "rec_battery", fields: { "货品": "大疆新电池", "货物编号": "BATTERY", "现有库存数量": 2, "入库数量": 3, "出库数量": 1 } },
    { record_id: "rec_motor_sn", fields: { "货物编号": "S3519", "SN码": "M-001", "是否被使用": "否", "父记录": [{ record_ids: ["rec_motor"] }] } },
    { record_id: "rec_motor", fields: { "货品": "RM_M3508", "货物编号": "M3508" } }
  ];

  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    const method = options.method || "GET";
    if (url.pathname.endsWith("/tenant_access_token/internal")) {
      return Response.json({ code: 0, tenant_access_token: "test-token", expire: 7200 });
    }
    if (url.pathname.endsWith("/records") && method === "GET") {
      return Response.json({ code: 0, data: { items: rows, has_more: false } });
    }
    if (url.pathname.endsWith("/fields")) {
      return Response.json({ code: 0, data: { items: fieldNames.map((field_name) => ({ field_name })) } });
    }
    const updateMatch = url.pathname.match(/\/records\/(rec_[^/]+)$/);
    if (updateMatch && method === "PUT") {
      const updateFields = JSON.parse(options.body).fields;
      if ("父记录" in updateFields && (!Array.isArray(updateFields["父记录"]) || updateFields["父记录"].some((id) => typeof id !== "string"))) {
        return Response.json({ code: 1254067, msg: "LinkFieldConvFail" });
      }
      const row = rows.find((entry) => entry.record_id === updateMatch[1]);
      Object.assign(row.fields, updateFields);
      return Response.json({ code: 0, data: {} });
    }
    if (url.pathname.endsWith("/records") && method === "POST") {
      const createFields = JSON.parse(options.body).fields;
      if ("父记录" in createFields && (!Array.isArray(createFields["父记录"]) || createFields["父记录"].some((id) => typeof id !== "string"))) {
        return Response.json({ code: 1254067, msg: "LinkFieldConvFail" });
      }
      const row = { record_id: `rec_new_${nextId++}`, fields: createFields };
      rows.push(row);
      return Response.json({ code: 0, data: { record: row } });
    }
    return Response.json({ code: 999, msg: `unexpected ${method} ${url.pathname}` }, { status: 400 });
  };

  try {
    const env = {
      FEISHU_APP_ID: "test",
      FEISHU_APP_SECRET: "test",
      FEISHU_APP_TOKEN: "app-token",
      FEISHU_ITEMS_TABLE_ID: "items-table",
      STOCK_WRITE_MODE: "movement_totals"
    };
    const call = async (path, method = "GET", body) => {
      const response = await worker.fetch(new Request(`https://test.local${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {})
      }), env);
      return { status: response.status, data: await response.json() };
    };

    let result = await call("/api/items");
    assert.equal(result.status, 200);
    assert.equal(result.data.items.length, 2);
    const battery = result.data.items.find((item) => item.name === "大疆新电池");
    assert.deepEqual(battery.codes, ["BATTERY", "0704-A", "0704-B"]);
    assert.equal(battery.sn, "DJI-001\nDJI-002");
    assert.equal(result.data.items.find((item) => item.codes.includes("S3519"))?.name, "RM_M3508");

    result = await call("/api/items/update", "POST", {
      recordId: "rec_battery",
      code: "BATTERY",
      nextCode: "BATTERY",
      name: "大疆新电池",
      sn: ["DJI-001", "DJI-003"]
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(rows.find((row) => row.record_id === "rec_battery_2").fields["SN码"], "DJI-003");
    assert.deepEqual(rows.find((row) => row.record_id === "rec_battery_2").fields["父记录"][0].record_ids, ["rec_battery"]);

    result = await call("/api/inbound", "POST", {
      recordId: "rec_battery",
      code: "BATTERY",
      quantity: 1,
      sn: ["DJI-004"],
      operator: "test"
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    const inboundSn = rows.find((row) => row.fields["SN码"] === "DJI-004");
    assert.ok(inboundSn);
    assert.deepEqual(inboundSn.fields["父记录"], ["rec_battery"]);
    assert.equal(inboundSn.fields["是否被使用"], "否");

    result = await call("/api/outbound", "POST", {
      recordId: "rec_battery",
      code: "BATTERY",
      quantity: 1,
      sn: ["DJI-001"],
      operator: "test",
      reason: "使用",
      detail: "验证SN状态更新"
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(rows.find((row) => row.record_id === "rec_battery_1").fields["SN码"], "DJI-001");
    assert.equal(rows.find((row) => row.record_id === "rec_battery_1").fields["是否被使用"], "是");
  } finally {
    globalThis.fetch = previousFetch;
  }
});
