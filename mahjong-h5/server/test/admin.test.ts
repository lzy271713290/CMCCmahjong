import assert from "node:assert/strict";
import test from "node:test";
import { RoomError, RoomManager } from "../src/room-manager.js";

test("后台概览统计房间、真人、测试玩家与等待/进行中数量", () => {
  const rooms = new RoomManager();
  const host = rooms.createRoom("房主");
  const second = rooms.joinRoom(host.roomCode, "玩家二");
  rooms.fillWithTestPlayers(host.roomCode, host.playerToken);
  rooms.setReady(host.roomCode, host.playerToken, true);
  rooms.setReady(host.roomCode, second.playerToken, true);
  rooms.startGame(host.roomCode, host.playerToken);
  assert.deepEqual(rooms.adminStats(), {
    roomCount: 1,
    waitingRoomCount: 0,
    playingRoomCount: 1,
    connectedPlayerCount: 2,
    realPlayerCount: 2,
    testPlayerCount: 2,
  });
});

test("后台房间摘要只暴露公开状态", () => {
  const rooms = new RoomManager();
  const host = rooms.createRoom("房主");
  rooms.fillWithTestPlayers(host.roomCode, host.playerToken);
  rooms.setReady(host.roomCode, host.playerToken, true);
  rooms.startGame(host.roomCode, host.playerToken);
  const [summary] = rooms.listAdminRooms();
  assert.ok(summary);
  assert.equal(summary.code, host.roomCode);
  assert.equal(summary.phase, "playing");
  assert.equal(summary.playerCount, 4);
  assert.equal(summary.testPlayerCount, 3);
  assert.equal(summary.completedRounds, 0);
  assert.equal(summary.wallRemaining, 83);
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes("playerToken"), false);
  assert.equal(serialized.includes("selfHand"), false);
  assert.equal(serialized.includes("selfDrawnTile"), false);
});

test("后台房间详情可查看公开牌桌且不泄露私有字段", () => {
  const rooms = new RoomManager();
  const host = rooms.createRoom("房主");
  const second = rooms.joinRoom(host.roomCode, "玩家二");
  const third = rooms.joinRoom(host.roomCode, "玩家三");
  const fourth = rooms.joinRoom(host.roomCode, "玩家四");
  for (const session of [host, second, third, fourth]) {
    rooms.setReady(host.roomCode, session.playerToken, true);
  }
  rooms.startGame(host.roomCode, host.playerToken);
  rooms.disconnect(host.roomCode, second.playerToken);
  const detail = rooms.getAdminRoom(host.roomCode);
  assert.equal(detail.players.length, 4);
  assert.equal(detail.players.find((player) => player.seat === 1)?.connected, false);
  assert.equal(detail.game?.roundNumber, 1);
  assert.equal(detail.game?.wallRemaining, 83);
  assert.equal(detail.game?.handTileCounts.reduce((sum, count) => sum + count, 0), 53);
  assert.equal(detail.match.status, "active");
  const serialized = JSON.stringify(detail);
  assert.equal(serialized.includes("playerToken"), false);
  assert.equal(serialized.includes("selfHand"), false);
  assert.equal(serialized.includes("selfDrawnTile"), false);
});

test("后台查询不存在的房间返回房间不存在错误", () => {
  const rooms = new RoomManager();
  assert.throws(
    () => rooms.getAdminRoom("123456"),
    (error) => error instanceof RoomError && error.code === "ROOM_NOT_FOUND",
  );
});
