# 阿里云 ECS 部署记录（IP 直连 + Redis + 进程守护）

当前方案使用公网 IP 直连 3000 端口，不配置域名。房间状态每 2 秒写入 Redis，服务由 PM2 或 systemd 守护，进程崩溃或服务器重启后会自动拉起并恢复房间。

## 1. 确认服务器环境

通过阿里云 ECS 控制台的 Workbench 连接服务器，然后执行：

```bash
cat /etc/os-release
uname -m
whoami
```

本次目标服务器为 Ubuntu 22.04 LTS、x86_64、root 用户。

## 2. 安装基础工具与 Node.js

```bash
apt update
apt install -y git curl ca-certificates redis-server
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

## 3. 启动并保护 Redis

```bash
systemctl enable --now redis-server
redis-cli ping
```

应返回 `PONG`。给 Redis 设置密码并只允许本机访问：

```bash
redis-cli CONFIG SET requirepass '你的Redis密码'
redis-cli CONFIG REWRITE
systemctl restart redis-server
redis-cli -a '你的Redis密码' ping
```

确认 Redis 没有监听公网：

```bash
ss -lntp | grep 6379
```

正常情况下只应看到 `127.0.0.1:6379`。不需要在安全组或 UFW 中放行 6379。项目读取的地址为：

```text
redis://:你的Redis密码@127.0.0.1:6379
```

如果不设密码，则为 `redis://127.0.0.1:6379`。

## 4. 下载、安装并测试项目

```bash
cd /opt
git clone https://github.com/lzy271713290/CMCCmahjong.git
cd /opt/CMCCmahjong/mahjong-h5
pnpm install --frozen-lockfile
pnpm test
pnpm run build
```

自动测试应全部通过，当前版本为 `persist-control-v17`。

## 5. 使用 PM2 启动并开机自启

仓库已提供 `mahjong-h5/ecosystem.config.cjs`。安装 PM2：

```bash
npm install -g pm2
```

启动服务：

```bash
cd /opt/CMCCmahjong/mahjong-h5
ADMIN_TOKEN=你的后台令牌 REDIS_URL=redis://:你的Redis密码@127.0.0.1:6379 pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd
```

`pm2 startup systemd` 会打印一条命令，复制执行一次即可开机自启。查看状态：

```bash
pm2 status
pm2 logs cmcc-mahjong --lines 100
```

### 使用 systemd 的替代方案

仓库已提供 `deploy/cmccmahjong.service`。先编辑其中的 `ADMIN_TOKEN` 和 Redis 地址：

```bash
cp /opt/CMCCmahjong/deploy/cmccmahjong.service /etc/systemd/system/cmccmahjong.service
nano /etc/systemd/system/cmccmahjong.service
systemctl daemon-reload
systemctl enable --now cmccmahjong
```

两者任选其一，不要同时启动两套守护进程，避免端口冲突。

## 6. 放行公网 3000 端口

当前不需要域名，直接使用公网 IP 访问。检查 UFW：

```bash
ufw status
ufw allow 3000/tcp comment 'CMCC mahjong'
```

在阿里云控制台进入：云服务器 ECS → 实例 → 对应安全组 → 入方向规则 → 增加规则，放行：

```text
授权策略：允许
协议类型：自定义 TCP
目的端口：3000/3000
授权对象：0.0.0.0/0
描述：麻将公网联机
```

## 7. 验收当前版本

无需创建房间即可确认版本、实例和持久化模式：

```bash
curl -s http://127.0.0.1:3000/healthz
```

应返回 `"modelVersion":"persist-control-v17"`、`"persistence":"redis"`、8位 `instanceId` 和运行秒数。

后台管理使用令牌保护：

```bash
ADMIN_TOKEN=你的后台令牌 node scripts/admin-smoke.mjs http://127.0.0.1:3000 你的后台令牌 persist-control-v17
```

从公司电脑对公网服务执行完整冒烟：

```bash
cd mahjong-h5
node scripts/websocket-smoke.mjs ws://服务器公网IP:3000/ws persist-control-v17
node scripts/admin-smoke.mjs http://服务器公网IP:3000 你的后台令牌 persist-control-v17
node scripts/full-round-smoke.mjs ws://服务器公网IP:3000/ws persist-control-v17
```

后台冒烟会额外验证管理员公告送达和强制解散后房间清空。手机访问：

```text
http://服务器公网IP:3000
```

## 8. 验证 Redis 持久化与重启恢复

先创建一个正在进行的房间并进入牌局，然后执行：

```bash
pm2 restart cmcc-mahjong
```

重启后登录同一房间的玩家应能直接恢复原座位；后台房间列表应继续显示该房间。Redis 中的房间数据保存在键 `cmcc:mahjong:rooms:v1`：

```bash
redis-cli -a '你的Redis密码' --no-auth-warning GET cmcc:mahjong:rooms:v1 | head -c 300
```

服务每 2 秒保存一次快照，因此极端情况下崩溃最多丢失约 2 秒内的房间操作。未配置 `REDIS_URL` 时仍可运行，但房间只保存在内存中。

## 9. 后台管理操作

后台页面：`http://服务器公网IP:3000/admin?token=你的后台令牌`。

- 概览：房间数、进行中/等待中、在线真人、测试玩家、WebSocket 连接数。
- 房间列表：状态、人数、局数、牌墙、阶段、动作数、房主。
- 房间详情：玩家连接/托管状态、公开牌桌状态、最近公共动作。
- 管理操作：向房间内玩家发送公告；强制解散房间，所有玩家会收到提示并返回大厅。

接口也支持直接调用：

```bash
curl -X POST 'http://127.0.0.1:3000/api/admin/rooms/123456/actions?token=你的后台令牌'   -H 'content-type: application/json'   -d '{"action":"announce","message":"维护公告"}'

curl -X POST 'http://127.0.0.1:3000/api/admin/rooms/123456/actions?token=你的后台令牌'   -H 'content-type: application/json'   -d '{"action":"force_close","reason":"维护强制解散"}'
```

## 10. 日志与排障

服务日志仍写入 `/opt/CMCCmahjong/mahjong-h5/logs/server.jsonl`。PM2 另写 `logs/pm2-out.log` 和 `logs/pm2-error.log`：

```bash
cd /opt/CMCCmahjong/mahjong-h5
tail -n 200 logs/server.jsonl
pm2 logs cmcc-mahjong --lines 200
```

查看 Redis 连接与房间恢复事件：

```bash
grep -E '"event":"(redis_connected|rooms_restored|room_persist_failed|redis_bootstrap_failed|admin_force_close|admin_announce)"' logs/server.jsonl | tail -n 100
```

## 11. 更新服务器代码

```bash
cd /opt/CMCCmahjong
git pull --ff-only origin main
cd mahjong-h5
pnpm install --frozen-lockfile
pnpm test
pnpm run build
pm2 restart cmcc-mahjong --update-env
```

如果使用 systemd：

```bash
systemctl restart cmccmahjong
```

重启不会清空 Redis 中的房间；已保存的房间会在服务启动时自动恢复。
