# CMCC 好友麻将

面向手机浏览器的四人联机麻将项目。当前已完成 H5 联机大厅、私有手牌、横屏四方牌桌和“出牌 → 无操作自动过 → 下家摸牌”的基础回合循环，下一阶段接入吃碰杠胡候选计算与响应优先级。

## 当前进度

- 六位房间号、四人座位、准备状态和实时同步。
- 刷新或短暂掉线后恢复原座位。
- 房主可一键补齐测试玩家并开始测试对局。
- 已接入最小牌局模型：136张牌、洗牌、随机庄家、四人发牌和牌张守恒校验。
- 对局页面已重做为横屏四方桌：仓库原始牌桌背景、真实麻将牌图集、四家座位、牌墙、分区弃牌、中央风位/余牌计数和当前行动高亮。
- 每名玩家只会收到自己的具体手牌，其他玩家仅公开手牌数量；刷新和断线重连可恢复同一副牌。
- 服务端校验出牌轮次和持牌；当前没有吃碰杠胡候选时自动过响应窗口，为下一家摸牌并继续出牌。
- 单人联调时三名测试玩家会自动摸打，真人每出一张即可跑完一整圈并重新获得14张手牌。
- 回合推进、自动出牌、私有手牌恢复和异常请求均写入结构化监控日志，不记录其他玩家的具体手牌。
- 服务端使用 TypeScript 和 WebSocket，客户端使用移动端 H5。
- 已整理幼麟四川麻将的牌桌背景、麻将牌和牌桌操作图集。
- 最新麻将规则源文件位于 `docs/GAME_RULES.md`，可直接在 GitHub 查看和比对；Word 固化稿位于 `deliverables/`。

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
- `docs/REFERENCE_NOTES.md`：开源参考项目中采用与明确不采用的麻将逻辑。
- `sources/`：项目同步参考目录。

## 开源参考

房间管理、断线恢复和服务端裁决思路参考 [babykylin_scmj 幼麟四川麻将](https://github.com/babykylin/babykylin_scmj)。完整参考仓库不重复提交，已经确定复用的美术资源保存在 `mahjong-h5/client/public/assets/babykylin/`。
