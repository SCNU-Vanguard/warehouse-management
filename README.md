# Warehouse Management Prototype

This project is a minimal implementation for the warehouse workflow discussed earlier.

## Architecture

```text
GitHub Pages static frontend
-> lightweight API worker
-> Feishu Bitable as the data source
```

The API does not use any large language model. It only reads and writes Feishu Bitable records.

## Folders

```text
web/
  index.html    Static frontend for GitHub Pages
  styles.css    Mobile-first UI styles
  app.js        Dashboard, item detail, scan/manual code flow, inbound/outbound forms

api/
  worker.js     Cloudflare Workers API proxy for Feishu Bitable
  wrangler.toml.example
```

## Frontend

Open `web/index.html` directly for a local UI preview. It uses demo data until an API base URL is configured.

In the page settings, set API Base URL to your deployed Worker URL, for example:

```text
https://warehouse-api.your-name.workers.dev
```

QR code content should use a URL like:

```text
https://your-org.github.io/warehouse-web/?code=WZ-0001
```

The static page reads `code` from the URL and opens that item.

## API Endpoints

```text
GET  /api/items
GET  /api/items/:code
GET  /api/records
POST /api/inbound
POST /api/outbound
```

Example outbound body:

```json
{
  "code": "WZ-0001",
  "quantity": 2,
  "reason": "项目使用",
  "detail": "A 项目设备维护",
  "operator": "张三"
}
```

## Required Worker Environment Variables

Use `FEISHU_WIKI_TOKEN` when your Bitable is opened from a Feishu wiki URL. The Worker resolves the real Bitable `app_token` automatically.

```text
FEISHU_APP_ID
FEISHU_APP_SECRET
FEISHU_WIKI_TOKEN=JPtgwwj0mia1KvkOOoUckEGOngd
FEISHU_SHEET_ID=81kyme`r`nFEISHU_ITEMS_TABLE_ID=tblMsuzoJ3m3eXfw
```

If you later get a raw `/base/appxxxx` link, you can set `FEISHU_APP_TOKEN` instead of `FEISHU_WIKI_TOKEN`.

Current inventory table field defaults:

```text
FIELD_CODE=货物编号
FIELD_NAME=货品
FIELD_STOCK=现有库存数量
FIELD_IN_QTY=入库数量
FIELD_OUT_QTY=出库数量
STOCK_WRITE_MODE=movement_totals
```

`movement_totals` writes inbound changes to `入库数量` and outbound changes to `出库数量`, so `现有库存数量` can remain a formula field. Use `STOCK_WRITE_MODE=stock` only if `现有库存数量` is a writable number column.

Optional movement record table field defaults:

```text
FIELD_RECORD_CODE=货物编号
FIELD_RECORD_NAME=货品
FIELD_RECORD_TYPE=类型
FIELD_RECORD_QTY=数量
FIELD_REASON=出库原因
FIELD_DETAIL=具体信息
FIELD_OPERATOR=操作人
FIELD_TIME=操作时间
```

Do not put `FEISHU_APP_SECRET` in frontend code.

## Feishu Permissions

Enable these in Feishu Open Platform, then create and publish a new app version:

```text
wiki:node:read
bitable:app
bitable:app:readonly
bitable record read/write permissions
```

## Next Steps

1. Copy `api/wrangler.toml.example` to `api/wrangler.toml`.
2. Add `FEISHU_APP_ID` and `FEISHU_APP_SECRET` as Worker secrets.`r`n3. Deploy the Worker and set the frontend API Base URL to the Worker URL.`r`n4. Optionally add `FEISHU_RECORDS_TABLE_ID` later for movement history and charts.
