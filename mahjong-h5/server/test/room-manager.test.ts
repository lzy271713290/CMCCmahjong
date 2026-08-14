import assert from "node:assert/strict";
import test from "node:test";
import { createFullTileSet } from "../src/game-model.js";
import { RoomError, RoomManager } from "../src/room-manager.js";

test("四名玩家可以加入并同步准备状态", () => {
  const rooms = new RoomManager();
  const host = rooms.createRoom("房主");
  const second = rooms.joinRoom(host.roomCode, "玩家二");
  rooms.joinRoom(host.roomCode, "玩家三");
  rooms.joinRoom(host.roomCode, "玩家四");
  const snapshot = rooms.setReady(host.roomCode, second.playerToken, true);
  assert.equal(snapshot.players.length, 4);
  assert.equal(snapshot.players.find((player) => player.id === second.playerId)?.ready, true);
});

test("第五名玩家会收到房间已满", () => {
  const rooms = new RoomManager();
  const host = rooms.createRoom("一");
  rooms.joinRoom(host.roomCode, "二");
  rooms.joinRoom(host.roomCode, "三");
  rooms.joinRoom(host.roomCode, "四");
  assert.throws(() => rooms.joinRoom(host.roomCode, "五"), (error) => error instanceof RoomError && error.code === "ROOM_FULL");
});

test("掉线后使用令牌恢复原座位", () => {
  const rooms = new RoomManager();
  const host = rooms.createRoom("老张");
  rooms.disconnect(host.roomCode, host.playerToken);
  assert.equal(rooms.snapshot(host.roomCode).players[0]?.connected, false);
  const restored = rooms.reconnect(host.roomCode, host.playerToken);
  assert.equal(restored.playerId, host.playerId);
  assert.equal(restored.snapshot.players[0]?.connected, true);
});

test("房主可以一键补齐三个已准备的测试玩家", () => {
  const rooms = new RoomManager();
  const host = rooms.createRoom("单人测试");
  const snapshot = rooms.fillWithTestPlayers(host.roomCode, host.playerToken);
  assert.equal(snapshot.players.length, 4);
  assert.equal(snapshot.players.filter((player) => player.isTestPlayer).length, 3);
  assert.equal(snapshot.players.filter((player) => player.isTestPlayer).every((player) => player.ready), true);
});

test("四人全部准备后房主可以开始游戏", () => {
  const rooms = new RoomManager();
  const host = rooms.createRoom("房主");
  rooms.fillWithTestPlayers(host.roomCode, host.playerToken);
  rooms.setReady(host.roomCode, host.playerToken, true);
  const snapshot = rooms.startGame(host.roomCode, host.playerToken);
  assert.equal(snapshot.phase, "playing");
  assert.equal(snapshot.game?.wallRemaining, 83);
  assert.equal(snapshot.game?.handTileCounts.reduce((sum, count) => sum + count, 0), 53);
  assert.equal(snapshot.game?.handTileCounts.filter((count) => count === 14).length, 1);
  assert.equal(snapshot.game?.dealerSeat, 0);
});

test("有人未准备时不能开始游戏", () => {
  const rooms = new RoomManager();
  const host = rooms.createRoom("房主");
  rooms.fillWithTestPlayers(host.roomCode, host.playerToken);
  assert.throws(() => rooms.startGame(host.roomCode, host.playerToken), (error) => error instanceof RoomError && error.code === "READY_REQUIRED");
});

test("公共快照不泄露手牌且每名玩家只收到自己的起手牌", () => {
  const rooms = new RoomManager();
  const host = rooms.createRoom("房主");
  const second = rooms.joinRoom(host.roomCode, "玩家二");
  rooms.fillWithTestPlayers(host.roomCode, host.playerToken);
  rooms.setReady(host.roomCode, host.playerToken, true);
  rooms.setReady(host.roomCode, second.playerToken, true);
  const publicSnapshot = rooms.startGame(host.roomCode, host.playerToken);
  const hostSnapshot = rooms.snapshotForPlayer(host.roomCode, host.playerToken);
  const secondSnapshot = rooms.snapshotForPlayer(host.roomCode, second.playerToken);

  assert.equal(publicSnapshot.game?.selfHand, undefined);
  assert.equal(publicSnapshot.game?.viewerSeat, undefined);
  assert.equal(hostSnapshot.game?.viewerSeat, 0);
  assert.equal(hostSnapshot.game?.selfHand?.length, hostSnapshot.game?.handTileCounts[0]);
  assert.equal(secondSnapshot.game?.viewerSeat, 1);
  assert.equal(secondSnapshot.game?.selfHand?.length, secondSnapshot.game?.handTileCounts[1]);
});

test("对局中断线重连恢复同一副个人手牌", () => {
  const rooms = new RoomManager();
  const host = rooms.createRoom("房主");
  rooms.fillWithTestPlayers(host.roomCode, host.playerToken);
  rooms.setReady(host.roomCode, host.playerToken, true);
  rooms.startGame(host.roomCode, host.playerToken);
  const originalHand = rooms.snapshotForPlayer(host.roomCode, host.playerToken).game?.selfHand;

  rooms.disconnect(host.roomCode, host.playerToken);
  const restored = rooms.reconnect(host.roomCode, host.playerToken);
  assert.deepEqual(restored.snapshot.game?.selfHand, originalHand);
});

test("只有庄家可以从自己的手牌中执行首次出牌", () => {
  const rooms = new RoomManager();
  const sessions = [rooms.createRoom("一")];
  sessions.push(rooms.joinRoom(sessions[0]!.roomCode, "二"));
  sessions.push(rooms.joinRoom(sessions[0]!.roomCode, "三"));
  sessions.push(rooms.joinRoom(sessions[0]!.roomCode, "四"));
  for (const session of sessions) rooms.setReady(session.roomCode, session.playerToken, true);
  const started = rooms.startGame(sessions[0]!.roomCode, sessions[0]!.playerToken);
  const dealerSeat = started.game!.dealerSeat;
  const dealer = sessions.find((session) => session.snapshot.players.find((player) => player.id === session.playerId)?.seat === dealerSeat)!;
  const other = sessions.find((session) => session.playerId !== dealer.playerId)!;
  const dealerView = rooms.snapshotForPlayer(dealer.roomCode, dealer.playerToken);
  const tile = dealerView.game!.selfHand![0]!;
  const missingTile = createFullTileSet().map((candidate) => candidate.code).find((candidate) => !dealerView.game!.selfHand!.includes(candidate))!;

  assert.throws(
    () => rooms.discardTile(other.roomCode, other.playerToken, tile),
    (error) => error instanceof RoomError && error.code === "TURN_REQUIRED",
  );
  assert.throws(
    () => rooms.discardTile(dealer.roomCode, dealer.playerToken, missingTile),
    (error) => error instanceof RoomError && error.code === "TILE_NOT_IN_HAND",
  );
  const discarded = rooms.discardTile(dealer.roomCode, dealer.playerToken, tile);
  assert.equal(discarded.game?.stage, "awaiting_reactions");
  assert.deepEqual(discarded.game?.latestDiscard, { seat: dealerSeat, tile });
  assert.equal(discarded.game?.handTileCounts[dealerSeat], 13);
  assert.equal(discarded.game?.selfHand, undefined);
  assert.throws(
    () => rooms.discardTile(dealer.roomCode, dealer.playerToken, tile),
    (error) => error instanceof RoomError && error.code === "REACTIONS_PENDING",
  );
});
