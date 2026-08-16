import { createReadStream, existsSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { extname, isAbsolute, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "../../shared/protocol.js";
import { RoomError, RoomManager, TEST_PLAYER_TURN_MS, type Session } from "./room-manager.js";
import { RoomStore } from "./room-store.js";
import { instanceId, logError, logInfo, logWarn, shortId } from "./logger.js";
import { GAME_MODEL_VERSION } from "./game-model.js";

const port = Number(process.env.PORT ?? process.argv[2] ?? 3000);
const adminToken = process.env.ADMIN_TOKEN;
const roomStore = new RoomStore(process.env.REDIS_URL);
const manager = new RoomManager(undefined, undefined, undefined, roomStore, { testPlayerTurnMs: TEST_PLAYER_TURN_MS });
const socketsByToken = new Map<string, WebSocket>();
const sessionsBySocket = new Map<WebSocket, { roomCode: string; playerToken: string; seat?: number }>();
const projectRoot = fileURLToPath(new URL("../../..", import.meta.url));
const publicAssetsRoot = join(projectRoot, "client/public/assets");

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
};

function adminAuthorized(request: IncomingMessage): boolean {
  if (!adminToken) return false;
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.searchParams.get("token") === adminToken) return true;
  return request.headers.authorization === `Bearer ${adminToken}`;
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error("请求体过大"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function adminSummaryPayload() {
  return {
    ok: true,
    modelVersion: GAME_MODEL_VERSION,
    persistence: roomStore.enabled ? "redis" : "memory",
    instanceId,
    pid: process.pid,
    port,
    uptimeSeconds: Math.floor(process.uptime()),
    nodeVersion: process.version,
    connectedSockets: webSockets.clients.size,
    ...manager.adminStats(),
    rooms: manager.listAdminRooms(),
  };
}

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (pathname === "/healthz") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify({ ok: true, modelVersion: GAME_MODEL_VERSION, persistence: roomStore.enabled ? "redis" : "memory", instanceId, uptimeSeconds: Math.floor(process.uptime()), roomCount: manager.adminStats().roomCount, connectedSockets: webSockets.clients.size }));
    return;
  }
  let filePath: string | undefined;
  if (pathname === "/admin" || pathname === "/admin.html") {
    if (!adminToken) {
      response.writeHead(503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: false, code: "ADMIN_DISABLED", message: "未配置 ADMIN_TOKEN，后台管理已关闭" }));
      return;
    }
    filePath = join(projectRoot, "client/public/admin.html");
  } else if (pathname === "/api/admin/summary") {
    if (!adminAuthorized(request)) {
      response.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: false, code: "ADMIN_UNAUTHORIZED", message: "后台令牌无效" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify(adminSummaryPayload()));
    return;
  } else if (request.method === "POST" && /^\/api\/admin\/rooms\/[^/]+\/actions$/.test(pathname)) {
    if (!adminAuthorized(request)) {
      response.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: false, code: "ADMIN_UNAUTHORIZED", message: "后台令牌无效" }));
      return;
    }
    const roomMatch = /^\/api\/admin\/rooms\/([^/]+)\/actions$/.exec(pathname);
    if (!roomMatch?.[1]) {
      response.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: false, code: "BAD_ROOM", message: "房间号无效" }));
      return;
    }
    const roomCode = decodeURIComponent(roomMatch[1]);
    let body: Record<string, unknown>;
    try {
      body = (await readJsonBody(request)) as Record<string, unknown>;
    } catch {
      response.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: false, code: "BAD_JSON", message: "管理操作请求体必须是 JSON" }));
      return;
    }
    try {
      const action = typeof body.action === "string" ? body.action : "";
      if (action === "force_close") {
        const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 80) : "管理员强制解散房间";
        const result = manager.forceCloseRoomByAdmin(roomCode, reason);
        notifyRoomClosed(result.roomCode, result.reason);
        logInfo("admin_force_close", { roomCode: result.roomCode, reason: result.reason, playerSeats: result.playerSeats.join(",") });
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ ok: true, roomCode: result.roomCode, reason: result.reason, playerSeats: result.playerSeats }));
      } else if (action === "announce") {
        const messageText = typeof body.message === "string" ? body.message.trim().slice(0, 200) : "";
        if (!messageText) throw new RoomError("ANNOUNCE_REQUIRED", "公告内容不能为空");
        const recipients = announceToRoom(roomCode, messageText);
        logInfo("admin_announce", { roomCode, recipients, messageLength: messageText.length });
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ ok: true, roomCode, recipients, message: messageText }));
      } else {
        throw new RoomError("ADMIN_ACTION_INVALID", "不支持的管理操作");
      }
    } catch (error) {
      const code = error instanceof RoomError ? error.code : "BAD_ACTION";
      const message = error instanceof Error ? error.message : "管理操作失败";
      response.writeHead(code === "ROOM_NOT_FOUND" ? 404 : 400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: false, code, message }));
    }
    return;
  } else if (pathname.startsWith("/api/admin/rooms/")) {
    if (!adminAuthorized(request)) {
      response.writeHead(401, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: false, code: "ADMIN_UNAUTHORIZED", message: "后台令牌无效" }));
      return;
    }
    const roomCode = decodeURIComponent(pathname.slice("/api/admin/rooms/".length));
    try {
      const room = manager.getAdminRoom(roomCode);
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: true, room }));
    } catch (error) {
      const code = error instanceof RoomError ? error.code : "BAD_ROOM";
      response.writeHead(code === "ROOM_NOT_FOUND" ? 404 : 400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: false, code, message: error instanceof Error ? error.message : "房间查询失败" }));
    }
    return;
  }
  if (pathname === "/app.js") filePath = join(projectRoot, "dist/client/src/app.js");
  else if (pathname === "/voice-channel.js") filePath = join(projectRoot, "dist/client/src/voice-channel.js");
  else if (pathname === "/audio-manager.js") filePath = join(projectRoot, "dist/client/src/audio-manager.js");
  else if (pathname === "/public-replay.js") filePath = join(projectRoot, "dist/client/src/public-replay.js");
  else if (pathname === "/styles.css") filePath = join(projectRoot, "client/public/styles.css");
  else if (pathname === "/" || pathname === "/index.html") filePath = join(projectRoot, "client/public/index.html");
  else if (pathname.startsWith("/assets/")) {
    try {
      const assetRelativePath = normalize(decodeURIComponent(pathname.slice("/assets/".length))).replace(/^[/\\]+/, "");
      const avatarAlias = /^avatars[\\/]avatar-a(\d+)\.svg$/.exec(assetRelativePath);
      const resolvedAssetRelativePath = avatarAlias ? `avatars/avatar-${avatarAlias[1]}.svg` : assetRelativePath;
      const assetPath = join(publicAssetsRoot, resolvedAssetRelativePath);
      const pathFromAssets = relative(publicAssetsRoot, assetPath);
      if (!pathFromAssets.startsWith("..") && !isAbsolute(pathFromAssets)) filePath = assetPath;
    } catch {
      response.writeHead(400).end("Bad asset path");
      return;
    }
  }
  if (!filePath) {
    response.writeHead(404).end("Not found");
    return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404).end("Not found");
    return;
  }
  response.writeHead(200, { "content-type": mimeTypes[extname(filePath)] ?? "application/octet-stream", "cache-control": "no-store" });
  createReadStream(filePath).pipe(response);
});

const webSockets = new WebSocketServer({ server, path: "/ws" });

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function broadcast(roomCode: string): void {
  for (const [socket, session] of sessionsBySocket) {
    if (session.roomCode === roomCode) {
      let seat: number | undefined;
      try {
        seat = manager.participant(roomCode, session.playerToken).seat;
      } catch {
        // 玩家/观战者可能刚离开，下一帧连接会被清理。
      }
      sessionsBySocket.set(socket, { ...session, seat });
      send(socket, { type: "snapshot", snapshot: manager.snapshotForPlayer(roomCode, session.playerToken) });
    }
  }
}

function notifyRoomClosed(roomCode: string, reason: string): void {
  const socketsToClose: WebSocket[] = [];
  for (const [socket, session] of sessionsBySocket) {
    if (session.roomCode !== roomCode) continue;
    send(socket, { type: "room_closed", roomCode, reason });
    socketsToClose.push(socket);
  }
  for (const socket of socketsToClose) {
    const session = sessionsBySocket.get(socket);
    if (session) {
      sessionsBySocket.delete(socket);
      if (socketsByToken.get(session.playerToken) === socket) socketsByToken.delete(session.playerToken);
    }
    socket.close(4001, "room_closed");
  }
}

function relayVoice(roomCode: string, sender: WebSocket, payload: Extract<ServerMessage, { type: "voice_audio" }>): void {
  let recipients = 0;
  for (const [socket, session] of sessionsBySocket) {
    if (session.roomCode !== roomCode || socket === sender || socket.readyState !== socket.OPEN) continue;
    socket.send(JSON.stringify(payload));
    recipients += 1;
  }
  if (recipients > 0) logInfo("voice_relayed", { roomCode, fromSeat: payload.fromSeat, recipients });
}

function broadcastVoiceState(roomCode: string, fromSeat: number, micOn: boolean, speakerOn: boolean): void {
  const payload: ServerMessage = { type: "voice_state", fromSeat, micOn, speakerOn };
  for (const [socket, session] of sessionsBySocket) {
    if (session.roomCode !== roomCode) continue;
    send(socket, payload);
  }
}

function broadcastChatMessage(roomCode: string, sender: { id: string; name: string; avatar: string; seat?: number }, text: string): void {
  const payload: ServerMessage = { type: "chat_message", fromSeat: sender.seat, fromId: sender.id, fromName: sender.name, fromAvatar: sender.avatar, text: text.slice(0, 200) };
  for (const [socket, session] of sessionsBySocket) {
    if (session.roomCode !== roomCode) continue;
    send(socket, payload);
  }
}

function broadcastChatEmote(roomCode: string, sender: { id: string; name: string; avatar: string; seat?: number }, emote: string, toSeat?: number): void {
  const payload: ServerMessage = { type: "chat_emote", fromSeat: sender.seat, fromId: sender.id, fromName: sender.name, fromAvatar: sender.avatar, emote: emote.slice(0, 24), toSeat };
  for (const [socket, session] of sessionsBySocket) {
    if (session.roomCode !== roomCode) continue;
    send(socket, payload);
  }
}

function announceToRoom(roomCode: string, messageText: string): number {
  let recipients = 0;
  for (const [socket, session] of sessionsBySocket) {
    if (session.roomCode === roomCode) {
      send(socket, { type: "room_announcement", message: messageText });
      recipients += 1;
    }
  }
  return recipients;
}

function bindSession(socket: WebSocket, session: Session, connectionId: string, event: "room_created" | "room_joined" | "room_reconnected"): void {
  const oldSocket = socketsByToken.get(session.playerToken);
  if (oldSocket && oldSocket !== socket) oldSocket.close(4001, "已在新连接恢复");
  socketsByToken.set(session.playerToken, socket);
  const boundSeat = session.role === "spectator" ? undefined : session.snapshot.players.find((player) => player.id === session.playerId)?.seat;
  sessionsBySocket.set(socket, { roomCode: session.roomCode, playerToken: session.playerToken, seat: boundSeat });
  send(socket, { type: "session", ...session });
  broadcast(session.roomCode);
  logInfo(event, {
    connectionId,
    roomCode: session.roomCode,
    playerId: shortId(session.playerId),
    playerCount: session.snapshot.players.length,
    revision: session.snapshot.revision,
    phase: session.snapshot.phase,
    totalRounds: session.snapshot.match.totalRounds,
    completedRounds: session.snapshot.match.completedRounds,
  });
  if (event === "room_reconnected" && session.snapshot.game?.selfHand) {
    logInfo("private_hand_restored", {
      connectionId,
      roomCode: session.roomCode,
      playerId: shortId(session.playerId),
      seat: session.snapshot.game.viewerSeat,
      handTileCount: session.snapshot.game.selfHand.length,
      roundNumber: session.snapshot.game.roundNumber,
    });
  }
  if (event === "room_reconnected" && session.autoManagementReleased) {
    logInfo("auto_management_ended", {
      connectionId,
      roomCode: session.roomCode,
      playerId: shortId(session.playerId),
      seat: session.snapshot.game?.viewerSeat,
      reason: "player_reconnected",
      revision: session.snapshot.revision,
    });
  }
}

function requireSession(socket: WebSocket): { roomCode: string; playerToken: string; seat?: number } {
  const session = sessionsBySocket.get(socket);
  if (!session) throw new RoomError("SESSION_REQUIRED", "请先创建或加入房间");
  return session;
}

function logMatchEndedIfNeeded(snapshot: Session["snapshot"], connectionId: string, roomCode: string): void {
  if (snapshot.match.status !== "completed") return;
  logInfo("match_ended", {
    connectionId,
    roomCode,
    endReason: snapshot.match.endReason,
    completedRounds: snapshot.match.completedRounds,
    totalRounds: snapshot.match.totalRounds,
    scoreTotals: snapshot.scoreTotals.join(","),
    rankings: snapshot.match.rankings?.map((ranking) => `${ranking.rank}:${ranking.seat}:${ranking.score}`).join(","),
    revision: snapshot.revision,
  });
}

function logPublicTimelineCheckpointIfRoundEnded(snapshot: Session["snapshot"], connectionId: string, roomCode: string): void {
  if (snapshot.game?.stage !== "round_ended") return;
  const latest = snapshot.publicActions.at(-1);
  logInfo("public_timeline_checkpoint", {
    connectionId,
    roomCode,
    roundNumber: snapshot.game.roundNumber,
    publicActionCount: snapshot.publicActions.length,
    latestSequence: latest?.sequence,
    latestAction: latest?.kind,
    privacyMode: "public_actions_only",
    revision: snapshot.revision,
  });
}

webSockets.on("connection", (socket) => {
  const connectionId = randomUUID().slice(0, 8);
  logInfo("websocket_connected", { connectionId });

  socket.on("message", (data) => {
    let action = "unknown";
    let requestedRoomCode: string | undefined;
    try {
      const message = JSON.parse(data.toString()) as ClientMessage;
      action = message.type;
      requestedRoomCode = "roomCode" in message ? message.roomCode : undefined;
      switch (message.type) {
        case "create_room": {
          const session = manager.createRoom(message.name, message.totalRounds, message.startScore, message.avatar);
          bindSession(socket, session, connectionId, "room_created");
          break;
        }
        case "join_room": {
          const session = manager.joinRoom(message.roomCode, message.name, message.avatar, message.asSpectator === true);
          bindSession(socket, session, connectionId, "room_joined");
          break;
        }
        case "update_avatar": {
          const session = requireSession(socket);
          const snapshot = manager.updateAvatar(session.roomCode, session.playerToken, message.avatar);
          broadcast(session.roomCode);
          logInfo("avatar_updated", { connectionId, roomCode: session.roomCode, seat: session.seat, revision: snapshot.revision });
          break;
        }
        case "request_seat": {
          const session = requireSession(socket);
          const snapshot = manager.requestSeat(session.roomCode, session.playerToken);
          broadcast(session.roomCode);
          logInfo("seat_requested", { connectionId, roomCode: session.roomCode, revision: snapshot.revision });
          break;
        }
        case "promote_spectator": {
          const session = requireSession(socket);
          const snapshot = manager.promoteSpectator(session.roomCode, session.playerToken, message.spectatorId);
          broadcast(session.roomCode);
          logInfo("spectator_promoted", { connectionId, roomCode: session.roomCode, spectatorId: shortId(message.spectatorId), revision: snapshot.revision });
          break;
        }
        case "reconnect": {
          const session = manager.reconnect(message.roomCode, message.playerToken);
          bindSession(socket, session, connectionId, "room_reconnected");
          break;
        }
        case "leave_room": {
          const session = requireSession(socket);
          const result = manager.leaveRoom(session.roomCode, session.playerToken);
          sessionsBySocket.delete(socket);
          if (socketsByToken.get(session.playerToken) === socket) socketsByToken.delete(session.playerToken);
          send(socket, { type: "left_room" });
          if (!result.deleted) broadcast(session.roomCode);
          logInfo("room_left", {
            connectionId,
            roomCode: session.roomCode,
            playerId: shortId(result.playerId),
            seat: result.seat,
            wasHost: result.wasHost,
            hostTransferred: Boolean(result.nextHostPlayerId),
            roomDeleted: result.deleted,
            playerCount: result.snapshot?.players.length ?? 0,
            revision: result.snapshot?.revision,
          });
          break;
        }
        case "set_ready": {
          const session = requireSession(socket);
          const snapshot = manager.setReady(session.roomCode, session.playerToken, Boolean(message.ready));
          broadcast(session.roomCode);
          logInfo("ready_changed", { connectionId, roomCode: session.roomCode, ready: Boolean(message.ready), revision: snapshot.revision });
          break;
        }
        case "fill_test_players": {
          const session = requireSession(socket);
          const snapshot = manager.fillWithTestPlayers(session.roomCode, session.playerToken);
          broadcast(session.roomCode);
          logInfo("test_players_filled", { connectionId, roomCode: session.roomCode, playerCount: snapshot.players.length, revision: snapshot.revision });
          break;
        }
        case "remove_test_players": {
          const session = requireSession(socket);
          const { snapshot, removedCount } = manager.removeTestPlayers(session.roomCode, session.playerToken);
          broadcast(session.roomCode);
          logInfo("test_players_removed", {
            connectionId,
            roomCode: session.roomCode,
            removedCount,
            playerCount: snapshot.players.length,
            revision: snapshot.revision,
          });
          break;
        }
        case "start_game": {
          const session = requireSession(socket);
          const snapshot = manager.startGame(session.roomCode, session.playerToken);
          broadcast(session.roomCode);
          logInfo("game_model_initialized", {
            connectionId,
            roomCode: session.roomCode,
            modelVersion: snapshot.game?.modelVersion,
            roundNumber: snapshot.game?.roundNumber,
            dealerSeat: snapshot.game?.dealerSeat,
            turnSeat: snapshot.game?.turnSeat,
            stage: snapshot.game?.stage,
            wallRemaining: snapshot.game?.wallRemaining,
            handTileCounts: snapshot.game?.handTileCounts.join(","),
            totalTiles: (snapshot.game?.wallRemaining ?? 0) + (snapshot.game?.handTileCounts.reduce((sum, count) => sum + count, 0) ?? 0),
            playerCount: snapshot.players.length,
            revision: snapshot.revision,
          });
          logInfo("private_hands_distributed", {
            connectionId,
            roomCode: session.roomCode,
            recipientCount: snapshot.players.length,
            handTileCounts: snapshot.game?.handTileCounts.join(","),
            privacyMode: "self_hand_only",
            revision: snapshot.revision,
          });
          logInfo("game_started", { connectionId, roomCode: session.roomCode, playerCount: snapshot.players.length, revision: snapshot.revision });
          break;
        }
        case "voice_audio": {
          const session = requireSession(socket);
          if (session.seat === undefined) throw new RoomError("SPECTATOR_NOT_ALLOWED", "观战者不能发送语音");
          if (typeof message.data !== "string" || !message.data || typeof message.mimeType !== "string") {
            throw new RoomError("VOICE_INVALID", "语音数据格式无效");
          }
          relayVoice(session.roomCode, socket, {
            type: "voice_audio",
            fromSeat: session.seat,
            data: message.data.slice(0, 512 * 1024),
            mimeType: message.mimeType.slice(0, 120),
          });
          break;
        }
        case "voice_state": {
          const session = requireSession(socket);
          if (session.seat === undefined) throw new RoomError("SPECTATOR_NOT_ALLOWED", "观战者不能操作语音");
          broadcastVoiceState(session.roomCode, session.seat, Boolean(message.micOn), Boolean(message.speakerOn));
          break;
        }
        case "chat_message": {
          const session = requireSession(socket);
          const text = typeof message.text === "string" ? message.text.trim() : "";
          if (!text) throw new RoomError("CHAT_EMPTY", "消息内容不能为空");
          const sender = manager.participant(session.roomCode, session.playerToken);
          broadcastChatMessage(session.roomCode, { ...sender, seat: session.seat }, text);
          break;
        }
        case "chat_emote": {
          const session = requireSession(socket);
          const emote = typeof message.emote === "string" ? message.emote.trim() : "";
          if (!emote) throw new RoomError("EMOTE_EMPTY", "表情不能为空");
          const sender = manager.participant(session.roomCode, session.playerToken);
          broadcastChatEmote(session.roomCode, { ...sender, seat: session.seat }, emote, typeof message.toSeat === "number" ? message.toSeat : undefined);
          break;
        }
        case "start_next_round": {
          const session = requireSession(socket);
          const snapshot = manager.startNextRound(session.roomCode, session.playerToken);
          broadcast(session.roomCode);
          logInfo("round_started", {
            connectionId,
            roomCode: session.roomCode,
            modelVersion: snapshot.game?.modelVersion,
            roundNumber: snapshot.game?.roundNumber,
            dealerSeat: snapshot.game?.dealerSeat,
            turnSeat: snapshot.game?.turnSeat,
            wallRemaining: snapshot.game?.wallRemaining,
            handTileCounts: snapshot.game?.handTileCounts.join(","),
            totalTiles: (snapshot.game?.wallRemaining ?? 0) + (snapshot.game?.handTileCounts.reduce((sum, count) => sum + count, 0) ?? 0),
            scoreTotals: snapshot.scoreTotals.join(","),
            completedRounds: snapshot.match.completedRounds,
            totalRounds: snapshot.match.totalRounds,
            privacyMode: "self_hand_only",
            revision: snapshot.revision,
          });
          break;
        }
        case "request_early_settlement": {
          const session = requireSession(socket);
          const { snapshot, diagnostics } = manager.requestEarlySettlement(session.roomCode, session.playerToken);
          broadcast(session.roomCode);
          logInfo("early_settlement_requested", {
            connectionId,
            roomCode: session.roomCode,
            requesterSeat: diagnostics.requesterSeat,
            status: diagnostics.status,
            approvedCount: diagnostics.approvedCount,
            waitingCount: diagnostics.waitingCount,
            autoApprovedCount: diagnostics.autoApprovedSeats.length,
            duringRound: snapshot.match.earlySettlement?.duringRound,
            completedRounds: snapshot.match.completedRounds,
            revision: snapshot.revision,
          });
          logMatchEndedIfNeeded(snapshot, connectionId, session.roomCode);
          break;
        }
        case "respond_early_settlement": {
          const session = requireSession(socket);
          const { snapshot, diagnostics } = manager.respondEarlySettlement(
            session.roomCode,
            session.playerToken,
            Boolean(message.agree),
          );
          broadcast(session.roomCode);
          logInfo("early_settlement_response", {
            connectionId,
            roomCode: session.roomCode,
            requesterSeat: diagnostics.requesterSeat,
            responderSeat: diagnostics.responderSeat,
            agree: diagnostics.agree,
            status: diagnostics.status,
            approvedCount: diagnostics.approvedCount,
            waitingCount: diagnostics.waitingCount,
            revision: snapshot.revision,
          });
          logMatchEndedIfNeeded(snapshot, connectionId, session.roomCode);
          break;
        }
        case "discard_tile": {
          const session = requireSession(socket);
          const result = manager.discardTile(session.roomCode, session.playerToken, message.tile);
          const { snapshot, diagnostics } = result;
          broadcast(session.roomCode);
          logInfo("tile_discarded", {
            connectionId,
            roomCode: session.roomCode,
            seat: diagnostics.initialDiscard.seat,
            tile: diagnostics.initialDiscard.tile,
            handTileCount: diagnostics.initialDiscard.handTileCount,
            wallRemaining: diagnostics.wallRemaining,
            nextStage: diagnostics.stage,
            revision: snapshot.revision,
          });
          for (const window of diagnostics.reactionWindows) {
            logInfo("reaction_options_calculated", {
              connectionId,
              roomCode: session.roomCode,
              discardSeat: window.discard.seat,
              eligibleSeatCount: window.eligibleSeats.length,
              optionCount: window.optionCount,
              autoPassedCount: window.autoPassedSeats.length,
              awaitingResponseCount: window.awaitingSeats.length,
              resolution: window.resolution,
              revision: snapshot.revision,
            });
            if (window.resolution === "advance_turn") {
              logInfo("reaction_window_resolved", {
                connectionId,
                roomCode: session.roomCode,
                discardSeat: window.discard.seat,
                resolution: "all_passed_or_no_options",
                revision: snapshot.revision,
              });
            }
          }
          for (const automatic of diagnostics.autoDiscards) {
            logInfo("test_player_auto_discarded", {
              connectionId,
              roomCode: session.roomCode,
              seat: automatic.seat,
              tile: automatic.tile,
              wallRemaining: automatic.wallRemaining,
              revision: snapshot.revision,
            });
          }
          logInfo("turn_advanced", {
            connectionId,
            roomCode: session.roomCode,
            nextTurnSeat: diagnostics.nextTurnSeat,
            nextHandTileCount: diagnostics.nextHandTileCount,
            wallRemaining: diagnostics.wallRemaining,
            automaticTurnCount: diagnostics.autoDiscards.length,
            stage: diagnostics.stage,
            revision: snapshot.revision,
          });
          logPublicTimelineCheckpointIfRoundEnded(snapshot, connectionId, session.roomCode);
          logMatchEndedIfNeeded(snapshot, connectionId, session.roomCode);
          break;
        }
        case "perform_turn_operation": {
          const session = requireSession(socket);
          const result = manager.performTurnOperation(session.roomCode, session.playerToken, message.operationId);
          const { snapshot, diagnostics } = result;
          broadcast(session.roomCode);
          logInfo("turn_operation_performed", {
            connectionId,
            roomCode: session.roomCode,
            seat: diagnostics.seat,
            operation: diagnostics.operation,
            tile: diagnostics.tile,
            wallRemaining: diagnostics.wallRemaining,
            stage: diagnostics.stage,
            revision: snapshot.revision,
          });
          if (diagnostics.reactionWindow) {
            logInfo("rob_kong_options_calculated", {
              connectionId,
              roomCode: session.roomCode,
              gangSeat: diagnostics.seat,
              eligibleSeatCount: diagnostics.reactionWindow.eligibleSeats.length,
              autoPassedCount: diagnostics.reactionWindow.autoPassedSeats.length,
              awaitingResponseCount: diagnostics.reactionWindow.awaitingSeats.length,
              resolution: diagnostics.reactionWindow.resolution,
              revision: snapshot.revision,
            });
          }
          if (diagnostics.meld) {
            logInfo("kong_completed", {
              connectionId,
              roomCode: session.roomCode,
              seat: diagnostics.meld.seat,
              meldKind: diagnostics.meld.kind,
              gangType: diagnostics.meld.gangType,
              specialType: diagnostics.meld.specialType,
              growthCount: diagnostics.meld.growthCount,
              wallRemaining: diagnostics.wallRemaining,
              revision: snapshot.revision,
            });
          }
          if (diagnostics.operation === "zimo") {
            logInfo("round_ended", {
              connectionId,
              roomCode: session.roomCode,
              reason: "self_draw_hu",
              winnerSeats: String(diagnostics.seat),
              winnerCount: 1,
              revision: snapshot.revision,
            });
          }
          if (diagnostics.scorePayments.length > 0) {
            logInfo("score_settled", {
              connectionId,
              roomCode: session.roomCode,
              trigger: diagnostics.operation,
              paymentCount: diagnostics.scorePayments.length,
              totalTransferred: diagnostics.scorePayments.reduce((sum, payment) => sum + payment.amount, 0),
              roundScoreDeltas: snapshot.game?.scoreDeltas.join(","),
              scoreTotals: snapshot.scoreTotals.join(","),
              revision: snapshot.revision,
            });
          }
          logPublicTimelineCheckpointIfRoundEnded(snapshot, connectionId, session.roomCode);
          logMatchEndedIfNeeded(snapshot, connectionId, session.roomCode);
          break;
        }
        case "react_to_discard": {
          const session = requireSession(socket);
          const result = manager.reactToDiscard(session.roomCode, session.playerToken, message.operationId);
          const { snapshot, diagnostics } = result;
          broadcast(session.roomCode);
          logInfo("reaction_response_received", {
            connectionId,
            roomCode: session.roomCode,
            responderSeat: diagnostics.responderSeat,
            operation: diagnostics.operationId === "pass" ? "pass" : diagnostics.operationId.split(":", 1)[0],
            resolution: diagnostics.resolution,
            revision: snapshot.revision,
          });
          if (diagnostics.resolution !== "waiting") {
            logInfo("reaction_window_resolved", {
              connectionId,
              roomCode: session.roomCode,
              resolution: diagnostics.resolution,
              revision: snapshot.revision,
            });
          }
          for (const window of diagnostics.reactionWindows) {
            logInfo("reaction_options_calculated", {
              connectionId,
              roomCode: session.roomCode,
              discardSeat: window.discard.seat,
              eligibleSeatCount: window.eligibleSeats.length,
              optionCount: window.optionCount,
              autoPassedCount: window.autoPassedSeats.length,
              awaitingResponseCount: window.awaitingSeats.length,
              resolution: window.resolution,
              revision: snapshot.revision,
            });
          }
          for (const automatic of diagnostics.autoDiscards) {
            logInfo("test_player_auto_discarded", {
              connectionId,
              roomCode: session.roomCode,
              seat: automatic.seat,
              tile: automatic.tile,
              wallRemaining: automatic.wallRemaining,
              revision: snapshot.revision,
            });
          }
          if (diagnostics.claimedMeld) {
            logInfo("meld_claimed", {
              connectionId,
              roomCode: session.roomCode,
              seat: diagnostics.claimedMeld.seat,
              meldKind: diagnostics.claimedMeld.kind,
              gangType: diagnostics.claimedMeld.gangType,
              specialType: diagnostics.claimedMeld.specialType,
              growthCount: diagnostics.claimedMeld.growthCount,
              fromSeat: diagnostics.claimedMeld.fromSeat,
              wallRemaining: diagnostics.wallRemaining,
              revision: snapshot.revision,
            });
          }
          if (diagnostics.resolution === "discard_hu" || diagnostics.resolution === "rob_kong_hu") {
            logInfo("round_ended", {
              connectionId,
              roomCode: session.roomCode,
              reason: diagnostics.resolution,
              winnerSeats: diagnostics.winningSeats.join(","),
              winnerCount: diagnostics.winningSeats.length,
              revision: snapshot.revision,
            });
          }
          if (diagnostics.scorePayments.length > 0) {
            logInfo("score_settled", {
              connectionId,
              roomCode: session.roomCode,
              trigger: diagnostics.resolution,
              paymentCount: diagnostics.scorePayments.length,
              totalTransferred: diagnostics.scorePayments.reduce((sum, payment) => sum + payment.amount, 0),
              roundScoreDeltas: snapshot.game?.scoreDeltas.join(","),
              scoreTotals: snapshot.scoreTotals.join(","),
              revision: snapshot.revision,
            });
          }
          logInfo("turn_advanced", {
            connectionId,
            roomCode: session.roomCode,
            nextTurnSeat: diagnostics.nextTurnSeat,
            wallRemaining: diagnostics.wallRemaining,
            automaticTurnCount: diagnostics.autoDiscards.length,
            stage: diagnostics.stage,
            revision: snapshot.revision,
          });
          logPublicTimelineCheckpointIfRoundEnded(snapshot, connectionId, session.roomCode);
          logMatchEndedIfNeeded(snapshot, connectionId, session.roomCode);
          break;
        }
        case "ping":
          send(socket, { type: "pong" });
          break;
        default:
          throw new RoomError("BAD_MESSAGE", "无法识别的操作");
      }
    } catch (error) {
      const code = error instanceof RoomError ? error.code : "BAD_MESSAGE";
      const message = error instanceof Error ? error.message : "请求格式错误";
      logWarn("request_failed", { connectionId, action, roomCode: requestedRoomCode, code, message });
      send(socket, { type: "error", code, message });
    }
  });

  socket.on("close", (code) => {
    const session = sessionsBySocket.get(socket);
    if (!session) {
      logInfo("websocket_closed", { connectionId, closeCode: code, hadSession: false });
      return;
    }
    sessionsBySocket.delete(socket);
    if (socketsByToken.get(session.playerToken) !== socket) {
      logInfo("websocket_closed", { connectionId, roomCode: session.roomCode, closeCode: code, replaced: true });
      return;
    }
    socketsByToken.delete(session.playerToken);
    manager.disconnect(session.roomCode, session.playerToken);
    broadcast(session.roomCode);
    logInfo("player_disconnected", { connectionId, roomCode: session.roomCode, closeCode: code });
  });

  socket.on("error", (error) => {
    logError("websocket_error", { connectionId, message: error.message });
  });
});

const governanceTimer = setInterval(() => {
  try {
    for (const result of manager.processGovernance()) {
      broadcast(result.roomCode);
      for (const event of result.events) {
        if (event.kind === "auto_management_started") {
          logInfo("auto_management_started", {
            roomCode: result.roomCode,
            seat: event.seat,
            offlineSeconds: Math.floor(event.offlineMs / 1_000),
            revision: result.snapshot.revision,
          });
        } else if (event.kind === "turn_timed_out") {
          logInfo("turn_timeout_resolved", {
            roomCode: result.roomCode,
            seat: event.seat,
            tile: event.tile,
            autoManaged: event.autoManaged,
            deadlineAt: event.deadlineAt,
            automaticTurnCount: event.automaticTurnCount,
            nextTurnSeat: result.snapshot.game?.turnSeat,
            stage: result.snapshot.game?.stage,
            wallRemaining: result.snapshot.game?.wallRemaining,
            revision: result.snapshot.revision,
          });
        } else if (event.kind === "test_player_auto_discard") {
          logInfo("test_player_auto_discard", {
            roomCode: result.roomCode,
            seat: event.seat,
            tile: event.tile,
            dueAt: event.dueAt,
            automaticTurnCount: event.automaticTurnCount,
            nextTurnSeat: result.snapshot.game?.turnSeat,
            stage: result.snapshot.game?.stage,
            wallRemaining: result.snapshot.game?.wallRemaining,
            revision: result.snapshot.revision,
          });
        } else {
          logInfo("reaction_timeout_resolved", {
            roomCode: result.roomCode,
            timedOutSeats: event.seats.join(","),
            autoManagedSeats: event.autoManagedSeats.join(","),
            deadlineAt: event.deadlineAt,
            nextTurnSeat: result.snapshot.game?.turnSeat,
            stage: result.snapshot.game?.stage,
            wallRemaining: result.snapshot.game?.wallRemaining,
            revision: result.snapshot.revision,
          });
        }
      }
      logPublicTimelineCheckpointIfRoundEnded(result.snapshot, "governance", result.roomCode);
      logMatchEndedIfNeeded(result.snapshot, "governance", result.roomCode);
    }
  } catch (error) {
    logError("governance_tick_failed", { message: error instanceof Error ? error.message : "unknown" });
  }
}, 500);
governanceTimer.unref();

server.on("error", (error) => {
  const code = "code" in error && typeof error.code === "string" ? error.code : "UNKNOWN";
  logError("server_error", { code, message: error.message });
});

async function bootstrapPersistence(): Promise<void> {
  if (!roomStore.enabled) return;
  try {
    await roomStore.connect();
    const restored = await manager.restoreFromStore();
    logInfo("rooms_restored", { restoredCount: restored.restoredCount, skippedCount: restored.skipped.length });
  } catch (error) {
    logWarn("redis_bootstrap_failed", { message: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
  }
}

const persistenceTimer = setInterval(() => {
  void manager.persistToStore();
}, 2_000);
persistenceTimer.unref();

void bootstrapPersistence().then(() => {
  server.listen(port, "0.0.0.0", () => {
    logInfo("server_started", { port, nodeVersion: process.version, persistence: roomStore.enabled ? "redis" : "memory" });
    console.log(`麻将联机样板已启动：http://localhost:${port}，实例：${instanceId}，房间持久化：${roomStore.enabled ? "Redis" : "内存"}`);
  });
});
