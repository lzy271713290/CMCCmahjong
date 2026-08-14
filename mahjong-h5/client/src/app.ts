import type { DiscardView, RoomSnapshot, ServerMessage, TileCode } from "../../shared/protocol.js";

type SavedSession = { roomCode: string; playerId: string; playerToken: string };

const lobby = required<HTMLElement>("lobby");
const room = required<HTMLElement>("room");
const nameInput = required<HTMLInputElement>("name");
const codeInput = required<HTMLInputElement>("room-code");
const createButton = required<HTMLButtonElement>("create");
const joinButton = required<HTMLButtonElement>("join");
const readyButton = required<HTMLButtonElement>("ready");
const fillTestButton = required<HTMLButtonElement>("fill-test");
const startButton = required<HTMLButtonElement>("start");
const gameStatus = required<HTMLElement>("game-status");
const gameSummary = required<HTMLElement>("game-summary");
const gameTable = required<HTMLElement>("game-table");
const turnStatus = required<HTMLElement>("turn-status");
const wallStatus = required<HTMLElement>("wall-status");
const latestDiscard = required<HTMLElement>("latest-discard");
const selfHand = required<HTMLElement>("self-hand");
const copyButton = required<HTMLButtonElement>("copy");
const currentCode = required<HTMLElement>("current-code");
const seats = required<HTMLElement>("seats");
const notice = required<HTMLElement>("notice");
const connection = required<HTMLElement>("connection");

let socket: WebSocket;
let saved = loadSession();
let snapshot: RoomSnapshot | undefined;
let reconnectTimer: number | undefined;

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
}

function connect(): void {
  window.clearTimeout(reconnectTimer);
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${scheme}://${location.host}/ws`);
  setConnection("连接中", false);
  socket.addEventListener("open", () => {
    setConnection("已连接", true);
    if (saved) send({ type: "reconnect", roomCode: saved.roomCode, playerToken: saved.playerToken });
  });
  socket.addEventListener("message", (event) => handleMessage(JSON.parse(String(event.data)) as ServerMessage));
  socket.addEventListener("close", () => {
    setConnection("正在重连", false);
    reconnectTimer = window.setTimeout(connect, 1500);
  });
  socket.addEventListener("error", () => showNotice("网络连接不稳定，正在重试"));
}

function send(message: object): void {
  if (socket.readyState !== WebSocket.OPEN) {
    showNotice("还没有连上服务器，请稍等");
    return;
  }
  socket.send(JSON.stringify(message));
}

function handleMessage(message: ServerMessage): void {
  if (message.type === "session") {
    saved = { roomCode: message.roomCode, playerId: message.playerId, playerToken: message.playerToken };
    localStorage.setItem("mahjong-session", JSON.stringify(saved));
    render(message.snapshot);
    showNotice("已进入房间");
  } else if (message.type === "snapshot") {
    render(message.snapshot);
  } else if (message.type === "error") {
    if (message.code === "ROOM_NOT_FOUND" || message.code === "TOKEN_INVALID") {
      localStorage.removeItem("mahjong-session");
      saved = undefined;
      showLobby();
    }
    showNotice(message.message);
  }
}

function render(next: RoomSnapshot): void {
  snapshot = next;
  lobby.classList.add("hidden");
  room.classList.remove("hidden");
  currentCode.textContent = next.roomCode;
  seats.replaceChildren();
  for (let seat = 0; seat < 4; seat += 1) {
    const player = next.players.find((candidate) => candidate.seat === seat);
    const card = document.createElement("div");
    card.className = `seat${player ? " occupied" : ""}`;
    card.innerHTML = player
      ? `<div class="seat-head"><span>${seat + 1}号位${player.isHost ? " · 房主" : player.isTestPlayer ? " · 测试" : ""}</span><span class="${player.ready ? "ready" : ""}">${player.connected ? (player.ready ? "已准备" : "在线") : "暂离"}</span></div><span class="seat-name"></span>`
      : `<div class="seat-head"><span>${seat + 1}号位</span></div><span class="seat-name">等待加入</span>`;
    const name = card.querySelector<HTMLElement>(".seat-name");
    if (name && player) name.textContent = player.id === saved?.playerId ? `${player.name}（我）` : player.name;
    if (player && next.game) {
      const handCount = document.createElement("span");
      handCount.className = "hand-count";
      handCount.textContent = `${next.game.handTileCounts[player.seat] ?? 0}张${player.seat === next.game.dealerSeat ? " · 庄" : ""}`;
      card.append(handCount);
    }
    seats.append(card);
  }
  const me = next.players.find((player) => player.id === saved?.playerId);
  readyButton.textContent = me?.ready ? "取消准备" : "准备";
  const isPlaying = next.phase === "playing";
  const canStart = Boolean(me?.isHost && next.players.length === 4 && next.players.every((player) => player.ready));
  readyButton.classList.toggle("hidden", isPlaying);
  fillTestButton.classList.toggle("hidden", isPlaying || !me?.isHost || next.players.length >= 4);
  startButton.classList.toggle("hidden", isPlaying || !canStart);
  gameStatus.classList.toggle("hidden", !isPlaying);
  gameTable.classList.toggle("hidden", !isPlaying);
  if (next.game) {
    gameSummary.textContent = `第${next.game.roundNumber}局 · ${next.game.dealerSeat + 1}号位庄家 · 手牌 ${next.game.handTileCounts.join("/")} · 牌墙剩余${next.game.wallRemaining}张`;
    turnStatus.textContent =
      next.game.stage === "awaiting_reactions"
        ? "等待其他玩家响应弃牌"
        : next.game.turnSeat === next.game.viewerSeat
          ? "轮到你首次出牌"
          : `等待${next.game.turnSeat + 1}号位首次出牌`;
    wallStatus.textContent = `牌墙 ${next.game.wallRemaining} 张`;
    renderLatestDiscard(next.game.latestDiscard);
    renderSelfHand(next.game.selfHand ?? [], next.game.stage === "awaiting_discard" && next.game.turnSeat === next.game.viewerSeat);
  }
}

function renderSelfHand(tiles: TileCode[], canDiscard: boolean): void {
  selfHand.replaceChildren();
  for (const code of tiles) {
    const tile = document.createElement("button");
    tile.type = "button";
    tile.className = `mahjong-tile ${tileClass(code)}`;
    tile.textContent = tileDisplayLabel(code);
    tile.setAttribute("aria-label", tileLabel(code));
    tile.disabled = !canDiscard;
    if (canDiscard) tile.addEventListener("click", () => send({ type: "discard_tile", tile: code }));
    selfHand.append(tile);
  }
}

function renderLatestDiscard(discard: DiscardView | undefined): void {
  const oldTile = latestDiscard.querySelector(".mahjong-tile, .discard-placeholder");
  oldTile?.remove();
  const tile = document.createElement("div");
  if (discard) {
    const code = discard.tile;
    tile.className = `mahjong-tile ${tileClass(code)}`;
    tile.textContent = tileDisplayLabel(code);
    tile.setAttribute("aria-label", tileLabel(code));
  } else {
    tile.className = "discard-placeholder";
    tile.textContent = "暂无弃牌";
  }
  latestDiscard.append(tile);
}

function tileClass(code: TileCode): string {
  if (code.startsWith("wan-")) return "wan";
  if (code.startsWith("tong-")) return "tong";
  if (code.startsWith("tiao-")) return "tiao";
  return "honor";
}

function tileLabel(code: TileCode): string {
  const honors: Record<string, string> = { east: "东", south: "南", west: "西", north: "北", red: "中", green: "发", white: "白" };
  if (honors[code]) return honors[code];
  const [suit, rawRank] = code.split("-");
  const ranks = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  const suits: Record<string, string> = { wan: "万", tong: "筒", tiao: "条" };
  return `${ranks[Number(rawRank)] ?? rawRank}${suits[suit ?? ""] ?? ""}`;
}

function tileDisplayLabel(code: TileCode): string {
  const label = tileLabel(code);
  return label.length === 2 ? `${label[0]}\n${label[1]}` : label;
}

function showLobby(): void {
  snapshot = undefined;
  room.classList.add("hidden");
  lobby.classList.remove("hidden");
}

function loadSession(): SavedSession | undefined {
  try {
    const raw = localStorage.getItem("mahjong-session");
    return raw ? (JSON.parse(raw) as SavedSession) : undefined;
  } catch {
    return undefined;
  }
}

function setConnection(text: string, online: boolean): void {
  connection.textContent = text;
  connection.classList.toggle("offline", !online);
}

function showNotice(text: string): void {
  notice.textContent = text;
}

createButton.addEventListener("click", () => send({ type: "create_room", name: nameInput.value }));
joinButton.addEventListener("click", () => send({ type: "join_room", roomCode: codeInput.value, name: nameInput.value }));
readyButton.addEventListener("click", () => {
  const me = snapshot?.players.find((player) => player.id === saved?.playerId);
  send({ type: "set_ready", ready: !me?.ready });
});
fillTestButton.addEventListener("click", () => send({ type: "fill_test_players" }));
startButton.addEventListener("click", () => send({ type: "start_game" }));
copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(currentCode.textContent ?? "");
  showNotice("房间号已复制，发给朋友就能加入");
});

connect();
