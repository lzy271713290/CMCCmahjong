import WebSocket from "ws";

function open() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket("ws://127.0.0.1:3000/ws");
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

const offlineWait = next(first, "snapshot");
second.close();
const offline = await offlineWait;

const restoredSocket = await open();
const restoredWait = next(restoredSocket, "session");
restoredSocket.send(JSON.stringify({ type: "reconnect", roomCode: created.roomCode, playerToken: joined.playerToken }));
const restored = await restoredWait;

const secondReadyWait = next(first, "snapshot", (message) => message.snapshot.players.find((player) => player.id === joined.playerId)?.ready === true);
restoredSocket.send(JSON.stringify({ type: "set_ready", ready: true }));
await secondReadyWait;

const filledWait = next(first, "snapshot", (message) => message.snapshot.players.length === 4);
first.send(JSON.stringify({ type: "fill_test_players" }));
await filledWait;

const hostReadyWait = next(first, "snapshot", (message) => message.snapshot.players.find((player) => player.id === created.playerId)?.ready === true);
first.send(JSON.stringify({ type: "set_ready", ready: true }));
await hostReadyWait;

const gameStartedWait = next(first, "snapshot", (message) => message.snapshot.phase === "playing");
first.send(JSON.stringify({ type: "start_game" }));
const gameStarted = await gameStartedWait;

const result = {
  roomCodeLength: created.roomCode.length,
  playerCount: twoPlayers.snapshot.players.length,
  disconnectObserved: offline.snapshot.players.find((player) => player.id === joined.playerId)?.connected === false,
  originalSeatRestored: restored.playerId === joined.playerId,
  gamePhase: gameStarted.snapshot.phase,
  wallRemaining: gameStarted.snapshot.game?.wallRemaining,
  handTileCounts: gameStarted.snapshot.game?.handTileCounts,
};
console.log(JSON.stringify(result));
first.close();
restoredSocket.close();

if (
  result.roomCodeLength !== 6 ||
  result.playerCount !== 2 ||
  !result.disconnectObserved ||
  !result.originalSeatRestored ||
  result.gamePhase !== "playing" ||
  result.wallRemaining !== 83 ||
  result.handTileCounts?.reduce((sum, count) => sum + count, 0) !== 53
) {
  process.exitCode = 1;
}
