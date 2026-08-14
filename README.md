# CMCC 好友麻将

面向手机浏览器的四人联机麻将项目。当前已完成 H5 联机大厅原型，麻将规则规格和牌桌素材已经整理，下一阶段接入发牌、回合状态机和吃碰杠胡。

## 当前进度

- 六位房间号、四人座位、准备状态和实时同步。
- 刷新或短暂掉线后恢复原座位。
- 房主可一键补齐测试玩家并开始测试对局。
- 服务端使用 TypeScript 和 WebSocket，客户端使用移动端 H5。
- 已整理幼麟四川麻将的牌桌背景、麻将牌和牌桌操作图集。
- 麻将规则文档位于 `deliverables/`。

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
- `deliverables/`：麻将规则需求规格文档。
- `sources/`：项目同步参考目录。

## 开源参考

房间管理、断线恢复和服务端裁决思路参考 [babykylin_scmj 幼麟四川麻将](https://github.com/babykylin/babykylin_scmj)。完整参考仓库不重复提交，已经确定复用的美术资源保存在 `mahjong-h5/client/public/assets/babykylin/`。
