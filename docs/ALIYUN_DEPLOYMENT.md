# 阿里云 ECS 临时联机测试部署记录

本文记录 Ubuntu 22.04 ECS 上已经走通的部署过程。当前方案用于多人联机测试，正式发布时应升级为后台进程、Nginx 和 HTTPS/WSS。

## 1. 确认服务器环境

通过阿里云 ECS 控制台的 Workbench 连接服务器，然后执行：

```bash
cat /etc/os-release
uname -m
whoami
```

本次服务器为 Ubuntu 22.04.5 LTS、x86_64、root 用户。

## 2. 安装基础工具

```bash
apt update
apt install -y git curl ca-certificates
```

安装 nvm：

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.6/install.sh | bash
```

加载 nvm 并安装 Node.js 24：

```bash
export NVM_DIR="/root/.nvm"; . "$NVM_DIR/nvm.sh"; nvm install 24; nvm alias default 24
```

安装 pnpm：

```bash
npm install -g pnpm
```

检查版本：

```bash
node -v
npm -v
pnpm -v
git --version
```

## 3. 下载、安装并测试项目

```bash
cd /opt
git clone https://github.com/lzy271713290/CMCCmahjong.git
cd /opt/CMCCmahjong/mahjong-h5
pnpm install --frozen-lockfile
pnpm test
```

八项自动测试全部通过后，启动服务：

```bash
cd /opt/CMCCmahjong/mahjong-h5
pnpm start
```

看到以下内容表示程序启动成功：

```text
麻将联机样板已启动：http://localhost:3000
```

当前是前台运行，终端不能关闭；按 `Ctrl+C` 会停止服务并清空内存中的房间。

## 4. Ubuntu 防火墙放行测试端口

检查 UFW：

```bash
ufw status
```

临时放行 TCP 3000：

```bash
ufw allow 3000/tcp comment 'CMCC mahjong temporary test'
```

检查本机服务：

```bash
curl -I http://127.0.0.1:3000
ss -lntp | grep ':3000'
```

应看到 HTTP 200，并且 `0.0.0.0:3000` 处于监听状态。

## 5. 阿里云安全组放行测试端口

在阿里云控制台进入：云服务器 ECS → 实例 → 对应安全组 → 入方向规则 → 增加规则。

填写：

```text
授权策略：允许
协议类型：自定义 TCP
目的端口：3000/3000
授权对象：0.0.0.0/0
描述：麻将临时联机测试
```

保存后，手机使用移动网络访问：

```text
http://服务器公网IP:3000
```

## 6. 四人联机测试方法

1. 一名玩家创建房间，将六位房间号发给朋友。
2. 另外三名玩家输入昵称和房间号加入。
3. 所有人点击准备，房主点击开始游戏。
4. 测试真人联机时不要点击“一键补齐测试玩家”，否则测试玩家会占满座位。
5. 分别测试刷新页面、切换网络、短暂离线后能否恢复座位。

## 7. 停止测试与关闭端口

在运行服务的终端按 `Ctrl+C`。然后关闭 Ubuntu 防火墙规则：

```bash
ufw delete allow 3000/tcp
```

同时在阿里云安全组中删除或禁用 TCP 3000 入方向规则。不要长期将测试端口暴露给 `0.0.0.0/0`。

## 8. 后续更新服务器代码

先停止正在运行的服务，然后执行：

```bash
cd /opt/CMCCmahjong
git pull
cd mahjong-h5
pnpm install --frozen-lockfile
pnpm test
pnpm start
```

如果依赖没有变化，`pnpm install` 会很快完成。服务重启后，原来只存在内存中的房间不会保留。

## 9. 正式部署待办

- 创建非 root 运行用户。
- 使用 PM2 或 systemd 保持服务后台运行和开机启动。
- 使用 Nginx 反向代理 WebSocket。
- 配置域名、HTTPS 和 WSS。
- 仅对公网开放 80/443，关闭直接暴露的 3000 端口。
- 房间状态迁移到 Redis，长期数据使用数据库保存。

## 10. 排查房间问题时提取日志

服务启动后会同时将结构化日志输出到终端和以下文件：

```text
/opt/CMCCmahjong/mahjong-h5/logs/server.jsonl
```

查看最近 200 行：

```bash
cd /opt/CMCCmahjong/mahjong-h5
tail -n 200 logs/server.jsonl
```

只看失败请求：

```bash
grep '"event":"request_failed"' logs/server.jsonl | tail -n 50
```

只看服务启动、创建房间和加入房间：

```bash
grep -E '"event":"(server_started|room_created|room_joined|room_reconnected)"' logs/server.jsonl | tail -n 100
```

验证最小牌局模型是否成功初始化：

```bash
grep '"event":"game_model_initialized"' logs/server.jsonl | tail -n 20
```

正常 JSON 日志应包含 `"modelVersion":"minimal-v1"`、`"wallRemaining":83` 和 `"totalTiles":136`；`handTileCounts` 中应恰好一家14张、三家13张。日志不会记录具体手牌。

从开发电脑对公网服务执行完整 WebSocket 冒烟测试：

```bash
cd mahjong-h5
node scripts/websocket-smoke.mjs ws://服务器公网IP:3000/ws
```

命令退出码为0，并返回 `"gamePhase":"playing"`、`"wallRemaining":83` 以及一家14张/三家13张的 `handTileCounts`，表示最小模型公网流程通过。

日志包含服务实例 ID、进程 PID、房间号、人数、操作和错误码，不记录玩家身份令牌。把相关行复制出来即可协助定位“服务是否重启”“请求是否进入同一实例”“房间为何不存在”等问题。
