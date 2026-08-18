import type { MeldView, PlayerView, PublicActionView, ReactionOption, RoomSnapshot, ScoreFactor, ScorePaymentView, ServerMessage, TileCode, TurnOperationOption } from "../../shared/protocol.js";
import { MahjongAudioManager, actionVoicePath, customVoicePath, type ActionVoice, type AudioMonitorEvent, type EffectSound, type VoiceGender } from "./audio-manager.js";
import { VoiceChannel } from "./voice-channel.js";
import { PUBLIC_REPLAY_FORMAT, parsePublicReplay, type PublicReplayPlayer, type PublicReplayRecord } from "./public-replay.js";

type SavedSession = { roomCode: string; playerId: string; playerToken: string };
type TablePosition = "bottom" | "right" | "top" | "left";
type FeedbackKind = "discard" | "turn" | "meld" | "hu" | "round" | "vote" | "system";
type TableEffectKind = "chi" | "peng" | "gang" | "hu" | "zimo" | "round";
type Feedback = {
  text: string;
  kind: FeedbackKind;
  tile?: TileCode;
  actionVoice?: ActionVoice;
  customVoice?: string;
  suppressTileVoice?: boolean;
  sound?: EffectSound;
  resultSound?: "win" | "lose";
  visual?: TableEffectKind;
  seat?: number;
};
type HistorySource = {
  roomCode: string;
  modelVersion?: string;
  players: PublicReplayPlayer[];
  scoreTotals: number[];
  publicActions: PublicActionView[];
};

const positions: TablePosition[] = ["bottom", "right", "top", "left"];
const winds = ["东", "南", "西", "北"];
type ThrowableId = "slipper" | "egg" | "potato";
const HU_WIN_VOICES = [
  "1_1_运气眷顾，轻轻松松胡一把_1.wav",
  "1_1_哟呵，牌势到位，胡牌到手_1.wav",
  "1_1_手感在线，这把稳稳胡牌_1.wav",
  "1_1_属实没想到，又让我胡到一把_1.wav",
  "1_1_这牌来得刚刚好，直接胡上_1.wav",
  "1_1_哈哈，机会到手，果断胡牌_1.wav",
  "1_1_牌运爆棚，轻轻松松拿下这局_1.wav",
  "1_1_没想到这么顺利，又被我胡到咯_1.wav",
  "1_1_嘿嘿，这把运气直接拉满，胡啦_1.wav",
  "1_1_手气来了挡都挡不住，胡牌咯！_1.wav",
];
const QUICK_VOICE_FILES = [
  "1_1_快快出牌，别让大家久等呀_1.wav",
  "1_1_还在思考吗，我都等好久咯_1.wav",
  "1_1_慢慢来，好戏还在后头_1.wav",
  "1_1_牌场无常，风水轮流转嘛_1.wav",
  "1_1_输赢无所谓，开心最重要啦_1.wav",
  "1_1_好家伙，这都能被你摸到_1.wav",
  "1_1_可以可以，这一手打得漂亮_1.wav",
  "1_1_别这么猛，给大家留条活路嘛_1.wav",
  "1_1_哟，手气可以啊，佩服佩服_1.wav",
  "1_1_听牌啦，就等那张关键牌_1.wav",
  "1_1_这把有搞头，各位可要小心咯_1.wav",
  "1_1_坐等好牌到来，看谁给我点炮_1.wav",
  "1_1_这牌拿在手里，头都大了_1.wav",
  "1_1_完了完了，这牌怕是很难胡了_1.wav",
];

function quickVoiceText(file: string): string {
  return file.replace(/^1_1_/, "").replace(/_1\.wav$/, "");
}
const THROWABLES: Array<{ id: ThrowableId; emote: string; label: string; impact: string }> = [
  { id: "slipper", emote: "🩴", label: "拖鞋", impact: "🩴💥" },
  { id: "egg", emote: "🥚", label: "鸡蛋", impact: "🍳💥" },
  { id: "potato", emote: "🥔", label: "土豆", impact: "🥔💥" },
];
const lobby = required<HTMLElement>("lobby");
const room = required<HTMLElement>("room");
const gameScreen = required<HTMLElement>("game-screen");
const tableBoard = document.querySelector<HTMLElement>(".table-board");
const waitingControls = required<HTMLElement>("waiting-controls");
const spectatorStrip = required<HTMLElement>("spectator-strip");
const waitingReadyButton = required<HTMLButtonElement>("waiting-ready");
const waitingFillTestButton = required<HTMLButtonElement>("waiting-fill-test");
const waitingStartButton = required<HTMLButtonElement>("waiting-start");
const waitingLeaveButton = required<HTMLButtonElement>("waiting-leave");
const waitingCopyButton = required<HTMLButtonElement>("waiting-copy");
const nameInput = required<HTMLInputElement>("name");
const matchRounds = required<HTMLSelectElement>("match-rounds");
const codeInput = required<HTMLInputElement>("room-code");
const createButton = required<HTMLButtonElement>("create");
const joinButton = required<HTMLButtonElement>("join");
const currentCode = required<HTMLElement>("current-code");
const matchModeLabel = required<HTMLElement>("match-mode-label");
const gameRoomCode = required<HTMLElement>("game-room-code");
const gameMatchProgress = required<HTMLElement>("game-match-progress");
const roundLabel = required<HTMLElement>("round-label");
const tableSeats = required<HTMLElement>("table-seats");
const selfHand = required<HTMLElement>("self-hand");
const selfMeldRack = required<HTMLElement>("self-melds");
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
const audioSettings = required<HTMLElement>("audio-settings");
const voiceToggle = required<HTMLInputElement>("voice-toggle");
const effectsToggle = required<HTMLInputElement>("effects-toggle");
const musicToggle = required<HTMLInputElement>("music-toggle");
const voicePreviewButton = required<HTMLButtonElement>("voice-preview");
const effectPreviewButton = required<HTMLButtonElement>("effect-preview");
const genderFemaleButton = required<HTMLButtonElement>("gender-female");
const genderMaleButton = required<HTMLButtonElement>("gender-male");
const genderPreviewButton = required<HTMLButtonElement>("gender-preview");
const voiceGenderGameSelect = required<HTMLSelectElement>("voice-gender-game");
const fullscreenToggleButton = required<HTMLButtonElement>("fullscreen-toggle");
const actionBanner = required<HTMLElement>("action-banner");
const tableEffect = required<HTMLElement>("table-effect");
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
const startScoreInput = required<HTMLInputElement>("start-score");
const chatToggleButton = required<HTMLButtonElement>("chat-toggle");
const publicChat = required<HTMLElement>("public-chat");
const chatCloseButton = required<HTMLButtonElement>("chat-close");
const chatMessages = required<HTMLElement>("chat-messages");
const chatForm = required<HTMLFormElement>("chat-form");
const chatInput = required<HTMLInputElement>("chat-input");
const chatEmotes = required<HTMLElement>("chat-emotes");
const chatVoiceClips = required<HTMLElement>("chat-voice-clips");
const throwEffect = required<HTMLElement>("throw-effect");
const avatarGrid = required<HTMLElement>("avatar-grid");
const avatarOverlay = required<HTMLElement>("avatar-overlay");
const avatarOverlayGrid = required<HTMLElement>("avatar-overlay-grid");
const avatarOverlayClose = required<HTMLButtonElement>("avatar-overlay-close");
const avatarOverlayConfirm = required<HTMLButtonElement>("avatar-overlay-confirm");
const paymentDetailOverlay = required<HTMLElement>("payment-detail-overlay");
const paymentDetailTitle = required<HTMLElement>("payment-detail-title");
const paymentDetailList = required<HTMLElement>("payment-detail-list");
const paymentDetailClose = required<HTMLButtonElement>("payment-detail-close");
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
let tableEffectTimer: number | undefined;
const feedbackQueue: Feedback[] = [];
const audioManager = new MahjongAudioManager(logAudioMonitor);
let lastServerMessageAt = Date.now();
let reconnectFeedbackPending = false;
let importedReplay: PublicReplayRecord | undefined;
let historySource: HistorySource | undefined;
const voiceChannel = new VoiceChannel({ send: sendDirect, notice: showNotice });
const voiceStates = new Map<number, { micOn: boolean; speakerOn: boolean }>();
let historyCursor = 0;
let historyPlaybackTimer: number | undefined;
let countdownTimer: number | undefined;
let lastCountdownAlarmKey = "";
const AVATAR_IDS = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10", "a11", "a12", "a13", "a14", "a15", "a16", "a17", "a18", "a19", "a20", "a21", "a22"];
let selectedAvatar = localStorage.getItem("mahjong-avatar") ?? "a1";
let drawRenderTimer: number | undefined;
let delayedDrawSnapshot: RoomSnapshot | undefined;
let avatarDraft = selectedAvatar;
if (!AVATAR_IDS.includes(selectedAvatar)) selectedAvatar = "a1";
type ChatEntry = { seat?: number; senderId: string; senderName: string; senderAvatar: string; text: string; emote: boolean; ts: number };
const chatHistory: ChatEntry[] = [];
let selectedHandTile: TileCode | undefined;

function logAudioMonitor(event: AudioMonitorEvent): void {
  const payload = { timestamp: new Date().toISOString(), ...event };
  if (event.event === "audio_asset_failed") console.warn(JSON.stringify(payload));
  else console.info(JSON.stringify(payload));
}

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
}

function avatarUrl(avatar: string): string {
  const id = AVATAR_IDS.includes(avatar) ? avatar : "a1";
  const extension = Number(id.slice(1)) >= 11 ? "png" : "svg";
  return `/assets/avatars/avatar-${id.slice(1)}.${extension}`;
}

function iconSvg(name: "mic" | "mic-off" | "volume" | "volume-x" | "chat" | "slipper"): string {
  const icons: Record<string, string> = {
    mic: '<path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/>',
    "mic-off": '<line x1="2" y1="2" x2="22" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/><line x1="12" y1="19" x2="12" y2="22"/>',
    volume: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
    "volume-x": '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    slipper: '<path d="M4 14c4 0 7-4 7-8V4H5a6 6 0 0 0-1 10z"/><path d="M21 9c-4 0-7 4-7 8v3h5a6 6 0 0 0 2-11z"/><path d="M7 14c3 2 7 2 10 0"/>',
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icons[name] ?? icons.chat}</svg>`;
}

function renderAvatarGrid(container: HTMLElement, current: string, onPick: (id: string) => void): void {
  container.replaceChildren();
  for (const id of AVATAR_IDS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `avatar-option${id === current ? " active" : ""}`;
    button.title = `头像 ${id.slice(1)}`;
    button.dataset.avatar = id;
    const image = document.createElement("img");
    image.src = avatarUrl(id);
    image.alt = "";
    button.append(image);
    button.addEventListener("click", () => {
      container.querySelectorAll(".avatar-option").forEach((option) => option.classList.remove("active"));
      button.classList.add("active");
      onPick(id);
    });
    container.append(button);
  }
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

function sendDirect(message: object): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
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
    clearDelayedDrawRender();
    clearPendingRequest();
    if (snapshot?.roomCode !== message.roomCode) chatHistory.length = 0;
    voiceChannel.reset();
    voiceStates.clear();
    syncVoiceButtons();
    renderChatHistory();
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
    const preCollectDraw = Boolean(
      previous?.game
      && message.snapshot.game
      && message.snapshot.game.wallRemaining < previous.game.wallRemaining,
    );
    if (preCollectDraw) {
      collectSnapshotFeedback(previous, message.snapshot);
      scheduleDelayedDrawRender(message.snapshot, 620);
      return;
    }
    clearDelayedDrawRender();
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
    clearDelayedDrawRender();
    clearPendingRequest();
    voiceChannel.reset();
    voiceStates.clear();
    localStorage.removeItem("mahjong-session");
    saved = undefined;
    snapshot = undefined;
    chatHistory.length = 0;
    renderChatHistory();
    history.replaceState({}, "", "/");
    showLobby();
    showNotice("已退出房间");
  } else if (message.type === "room_closed") {
    clearDelayedDrawRender();
    clearPendingRequest();
    voiceChannel.reset();
    voiceStates.clear();
    localStorage.removeItem("mahjong-session");
    saved = undefined;
    snapshot = undefined;
    chatHistory.length = 0;
    renderChatHistory();
    history.replaceState({}, "", "/");
    showLobby();
    showNotice(`房间 ${message.roomCode} 已由管理员解散：${message.reason}`);
  } else if (message.type === "chat_message") {
    appendChatEntry(message.fromSeat, message.fromId, message.fromName, message.fromAvatar, message.text, false);
    showChatBubble(message.fromSeat, message.fromId, message.text);
  } else if (message.type === "chat_emote") {
    appendChatEntry(message.fromSeat, message.fromId, message.fromName, message.fromAvatar, message.emote, true);
    const throwable = throwableByEmote(message.emote);
    if (throwable) {
      playThrowableThrow(message.fromSeat, message.fromId, message.toSeat, throwable);
    } else {
      showFloatingEmote(message.fromSeat, message.fromId, message.emote);
    }
  } else if (message.type === "chat_voice") {
    if (!QUICK_VOICE_FILES.includes(message.voice)) return;
    const voiceText = quickVoiceText(message.voice);
    appendChatEntry(message.fromSeat, message.fromId, message.fromName, message.fromAvatar, voiceText, false);
    showChatBubble(message.fromSeat, message.fromId, voiceText);
    audioManager.playVoiceFile(customVoicePath(message.voice), 1);
  } else if (message.type === "room_announcement") {
    showNotice(`管理员公告：${message.message}`);
  } else if (message.type === "voice_audio") {
    voiceChannel.handleAudio(message.fromSeat, message.data, message.mimeType);
  } else if (message.type === "voice_state") {
    voiceStates.set(message.fromSeat, { micOn: message.micOn, speakerOn: message.speakerOn });
    syncVoiceButtons();
  } else if (message.type === "pong") {
    setConnection("已连接", true);
  }
}

function render(next: RoomSnapshot): void {
  snapshot = next;
  const me = next.players.find((player) => player.id === saved?.playerId);
  const spectator = next.spectators.find((candidate) => candidate.id === saved?.playerId);
  const isPlaying = next.phase === "playing" && Boolean(next.game);
  audioManager.setInGame(isPlaying && next.match.status !== "completed");
  document.body.classList.add("in-game");
  lobby.classList.add("hidden");
  room.classList.add("hidden");
  gameScreen.classList.remove("hidden");
  currentCode.textContent = next.roomCode;
  matchModeLabel.textContent = `${next.match.totalRounds}局 · ${next.match.startScore ?? 100}分起`;
  gameRoomCode.textContent = next.roomCode;
  gameMatchProgress.textContent = `第${next.game?.roundNumber ?? 1}/${next.match.totalRounds}局`;

  if (isPlaying && next.game) {
    renderTable(next, me);
    waitingControls.classList.add("hidden");
    renderSpectatorStrip(next);
    renderPendingState();
    return;
  }

  renderWaitingTable(next, me, spectator);
  renderPendingState();
}

function clearDelayedDrawRender(): void {
  if (drawRenderTimer !== undefined) window.clearTimeout(drawRenderTimer);
  drawRenderTimer = undefined;
  delayedDrawSnapshot = undefined;
  selfHand.classList.remove("drawing");
}

function scheduleDelayedDrawRender(next: RoomSnapshot, delay: number): void {
  clearDelayedDrawRender();
  delayedDrawSnapshot = next;
  turnStatus.textContent = "摸牌中...";
  selfHand.classList.add("drawing");
  drawRenderTimer = window.setTimeout(() => {
    drawRenderTimer = undefined;
    const pending = delayedDrawSnapshot;
    delayedDrawSnapshot = undefined;
    selfHand.classList.remove("drawing");
    if (pending) render(pending);
  }, delay);
}
function renderWaitingTable(next: RoomSnapshot, me: PlayerView | undefined, spectator: { id: string; name: string; avatar: string; connected: boolean; requestingSeat: boolean } | undefined): void {
  waitingControls.classList.remove("hidden");
  const viewerSeat = me?.seat ?? 0;
  tableSeats.replaceChildren();
  selfMeldRack.replaceChildren();
  for (let seat = 0; seat < 4; seat += 1) {
    const player = next.players.find((candidate) => candidate.seat === seat);
    const position = positionForSeat(seat, viewerSeat);
    const playerSeat = document.createElement("div");
    playerSeat.className = `player-seat seat-${position}${player ? "" : " seat-empty"}${player?.connected === false ? " offline" : ""}`;
    playerSeat.dataset.seat = String(seat);
    const avatarBlock = document.createElement("div");
    avatarBlock.className = "avatar-block";
    const avatar = document.createElement("img");
    avatar.className = "avatar";
    const info = document.createElement("div");
    info.className = "player-info";
    if (player) {
      avatar.src = avatarUrl(player.avatar);
      avatar.alt = "";
      avatar.title = player.id === saved?.playerId ? "点击更换头像" : player.name;
      if (player.id === saved?.playerId) avatar.addEventListener("click", openAvatarPicker);
      const strong = document.createElement("strong");
      strong.textContent = player.id === saved?.playerId ? `${player.name}（我）` : player.name;
      const span = document.createElement("span");
      span.textContent = player.connected
        ? (player.isHost ? "房主 · " : "") + (player.ready ? "已准备" : "在线")
        : "暂离";
      if (player.isTestPlayer) span.textContent += " · 测试";
      info.append(strong, span);
      const actions = document.createElement("div");
      actions.className = "player-actions";
      if (player.id === saved?.playerId) {
        const chatButton = document.createElement("button");
        chatButton.type = "button";
        chatButton.className = "seat-action-btn";
        chatButton.dataset.action = "chat";
        chatButton.dataset.seat = String(seat);
        chatButton.setAttribute("aria-label", "公屏聊天");
        chatButton.innerHTML = iconSvg("chat");
        actions.append(chatButton);
      }
      avatarBlock.append(avatar, actions);
    } else {
      const emptyBox = document.createElement("div");
      emptyBox.className = "avatar seat-empty-avatar";
      const invite = document.createElement("button");
      invite.type = "button";
      invite.className = "seat-empty-invite";
      invite.textContent = "邀";
      invite.title = "邀请好友";
      invite.addEventListener("click", () => void shareCurrentRoom());
      emptyBox.append(invite);
      avatarBlock.append(emptyBox);
      const strong = document.createElement("strong");
      strong.textContent = "等待加入";
      const span = document.createElement("span");
      span.textContent = "邀请好友上桌";
      info.append(strong, span);
    }
    playerSeat.append(avatarBlock, info);
    tableSeats.append(playerSeat);
  }
  renderSpectatorStrip(next);
  waitingReadyButton.textContent = me
    ? (me.ready ? "取消准备" : "准备")
    : spectator
      ? (spectator.requestingSeat ? "已申请上桌" : "申请上桌")
      : "准备";
  const testPlayerCount = next.players.filter((player) => player.isTestPlayer).length;
  const canStart = Boolean(
    me?.isHost
    && next.players.length === 4
    && next.players.every((player) => player.ready && (player.connected || player.isTestPlayer)),
  );
  waitingFillTestButton.textContent = testPlayerCount > 0 ? `移除测试玩家（${testPlayerCount}）` : "一键补齐测试玩家";
  waitingFillTestButton.classList.toggle("hidden", !me?.isHost || (testPlayerCount === 0 && next.players.length >= 4));
  waitingStartButton.classList.toggle("hidden", !canStart);
  waitingReadyButton.classList.toggle("hidden", Boolean(spectator));
  wallStatus.textContent = "等待开局";
  turnStatus.textContent = next.players.length < 4 ? "等待好友加入或补齐测试玩家" : "请各位玩家准备";
  actionCountdown.textContent = "--";
  operationPanel.classList.add("hidden");
  scoreSummary.classList.add("hidden");
  actionBanner.classList.add("hidden");
  selfHand.replaceChildren();
  for (const position of positions) {
    required<HTMLElement>(`discards-${position}`).replaceChildren();
    required<HTMLElement>(`wall-${position}`).replaceChildren();
  }
}

function renderSpectatorStrip(next: RoomSnapshot): void {
  spectatorStrip.replaceChildren();
  if (next.spectators.length === 0) {
    spectatorStrip.classList.add("hidden");
    return;
  }
  spectatorStrip.classList.remove("hidden");
  const label = document.createElement("span");
  label.className = "spectator-label";
  label.textContent = `观战 ${next.spectators.length}`;
  spectatorStrip.append(label);
  const me = next.players.find((player) => player.id === saved?.playerId);
  const hasFreeSeat = next.players.length < 4;
  for (const spectator of next.spectators) {
    const chip = document.createElement("div");
    chip.className = `spectator-chip${spectator.requestingSeat ? " requesting" : ""}${spectator.connected ? "" : " offline"}`;
    chip.dataset.spectatorId = spectator.id;
    const avatar = document.createElement("img");
    avatar.className = "spectator-avatar";
    avatar.src = avatarUrl(spectator.avatar);
    avatar.alt = "";
    const name = document.createElement("span");
    name.className = "spectator-name";
    name.textContent = `${spectator.name}${spectator.id === saved?.playerId ? "（我）" : ""}${spectator.requestingSeat ? " 求上桌" : ""}`;
    chip.append(avatar, name);
    if (me?.isHost && next.phase === "waiting" && hasFreeSeat) {
      const promote = document.createElement("button");
      promote.type = "button";
      promote.className = "spectator-promote";
      promote.dataset.action = "promote";
      promote.dataset.spectatorId = spectator.id;
      promote.textContent = "上桌";
      chip.append(promote);
    }
    spectatorStrip.append(chip);
  }
}

function renderTable(next: RoomSnapshot, me: PlayerView | undefined): void {
  const game = next.game!;
  const viewerSeat = game.viewerSeat ?? me?.seat ?? 0;
  const isSpectator = next.viewerRole === "spectator";
  const canDiscard = game.stage === "awaiting_discard" && game.turnSeat === viewerSeat;
  if (selectedHandTile && !(game.selfHand ?? []).includes(selectedHandTile) && game.selfDrawnTile !== selectedHandTile) {
    selectedHandTile = undefined;
  }
  roundLabel.textContent = `第${game.roundNumber}/${next.match.totalRounds}局 · ${isSpectator ? "观战视角" : `${winds[(viewerSeat - game.dealerSeat + 4) % 4]}位视角`}`;
  wallStatus.textContent = String(game.wallRemaining);
  renderPlayers(next, viewerSeat);
  renderSpectatorStrip(next);
  renderWalls(game.wallRemaining, game.wallRemainingBySeat, viewerSeat);
  renderDiscards(game.discards, viewerSeat);
  renderCenter(game.dealerSeat, game.turnSeat, viewerSeat);
  renderOperations(game.availableOperations ?? [], game.availableTurnOperations ?? []);
  renderScoreSummary(next);
  renderDissolveVote(next, me);
  updateActionCountdown();
  refreshLiveHistory(next);

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
  renderSelfHand(game.selfHand ?? [], game.selfDrawnTile, canDiscard, game.selfDiscardRestrictedTile);
}

function renderPlayers(next: RoomSnapshot, viewerSeat: number): void {
  const game = next.game!;
  tableSeats.replaceChildren();
  selfMeldRack.replaceChildren();
  for (const player of next.players) {
    const position = positionForSeat(player.seat, viewerSeat);
    const playerSeat = document.createElement("div");
    playerSeat.className = `player-seat seat-${position}${game.turnSeat === player.seat ? " active" : ""}${player.connected ? "" : " offline"}${player.autoManaged ? " managed" : ""}`;
    playerSeat.dataset.seat = String(player.seat);
    if (voiceStates.get(player.seat)?.micOn) playerSeat.classList.add("voice-mic");

    const avatarBlock = document.createElement("div");
    avatarBlock.className = "avatar-block";
    const avatar = document.createElement("img");
    avatar.className = "avatar";
    avatar.src = avatarUrl(player.avatar);
    avatar.alt = "";
    const actions = document.createElement("div");
    actions.className = "player-actions";
    const isSpectator = snapshot?.viewerRole === "spectator";
    if (!isSpectator) {
      const micButton = document.createElement("button");
      micButton.type = "button";
      micButton.className = "seat-action-btn";
      micButton.dataset.action = "mic";
      micButton.dataset.seat = String(player.seat);
      micButton.setAttribute("aria-label", "麦克风");
      const speakerButton = document.createElement("button");
      speakerButton.type = "button";
      speakerButton.className = "seat-action-btn";
      speakerButton.dataset.action = "speaker";
      speakerButton.dataset.seat = String(player.seat);
      speakerButton.setAttribute("aria-label", "喇叭");
      actions.append(micButton, speakerButton);
    }
    if (position === "bottom") {
      const chatButton = document.createElement("button");
      chatButton.type = "button";
      chatButton.className = "seat-action-btn";
      chatButton.dataset.action = "chat";
      chatButton.dataset.seat = String(player.seat);
      chatButton.setAttribute("aria-label", "公屏聊天");
      chatButton.innerHTML = iconSvg("chat");
      actions.append(chatButton);
    }
    if (position !== "bottom") {
      const throwControl = document.createElement("div");
      throwControl.className = "throw-control";
      const throwButton = document.createElement("button");
      throwButton.type = "button";
      throwButton.className = "seat-action-btn throw-action";
      throwButton.dataset.action = "throw";
      throwButton.dataset.seat = String(player.seat);
      throwButton.textContent = "丢";
      throwButton.title = `向 ${player.name} 丢东西`;
      const throwMenu = document.createElement("div");
      throwMenu.className = "throw-menu";
      for (const throwable of THROWABLES) {
        const option = document.createElement("button");
        option.type = "button";
        option.className = "throw-menu-button";
        option.dataset.action = "throw-option";
        option.dataset.seat = String(player.seat);
        option.dataset.throwable = throwable.id;
        option.textContent = `${throwable.emote} ${throwable.label}`;
        throwMenu.append(option);
      }
      throwControl.append(throwButton, throwMenu);
      actions.append(throwControl);
    }
    avatarBlock.append(avatar, actions);
    const info = document.createElement("div");
    info.className = "player-info";
    const role = player.seat === game.dealerSeat ? "庄" : winds[(player.seat - game.dealerSeat + 4) % 4];
    info.innerHTML = `<strong></strong><span><b>${role}</b> ${game.handTileCounts[player.seat] ?? 0}张 · ${next.scoreTotals[player.seat] ?? 100}分${player.isTestPlayer ? " · 测试" : player.autoManaged ? " · 托管" : ""}</span>`;
    info.querySelector("strong")!.textContent = player.id === saved?.playerId ? `${player.name}（我）` : player.name;
    playerSeat.append(avatarBlock, info);

    if (position !== "bottom") {
      const rack = document.createElement("div");
      rack.className = "opponent-rack";
      const handCount = game.handTileCounts[player.seat] ?? 0;
      for (let tile = 0; tile < handCount; tile += 1) rack.append(createTileBack());
      playerSeat.append(rack);
    }
    const playerMelds = game.melds.filter((meld) => meld.seat === player.seat);
    if (playerMelds.length > 0) {
      const groups: HTMLElement[] = [];
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
        groups.push(group);
      }
      if (position === "bottom") {
        selfMeldRack.append(...groups);
      } else {
        const meldRack = document.createElement("div");
        meldRack.className = "meld-rack";
        meldRack.append(...groups);
        playerSeat.append(meldRack);
      }
    }
    tableSeats.append(playerSeat);
  }
  syncVoiceButtons();
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
  if (remaining === undefined || remaining !== 5) {
    if (remaining === undefined) lastCountdownAlarmKey = "";
    return;
  }
  const alarmKey = String(deadline);
  if (alarmKey !== lastCountdownAlarmKey) {
    lastCountdownAlarmKey = alarmKey;
    audioManager.playEffect("timeup");
  }
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

  const viewerPlayer = next.players.find((player) => player.id === saved?.playerId);
  const winnerPayments = result.payments ?? game.scorePayments ?? [];
  const selfPanel = document.createElement("div");
  selfPanel.className = "settlement-winners";
  if (!viewerPlayer) {
    const spectatorCard = document.createElement("div");
    spectatorCard.className = "self-result-card is-spectator";
    const title = document.createElement("strong");
    title.textContent = "观战视角";
    const detail = document.createElement("span");
    detail.textContent = result.winnerSeats.length > 0 ? "本局已有玩家胡牌" : "本局流局";
    spectatorCard.append(title, detail);
    selfPanel.append(spectatorCard);
  } else {
    const net = game.scoreDeltas[viewerPlayer.seat] ?? 0;
    const total = next.scoreTotals[viewerPlayer.seat] ?? next.match.startScore ?? 100;
    const isWinner = result.winnerSeats.includes(viewerPlayer.seat);
    const card = document.createElement("div");
    card.className = `self-result-card ${net > 0 ? "is-winner" : net < 0 ? "is-loss" : "is-draw"}`;
    const head = document.createElement("div");
    head.className = "winner-head";
    const avatar = document.createElement("img");
    avatar.className = "winner-avatar";
    avatar.src = avatarUrl(viewerPlayer.avatar);
    avatar.alt = "";
    const identity = document.createElement("div");
    identity.className = "winner-identity";
    const name = document.createElement("strong");
    name.textContent = `${viewerPlayer.name}（我）`;
    const reason = document.createElement("span");
    reason.className = "winner-reason";
    reason.textContent = isWinner ? (result.reason === "self_draw_hu" ? "自摸" : result.reason === "rob_kong_hu" ? "抢杠胡" : "点炮胡") : (net > 0 ? "本局得分" : net < 0 ? "本局失分" : "本局打平");
    identity.append(name, reason);
    const badge = document.createElement("span");
    badge.className = "winner-badge";
    badge.textContent = net > 0 ? "胜" : net < 0 ? "负" : "平";
    head.append(avatar, identity, badge);
    const score = document.createElement("strong");
    score.className = `winner-score ${net >= 0 ? "positive" : "negative"}`;
    score.textContent = `本局 ${net >= 0 ? "+" : ""}${net} 分`;
    const meta = document.createElement("div");
    meta.className = "winner-meta";
    const totalText = document.createElement("span");
    totalText.textContent = `累计 ${total}`;
    meta.append(totalText);
    card.append(head, score, meta);
    if (isWinner) {
      const huPayments = winnerPayments.filter((payment) => payment.toSeat === viewerPlayer.seat && ["self_draw", "discard_hu", "rob_kong_hu"].includes(payment.reason));
      const huGain = huPayments.reduce((sum, payment) => sum + payment.amount, 0);
      const fanFactors = new Set<ScoreFactor>();
      const formulas: string[] = [];
      for (const payment of huPayments) {
        const formula = scoreFactorFormula(payment.factors);
        for (const factor of payment.factors ?? []) {
          if (!["base", "kong", "angang", "zhangmao", "closed_payer"].includes(factor)) fanFactors.add(factor);
        }
        if (formula && !formulas.includes(formula)) formulas.push(formula);
      }
      const huText = document.createElement("span");
      huText.textContent = `胡牌入账 ${huGain >= 0 ? "+" : ""}${huGain} 分`;
      meta.append(huText);
      const fan = document.createElement("div");
      fan.className = "winner-fan";
      const fanCount = fanFactors.size;
      const fanLabel = document.createElement("strong");
      fanLabel.textContent = `${fanCount}番`;
      const fanFormula = document.createElement("span");
      fanFormula.textContent = formulas.join(" / ") || (scoreReasonLabels[result.reason] ?? "胡牌");
      fan.append(fanLabel, fanFormula);
      const payerList = document.createElement("div");
      payerList.className = "winner-payer-list";
      if (huPayments.length === 0) {
        const emptyPayment = document.createElement("span");
        emptyPayment.textContent = "本局没有胡牌支付明细";
        payerList.append(emptyPayment);
      } else {
        for (const payment of huPayments) {
          const payer = next.players.find((candidate) => candidate.seat === payment.fromSeat);
          const payerName = payer ? (payer.id === saved?.playerId ? `${payer.name}（我）` : payer.name) : `${payment.fromSeat + 1}号位`;
          const row = document.createElement("span");
          row.className = "winner-payer";
          row.textContent = `${payerName} -${payment.amount}分 · ${scoreReasonLabels[payment.reason] ?? payment.reason} · ${scoreFactorFormula(payment.factors)}`;
          payerList.append(row);
        }
      }
      card.append(fan, payerList);
    }
    selfPanel.append(card);
  }
  scoreSummary.append(selfPanel);

  const scoreboard = document.createElement("div");
  scoreboard.className = "settlement-matrix";
  const headerRow = document.createElement("div");
  headerRow.className = "matrix-row matrix-header";
  const headerName = document.createElement("span");
  headerName.textContent = "玩家";
  headerRow.append(headerName);
  for (const player of next.players) {
    const cell = document.createElement("span");
    cell.textContent = player.name;
    headerRow.append(cell);
  }
  const roundHeader = document.createElement("span");
  roundHeader.textContent = "本局";
  const totalHeader = document.createElement("span");
  totalHeader.textContent = "累计";
  headerRow.append(roundHeader, totalHeader);
  scoreboard.append(headerRow);

  const payments = result.payments ?? game.scorePayments ?? [];
  const matrix = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  for (const payment of payments) {
    matrix[payment.fromSeat]![payment.toSeat] = (matrix[payment.fromSeat]?.[payment.toSeat] ?? 0) - payment.amount;
    matrix[payment.toSeat]![payment.fromSeat] = (matrix[payment.toSeat]?.[payment.fromSeat] ?? 0) + payment.amount;
  }
  const seatPlayers = [...next.players].sort((left, right) => left.seat - right.seat);
  for (const rowPlayer of seatPlayers) {
    const row = document.createElement("div");
    row.className = `matrix-row${rowPlayer.id === saved?.playerId ? " is-me" : ""}${result.winnerSeats.includes(rowPlayer.seat) ? " is-winner" : ""}`;
    const nameCell = document.createElement("span");
    nameCell.className = "matrix-name";
    nameCell.textContent = rowPlayer.id === saved?.playerId ? `${rowPlayer.name}（我）` : rowPlayer.name;
    row.append(nameCell);
    for (const columnPlayer of seatPlayers) {
      const cell = document.createElement("span");
      cell.className = "matrix-cell";
      if (rowPlayer.seat === columnPlayer.seat) {
        cell.textContent = "—";
        cell.classList.add("matrix-diagonal");
      } else {
        const value = matrix[rowPlayer.seat]?.[columnPlayer.seat] ?? 0;
        if (value === 0) {
          cell.textContent = "0";
          cell.classList.add("matrix-zero");
        } else {
          const button = document.createElement("button");
          button.type = "button";
          button.className = `matrix-cell-button ${value > 0 ? "positive" : "negative"}`;
          button.textContent = `${value > 0 ? "+" : ""}${value}`;
          button.addEventListener("click", () => openPaymentDetail(rowPlayer.seat, columnPlayer.seat, value, payments, next));
          cell.append(button);
        }
      }
      row.append(cell);
    }
    const delta = game.scoreDeltas[rowPlayer.seat] ?? 0;
    const deltaCell = document.createElement("span");
    deltaCell.className = `matrix-total round-delta ${delta > 0 ? "positive" : delta < 0 ? "negative" : ""}`;
    deltaCell.textContent = `${delta >= 0 ? "+" : ""}${delta}`;
    const totalCell = document.createElement("span");
    totalCell.className = "matrix-total";
    totalCell.textContent = String(next.scoreTotals[rowPlayer.seat] ?? next.match.startScore ?? 100);
    row.append(deltaCell, totalCell);
    scoreboard.append(row);
  }
  scoreSummary.append(scoreboard);

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

  if (next.match.status !== "completed" && vote?.status !== "voting" && game.stage === "round_ended") {
    const readyCount = next.players.filter((player) => player.ready).length;
    const allReady = next.players.every((player) => player.ready);
    const myReady = Boolean(me?.ready);
    const readyButton = document.createElement("button");
    readyButton.type = "button";
    readyButton.className = myReady ? "request-settlement-button" : "next-round-button";
    readyButton.textContent = myReady ? `已准备下一局（${readyCount}/4）` : "准备下一局";
    readyButton.disabled = myReady;
    readyButton.addEventListener("click", () => {
      readyButton.disabled = true;
      send({ type: "set_ready", ready: !myReady });
    });
    footer.append(readyButton);
    if (me?.isHost) {
      const nextRound = document.createElement("button");
      nextRound.type = "button";
      nextRound.className = "next-round-button";
      nextRound.disabled = !allReady;
      nextRound.textContent = allReady ? "开始下一局" : `等待全员准备（${readyCount}/4）`;
      nextRound.addEventListener("click", () => {
        if (!allReady) return;
        nextRound.disabled = true;
        send({ type: "start_next_round" });
      });
      footer.append(nextRound);
    }
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

function renderWalls(remaining: number, wallCounts: number[] | undefined, viewerSeat: number): void {
  const baseCount = Math.floor(remaining / positions.length);
  const extraCount = remaining % positions.length;
  positions.forEach((position, wallIndex) => {
    const wall = required<HTMLElement>(`wall-${position}`);
    wall.replaceChildren();
    const absoluteSeat = (viewerSeat + wallIndex) % 4;
    const count = wallCounts?.[absoluteSeat] ?? baseCount + (wallIndex < extraCount ? 1 : 0);
    const isSide = position === "left" || position === "right";
    const deck = document.createElement("div");
    deck.className = isSide ? "wall-deck wall-deck-side" : "wall-deck";
    const farCount = Math.ceil(count / 2);
    const nearCount = count - farCount;
    const farRow = document.createElement("div");
    farRow.className = isSide ? "wall-row wall-row-far wall-row-side" : "wall-row wall-row-far";
    for (let tileIndex = 0; tileIndex < farCount; tileIndex += 1) farRow.append(createTileBack());
    const nearRow = document.createElement("div");
    nearRow.className = isSide ? "wall-row wall-row-near wall-row-side" : "wall-row wall-row-near";
    for (let tileIndex = 0; tileIndex < nearCount; tileIndex += 1) nearRow.append(createTileBack());
    if (isSide) {
      if (position === "left") deck.append(nearRow, farRow);
      else deck.append(farRow, nearRow);
    } else {
      deck.append(farRow, nearRow);
    }
    wall.append(deck);
  });
}

function playDrawEffect(seat: number, viewerSeat: number, drawnTile?: TileCode): void {
  if (!tableBoard) return;
  const position = positionForSeat(seat, viewerSeat);
  const wall = document.getElementById(`wall-${position}`);
  const target = position === "bottom"
    ? selfHand
    : document.querySelector<HTMLElement>(`.seat-${position} .opponent-rack`);
  if (!wall || !target) return;
  const boardRect = tableBoard.getBoundingClientRect();
  const wallRect = wall.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  if (boardRect.width === 0 || boardRect.height === 0) return;
  const scaleX = boardRect.width / 720;
  const scaleY = boardRect.height / 390;
  const startX = (wallRect.left + wallRect.width / 2 - boardRect.left) / scaleX;
  const startY = (wallRect.top + wallRect.height / 2 - boardRect.top) / scaleY;
  const endX = (targetRect.left + targetRect.width / 2 - boardRect.left) / scaleX;
  const endY = (targetRect.top + targetRect.height / 2 - boardRect.top) / scaleY;
  const effect = document.createElement("div");
  effect.className = `draw-effect draw-effect-${position}`;
  const hand = document.createElement("span");
  hand.className = "draw-hand";
  hand.setAttribute("aria-hidden", "true");
  hand.textContent = "🖐️";
  const tile = drawnTile ? createFaceTile(drawnTile, "hand", false) : createTileBack();
  tile.classList.add("draw-tile");
  effect.append(hand, tile);
  effect.style.setProperty("--fx-sx", `${startX}px`);
  effect.style.setProperty("--fx-sy", `${startY}px`);
  effect.style.setProperty("--fx-ex", `${endX}px`);
  effect.style.setProperty("--fx-ey", `${endY}px`);
  tableBoard.append(effect);
  window.setTimeout(() => effect.remove(), 1100);
}

function renderDiscards(discards: Array<{ seat: number; tile: TileCode }>, viewerSeat: number): void {
  for (const position of positions) required<HTMLElement>(`discards-${position}`).replaceChildren();
  discards.forEach((discard, index) => {
    const zone = required<HTMLElement>(`discards-${positionForSeat(discard.seat, viewerSeat)}`);
    const tile = createFaceTile(discard.tile, "discard", false);
    if (index === discards.length - 1) tile.classList.add("latest");
    if (discard.tile === selectedHandTile) tile.classList.add("matching-selected");
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

function renderSelfHand(tiles: TileCode[], drawnTile: TileCode | undefined, canDiscard: boolean, restrictedTile?: TileCode): void {
  selfHand.classList.remove("drawing");
  selfHand.replaceChildren();
  const hand = [...tiles];
  let drawn: TileCode | undefined;
  if (drawnTile) {
    const index = hand.lastIndexOf(drawnTile);
    if (index >= 0) drawn = hand.splice(index, 1)[0];
  }
  for (const code of hand) {
    const tile = createFaceTile(code, "hand", true, canDiscard, canDiscard && code === restrictedTile);
    if (code === selectedHandTile) tile.classList.add("selected");
    selfHand.append(tile);
  }
  if (drawn) {
    const tile = createFaceTile(drawn, "hand", true, canDiscard, canDiscard && drawn === restrictedTile);
    tile.classList.add("drawn");
    if (drawn === selectedHandTile) tile.classList.add("selected");
    selfHand.append(tile);
  }
}

function syncSelectedTileUI(): void {
  selfHand.querySelectorAll<HTMLElement>(".hand-tile").forEach((tile) => {
    tile.classList.toggle("selected", tile.dataset.tile === selectedHandTile);
  });
  document.querySelectorAll<HTMLElement>(".discard-tile").forEach((tile) => {
    tile.classList.toggle("matching-selected", tile.dataset.tile === selectedHandTile);
  });
}

function createFaceTile(code: TileCode, size: "hand" | "discard" | "meld", interactive: boolean, canDiscard = true, restricted = false): HTMLElement {
  const tile = document.createElement(interactive ? "button" : "div");
  if (tile instanceof HTMLButtonElement) {
    tile.type = "button";
    tile.addEventListener("click", () => {
      if (restricted) {
        showNotice(`本回合不能打出 ${tileLabel(code)}`);
        return;
      }
      if (selectedHandTile !== code) {
        selectedHandTile = code;
        syncSelectedTileUI();
        showNotice(canDiscard ? `已选中 ${tileLabel(code)}，再次点击打出` : `已选中 ${tileLabel(code)}，轮到你后才能打出`);
        return;
      }
      if (!canDiscard) {
        showNotice("还没轮到你，不能打出");
        return;
      }
      selectedHandTile = undefined;
      syncSelectedTileUI();
      if (send({ type: "discard_tile", tile: code })) {
        selfHand.querySelectorAll("button").forEach((button) => ((button as HTMLButtonElement).disabled = true));
        tile.classList.add("discarding");
        showNotice(`已打出 ${tileLabel(code)}`);
      }
    });
  }
  tile.className = `tile-shell ${size}-tile${restricted ? " restricted" : ""}`;
  tile.dataset.tile = code;
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
  if (!after || (previous && previous.roomCode !== next.roomCode)) return;
  if (!before) {
    enqueueFeedback({ text: `第${after.roundNumber}局开始 · ${playerName(next, after.dealerSeat)}坐庄`, kind: "round", sound: "shuffle", visual: "round", seat: after.dealerSeat });
    return;
  }
  if (after.roundNumber !== before.roundNumber) {
    enqueueFeedback({ text: `第${after.roundNumber}局开始 · ${playerName(next, after.dealerSeat)}坐庄`, kind: "round", sound: "shuffle", visual: "round", seat: after.dealerSeat });
    return;
  }

  if (after.wallRemaining < (before.wallRemaining ?? 0)) {
    const drawnSeat = after.stage === "awaiting_discard" ? after.turnSeat : undefined;
    const lastDiscard = after.discards.length > before.discards.length ? after.discards[after.discards.length - 1] : undefined;
    const seat = drawnSeat ?? lastDiscard?.seat ?? after.dealerSeat;
    const viewerSeat = after.viewerSeat ?? next.players.find((player) => player.id === saved?.playerId)?.seat ?? 0;
    const drawnPosition = positionForSeat(seat, viewerSeat);
    const consumedWall = document.getElementById(`wall-${drawnPosition}`);
    if (consumedWall) {
      consumedWall.classList.remove("wall-shrink");
      void consumedWall.offsetWidth;
      consumedWall.classList.add("wall-shrink");
      window.setTimeout(() => consumedWall.classList.remove("wall-shrink"), 600);
    }
    playDrawEffect(seat, viewerSeat, seat === after.viewerSeat ? after.selfDrawnTile : undefined);
  }

  const meldIdentity = (meld: MeldView): string => `${meld.seat}|${meld.kind}|${meld.fromSeat}|${meld.gangType ?? ""}|${meld.specialType ?? ""}|${meld.growthCount ?? 0}|${meld.hiddenTileCount ?? 0}|${meld.tiles.join(",")}`;
  const beforeMeldCounts = new Map<string, number>();
  for (const meld of before.melds) {
    const key = meldIdentity(meld);
    beforeMeldCounts.set(key, (beforeMeldCounts.get(key) ?? 0) + 1);
  }
  after.melds.forEach((meld) => {
    const key = meldIdentity(meld);
    const matched = beforeMeldCounts.get(key) ?? 0;
    if (matched > 0) {
      beforeMeldCounts.set(key, matched - 1);
      return;
    }
    const isChi = meld.kind === "chi";
    const isPeng = meld.kind === "peng";
    const isSpecialGang = meld.kind === "special_gang";
    const isZhangmao = isSpecialGang && Boolean(meld.growthCount);
    const label = isChi ? "吃" : isPeng ? "碰" : isZhangmao ? "涨毛" : isSpecialGang ? "特殊杠" : "杠";
    const actionVoice: ActionVoice | undefined = isChi ? "chi" : isPeng ? "peng" : isSpecialGang ? undefined : "gang";
    const customVoice = isZhangmao
      ? customVoicePath("1_1_涨毛_1.wav")
      : isSpecialGang
        ? customVoicePath(meld.specialType === "dragons" ? "1_1_中_发_白_1.wav" : "1_1_东_南_西_北_1.wav")
        : undefined;
    enqueueFeedback({
      text: `${playerName(next, meld.seat)} ${label}`,
      kind: "meld",
      actionVoice,
      customVoice,
      visual: isChi ? "chi" : isPeng ? "peng" : "gang",
      seat: meld.seat,
    });
  });

  if (after.discards.length > before.discards.length) {
    for (const discard of after.discards.slice(before.discards.length).slice(-4)) {
      enqueueFeedback({ text: `${playerName(next, discard.seat)} 打出 ${tileLabel(discard.tile)}`, kind: "discard", tile: discard.tile, seat: discard.seat });
    }
    queueMicrotask(() => document.querySelector(".discard-tile.latest")?.classList.add("new-discard"));
  }

  if (!before.roundResult && after.roundResult) {
    if (after.roundResult.winnerSeats.length > 0) {
      const winners = after.roundResult.winnerSeats.map((seat) => playerName(next, seat)).join("、");
      const label = after.roundResult.reason === "self_draw_hu" ? "自摸" : after.roundResult.reason === "rob_kong_hu" ? "抢杠胡" : "胡牌";
      const viewerWon = after.viewerSeat !== undefined && after.roundResult.winnerSeats.includes(after.viewerSeat);
      enqueueFeedback({
        text: `${winners} ${label}`,
        kind: "hu",
        customVoice: randomHuVoicePath(),
        resultSound: viewerWon ? "win" : "lose",
        visual: after.roundResult.reason === "self_draw_hu" ? "zimo" : "hu",
        seat: after.roundResult.winnerSeats[0],
      });
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
    enqueueFeedback({ text: "轮到你出牌", kind: "turn", sound: "select", seat: viewerSeat });
    navigator.vibrate?.(80);
  }
}

function randomHuVoicePath(): string {
  const candidates = [actionVoicePath("hu"), ...HU_WIN_VOICES.map(customVoicePath)];
  return candidates[Math.floor(Math.random() * candidates.length)]!;
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
  playFeedbackAudio(feedback);
  if (feedback.visual) showTableEffect(feedback.visual, feedback.seat);
  if (feedback.kind === "hu") navigator.vibrate?.([100, 60, 160]);
  feedbackTimer = window.setTimeout(showNextFeedback, feedback.kind === "hu" ? 1_600 : 900);
}

function playFeedbackAudio(feedback: Feedback): void {
  if (feedback.tile && !feedback.actionVoice && !feedback.customVoice && !feedback.suppressTileVoice) {
    audioManager.playEffect("discard");
    window.setTimeout(() => audioManager.playTile(feedback.tile!), 55);
  }
  if (feedback.customVoice) {
    audioManager.playVoiceFile(feedback.customVoice, feedback.kind === "hu" ? 1 : 0.92);
  } else if (feedback.actionVoice) {
    audioManager.playAction(feedback.actionVoice);
  }
  if (feedback.sound) {
    audioManager.playEffect(feedback.sound);
    if (feedback.sound === "shuffle") audioManager.playEffect("deal", 380);
  }
  if (feedback.resultSound) audioManager.playEffect(feedback.resultSound, 420);
  if (!feedback.tile && !feedback.actionVoice && !feedback.customVoice && !feedback.sound && (feedback.kind === "vote" || feedback.kind === "system")) {
    audioManager.playEffect("ui");
  }
}

function showTableEffect(kind: TableEffectKind, seat: number | undefined): void {
  window.clearTimeout(tableEffectTimer);
  const effectAssets: Partial<Record<TableEffectKind, string>> = {
    peng: "/assets/babykylin/efx/peng_glow2.png",
    gang: "/assets/babykylin/efx/gang_glow2.png",
    hu: "/assets/babykylin/efx/hu_glow4.png",
    zimo: "/assets/babykylin/efx/zimo_glow2.png",
  };
  const labels: Record<TableEffectKind, string> = { chi: "吃", peng: "碰", gang: "杠", hu: "胡", zimo: "自摸", round: "开局" };
  const viewerSeat = snapshot?.game?.viewerSeat ?? 0;
  const position = seat === undefined ? "center" : positionForSeat(seat, viewerSeat);
  tableEffect.replaceChildren();
  tableEffect.className = `table-effect effect-${kind} effect-at-${position}`;
  const asset = effectAssets[kind];
  if (asset) {
    const image = document.createElement("img");
    image.src = asset;
    image.alt = "";
    tableEffect.append(image);
  }
  const label = document.createElement("strong");
  label.textContent = labels[kind];
  tableEffect.append(label);
  spawnTableParticles(kind);
  tableEffectTimer = window.setTimeout(() => {
    tableEffect.className = "table-effect hidden";
    tableEffect.replaceChildren();
  }, kind === "hu" || kind === "zimo" ? 1_550 : 1_050);
}

function spawnTableParticles(kind: TableEffectKind): void {
  const palette: Record<TableEffectKind, string[]> = {
    chi: ["#9bd7ff", "#d7f0ff", "#6fb8ff"],
    peng: ["#d7b7ff", "#ffe3b3", "#b78bff"],
    gang: ["#8ff0ff", "#d4f8ff", "#4bc6ff"],
    hu: ["#ffd36b", "#ff9d5c", "#fff0b3"],
    zimo: ["#ffd36b", "#ff9d5c", "#fff0b3"],
    round: ["#fff3c4", "#ffd36b", "#9bd7ff"],
  };
  const colors = palette[kind];
  const count = kind === "hu" || kind === "zimo" ? 14 : 10;
  for (let index = 0; index < count; index += 1) {
    const particle = document.createElement("i");
    particle.className = "fx-particle";
    const angle = (Math.PI * 2 * index) / count + Math.random() * 0.35;
    const distance = kind === "hu" || kind === "zimo" ? 100 + Math.random() * 45 : 64 + Math.random() * 36;
    particle.style.setProperty("--dx", `${Math.cos(angle) * distance}px`);
    particle.style.setProperty("--dy", `${Math.sin(angle) * distance}px`);
    particle.style.setProperty("--fx-color", colors[index % colors.length]!);
    particle.style.setProperty("--fx-scale", String(0.7 + Math.random() * 0.9));
    tableEffect.append(particle);
  }
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
  document.querySelectorAll<HTMLButtonElement>("#lobby button, #room button, #waiting-controls button, #spectator-strip button, #self-hand button, #operation-panel button, #score-summary button")
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
  voiceChannel.reset();
  voiceStates.clear();
  audioManager.setInGame(false);
  setAudioSettingsVisible(false);
  document.body.classList.remove("in-game");
  room.classList.add("hidden");
  gameScreen.classList.add("hidden");
  waitingControls.classList.add("hidden");
  spectatorStrip.classList.add("hidden");
  lobby.classList.remove("hidden");
  networkOverlay.classList.add("hidden");
  setChatVisible(false);
  avatarOverlay.classList.add("hidden");
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

const scoreFactorLabels: Record<ScoreFactor, string> = {
  base: "底分2",
  self_draw: "自摸×2",
  discard: "点炮×2",
  dealer: "庄家×2",
  closed_winner: "赢家闭门×2",
  closed_payer: "付家闭门×2",
  pengpeng_hu: "碰碰胡×2",
  seven_pairs: "七小对×2",
  sanbu_lao: "三不烙×2",
  kong: "明/加/特殊杠2分",
  angang: "暗杠4分",
  zhangmao: "涨毛1分",
};

const scoreReasonLabels: Record<string, string> = {
  self_draw: "自摸",
  discard_hu: "点炮胡",
  rob_kong_hu: "抢杠胡",
  ming_gang: "明杠",
  an_gang: "暗杠",
  jia_gang: "加杠",
  special_gang: "特殊杠",
  zhangmao: "涨毛",
};

function scoreFactorFormula(factors: ScoreFactor[] | undefined): string {
  if (!factors?.length) return "";
  return factors.map((factor) => scoreFactorLabels[factor]).join(" × ");
}

function openPaymentDetail(rowSeat: number, columnSeat: number, value: number, payments: ScorePaymentView[], next: RoomSnapshot): void {
  const rowName = playerName(next, rowSeat);
  const columnName = playerName(next, columnSeat);
  const relevant = value < 0
    ? payments.filter((payment) => payment.fromSeat === rowSeat && payment.toSeat === columnSeat)
    : payments.filter((payment) => payment.fromSeat === columnSeat && payment.toSeat === rowSeat);
  paymentDetailTitle.textContent = value < 0 ? `${rowName} 支付给 ${columnName}` : `${rowName} 从 ${columnName} 获得`;
  paymentDetailList.replaceChildren();
  if (relevant.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "没有对应支付记录";
    paymentDetailList.append(empty);
  } else {
    for (const payment of relevant) {
      const item = document.createElement("div");
      item.className = "payment-detail-item";
      const heading = document.createElement("strong");
      heading.textContent = `${value < 0 ? "-" : "+"}${payment.amount} 分 · ${scoreReasonLabels[payment.reason] ?? payment.reason}`;
      const formula = scoreFactorFormula(payment.factors);
      const body = document.createElement("small");
      body.textContent = formula || `${payment.fromSeat + 1}号位 → ${payment.toSeat + 1}号位`;
      item.append(heading, body);
      paymentDetailList.append(item);
    }
  }
  paymentDetailOverlay.classList.remove("hidden");
}

function syncVoiceButtons(): void {
  const mySeat = snapshot?.game?.viewerSeat ?? snapshot?.players.find((player) => player.id === saved?.playerId)?.seat;
  document.querySelectorAll<HTMLElement>(".player-seat[data-seat]").forEach((seatElement) => {
    const seat = Number(seatElement.dataset.seat);
    const isMe = seat === mySeat;
    const micOn = isMe ? voiceChannel.micOn : Boolean(voiceStates.get(seat)?.micOn);
    const speakerOn = isMe ? voiceChannel.speakerOn : (voiceStates.get(seat)?.speakerOn ?? true);
    const micButton = seatElement.querySelector<HTMLButtonElement>('[data-action="mic"]');
    const speakerButton = seatElement.querySelector<HTMLButtonElement>('[data-action="speaker"]');
    if (micButton) {
      micButton.classList.toggle("active", micOn);
      micButton.classList.toggle("mic-off", !micOn);
      micButton.innerHTML = iconSvg(micOn ? "mic" : "mic-off");
      micButton.title = isMe ? (micOn ? "关闭麦克风" : "打开麦克风") : (micOn ? "正在说话" : "麦克风关闭");
      micButton.setAttribute("aria-pressed", String(micOn));
    }
    if (speakerButton) {
      speakerButton.classList.toggle("active", speakerOn);
      speakerButton.innerHTML = iconSvg(speakerOn ? "volume" : "volume-x");
      speakerButton.title = isMe ? (speakerOn ? "关闭喇叭" : "打开喇叭") : (speakerOn ? "正在收听" : "喇叭关闭");
      speakerButton.setAttribute("aria-pressed", String(speakerOn));
    }
    seatElement.classList.toggle("voice-mic", micOn);
  });
}

function appendChatEntry(seat: number | undefined, senderId: string, senderName: string, senderAvatar: string, text: string, emote: boolean): void {
  chatHistory.push({ seat, senderId, senderName, senderAvatar, text, emote, ts: Date.now() });
  if (chatHistory.length > 60) chatHistory.shift();
  renderChatHistory();
}

function renderChatHistory(): void {
  chatMessages.replaceChildren();
  for (const entry of chatHistory) {
    const row = document.createElement("div");
    row.className = `chat-entry${entry.senderId === saved?.playerId ? " me" : ""}`;
    if (entry.emote) {
      const avatar = document.createElement("img");
      avatar.className = "chat-avatar";
      avatar.src = avatarUrl(entry.senderAvatar);
      avatar.alt = "";
      const emoteText = document.createElement("span");
      emoteText.className = "chat-emote-text";
      emoteText.textContent = entry.text;
      row.append(avatar, emoteText);
    } else {
      const avatar = document.createElement("img");
      avatar.className = "chat-avatar";
      avatar.src = avatarUrl(entry.senderAvatar);
      avatar.alt = "";
      const name = document.createElement("span");
      name.className = "chat-name";
      name.textContent = `${entry.senderName}：`;
      const body = document.createElement("span");
      body.textContent = entry.text;
      row.append(avatar, name, body);
    }
    chatMessages.append(row);
  }
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function setChatVisible(visible: boolean): void {
  publicChat.classList.toggle("hidden", !visible);
  chatToggleButton.classList.toggle("active", visible);
  if (visible) chatInput.focus();
}

function toggleMicFromSeat(): Promise<void> {
  return voiceChannel.toggleMic().then((result) => {
    syncVoiceButtons();
    sendDirect({ type: "voice_state", micOn: result.micOn, speakerOn: voiceChannel.speakerOn });
  });
}

function toggleSpeakerFromSeat(): void {
  const result = voiceChannel.toggleSpeaker();
  syncVoiceButtons();
  sendDirect({ type: "voice_state", micOn: voiceChannel.micOn, speakerOn: result.speakerOn });
}

function throwableByEmote(emote: string): ThrowableId | undefined {
  return THROWABLES.find((item) => item.emote === emote || item.id === emote)?.id;
}

function throwableConfig(id: ThrowableId): (typeof THROWABLES)[number] {
  return THROWABLES.find((item) => item.id === id) ?? THROWABLES[0]!;
}

function throwAtSeat(targetSeat: number, throwableId: ThrowableId): void {
  const throwable = throwableConfig(throwableId);
  sendDirect({ type: "chat_emote", emote: throwable.emote, toSeat: targetSeat });
}

function playThrowableThrow(fromSeat: number | undefined, fromId: string, toSeat: number | undefined, throwableId: ThrowableId): void {
  const throwable = throwableConfig(throwableId);
  const source = fromSeat === undefined
    ? document.querySelector<HTMLElement>(`.spectator-chip[data-spectator-id="${fromId}"]`)
    : document.querySelector<HTMLElement>(`.player-seat[data-seat="${fromSeat}"]`);
  const target = toSeat === undefined ? undefined : document.querySelector<HTMLElement>(`.player-seat[data-seat="${toSeat}"] .avatar`);
  const startRect = source?.getBoundingClientRect();
  const endRect = target?.getBoundingClientRect() ?? (toSeat === undefined ? undefined : document.querySelector<HTMLElement>(`.player-seat[data-seat="${toSeat}"]`)?.getBoundingClientRect()) ?? source?.getBoundingClientRect();
  if (!startRect || !endRect) {
    showImpactBurst(window.innerWidth / 2, window.innerHeight / 2, throwable.impact);
    return;
  }
  const startX = startRect.left + startRect.width / 2 - 22;
  const startY = startRect.top + startRect.height / 2 - 22;
  const endX = endRect.left + endRect.width / 2 - 22;
  const endY = endRect.top + endRect.height / 2 - 22;
  const impactX = endRect.left + endRect.width / 2;
  const impactY = endRect.top + endRect.height / 2;
  const projectile = document.createElement("div");
  projectile.className = "flying-slipper flying-throwable";
  projectile.textContent = throwable.emote;
  projectile.style.setProperty("--fx-sx", `${startX}px`);
  projectile.style.setProperty("--fx-sy", `${startY}px`);
  projectile.style.setProperty("--fx-ex", `${endX}px`);
  projectile.style.setProperty("--fx-ey", `${endY}px`);
  projectile.style.setProperty("--fx-sr", `${Math.random() > 0.5 ? 1 : -1 * (360 + Math.random() * 200)}deg`);
  throwEffect.append(projectile);
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    projectile.remove();
    showImpactBurst(impactX, impactY, throwable.impact);
  };
  projectile.addEventListener("animationend", finish, { once: true });
  window.setTimeout(finish, 850);
}

function showImpactBurst(x: number, y: number, impact: string): void {
  const burst = document.createElement("div");
  burst.className = "smack-burst";
  burst.style.left = `${x}px`;
  burst.style.top = `${y}px`;
  const fallback = document.createElement("div");
  fallback.className = "smack-fallback";
  fallback.textContent = impact;
  burst.append(fallback);
  throwEffect.append(burst);
  window.setTimeout(() => burst.remove(), 1350);
}

function showFloatingEmote(seat: number | undefined, senderId: string, emote: string): void {
  const seatElement = seat === undefined
    ? document.querySelector<HTMLElement>(`.spectator-chip[data-spectator-id="${senderId}"]`)
    : document.querySelector<HTMLElement>(`.player-seat[data-seat="${seat}"]`);
  const rect = seatElement?.getBoundingClientRect();
  if (!rect) {
    const fallback = document.querySelector<HTMLElement>("#spectator-strip") ?? chatToggleButton;
    const fallbackRect = fallback?.getBoundingClientRect();
    if (!fallbackRect) return;
    const bubble = document.createElement("div");
    bubble.className = "emote-bubble";
    bubble.textContent = emote;
    bubble.style.left = `${fallbackRect.left + fallbackRect.width / 2}px`;
    bubble.style.top = `${fallbackRect.top}px`;
    throwEffect.append(bubble);
    window.setTimeout(() => bubble.remove(), 1700);
    return;
  }
  const bubble = document.createElement("div");
  bubble.className = "emote-bubble";
  bubble.textContent = emote;
  bubble.style.left = `${rect.left + rect.width / 2}px`;
  bubble.style.top = `${rect.top + 8}px`;
  throwEffect.append(bubble);
  window.setTimeout(() => bubble.remove(), 1700);
}

function showChatBubble(seat: number | undefined, senderId: string, text: string): void {
  const target = seat === undefined
    ? document.querySelector<HTMLElement>(`.spectator-chip[data-spectator-id="${senderId}"]`)
    : document.querySelector<HTMLElement>(`.player-seat[data-seat="${seat}"] .avatar-block`);
  const rect = target?.getBoundingClientRect();
  if (!rect) return;
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  bubble.textContent = text;
  bubble.style.left = `${rect.left + rect.width / 2}px`;
  bubble.style.top = `${rect.top - 4}px`;
  throwEffect.append(bubble);
  window.setTimeout(() => bubble.remove(), 2600);
}

function pickAvatarOverlay(id: string): void {
  avatarDraft = id;
  renderAvatarGrid(avatarOverlayGrid, id, pickAvatarOverlay);
}

function openAvatarPicker(): void {
  avatarDraft = selectedAvatar;
  renderAvatarGrid(avatarOverlayGrid, avatarDraft, pickAvatarOverlay);
  avatarOverlay.classList.remove("hidden");
}

function applyAvatarSelection(): void {
  const active = avatarOverlayGrid.querySelector<HTMLButtonElement>(".avatar-option.active");
  const picked = active?.dataset.avatar ?? avatarDraft;
  selectedAvatar = AVATAR_IDS.includes(picked) ? picked : "a1";
  localStorage.setItem("mahjong-avatar", selectedAvatar);
  renderAvatarGrid(avatarGrid, selectedAvatar, pickLobbyAvatar);
  if (saved && snapshot) sendDirect({ type: "update_avatar", avatar: selectedAvatar });
  avatarOverlay.classList.add("hidden");
}

function pickLobbyAvatar(id: string): void {
  selectedAvatar = id;
  localStorage.setItem("mahjong-avatar", id);
  renderAvatarGrid(avatarGrid, id, pickLobbyAvatar);
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
  localStorage.setItem("mahjong-nickname", nameInput.value.trim());
  const startScore = Number(startScoreInput.value);
  send({ type: "create_room", name: nameInput.value, avatar: selectedAvatar, totalRounds: Number(matchRounds.value) as 8 | 16, startScore: Number.isFinite(startScore) ? startScore : 100 });
});
joinButton.addEventListener("click", () => {
  if (!nameInput.value.trim()) return showNotice("请先输入昵称");
  if (!/^\d{6}$/.test(codeInput.value.trim())) return showNotice("请输入六位房间号");
  localStorage.setItem("mahjong-nickname", nameInput.value.trim());
  const asSpectator = new URLSearchParams(location.search).get("watch") === "1";
  send({ type: "join_room", roomCode: codeInput.value, name: nameInput.value, avatar: selectedAvatar, asSpectator });
});
waitingReadyButton.addEventListener("click", () => {
  const me = snapshot?.players.find((player) => player.id === saved?.playerId);
  if (me) send({ type: "set_ready", ready: !me.ready });
  else if (snapshot?.spectators.some((candidate) => candidate.id === saved?.playerId)) {
    send({ type: "request_seat" });
  }
});
waitingFillTestButton.addEventListener("click", () => {
  const hasTestPlayers = snapshot?.players.some((player) => player.isTestPlayer);
  send({ type: hasTestPlayers ? "remove_test_players" : "fill_test_players" });
});
waitingLeaveButton.addEventListener("click", returnToLobby);
waitingStartButton.addEventListener("click", () => {
  audioManager.activate();
  audioManager.setInGame(true);
  send({ type: "start_game" });
});
waitingCopyButton.addEventListener("click", async () => {
  const roomCode = currentCode.textContent ?? "";
  try {
    await copyText(`好友麻将房间 ${roomCode}\n${location.origin}/?room=${roomCode}`);
    showNotice("房间号和邀请链接已复制");
  } catch {
    showNotice(`请把房间号 ${roomCode} 发给朋友`);
  }
});
spectatorStrip.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-action='promote']");
  if (!button?.dataset.spectatorId) return;
  send({ type: "promote_spectator", spectatorId: button.dataset.spectatorId });
});
shareRoomButton.addEventListener("click", () => shareCurrentRoom());
soundToggleButton.addEventListener("click", () => {
  setAudioSettingsVisible(audioSettings.classList.contains("hidden"));
});
for (const toggle of [voiceToggle, effectsToggle, musicToggle]) {
  toggle.addEventListener("change", () => {
    audioManager.updateSettings({ voice: voiceToggle.checked, effects: effectsToggle.checked, music: musicToggle.checked });
    syncAudioSettingsUI();
    syncVoiceButtons();
  });
}
voicePreviewButton.addEventListener("click", () => {
  audioManager.activate();
  audioManager.playTile("wan-1");
});
effectPreviewButton.addEventListener("click", () => {
  audioManager.activate();
  audioManager.playAction("hu");
  audioManager.playEffect("win", 380);
  showTableEffect("hu", snapshot?.game?.viewerSeat);
});
for (const [button, gender] of [[genderFemaleButton, "female"], [genderMaleButton, "male"]] as const) {
  button.addEventListener("click", () => {
    audioManager.setGender(gender);
    syncAudioSettingsUI();
  });
}
genderPreviewButton.addEventListener("click", () => {
  audioManager.activate();
  audioManager.playTile("wan-1");
});
voiceGenderGameSelect.addEventListener("change", () => {
  audioManager.setGender(voiceGenderGameSelect.value as VoiceGender);
  syncAudioSettingsUI();
});
fullscreenToggleButton.addEventListener("click", () => toggleFullscreen());
function closeThrowMenus(): void {
  document.querySelectorAll<HTMLElement>(".throw-menu.open").forEach((menu) => menu.classList.remove("open"));
}

tableSeats.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "mic") void toggleMicFromSeat();
  else if (action === "speaker") toggleSpeakerFromSeat();
  else if (action === "chat") setChatVisible(publicChat.classList.contains("hidden"));
  else if (action === "throw") {
    const control = button.closest<HTMLElement>(".throw-control");
    const menu = control?.querySelector<HTMLElement>(".throw-menu");
    const wasOpen = menu?.classList.contains("open") ?? false;
    closeThrowMenus();
    if (menu && !wasOpen) menu.classList.add("open");
  } else if (action === "throw-option") {
    const targetSeat = Number(button.dataset.seat);
    const throwable = button.dataset.throwable as ThrowableId | undefined;
    closeThrowMenus();
    if (Number.isInteger(targetSeat) && throwable && THROWABLES.some((item) => item.id === throwable)) {
      throwAtSeat(targetSeat, throwable);
    }
  }
});

document.addEventListener("click", (event) => {
  if (!(event.target as HTMLElement).closest(".throw-control")) closeThrowMenus();
});
chatToggleButton.addEventListener("click", () => setChatVisible(publicChat.classList.contains("hidden")));
chatCloseButton.addEventListener("click", () => setChatVisible(false));
chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  sendDirect({ type: "chat_message", text });
  chatInput.value = "";
});
for (const voice of QUICK_VOICE_FILES) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "chat-voice-button";
  button.textContent = quickVoiceText(voice);
  button.title = `发送语音：${quickVoiceText(voice)}`;
  button.addEventListener("click", () => sendDirect({ type: "chat_voice", voice }));
  chatVoiceClips.append(button);
}

for (const emote of ["😂", "👍", "🍀", "🔥", "🎉", "😡", "😴", "🀄"]) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "chat-emote-button";
  button.textContent = emote;
  button.title = emote === "🩴" ? "丢个拖鞋" : `发送 ${emote}`;
  button.addEventListener("click", () => sendDirect({ type: "chat_emote", emote }));
  chatEmotes.append(button);
}
avatarOverlayClose.addEventListener("click", () => avatarOverlay.classList.add("hidden"));
avatarOverlayConfirm.addEventListener("click", applyAvatarSelection);
avatarOverlay.addEventListener("click", (event) => {
  if (event.target === avatarOverlay) avatarOverlay.classList.add("hidden");
});
paymentDetailClose.addEventListener("click", () => paymentDetailOverlay.classList.add("hidden"));
paymentDetailOverlay.addEventListener("click", (event) => {
  if (event.target === paymentDetailOverlay) paymentDetailOverlay.classList.add("hidden");
});
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
    setAudioSettingsVisible(false);
    setChatVisible(false);
    avatarOverlay.classList.add("hidden");
  }
});
window.addEventListener("online", () => {
  if (socket?.readyState !== WebSocket.OPEN) forceReconnect();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && socket?.readyState !== WebSocket.OPEN) forceReconnect();
});
document.addEventListener("pointerdown", () => audioManager.activate(), { once: true });
document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  if (target.closest("button")) audioManager.playEffect("ui");
  if (!target.closest("#audio-settings") && !target.closest("#sound-toggle")) setAudioSettingsVisible(false);
  if (!target.closest("#public-chat") && !target.closest("#chat-toggle")) setChatVisible(false);
});

function setAudioSettingsVisible(visible: boolean): void {
  audioSettings.classList.toggle("hidden", !visible);
  soundToggleButton.classList.toggle("active", visible);
  soundToggleButton.setAttribute("aria-expanded", String(visible));
}

function syncAudioSettingsUI(): void {
  const settings = audioManager.getSettings();
  voiceToggle.checked = settings.voice;
  effectsToggle.checked = settings.effects;
  musicToggle.checked = settings.music;
  const gender = settings.gender;
  genderFemaleButton.classList.toggle("active", gender === "female");
  genderFemaleButton.setAttribute("aria-pressed", String(gender === "female"));
  genderMaleButton.classList.toggle("active", gender === "male");
  genderMaleButton.setAttribute("aria-pressed", String(gender === "male"));
  voiceGenderGameSelect.value = gender;
  const enabled = settings.voice || settings.effects || settings.music;
  soundToggleButton.textContent = enabled ? "声" : "静";
  soundToggleButton.setAttribute("aria-label", enabled ? "声音设置，当前已开启" : "声音设置，当前已静音");
}

const rotateTip = document.querySelector<HTMLElement>(".rotate-tip");
let rotateTipTimer: number | undefined;
function fitTableToViewport(): void {
  if (!tableBoard) return;
  const width = window.visualViewport?.width ?? window.innerWidth;
  const height = window.visualViewport?.height ?? window.innerHeight;
  const scale = Math.max(0.4, Math.min(2, Math.min(width / 720, height / 390)));
  const offsetX = (width - 720 * scale) / 2;
  const offsetY = (height - 390 * scale) / 2;
  tableBoard.style.setProperty("--table-scale", String(scale));
  tableBoard.style.setProperty("--table-offset-x", `${offsetX}px`);
  tableBoard.style.setProperty("--table-offset-y", `${offsetY}px`);
}
function refreshRotateTip(): void {
  window.clearTimeout(rotateTipTimer);
  const portraitNarrow = window.matchMedia("(orientation: portrait) and (max-width: 700px)").matches;
  rotateTip?.classList.toggle("faded", !portraitNarrow);
  if (portraitNarrow) {
    rotateTipTimer = window.setTimeout(() => rotateTip?.classList.add("faded"), 3000);
  }
}
window.addEventListener("resize", refreshRotateTip);
window.addEventListener("orientationchange", refreshRotateTip);
window.addEventListener("resize", fitTableToViewport);
window.addEventListener("orientationchange", fitTableToViewport);
window.visualViewport?.addEventListener("resize", fitTableToViewport);
refreshRotateTip();
fitTableToViewport();

syncAudioSettingsUI();
renderAvatarGrid(avatarGrid, selectedAvatar, pickLobbyAvatar);
const savedNickname = localStorage.getItem("mahjong-nickname");
if (savedNickname) nameInput.value = savedNickname;
const invitedRoom = new URLSearchParams(location.search).get("room");
if (invitedRoom && /^\d{6}$/.test(invitedRoom)) codeInput.value = invitedRoom;

countdownTimer = window.setInterval(updateActionCountdown, 250);
connect();
