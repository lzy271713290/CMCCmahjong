import assert from "node:assert/strict";
import test from "node:test";
import type { RoomSnapshot } from "../../shared/protocol.js";
import { GAME_MODEL_VERSION, createFullTileSet, createInitialGame, validateInitialGame, type InitialGameState, type Tile } from "../src/game-model.js";
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

test("创建房间可以选择8局或16局模式", () => {
  const rooms = new RoomManager();
  const eight = rooms.createRoom("八局房", 8);
  const sixteen = rooms.createRoom("十六局房", 16);
  assert.deepEqual(eight.snapshot.match, {
    totalRounds: 8,
    completedRounds: 0,
    status: "waiting",
    endReason: undefined,
    rankings: undefined,
    roundHistory: [],
    earlySettlement: undefined,
  });
  assert.equal(sixteen.snapshot.match.totalRounds, 16);
  assert.throws(
    () => rooms.createRoom("错误房", 12 as 8),
    (error) => error instanceof RoomError && error.code === "MATCH_MODE_INVALID",
  );
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
    scorePayments: [],
    scoreDeltas: [0, 0, 0, 0],
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
  const roundResult = result.snapshot.game!.roundResult!;
  assert.deepEqual({ reason: roundResult.reason, winnerSeats: roundResult.winnerSeats, fromSeat: roundResult.fromSeat, tile: roundResult.tile }, {
    reason: "discard_hu",
    winnerSeats: [1],
    fromSeat: 0,
    tile: "east",
  });
  assert.deepEqual(roundResult.scoreDeltas, [-32, 48, -8, -8]);
  assert.deepEqual(result.snapshot.scoreTotals, [168, 248, 192, 192]);
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

function startTwoRoundCustomGame(factory: () => InitialGameState): { rooms: RoomManager; sessions: Session[]; started: RoomSnapshot } {
  let factoryCalls = 0;
  const rooms = new RoomManager(
    () => 0,
    (seats, dealerSeat, _randomIndex, roundNumber) => {
      factoryCalls += 1;
      return factoryCalls === 1 ? factory() : createInitialGame(seats, dealerSeat, () => 0, roundNumber);
    },
  );
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
    scorePayments: [],
    scoreDeltas: [0, 0, 0, 0],
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
  assert.equal(result.snapshot.game?.roundResult?.reason, "self_draw_hu");
  assert.equal(result.snapshot.game?.roundResult?.tile, "east");
  assert.deepEqual(result.snapshot.game?.roundResult?.scoreDeltas, [96, -32, -32, -32]);
  assert.deepEqual(result.snapshot.scoreTotals, [296, 168, 168, 168]);
});

test("庄家胡牌后连庄并保留累计分进入下一局", () => {
  const { rooms, sessions, started } = startTwoRoundCustomGame(createSelfDrawGame);
  assert.throws(
    () => rooms.startNextRound(started.roomCode, sessions[0]!.playerToken),
    (error) => error instanceof RoomError && error.code === "ROUND_ACTIVE",
  );
  const ended = rooms.performTurnOperation(started.roomCode, sessions[0]!.playerToken, "zimo").snapshot;
  assert.deepEqual(ended.scoreTotals, [296, 168, 168, 168]);
  assert.throws(
    () => rooms.startNextRound(started.roomCode, sessions[1]!.playerToken),
    (error) => error instanceof RoomError && error.code === "HOST_REQUIRED",
  );

  const next = rooms.startNextRound(started.roomCode, sessions[0]!.playerToken);
  assert.equal(next.game?.roundNumber, 2);
  assert.equal(next.game?.dealerSeat, 0);
  assert.equal(next.game?.turnSeat, 0);
  assert.deepEqual(next.scoreTotals, [296, 168, 168, 168]);
  assert.deepEqual(next.game?.scorePayments, []);
  assert.deepEqual(next.game?.scoreDeltas, [0, 0, 0, 0]);
  assert.deepEqual(next.game?.handTileCounts, [14, 13, 13, 13]);
});

test("闲家胡牌后由原庄下家坐庄", () => {
  const { rooms, sessions, started } = startTwoRoundCustomGame(createDiscardHuGame);
  rooms.discardTile(started.roomCode, sessions[0]!.playerToken, "east");
  const winnerView = rooms.snapshotForPlayer(started.roomCode, sessions[1]!.playerToken);
  const hu = winnerView.game!.availableOperations!.find((option) => option.kind === "hu")!;
  const ended = rooms.reactToDiscard(started.roomCode, sessions[1]!.playerToken, hu.id).snapshot;
  assert.deepEqual(ended.scoreTotals, [168, 248, 192, 192]);

  const next = rooms.startNextRound(started.roomCode, sessions[0]!.playerToken);
  assert.equal(next.game?.roundNumber, 2);
  assert.equal(next.game?.dealerSeat, 1);
  assert.equal(next.game?.turnSeat, 1);
  assert.deepEqual(next.scoreTotals, [168, 248, 192, 192]);
  assert.deepEqual(next.game?.handTileCounts, [13, 14, 13, 13]);
});

function createImmediateWallExhaustedGame(
  seats: readonly number[],
  dealerSeat: number,
  roundNumber = 1,
): InitialGameState {
  const dealerTile: Tile = { code: "wan-1", copy: 0 };
  return {
    modelVersion: GAME_MODEL_VERSION,
    roundNumber,
    dealerSeat,
    turnSeat: dealerSeat,
    stage: "awaiting_discard",
    hands: new Map(seats.map((seat) => [seat, seat === dealerSeat ? [dealerTile] : []])),
    wall: [],
    discards: [],
    melds: new Map(seats.map((seat) => [seat, []])),
    scorePayments: [],
    scoreDeltas: [0, 0, 0, 0],
    lastDraw: { seat: dealerSeat, tile: dealerTile },
  };
}

test("8局模式完成第8局后按累计分并列排名", () => {
  const rooms = new RoomManager(
    () => 0,
    (seats, dealerSeat, _randomIndex, roundNumber) => createImmediateWallExhaustedGame(seats, dealerSeat, roundNumber),
  );
  const sessions = [rooms.createRoom("东", 8)];
  sessions.push(rooms.joinRoom(sessions[0]!.roomCode, "南"));
  sessions.push(rooms.joinRoom(sessions[0]!.roomCode, "西"));
  sessions.push(rooms.joinRoom(sessions[0]!.roomCode, "北"));
  for (const session of sessions) rooms.setReady(session.roomCode, session.playerToken, true);
  let snapshot = rooms.startGame(sessions[0]!.roomCode, sessions[0]!.playerToken);

  for (let round = 1; round <= 8; round += 1) {
    const dealerSession = sessions.find(
      (session) => session.snapshot.players.find((player) => player.id === session.playerId)?.seat === snapshot.game?.dealerSeat,
    )!;
    snapshot = rooms.discardTile(snapshot.roomCode, dealerSession.playerToken, "wan-1").snapshot;
    assert.equal(snapshot.match.completedRounds, round);
    if (round < 8) snapshot = rooms.startNextRound(snapshot.roomCode, sessions[0]!.playerToken);
  }

  assert.equal(snapshot.match.status, "completed");
  assert.equal(snapshot.match.endReason, "round_limit");
  assert.deepEqual(snapshot.match.rankings, [
    { seat: 0, score: 200, rank: 1 },
    { seat: 1, score: 200, rank: 1 },
    { seat: 2, score: 200, rank: 1 },
    { seat: 3, score: 200, rank: 1 },
  ]);
  assert.equal(snapshot.match.roundHistory.length, 8);
  assert.deepEqual(snapshot.match.roundHistory[0], {
    roundNumber: 1,
    dealerSeat: 0,
    reason: "wall_exhausted",
    winnerSeats: [],
    scoreDeltas: [0, 0, 0, 0],
    scoreTotals: [200, 200, 200, 200],
  });
  assert.throws(
    () => rooms.startNextRound(snapshot.roomCode, sessions[0]!.playerToken),
    (error) => error instanceof RoomError && error.code === "MATCH_ENDED",
  );
});

test("16局模式在局末出现负分时提前结束并生成并列排名", () => {
  const rooms = new RoomManager(() => 0, () => createSelfDrawGame());
  const sessions = [rooms.createRoom("东", 16)];
  sessions.push(rooms.joinRoom(sessions[0]!.roomCode, "南"));
  sessions.push(rooms.joinRoom(sessions[0]!.roomCode, "西"));
  sessions.push(rooms.joinRoom(sessions[0]!.roomCode, "北"));
  for (const session of sessions) rooms.setReady(session.roomCode, session.playerToken, true);
  let snapshot = rooms.startGame(sessions[0]!.roomCode, sessions[0]!.playerToken);

  for (let round = 1; round <= 7; round += 1) {
    snapshot = rooms.performTurnOperation(snapshot.roomCode, sessions[0]!.playerToken, "zimo").snapshot;
    if (round < 7) snapshot = rooms.startNextRound(snapshot.roomCode, sessions[0]!.playerToken);
  }

  assert.equal(snapshot.match.status, "completed");
  assert.equal(snapshot.match.completedRounds, 7);
  assert.equal(snapshot.match.endReason, "negative_score");
  assert.deepEqual(snapshot.scoreTotals, [872, -24, -24, -24]);
  assert.deepEqual(snapshot.match.rankings, [
    { seat: 0, score: 872, rank: 1 },
    { seat: 1, score: -24, rank: 2 },
    { seat: 2, score: -24, rank: 2 },
    { seat: 3, score: -24, rank: 2 },
  ]);
  assert.equal(snapshot.match.roundHistory.length, 7);
  assert.deepEqual(snapshot.match.roundHistory.at(-1)?.scoreTotals, [872, -24, -24, -24]);
});

function startEarlySettlementRoom(useTestPlayers = false): { rooms: RoomManager; sessions: Session[]; ended: RoomSnapshot } {
  const rooms = new RoomManager(
    () => 0,
    (seats, dealerSeat, _randomIndex, roundNumber) => createImmediateWallExhaustedGame(seats, dealerSeat, roundNumber),
  );
  const sessions = [rooms.createRoom("东", 16)];
  if (useTestPlayers) {
    rooms.fillWithTestPlayers(sessions[0]!.roomCode, sessions[0]!.playerToken);
  } else {
    sessions.push(rooms.joinRoom(sessions[0]!.roomCode, "南"));
    sessions.push(rooms.joinRoom(sessions[0]!.roomCode, "西"));
    sessions.push(rooms.joinRoom(sessions[0]!.roomCode, "北"));
  }
  for (const session of sessions) rooms.setReady(session.roomCode, session.playerToken, true);
  const started = rooms.startGame(sessions[0]!.roomCode, sessions[0]!.playerToken);
  assert.throws(
    () => rooms.requestEarlySettlement(started.roomCode, sessions[0]!.playerToken),
    (error) => error instanceof RoomError && error.code === "ROUND_ACTIVE",
  );
  const ended = rooms.discardTile(started.roomCode, sessions[0]!.playerToken, "wan-1").snapshot;
  return { rooms, sessions, ended };
}

test("提前结算投票可以拒绝且拒绝后正常开始下一局", () => {
  const { rooms, sessions, ended } = startEarlySettlementRoom();
  const requested = rooms.requestEarlySettlement(ended.roomCode, sessions[1]!.playerToken).snapshot;
  assert.deepEqual(requested.match.earlySettlement, {
    requesterSeat: 1,
    status: "voting",
    approvedSeats: [1],
    rejectedSeats: [],
    waitingSeats: [0, 2, 3],
  });
  assert.throws(
    () => rooms.startNextRound(ended.roomCode, sessions[0]!.playerToken),
    (error) => error instanceof RoomError && error.code === "EARLY_SETTLEMENT_PENDING",
  );
  rooms.respondEarlySettlement(ended.roomCode, sessions[2]!.playerToken, true);
  const rejected = rooms.respondEarlySettlement(ended.roomCode, sessions[3]!.playerToken, false).snapshot;
  assert.equal(rejected.match.status, "active");
  assert.equal(rejected.match.earlySettlement?.status, "rejected");
  assert.deepEqual(rejected.match.earlySettlement?.rejectedSeats, [3]);
  const next = rooms.startNextRound(ended.roomCode, sessions[0]!.playerToken);
  assert.equal(next.game?.roundNumber, 2);
  assert.equal(next.match.earlySettlement, undefined);
  assert.equal(next.match.roundHistory.length, 1);
});

test("另外三人全部同意后提前整场结算且重连恢复投票状态", () => {
  const { rooms, sessions, ended } = startEarlySettlementRoom();
  rooms.requestEarlySettlement(ended.roomCode, sessions[0]!.playerToken);
  rooms.respondEarlySettlement(ended.roomCode, sessions[1]!.playerToken, true);
  rooms.disconnect(ended.roomCode, sessions[2]!.playerToken);
  const restored = rooms.reconnect(ended.roomCode, sessions[2]!.playerToken);
  assert.deepEqual(restored.snapshot.match.earlySettlement?.approvedSeats, [0, 1]);
  assert.deepEqual(restored.snapshot.match.earlySettlement?.waitingSeats, [2, 3]);
  rooms.respondEarlySettlement(ended.roomCode, sessions[2]!.playerToken, true);
  const approved = rooms.respondEarlySettlement(ended.roomCode, sessions[3]!.playerToken, true).snapshot;
  assert.equal(approved.match.status, "completed");
  assert.equal(approved.match.endReason, "early_agreement");
  assert.equal(approved.match.earlySettlement?.status, "approved");
  assert.deepEqual(approved.match.rankings, [
    { seat: 0, score: 200, rank: 1 },
    { seat: 1, score: 200, rank: 1 },
    { seat: 2, score: 200, rank: 1 },
    { seat: 3, score: 200, rank: 1 },
  ]);
  assert.throws(
    () => rooms.startNextRound(ended.roomCode, sessions[0]!.playerToken),
    (error) => error instanceof RoomError && error.code === "MATCH_ENDED",
  );
});

test("单人联调的三个测试玩家自动同意提前结算", () => {
  const { rooms, sessions, ended } = startEarlySettlementRoom(true);
  const approved = rooms.requestEarlySettlement(ended.roomCode, sessions[0]!.playerToken);
  assert.equal(approved.diagnostics.autoApprovedSeats.length, 3);
  assert.equal(approved.snapshot.match.status, "completed");
  assert.equal(approved.snapshot.match.endReason, "early_agreement");
  assert.deepEqual(approved.snapshot.match.earlySettlement?.approvedSeats, [0, 1, 2, 3]);
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
    scorePayments: [],
    scoreDeltas: [0, 0, 0, 0],
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
  assert.deepEqual(result.snapshot.game?.scoreDeltas, [12, -4, -4, -4]);
  assert.deepEqual(result.snapshot.scoreTotals, [212, 196, 196, 196]);
  assert.deepEqual(result.snapshot.game?.melds, [{
    seat: 0,
    kind: "gang",
    gangType: "an",
    tiles: [],
    fromSeat: 0,
    hiddenTileCount: 4,
  }]);
  const ownerView = rooms.snapshotForPlayer(started.roomCode, sessions[0]!.playerToken);
  assert.deepEqual(ownerView.game?.melds[0]?.tiles, ["wan-1", "wan-1", "wan-1", "wan-1"]);
  assert.equal(ownerView.game?.melds[0]?.hiddenTileCount, undefined);
  assert.ok(ownerView.game?.selfDrawnTile);
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
    scorePayments: [],
    scoreDeltas: [0, 0, 0, 0],
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
  assert.equal(result.snapshot.game?.roundResult?.reason, "rob_kong_hu");
  assert.deepEqual(result.snapshot.game?.roundResult?.scoreDeltas, [-16, 32, -8, -8]);
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
  assert.deepEqual(result.snapshot.game?.scoreDeltas, [6, -2, -2, -2]);
  assert.deepEqual(result.snapshot.game?.melds[0], {
    seat: 0,
    kind: "gang",
    gangType: "jia",
    tiles: ["wan-3", "wan-3", "wan-3", "wan-3"],
    fromSeat: 2,
  });
});

function createSpecialGangGame(): InitialGameState {
  const pool = createFullTileSet();
  const take = (code: Tile["code"]): Tile => {
    const index = pool.findIndex((tile) => tile.code === code);
    if (index < 0) throw new Error(`测试牌池缺少 ${code}`);
    return pool.splice(index, 1)[0]!;
  };
  const red = take("red");
  const green = take("green");
  const white = take("white");
  const extraRed = take("red");
  const extraGreen = take("green");
  const winnerHand = [
    "wan-1", "wan-2", "wan-3",
    "tong-1", "tong-2", "tong-3",
    "tiao-1", "tiao-2", "tiao-3",
    "wan-9", "wan-9", "wan-9",
    "white",
  ].map((code) => take(code as Tile["code"]));
  const dealerHand = [red, green, extraRed, extraGreen, ...pool.splice(0, 9), white];
  return {
    modelVersion: GAME_MODEL_VERSION,
    roundNumber: 1,
    dealerSeat: 0,
    turnSeat: 0,
    stage: "awaiting_discard",
    hands: new Map([[0, dealerHand], [1, winnerHand], [2, pool.splice(0, 13)], [3, pool.splice(0, 13)]]),
    wall: pool,
    discards: [],
    melds: new Map([[0, []], [1, []], [2, []], [3, []]]),
    scorePayments: [],
    scoreDeltas: [0, 0, 0, 0],
    lastDraw: { seat: 0, tile: white },
  };
}

test("中发白特殊杠先开启私有抢杠窗口，被抢后只扣除被抢牌", () => {
  const { rooms, sessions, started } = startCustomGame(createSpecialGangGame);
  const dealerView = rooms.snapshotForPlayer(started.roomCode, sessions[0]!.playerToken);
  const special = dealerView.game!.availableTurnOperations!.find((option) => option.id === "specialgang:dragons")!;
  const pending = rooms.performTurnOperation(started.roomCode, sessions[0]!.playerToken, special.id);

  assert.equal(pending.snapshot.game?.stage, "awaiting_reactions");
  assert.equal(pending.snapshot.game?.reaction?.source, "special_gang");
  assert.equal(pending.snapshot.game?.reaction?.discard.tile, "white");
  assert.equal(pending.snapshot.game?.handTileCounts[0], 11);
  assert.deepEqual(rooms.snapshotForPlayer(started.roomCode, sessions[1]!.playerToken).game?.availableOperations?.map((option) => option.kind), ["hu"]);
  assert.equal(rooms.snapshotForPlayer(started.roomCode, sessions[2]!.playerToken).game?.availableOperations, undefined);

  const result = rooms.reactToDiscard(started.roomCode, sessions[1]!.playerToken, "hu");
  assert.equal(result.diagnostics.resolution, "rob_kong_hu");
  assert.equal(result.snapshot.game?.roundResult?.reason, "rob_kong_hu");
  assert.deepEqual(result.snapshot.game?.roundResult?.scoreDeltas, [-32, 48, -8, -8]);
  assert.equal(result.snapshot.game?.handTileCounts[0], 13);
  assert.deepEqual(result.snapshot.game?.melds, []);
  const finalDealerHand = rooms.snapshotForPlayer(started.roomCode, sessions[0]!.playerToken).game!.selfHand!;
  assert.equal(finalDealerHand.filter((code) => code === "red").length, 2);
  assert.equal(finalDealerHand.filter((code) => code === "green").length, 2);
  assert.equal(finalDealerHand.includes("white"), false);
});

test("特殊杠全过后成立并允许手中多余字牌连续涨毛", () => {
  const { rooms, sessions, started } = startCustomGame(createSpecialGangGame);
  const special = rooms.snapshotForPlayer(started.roomCode, sessions[0]!.playerToken).game!.availableTurnOperations!.find(
    (option) => option.id === "specialgang:dragons",
  )!;
  rooms.performTurnOperation(started.roomCode, sessions[0]!.playerToken, special.id);
  const established = rooms.reactToDiscard(started.roomCode, sessions[1]!.playerToken, "pass");

  assert.equal(established.diagnostics.resolution, "special_gang_completed");
  assert.equal(established.snapshot.game?.stage, "awaiting_discard");
  assert.equal(established.snapshot.game?.wallRemaining, 82);
  assert.equal(established.snapshot.game?.handTileCounts[0], 12);
  assert.deepEqual(established.snapshot.game?.scoreDeltas, [6, -2, -2, -2]);
  assert.deepEqual(established.snapshot.game?.melds[0], {
    seat: 0,
    kind: "special_gang",
    specialType: "dragons",
    tiles: ["red", "green", "white"],
    fromSeat: 0,
    growthCount: 0,
  });

  const afterBaseView = rooms.snapshotForPlayer(started.roomCode, sessions[0]!.playerToken);
  const redGrowth = afterBaseView.game!.availableTurnOperations!.find((option) => option.id === "zhangmao:0:red")!;
  const firstGrowth = rooms.performTurnOperation(started.roomCode, sessions[0]!.playerToken, redGrowth.id);
  assert.equal(firstGrowth.snapshot.game?.wallRemaining, 81);
  assert.equal(firstGrowth.snapshot.game?.melds[0]?.growthCount, 1);
  assert.deepEqual(firstGrowth.snapshot.game?.melds[0]?.tiles, ["red", "green", "white", "red"]);

  const greenGrowth = rooms.snapshotForPlayer(started.roomCode, sessions[0]!.playerToken).game!.availableTurnOperations!.find(
    (option) => option.id === "zhangmao:0:green",
  )!;
  const secondGrowth = rooms.performTurnOperation(started.roomCode, sessions[0]!.playerToken, greenGrowth.id);
  assert.equal(secondGrowth.snapshot.game?.wallRemaining, 80);
  assert.equal(secondGrowth.snapshot.game?.melds.length, 1);
  assert.equal(secondGrowth.snapshot.game?.melds[0]?.growthCount, 2);
  assert.deepEqual(secondGrowth.snapshot.game?.scoreDeltas, [12, -4, -4, -4]);
  assert.deepEqual(secondGrowth.snapshot.scoreTotals, [212, 196, 196, 196]);
  assert.deepEqual(secondGrowth.snapshot.game?.melds[0]?.tiles, ["red", "green", "white", "red", "green"]);
});

function createZhangmaoRobGame(): InitialGameState {
  const pool = createFullTileSet();
  const take = (code: Tile["code"]): Tile => {
    const index = pool.findIndex((tile) => tile.code === code);
    if (index < 0) throw new Error(`测试牌池缺少 ${code}`);
    return pool.splice(index, 1)[0]!;
  };
  const specialTiles = [take("red"), take("green"), take("white")];
  const winnerHand = [
    "wan-1", "wan-2", "wan-3",
    "tong-1", "tong-2", "tong-3",
    "tiao-1", "tiao-2", "tiao-3",
    "wan-9", "wan-9", "wan-9",
    "white",
  ].map((code) => take(code as Tile["code"]));
  const growthTile = take("white");
  const dealerHand = [...pool.splice(0, 10), growthTile];
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
      [0, [{ seat: 0, kind: "special_gang", specialType: "dragons", tiles: specialTiles.map((tile) => tile.code), fromSeat: 0, growthCount: 0 }]],
      [1, []], [2, []], [3, []],
    ]),
    scorePayments: [],
    scoreDeltas: [0, 0, 0, 0],
    lastDraw: { seat: 0, tile: growthTile },
  };
}

test("每次涨毛独立开放抢杠窗口，被抢后不增加特殊杠牌张", () => {
  const { rooms, sessions, started } = startCustomGame(createZhangmaoRobGame);
  const growth = rooms.snapshotForPlayer(started.roomCode, sessions[0]!.playerToken).game!.availableTurnOperations!.find(
    (option) => option.id === "zhangmao:0:white",
  )!;
  const pending = rooms.performTurnOperation(started.roomCode, sessions[0]!.playerToken, growth.id);
  assert.equal(pending.snapshot.game?.reaction?.source, "zhangmao");
  assert.equal(pending.snapshot.game?.handTileCounts[0], 10);

  const result = rooms.reactToDiscard(started.roomCode, sessions[1]!.playerToken, "hu");
  assert.equal(result.diagnostics.resolution, "rob_kong_hu");
  assert.equal(result.snapshot.game?.melds[0]?.growthCount, 0);
  assert.deepEqual(result.snapshot.game?.melds[0]?.tiles, ["red", "green", "white"]);
  assert.equal(result.snapshot.game?.wallRemaining, 83);
});
