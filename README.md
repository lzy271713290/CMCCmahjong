# CMCC 好友麻将

面向手机浏览器的四人联机麻将项目。当前已完成 H5 联机大厅和最小牌局模型验证，麻将规则规格和牌桌素材已经整理，下一阶段接入摸牌、出牌和回合状态机。

## 当前进度

- 六位房间号、四人座位、准备状态和实时同步。
- 刷新或短暂掉线后恢复原座位。
- 房主可一键补齐测试玩家并开始测试对局。
- 已接入最小牌局模型：136张牌、洗牌、随机庄家、四人发牌和牌张守恒校验。
- 开局页面会显示庄家、各座位手牌数量和剩余牌墙，服务端同步记录结构化监控日志。
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
- `sources/`：项目同步参考目录。

## 开源参考

房间管理、断线恢复和服务端裁决思路参考 [babykylin_scmj 幼麟四川麻将](https://github.com/babykylin/babykylin_scmj)。完整参考仓库不重复提交，已经确定复用的美术资源保存在 `mahjong-h5/client/public/assets/babykylin/`。
