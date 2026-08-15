# CMCC 好友麻将公司电脑交接单

更新时间：2026-08-15

## 当前可交接版本

- 分支：`main`
- 模型版本：`persist-control-v17`
- 临时朋友联网可玩版：100%
- 长期稳定运营版：约65%
- 综合完成度：约80%
- 完整进度与功能清单：见 `docs/PROJECT_STATUS.md`
- 已确认规则：见 `docs/GAME_RULES.md`
- 验证状态：v17 已在公司电脑通过 78 项自动测试、生产构建；本地联机/后台冒烟待提交后执行，公网真机回归在阿里云部署后执行。

v15 修复了两项真实部署反馈：7张字牌语音全部按素材真实顺序映射（东31、西41、南51、北61、中71、发81、白91），首页规则说明改为“中发白和东南西北两类特殊杠”。浏览器控制台会输出 `audio_voice_requested`，其中同时包含牌码和实际 MP3 文件名。

v16 新增受 `ADMIN_TOKEN` 保护的后台管理与在线监控：`/admin` 页面、`/api/admin/summary` 和 `/api/admin/rooms/:code` 只读接口，可查看房间概览、在线真人、测试玩家、等待/进行中统计、异常房间详情和公开牌桌状态，不返回玩家令牌、私有手牌和自摸牌。

v17 在 v16 基础上新增 Redis 房间持久化（`REDIS_URL` 可选，未配置时保持纯内存）、PM2/systemd 进程守护配置、后台强制解散与管理员公告、大厅男声/女声选择（男声使用 Web Audio 降调，不新增素材）、粒子结算特效、昵称记忆和更多体验优化。后台管理页现在可以发送公告并强制解散房间。

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
node scripts/websocket-smoke.mjs ws://127.0.0.1:3000/ws persist-control-v17
node scripts/admin-smoke.mjs http://127.0.0.1:3000 你的后台令牌 persist-control-v17
node scripts/full-round-smoke.mjs ws://127.0.0.1:3000/ws persist-control-v17
```

健康检查应返回 `persist-control-v17`，后台概览应返回房间数、在线真人数和房间列表，且未配置 `REDIS_URL` 时显示 `"persistence":"memory"`。后台冒烟会验证公告和强制解散。最后需用手机人工试听女声和男声；若仍有问题，把浏览器控制台的 `audio_voice_requested` JSON 和实际听到的牌名发回即可精确修正。

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
- Redis 房间持久化、服务重启自动恢复、PM2/systemd 守护配置。
- 后台公告与强制解散、大厅男女声切换、粒子结算特效和昵称记忆。

## 后续待办

1. 阿里云安装 Redis、部署 v17 后验证重启恢复、后台公告/强制解散、男女声人工听音和四人真机完整一场回归。
2. 按需增加长期持久化的完整牌桌回放、告警/通知、性能趋势和异常自动上报。
3. 如果未来需要域名/HTTPS，再配置 Nginx 和 WSS；当前按需求保持公网 IP 直连。
4. 根据朋友实战反馈微调地方规则，并继续补方言语音、更多粒子动画和低端机性能优化。

## 重要运行边界

- 配置 `REDIS_URL` 后房间状态每 2 秒写入 Redis，进程重启可恢复；未配置时仍是纯内存。
- `logs/server.jsonl` 不记录玩家令牌和私有手牌，可用于按房间号排障。
- 客户端是展示层，规则、手牌和计分始终由服务端裁决。
