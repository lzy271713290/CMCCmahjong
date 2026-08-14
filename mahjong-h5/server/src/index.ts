import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "../../shared/protocol.js";
import { RoomError, RoomManager, type Session } from "./room-manager.js";

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

function bindSession(socket: WebSocket, session: Session): void {
  const oldSocket = socketsByToken.get(session.playerToken);
  if (oldSocket && oldSocket !== socket) oldSocket.close(4001, "已在新连接恢复");
  socketsByToken.set(session.playerToken, socket);
  sessionsBySocket.set(socket, { roomCode: session.roomCode, playerToken: session.playerToken });
  send(socket, { type: "session", ...session });
  broadcast(session.roomCode);
}

function requireSession(socket: WebSocket): { roomCode: string; playerToken: string } {
  const session = sessionsBySocket.get(socket);
  if (!session) throw new RoomError("SESSION_REQUIRED", "请先创建或加入房间");
  return session;
}

webSockets.on("connection", (socket) => {
  socket.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString()) as ClientMessage;
      switch (message.type) {
        case "create_room":
          bindSession(socket, manager.createRoom(message.name));
          break;
        case "join_room":
          bindSession(socket, manager.joinRoom(message.roomCode, message.name));
          break;
        case "reconnect":
          bindSession(socket, manager.reconnect(message.roomCode, message.playerToken));
          break;
        case "set_ready": {
          const session = requireSession(socket);
          manager.setReady(session.roomCode, session.playerToken, Boolean(message.ready));
          broadcast(session.roomCode);
          break;
        }
        case "fill_test_players": {
          const session = requireSession(socket);
          manager.fillWithTestPlayers(session.roomCode, session.playerToken);
          broadcast(session.roomCode);
          break;
        }
        case "start_game": {
          const session = requireSession(socket);
          manager.startGame(session.roomCode, session.playerToken);
          broadcast(session.roomCode);
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
      send(socket, { type: "error", code, message });
    }
  });

  socket.on("close", () => {
    const session = sessionsBySocket.get(socket);
    if (!session) return;
    sessionsBySocket.delete(socket);
    if (socketsByToken.get(session.playerToken) !== socket) return;
    socketsByToken.delete(session.playerToken);
    manager.disconnect(session.roomCode, session.playerToken);
    broadcast(session.roomCode);
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`麻将联机样板已启动：http://localhost:${port}`);
});
