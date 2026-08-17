# CMCC 好友麻将

面向手机浏览器的四人联机麻将项目。当前模型版本为 `ui-voice-v18`，已具备四人联机房间、私有手牌、横屏四方牌桌、吃碰杠胡与抢杠、中发白/东南西北特殊杠和连续涨毛、服务端权威计分与结算、8/16局整场、局中解散、操作倒计时和掉线托管。体验层已加入真人语音、男女声切换、背景音乐、粒子特效、观战座位、头像与公屏聊天表情、定向丢拖鞋动画、开局分自定义、结算矩阵弹层，以及麦克风/喇叭实时语音；后台层已加入 `ADMIN_TOKEN` 后台管理、Redis 房间持久化和 PM2/systemd 进程守护。

## 当前进度

- 当前版本 `ui-voice-v18` 已通过 **102 项自动测试**、TypeScript 生产构建、本地联机冒烟和阿里云公网冒烟。
- 手机横屏牌桌已按真机反馈多轮修正：四面牌墙按真实剩余数渲染并随摸牌递减；中央倒计时和风位缩小；左右墙与立牌不重叠；自己手牌左移，落地牌右侧横向排列、超过两组自动换行；出牌提示上移，避免遮挡手牌；吃牌后当前回合不能打出刚吃进来的那张牌。
- 三不烙只统计已落地的刻子/杠，至少3组；中发白可作为“有杠”面子参与胡牌并豁免一九/刻子，东南西北不能暗成组胡牌，只能作为特殊杠。
- 特殊杠补牌遵循“本次亮出牌张数减3”规则：中发白基础3张补0张，东南西北基础4张补1张，多亮出的字牌每张对应1次涨毛补牌；完成出牌后手牌始终为3n+1。
- 服务器已采用 Redis 房间持久化、PM2 守护与开机自启；后台 `/admin` 可查看房间、发送公告和强制解散。
- 公网 IP 直连仍按需求运行在 `http://8.148.231.244:3000/`，麦克风受浏览器 HTTPS 限制，喇叭收听不受影响；域名/HTTPS/Nginx 留作后续升级。

详细规则见 `docs/GAME_RULES.md`，项目进度见 `docs/PROJECT_STATUS.md`，服务器部署与更新命令见 `docs/ALIYUN_DEPLOYMENT.md`，本地接手步骤见 `docs/HANDOFF.md`。
## 回家后继续开发

```powershell
git clone https://github.com/lzy271713290/CMCCmahjong.git
cd CMCCmahjong\mahjong-h5
pnpm install
pnpm test
pnpm start
```

浏览器访问 `http://localhost:3000`。手机和电脑在同一网络时，可访问 `http://电脑局域网IP:3000`。

## 目录

- `mahjong-h5/`：H5 客户端、TypeScript 服务端、测试和牌桌素材。
- `docs/GAME_RULES.md`：麻将规则 v0.2 的可追踪源文件。
- `deliverables/`：麻将规则需求规格 Word 固化稿，保留历史版本。
- `scripts/build_mahjong_rules_docx.py`：从规则源文件生成 Word 固化稿。
- `docs/`：项目进度和阿里云部署记录。
- `docs/HANDOFF.md`：公司电脑接手、验证和继续开发的简明交接单。
- `docs/REFERENCE_NOTES.md`：开源参考项目中采用与明确不采用的麻将逻辑。
- `sources/`：项目同步参考目录。

## 开源参考

房间管理、断线恢复和服务端裁决思路参考 [babykylin_scmj 幼麟四川麻将](https://github.com/babykylin/babykylin_scmj)。完整参考仓库不重复提交，已经确定复用的美术资源保存在 `mahjong-h5/client/public/assets/babykylin/`。
