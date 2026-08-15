import WebSocket from "ws";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const serverUrl = args[0] ?? "ws://127.0.0.1:3000/ws";
const expectedVersion = args[1] ?? "ui-voice-v18";
const timeoutMs = 12_000;

function openSocket() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(serverUrl);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function createPeer(socket) {
  const peer = { socket, session: undefined, latest: undefined, waiters: new Set() };
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === "session") {
      peer.session = message;
      peer.latest = message.snapshot;
    } else if (message.type === "snapshot") {
      peer.latest = message.snapshot;
    }
    for (const waiter of [...peer.waiters]) {
      try {
        if (!waiter.predicate(message, peer)) continue;
        clearTimeout(waiter.timer);
        peer.waiters.delete(waiter);
        waiter.resolve(message);
      } catch (error) {
        clearTimeout(waiter.timer);
        peer.waiters.delete(waiter);
        waiter.reject(error);
      }
    }
  });
  return peer;
}

function waitForMessage(peer, predicate, label) {
  return new Promise((resolve, reject) => {
    const waiter = {
      predicate,
      resolve,
      reject,
      timer: setTimeout(() => {
        peer.waiters.delete(waiter);
        reject(new Error(`等待超时：${label}`));
      }, timeoutMs),
    };
    peer.waiters.add(waiter);
  });
}

function waitForState(peer, predicate, label) {
  if (peer.latest && predicate(peer.latest)) return Promise.resolve(peer.latest);
  return waitForMessage(
    peer,
    (message) => message.type !== "error" && peer.latest && predicate(peer.latest),
    label,
  ).then(() => peer.latest);
}

async function sendAndWait(actor, observer, payload, predicate, label) {
  const previousRevision = observer.latest?.revision ?? -1;
  const waiting = waitForMessage(
    observer,
    (message) => {
      if (message.type === "error") throw new Error(`${message.code}: ${message.message}`);
      return observer.latest?.revision > previousRevision && predicate(observer.latest);
    },
    label,
  );
  actor.socket.send(JSON.stringify(payload));
  await waiting;
  return observer.latest;
}

async function createOrJoin(name, roomCode) {
  const peer = createPeer(await openSocket());
  const waiting = waitForMessage(peer, (message) => message.type === "session" || message.type === "error", `${name}进入房间`);
  peer.socket.send(JSON.stringify(roomCode ? { type: "join_room", roomCode, name } : { type: "create_room", name, totalRounds: 8 }));
  const message = await waiting;
  if (message.type === "error") throw new Error(`${message.code}: ${message.message}`);
  return peer;
}

function seatOf(peer, snapshot) {
  return snapshot.players.find((player) => player.id === peer.session.playerId)?.seat;
}

async function syncPeers(peers, revision) {
  await Promise.all(peers.map((peer) => waitForState(peer, (state) => state.revision >= revision, `同步版本 ${revision}`)));
}

const peers = [];
let reconnectVoteRestored = false;
let discardCount = 0;
let passCount = 0;

try {
  peers.push(await createOrJoin("整局甲"));
  const roomCode = peers[0].session.roomCode;
  peers.push(await createOrJoin("整局乙", roomCode));
  peers.push(await createOrJoin("整局丙", roomCode));
  peers.push(await createOrJoin("整局丁", roomCode));
  const leader = peers[0];
  await waitForState(leader, (state) => state.players.length === 4, "四人到齐");

  for (const peer of peers) {
    await sendAndWait(
      peer,
      leader,
      { type: "set_ready", ready: true },
      (state) => state.players.find((player) => player.id === peer.session.playerId)?.ready === true,
      `${peer.session.playerId}准备`,
    );
  }

  await sendAndWait(leader, leader, { type: "start_game" }, (state) => state.phase === "playing", "开始游戏");

  for (let step = 0; step < 500 && leader.latest.game?.stage !== "round_ended"; step += 1) {
    await syncPeers(peers, leader.latest.revision);
    const game = leader.latest.game;
    if (game.stage === "awaiting_reactions") {
      const responder = peers.find((peer) => (peer.latest.game?.availableOperations?.length ?? 0) > 0);
      if (!responder) throw new Error("响应阶段没有找到可操作玩家");
      await sendAndWait(responder, leader, { type: "react_to_discard", operationId: "pass" }, () => true, "响应过牌");
      passCount += 1;
      continue;
    }
    if (game.stage !== "awaiting_discard") throw new Error(`无法处理的阶段：${game.stage}`);
    const actor = peers.find((peer) => seatOf(peer, leader.latest) === game.turnSeat);
    if (!actor) throw new Error(`找不到座位 ${game.turnSeat} 的玩家`);
    await waitForState(actor, (state) => state.revision >= leader.latest.revision, "同步出牌者手牌");
    const tile = actor.latest.game?.selfHand?.[0];
    if (!tile) throw new Error(`座位 ${game.turnSeat} 没有可出的手牌`);
    await sendAndWait(actor, leader, { type: "discard_tile", tile }, () => true, `座位 ${game.turnSeat} 出牌`);
    discardCount += 1;
  }

  if (leader.latest.game?.stage !== "round_ended") throw new Error("500 步内未完成整局");
  if (leader.latest.game.roundResult?.reason !== "wall_exhausted") throw new Error(`整局结束原因异常：${leader.latest.game.roundResult?.reason}`);
  if (leader.latest.match.completedRounds !== 1 || leader.latest.match.roundHistory.length !== 1) throw new Error("整局历史未正确记录");

  await sendAndWait(
    leader,
    leader,
    { type: "request_early_settlement" },
    (state) => state.match.earlySettlement?.status === "voting",
    "发起提前结算",
  );

  const disconnected = peers[2];
  const disconnectedId = disconnected.session.playerId;
  const disconnectedToken = disconnected.session.playerToken;
  const offlineWait = waitForState(
    leader,
    (state) => state.players.find((player) => player.id === disconnectedId)?.connected === false,
    "投票中掉线",
  );
  disconnected.socket.close();
  await offlineWait;

  const restored = createPeer(await openSocket());
  const reconnectWait = waitForMessage(restored, (message) => message.type === "session" || message.type === "error", "投票中重连");
  restored.socket.send(JSON.stringify({ type: "reconnect", roomCode, playerToken: disconnectedToken }));
  const reconnectMessage = await reconnectWait;
  if (reconnectMessage.type === "error") throw new Error(`${reconnectMessage.code}: ${reconnectMessage.message}`);
  reconnectVoteRestored = reconnectMessage.snapshot.match.earlySettlement?.status === "voting";
  peers[2] = restored;

  while (leader.latest.match.status !== "completed") {
    await syncPeers(peers, leader.latest.revision);
    const waitingSeat = leader.latest.match.earlySettlement?.waitingSeats?.[0];
    if (waitingSeat === undefined) throw new Error("提前结算仍未完成但没有待投票座位");
    const voter = peers.find((peer) => seatOf(peer, leader.latest) === waitingSeat);
    if (!voter) throw new Error(`找不到投票座位 ${waitingSeat}`);
    await sendAndWait(
      voter,
      leader,
      { type: "respond_early_settlement", agree: true },
      (state) => state.match.status === "completed" || !state.match.earlySettlement?.waitingSeats.includes(waitingSeat),
      `座位 ${waitingSeat} 同意提前结算`,
    );
  }

  const result = {
    serverUrl,
    modelVersion: leader.latest.game?.modelVersion,
    roomCodeLength: roomCode.length,
    realPlayers: leader.latest.players.length,
    discardCount,
    passCount,
    roundReason: leader.latest.game?.roundResult?.reason,
    wallRemaining: leader.latest.game?.wallRemaining,
    completedRounds: leader.latest.match.completedRounds,
    roundHistory: leader.latest.match.roundHistory.length,
    reconnectVoteRestored,
    matchStatus: leader.latest.match.status,
    matchEndReason: leader.latest.match.endReason,
    rankingCount: leader.latest.match.rankings?.length,
    publicActionCount: leader.latest.publicActions.length,
    firstPublicAction: leader.latest.publicActions[0]?.kind,
    lastPublicAction: leader.latest.publicActions.at(-1)?.kind,
    publicActionsPrivateDataFree: !/playerToken|selfHand/.test(JSON.stringify(leader.latest.publicActions)),
  };
  console.log(JSON.stringify(result));

  if (
    result.roomCodeLength !== 6 ||
    result.realPlayers !== 4 ||
    result.discardCount < 70 ||
    result.roundReason !== "wall_exhausted" ||
    result.wallRemaining !== 0 ||
    result.completedRounds !== 1 ||
    result.roundHistory !== 1 ||
    !result.reconnectVoteRestored ||
    result.matchStatus !== "completed" ||
    result.matchEndReason !== "early_agreement" ||
    result.rankingCount !== 4 ||
    result.publicActionCount < 90 ||
    result.firstPublicAction !== "round_started" ||
    result.lastPublicAction !== "settlement_agreed" ||
    !result.publicActionsPrivateDataFree ||
    (expectedVersion && result.modelVersion !== expectedVersion)
  ) {
    process.exitCode = 1;
  }
} finally {
  for (const peer of peers) peer.socket.close();
}
