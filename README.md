# 物资管理系统

_https://scnu-vanguard.github.io/warehouse-management/_

一个轻量级物资出入库页面，前端部署在 GitHub Pages，后端 API 部署在 Cloudflare Workers，数据存放在飞书多维表格。

系统本身不保存数据库，也不接入大模型。所有库存、SN 码、出入库记录都从飞书读取和写入。

## 功能

- 查看物资列表、库存、负责人、备注和 SN 码
- 顶部统计物资种类、当前库存、今日入库、今日出库
- 物资详情显示当前库存和累计出库
- 按物资编号、名称搜索
- 入库、出库，并同步更新飞书表格
- 出库时记录原因、具体信息、操作人
- 支持扫码打开指定物资
- 生成单张整合二维码标签
- 在页面补全物资编号、SN 码、负责人、备注等档案信息
- 可选记录出入库历史

## 使用者指引

1. 打开网页，左侧选择物资，或用搜索框查找。
2. 入库：填数量、SN 码和操作人，提交。
3. 出库：选择对应 SN，填数量、出库原因、具体信息和操作人，提交。
4. 补资料：点“编辑信息”，补货物编号、SN 码、负责人、备注等字段。
5. 打标签：点“二维码”，打印后贴到对应物资上。

SN 码一行一个。一个 SN 对应一个实物，不要重复录入。

## 战队接入步骤

最少需要三样东西：

```text
1. 一个飞书企业自建应用
2. 一个飞书多维表格
3. 一个 Cloudflare Worker
```

接入顺序：

1. 按下方字段建好飞书库存表和记录表。
2. 在飞书开放平台给应用开多维表格读写权限，并发布版本。
3. 复制 `api/wrangler.toml.example` 为 `api/wrangler.toml`。
4. 填自己的飞书 token、table id、GitHub Pages 地址。
5. 用 `wrangler secret` 写入 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET`。
6. 部署 Worker，再部署 `docs/` 到 GitHub Pages。
7. 把 [docs/app.js](./docs/app.js) 顶部的 `CLOUDFLARE_API_BASE` 改成自己的 Worker 地址。

## 项目结构

```text
docs/
  index.html      前端页面
  app.js          页面逻辑、扫码、出入库、二维码
  styles.css      页面样式
  assets/         图片资源
  vendor/         前端依赖

api/
  worker.js              Cloudflare Worker 后端
  wrangler.toml.example  Worker 配置模板
  wrangler.toml.backup   当前本地部署配置备份

edge-functions/          EdgeOne 可选入口
edgeone.json             EdgeOne 可选配置
```

## 数据表要求

主表用于存放当前库存。推荐字段如下：

```text
货物编号
货品
SN码
入库数量
出库数量
现有库存数量
负责人
备注
二维码链接
```

`现有库存数量` 可以是公式字段，例如：

```text
入库数量 - 出库数量
```

物资详情里的“累计出库”来自主表的 `出库数量` 字段。

如果要记录出入库历史，另建一张表，字段如下：

```text
货物编号
货品
类型
数量
SN码
出库原因
具体信息
操作人
操作时间
```

## 飞书应用权限

在飞书开放平台创建企业自建应用，并开启需要的文档权限。常用权限包括：

```text
wiki:node:read
多维表格读取权限
多维表格写入权限
```

如果表格在知识库页面里，还需要让应用能访问对应知识库。改完权限后，要创建并发布新版本，否则权限不会生效。

## 部署后端

后端使用 Cloudflare Workers。

1. 复制配置模板：

```bash
copy api\wrangler.toml.example api\wrangler.toml
```

2. 修改 `api/wrangler.toml` 里的变量：

```text
FEISHU_WIKI_TOKEN=飞书知识库页面 token
FEISHU_SHEET_ID=飞书 sheet id
FEISHU_ITEMS_TABLE_ID=库存主表 table id
FEISHU_RECORDS_TABLE_ID=出入库记录表 table id，可选
ALLOWED_ORIGIN=你的 GitHub Pages 地址
```

如果你用的是飞书多维表格原始链接，也可以不用 `FEISHU_WIKI_TOKEN`，改用：

```text
FEISHU_APP_TOKEN=appxxxx
```

3. 添加密钥，不要写进代码：

```bash
wrangler secret put FEISHU_APP_ID
wrangler secret put FEISHU_APP_SECRET
```

4. 部署 Worker：

```bash
cd api
wrangler deploy
```

5. 打开健康检查地址：

```text
https://你的-worker地址/api/health
```

看到 `ok: true` 就说明后端已启动。

## 部署前端

前端是纯静态页面，部署 `docs/` 目录即可。

GitHub Pages 推荐设置：

```text
Source: Deploy from a branch
Branch: main
Folder: /docs
```

部署完成后，把 [docs/app.js](./docs/app.js) 顶部的 `CLOUDFLARE_API_BASE` 改成你的 Worker 地址：

```text
https://你的-worker地址
```

保存并重新部署前端。页面能看到飞书数据，就说明接入成功。

## 环境变量说明

常用配置如下：

```text
FEISHU_APP_ID              飞书应用 App ID，作为 Worker secret
FEISHU_APP_SECRET          飞书应用 App Secret，作为 Worker secret
FEISHU_WIKI_TOKEN          飞书知识库页面 token
FEISHU_SHEET_ID            飞书 sheet id
FEISHU_APP_TOKEN           飞书多维表格 app token，可替代 wiki token
FEISHU_ITEMS_TABLE_ID      库存主表 table id
FEISHU_RECORDS_TABLE_ID    出入库记录表 table id，可选
ALLOWED_ORIGIN             允许访问 API 的前端地址
```

字段名默认值：

```text
FIELD_CODE=货物编号
FIELD_NAME=货品
FIELD_STOCK=现有库存数量
FIELD_SN=SN码
FIELD_IN_QTY=入库数量
FIELD_OUT_QTY=出库数量
STOCK_WRITE_MODE=movement_totals
FIELD_OWNER=负责人
FIELD_QR=二维码链接
FIELD_NOTE=备注
```

出入库记录表默认字段：

```text
FIELD_RECORD_CODE=货物编号
FIELD_RECORD_NAME=货品
FIELD_RECORD_TYPE=类型
FIELD_RECORD_QTY=数量
FIELD_RECORD_SN=SN码
FIELD_REASON=出库原因
FIELD_DETAIL=具体信息
FIELD_OPERATOR=操作人
FIELD_TIME=操作时间
```

如果你的飞书字段名不同，改对应的环境变量即可。

## 常用接口

```text
GET  /api/health
GET  /api/items
GET  /api/items/:code
POST /api/items/update
GET  /api/records
POST /api/inbound
POST /api/outbound
```

出库请求示例：

```json
{
  "code": "WZ-0001",
  "quantity": 2,
  "reason": "项目使用",
  "detail": "A 项目设备维护",
  "operator": "张三"
}
```

## 可选：EdgeOne

仓库里保留了 EdgeOne 配置，可以作为国内访问入口。但 EdgeOne 默认域名只适合预览，长期使用通常需要绑定自定义域名。

如果只使用 GitHub Pages + Cloudflare Workers，可以忽略 `edge-functions/` 和 `edgeone.json`。

## 注意事项

- 不要把 `FEISHU_APP_SECRET` 写进前端代码。
- 不要直接提交 `api/wrangler.toml`，提交 `api/wrangler.toml.example` 即可。
- 别人 fork 本仓库后，需要填写自己的飞书应用、表格 ID 和 Worker 地址。
- 如果前端显示演示数据，通常是 `CLOUDFLARE_API_BASE` 没改或 Worker 无法访问。
