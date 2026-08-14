import { createReadStream, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "../../shared/protocol.js";
import { RoomError, RoomManager, type Session } from "./room-manager.js";
import { instanceId, logError, logInfo, logWarn, shortId } from "./logger.js";

const port = Number(process.env.PORT ?? process.argv[2] ?? 3000);
const manager = new RoomManager();
const socketsByToken = new Map<string, WebSocket>();
const sessionsBySocket = new Map<WebSocket, { roomCode: string; playerToken: string }>();
const projectRoot = fileURLToPath(new URL("../../..", import.meta.url));

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer((request, response) => {
  const requestedPath = request.url === "/app.js" ? "dist/client/src/app.js" : request.url === "/styles.css" ? "client/public/styles.css" : "client/public/index.html";
  const safePath = normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(projectRoot, safePath);
  if (!existsSync(filePath)) {
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
  const snapshot = manager.snapshot(roomCode);
  for (const [socket, session] of sessionsBySocket) {
    if (session.roomCode === roomCode) send(socket, { type: "snapshot", snapshot });
  }
}

function bindSession(socket: WebSocket, session: Session, connectionId: string, event: "room_created" | "room_joined" | "room_reconnected"): void {
  const oldSocket = socketsByToken.get(session.playerToken);
  if (oldSocket && oldSocket !== socket) oldSocket.close(4001, "已在新连接恢复");
  socketsByToken.set(session.playerToken, socket);
  sessionsBySocket.set(socket, { roomCode: session.roomCode, playerToken: session.playerToken });
  send(socket, { type: "session", ...session });
  broadcast(session.roomCode);
  logInfo(event, {
    connectionId,
    roomCode: session.roomCode,
    playerId: shortId(session.playerId),
    playerCount: session.snapshot.players.length,
    revision: session.snapshot.revision,
    phase: session.snapshot.phase,
  });
}

function requireSession(socket: WebSocket): { roomCode: string; playerToken: string } {
  const session = sessionsBySocket.get(socket);
  if (!session) throw new RoomError("SESSION_REQUIRED", "请先创建或加入房间");
  return session;
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
          const session = manager.createRoom(message.name);
          bindSession(socket, session, connectionId, "room_created");
          break;
        }
        case "join_room": {
          const session = manager.joinRoom(message.roomCode, message.name);
          bindSession(socket, session, connectionId, "room_joined");
          break;
        }
        case "reconnect": {
          const session = manager.reconnect(message.roomCode, message.playerToken);
          bindSession(socket, session, connectionId, "room_reconnected");
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
        case "start_game": {
          const session = requireSession(socket);
          const snapshot = manager.startGame(session.roomCode, session.playerToken);
          broadcast(session.roomCode);
          logInfo("game_started", { connectionId, roomCode: session.roomCode, playerCount: snapshot.players.length, revision: snapshot.revision });
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

server.on("error", (error) => {
  const code = "code" in error && typeof error.code === "string" ? error.code : "UNKNOWN";
  logError("server_error", { code, message: error.message });
});

server.listen(port, "0.0.0.0", () => {
  logInfo("server_started", { port, nodeVersion: process.version });
  console.log(`麻将联机样板已启动：http://localhost:${port}，实例：${instanceId}`);
});
