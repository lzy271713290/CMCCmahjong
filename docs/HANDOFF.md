# CMCC 好友麻将公司电脑交接单

更新时间：2026-08-15

## 当前可交接版本

- 分支：`main`
- 模型版本：`admin-monitor-v16`
- 临时朋友联网可玩版：100%
- 长期稳定运营版：约65%
- 综合完成度：约80%
- 完整进度与功能清单：见 `docs/PROJECT_STATUS.md`
- 已确认规则：见 `docs/GAME_RULES.md`
- 验证状态：v16 已在公司电脑通过 74 项自动测试、生产构建、后台冒烟、常规联机冒烟和四真人整局冒烟；7 张字牌人工听音和公网真机回归留到阿里云部署后执行。

v15 修复了两项真实部署反馈：7张字牌语音全部按素材真实顺序映射（东31、西41、南51、北61、中71、发81、白91），首页规则说明改为“中发白和东南西北两类特殊杠”。浏览器控制台会输出 `audio_voice_requested`，其中同时包含牌码和实际 MP3 文件名。

v16 新增受 `ADMIN_TOKEN` 保护的后台管理与在线监控：`/admin` 页面、`/api/admin/summary` 和 `/api/admin/rooms/:code` 只读接口，可查看房间概览、在线真人、测试玩家、等待/进行中统计、异常房间详情和公开牌桌状态，不返回玩家令牌、私有手牌和自摸牌。

## 公司电脑拉取与启动

新电脑首次拉取：

```powershell
git clone https://github.com/lzy271713290/CMCCmahjong.git
cd CMCCmahjong\mahjong-h5
pnpm install
pnpm test
pnpm start
```

后台管理默认关闭；本地启动前设置后台令牌：

```powershell
$env:ADMIN_TOKEN="你的后台令牌"
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

## 阿里云更新与验收

```bash
cd /opt/CMCCmahjong
git pull --ff-only origin main
cd mahjong-h5
pnpm install
pnpm test
pnpm start
```

启动后检查：

```bash
curl -s http://127.0.0.1:3000/healthz
node scripts/websocket-smoke.mjs ws://127.0.0.1:3000/ws admin-monitor-v16
node scripts/admin-smoke.mjs http://127.0.0.1:3000 你的后台令牌 admin-monitor-v16
```

健康检查应返回 `admin-monitor-v16`，后台概览应返回房间数、在线真人数和房间列表。最后需用手机人工依次听东、西、南、北、中、发、白；若仍有问题，把浏览器控制台的 `audio_voice_requested` JSON 和实际听到的牌名发回即可精确修正。

## 已完成主链路

- 六位房间、四真人联机、准备/开局、私有手牌、断线恢复、测试玩家补齐。
- 136张牌、服务端权威回合、吃碰杠胡、自摸/点炮/抢杠胡、一炮多响。
- 中发白与东南西北特殊杠、连续涨毛、杠尾补牌和暗杠隐私。
- 权威计分、8/16局、连庄轮庄、负分结束、局中解散、逐局记录和最终排名。
- 30/12秒操作倒计时、掉线90秒托管、弱网重连与防重复提交。
- 公共动作时间线、JSON导出、只读导入回放和私有字段校验。
- 横屏四方牌桌、34张牌真人语音、背景音乐、操作音效和核心牌桌特效。
- 结构化服务端/客户端监控、健康检查、普通冒烟和四真人完整一局冒烟。
- 受 `ADMIN_TOKEN` 保护的后台管理与在线监控、异常房间详情和公开牌桌状态查看。

## 后续待办

1. 阿里云部署 v16 后完成7张字牌人工听音、后台页面/接口远程验收和四人真机完整一场回归。
2. 接入 Redis 持久化房间、牌局、累计分和完整牌桌回放，解决服务重启清空。
3. 使用 PM2 或 systemd 守护进程，配置 Nginx、域名、HTTPS/WSS，停止长期裸露3000端口。
4. 增加告警/通知、长期性能趋势和异常自动上报。
5. 根据朋友实战反馈微调地方规则，并补方言/男女声、更多粒子特效和低端机性能优化。

## 重要运行边界

- 当前数据仅在服务内存，重启会清空房间和进行中的牌局。
- `logs/server.jsonl` 不记录玩家令牌和私有手牌，可用于按房间号排障。
- 客户端是展示层，规则、手牌和计分始终由服务端裁决。
