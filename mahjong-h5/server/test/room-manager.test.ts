import assert from "node:assert/strict";
import test from "node:test";
import type { RoomSnapshot } from "../../shared/protocol.js";
import { GAME_MODEL_VERSION, createFullTileSet, createInitialGame, validateInitialGame, type InitialGameState, type Tile } from "../src/game-model.js";
import { AUTO_MANAGEMENT_AFTER_MS, DISCARD_TIMEOUT_MS, REACTION_TIMEOUT_MS, RoomError, RoomManager, type Session } from "../src/room-manager.js";

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

function readyAllForNextRound(rooms: RoomManager, sessions: Session[]): void {
  for (const session of sessions) rooms.setReady(session.roomCode, session.playerToken, true);
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
    startScore: 100,
    completedRounds: 0,
    status: "waiting",
    endReason: undefined,
    rankings: undefined,
    roundHistory: [],
    earlySettlement: undefined,
  });
  assert.equal(sixteen.snapshot.match.totalRounds, 16);
  const custom = rooms.createRoom("自定义分房", 8, 250);
  assert.equal(custom.snapshot.match.startScore, 250);
  assert.deepEqual(custom.snapshot.scoreTotals, [250, 250, 250, 250]);
  assert.equal(rooms.createRoom("默认分房", 8).snapshot.match.startScore, 100);
  assert.throws(
    () => rooms.createRoom("低分房", 8, 49),
    (error) => error instanceof RoomError && error.code === "START_SCORE_INVALID",
  );
  assert.throws(
    () => rooms.createRoom("超高分房", 8, 1001),
    (error) => error instanceof RoomError && error.code === "START_SCORE_INVALID",
  );
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

function createTimedFourPlayerGame(): { rooms: RoomManager; sessions: Session[]; started: RoomSnapshot; setNow: (value: number) => void } {
  let now = 1_000_000;
  const rooms = new RoomManager(() => 0, createInitialGame, () => now);
  const sessions = [rooms.createRoom("东")];
  sessions.push(rooms.joinRoom(sessions[0]!.roomCode, "南"));
  sessions.push(rooms.joinRoom(sessions[0]!.roomCode, "西"));
  sessions.push(rooms.joinRoom(sessions[0]!.roomCode, "北"));
  for (const session of sessions) rooms.setReady(session.roomCode, session.playerToken, true);
  const started = rooms.startGame(sessions[0]!.roomCode, sessions[0]!.playerToken);
  return { rooms, sessions, started, setNow: (value) => { now = value; } };
}

test("出牌30秒超时优先自动打出刚摸牌并刷新服务端期限", () => {
  const { rooms, started, setNow } = createTimedFourPlayerGame();
  assert.equal(started.game?.actionDeadlineAt, 1_000_000 + DISCARD_TIMEOUT_MS);
  assert.equal(started.game?.actionTimeoutSeconds, 30);
  setNow(1_000_000 + DISCARD_TIMEOUT_MS - 1);
  assert.deepEqual(rooms.processGovernance(), []);

  setNow(1_000_000 + DISCARD_TIMEOUT_MS);
  const [tick] = rooms.processGovernance();
  const event = tick?.events.find((candidate) => candidate.kind === "turn_timed_out");
  assert.equal(event?.kind, "turn_timed_out");
  assert.equal(event?.seat, 0);
  assert.equal(tick?.snapshot.game?.handTileCounts[0], 13);
  assert.equal(tick?.snapshot.publicActions.some((action) => action.kind === "turn_timed_out"), true);
  assert.equal(tick?.snapshot.publicActions.some((action) => action.kind === "discard"), true);
  assert.equal((tick?.snapshot.game?.actionDeadlineAt ?? 0) > 1_000_000 + DISCARD_TIMEOUT_MS, true);
});

test("响应12秒超时将所有未响应真人自动过牌", () => {
  const { rooms, sessions, started, setNow } = createTimedFourPlayerGame();
  const discarded = rooms.discardTile(started.roomCode, sessions[0]!.playerToken, "wan-1").snapshot;
  assert.equal(discarded.game?.stage, "awaiting_reactions");
  assert.equal(discarded.game?.actionTimeoutSeconds, 12);
  assert.equal(discarded.game?.actionDeadlineAt, 1_000_000 + REACTION_TIMEOUT_MS);

  setNow(1_000_000 + REACTION_TIMEOUT_MS);
  const [tick] = rooms.processGovernance();
  const event = tick?.events.find((candidate) => candidate.kind === "reaction_timed_out");
  assert.equal(event?.kind, "reaction_timed_out");
  assert.deepEqual(event?.seats, [1]);
  assert.equal(tick?.snapshot.game?.stage, "awaiting_discard");
  assert.equal(tick?.snapshot.game?.turnSeat, 1);
  assert.equal(tick?.snapshot.publicActions.some((action) => action.kind === "reaction_timed_out"), true);
});

test("真人掉线90秒进入托管且重连立即收回控制权", () => {
  const { rooms, sessions, started, setNow } = createTimedFourPlayerGame();
  rooms.disconnect(started.roomCode, sessions[2]!.playerToken);
  setNow(1_000_000 + AUTO_MANAGEMENT_AFTER_MS - 1);
  rooms.processGovernance();
  assert.equal(rooms.snapshot(started.roomCode).players[2]?.autoManaged, false);

  setNow(1_000_000 + AUTO_MANAGEMENT_AFTER_MS);
  const [tick] = rooms.processGovernance();
  assert.deepEqual(tick?.events.map((event) => event.kind), ["auto_management_started"]);
  assert.equal(tick?.snapshot.players[2]?.autoManaged, true);
  const restored = rooms.reconnect(started.roomCode, sessions[2]!.playerToken);
  assert.equal(restored.autoManagementReleased, true);
  assert.equal(restored.snapshot.players[2]?.autoManaged, false);
  assert.deepEqual(restored.snapshot.publicActions.slice(-2).map((action) => action.kind), ["auto_management_ended", "player_reconnected"]);
});

test("局中解散被拒后牌局恢复并重新获得完整出牌时间", () => {
  const { rooms, sessions, started } = createTimedFourPlayerGame();
  const requested = rooms.requestEarlySettlement(started.roomCode, sessions[0]!.playerToken).snapshot;
  assert.equal(requested.match.earlySettlement?.duringRound, true);
  assert.equal(requested.game?.actionDeadlineAt, undefined);
  const rejected = rooms.respondEarlySettlement(started.roomCode, sessions[1]!.playerToken, false).snapshot;
  assert.equal(rejected.match.earlySettlement?.status, "rejected");
  assert.equal(rejected.game?.stage, "awaiting_discard");
  assert.equal(rejected.game?.actionDeadlineAt, 1_000_000 + DISCARD_TIMEOUT_MS);
});

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
  assert.deepEqual(result.snapshot.scoreTotals, [68, 148, 92, 92]);
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
  assert.deepEqual(result.snapshot.scoreTotals, [196, 68, 68, 68]);
});

test("庄家胡牌后连庄并保留累计分进入下一局", () => {
  const { rooms, sessions, started } = startTwoRoundCustomGame(createSelfDrawGame);
  assert.throws(
    () => rooms.startNextRound(started.roomCode, sessions[0]!.playerToken),
    (error) => error instanceof RoomError && error.code === "ROUND_ACTIVE",
  );
  const ended = rooms.performTurnOperation(started.roomCode, sessions[0]!.playerToken, "zimo").snapshot;
  assert.deepEqual(ended.scoreTotals, [196, 68, 68, 68]);
  assert.throws(
    () => rooms.startNextRound(started.roomCode, sessions[1]!.playerToken),
    (error) => error instanceof RoomError && error.code === "HOST_REQUIRED",
  );

  readyAllForNextRound(rooms, sessions);
  const next = rooms.startNextRound(started.roomCode, sessions[0]!.playerToken);
  assert.equal(next.game?.roundNumber, 2);
  assert.equal(next.game?.dealerSeat, 0);
  assert.equal(next.game?.turnSeat, 0);
  assert.deepEqual(next.scoreTotals, [196, 68, 68, 68]);
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
  assert.deepEqual(ended.scoreTotals, [68, 148, 92, 92]);

  readyAllForNextRound(rooms, sessions);
  const next = rooms.startNextRound(started.roomCode, sessions[0]!.playerToken);
  assert.equal(next.game?.roundNumber, 2);
  assert.equal(next.game?.dealerSeat, 1);
  assert.equal(next.game?.turnSeat, 1);
  assert.deepEqual(next.scoreTotals, [68, 148, 92, 92]);
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
    if (round < 8) {
      readyAllForNextRound(rooms, sessions);
      snapshot = rooms.startNextRound(snapshot.roomCode, sessions[0]!.playerToken);
    }
  }

  assert.equal(snapshot.match.status, "completed");
  assert.equal(snapshot.match.endReason, "round_limit");
  assert.deepEqual(snapshot.match.rankings, [
    { seat: 0, score: 100, rank: 1 },
    { seat: 1, score: 100, rank: 1 },
    { seat: 2, score: 100, rank: 1 },
    { seat: 3, score: 100, rank: 1 },
  ]);
  assert.equal(snapshot.match.roundHistory.length, 8);
  assert.deepEqual(snapshot.match.roundHistory[0], {
    roundNumber: 1,
    dealerSeat: 0,
    reason: "wall_exhausted",
    winnerSeats: [],
    scoreDeltas: [0, 0, 0, 0],
    scoreTotals: [100, 100, 100, 100],
  });
  assert.throws(
    () => rooms.startNextRound(snapshot.roomCode, sessions[0]!.playerToken),
    (error) => error instanceof RoomError && error.code === "MATCH_ENDED",
  );
});

test("16局模式在局末出现负分时提前结束并生成并列排名", () => {
  const rooms = new RoomManager(() => 0, () => createSelfDrawGame());
  const sessions = [rooms.createRoom("东", 16, 100)];
  sessions.push(rooms.joinRoom(sessions[0]!.roomCode, "南"));
  sessions.push(rooms.joinRoom(sessions[0]!.roomCode, "西"));
  sessions.push(rooms.joinRoom(sessions[0]!.roomCode, "北"));
  for (const session of sessions) rooms.setReady(session.roomCode, session.playerToken, true);
  let snapshot = rooms.startGame(sessions[0]!.roomCode, sessions[0]!.playerToken);

  for (let round = 1; snapshot.match.status !== "completed"; round += 1) {
    snapshot = rooms.performTurnOperation(snapshot.roomCode, sessions[0]!.playerToken, "zimo").snapshot;
    if (snapshot.match.status !== "completed") {
      readyAllForNextRound(rooms, sessions);
      snapshot = rooms.startNextRound(snapshot.roomCode, sessions[0]!.playerToken);
    }
  }

  assert.equal(snapshot.match.status, "completed");
  assert.equal(snapshot.match.completedRounds, 4);
  assert.equal(snapshot.match.endReason, "negative_score");
  assert.deepEqual(snapshot.scoreTotals, [484, -28, -28, -28]);
  assert.deepEqual(snapshot.match.rankings, [
    { seat: 0, score: 484, rank: 1 },
    { seat: 1, score: -28, rank: 2 },
    { seat: 2, score: -28, rank: 2 },
    { seat: 3, score: -28, rank: 2 },
  ]);
  assert.equal(snapshot.match.roundHistory.length, 4);
  assert.deepEqual(snapshot.match.roundHistory.at(-1)?.scoreTotals, [484, -28, -28, -28]);
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
  const ended = rooms.discardTile(started.roomCode, sessions[0]!.playerToken, "wan-1").snapshot;
  return { rooms, sessions, ended };
}

test("本局结束后全员准备才能开始下一局", () => {
  const { rooms, sessions, ended } = startEarlySettlementRoom();
  assert.throws(
    () => rooms.startNextRound(ended.roomCode, sessions[0]!.playerToken),
    (error) => error instanceof RoomError && error.code === "READY_REQUIRED",
  );
  readyAllForNextRound(rooms, sessions);
  const next = rooms.startNextRound(ended.roomCode, sessions[0]!.playerToken);
  assert.equal(next.game?.roundNumber, 2);
});

test("提前结算投票可以拒绝且拒绝后正常开始下一局", () => {
  const { rooms, sessions, ended } = startEarlySettlementRoom();
  const requested = rooms.requestEarlySettlement(ended.roomCode, sessions[1]!.playerToken).snapshot;
  assert.deepEqual(requested.match.earlySettlement, {
    requesterSeat: 1,
    duringRound: false,
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
  readyAllForNextRound(rooms, sessions);
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
    { seat: 0, score: 100, rank: 1 },
    { seat: 1, score: 100, rank: 1 },
    { seat: 2, score: 100, rank: 1 },
    { seat: 3, score: 100, rank: 1 },
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
  assert.deepEqual(result.snapshot.scoreTotals, [112, 96, 96, 96]);
  assert.deepEqual(result.snapshot.game?.melds, [{
    seat: 0,
    kind: "gang",
    gangType: "an",
    tiles: [],
    fromSeat: 0,
    hiddenTileCount: 4,
  }]);
  const publicAngang = result.snapshot.publicActions.find((action) => action.kind === "an_gang");
  assert.equal(publicAngang?.seat, 0);
  assert.equal(publicAngang?.tile, undefined);
  assert.equal(JSON.stringify(result.snapshot.publicActions).includes("wan-1"), false);
  const ownerView = rooms.snapshotForPlayer(started.roomCode, sessions[0]!.playerToken);
  assert.deepEqual(ownerView.game?.melds[0]?.tiles, ["wan-1", "wan-1", "wan-1", "wan-1"]);
  assert.equal(ownerView.game?.melds[0]?.hiddenTileCount, undefined);
  assert.ok(ownerView.game?.selfDrawnTile);
});

test("局中解散必须四人一致且保留已结算杠分但不计未完成局", () => {
  const { rooms, sessions, started } = startCustomGame(createConcealedGangGame);
  const view = rooms.snapshotForPlayer(started.roomCode, sessions[0]!.playerToken);
  const angang = view.game!.availableTurnOperations!.find((option) => option.kind === "angang")!;
  const afterGang = rooms.performTurnOperation(started.roomCode, sessions[0]!.playerToken, angang.id).snapshot;
  assert.deepEqual(afterGang.scoreTotals, [112, 96, 96, 96]);

  const requested = rooms.requestEarlySettlement(started.roomCode, sessions[1]!.playerToken).snapshot;
  assert.equal(requested.match.earlySettlement?.duringRound, true);
  assert.equal(requested.game?.actionDeadlineAt, undefined);
  assert.throws(
    () => rooms.discardTile(started.roomCode, sessions[0]!.playerToken, requested.game!.selfHand?.[0] ?? "wan-1"),
    (error) => error instanceof RoomError && error.code === "EARLY_SETTLEMENT_PENDING",
  );
  rooms.respondEarlySettlement(started.roomCode, sessions[0]!.playerToken, true);
  rooms.respondEarlySettlement(started.roomCode, sessions[2]!.playerToken, true);
  const approved = rooms.respondEarlySettlement(started.roomCode, sessions[3]!.playerToken, true).snapshot;

  assert.equal(approved.match.status, "completed");
  assert.equal(approved.match.endReason, "early_agreement");
  assert.equal(approved.match.completedRounds, 0);
  assert.deepEqual(approved.match.roundHistory, []);
  assert.equal(approved.game?.roundResult?.reason, "dissolved");
  assert.deepEqual(approved.game?.roundResult?.scoreDeltas, [12, -4, -4, -4]);
  assert.deepEqual(approved.scoreTotals, [112, 96, 96, 96]);
  assert.equal(approved.publicActions.at(-1)?.kind, "round_dissolved");
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
  assert.deepEqual(secondGrowth.snapshot.scoreTotals, [112, 96, 96, 96]);
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

test("等待房间玩家可以退出并释放原座位", () => {
  const rooms = new RoomManager();
  const host = rooms.createRoom("房主");
  const second = rooms.joinRoom(host.roomCode, "玩家二");

  const result = rooms.leaveRoom(host.roomCode, second.playerToken);

  assert.equal(result.deleted, false);
  assert.equal(result.snapshot?.players.length, 1);
  assert.throws(
    () => rooms.reconnect(host.roomCode, second.playerToken),
    (error) => error instanceof RoomError && error.code === "TOKEN_INVALID",
  );
  const replacement = rooms.joinRoom(host.roomCode, "替补玩家");
  assert.equal(replacement.snapshot.players.find((player) => player.id === replacement.playerId)?.seat, 1);
});

test("房主退出会转移房主且没有真人时删除房间", () => {
  const rooms = new RoomManager();
  const host = rooms.createRoom("原房主");
  const second = rooms.joinRoom(host.roomCode, "新房主");
  rooms.fillWithTestPlayers(host.roomCode, host.playerToken);

  const transferred = rooms.leaveRoom(host.roomCode, host.playerToken);

  assert.equal(transferred.wasHost, true);
  assert.equal(transferred.nextHostPlayerId, second.playerId);
  assert.equal(transferred.snapshot?.players.find((player) => player.id === second.playerId)?.isHost, true);

  const solo = rooms.createRoom("单人房主");
  rooms.fillWithTestPlayers(solo.roomCode, solo.playerToken);
  assert.equal(rooms.leaveRoom(solo.roomCode, solo.playerToken).deleted, true);
  assert.throws(
    () => rooms.snapshot(solo.roomCode),
    (error) => error instanceof RoomError && error.code === "ROOM_NOT_FOUND",
  );
});

test("房主可撤销测试玩家且离线真人不能开局", () => {
  const rooms = new RoomManager();
  const host = rooms.createRoom("房主");
  const second = rooms.joinRoom(host.roomCode, "玩家二");
  rooms.fillWithTestPlayers(host.roomCode, host.playerToken);

  const removed = rooms.removeTestPlayers(host.roomCode, host.playerToken);
  assert.equal(removed.removedCount, 2);
  assert.equal(removed.snapshot.players.length, 2);

  const third = rooms.joinRoom(host.roomCode, "玩家三");
  const fourth = rooms.joinRoom(host.roomCode, "玩家四");
  for (const session of [host, second, third, fourth]) rooms.setReady(host.roomCode, session.playerToken, true);
  rooms.disconnect(host.roomCode, fourth.playerToken);
  assert.throws(
    () => rooms.startGame(host.roomCode, host.playerToken),
    (error) => error instanceof RoomError && error.code === "CONNECTED_PLAYERS_REQUIRED",
  );
  rooms.reconnect(host.roomCode, fourth.playerToken);
  assert.equal(rooms.startGame(host.roomCode, host.playerToken).phase, "playing");
});

test("公开操作时间线记录开局出牌且所有玩家视图一致", () => {
  const { rooms, sessions, started } = createDeterministicFourPlayerGame();
  assert.deepEqual(started.publicActions, [{ sequence: 1, roundNumber: 1, kind: "round_started", seat: 0, seats: undefined }]);

  rooms.discardTile(started.roomCode, sessions[0]!.playerToken, "wan-1");
  const hostView = rooms.snapshotForPlayer(started.roomCode, sessions[0]!.playerToken);
  const secondView = rooms.snapshotForPlayer(started.roomCode, sessions[1]!.playerToken);

  assert.deepEqual(hostView.publicActions, secondView.publicActions);
  assert.deepEqual(hostView.publicActions.at(-1), {
    sequence: 2,
    roundNumber: 1,
    kind: "discard",
    seat: 0,
    tile: "wan-1",
    seats: undefined,
  });
  assert.equal(JSON.stringify(hostView.publicActions).includes("playerToken"), false);
  assert.equal(JSON.stringify(hostView.publicActions).includes("selfHand"), false);
});

test("公开操作时间线在断线重连后保留并记录连接变化", () => {
  const rooms = new RoomManager();
  const host = rooms.createRoom("房主");
  rooms.fillWithTestPlayers(host.roomCode, host.playerToken);
  rooms.setReady(host.roomCode, host.playerToken, true);
  rooms.startGame(host.roomCode, host.playerToken);

  rooms.disconnect(host.roomCode, host.playerToken);
  const restored = rooms.reconnect(host.roomCode, host.playerToken);

  assert.deepEqual(restored.snapshot.publicActions.map((action) => action.kind), [
    "round_started",
    "player_disconnected",
    "player_reconnected",
  ]);
  assert.deepEqual(restored.snapshot.publicActions.map((action) => action.sequence), [1, 2, 3]);
});

test("胡牌和本局结束写入公共操作时间线", () => {
  const { rooms, sessions, started } = startCustomGame(createDiscardHuGame);
  rooms.discardTile(started.roomCode, sessions[0]!.playerToken, "east");
  const hu = rooms.snapshotForPlayer(started.roomCode, sessions[1]!.playerToken).game!.availableOperations!.find(
    (option) => option.kind === "hu",
  )!;
  const result = rooms.reactToDiscard(started.roomCode, sessions[1]!.playerToken, hu.id);

  assert.deepEqual(result.snapshot.publicActions.map((action) => action.kind), [
    "round_started",
    "discard",
    "discard_hu",
    "round_ended",
  ]);
  assert.deepEqual(result.snapshot.publicActions.at(-2)?.seats, [1]);
  assert.equal(result.snapshot.publicActions.at(-2)?.fromSeat, 0);
  assert.equal(result.snapshot.publicActions.at(-2)?.tile, "east");
});

test("房间序列化后可恢复完整牌局、待响应状态和私密身份", () => {
  const { rooms, sessions, started } = startCustomGame(createDiscardHuGame);
  rooms.discardTile(started.roomCode, sessions[0]!.playerToken, "east");
  const envelope = rooms.exportPersistedState();
  const restoredRooms = new RoomManager();
  const restored = restoredRooms.restorePersistedState(envelope);
  assert.equal(restored.restoredCount, 1);
  assert.equal(restored.skipped.length, 0);
  const view = restoredRooms.snapshotForPlayer(started.roomCode, sessions[1]!.playerToken);
  assert.equal(view.game?.stage, "awaiting_reactions");
  assert.equal(view.game?.handTileCounts.reduce((sum, count) => sum + count, 0), 52);
  assert.equal(view.game?.wallRemaining, 83);
  assert.ok(view.game?.availableOperations?.some((option) => option.kind === "hu"));
  const closed = restoredRooms.forceCloseRoomByAdmin(started.roomCode, "测试强制解散");
  assert.equal(closed.playerSeats.length, 4);
});

test("版本不匹配的持久化数据会被拒绝恢复", () => {
  const rooms = new RoomManager();
  rooms.createRoom("旧房主");
  const envelope = rooms.exportPersistedState() as { gameModelVersion: string };
  envelope.gameModelVersion = "legacy-v1";
  assert.throws(
    () => new RoomManager().restorePersistedState(envelope),
    (error) => error instanceof RoomError && error.code === "PERSISTENCE_VERSION_MISMATCH",
  );
});
