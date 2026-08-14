import type { PlayerView, ReactionOption, RoomSnapshot, ServerMessage, TileCode, TurnOperationOption } from "../../shared/protocol.js";

type SavedSession = { roomCode: string; playerId: string; playerToken: string };
type TablePosition = "bottom" | "right" | "top" | "left";

const positions: TablePosition[] = ["bottom", "right", "top", "left"];
const winds = ["东", "南", "西", "北"];
const lobby = required<HTMLElement>("lobby");
const room = required<HTMLElement>("room");
const gameScreen = required<HTMLElement>("game-screen");
const nameInput = required<HTMLInputElement>("name");
const codeInput = required<HTMLInputElement>("room-code");
const createButton = required<HTMLButtonElement>("create");
const joinButton = required<HTMLButtonElement>("join");
const readyButton = required<HTMLButtonElement>("ready");
const fillTestButton = required<HTMLButtonElement>("fill-test");
const startButton = required<HTMLButtonElement>("start");
const copyButton = required<HTMLButtonElement>("copy");
const currentCode = required<HTMLElement>("current-code");
const gameRoomCode = required<HTMLElement>("game-room-code");
const roundLabel = required<HTMLElement>("round-label");
const seats = required<HTMLElement>("seats");
const tableSeats = required<HTMLElement>("table-seats");
const selfHand = required<HTMLElement>("self-hand");
const wallStatus = required<HTMLElement>("wall-status");
const turnStatus = required<HTMLElement>("turn-status");
const centerConsole = required<HTMLElement>("center-console");
const operationPanel = required<HTMLElement>("operation-panel");
const notice = required<HTMLElement>("notice");
const gameNotice = required<HTMLElement>("game-notice");
const connection = required<HTMLElement>("connection");
const gameConnection = required<HTMLElement>("game-connection");

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
  const me = next.players.find((player) => player.id === saved?.playerId);
  const isPlaying = next.phase === "playing" && Boolean(next.game);
  document.body.classList.toggle("in-game", isPlaying);
  lobby.classList.add("hidden");
  room.classList.toggle("hidden", isPlaying);
  gameScreen.classList.toggle("hidden", !isPlaying);
  currentCode.textContent = next.roomCode;
  gameRoomCode.textContent = next.roomCode;

  if (isPlaying && next.game) {
    renderTable(next, me);
    return;
  }

  renderWaitingRoom(next, me);
}

function renderWaitingRoom(next: RoomSnapshot, me: PlayerView | undefined): void {
  seats.replaceChildren();
  for (let seat = 0; seat < 4; seat += 1) {
    const player = next.players.find((candidate) => candidate.seat === seat);
    const card = document.createElement("div");
    card.className = `seat${player ? " occupied" : ""}`;
    card.innerHTML = player
      ? `<div class="seat-head"><span>${seat + 1}号位${player.isHost ? " · 房主" : player.isTestPlayer ? " · 测试" : ""}</span><span class="${player.ready ? "ready" : ""}">${player.connected ? (player.ready ? "已准备" : "在线") : "暂离"}</span></div><span class="seat-name"></span>`
      : `<div class="seat-head"><span>${seat + 1}号位</span></div><span class="seat-name">等待加入</span>`;
    const playerName = card.querySelector<HTMLElement>(".seat-name");
    if (playerName && player) playerName.textContent = player.id === saved?.playerId ? `${player.name}（我）` : player.name;
    seats.append(card);
  }
  readyButton.textContent = me?.ready ? "取消准备" : "准备";
  const canStart = Boolean(me?.isHost && next.players.length === 4 && next.players.every((player) => player.ready));
  fillTestButton.classList.toggle("hidden", !me?.isHost || next.players.length >= 4);
  startButton.classList.toggle("hidden", !canStart);
}

function renderTable(next: RoomSnapshot, me: PlayerView | undefined): void {
  const game = next.game!;
  const viewerSeat = game.viewerSeat ?? me?.seat ?? 0;
  roundLabel.textContent = `第${game.roundNumber}局 · ${winds[(viewerSeat - game.dealerSeat + 4) % 4]}位视角`;
  wallStatus.textContent = String(game.wallRemaining);
  renderPlayers(next, viewerSeat);
  renderWalls(game.wallRemaining);
  renderDiscards(game.discards, viewerSeat);
  renderCenter(game.dealerSeat, game.turnSeat, viewerSeat);
  renderOperations(game.availableOperations ?? [], game.availableTurnOperations ?? []);

  const canDiscard = game.stage === "awaiting_discard" && game.turnSeat === viewerSeat;
  if (game.stage === "round_ended") {
    if (game.roundResult?.reason === "discard_hu" || game.roundResult?.reason === "rob_kong_hu" || game.roundResult?.reason === "self_draw_hu") {
      const winners = game.roundResult.winnerSeats
        .map((seat) => next.players.find((player) => player.seat === seat)?.name ?? `${seat + 1}号位`)
        .join("、");
      const resultLabel = game.roundResult.reason === "self_draw_hu" ? "自摸" : game.roundResult.reason === "rob_kong_hu" ? "抢杠胡" : "胡牌";
      turnStatus.textContent = `${winners} ${resultLabel}`;
    } else {
      turnStatus.textContent = "牌墙已空 · 本局流局";
    }
  } else if (canDiscard) {
    turnStatus.textContent = "轮到你 · 请选择一张牌";
  } else if (game.stage === "awaiting_reactions") {
    turnStatus.textContent = game.availableOperations?.length
      ? game.reaction?.source === "added_gang" ? "可以抢杠胡" : "请响应这张牌"
      : "等待其他玩家响应";
  } else {
    const current = next.players.find((player) => player.seat === game.turnSeat);
    turnStatus.textContent = `等待 ${current?.name ?? `${game.turnSeat + 1}号位`} 出牌`;
  }
  renderSelfHand(game.selfHand ?? [], game.selfDrawnTile, canDiscard);
}

function renderPlayers(next: RoomSnapshot, viewerSeat: number): void {
  const game = next.game!;
  tableSeats.replaceChildren();
  for (const player of next.players) {
    const position = positionForSeat(player.seat, viewerSeat);
    const playerSeat = document.createElement("div");
    playerSeat.className = `player-seat seat-${position}${game.turnSeat === player.seat ? " active" : ""}${player.connected ? "" : " offline"}`;

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = Array.from(player.name)[0] ?? "麻";
    const info = document.createElement("div");
    info.className = "player-info";
    const role = player.seat === game.dealerSeat ? "庄" : winds[(player.seat - game.dealerSeat + 4) % 4];
    info.innerHTML = `<strong></strong><span><b>${role}</b> ${game.handTileCounts[player.seat] ?? 0}张${player.isTestPlayer ? " · 托管" : ""}</span>`;
    info.querySelector("strong")!.textContent = player.id === saved?.playerId ? `${player.name}（我）` : player.name;
    playerSeat.append(avatar, info);

    if (position !== "bottom") {
      const rack = document.createElement("div");
      rack.className = "opponent-rack";
      const handCount = game.handTileCounts[player.seat] ?? 0;
      for (let tile = 0; tile < handCount; tile += 1) rack.append(createTileBack());
      playerSeat.append(rack);
    }
    const playerMelds = game.melds.filter((meld) => meld.seat === player.seat);
    if (playerMelds.length > 0) {
      const meldRack = document.createElement("div");
      meldRack.className = "meld-rack";
      for (const meld of playerMelds) {
        const group = document.createElement("div");
        group.className = "meld-group";
        group.title = meld.kind === "chi" ? "吃" : meld.kind === "peng" ? "碰" : meld.gangType === "an" ? "暗杠" : meld.gangType === "jia" ? "加杠" : "明杠";
        for (const code of meld.tiles) group.append(createFaceTile(code, "meld", false));
        meldRack.append(group);
      }
      playerSeat.append(meldRack);
    }
    tableSeats.append(playerSeat);
  }
}

function renderOperations(options: ReactionOption[], turnOptions: TurnOperationOption[]): void {
  operationPanel.replaceChildren();
  operationPanel.classList.toggle("hidden", options.length === 0 && turnOptions.length === 0);
  if (options.length === 0 && turnOptions.length === 0) return;
  const labels: Record<ReactionOption["kind"], string> = { chi: "吃", peng: "碰", gang: "杠", hu: "胡" };
  for (const option of options) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `operation-button operation-${option.kind}`;
    const display = option.displayTiles.map(tileLabel).join(" ");
    if (option.kind === "chi") {
      button.classList.add("has-detail");
      const label = document.createElement("strong");
      label.textContent = labels[option.kind];
      const detail = document.createElement("small");
      detail.textContent = option.displayTiles.map(tileLabel).join("");
      button.append(label, detail);
    } else {
      button.textContent = labels[option.kind];
    }
    button.title = display;
    button.setAttribute("aria-label", `${labels[option.kind]} ${display}`.trim());
    button.addEventListener("click", () => submitReaction(option.id, labels[option.kind]));
    operationPanel.append(button);
  }
  if (options.length > 0) {
    const passButton = document.createElement("button");
    passButton.type = "button";
    passButton.className = "operation-button operation-pass";
    passButton.textContent = "过";
    passButton.addEventListener("click", () => submitReaction("pass", "过"));
    operationPanel.append(passButton);
  }
  const turnLabels: Record<TurnOperationOption["kind"], string> = { angang: "暗杠", jiagang: "加杠", zimo: "自摸" };
  for (const option of turnOptions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `operation-button operation-${option.kind}${option.kind === "angang" || option.kind === "jiagang" ? " has-detail" : ""}`;
    const label = turnLabels[option.kind];
    if (option.kind === "zimo") button.textContent = label;
    else {
      const strong = document.createElement("strong");
      strong.textContent = label;
      const detail = document.createElement("small");
      detail.textContent = option.tiles.map(tileLabel).join("");
      button.append(strong, detail);
    }
    button.title = `${label} ${option.tiles.map(tileLabel).join(" ")}`;
    button.addEventListener("click", () => submitTurnOperation(option.id, label));
    operationPanel.append(button);
  }
}

function submitReaction(operationId: string | "pass", label: string): void {
  operationPanel.querySelectorAll("button").forEach((button) => ((button as HTMLButtonElement).disabled = true));
  send({ type: "react_to_discard", operationId });
  showNotice(`已选择${label}，等待结算`);
}

function submitTurnOperation(operationId: string, label: string): void {
  operationPanel.querySelectorAll("button").forEach((button) => ((button as HTMLButtonElement).disabled = true));
  send({ type: "perform_turn_operation", operationId });
  showNotice(`已选择${label}`);
}

function renderWalls(remaining: number): void {
  const visibleBacks = Math.ceil((remaining / 83) * 40);
  positions.forEach((position, wallIndex) => {
    const wall = required<HTMLElement>(`wall-${position}`);
    wall.replaceChildren();
    for (let tileIndex = 0; tileIndex < 10; tileIndex += 1) {
      const tile = createTileBack();
      if (wallIndex * 10 + tileIndex >= visibleBacks) tile.classList.add("consumed");
      wall.append(tile);
    }
  });
}

function renderDiscards(discards: Array<{ seat: number; tile: TileCode }>, viewerSeat: number): void {
  for (const position of positions) required<HTMLElement>(`discards-${position}`).replaceChildren();
  discards.forEach((discard, index) => {
    const zone = required<HTMLElement>(`discards-${positionForSeat(discard.seat, viewerSeat)}`);
    const tile = createFaceTile(discard.tile, "discard", false);
    if (index === discards.length - 1) tile.classList.add("latest");
    zone.append(tile);
  });
}

function renderCenter(dealerSeat: number, turnSeat: number, viewerSeat: number): void {
  centerConsole.className = `center-console active-${positionForSeat(turnSeat, viewerSeat)}`;
  positions.forEach((position, relativeSeat) => {
    const absoluteSeat = (viewerSeat + relativeSeat) % 4;
    required<HTMLElement>(`wind-${position}`).textContent = winds[(absoluteSeat - dealerSeat + 4) % 4]!;
  });
}

function renderSelfHand(tiles: TileCode[], drawnTile: TileCode | undefined, canDiscard: boolean): void {
  selfHand.replaceChildren();
  const hand = [...tiles];
  let drawn: TileCode | undefined;
  if (drawnTile) {
    const index = hand.lastIndexOf(drawnTile);
    if (index >= 0) drawn = hand.splice(index, 1)[0];
  }
  for (const code of hand) selfHand.append(createFaceTile(code, "hand", canDiscard));
  if (drawn) {
    const tile = createFaceTile(drawn, "hand", canDiscard);
    tile.classList.add("drawn");
    selfHand.append(tile);
  }
}

function createFaceTile(code: TileCode, size: "hand" | "discard" | "meld", interactive: boolean): HTMLElement {
  const tile = document.createElement(interactive ? "button" : "div");
  if (tile instanceof HTMLButtonElement) {
    tile.type = "button";
    tile.addEventListener("click", () => {
      selfHand.querySelectorAll("button").forEach((button) => ((button as HTMLButtonElement).disabled = true));
      send({ type: "discard_tile", tile: code });
      showNotice(`已打出 ${tileLabel(code)}`);
    });
  }
  tile.className = `tile-shell ${size}-tile`;
  tile.setAttribute("aria-label", tileLabel(code));
  tile.title = tileLabel(code);
  const face = document.createElement("span");
  face.className = "tile-face";
  const index = tileSpriteIndex(code);
  face.style.backgroundPosition = `${-Math.floor(index / 6) * 55}px ${-(index % 6) * 84}px`;
  tile.append(face);
  return tile;
}

function createTileBack(): HTMLElement {
  const back = document.createElement("span");
  back.className = "tile-back";
  return back;
}

function tileSpriteIndex(code: TileCode): number {
  const [suit, rawRank] = code.split("-");
  const rank = Number(rawRank);
  if (suit === "tiao") return rank;
  if (suit === "wan") return 9 + rank;
  if (suit === "tong") return 18 + rank;
  const honors: Record<string, number> = { green: 28, red: 30, white: 31, east: 32, north: 33, south: 34, west: 35 };
  return honors[code] ?? 31;
}

function positionForSeat(seat: number, viewerSeat: number): TablePosition {
  return positions[(seat - viewerSeat + 4) % 4]!;
}

function tileLabel(code: TileCode): string {
  const honors: Record<string, string> = { east: "东", south: "南", west: "西", north: "北", red: "中", green: "发", white: "白" };
  if (honors[code]) return honors[code];
  const [suit, rawRank] = code.split("-");
  const ranks = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  const suits: Record<string, string> = { wan: "万", tong: "筒", tiao: "条" };
  return `${ranks[Number(rawRank)] ?? rawRank}${suits[suit ?? ""] ?? ""}`;
}

function showLobby(): void {
  snapshot = undefined;
  document.body.classList.remove("in-game");
  room.classList.add("hidden");
  gameScreen.classList.add("hidden");
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
  for (const indicator of [connection, gameConnection]) {
    indicator.textContent = text;
    indicator.classList.toggle("offline", !online);
  }
}

function showNotice(text: string): void {
  notice.textContent = text;
  gameNotice.textContent = text;
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
