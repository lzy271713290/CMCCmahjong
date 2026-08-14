import assert from "node:assert/strict";
import test from "node:test";
import type { RoomSnapshot } from "../../shared/protocol.js";
import { GAME_MODEL_VERSION, createFullTileSet, validateInitialGame, type InitialGameState, type Tile } from "../src/game-model.js";
import { RoomError, RoomManager, type Session } from "../src/room-manager.js";

function passAllReactions(rooms: RoomManager, sessions: Session[], initial: RoomSnapshot): RoomSnapshot {
  let snapshot = initial;
  while (snapshot.game?.stage === "awaiting_reactions") {
    let responded = false;
    for (const session of sessions) {
      const view = rooms.snapshotForPlayer(session.roomCode, session.playerToken);
      if (!view.game?.availableOperations?.length) continue;
      snapshot = rooms.reactToDiscard(session.roomCode, session.playerToken, "pass").snapshot;
      responded = true;
      if (snapshot.game?.stage !== "awaiting_reactions") break;
    }
    if (!responded) throw new Error("响应阶段没有可操作的真人玩家");
  }
  return snapshot;
}

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
  const afterPasses = passAllReactions(rooms, sessions, discarded.snapshot);
  const nextSeat = (dealerSeat + 1) % 4;
  assert.equal(afterPasses.game?.stage, "awaiting_discard");
  assert.deepEqual(afterPasses.game?.latestDiscard, { seat: dealerSeat, tile });
  assert.equal(afterPasses.game?.handTileCounts[dealerSeat], 13);
  assert.equal(afterPasses.game?.handTileCounts[nextSeat], 14);
  assert.equal(afterPasses.game?.wallRemaining, 82);
  assert.equal(afterPasses.game?.selfHand, undefined);
  assert.throws(
    () => rooms.discardTile(dealer.roomCode, dealer.playerToken, tile),
    (error) => error instanceof RoomError && error.code === "TURN_REQUIRED",
  );

  const nextPlayer = sessions.find(
    (session) => session.snapshot.players.find((player) => player.id === session.playerId)?.seat === nextSeat,
  )!;
  const nextView = rooms.snapshotForPlayer(nextPlayer.roomCode, nextPlayer.playerToken);
  const nextTile = nextView.game!.selfHand![0]!;
  const secondDiscard = rooms.discardTile(nextPlayer.roomCode, nextPlayer.playerToken, nextTile);
  const afterSecondPasses = passAllReactions(rooms, sessions, secondDiscard.snapshot);
  assert.equal(afterSecondPasses.game?.discards.length, 2);
  assert.equal(afterSecondPasses.game?.turnSeat, (nextSeat + 1) % 4);
  assert.equal(afterSecondPasses.game?.wallRemaining, 81);
});

test("单人联调时测试玩家自动完成回合并把出牌权还给真人", () => {
  const rooms = new RoomManager();
  const host = rooms.createRoom("单人联调");
  rooms.fillWithTestPlayers(host.roomCode, host.playerToken);
  rooms.setReady(host.roomCode, host.playerToken, true);
  rooms.startGame(host.roomCode, host.playerToken);
  const hostView = rooms.snapshotForPlayer(host.roomCode, host.playerToken);
  const tile = hostView.game!.selfHand![0]!;

  const progressed = rooms.discardTile(host.roomCode, host.playerToken, tile);
  let finalSnapshot = progressed.snapshot;
  const automaticDiscards = [...progressed.diagnostics.autoDiscards];
  while (finalSnapshot.game?.stage === "awaiting_reactions") {
    const hostReaction = rooms.snapshotForPlayer(host.roomCode, host.playerToken).game?.availableOperations;
    assert.ok(hostReaction?.length);
    const passed = rooms.reactToDiscard(host.roomCode, host.playerToken, "pass");
    automaticDiscards.push(...passed.diagnostics.autoDiscards);
    finalSnapshot = passed.snapshot;
  }

  assert.equal(automaticDiscards.length, 3);
  assert.equal(progressed.diagnostics.initialDiscard.handTileCount, 13);
  assert.deepEqual(
    automaticDiscards.map((discard) => discard.wallRemaining),
    [82, 81, 80],
  );
  assert.equal(finalSnapshot.game?.stage, "awaiting_discard");
  assert.equal(finalSnapshot.game?.turnSeat, 0);
  assert.equal(finalSnapshot.game?.wallRemaining, 79);
  assert.deepEqual(finalSnapshot.game?.handTileCounts, [14, 13, 13, 13]);
  assert.equal(finalSnapshot.game?.discards.length, 4);
  assert.equal(rooms.snapshotForPlayer(host.roomCode, host.playerToken).game?.selfHand?.length, 14);
});

function createDeterministicFourPlayerGame(): { rooms: RoomManager; sessions: Session[]; started: RoomSnapshot } {
  const rooms = new RoomManager(() => 0);
  const sessions = [rooms.createRoom("东")];
  sessions.push(rooms.joinRoom(sessions[0]!.roomCode, "南"));
  sessions.push(rooms.joinRoom(sessions[0]!.roomCode, "西"));
  sessions.push(rooms.joinRoom(sessions[0]!.roomCode, "北"));
  for (const session of sessions) rooms.setReady(session.roomCode, session.playerToken, true);
  const started = rooms.startGame(sessions[0]!.roomCode, sessions[0]!.playerToken);
  return { rooms, sessions, started };
}

test("弃牌响应候选只下发给有资格的玩家且过牌后下家正常摸牌", () => {
  const { rooms, sessions, started } = createDeterministicFourPlayerGame();
  assert.equal(started.game?.dealerSeat, 0);
  const discarded = rooms.discardTile(started.roomCode, sessions[0]!.playerToken, "wan-1");

  assert.equal(discarded.snapshot.game?.stage, "awaiting_reactions");
  assert.equal(discarded.snapshot.game?.availableOperations, undefined);
  assert.deepEqual(discarded.snapshot.game?.reaction, {
    discard: { seat: 0, tile: "wan-1" },
    source: "discard",
    waitingCount: 1,
    respondedCount: 0,
  });
  assert.equal(rooms.snapshotForPlayer(started.roomCode, sessions[0]!.playerToken).game?.availableOperations, undefined);
  const nextView = rooms.snapshotForPlayer(started.roomCode, sessions[1]!.playerToken);
  assert.deepEqual(nextView.game?.availableOperations?.map((option) => option.kind), ["chi"]);
  assert.equal(rooms.snapshotForPlayer(started.roomCode, sessions[2]!.playerToken).game?.availableOperations, undefined);
  assert.throws(
    () => rooms.reactToDiscard(started.roomCode, sessions[2]!.playerToken, "pass"),
    (error) => error instanceof RoomError && error.code === "REACTION_NOT_ELIGIBLE",
  );

  const passed = rooms.reactToDiscard(started.roomCode, sessions[1]!.playerToken, "pass");
  assert.equal(passed.diagnostics.resolution, "all_passed");
  assert.equal(passed.snapshot.game?.stage, "awaiting_discard");
  assert.equal(passed.snapshot.game?.turnSeat, 1);
  assert.equal(passed.snapshot.game?.wallRemaining, 82);
  assert.equal(passed.snapshot.game?.handTileCounts[1], 14);
});

test("吃牌成功后移除弃牌和两张手牌并由吃牌者直接出牌", () => {
  const { rooms, sessions, started } = createDeterministicFourPlayerGame();
  rooms.discardTile(started.roomCode, sessions[0]!.playerToken, "wan-1");
  const nextView = rooms.snapshotForPlayer(started.roomCode, sessions[1]!.playerToken);
  const chi = nextView.game!.availableOperations!.find((option) => option.kind === "chi")!;

  const claimed = rooms.reactToDiscard(started.roomCode, sessions[1]!.playerToken, chi.id);

  assert.equal(claimed.diagnostics.resolution, "meld_claimed");
  assert.equal(claimed.snapshot.game?.stage, "awaiting_discard");
  assert.equal(claimed.snapshot.game?.turnSeat, 1);
  assert.equal(claimed.snapshot.game?.discards.length, 0);
  assert.equal(claimed.snapshot.game?.handTileCounts[1], 11);
  assert.deepEqual(claimed.snapshot.game?.melds, [{ seat: 1, kind: "chi", tiles: ["wan-1", "wan-2", "wan-3"], fromSeat: 0 }]);
  assert.equal(claimed.snapshot.game?.wallRemaining, 83);
});

test("明杠从牌墙尾部补牌并把出牌权交给杠牌者", () => {
  const { rooms, sessions, started } = createDeterministicFourPlayerGame();
  const firstDiscard = rooms.discardTile(started.roomCode, sessions[0]!.playerToken, "tong-5");
  assert.equal(firstDiscard.snapshot.game?.turnSeat, 1);
  rooms.discardTile(started.roomCode, sessions[1]!.playerToken, "wan-3");
  const gangView = rooms.snapshotForPlayer(started.roomCode, sessions[2]!.playerToken);
  const gang = gangView.game!.availableOperations!.find((option) => option.kind === "gang")!;

  const claimed = rooms.reactToDiscard(started.roomCode, sessions[2]!.playerToken, gang.id);

  assert.equal(claimed.snapshot.game?.stage, "awaiting_discard");
  assert.equal(claimed.snapshot.game?.turnSeat, 2);
  assert.equal(claimed.snapshot.game?.wallRemaining, 81);
  assert.equal(claimed.snapshot.game?.handTileCounts[2], 11);
  assert.equal(claimed.snapshot.game?.selfHand, undefined);
  assert.deepEqual(claimed.snapshot.game?.melds.at(-1), {
    seat: 2,
    kind: "gang",
    tiles: ["wan-3", "wan-3", "wan-3", "wan-3"],
    fromSeat: 1,
    gangType: "ming",
  });
  assert.equal(rooms.snapshotForPlayer(started.roomCode, sessions[2]!.playerToken).game?.selfDrawnTile !== undefined, true);
});

function createDiscardHuGame(): InitialGameState {
  const pool = createFullTileSet();
  const take = (code: Tile["code"]): Tile => {
    const index = pool.findIndex((tile) => tile.code === code);
    if (index < 0) throw new Error(`测试牌池缺少 ${code}`);
    return pool.splice(index, 1)[0]!;
  };
  const winnerCodes: Tile["code"][] = [
    "wan-1", "wan-2", "wan-3",
    "tong-1", "tong-2", "tong-3",
    "tiao-1", "tiao-2", "tiao-3",
    "wan-9", "wan-9", "wan-9",
    "east",
  ];
  const winnerHand = winnerCodes.map(take);
  const dealerHand = [take("east"), ...pool.splice(0, 13)];
  const thirdHand = pool.splice(0, 13);
  const fourthHand = pool.splice(0, 13);
  const game: InitialGameState = {
    modelVersion: GAME_MODEL_VERSION,
    roundNumber: 1,
    dealerSeat: 0,
    turnSeat: 0,
    stage: "awaiting_discard",
    hands: new Map([
      [0, dealerHand],
      [1, winnerHand],
      [2, thirdHand],
      [3, fourthHand],
    ]),
    wall: pool,
    discards: [],
    melds: new Map([[0, []], [1, []], [2, []], [3, []]]),
    lastDraw: { seat: 0, tile: dealerHand.at(-1)! },
  };
  validateInitialGame(game);
  return game;
}

test("点炮胡响应结束本局并公开赢家、点炮者和胡牌张", () => {
  const rooms = new RoomManager(() => 0, () => createDiscardHuGame());
  const sessions = [rooms.createRoom("东")];
  sessions.push(rooms.joinRoom(sessions[0]!.roomCode, "南"));
  sessions.push(rooms.joinRoom(sessions[0]!.roomCode, "西"));
  sessions.push(rooms.joinRoom(sessions[0]!.roomCode, "北"));
  for (const session of sessions) rooms.setReady(session.roomCode, session.playerToken, true);
  const started = rooms.startGame(sessions[0]!.roomCode, sessions[0]!.playerToken);

  rooms.discardTile(started.roomCode, sessions[0]!.playerToken, "east");
  const winnerView = rooms.snapshotForPlayer(started.roomCode, sessions[1]!.playerToken);
  const hu = winnerView.game!.availableOperations!.find((option) => option.kind === "hu")!;
  const result = rooms.reactToDiscard(started.roomCode, sessions[1]!.playerToken, hu.id);

  assert.equal(result.diagnostics.resolution, "discard_hu");
  assert.equal(result.snapshot.game?.stage, "round_ended");
  assert.deepEqual(result.snapshot.game?.roundResult, {
    reason: "discard_hu",
    winnerSeats: [1],
    fromSeat: 0,
    tile: "east",
  });
  assert.throws(
    () => rooms.discardTile(started.roomCode, sessions[1]!.playerToken, "wan-1"),
    (error) => error instanceof RoomError && error.code === "ROUND_ENDED",
  );
});

function startCustomGame(factory: () => InitialGameState): { rooms: RoomManager; sessions: Session[]; started: RoomSnapshot } {
  const rooms = new RoomManager(() => 0, factory);
  const sessions = [rooms.createRoom("东")];
  sessions.push(rooms.joinRoom(sessions[0]!.roomCode, "南"));
  sessions.push(rooms.joinRoom(sessions[0]!.roomCode, "西"));
  sessions.push(rooms.joinRoom(sessions[0]!.roomCode, "北"));
  for (const session of sessions) rooms.setReady(session.roomCode, session.playerToken, true);
  return { rooms, sessions, started: rooms.startGame(sessions[0]!.roomCode, sessions[0]!.playerToken) };
}

function createSelfDrawGame(): InitialGameState {
  const pool = createFullTileSet();
  const take = (code: Tile["code"]): Tile => {
    const index = pool.findIndex((tile) => tile.code === code);
    if (index < 0) throw new Error(`测试牌池缺少 ${code}`);
    return pool.splice(index, 1)[0]!;
  };
  const dealerHand = [
    "wan-1", "wan-2", "wan-3",
    "tong-1", "tong-2", "tong-3",
    "tiao-1", "tiao-2", "tiao-3",
    "wan-9", "wan-9", "wan-9",
    "east", "east",
  ].map((code) => take(code as Tile["code"]));
  const game: InitialGameState = {
    modelVersion: GAME_MODEL_VERSION,
    roundNumber: 1,
    dealerSeat: 0,
    turnSeat: 0,
    stage: "awaiting_discard",
    hands: new Map([[0, dealerHand], [1, pool.splice(0, 13)], [2, pool.splice(0, 13)], [3, pool.splice(0, 13)]]),
    wall: pool,
    discards: [],
    melds: new Map([[0, []], [1, []], [2, []], [3, []]]),
    lastDraw: { seat: 0, tile: dealerHand.at(-1)! },
  };
  validateInitialGame(game);
  return game;
}

test("自摸候选只下发给当前玩家并在确认后结束本局", () => {
  const { rooms, sessions, started } = startCustomGame(createSelfDrawGame);
  assert.deepEqual(started.game?.availableTurnOperations, undefined);
  const dealerView = rooms.snapshotForPlayer(started.roomCode, sessions[0]!.playerToken);
  assert.deepEqual(dealerView.game?.availableTurnOperations?.map((option) => option.kind), ["zimo"]);
  assert.equal(rooms.snapshotForPlayer(started.roomCode, sessions[1]!.playerToken).game?.availableTurnOperations, undefined);
  assert.throws(
    () => rooms.performTurnOperation(started.roomCode, sessions[1]!.playerToken, "zimo"),
    (error) => error instanceof RoomError && error.code === "TURN_OPERATION_NOT_AVAILABLE",
  );

  const result = rooms.performTurnOperation(started.roomCode, sessions[0]!.playerToken, "zimo");
  assert.equal(result.diagnostics.operation, "zimo");
  assert.equal(result.snapshot.game?.stage, "round_ended");
  assert.deepEqual(result.snapshot.game?.roundResult, { reason: "self_draw_hu", winnerSeats: [0], tile: "east" });
});

function createConcealedGangGame(): InitialGameState {
  const pool = createFullTileSet();
  const gangTiles = pool.filter((tile) => tile.code === "wan-1");
  for (const tile of gangTiles) pool.splice(pool.indexOf(tile), 1);
  const dealerHand = [...gangTiles, ...pool.splice(0, 10)];
  return {
    modelVersion: GAME_MODEL_VERSION,
    roundNumber: 1,
    dealerSeat: 0,
    turnSeat: 0,
    stage: "awaiting_discard",
    hands: new Map([[0, dealerHand], [1, pool.splice(0, 13)], [2, pool.splice(0, 13)], [3, pool.splice(0, 13)]]),
    wall: pool,
    discards: [],
    melds: new Map([[0, []], [1, []], [2, []], [3, []]]),
    lastDraw: { seat: 0, tile: dealerHand.at(-1)! },
  };
}

test("暗杠移除四张手牌、公开副露并从牌墙尾部补牌", () => {
  const { rooms, sessions, started } = startCustomGame(createConcealedGangGame);
  const view = rooms.snapshotForPlayer(started.roomCode, sessions[0]!.playerToken);
  const angang = view.game!.availableTurnOperations!.find((option) => option.kind === "angang")!;
  const result = rooms.performTurnOperation(started.roomCode, sessions[0]!.playerToken, angang.id);

  assert.equal(result.snapshot.game?.stage, "awaiting_discard");
  assert.equal(result.snapshot.game?.wallRemaining, 82);
  assert.equal(result.snapshot.game?.handTileCounts[0], 11);
  assert.deepEqual(result.snapshot.game?.melds, [{
    seat: 0,
    kind: "gang",
    gangType: "an",
    tiles: ["wan-1", "wan-1", "wan-1", "wan-1"],
    fromSeat: 0,
  }]);
  assert.ok(rooms.snapshotForPlayer(started.roomCode, sessions[0]!.playerToken).game?.selfDrawnTile);
});

function createAddedGangGame(): InitialGameState {
  const pool = createFullTileSet();
  const take = (code: Tile["code"]): Tile => {
    const index = pool.findIndex((tile) => tile.code === code);
    if (index < 0) throw new Error(`测试牌池缺少 ${code}`);
    return pool.splice(index, 1)[0]!;
  };
  const pengTiles = [take("wan-3"), take("wan-3"), take("wan-3")];
  const winnerHand = [
    "wan-1", "wan-2",
    "tong-1", "tong-2", "tong-3",
    "tiao-1", "tiao-2", "tiao-3",
    "wan-9", "wan-9", "wan-9",
    "east", "east",
  ].map((code) => take(code as Tile["code"]));
  const dealerHand = [take("wan-3"), ...pool.splice(0, 10)];
  return {
    modelVersion: GAME_MODEL_VERSION,
    roundNumber: 1,
    dealerSeat: 0,
    turnSeat: 0,
    stage: "awaiting_discard",
    hands: new Map([[0, dealerHand], [1, winnerHand], [2, pool.splice(0, 13)], [3, pool.splice(0, 13)]]),
    wall: pool,
    discards: [],
    melds: new Map([
      [0, [{ seat: 0, kind: "peng", tiles: pengTiles.map((tile) => tile.code), fromSeat: 2 }]],
      [1, []], [2, []], [3, []],
    ]),
    lastDraw: { seat: 0, tile: dealerHand.at(-1)! },
  };
}

test("加杠先开启私有抢杠窗口，胡牌后保留原碰牌", () => {
  const { rooms, sessions, started } = startCustomGame(createAddedGangGame);
  const dealerView = rooms.snapshotForPlayer(started.roomCode, sessions[0]!.playerToken);
  const jiagang = dealerView.game!.availableTurnOperations!.find((option) => option.kind === "jiagang")!;
  const pending = rooms.performTurnOperation(started.roomCode, sessions[0]!.playerToken, jiagang.id);

  assert.equal(pending.snapshot.game?.stage, "awaiting_reactions");
  assert.equal(pending.snapshot.game?.reaction?.source, "added_gang");
  assert.equal(pending.snapshot.game?.handTileCounts[0], 10);
  assert.equal(pending.snapshot.game?.melds[0]?.kind, "peng");
  assert.deepEqual(rooms.snapshotForPlayer(started.roomCode, sessions[1]!.playerToken).game?.availableOperations?.map((option) => option.kind), ["hu"]);
  assert.equal(rooms.snapshotForPlayer(started.roomCode, sessions[2]!.playerToken).game?.availableOperations, undefined);

  const result = rooms.reactToDiscard(started.roomCode, sessions[1]!.playerToken, "hu");
  assert.equal(result.diagnostics.resolution, "rob_kong_hu");
  assert.deepEqual(result.snapshot.game?.roundResult, { reason: "rob_kong_hu", winnerSeats: [1], fromSeat: 0, tile: "wan-3" });
  assert.equal(result.snapshot.game?.melds[0]?.kind, "peng");
  assert.equal(result.snapshot.game?.wallRemaining, 83);
});

test("无人抢杠时加杠升级原碰牌并从牌墙尾部补牌", () => {
  const { rooms, sessions, started } = startCustomGame(createAddedGangGame);
  const jiagang = rooms.snapshotForPlayer(started.roomCode, sessions[0]!.playerToken).game!.availableTurnOperations!.find(
    (option) => option.kind === "jiagang",
  )!;
  rooms.performTurnOperation(started.roomCode, sessions[0]!.playerToken, jiagang.id);
  const result = rooms.reactToDiscard(started.roomCode, sessions[1]!.playerToken, "pass");

  assert.equal(result.diagnostics.resolution, "added_gang_completed");
  assert.equal(result.snapshot.game?.stage, "awaiting_discard");
  assert.equal(result.snapshot.game?.wallRemaining, 82);
  assert.equal(result.snapshot.game?.handTileCounts[0], 11);
  assert.deepEqual(result.snapshot.game?.melds[0], {
    seat: 0,
    kind: "gang",
    gangType: "jia",
    tiles: ["wan-3", "wan-3", "wan-3", "wan-3"],
    fromSeat: 2,
  });
});
