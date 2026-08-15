import type { PlayerView, PublicActionView, ReactionOption, RoomSnapshot, ServerMessage, TileCode, TurnOperationOption } from "../../shared/protocol.js";
import { PUBLIC_REPLAY_FORMAT, parsePublicReplay, type PublicReplayPlayer, type PublicReplayRecord } from "./public-replay.js";

type SavedSession = { roomCode: string; playerId: string; playerToken: string };
type TablePosition = "bottom" | "right" | "top" | "left";
type FeedbackKind = "discard" | "turn" | "meld" | "hu" | "round" | "vote" | "system";
type Feedback = { text: string; kind: FeedbackKind };
type HistorySource = {
  roomCode: string;
  modelVersion?: string;
  players: PublicReplayPlayer[];
  scoreTotals: number[];
  publicActions: PublicActionView[];
};

const positions: TablePosition[] = ["bottom", "right", "top", "left"];
const winds = ["东", "南", "西", "北"];
const lobby = required<HTMLElement>("lobby");
const room = required<HTMLElement>("room");
const gameScreen = required<HTMLElement>("game-screen");
const nameInput = required<HTMLInputElement>("name");
const matchRounds = required<HTMLSelectElement>("match-rounds");
const codeInput = required<HTMLInputElement>("room-code");
const createButton = required<HTMLButtonElement>("create");
const joinButton = required<HTMLButtonElement>("join");
const readyButton = required<HTMLButtonElement>("ready");
const fillTestButton = required<HTMLButtonElement>("fill-test");
const startButton = required<HTMLButtonElement>("start");
const leaveRoomButton = required<HTMLButtonElement>("leave-room");
const copyButton = required<HTMLButtonElement>("copy");
const currentCode = required<HTMLElement>("current-code");
const matchModeLabel = required<HTMLElement>("match-mode-label");
const gameRoomCode = required<HTMLElement>("game-room-code");
const gameMatchProgress = required<HTMLElement>("game-match-progress");
const roundLabel = required<HTMLElement>("round-label");
const seats = required<HTMLElement>("seats");
const tableSeats = required<HTMLElement>("table-seats");
const selfHand = required<HTMLElement>("self-hand");
const wallStatus = required<HTMLElement>("wall-status");
const turnStatus = required<HTMLElement>("turn-status");
const centerConsole = required<HTMLElement>("center-console");
const operationPanel = required<HTMLElement>("operation-panel");
const scoreSummary = required<HTMLElement>("score-summary");
const notice = required<HTMLElement>("notice");
const gameNotice = required<HTMLElement>("game-notice");
const connection = required<HTMLElement>("connection");
const gameConnection = required<HTMLElement>("game-connection");
const shareRoomButton = required<HTMLButtonElement>("share-room");
const soundToggleButton = required<HTMLButtonElement>("sound-toggle");
const fullscreenToggleButton = required<HTMLButtonElement>("fullscreen-toggle");
const actionBanner = required<HTMLElement>("action-banner");
const networkOverlay = required<HTMLElement>("network-overlay");
const networkDetail = required<HTMLElement>("network-detail");
const reconnectNowButton = required<HTMLButtonElement>("reconnect-now");
const rulesOpenButton = required<HTMLButtonElement>("rules-open");
const rulesGameButton = required<HTMLButtonElement>("rules-game");
const rulesOverlay = required<HTMLElement>("rules-overlay");
const rulesCloseButton = required<HTMLButtonElement>("rules-close");
const rulesCloseXButton = required<HTMLButtonElement>("rules-close-x");
const historyImportButton = required<HTMLButtonElement>("history-import");
const historyFileInput = required<HTMLInputElement>("history-file");
const historyGameButton = required<HTMLButtonElement>("history-game");
const historyOverlay = required<HTMLElement>("history-overlay");
const historyEyebrow = required<HTMLElement>("history-eyebrow");
const historyTitle = required<HTMLElement>("history-title");
const historyMeta = required<HTMLElement>("history-meta");
const historyRoundSelect = required<HTMLSelectElement>("history-round");
const historyFocus = required<HTMLElement>("history-focus");
const historyProgress = required<HTMLInputElement>("history-progress");
const historyPrevButton = required<HTMLButtonElement>("history-prev");
const historyPlayButton = required<HTMLButtonElement>("history-play");
const historyNextButton = required<HTMLButtonElement>("history-next");
const historyList = required<HTMLOListElement>("history-list");
const historyExportButton = required<HTMLButtonElement>("history-export");
const historyCloseButton = required<HTMLButtonElement>("history-close");
const historyCloseXButton = required<HTMLButtonElement>("history-close-x");
const requestDissolveButton = required<HTMLButtonElement>("request-dissolve");
const actionCountdown = required<HTMLElement>("action-countdown");
const dissolveOverlay = required<HTMLElement>("dissolve-overlay");
const dissolveDetail = required<HTMLElement>("dissolve-detail");
const dissolveActions = required<HTMLElement>("dissolve-actions");

let socket: WebSocket | undefined;
let saved = loadSession();
let snapshot: RoomSnapshot | undefined;
let reconnectTimer: number | undefined;
let heartbeatTimer: number | undefined;
let connectionGeneration = 0;
let reconnectAttempts = 0;
let pendingRequest: { type: string; timeout: number } | undefined;
let feedbackTimer: number | undefined;
const feedbackQueue: Feedback[] = [];
let soundEnabled = localStorage.getItem("mahjong-sound") !== "off";
let audioContext: AudioContext | undefined;
let lastServerMessageAt = Date.now();
let reconnectFeedbackPending = false;
let importedReplay: PublicReplayRecord | undefined;
let historySource: HistorySource | undefined;
let historyCursor = 0;
let historyPlaybackTimer: number | undefined;
let countdownTimer: number | undefined;

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
}

function connect(): void {
  window.clearTimeout(reconnectTimer);
  window.clearInterval(heartbeatTimer);
  const generation = ++connectionGeneration;
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const nextSocket = new WebSocket(`${scheme}://${location.host}/ws`);
  socket = nextSocket;
  setConnection(reconnectAttempts > 0 ? "重连中" : "连接中", false);
  updateNetworkOverlay(true);
  nextSocket.addEventListener("open", () => {
    if (generation !== connectionGeneration) return;
    const wasReconnecting = reconnectAttempts > 0;
    reconnectAttempts = 0;
    lastServerMessageAt = Date.now();
    reconnectFeedbackPending = wasReconnecting;
    setConnection(saved ? "恢复中" : "已连接", true);
    if (saved) send({ type: "reconnect", roomCode: saved.roomCode, playerToken: saved.playerToken });
    else updateNetworkOverlay(false);
    heartbeatTimer = window.setInterval(() => {
      if (Date.now() - lastServerMessageAt > 45_000) {
        nextSocket.close(4000, "连接超时");
        return;
      }
      send({ type: "ping" }, false);
    }, 20_000);
  });
  nextSocket.addEventListener("message", (event) => {
    if (generation !== connectionGeneration) return;
    lastServerMessageAt = Date.now();
    handleMessage(JSON.parse(String(event.data)) as ServerMessage);
  });
  nextSocket.addEventListener("close", () => {
    if (generation !== connectionGeneration) return;
    window.clearInterval(heartbeatTimer);
    clearPendingRequest();
    reconnectAttempts += 1;
    const delay = Math.min(1_000 * 2 ** Math.min(reconnectAttempts - 1, 4), 15_000);
    setConnection("正在重连", false);
    updateNetworkOverlay(true, delay);
    reconnectTimer = window.setTimeout(connect, delay);
  });
  nextSocket.addEventListener("error", () => {
    if (generation === connectionGeneration) showNotice("网络连接不稳定，正在自动重试");
  });
}

function send(message: object, trackRequest = true): boolean {
  if (socket?.readyState !== WebSocket.OPEN) {
    showNotice("还没有连上服务器，请稍等");
    updateNetworkOverlay(true);
    return false;
  }
  const type = (message as { type?: string }).type ?? "unknown";
  if (trackRequest && pendingRequest) {
    showNotice("上一个操作正在确认，请勿重复点击");
    return false;
  }
  socket.send(JSON.stringify(message));
  if (trackRequest && type !== "reconnect") {
    const timeout = window.setTimeout(() => {
      if (pendingRequest?.type !== type) return;
      pendingRequest = undefined;
      showNotice("操作确认较慢，请检查网络后重试");
      renderPendingState();
    }, 6_000);
    pendingRequest = { type, timeout };
    renderPendingState();
  }
  return true;
}

function handleMessage(message: ServerMessage): void {
  if (message.type === "session") {
    clearPendingRequest();
    saved = { roomCode: message.roomCode, playerId: message.playerId, playerToken: message.playerToken };
    localStorage.setItem("mahjong-session", JSON.stringify(saved));
    render(message.snapshot);
    setConnection("已连接", true);
    updateNetworkOverlay(false);
    if (reconnectFeedbackPending) enqueueFeedback({ text: "网络已恢复，牌局状态已同步", kind: "system" });
    reconnectFeedbackPending = false;
    showNotice(message.snapshot.phase === "playing" ? "牌局状态已恢复" : "已进入房间");
  } else if (message.type === "snapshot") {
    const previous = snapshot;
    clearPendingRequest();
    render(message.snapshot);
    collectSnapshotFeedback(previous, message.snapshot);
  } else if (message.type === "error") {
    clearPendingRequest();
    if (message.code === "ROOM_NOT_FOUND" || message.code === "TOKEN_INVALID") {
      localStorage.removeItem("mahjong-session");
      saved = undefined;
      showLobby();
    }
    reconnectFeedbackPending = false;
    updateNetworkOverlay(false);
    showNotice(message.message);
  } else if (message.type === "left_room") {
    clearPendingRequest();
    localStorage.removeItem("mahjong-session");
    saved = undefined;
    snapshot = undefined;
    history.replaceState({}, "", "/");
    showLobby();
    showNotice("已退出房间");
  } else if (message.type === "pong") {
    setConnection("已连接", true);
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
  matchModeLabel.textContent = `${next.match.totalRounds}局`;
  gameRoomCode.textContent = next.roomCode;
  gameMatchProgress.textContent = `第${next.game?.roundNumber ?? 1}/${next.match.totalRounds}局`;

  if (isPlaying && next.game) {
    renderTable(next, me);
    renderPendingState();
    return;
  }

  renderWaitingRoom(next, me);
  renderPendingState();
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
  const testPlayerCount = next.players.filter((player) => player.isTestPlayer).length;
  const canStart = Boolean(
    me?.isHost
    && next.players.length === 4
    && next.players.every((player) => player.ready && (player.connected || player.isTestPlayer)),
  );
  fillTestButton.textContent = testPlayerCount > 0 ? `移除测试玩家（${testPlayerCount}）` : "一键补齐测试玩家";
  fillTestButton.classList.toggle("hidden", !me?.isHost || (testPlayerCount === 0 && next.players.length >= 4));
  startButton.classList.toggle("hidden", !canStart);
}

function renderTable(next: RoomSnapshot, me: PlayerView | undefined): void {
  const game = next.game!;
  const viewerSeat = game.viewerSeat ?? me?.seat ?? 0;
  roundLabel.textContent = `第${game.roundNumber}/${next.match.totalRounds}局 · ${winds[(viewerSeat - game.dealerSeat + 4) % 4]}位视角`;
  wallStatus.textContent = String(game.wallRemaining);
  renderPlayers(next, viewerSeat);
  renderWalls(game.wallRemaining);
  renderDiscards(game.discards, viewerSeat);
  renderCenter(game.dealerSeat, game.turnSeat, viewerSeat);
  renderOperations(game.availableOperations ?? [], game.availableTurnOperations ?? []);
  renderScoreSummary(next);
  renderDissolveVote(next, me);
  updateActionCountdown();
  refreshLiveHistory(next);

  const canDiscard = game.stage === "awaiting_discard" && game.turnSeat === viewerSeat;
  if (next.match.status === "completed") {
    turnStatus.textContent = `整场结束 · 已完成${next.match.completedRounds}局`;
  } else if (game.stage === "round_ended") {
    if (game.roundResult?.reason === "discard_hu" || game.roundResult?.reason === "rob_kong_hu" || game.roundResult?.reason === "self_draw_hu") {
      const winners = game.roundResult.winnerSeats
        .map((seat) => next.players.find((player) => player.seat === seat)?.name ?? `${seat + 1}号位`)
        .join("、");
      const resultLabel = game.roundResult.reason === "self_draw_hu" ? "自摸" : game.roundResult.reason === "rob_kong_hu" ? "抢杠胡" : "胡牌";
      const winnerGain = game.roundResult.winnerSeats.reduce((sum, seat) => sum + (game.scoreDeltas[seat] ?? 0), 0);
      turnStatus.textContent = `${winners} ${resultLabel} · +${winnerGain}分`;
    } else if (game.roundResult?.reason === "dissolved") {
      turnStatus.textContent = "本局已解散 · 不计入完成局数";
    } else {
      turnStatus.textContent = "牌墙已空 · 本局流局";
    }
  } else if (canDiscard) {
    turnStatus.textContent = "轮到你 · 请选择一张牌";
  } else if (game.stage === "awaiting_reactions") {
    turnStatus.textContent = game.availableOperations?.length
      ? game.reaction?.source !== "discard" ? "可以抢杠胡" : "请响应这张牌"
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
    playerSeat.className = `player-seat seat-${position}${game.turnSeat === player.seat ? " active" : ""}${player.connected ? "" : " offline"}${player.autoManaged ? " managed" : ""}`;

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = Array.from(player.name)[0] ?? "麻";
    const info = document.createElement("div");
    info.className = "player-info";
    const role = player.seat === game.dealerSeat ? "庄" : winds[(player.seat - game.dealerSeat + 4) % 4];
    info.innerHTML = `<strong></strong><span><b>${role}</b> ${game.handTileCounts[player.seat] ?? 0}张 · ${next.scoreTotals[player.seat] ?? 200}分${player.isTestPlayer ? " · 测试" : player.autoManaged ? " · 托管" : ""}</span>`;
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
        group.title = meld.kind === "chi"
          ? "吃"
          : meld.kind === "peng"
            ? "碰"
            : meld.kind === "special_gang"
              ? `${meld.specialType === "dragons" ? "中发白特殊杠" : "东南西北特殊杠"}${meld.growthCount ? ` · 涨毛${meld.growthCount}次` : ""}`
              : meld.gangType === "an" ? "暗杠" : meld.gangType === "jia" ? "加杠" : "明杠";
        for (const code of meld.tiles) group.append(createFaceTile(code, "meld", false));
        for (let hidden = 0; hidden < (meld.hiddenTileCount ?? 0); hidden += 1) {
          const back = createTileBack();
          back.classList.add("meld-back");
          group.append(back);
        }
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
  const turnLabels: Record<TurnOperationOption["kind"], string> = {
    angang: "暗杠",
    jiagang: "加杠",
    specialgang: "特殊杠",
    zhangmao: "涨毛",
    zimo: "自摸",
  };
  for (const option of turnOptions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `operation-button operation-${option.kind}${option.kind !== "zimo" ? " has-detail" : ""}`;
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
  if (send({ type: "react_to_discard", operationId })) {
    operationPanel.querySelectorAll("button").forEach((button) => ((button as HTMLButtonElement).disabled = true));
    showNotice(`已选择${label}，等待结算`);
  }
}

function submitTurnOperation(operationId: string, label: string): void {
  if (send({ type: "perform_turn_operation", operationId })) {
    operationPanel.querySelectorAll("button").forEach((button) => ((button as HTMLButtonElement).disabled = true));
    showNotice(`已选择${label}`);
  }
}

function updateActionCountdown(): void {
  const deadline = snapshot?.game?.actionDeadlineAt;
  const paused = snapshot?.match.earlySettlement?.status === "voting" || snapshot?.match.status === "completed";
  const remaining = !deadline || paused ? undefined : Math.max(0, Math.ceil((deadline - Date.now()) / 1_000));
  actionCountdown.textContent = remaining === undefined ? "--" : String(remaining);
  actionCountdown.parentElement?.classList.toggle("urgent", remaining !== undefined && remaining <= 5);
}

function renderDissolveVote(next: RoomSnapshot, me: PlayerView | undefined): void {
  const vote = next.match.earlySettlement;
  const visible = vote?.status === "voting" && Boolean(vote.duringRound);
  dissolveOverlay.classList.toggle("hidden", !visible);
  requestDissolveButton.classList.toggle("hidden", next.match.status === "completed");
  requestDissolveButton.disabled = vote?.status === "voting";
  if (!visible || !vote) return;

  const requester = next.players.find((player) => player.seat === vote.requesterSeat)?.name ?? `${vote.requesterSeat + 1}号位`;
  dissolveDetail.textContent = `${requester}申请解散 · 已同意 ${vote.approvedSeats.length}/4 · 投票期间牌局暂停`;
  dissolveActions.replaceChildren();
  if (!me || !vote.waitingSeats.includes(me.seat)) return;
  const agree = document.createElement("button");
  agree.type = "button";
  agree.textContent = "同意解散";
  const reject = document.createElement("button");
  reject.type = "button";
  reject.className = "reject-settlement-button";
  reject.textContent = "继续打牌";
  const respond = (accepted: boolean) => {
    agree.disabled = true;
    reject.disabled = true;
    send({ type: "respond_early_settlement", agree: accepted });
  };
  agree.addEventListener("click", () => respond(true));
  reject.addEventListener("click", () => respond(false));
  dissolveActions.append(agree, reject);
}

function renderScoreSummary(next: RoomSnapshot): void {
  const game = next.game;
  const result = game?.roundResult;
  scoreSummary.replaceChildren();
  scoreSummary.classList.toggle("hidden", !game || game.stage !== "round_ended" || !result);
  if (!game || game.stage !== "round_ended" || !result) return;

  const header = document.createElement("header");
  const title = document.createElement("strong");
  title.textContent = next.match.status === "completed" ? "整场结算" : result.winnerSeats.length > 0 ? "本局结算" : "本局流局";
  const subtitle = document.createElement("span");
  const endReasonLabels: Record<string, string> = {
    round_limit: "已完成约定局数",
    negative_score: "有玩家累计分低于0分",
    early_agreement: "全员同意提前结算",
  };
  subtitle.textContent = next.match.status === "completed"
    ? endReasonLabels[next.match.endReason ?? ""] ?? `共完成${next.match.completedRounds}局`
    : `第${game.roundNumber}局 · 当前累计分`;
  header.append(title, subtitle);
  scoreSummary.append(header);

  const scoreboard = document.createElement("div");
  scoreboard.className = "settlement-scoreboard";
  const orderedPlayers = [...next.players].sort((left, right) => {
    const leftRank = next.match.rankings?.find((ranking) => ranking.seat === left.seat)?.rank ?? left.seat + 1;
    const rightRank = next.match.rankings?.find((ranking) => ranking.seat === right.seat)?.rank ?? right.seat + 1;
    return leftRank - rightRank || (next.scoreTotals[right.seat] ?? 0) - (next.scoreTotals[left.seat] ?? 0);
  });
  for (const player of orderedPlayers) {
    const row = document.createElement("div");
    const ranking = next.match.rankings?.find((candidate) => candidate.seat === player.seat);
    const delta = game.scoreDeltas[player.seat] ?? 0;
    row.className = `${player.id === saved?.playerId ? "is-me" : ""}${result.winnerSeats.includes(player.seat) ? " is-winner" : ""}`;
    row.innerHTML = `<b>${ranking ? `第${ranking.rank}名` : winds[(player.seat - game.dealerSeat + 4) % 4]}</b><strong></strong><span class="round-delta ${delta > 0 ? "positive" : delta < 0 ? "negative" : ""}">${delta >= 0 ? "+" : ""}${delta}</span><em>${next.scoreTotals[player.seat] ?? 200}分</em>`;
    row.querySelector("strong")!.textContent = player.id === saved?.playerId ? `${player.name}（我）` : player.name;
    scoreboard.append(row);
  }
  scoreSummary.append(scoreboard);

  if (result.payments?.length) {
    const paymentDetails = document.createElement("details");
    paymentDetails.className = "payment-details";
    const paymentSummary = document.createElement("summary");
    paymentSummary.textContent = `查看支付明细（${result.payments.length}笔）`;
    const detail = document.createElement("small");
    detail.textContent = result.payments
      .map((payment) => {
        const from = next.players.find((player) => player.seat === payment.fromSeat)?.name ?? `${payment.fromSeat + 1}号位`;
        const to = next.players.find((player) => player.seat === payment.toSeat)?.name ?? `${payment.toSeat + 1}号位`;
        return `${from}→${to} ${payment.amount}分`;
      })
      .join(" · ");
    paymentDetails.append(paymentSummary, detail);
    scoreSummary.append(paymentDetails);
  }

  const me = next.players.find((player) => player.id === saved?.playerId);
  const vote = next.match.earlySettlement;
  if (next.match.roundHistory.length > 0) {
    const history = document.createElement("details");
    history.className = "round-history";
    const summary = document.createElement("summary");
    summary.textContent = `逐局记录（${next.match.roundHistory.length}局）`;
    const list = document.createElement("ol");
    for (const round of [...next.match.roundHistory].reverse()) {
      const item = document.createElement("li");
      const winners = round.winnerSeats.length
        ? round.winnerSeats.map((seat) => next.players.find((player) => player.seat === seat)?.name ?? `${seat + 1}号位`).join("、")
        : "流局";
      item.textContent = `第${round.roundNumber}局 ${winners}｜${round.scoreTotals.join(" / ")}`;
      list.append(item);
    }
    history.append(summary, list);
    scoreSummary.append(history);
  }

  if (vote) {
    const voteStatus = document.createElement("div");
    voteStatus.className = `early-settlement status-${vote.status}`;
    const requester = next.players.find((player) => player.seat === vote.requesterSeat)?.name ?? `${vote.requesterSeat + 1}号位`;
    if (vote.status === "voting") {
      voteStatus.textContent = `${requester}申请解散牌局 · 已同意 ${vote.approvedSeats.length}/4`;
      if (me && vote.waitingSeats.includes(me.seat)) {
        const actions = document.createElement("div");
        actions.className = "settlement-actions";
        const agree = document.createElement("button");
        agree.type = "button";
        agree.textContent = "同意解散";
        const reject = document.createElement("button");
        reject.type = "button";
        reject.className = "reject-settlement-button";
        reject.textContent = "继续打牌";
        agree.addEventListener("click", () => {
          agree.disabled = true;
          reject.disabled = true;
          send({ type: "respond_early_settlement", agree: true });
        });
        reject.addEventListener("click", () => {
          agree.disabled = true;
          reject.disabled = true;
          send({ type: "respond_early_settlement", agree: false });
        });
        actions.append(agree, reject);
        voteStatus.append(actions);
      }
    } else if (vote.status === "rejected") {
      voteStatus.textContent = "解散投票未通过，本场继续";
    } else {
      voteStatus.textContent = "全员同意解散牌局";
    }
    scoreSummary.append(voteStatus);
  }

  const footer = document.createElement("footer");
  footer.className = "settlement-footer";

  if (next.match.status !== "completed" && vote?.status !== "voting") {
    const requestSettlement = document.createElement("button");
    requestSettlement.type = "button";
    requestSettlement.className = "request-settlement-button";
    requestSettlement.textContent = "申请解散牌局";
    requestSettlement.addEventListener("click", () => {
      requestSettlement.disabled = true;
      send({ type: "request_early_settlement" });
    });
    footer.append(requestSettlement);
  }

  if (me?.isHost && next.match.status !== "completed" && vote?.status !== "voting") {
    const nextRound = document.createElement("button");
    nextRound.type = "button";
    nextRound.className = "next-round-button";
    nextRound.textContent = "开始下一局";
    nextRound.addEventListener("click", () => {
      nextRound.disabled = true;
      send({ type: "start_next_round" });
    });
    footer.append(nextRound);
  }

  if (next.match.status === "completed") {
    const newRoom = document.createElement("button");
    newRoom.type = "button";
    newRoom.className = "next-round-button";
    newRoom.textContent = "再开一桌";
    newRoom.addEventListener("click", () => returnToLobby());
    const shareResult = document.createElement("button");
    shareResult.type = "button";
    shareResult.className = "request-settlement-button";
    shareResult.textContent = "分享结果";
    shareResult.addEventListener("click", () => shareCurrentRoom(true));
    footer.append(shareResult, newRoom);
  }
  if (footer.childElementCount > 0) scoreSummary.append(footer);
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
      if (send({ type: "discard_tile", tile: code })) {
        selfHand.querySelectorAll("button").forEach((button) => ((button as HTMLButtonElement).disabled = true));
        tile.classList.add("discarding");
        showNotice(`已打出 ${tileLabel(code)}`);
      }
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

function collectSnapshotFeedback(previous: RoomSnapshot | undefined, next: RoomSnapshot): void {
  const before = previous?.game;
  const after = next.game;
  if (!before || !after || previous?.roomCode !== next.roomCode) return;
  if (after.roundNumber !== before.roundNumber) {
    enqueueFeedback({ text: `第${after.roundNumber}局开始 · ${playerName(next, after.dealerSeat)}坐庄`, kind: "round" });
    return;
  }

  if (after.discards.length > before.discards.length) {
    for (const discard of after.discards.slice(before.discards.length).slice(-4)) {
      enqueueFeedback({ text: `${playerName(next, discard.seat)} 打出 ${tileLabel(discard.tile)}`, kind: "discard" });
    }
    document.querySelector(".discard-tile.latest")?.classList.add("new-discard");
  }

  const oldMelds = new Map(before.melds.map((meld, index) => [`${meld.seat}:${index}`, JSON.stringify(meld)]));
  after.melds.forEach((meld, index) => {
    if (oldMelds.get(`${meld.seat}:${index}`) === JSON.stringify(meld)) return;
    const label = meld.kind === "chi"
      ? "吃"
      : meld.kind === "peng"
        ? "碰"
        : meld.kind === "special_gang"
          ? meld.growthCount ? "涨毛" : "特殊杠"
          : "杠";
    enqueueFeedback({ text: `${playerName(next, meld.seat)} ${label}`, kind: "meld" });
  });

  if (!before.roundResult && after.roundResult) {
    if (after.roundResult.winnerSeats.length > 0) {
      const winners = after.roundResult.winnerSeats.map((seat) => playerName(next, seat)).join("、");
      const label = after.roundResult.reason === "self_draw_hu" ? "自摸" : after.roundResult.reason === "rob_kong_hu" ? "抢杠胡" : "胡牌";
      enqueueFeedback({ text: `${winners} ${label}`, kind: "hu" });
    } else if (after.roundResult.reason === "dissolved") {
      enqueueFeedback({ text: "全员同意，当前未完成局已解散", kind: "round" });
    } else {
      enqueueFeedback({ text: "牌墙已空，本局流局", kind: "round" });
    }
  }

  const previousVote = previous.match.earlySettlement;
  const nextVote = next.match.earlySettlement;
  if (nextVote && JSON.stringify(previousVote) !== JSON.stringify(nextVote)) {
    const voteText = nextVote.status === "approved"
      ? "全员同意，整场提前结算"
      : nextVote.status === "rejected"
        ? "提前结算未通过，继续牌局"
        : `提前结算投票 ${nextVote.approvedSeats.length}/4`;
    enqueueFeedback({ text: voteText, kind: "vote" });
  }

  const viewerSeat = after.viewerSeat;
  if (viewerSeat !== undefined && before.turnSeat !== viewerSeat && after.turnSeat === viewerSeat && after.stage === "awaiting_discard") {
    enqueueFeedback({ text: "轮到你出牌", kind: "turn" });
    navigator.vibrate?.(80);
  }
}

function playerName(roomSnapshot: RoomSnapshot, seat: number): string {
  return roomSnapshot.players.find((player) => player.seat === seat)?.name ?? `${seat + 1}号位`;
}

function enqueueFeedback(feedback: Feedback): void {
  if (feedbackQueue.length >= 8) feedbackQueue.shift();
  feedbackQueue.push(feedback);
  if (feedbackTimer === undefined) showNextFeedback();
}

function showNextFeedback(): void {
  const feedback = feedbackQueue.shift();
  if (!feedback) {
    actionBanner.classList.add("hidden");
    actionBanner.className = "action-banner hidden";
    feedbackTimer = undefined;
    return;
  }
  actionBanner.textContent = feedback.text;
  actionBanner.className = `action-banner feedback-${feedback.kind}`;
  playSound(feedback.kind);
  if (feedback.kind === "hu") navigator.vibrate?.([100, 60, 160]);
  feedbackTimer = window.setTimeout(showNextFeedback, feedback.kind === "hu" ? 1_600 : 900);
}

function ensureAudioContext(): AudioContext | undefined {
  if (!soundEnabled) return undefined;
  try {
    audioContext ??= new AudioContext();
    void audioContext.resume();
    return audioContext;
  } catch {
    return undefined;
  }
}

function playSound(kind: FeedbackKind): void {
  const context = ensureAudioContext();
  if (!context) return;
  const tones: Record<FeedbackKind, number[]> = {
    discard: [360],
    turn: [520, 660],
    meld: [410, 520],
    hu: [523, 659, 784],
    round: [330, 440],
    vote: [440],
    system: [600],
  };
  tones[kind].forEach((frequency, index) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const start = context.currentTime + index * 0.09;
    oscillator.type = kind === "hu" ? "triangle" : "sine";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(kind === "hu" ? 0.12 : 0.06, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.14);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.16);
  });
}

function clearPendingRequest(): void {
  if (!pendingRequest) return;
  window.clearTimeout(pendingRequest.timeout);
  pendingRequest = undefined;
  renderPendingState();
}

function renderPendingState(): void {
  const busy = Boolean(pendingRequest);
  document.body.classList.toggle("request-pending", busy);
  document.querySelectorAll<HTMLButtonElement>("#lobby button, #room button, #self-hand button, #operation-panel button, #score-summary button")
    .forEach((button) => { button.disabled = busy; });
}

function updateNetworkOverlay(visible: boolean, retryDelay = 0): void {
  networkOverlay.classList.toggle("hidden", !visible || !document.body.classList.contains("in-game"));
  networkDetail.textContent = retryDelay > 0
    ? `${Math.ceil(retryDelay / 1_000)}秒后自动重试，牌局状态会保留`
    : "牌局状态会自动恢复，请稍候";
}

function forceReconnect(): void {
  window.clearTimeout(reconnectTimer);
  window.clearInterval(heartbeatTimer);
  const oldSocket = socket;
  connectionGeneration += 1;
  socket = undefined;
  oldSocket?.close();
  reconnectAttempts = Math.max(1, reconnectAttempts);
  connect();
}

async function shareCurrentRoom(includeResult = false): Promise<void> {
  const roomCode = snapshot?.roomCode ?? currentCode.textContent ?? "";
  const inviteUrl = `${location.origin}/?room=${encodeURIComponent(roomCode)}`;
  const rankingText = includeResult && snapshot?.match.rankings
    ? `，战绩：${snapshot.match.rankings.map((ranking) => `${playerName(snapshot!, ranking.seat)}${ranking.score}分`).join("、")}`
    : "";
  const text = `好友麻将房间 ${roomCode}${rankingText}`;
  try {
    if (navigator.share) await navigator.share({ title: "好友麻将", text, url: inviteUrl });
    else {
      await copyText(`${text}\n${inviteUrl}`);
      showNotice("邀请信息已复制，发给朋友即可加入");
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    try {
      await copyText(`${text}\n${inviteUrl}`);
      showNotice("邀请信息已复制，发给朋友即可加入");
    } catch {
      showNotice("分享失败，请直接告诉朋友房间号");
    }
  }
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // 公网 HTTP 下部分手机不开放 Clipboard API，继续使用兼容方案。
    }
  }
  const helper = document.createElement("textarea");
  helper.value = text;
  helper.style.position = "fixed";
  helper.style.opacity = "0";
  document.body.append(helper);
  helper.select();
  const copied = document.execCommand("copy");
  helper.remove();
  if (!copied) throw new Error("浏览器不支持复制");
}

function returnToLobby(): void {
  if (send({ type: "leave_room" })) showNotice("正在退出房间");
}

async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await gameScreen.requestFullscreen();
    const orientation = screen.orientation as ScreenOrientation & { lock?: (orientation: "landscape") => Promise<void> };
    await orientation.lock?.("landscape");
  } catch {
    showNotice("当前浏览器不支持自动全屏，请手动横屏");
  }
}

function showLobby(): void {
  snapshot = undefined;
  document.body.classList.remove("in-game");
  room.classList.add("hidden");
  gameScreen.classList.add("hidden");
  lobby.classList.remove("hidden");
  networkOverlay.classList.add("hidden");
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

function setRulesVisible(visible: boolean): void {
  rulesOverlay.classList.toggle("hidden", !visible);
  if (visible) rulesCloseButton.focus();
}

function stopHistoryPlayback(): void {
  window.clearInterval(historyPlaybackTimer);
  historyPlaybackTimer = undefined;
  historyPlayButton.textContent = "播放";
}

function setHistoryVisible(visible: boolean): void {
  historyOverlay.classList.toggle("hidden", !visible);
  if (!visible) stopHistoryPlayback();
  else historyCloseButton.focus();
}

function sourceFromSnapshot(roomSnapshot: RoomSnapshot): HistorySource {
  return {
    roomCode: roomSnapshot.roomCode,
    modelVersion: roomSnapshot.game?.modelVersion,
    players: roomSnapshot.players,
    scoreTotals: roomSnapshot.scoreTotals,
    publicActions: roomSnapshot.publicActions,
  };
}

function setHistorySource(source: HistorySource, imported: boolean): void {
  stopHistoryPlayback();
  historySource = source;
  historyRoundSelect.replaceChildren(new Option("全部", "all"));
  const rounds = [...new Set(source.publicActions.map((action) => action.roundNumber).filter((round): round is number => round !== undefined))].sort((a, b) => a - b);
  for (const round of rounds) historyRoundSelect.add(new Option(`第${round}局`, String(round)));
  historyCursor = imported ? 0 : Math.max(0, source.publicActions.length - 1);
  historyEyebrow.textContent = imported ? "本地只读 · 已校验隐私" : "服务端权威记录";
  historyTitle.textContent = imported ? "公共牌局记录回放" : "牌局公开时间线";
  historyExportButton.classList.toggle("hidden", imported);
  historyCloseButton.textContent = imported ? "关闭回放" : "返回牌桌";
  renderActionHistory();
}

function openLiveHistory(): void {
  if (!snapshot) return;
  importedReplay = undefined;
  setHistorySource(sourceFromSnapshot(snapshot), false);
  setHistoryVisible(true);
}

function refreshLiveHistory(roomSnapshot: RoomSnapshot): void {
  if (historyOverlay.classList.contains("hidden") || importedReplay) return;
  const wasLatest = historyCursor >= filteredHistoryActions().length - 1;
  historySource = sourceFromSnapshot(roomSnapshot);
  if (wasLatest) historyCursor = Math.max(0, filteredHistoryActions().length - 1);
  renderActionHistory();
}

function historyPlayerName(source: HistorySource, seat: number): string {
  return source.players.find((player) => player.seat === seat)?.name ?? `${seat + 1}号位`;
}

function describePublicAction(action: PublicActionView, source: HistorySource): string {
  const seatName = (seat: number | undefined) => seat === undefined ? "玩家" : historyPlayerName(source, seat);
  const winners = action.seats?.map((seat) => seatName(seat)).join("、") ?? "";
  const tile = action.tile ? ` ${tileLabel(action.tile)}` : "";
  switch (action.kind) {
    case "round_started": return `${seatName(action.seat)}坐庄，第${action.roundNumber}局开始`;
    case "discard": return `${seatName(action.seat)}打出${tile}`;
    case "chi": return `${seatName(action.seat)}吃牌${tile}`;
    case "peng": return `${seatName(action.seat)}碰牌${tile}`;
    case "ming_gang": return `${seatName(action.seat)}明杠${tile}`;
    case "an_gang": return `${seatName(action.seat)}暗杠`;
    case "jia_gang": return `${seatName(action.seat)}加杠${tile}`;
    case "special_gang": return `${seatName(action.seat)}完成特殊杠`;
    case "zhangmao": return `${seatName(action.seat)}涨毛`;
    case "self_draw_hu": return `${winners}自摸${tile}`;
    case "discard_hu": return `${winners}胡${seatName(action.fromSeat)}打出的${tile}`;
    case "rob_kong_hu": return `${winners}抢杠胡${tile}`;
    case "round_ended": return winners ? `本局结束，赢家：${winners}` : "牌墙耗尽，本局流局";
    case "settlement_requested": return `${seatName(action.seat)}申请提前结算`;
    case "settlement_agreed": return `${seatName(action.seat)}同意提前结算`;
    case "settlement_rejected": return `${seatName(action.seat)}拒绝提前结算`;
    case "round_dissolved": return "全员同意，当前未完成局解散";
    case "turn_timed_out": return `${seatName(action.seat)}超时或托管自动打出${tile}`;
    case "reaction_timed_out": return `${winners || "玩家"}响应超时，自动过牌`;
    case "auto_management_started": return `${seatName(action.seat)}离线90秒，进入托管`;
    case "auto_management_ended": return `${seatName(action.seat)}重连，收回控制权`;
    case "player_disconnected": return `${seatName(action.seat)}暂时离线`;
    case "player_reconnected": return `${seatName(action.seat)}已重连`;
  }
}

function filteredHistoryActions(): PublicActionView[] {
  const actions = historySource?.publicActions ?? [];
  if (historyRoundSelect.value === "all") return actions;
  const round = Number(historyRoundSelect.value);
  return actions.filter((action) => action.roundNumber === round);
}

function setHistoryCursor(next: number): void {
  const actions = filteredHistoryActions();
  historyCursor = actions.length === 0 ? 0 : Math.max(0, Math.min(next, actions.length - 1));
  renderActionHistory();
}

function renderActionHistory(): void {
  historyList.replaceChildren();
  const source = historySource;
  const actions = filteredHistoryActions();
  historyCursor = actions.length === 0 ? 0 : Math.min(historyCursor, actions.length - 1);
  historyProgress.max = String(Math.max(0, actions.length - 1));
  historyProgress.value = String(historyCursor);
  historyProgress.disabled = actions.length < 2;
  historyPrevButton.disabled = actions.length === 0 || historyCursor === 0;
  historyNextButton.disabled = actions.length === 0 || historyCursor === actions.length - 1;
  historyPlayButton.disabled = actions.length < 2;
  historyMeta.textContent = source
    ? `房间 ${source.roomCode} · ${source.modelVersion ?? "未知版本"} · ${actions.length}条${historyRoundSelect.value === "all" ? "" : "本局"}动作`
    : "等待公开动作";
  if (actions.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-history";
    empty.textContent = historyRoundSelect.value === "all" ? "开局后的公开操作会显示在这里" : "这一局没有公开动作";
    historyList.append(empty);
    historyFocus.textContent = "选择一条动作开始回看";
    return;
  }
  const current = actions[historyCursor]!;
  historyFocus.textContent = `第 ${historyCursor + 1}/${actions.length} 步 · ${describePublicAction(current, source!)}`;
  const first = Math.max(0, historyCursor - 5);
  const last = Math.min(actions.length, historyCursor + 6);
  for (let index = last - 1; index >= first; index -= 1) {
    const action = actions[index]!;
    const item = document.createElement("li");
    item.classList.toggle("current", index === historyCursor);
    item.tabIndex = 0;
    const sequence = document.createElement("b");
    sequence.textContent = `#${action.sequence}`;
    const description = document.createElement("span");
    description.textContent = describePublicAction(action, source!);
    item.append(sequence, description);
    item.addEventListener("click", () => setHistoryCursor(index));
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") setHistoryCursor(index);
    });
    historyList.append(item);
  }
}

function toggleHistoryPlayback(): void {
  if (historyPlaybackTimer !== undefined) {
    stopHistoryPlayback();
    return;
  }
  const actions = filteredHistoryActions();
  if (actions.length < 2) return;
  if (historyCursor >= actions.length - 1) historyCursor = 0;
  historyPlayButton.textContent = "暂停";
  renderActionHistory();
  historyPlaybackTimer = window.setInterval(() => {
    const latestActions = filteredHistoryActions();
    if (historyCursor >= latestActions.length - 1) {
      stopHistoryPlayback();
      return;
    }
    setHistoryCursor(historyCursor + 1);
  }, 850);
}

async function importPublicHistory(file: File): Promise<void> {
  try {
    if (file.size > 1_000_000) throw new Error("记录文件不能超过1MB");
    const replay = parsePublicReplay(await file.text());
    importedReplay = replay;
    setHistorySource(replay, true);
    setHistoryVisible(true);
    console.info(JSON.stringify({ event: "public_replay_imported", format: replay.format, roomCode: replay.roomCode, modelVersion: replay.modelVersion, publicActionCount: replay.publicActions.length, privacy: "public_only" }));
    showNotice(`已导入房间 ${replay.roomCode} 的 ${replay.publicActions.length} 条公共动作`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    console.warn(JSON.stringify({ event: "public_replay_import_rejected", reason: message }));
    showNotice(`记录导入失败：${message}`);
  } finally {
    historyFileInput.value = "";
  }
}

async function exportPublicHistory(): Promise<void> {
  if (!snapshot) return;
  const record = {
    format: PUBLIC_REPLAY_FORMAT,
    exportedAt: new Date().toISOString(),
    roomCode: snapshot.roomCode,
    modelVersion: snapshot.game?.modelVersion,
    match: snapshot.match,
    players: snapshot.players.map(({ name, seat, isTestPlayer }) => ({ name, seat, isTestPlayer })),
    scoreTotals: snapshot.scoreTotals,
    publicActions: snapshot.publicActions,
  };
  const json = JSON.stringify(record, null, 2);
  let copied = false;
  try {
    await copyText(json);
    copied = true;
  } catch {
    // 下载仍可作为剪贴板不可用时的后备方案。
  }
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `mahjong-${snapshot.roomCode}-public-record.json`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  showNotice(copied ? "公共记录已复制，并尝试下载JSON" : "公共记录已尝试下载JSON");
}

createButton.addEventListener("click", () => {
  if (!nameInput.value.trim()) return showNotice("请先输入昵称");
  send({ type: "create_room", name: nameInput.value, totalRounds: Number(matchRounds.value) as 8 | 16 });
});
joinButton.addEventListener("click", () => {
  if (!nameInput.value.trim()) return showNotice("请先输入昵称");
  if (!/^\d{6}$/.test(codeInput.value.trim())) return showNotice("请输入六位房间号");
  send({ type: "join_room", roomCode: codeInput.value, name: nameInput.value });
});
readyButton.addEventListener("click", () => {
  const me = snapshot?.players.find((player) => player.id === saved?.playerId);
  send({ type: "set_ready", ready: !me?.ready });
});
fillTestButton.addEventListener("click", () => {
  const hasTestPlayers = snapshot?.players.some((player) => player.isTestPlayer);
  send({ type: hasTestPlayers ? "remove_test_players" : "fill_test_players" });
});
leaveRoomButton.addEventListener("click", returnToLobby);
startButton.addEventListener("click", () => {
  ensureAudioContext();
  send({ type: "start_game" });
});
copyButton.addEventListener("click", async () => {
  const roomCode = currentCode.textContent ?? "";
  try {
    await copyText(`好友麻将房间 ${roomCode}\n${location.origin}/?room=${roomCode}`);
    showNotice("房间号和邀请链接已复制");
  } catch {
    showNotice(`请把房间号 ${roomCode} 发给朋友`);
  }
});
shareRoomButton.addEventListener("click", () => shareCurrentRoom());
soundToggleButton.addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  localStorage.setItem("mahjong-sound", soundEnabled ? "on" : "off");
  soundToggleButton.textContent = soundEnabled ? "声" : "静";
  soundToggleButton.setAttribute("aria-label", soundEnabled ? "关闭音效" : "开启音效");
  if (soundEnabled) playSound("system");
});
fullscreenToggleButton.addEventListener("click", () => toggleFullscreen());
reconnectNowButton.addEventListener("click", forceReconnect);
requestDissolveButton.addEventListener("click", () => {
  requestDissolveButton.disabled = true;
  send({ type: "request_early_settlement" });
});
rulesOpenButton.addEventListener("click", () => setRulesVisible(true));
rulesGameButton.addEventListener("click", () => setRulesVisible(true));
rulesCloseButton.addEventListener("click", () => setRulesVisible(false));
rulesCloseXButton.addEventListener("click", () => setRulesVisible(false));
rulesOverlay.addEventListener("click", (event) => {
  if (event.target === rulesOverlay) setRulesVisible(false);
});
historyImportButton.addEventListener("click", () => historyFileInput.click());
historyFileInput.addEventListener("change", () => {
  const file = historyFileInput.files?.[0];
  if (file) void importPublicHistory(file);
});
historyGameButton.addEventListener("click", openLiveHistory);
historyCloseButton.addEventListener("click", () => setHistoryVisible(false));
historyCloseXButton.addEventListener("click", () => setHistoryVisible(false));
historyExportButton.addEventListener("click", exportPublicHistory);
historyRoundSelect.addEventListener("change", () => {
  stopHistoryPlayback();
  setHistoryCursor(0);
});
historyProgress.addEventListener("input", () => {
  stopHistoryPlayback();
  setHistoryCursor(Number(historyProgress.value));
});
historyPrevButton.addEventListener("click", () => {
  stopHistoryPlayback();
  setHistoryCursor(historyCursor - 1);
});
historyPlayButton.addEventListener("click", toggleHistoryPlayback);
historyNextButton.addEventListener("click", () => {
  stopHistoryPlayback();
  setHistoryCursor(historyCursor + 1);
});
historyOverlay.addEventListener("click", (event) => {
  if (event.target === historyOverlay) setHistoryVisible(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setRulesVisible(false);
    setHistoryVisible(false);
  }
});
window.addEventListener("online", () => {
  if (socket?.readyState !== WebSocket.OPEN) forceReconnect();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && socket?.readyState !== WebSocket.OPEN) forceReconnect();
});
document.addEventListener("pointerdown", () => ensureAudioContext(), { once: true });

soundToggleButton.textContent = soundEnabled ? "声" : "静";
soundToggleButton.setAttribute("aria-label", soundEnabled ? "关闭音效" : "开启音效");
const invitedRoom = new URLSearchParams(location.search).get("room");
if (invitedRoom && /^\d{6}$/.test(invitedRoom)) codeInput.value = invitedRoom;

countdownTimer = window.setInterval(updateActionCountdown, 250);
connect();
