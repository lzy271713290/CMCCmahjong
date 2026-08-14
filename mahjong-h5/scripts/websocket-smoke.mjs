import WebSocket from "ws";

const serverUrl = process.argv[2] ?? "ws://127.0.0.1:3000/ws";

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
first.send(JSON.stringify({ type: "create_room", name: "甲" }));
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

const gameStartedWaits = connections.map((connection) => next(connection.socket, "snapshot", (message) => message.snapshot.phase === "playing"));
first.send(JSON.stringify({ type: "start_game" }));
const gameStartedMessages = await Promise.all(gameStartedWaits);
const gameStarted = gameStartedMessages[0];
const dealerSeat = gameStarted.snapshot.game?.dealerSeat;
const dealerIndex = connections.findIndex((connection) => gameStarted.snapshot.players.find((player) => player.id === connection.session.playerId)?.seat === dealerSeat);
const dealerTile = gameStartedMessages[dealerIndex]?.snapshot.game?.selfHand?.[0];
const discardWaits = connections.map((connection) => next(connection.socket, "snapshot", (message) => message.snapshot.game?.stage === "awaiting_reactions"));
connections[dealerIndex]?.socket.send(JSON.stringify({ type: "discard_tile", tile: dealerTile }));
const discardedMessages = await Promise.all(discardWaits);
const dealerAfterDiscard = discardedMessages[dealerIndex];
const originalPlayingHand = discardedMessages[1].snapshot.game?.selfHand;

const playingOfflineWait = next(first, "snapshot", (message) => message.snapshot.players.find((player) => player.id === joined.playerId)?.connected === false);
restoredSocket.close();
await playingOfflineWait;

const playingRestoredSocket = await open();
const playingRestoredWait = next(playingRestoredSocket, "session");
playingRestoredSocket.send(JSON.stringify({ type: "reconnect", roomCode: created.roomCode, playerToken: joined.playerToken }));
const playingRestored = await playingRestoredWait;

const result = {
  serverUrl,
  roomCodeLength: created.roomCode.length,
  playerCount: twoPlayers.snapshot.players.length,
  fourPlayerCount: gameStarted.snapshot.players.length,
  disconnectObserved: offline.snapshot.players.find((player) => player.id === joined.playerId)?.connected === false,
  originalSeatRestored: restored.playerId === joined.playerId,
  gamePhase: gameStarted.snapshot.phase,
  wallRemaining: gameStarted.snapshot.game?.wallRemaining,
  handTileCounts: gameStarted.snapshot.game?.handTileCounts,
  hostPrivateHandCount: gameStarted.snapshot.game?.selfHand?.length,
  secondPrivateHandCount: gameStartedMessages[1].snapshot.game?.selfHand?.length,
  discardStage: dealerAfterDiscard.snapshot.game?.stage,
  discardedTile: dealerAfterDiscard.snapshot.game?.latestDiscard?.tile,
  dealerHandAfterDiscard: dealerAfterDiscard.snapshot.game?.selfHand?.length,
  playingHandRestored: JSON.stringify(playingRestored.snapshot.game?.selfHand) === JSON.stringify(originalPlayingHand),
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
  result.wallRemaining !== 83 ||
  result.handTileCounts?.reduce((sum, count) => sum + count, 0) !== 53 ||
  ![13, 14].includes(result.hostPrivateHandCount) ||
  ![13, 14].includes(result.secondPrivateHandCount) ||
  result.discardStage !== "awaiting_reactions" ||
  result.discardedTile !== dealerTile ||
  result.dealerHandAfterDiscard !== 13 ||
  !result.playingHandRestored
) {
  process.exitCode = 1;
}
