import WebSocket from "ws";
import { findDiscardReactionOptions } from "../dist/server/src/game-model.js";

const serverUrl = process.argv[2] ?? "ws://127.0.0.1:3000/ws";
const expectedVersion = process.argv[3] ?? "replay-viewer-v12";
const httpBaseUrl = serverUrl.replace(/^ws/, "http").replace(/\/ws$/, "");

function open() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(serverUrl);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function next(socket, type, predicate = () => true) {
  return new Promise((resolve) => {
    const receive = (data) => {
      const message = JSON.parse(data.toString());
      if (message.type !== type || !predicate(message)) return;
      socket.off("message", receive);
      resolve(message);
    };
    socket.on("message", receive);
  });
}

const first = await open();
const createdWait = next(first, "session");
first.send(JSON.stringify({ type: "create_room", name: "甲", totalRounds: 16 }));
const created = await createdWait;

const second = await open();
const twoPlayersWait = next(first, "snapshot");
const joinedWait = next(second, "session");
second.send(JSON.stringify({ type: "join_room", roomCode: created.roomCode, name: "乙" }));
const joined = await joinedWait;
const twoPlayers = await twoPlayersWait;

const offlineWait = next(first, "snapshot", (message) => message.snapshot.players.find((player) => player.id === joined.playerId)?.connected === false);
second.close();
const offline = await offlineWait;

const restoredSocket = await open();
const restoredWait = next(restoredSocket, "session");
restoredSocket.send(JSON.stringify({ type: "reconnect", roomCode: created.roomCode, playerToken: joined.playerToken }));
const restored = await restoredWait;

const thirdSocket = await open();
const threePlayersWait = next(first, "snapshot", (message) => message.snapshot.players.length === 3);
const thirdJoinedWait = next(thirdSocket, "session");
thirdSocket.send(JSON.stringify({ type: "join_room", roomCode: created.roomCode, name: "丙" }));
const thirdJoined = await thirdJoinedWait;
await threePlayersWait;

const fourthSocket = await open();
const fourPlayersWait = next(first, "snapshot", (message) => message.snapshot.players.length === 4);
const fourthJoinedWait = next(fourthSocket, "session");
fourthSocket.send(JSON.stringify({ type: "join_room", roomCode: created.roomCode, name: "丁" }));
const fourthJoined = await fourthJoinedWait;
await fourPlayersWait;

const connections = [
  { socket: first, session: created },
  { socket: restoredSocket, session: restored },
  { socket: thirdSocket, session: thirdJoined },
  { socket: fourthSocket, session: fourthJoined },
];
for (const connection of connections) {
  const readyWait = next(first, "snapshot", (message) => message.snapshot.players.find((player) => player.id === connection.session.playerId)?.ready === true);
  connection.socket.send(JSON.stringify({ type: "set_ready", ready: true }));
  await readyWait;
}

function toTiles(codes) {
  const copies = new Map();
  return codes.map((code) => {
    const copy = copies.get(code) ?? 0;
    copies.set(code, copy + 1);
    return { code, copy };
  });
}

function chooseSafeDiscard(messages, discarderIndex) {
  const discarder = messages[discarderIndex].snapshot.game;
  for (const tile of [...new Set(discarder.selfHand ?? [])]) {
    const discard = { seat: discarder.viewerSeat, tile };
    const createsReaction = messages.some((message, index) => {
      if (index === discarderIndex) return false;
      const game = message.snapshot.game;
      return (
        findDiscardReactionOptions(
          toTiles(game.selfHand ?? []),
          game.viewerSeat,
          discard,
          (game.melds ?? []).filter((meld) => meld.seat === game.viewerSeat),
          game.wallRemaining,
        ).length > 0
      );
    });
    if (!createsReaction) return tile;
  }
  throw new Error("冒烟测试没有找到不会触发响应的安全弃牌");
}

const gameStartedWaits = connections.map((connection) => next(connection.socket, "snapshot", (message) => message.snapshot.phase === "playing"));
first.send(JSON.stringify({ type: "start_game" }));
const gameStartedMessages = await Promise.all(gameStartedWaits);
const gameStarted = gameStartedMessages[0];
const earlyNextRoundWait = next(first, "error", (message) => message.code === "ROUND_ACTIVE");
first.send(JSON.stringify({ type: "start_next_round" }));
const earlyNextRoundError = await earlyNextRoundWait;
const earlySettlementWait = next(first, "error", (message) => message.code === "ROUND_ACTIVE");
first.send(JSON.stringify({ type: "request_early_settlement" }));
const earlySettlementError = await earlySettlementWait;
const dealerSeat = gameStarted.snapshot.game?.dealerSeat;
const dealerIndex = connections.findIndex((connection) => gameStarted.snapshot.players.find((player) => player.id === connection.session.playerId)?.seat === dealerSeat);
const dealerTile = chooseSafeDiscard(gameStartedMessages, dealerIndex);
const discardWaits = connections.map((connection) =>
  next(
    connection.socket,
    "snapshot",
    (message) => message.snapshot.game?.discards.length === 1 && message.snapshot.game?.stage === "awaiting_discard",
  ),
);
connections[dealerIndex]?.socket.send(JSON.stringify({ type: "discard_tile", tile: dealerTile }));
const discardedMessages = await Promise.all(discardWaits);
const dealerAfterDiscard = discardedMessages[dealerIndex];
const nextSeat = (dealerSeat + 1) % 4;
const nextPlayerIndex = connections.findIndex(
  (connection) => gameStarted.snapshot.players.find((player) => player.id === connection.session.playerId)?.seat === nextSeat,
);
const nextPlayerAfterDraw = discardedMessages[nextPlayerIndex];
const nextTile = chooseSafeDiscard(discardedMessages, nextPlayerIndex);
const secondDiscardWaits = connections.map((connection) =>
  next(
    connection.socket,
    "snapshot",
    (message) => message.snapshot.game?.discards.length === 2 && message.snapshot.game?.stage === "awaiting_discard",
  ),
);
connections[nextPlayerIndex]?.socket.send(JSON.stringify({ type: "discard_tile", tile: nextTile }));
const secondDiscardMessages = await Promise.all(secondDiscardWaits);
const originalPlayingHand = secondDiscardMessages[1].snapshot.game?.selfHand;

const playingOfflineWait = next(first, "snapshot", (message) => message.snapshot.players.find((player) => player.id === joined.playerId)?.connected === false);
restoredSocket.close();
await playingOfflineWait;

const playingRestoredSocket = await open();
const playingRestoredWait = next(playingRestoredSocket, "session");
playingRestoredSocket.send(JSON.stringify({ type: "reconnect", roomCode: created.roomCode, playerToken: joined.playerToken }));
const playingRestored = await playingRestoredWait;
const [tileAssetResponse, tableAssetResponse, replayModuleResponse] = await Promise.all([
  fetch(`${httpBaseUrl}/assets/babykylin/MJ/bottom/Z_bottom.png`),
  fetch(`${httpBaseUrl}/assets/babykylin/table/mahjong_table.jpg`),
  fetch(`${httpBaseUrl}/public-replay.js`),
]);
const [tileAsset, tableAsset] = await Promise.all([tileAssetResponse.arrayBuffer(), tableAssetResponse.arrayBuffer()]);
const replayModule = await replayModuleResponse.text();
const healthResponse = await fetch(`${httpBaseUrl}/healthz`);
const health = await healthResponse.json();

const result = {
  serverUrl,
  roomCodeLength: created.roomCode.length,
  playerCount: twoPlayers.snapshot.players.length,
  fourPlayerCount: gameStarted.snapshot.players.length,
  disconnectObserved: offline.snapshot.players.find((player) => player.id === joined.playerId)?.connected === false,
  originalSeatRestored: restored.playerId === joined.playerId,
  gamePhase: gameStarted.snapshot.phase,
  modelVersion: gameStarted.snapshot.game?.modelVersion,
  matchRounds: gameStarted.snapshot.match?.totalRounds,
  earlyNextRoundRejected: earlyNextRoundError.code === "ROUND_ACTIVE",
  earlySettlementDuringRoundRejected: earlySettlementError.code === "ROUND_ACTIVE",
  wallRemaining: gameStarted.snapshot.game?.wallRemaining,
  handTileCounts: gameStarted.snapshot.game?.handTileCounts,
  hostPrivateHandCount: gameStarted.snapshot.game?.selfHand?.length,
  secondPrivateHandCount: gameStartedMessages[1].snapshot.game?.selfHand?.length,
  discardStage: dealerAfterDiscard.snapshot.game?.stage,
  discardedTile: dealerAfterDiscard.snapshot.game?.latestDiscard?.tile,
  dealerHandAfterDiscard: dealerAfterDiscard.snapshot.game?.selfHand?.length,
  nextTurnSeat: dealerAfterDiscard.snapshot.game?.turnSeat,
  nextPlayerHandAfterDraw: nextPlayerAfterDraw.snapshot.game?.selfHand?.length,
  wallAfterFirstDiscard: dealerAfterDiscard.snapshot.game?.wallRemaining,
  discardCountAfterSecondTurn: secondDiscardMessages[0].snapshot.game?.discards.length,
  wallAfterSecondDiscard: secondDiscardMessages[0].snapshot.game?.wallRemaining,
  publicActionCount: secondDiscardMessages[0].snapshot.publicActions?.length,
  publicActionsPrivateDataFree: !/playerToken|selfHand/.test(JSON.stringify(secondDiscardMessages[0].snapshot.publicActions)),
  playingHandRestored: JSON.stringify(playingRestored.snapshot.game?.selfHand) === JSON.stringify(originalPlayingHand),
  tileAsset: { contentType: tileAssetResponse.headers.get("content-type"), bytes: tileAsset.byteLength },
  tableAsset: { contentType: tableAssetResponse.headers.get("content-type"), bytes: tableAsset.byteLength },
  replayModule: { status: replayModuleResponse.status, contentType: replayModuleResponse.headers.get("content-type"), parserExported: replayModule.includes("export function parsePublicReplay") },
  health: { status: healthResponse.status, ok: health.ok, modelVersion: health.modelVersion, instanceIdLength: health.instanceId?.length },
};
console.log(JSON.stringify(result));
first.close();
playingRestoredSocket.close();
thirdSocket.close();
fourthSocket.close();

if (
  result.roomCodeLength !== 6 ||
  result.playerCount !== 2 ||
  result.fourPlayerCount !== 4 ||
  !result.disconnectObserved ||
  !result.originalSeatRestored ||
  result.gamePhase !== "playing" ||
  result.modelVersion !== expectedVersion ||
  result.matchRounds !== 16 ||
  !result.earlyNextRoundRejected ||
  !result.earlySettlementDuringRoundRejected ||
  result.wallRemaining !== 83 ||
  result.handTileCounts?.reduce((sum, count) => sum + count, 0) !== 53 ||
  ![13, 14].includes(result.hostPrivateHandCount) ||
  ![13, 14].includes(result.secondPrivateHandCount) ||
  result.discardStage !== "awaiting_discard" ||
  result.discardedTile !== dealerTile ||
  result.dealerHandAfterDiscard !== 13 ||
  result.nextTurnSeat !== nextSeat ||
  result.nextPlayerHandAfterDraw !== 14 ||
  result.wallAfterFirstDiscard !== 82 ||
  result.discardCountAfterSecondTurn !== 2 ||
  result.wallAfterSecondDiscard !== 81 ||
  result.publicActionCount < 3 ||
  !result.publicActionsPrivateDataFree ||
  !result.playingHandRestored ||
  result.tileAsset.contentType !== "image/png" ||
  result.tileAsset.bytes < 100_000 ||
  result.tableAsset.contentType !== "image/jpeg" ||
  result.tableAsset.bytes < 100_000 ||
  result.replayModule.status !== 200 ||
  !result.replayModule.contentType?.includes("javascript") ||
  !result.replayModule.parserExported ||
  result.health.status !== 200 ||
  !result.health.ok ||
  result.health.modelVersion !== expectedVersion ||
  result.health.instanceIdLength !== 8
) {
  process.exitCode = 1;
}
