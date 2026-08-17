# CMCC 好友麻将公司电脑交接单

更新时间：2026-08-17

## 当前可交接版本

- 分支：`main`
- 模型版本：`ui-voice-v18`
- 临时朋友联网可玩版：100%
- 长期稳定运营版：约82%
- 综合完成度：约90%
- 完整进度与功能清单：见 `docs/PROJECT_STATUS.md`
- 已确认规则：见 `docs/GAME_RULES.md`（当前 v0.4）
- 验证状态：`ui-voice-v18` 已通过 102 项自动测试、TypeScript 生产构建和本地联机/后台/四真人整局冒烟；阿里云已启用 Redis 持久化、PM2 守护和后台管理。

当前版本主要新增/收口：

- 观战座位：第5人进入后观战，可参与公屏聊天，有空位时房主可提上桌。
- 头像、聊天与特效：系统头像选择、头像下方麦克风/喇叭/聊天入口、公屏文字与表情、定向丢拖鞋动画。
- 三不烙与中发白规则：三不烙只统计落地刻子；中发白可作为“有杠”面子胡牌，东南西北不能暗成组胡牌。
- 特殊杠补牌：按“本次亮出牌张数减3”计算，中发白基础3张补0张，东南西北基础4张补1张；完成后手牌保持3n+1。
- 吃牌同牌禁打：吃牌后本回合不能打出刚吃进来的那张牌，客户端置灰，服务端强制校验。
- 牌桌布局：四面牌墙按真实剩余数显示，自己手牌与落地牌左右分列，出牌提示上移不遮挡手牌。
- 语音与计分：吃碰杠只报一次音，矩阵式结算明细，可自定义开局分、全员准备后下一局、麦克风/喇叭实时语音。

## 公司电脑拉取与启动

新电脑首次拉取：

```powershell
git clone https://github.com/lzy271713290/CMCCmahjong.git
cd CMCCmahjong\mahjong-h5
pnpm install
pnpm test
pnpm start
```

已有目录更新：

```powershell
cd CMCCmahjong
git pull --ff-only origin main
cd mahjong-h5
pnpm install
pnpm test
pnpm start
```

若公司网络需要本机7890代理：

```powershell
git -c http.proxy=http://127.0.0.1:7890 -c https.proxy=http://127.0.0.1:7890 pull --ff-only origin main
```

后台管理默认关闭；本地启动前设置后台令牌：

```powershell
$env:ADMIN_TOKEN="你的后台令牌"
pnpm start
```

## 阿里云更新与验收

```bash
cd /opt/CMCCmahjong
git pull --ff-only origin main
cd mahjong-h5
pnpm install --frozen-lockfile
pnpm test
pnpm run build
pm2 restart cmcc-mahjong --update-env
```

启动后检查：

```bash
curl -s http://127.0.0.1:3000/healthz
node scripts/websocket-smoke.mjs ws://127.0.0.1:3000/ws ui-voice-v18
node scripts/admin-smoke.mjs http://127.0.0.1:3000 你的后台令牌 ui-voice-v18
node scripts/full-round-smoke.mjs ws://127.0.0.1:3000/ws ui-voice-v18
```

健康检查应返回 `"modelVersion":"ui-voice-v18"`，配置 Redis 后返回 `"persistence":"redis"`。后台冒烟会验证管理员公告和强制解散。

## 已完成主链路

- 六位房间、四真人联机、观战座位、准备/开局、私有手牌、断线恢复、测试玩家补齐。
- 136张牌、服务端权威回合、吃碰杠胡、自摸/点炮/抢杠胡、一炮多响。
- 中发白/东南西北特殊杠、连续涨毛、杠尾补牌、暗杠隐私，以及特殊杠手牌3n+1约束。
- 吃牌后本回合同牌禁打，客户端置灰与服务端拒绝双重保障。
- 权威计分、8/16局、自定义开局分、连庄轮庄、负分结束、局中解散、矩阵结算明细和最终排名。
- 30/12秒操作倒计时、掉线90秒托管、弱网重连与防重复提交。
- 公共动作时间线、JSON导出、只读导入回放和私有字段校验。
- 横屏四方牌桌、34张牌真人语音、背景音乐、操作音效、粒子特效、头像聊天、丢拖鞋动画和实时语音。
- 结构化服务端/客户端监控、健康检查、普通冒烟和四真人完整一局冒烟。
- `ADMIN_TOKEN` 后台管理、房间概览、公告与强制解散。
- Redis 房间持久化、服务重启自动恢复、PM2/systemd 守护配置。

## 后续待办

1. 继续用真机验证新吃牌规则、特殊杠补牌、语音去重和牌桌布局。
2. 按需增加完整牌桌持久化回放、告警/通知、性能趋势和异常自动上报。
3. 如果未来需要域名/HTTPS，再配置 Nginx 和 WSS；当前按需求保持公网 IP 直连。
4. 根据朋友实战反馈继续微调地方规则，并补方言语音、更多动画和低端机性能优化。

## 重要运行边界

- 配置 `REDIS_URL` 后房间状态每 2 秒写入 Redis，进程重启可恢复；未配置时仍是纯内存。
- `logs/server.jsonl` 不记录玩家令牌和私有手牌，可用于按房间号排障。
- 客户端是展示层，规则、手牌和计分始终由服务端裁决。