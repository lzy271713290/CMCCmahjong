import WebSocket from "ws";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const httpBaseUrl = (args[0] ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const token = args[1] ?? process.env.ADMIN_TOKEN;
const expectedVersion = args[2] ?? "ui-voice-v18";

if (!token) throw new Error("缺少 ADMIN_TOKEN");

async function checkedJson(response, label) {
  if (!response.ok) throw new Error(label + " 返回 " + response.status);
  const body = await response.json();
  if (body.ok === false) throw new Error(label + " 返回错误：" + body.code + " " + body.message);
  return body;
}

function openSocket() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(httpBaseUrl.replace(/^http/, "ws") + "/ws");
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextMessage(socket, type, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等待消息超时")), 10_000);
    const receive = (data) => {
      const message = JSON.parse(data.toString());
      if (message.type !== type || !predicate(message)) return;
      clearTimeout(timer);
      socket.off("message", receive);
      resolve(message);
    };
    socket.on("message", receive);
  });
}

let socket;
let roomCode;
let detail;
let summaryAfter;
let health;
try {
  health = await checkedJson(await fetch(httpBaseUrl + "/healthz"), "健康检查");
  if (health.modelVersion !== expectedVersion) throw new Error("模型版本不匹配：" + health.modelVersion);
  if (typeof health.roomCount !== "number") throw new Error("健康检查缺少 roomCount");

  const page = await fetch(httpBaseUrl + "/admin?token=" + encodeURIComponent(token));
  if (!page.ok) throw new Error("后台页面返回 " + page.status);
  const pageHtml = await page.text();
  if (!pageHtml.includes("CMCC 后台监控")) throw new Error("后台页面内容不完整");

  const unauthorized = await fetch(httpBaseUrl + "/api/admin/summary");
  if (unauthorized.status !== 401) throw new Error("无令牌访问应返回 401，实际 " + unauthorized.status);

  await checkedJson(await fetch(httpBaseUrl + "/api/admin/summary?token=" + encodeURIComponent(token)), "后台概览");

  socket = await openSocket();
  const createdWait = nextMessage(socket, "session");
  socket.send(JSON.stringify({ type: "create_room", name: "后台冒烟", totalRounds: 8, startScore: 150 }));
  const created = await createdWait;
  roomCode = created.roomCode;

  summaryAfter = await checkedJson(await fetch(httpBaseUrl + "/api/admin/summary?token=" + encodeURIComponent(token)), "创建房间后的后台概览");
  const room = summaryAfter.rooms.find((candidate) => candidate.code === roomCode);
  if (!room || room.playerCount !== 1 || room.phase !== "waiting") throw new Error("后台未正确显示新建房间");

  detail = await checkedJson(await fetch(httpBaseUrl + "/api/admin/rooms/" + roomCode + "?token=" + encodeURIComponent(token)), "房间详情");
  const serialized = JSON.stringify(detail.room);
  if (/playerToken|selfHand|selfDrawnTile/.test(serialized)) throw new Error("房间详情泄露私有字段");
  if (detail.room.players[0]?.name !== "后台冒烟") throw new Error("房间详情玩家信息异常");

  const missing = await fetch(httpBaseUrl + "/api/admin/rooms/000000?token=" + encodeURIComponent(token));
  if (missing.status !== 404) throw new Error("不存在的房间应返回 404，实际 " + missing.status);

  const announceResponse = await fetch(httpBaseUrl + "/api/admin/rooms/" + roomCode + "/actions?token=" + encodeURIComponent(token), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "announce", message: "后台冒烟公告" }),
  });
  const announceBody = await checkedJson(announceResponse, "发送管理员公告");
  if (announceBody.recipients < 1 || announceBody.message !== "后台冒烟公告") throw new Error("管理员公告未正确送达");

  const closedWait = nextMessage(socket, "room_closed");
  const forceResponse = await fetch(httpBaseUrl + "/api/admin/rooms/" + roomCode + "/actions?token=" + encodeURIComponent(token), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "force_close", reason: "冒烟测试强制解散" }),
  });
  const forceBody = await checkedJson(forceResponse, "强制解散房间");
  if (forceBody.roomCode !== roomCode || forceBody.playerSeats.length < 1) throw new Error("强制解散结果异常");
  const closedMessage = await closedWait;
  if (closedMessage.roomCode !== roomCode || !closedMessage.reason) throw new Error("客户端未收到房间解散消息");

  const summaryAfterClose = await checkedJson(await fetch(httpBaseUrl + "/api/admin/summary?token=" + encodeURIComponent(token)), "解散后的后台概览");
  if (summaryAfterClose.rooms.some((room) => room.code === roomCode)) throw new Error("强制解散后房间仍存在");

  const result = {
    httpBaseUrl,
    modelVersion: health.modelVersion,
    startScore: detail.room.match?.startScore,
    roomCount: summaryAfter.roomCount,
    waitingRoomCount: summaryAfter.waitingRoomCount,
    connectedSockets: summaryAfter.connectedSockets,
    roomCode,
    roomPhase: room.phase,
    playerCount: detail.room.players.length,
    privacyFree: !/playerToken|selfHand|selfDrawnTile/.test(serialized),
    announceRecipients: announceBody.recipients,
    forceClosed: forceBody.roomCode === roomCode,
    clientNotified: closedMessage.roomCode === roomCode && Boolean(closedMessage.reason),
    roomClearedAfterClose: !summaryAfterClose.rooms.some((room) => room.code === roomCode),
  };
  console.log(JSON.stringify(result));
  if (
    result.modelVersion !== expectedVersion ||
    result.startScore !== 150 ||
    result.roomCount < 1 ||
    result.waitingRoomCount < 1 ||
    result.connectedSockets < 1 ||
    result.roomPhase !== "waiting" ||
    result.playerCount !== 1 ||
    !result.privacyFree ||
    result.announceRecipients < 1 ||
    !result.forceClosed ||
    !result.clientNotified ||
    !result.roomClearedAfterClose
  ) {
    process.exitCode = 1;
  }
} finally {
  if (socket && socket.readyState === socket.OPEN) socket.close();
}
