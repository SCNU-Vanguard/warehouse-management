# Warehouse Management Prototype

Minimal warehouse management prototype for GitHub Pages + Cloudflare Workers + Feishu.

## Architecture

```text
GitHub Pages static frontend
-> Cloudflare Worker API
-> Feishu wiki sheet / Bitable data source
```

The API does not use any large language model. It only reads and writes Feishu document data.

## Folders

```text
docs/
  index.html    Static frontend served by GitHub Pages
  styles.css    Mobile-first UI styles
  app.js        Dashboard, item detail, scan/manual code flow, inbound/outbound forms
  assets/       Frontend image assets

api/
  worker.js     Cloudflare Workers API proxy for Feishu
  wrangler.toml.example
```

## Frontend

GitHub Pages is configured to serve the `docs/` folder from the `main` branch.

Site URL:

```text
https://scnu-vanguard.github.io/warehouse-management/
```

In the page settings, set API Base URL to your deployed Worker URL:

```text
https://warehouse-api.hoanglinh4586359.workers.dev
```

QR code content should use a URL like:

```text
https://scnu-vanguard.github.io/warehouse-management/?code=WZ-0001
```

The static page reads `code` from the URL and opens that item.

## API Endpoints

```text
GET  /api/health
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

Use `FEISHU_WIKI_TOKEN` when the source is opened from a Feishu wiki URL. The Worker resolves the underlying document token automatically.

For the current Feishu sheet source:

```text
FEISHU_APP_ID
FEISHU_APP_SECRET
FEISHU_WIKI_TOKEN=JPtgwwj0mia1KvkOOoUckEGOngd
FEISHU_SHEET_ID=81kyme
ALLOWED_ORIGIN=https://scnu-vanguard.github.io
```

Optional for a raw Bitable source:

```text
FEISHU_APP_TOKEN=appxxxx
FEISHU_ITEMS_TABLE_ID=tblxxxx
```

Current inventory field defaults:

```text
FIELD_CODE=货物编号
FIELD_NAME=货品
FIELD_STOCK=现有库存数量
FIELD_IN_QTY=入库数量
FIELD_OUT_QTY=出库数量
STOCK_WRITE_MODE=movement_totals
```

`movement_totals` writes inbound changes to `入库数量` and outbound changes to `出库数量`, so `现有库存数量` can remain a formula field. Use `STOCK_WRITE_MODE=stock` only if `现有库存数量` is a writable number column.

Optional movement record table fields:

```text
FEISHU_RECORDS_TABLE_ID=tblxxxx
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

Enable the relevant document permissions in Feishu Open Platform, then create and publish a new app version:

```text
wiki:node:read
sheet read/write permissions
bitable permissions only if a Bitable source is used
```

## Next Steps

1. Add or update Worker variables in Cloudflare.
2. Deploy `api/worker.js` to Cloudflare Workers.
3. Set the frontend API Base URL to the Worker URL.
4. Optionally add `FEISHU_RECORDS_TABLE_ID` later for movement history and charts.
