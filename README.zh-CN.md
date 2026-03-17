<div align="center">

# Crucix（中文文档）

**你的本地情报终端：27 个数据源，一条命令，零云依赖。**

[![Node.js 22+](https://img.shields.io/badge/node-22%2B-brightgreen)](#快速开始)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPLv3-blue.svg)](LICENSE)
[![Dependencies](https://img.shields.io/badge/dependencies-1%20(express)-orange)](#架构)
[![Sources](https://img.shields.io/badge/OSINT%20sources-27-cyan)](#数据源27)
[![Docker](https://img.shields.io/badge/docker-ready-blue?logo=docker)](#docker)

![Crucix Dashboard](docs/dashboard.png)

</div>

---

## 项目简介

Crucix 会并行采集 27 个开源情报数据源（卫星火点、航班、辐射、冲突、制裁、经济指标、市场价格、社交情绪等），默认每 15 分钟更新一次，并统一渲染到一个自包含仪表盘。

接入大模型后，系统会升级为双向智能助手：
- 在重要变化发生时推送分级告警到 Telegram / Discord / 飞书
- 响应 `/brief`、`/sweep`、`/status` 等命令
- 基于跨域数据生成可执行的观察结论与交易想法

无需云端、无需遥测、无需订阅，启动即可用。

---

## 二次开发说明

如果你在此仓库基础上做了二次开发，建议同步更新以下内容，便于团队协作和后续维护：
- 新增或删除的数据源与采集频率
- 新增告警渠道、机器人命令或路由
- LLM 提示词、策略阈值、打分逻辑的改动
- 新增环境变量及默认值
- 前端仪表盘布局与交互变化

你可以以本文件为中文主文档，并保留 [README.md](README.md) 作为英文版。

---

## 快速开始

```bash
# 1) 克隆仓库
git clone https://github.com/calesthio/Crucix.git
cd crucix

# 2) 安装依赖（运行时仅 Express）
npm install

# 3) 复制环境变量模板并填写 API Key
cp .env.example .env

# 4) 启动
npm run dev
```

默认访问：`http://localhost:3117`

首次启动会触发全量采集（27 源并行），通常 30–60 秒后面板开始出现数据。后续通过 SSE 自动推送更新，无需手动刷新。

要求：Node.js 22+

### Docker

```bash
git clone https://github.com/calesthio/Crucix.git
cd crucix
cp .env.example .env
docker compose up -d
```

---

## 核心能力

### 实时可视化面板
- 3D 地球 + 平面地图双视图
- 多类标记点：火点、航班、辐射、冲突、新闻等
- 实时市场数据、风险指标、跨源信号
- Sweep Delta：展示本轮相对上轮的新增/升级/降级变化
- Space Watch / Nuclear Watch 专题监控

### 自动采集与推送
每轮（默认 15 分钟）执行：
1. 并行请求全部数据源  
2. 结构化汇总并计算 delta  
3. 触发告警评估（FLASH / PRIORITY / ROUTINE）  
4. 推送到前端与已配置消息渠道

### 双向机器人
- Telegram：支持 `/status` `/sweep` `/brief` `/alerts` `/mute` 等
- Discord：支持 Slash Commands 与 Embed 告警
- 飞书：支持 webhook 或 app token 模式

### 可选 LLM 增强
支持 `anthropic` / `openai` / `gemini` / `codex`，用于：
- 交易想法生成
- 告警语义分级与跨域相关性判断
- 模型不可用时自动降级为规则引擎

---

## API Keys 配置

将 `.env.example` 复制为 `.env`，按需填写：

```bash
cp .env.example .env
```

优先建议（免费且价值高）：
- `FRED_API_KEY`
- `FIRMS_MAP_KEY`
- `EIA_API_KEY`

可选能力：
- 冲突事件：`ACLED_EMAIL` + `ACLED_PASSWORD`
- 航运 AIS：`AISSTREAM_API_KEY`
- ADS-B 扩展：`ADSB_API_KEY`

消息渠道：
- Telegram：`TELEGRAM_BOT_TOKEN`、`TELEGRAM_CHAT_ID`
- Discord：`DISCORD_BOT_TOKEN`、`DISCORD_CHANNEL_ID`
- 飞书：`FEISHU_WEBHOOK_URL` 或 `FEISHU_APP_ID`/`FEISHU_APP_SECRET`

---

## npm 脚本

| 脚本 | 命令 | 说明 |
|------|------|------|
| `npm run dev` | `node --trace-warnings server.mjs` | 启动服务 |
| `npm run sweep` | `node apis/briefing.mjs` | 执行一次采集 |
| `npm run inject` | `node dashboard/inject.mjs` | 将数据注入静态 HTML |
| `npm run brief:save` | `node apis/save-briefing.mjs` | 采集并保存时间戳结果 |
| `npm run diag` | `node diag.mjs` | 诊断 Node/模块/端口问题 |

---

## 关键配置项

常用环境变量：
- `PORT`（默认 `3117`）
- `REFRESH_INTERVAL_MINUTES`（默认 `15`）
- `LLM_PROVIDER` / `LLM_API_KEY` / `LLM_MODEL`
- `TELEGRAM_*` / `DISCORD_*` / `FEISHU_*`

差分引擎阈值可在 `crucix.config.mjs` 的 `delta.thresholds` 中调整。

---

## API 路由

开发模式启动后：
- `GET /`：仪表盘
- `GET /api/data`：当前聚合数据
- `GET /api/health`：服务健康状态
- `GET /events`：SSE 实时推送流

---

## 故障排查

### `npm run dev` 无输出直接退出
优先执行：

```bash
node --trace-warnings server.mjs
```

再执行：

```bash
node diag.mjs
```

### 页面初次为空
正常现象，首轮采集完成后自动填充。

### 部分数据源报错
通常是对应 Key 缺失。未受影响的数据源仍会继续运行。

### Discord 命令未出现
检查 `discord.js` 是否安装，以及 `DISCORD_GUILD_ID` 是否配置（可加速命令注册）。

---

## 架构

```text
crucix/
├── server.mjs
├── crucix.config.mjs
├── diag.mjs
├── apis/
├── dashboard/
├── lib/
└── runs/
```

设计原则：
- 纯 ESM（`.mjs`）
- 运行时最小依赖（Express）
- 并行采集与优雅降级
- 每个 source 可独立调试
- 面板可独立渲染

---

## 数据源（27）

分层覆盖：
- Tier 1：核心 OSINT 与地缘（11）
- Tier 2：经济金融（7）
- Tier 3：天气环境/科技/社交/SIGINT（7）
- Tier 4：空间与卫星（1）
- Tier 5：实时市场（1）

具体来源与鉴权方式请参考英文版 [README.md](README.md) 的完整表格。

---

## 许可证

AGPL-3.0
