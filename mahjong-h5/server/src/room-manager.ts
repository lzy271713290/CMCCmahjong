import { randomInt, randomUUID } from "node:crypto";
import type { DiscardView, MeldView, ReactionOption, RoomSnapshot, ScorePaymentView, TileCode, TurnOperationOption } from "../../shared/protocol.js";
import {
  analyzeWinningHand,
  createInitialGame,
  drawTileFromWall,
  drawTileFromWallEnd,
  findDiscardReactionOptions,
  findTurnOperationOptions,
  selectReactionClaims,
  sortTiles,
  type InitialGameState,
  type Tile,
} from "./game-model.js";
import { calculateHuPayments, calculateKongPayments, calculateScoreDeltas } from "./scoring.js";

type Player = {
  id: string;
  token: string;
  name: string;
  seat: number;
  ready: boolean;
  connected: boolean;
  isTestPlayer: boolean;
};

type Room = {
  code: string;
  revision: number;
  phase: "waiting" | "playing";
  hostPlayerId: string;
  players: Player[];
  scoreTotals: number[];
  game?: InitialGameState;
};

export type Session = {
  roomCode: string;
  playerId: string;
  playerToken: string;
  snapshot: RoomSnapshot;
};

export type TurnProgress = {
  snapshot: RoomSnapshot;
  diagnostics: {
    initialDiscard: { seat: number; tile: TileCode; handTileCount: number };
    autoDiscards: Array<{ seat: number; tile: TileCode; wallRemaining: number }>;
    reactionWindows: ReactionWindowDiagnostic[];
    nextTurnSeat?: number;
    wallRemaining: number;
    nextHandTileCount?: number;
    stage: NonNullable<RoomSnapshot["game"]>["stage"];
  };
};

export type ReactionProgress = {
  snapshot: RoomSnapshot;
  diagnostics: {
    responderSeat: number;
    operationId: string | "pass";
    resolution:
      | "waiting"
      | "all_passed"
      | "meld_claimed"
      | "discard_hu"
      | "rob_kong_hu"
      | "added_gang_completed"
      | "special_gang_completed"
      | "zhangmao_completed";
    winningSeats: number[];
    scorePayments: ScorePaymentView[];
    claimedMeld?: MeldView;
    autoDiscards: Array<{ seat: number; tile: TileCode; wallRemaining: number }>;
    reactionWindows: ReactionWindowDiagnostic[];
    nextTurnSeat?: number;
    wallRemaining: number;
    stage: NonNullable<RoomSnapshot["game"]>["stage"];
  };
};

export type TurnOperationProgress = {
  snapshot: RoomSnapshot;
  diagnostics: {
    seat: number;
    operation: TurnOperationOption["kind"];
    tile?: TileCode;
    meld?: MeldView;
    reactionWindow?: ReactionWindowDiagnostic;
    scorePayments: ScorePaymentView[];
    wallRemaining: number;
    stage: NonNullable<RoomSnapshot["game"]>["stage"];
  };
};

type ReactionWindowDiagnostic = {
  discard: DiscardView;
  eligibleSeats: number[];
  optionCount: number;
  autoPassedSeats: number[];
  awaitingSeats: number[];
  resolution: "awaiting_players" | "advance_turn";
};

type AutomaticProgress = {
  autoDiscards: Array<{ seat: number; tile: TileCode; wallRemaining: number }>;
  reactionWindows: ReactionWindowDiagnostic[];
};

export class RoomError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();

  constructor(
    private readonly gameRandomIndex: (maxExclusive: number) => number = randomInt,
    private readonly gameFactory: typeof createInitialGame = createInitialGame,
  ) {}

  createRoom(rawName: string): Session {
    const name = this.normalizeName(rawName);
    const code = this.createCode();
    const player = this.createPlayer(name, 0);
    const room: Room = {
      code,
      revision: 1,
      phase: "waiting",
      hostPlayerId: player.id,
      players: [player],
      scoreTotals: [200, 200, 200, 200],
    };
    this.rooms.set(code, room);
    return this.toSession(room, player);
  }

  joinRoom(rawCode: string, rawName: string): Session {
    const room = this.getRoom(rawCode);
    if (room.phase !== "waiting") throw new RoomError("GAME_STARTED", "本局已经开始，暂时不能加入");
    if (room.players.length >= 4) {
      throw new RoomError("ROOM_FULL", "房间已经坐满 4 人");
    }
    const name = this.normalizeName(rawName);
    const occupied = new Set(room.players.map((player) => player.seat));
    const seat = [0, 1, 2, 3].find((candidate) => !occupied.has(candidate));
    if (seat === undefined) throw new RoomError("ROOM_FULL", "房间已经坐满 4 人");
    const player = this.createPlayer(name, seat);
    room.players.push(player);
    room.revision += 1;
    return this.toSession(room, player);
  }

  reconnect(rawCode: string, playerToken: string): Session {
    const room = this.getRoom(rawCode);
    const player = room.players.find((candidate) => candidate.token === playerToken);
    if (!player) throw new RoomError("TOKEN_INVALID", "原座位已失效，请重新加入");
    if (!player.connected) {
      player.connected = true;
      room.revision += 1;
    }
    return this.toSession(room, player);
  }

  disconnect(rawCode: string, playerToken: string): void {
    const room = this.rooms.get(this.normalizeCode(rawCode));
    const player = room?.players.find((candidate) => candidate.token === playerToken);
    if (room && player?.connected) {
      player.connected = false;
      room.revision += 1;
    }
  }

  setReady(rawCode: string, playerToken: string, ready: boolean): RoomSnapshot {
    const room = this.getRoom(rawCode);
    if (room.phase !== "waiting") throw new RoomError("GAME_STARTED", "本局已经开始");
    const player = room.players.find((candidate) => candidate.token === playerToken);
    if (!player) throw new RoomError("TOKEN_INVALID", "玩家身份已失效");
    if (player.ready !== ready) {
      player.ready = ready;
      room.revision += 1;
    }
    return this.snapshot(room.code);
  }

  fillWithTestPlayers(rawCode: string, playerToken: string): RoomSnapshot {
    const room = this.getRoom(rawCode);
    if (room.phase !== "waiting") throw new RoomError("GAME_STARTED", "本局已经开始");
    const operator = room.players.find((candidate) => candidate.token === playerToken);
    if (!operator) throw new RoomError("TOKEN_INVALID", "玩家身份已失效");
    if (operator.id !== room.hostPlayerId) throw new RoomError("HOST_REQUIRED", "只有房主可以添加测试玩家");
    let testNumber = room.players.filter((player) => player.isTestPlayer).length + 1;
    while (room.players.length < 4) {
      const occupied = new Set(room.players.map((player) => player.seat));
      const seat = [0, 1, 2, 3].find((candidate) => !occupied.has(candidate));
      if (seat === undefined) break;
      const player = this.createPlayer(`测试玩家${testNumber}`, seat, true);
      player.ready = true;
      room.players.push(player);
      testNumber += 1;
    }
    room.revision += 1;
    return this.snapshot(room.code);
  }

  startGame(rawCode: string, playerToken: string): RoomSnapshot {
    const room = this.getRoom(rawCode);
    const operator = room.players.find((candidate) => candidate.token === playerToken);
    if (!operator) throw new RoomError("TOKEN_INVALID", "玩家身份已失效");
    if (operator.id !== room.hostPlayerId) throw new RoomError("HOST_REQUIRED", "只有房主可以开始游戏");
    if (room.phase !== "waiting") throw new RoomError("GAME_STARTED", "本局已经开始");
    if (room.players.length !== 4) throw new RoomError("PLAYERS_REQUIRED", "需要四名玩家才能开始");
    if (!room.players.every((player) => player.ready)) throw new RoomError("READY_REQUIRED", "需要所有玩家准备后才能开始");
    const hasTestPlayers = room.players.some((player) => player.isTestPlayer);
    const dealerCandidates = hasTestPlayers ? room.players.filter((player) => !player.isTestPlayer) : room.players;
    const dealerSeat = dealerCandidates[this.gameRandomIndex(dealerCandidates.length)]!.seat;
    room.game = this.gameFactory(
      room.players.map((player) => player.seat),
      dealerSeat,
      this.gameRandomIndex,
    );
    room.phase = "playing";
    room.revision += 1;
    return this.snapshot(room.code);
  }

  startNextRound(rawCode: string, playerToken: string): RoomSnapshot {
    const room = this.getRoom(rawCode);
    const operator = room.players.find((candidate) => candidate.token === playerToken);
    if (!operator) throw new RoomError("TOKEN_INVALID", "玩家身份已失效");
    if (operator.id !== room.hostPlayerId) throw new RoomError("HOST_REQUIRED", "只有房主可以开始下一局");
    if (room.phase !== "playing" || !room.game) throw new RoomError("GAME_NOT_STARTED", "牌局尚未开始");
    if (room.game.stage !== "round_ended" || !room.game.roundResult) throw new RoomError("ROUND_ACTIVE", "本局尚未结束");

    const previous = room.game;
    const previousResult = previous.roundResult;
    if (!previousResult) throw new RoomError("ROUND_ACTIVE", "本局尚未结束");
    const dealerContinues = previousResult.reason === "wall_exhausted"
      || previousResult.winnerSeats.includes(previous.dealerSeat);
    const nextDealerSeat = dealerContinues ? previous.dealerSeat : (previous.dealerSeat + 1) % 4;
    const nextRoundNumber = previous.roundNumber + 1;
    const nextGame = this.gameFactory(
      room.players.map((player) => player.seat),
      nextDealerSeat,
      this.gameRandomIndex,
      nextRoundNumber,
    );
    nextGame.roundNumber = nextRoundNumber;
    room.game = nextGame;
    room.revision += 1;
    return this.snapshot(room.code);
  }

  discardTile(rawCode: string, playerToken: string, tileCode: TileCode): TurnProgress {
    const room = this.getRoom(rawCode);
    const player = room.players.find((candidate) => candidate.token === playerToken);
    if (!player) throw new RoomError("TOKEN_INVALID", "玩家身份已失效");
    if (room.phase !== "playing" || !room.game) throw new RoomError("GAME_REQUIRED", "牌局尚未开始");
    if (room.game.stage === "round_ended") throw new RoomError("ROUND_ENDED", "本局已经结束");
    if (room.game.stage !== "awaiting_discard") throw new RoomError("REACTIONS_PENDING", "请等待其他玩家响应当前弃牌");
    if (room.game.turnSeat !== player.seat) throw new RoomError("TURN_REQUIRED", "还没有轮到你出牌");
    const hand = room.game.hands.get(player.seat);
    const tileIndex = hand?.findIndex((tile) => tile.code === tileCode) ?? -1;
    if (!hand || tileIndex < 0) throw new RoomError("TILE_NOT_IN_HAND", "你的手牌中没有这张牌");

    hand.splice(tileIndex, 1);
    const initialHandTileCount = hand.length;
    room.game.discards.push({ seat: player.seat, tile: tileCode });
    room.game.stage = "awaiting_reactions";
    room.game.lastDraw = undefined;
    const progress: AutomaticProgress = { autoDiscards: [], reactionWindows: [] };
    this.progressFromDiscard(room, { seat: player.seat, tile: tileCode }, progress);

    room.revision += 1;
    const nextTurnSeat = room.game.lastDraw ? room.game.turnSeat : undefined;
    return {
      snapshot: this.snapshot(room.code),
      diagnostics: {
        initialDiscard: { seat: player.seat, tile: tileCode, handTileCount: initialHandTileCount },
        autoDiscards: progress.autoDiscards,
        reactionWindows: progress.reactionWindows,
        nextTurnSeat,
        wallRemaining: room.game.wall.length,
        nextHandTileCount: nextTurnSeat === undefined ? undefined : room.game.hands.get(nextTurnSeat)?.length,
        stage: room.game.stage,
      },
    };
  }

  performTurnOperation(rawCode: string, playerToken: string, operationId: string): TurnOperationProgress {
    const room = this.getRoom(rawCode);
    const player = room.players.find((candidate) => candidate.token === playerToken);
    if (!player) throw new RoomError("TOKEN_INVALID", "玩家身份已失效");
    const game = room.game;
    if (room.phase !== "playing" || !game) throw new RoomError("GAME_REQUIRED", "牌局尚未开始");
    if (game.stage === "round_ended") throw new RoomError("ROUND_ENDED", "本局已经结束");
    if (game.stage !== "awaiting_discard" || game.turnSeat !== player.seat) {
      throw new RoomError("TURN_OPERATION_NOT_AVAILABLE", "当前不能执行这个回合操作");
    }
    const hand = game.hands.get(player.seat);
    const melds = game.melds.get(player.seat);
    if (!hand || !melds) throw new Error("当前玩家牌组不存在");
    const scorePaymentStart = game.scorePayments.length;
    const option = findTurnOperationOptions(hand, player.seat, melds, game.lastDraw, game.wall.length).find(
      (candidate) => candidate.id === operationId,
    );
    if (!option) throw new RoomError("TURN_OPERATION_INVALID", "这个操作不在当前可选范围内");

    let tile: TileCode | undefined;
    let meld: MeldView | undefined;
    let reactionWindow: ReactionWindowDiagnostic | undefined;
    if (option.kind === "zimo") {
      tile = game.lastDraw?.tile.code;
      const analysis = analyzeWinningHand(hand, undefined, melds);
      const settlement = calculateHuPayments({
        winnerSeats: [player.seat],
        dealerSeat: game.dealerSeat,
        reason: "self_draw_hu",
        analyses: new Map([[player.seat, analysis]]),
        meldsBySeat: game.melds,
      });
      this.recordPayments(room, settlement.payments);
      game.pendingReaction = undefined;
      game.lastDraw = undefined;
      game.stage = "round_ended";
      game.roundResult = {
        reason: "self_draw_hu",
        winnerSeats: [player.seat],
        tile,
        winnerDetails: settlement.winnerDetails,
        payments: [...game.scorePayments],
        scoreDeltas: [...game.scoreDeltas],
      };
    } else if (option.kind === "angang") {
      tile = option.tiles[0];
      if (!tile) throw new Error("暗杠牌张不存在");
      this.removeTilesFromHand(hand, option.tiles);
      meld = { seat: player.seat, kind: "gang", gangType: "an", tiles: [...option.tiles], fromSeat: player.seat };
      melds.push(meld);
      game.lastDraw = undefined;
      drawTileFromWallEnd(game, player.seat);
    } else {
      const parts = option.id.split(":");
      const meldIndex = option.kind === "jiagang" || option.kind === "zhangmao" ? Number(parts[1]) : undefined;
      const specialType = option.kind === "specialgang" ? (parts[1] as "dragons" | "winds") : undefined;
      tile = option.kind === "specialgang" && game.lastDraw?.seat === player.seat && option.tiles.includes(game.lastDraw.tile.code)
        ? game.lastDraw.tile.code
        : option.tiles[0];
      if (!tile || ((option.kind === "jiagang" || option.kind === "zhangmao") && !Number.isInteger(meldIndex))) {
        throw new Error("可抢杠操作状态不一致");
      }
      const physicalTiles = this.takeTilesFromHand(hand, option.tiles);
      const discard = { seat: player.seat, tile };
      const optionsBySeat = new Map<number, ReactionOption[]>();
      for (const candidate of room.players) {
        if (candidate.seat === player.seat) continue;
        const candidateHand = game.hands.get(candidate.seat) ?? [];
        const huOptions = findDiscardReactionOptions(
          candidateHand,
          candidate.seat,
          discard,
          game.melds.get(candidate.seat) ?? [],
          game.wall.length,
        ).filter((candidateOption) => candidateOption.kind === "hu");
        if (huOptions.length > 0) optionsBySeat.set(candidate.seat, huOptions);
      }
      const autoPassedSeats = [...optionsBySeat.keys()].filter(
        (seat) => room.players.find((candidate) => candidate.seat === seat)?.isTestPlayer,
      );
      const responses = new Map<number, string | "pass">(autoPassedSeats.map((seat) => [seat, "pass"]));
      const awaitingSeats = [...optionsBySeat.keys()].filter((seat) => !responses.has(seat));
      reactionWindow = {
        discard,
        eligibleSeats: [...optionsBySeat.keys()],
        optionCount: [...optionsBySeat.values()].reduce((sum, options) => sum + options.length, 0),
        autoPassedSeats,
        awaitingSeats,
        resolution: awaitingSeats.length > 0 ? "awaiting_players" : "advance_turn",
      };
      const pendingKong: NonNullable<NonNullable<InitialGameState["pendingReaction"]>["pendingKong"]> = {
        seat: player.seat,
        type: option.kind,
        tiles: physicalTiles,
        robTile: tile,
        meldIndex,
        specialType,
      };
      const source = option.kind === "jiagang" ? "added_gang" : option.kind === "specialgang" ? "special_gang" : "zhangmao";
      game.lastDraw = undefined;
      if (awaitingSeats.length > 0) {
        game.pendingReaction = { discard, source, pendingKong, optionsBySeat, responses };
        game.stage = "awaiting_reactions";
      } else {
        meld = this.finalizePendingKong(game, pendingKong);
      }
    }

    if (meld && option.kind !== "zimo") this.recordKongPayments(room, player.seat, option.kind);

    room.revision += 1;
    return {
      snapshot: this.snapshot(room.code),
      diagnostics: {
        seat: player.seat,
        operation: option.kind,
        tile,
        meld,
        reactionWindow,
        scorePayments: game.scorePayments.slice(scorePaymentStart),
        wallRemaining: game.wall.length,
        stage: game.stage,
      },
    };
  }

  reactToDiscard(rawCode: string, playerToken: string, operationId: string | "pass"): ReactionProgress {
    const room = this.getRoom(rawCode);
    const player = room.players.find((candidate) => candidate.token === playerToken);
    if (!player) throw new RoomError("TOKEN_INVALID", "玩家身份已失效");
    const game = room.game;
    const pending = game?.pendingReaction;
    if (room.phase !== "playing" || !game || game.stage !== "awaiting_reactions" || !pending) {
      throw new RoomError("REACTION_NOT_AVAILABLE", "当前没有等待你响应的弃牌");
    }
    const scorePaymentStart = game.scorePayments.length;
    const options = pending.optionsBySeat.get(player.seat);
    if (!options?.length) throw new RoomError("REACTION_NOT_ELIGIBLE", "你不能响应这张弃牌");
    if (pending.responses.has(player.seat)) throw new RoomError("REACTION_ALREADY_SENT", "你已经响应过这张牌");
    if (operationId !== "pass" && !options.some((option) => option.id === operationId)) {
      throw new RoomError("REACTION_INVALID", "这个操作不在当前可选范围内");
    }
    pending.responses.set(player.seat, operationId);
    const progress: AutomaticProgress = { autoDiscards: [], reactionWindows: [] };
    let resolution: ReactionProgress["diagnostics"]["resolution"] = "waiting";
    let winningSeats: number[] = [];
    let claimedMeld: MeldView | undefined;
    const waitingSeats = [...pending.optionsBySeat.keys()].filter((seat) => !pending.responses.has(seat));

    if (waitingSeats.length === 0) {
      const claims = [...pending.responses.entries()]
        .filter(([, response]) => response !== "pass")
        .map(([seat, response]) => ({
          seat,
          option: pending.optionsBySeat.get(seat)!.find((option) => option.id === response)!,
        }));
      const selectedClaims = selectReactionClaims(claims);
      const huClaims = selectedClaims.filter((claim) => claim.option.kind === "hu");
      if (huClaims.length > 0) {
        winningSeats = huClaims.map((claim) => claim.seat);
        if (pending.pendingKong) this.restoreUnrobbedKongTiles(game, pending.pendingKong);
        const roundReason = pending.source === "discard" ? "discard_hu" : "rob_kong_hu";
        const analyses = new Map(
          winningSeats.map((seat) => [
            seat,
            analyzeWinningHand(game.hands.get(seat) ?? [], pending.discard.tile, game.melds.get(seat) ?? []),
          ]),
        );
        const settlement = calculateHuPayments({
          winnerSeats: winningSeats,
          fromSeat: pending.discard.seat,
          dealerSeat: game.dealerSeat,
          reason: roundReason,
          analyses,
          meldsBySeat: game.melds,
        });
        this.recordPayments(room, settlement.payments);
        game.pendingReaction = undefined;
        game.lastDraw = undefined;
        game.stage = "round_ended";
        game.roundResult = {
          reason: roundReason,
          winnerSeats: winningSeats,
          fromSeat: pending.discard.seat,
          tile: pending.discard.tile,
          winnerDetails: settlement.winnerDetails,
          payments: [...game.scorePayments],
          scoreDeltas: [...game.scoreDeltas],
        };
        resolution = pending.source === "discard" ? "discard_hu" : "rob_kong_hu";
      } else if (selectedClaims.length > 0) {
        if (pending.source !== "discard") throw new Error("加杠响应窗口只能胡牌或过牌");
        const claim = selectedClaims[0]!;
        claimedMeld = this.applyMeldClaim(game, pending.discard, claim.seat, claim.option);
        if (claim.option.kind === "gang") this.recordKongPayments(room, claim.seat, "gang");
        resolution = "meld_claimed";
      } else if (pending.source !== "discard") {
        if (!pending.pendingKong) throw new Error("待完成的抢杠操作不存在");
        game.pendingReaction = undefined;
        claimedMeld = this.finalizePendingKong(game, pending.pendingKong);
        this.recordKongPayments(room, pending.pendingKong.seat, pending.pendingKong.type);
        resolution = pending.source === "added_gang"
          ? "added_gang_completed"
          : pending.source === "special_gang"
            ? "special_gang_completed"
            : "zhangmao_completed";
      } else {
        game.pendingReaction = undefined;
        this.progressFromDiscard(room, pending.discard, progress, true);
        resolution = "all_passed";
      }
    }

    room.revision += 1;
    const nextTurnSeat = game.pendingReaction || game.roundResult ? undefined : game.turnSeat;
    return {
      snapshot: this.snapshot(room.code),
      diagnostics: {
        responderSeat: player.seat,
        operationId,
        resolution,
        winningSeats,
        scorePayments: game.scorePayments.slice(scorePaymentStart),
        claimedMeld,
        autoDiscards: progress.autoDiscards,
        reactionWindows: progress.reactionWindows,
        nextTurnSeat,
        wallRemaining: game.wall.length,
        stage: game.stage,
      },
    };
  }

  snapshot(rawCode: string): RoomSnapshot {
    const room = this.getRoom(rawCode);
    return this.buildSnapshot(room);
  }

  snapshotForPlayer(rawCode: string, playerToken: string): RoomSnapshot {
    const room = this.getRoom(rawCode);
    const viewer = room.players.find((player) => player.token === playerToken);
    if (!viewer) throw new RoomError("TOKEN_INVALID", "玩家身份已失效");
    return this.buildSnapshot(room, viewer);
  }

  private buildSnapshot(room: Room, viewer?: Player): RoomSnapshot {
    return {
      roomCode: room.code,
      revision: room.revision,
      phase: room.phase,
      players: [...room.players]
        .sort((left, right) => left.seat - right.seat)
        .map((player) => ({
          id: player.id,
          name: player.name,
          seat: player.seat,
          ready: player.ready,
          connected: player.connected,
          isHost: player.id === room.hostPlayerId,
          isTestPlayer: player.isTestPlayer,
        })),
      scoreTotals: [...room.scoreTotals],
      game: room.game
        ? {
            modelVersion: room.game.modelVersion,
            roundNumber: room.game.roundNumber,
            dealerSeat: room.game.dealerSeat,
            turnSeat: room.game.turnSeat,
            stage: room.game.stage,
            wallRemaining: room.game.wall.length,
            handTileCounts: [0, 1, 2, 3].map((seat) => room.game?.hands.get(seat)?.length ?? 0),
            viewerSeat: viewer?.seat,
            selfHand: viewer ? sortTiles(room.game.hands.get(viewer.seat) ?? []).map((tile) => tile.code) : undefined,
            selfDrawnTile: viewer && room.game.lastDraw?.seat === viewer.seat ? room.game.lastDraw.tile.code : undefined,
            latestDiscard: room.game.discards.at(-1),
            discards: [...room.game.discards],
            melds: [...room.game.melds.values()].flat().map((meld) =>
              meld.gangType === "an" && viewer?.seat !== meld.seat
                ? { ...meld, tiles: [], hiddenTileCount: meld.tiles.length }
                : { ...meld },
            ),
            scorePayments: [...room.game.scorePayments],
            scoreDeltas: [...room.game.scoreDeltas],
            reaction: room.game.pendingReaction
              ? {
                  discard: room.game.pendingReaction.discard,
                  source: room.game.pendingReaction.source,
                  waitingCount: [...room.game.pendingReaction.optionsBySeat.keys()].filter(
                    (seat) => !room.game?.pendingReaction?.responses.has(seat),
                  ).length,
                  respondedCount: room.game.pendingReaction.responses.size,
                }
              : undefined,
            availableOperations:
              viewer && room.game.pendingReaction && !room.game.pendingReaction.responses.has(viewer.seat)
                ? room.game.pendingReaction.optionsBySeat.get(viewer.seat)
                : undefined,
            availableTurnOperations:
              viewer && room.game.stage === "awaiting_discard" && room.game.turnSeat === viewer.seat
                ? findTurnOperationOptions(
                    room.game.hands.get(viewer.seat) ?? [],
                    viewer.seat,
                    room.game.melds.get(viewer.seat) ?? [],
                    room.game.lastDraw,
                    room.game.wall.length,
                  )
                : undefined,
            roundResult: room.game.roundResult
              ? {
                  ...room.game.roundResult,
                  payments: room.game.roundResult.payments ?? [...room.game.scorePayments],
                  scoreDeltas: room.game.roundResult.scoreDeltas ?? [...room.game.scoreDeltas],
                }
              : undefined,
          }
        : undefined,
    };
  }

  private progressFromDiscard(
    room: Room,
    initialDiscard: DiscardView,
    progress: AutomaticProgress,
    initialReactionResolved = false,
  ): void {
    const game = room.game;
    if (!game) throw new Error("牌局状态不存在");
    let discard = initialDiscard;
    let reactionResolved = initialReactionResolved;

    while (true) {
      if (!reactionResolved) {
        const optionsBySeat = new Map<number, ReactionOption[]>();
        for (const candidate of room.players) {
          if (candidate.seat === discard.seat) continue;
          const hand = game.hands.get(candidate.seat) ?? [];
          const options = findDiscardReactionOptions(hand, candidate.seat, discard, game.melds.get(candidate.seat) ?? [], game.wall.length);
          if (options.length > 0) optionsBySeat.set(candidate.seat, options);
        }
        const autoPassedSeats = [...optionsBySeat.keys()].filter(
          (seat) => room.players.find((player) => player.seat === seat)?.isTestPlayer,
        );
        const responses = new Map<number, string | "pass">(autoPassedSeats.map((seat) => [seat, "pass"]));
        const awaitingSeats = [...optionsBySeat.keys()].filter((seat) => !responses.has(seat));
        progress.reactionWindows.push({
          discard,
          eligibleSeats: [...optionsBySeat.keys()],
          optionCount: [...optionsBySeat.values()].reduce((sum, options) => sum + options.length, 0),
          autoPassedSeats,
          awaitingSeats,
          resolution: awaitingSeats.length > 0 ? "awaiting_players" : "advance_turn",
        });

        if (awaitingSeats.length > 0) {
          game.pendingReaction = { discard, source: "discard", optionsBySeat, responses };
          game.stage = "awaiting_reactions";
          game.lastDraw = undefined;
          return;
        }
      }

      game.pendingReaction = undefined;
      const nextSeat = (discard.seat + 1) % 4;
      const drawnTile = drawTileFromWall(game, nextSeat);
      if (!drawnTile) return;
      const nextPlayer = room.players.find((candidate) => candidate.seat === nextSeat);
      if (!nextPlayer) throw new Error("下一回合玩家不存在");
      if (!nextPlayer.isTestPlayer) return;

      const testHand = game.hands.get(nextSeat);
      const automaticTile = testHand?.pop();
      if (!automaticTile) throw new Error("测试玩家没有可出的手牌");
      discard = { seat: nextSeat, tile: automaticTile.code };
      game.discards.push(discard);
      game.stage = "awaiting_reactions";
      game.lastDraw = undefined;
      progress.autoDiscards.push({ seat: nextSeat, tile: automaticTile.code, wallRemaining: game.wall.length });
      reactionResolved = false;
    }
  }

  private applyMeldClaim(game: InitialGameState, discard: DiscardView, seat: number, option: ReactionOption): MeldView {
    const hand = game.hands.get(seat);
    if (!hand) throw new Error("操作玩家手牌不存在");
    for (const code of option.consumeTiles) {
      const index = hand.findIndex((tile) => tile.code === code);
      if (index < 0) throw new Error("操作所需手牌不存在");
      hand.splice(index, 1);
    }
    const latestDiscard = game.discards.at(-1);
    if (!latestDiscard || latestDiscard.seat !== discard.seat || latestDiscard.tile !== discard.tile) {
      throw new Error("待响应弃牌与牌桌状态不一致");
    }
    game.discards.pop();
    const meld: MeldView = {
      seat,
      kind: option.kind as MeldView["kind"],
      tiles: option.displayTiles,
      fromSeat: discard.seat,
      ...(option.kind === "gang" ? { gangType: "ming" as const } : {}),
    };
    game.melds.get(seat)?.push(meld);
    game.pendingReaction = undefined;
    game.lastDraw = undefined;
    game.turnSeat = seat;
    if (option.kind === "gang") drawTileFromWallEnd(game, seat);
    else game.stage = "awaiting_discard";
    return meld;
  }

  private finalizePendingKong(
    game: InitialGameState,
    pendingKong: NonNullable<NonNullable<InitialGameState["pendingReaction"]>["pendingKong"]>,
  ): MeldView {
    const playerMelds = game.melds.get(pendingKong.seat);
    if (!playerMelds) throw new Error("杠牌玩家的副露不存在");
    let meld: MeldView;
    if (pendingKong.type === "jiagang") {
      const original = playerMelds[pendingKong.meldIndex ?? -1];
      const tile = pendingKong.tiles[0];
      if (!original || original.kind !== "peng" || !tile || original.tiles[0] !== tile.code) throw new Error("原碰牌组与加杠状态不一致");
      original.kind = "gang";
      original.gangType = "jia";
      original.tiles = [...original.tiles, tile.code];
      meld = original;
    } else if (pendingKong.type === "specialgang") {
      if (!pendingKong.specialType) throw new Error("特殊杠类型不存在");
      meld = {
        seat: pendingKong.seat,
        kind: "special_gang",
        tiles: pendingKong.tiles.map((tile) => tile.code),
        fromSeat: pendingKong.seat,
        specialType: pendingKong.specialType,
        growthCount: 0,
      };
      playerMelds.push(meld);
    } else {
      const original = playerMelds[pendingKong.meldIndex ?? -1];
      const tile = pendingKong.tiles[0];
      if (!original || original.kind !== "special_gang" || !original.specialType || !tile) throw new Error("原特殊杠与涨毛状态不一致");
      original.tiles = [...original.tiles, tile.code];
      original.growthCount = (original.growthCount ?? 0) + 1;
      meld = original;
    }
    game.pendingReaction = undefined;
    game.lastDraw = undefined;
    game.turnSeat = pendingKong.seat;
    drawTileFromWallEnd(game, pendingKong.seat);
    return meld;
  }

  private restoreUnrobbedKongTiles(
    game: InitialGameState,
    pendingKong: NonNullable<NonNullable<InitialGameState["pendingReaction"]>["pendingKong"]>,
  ): void {
    const hand = game.hands.get(pendingKong.seat);
    if (!hand) throw new Error("被抢杠玩家手牌不存在");
    let robbedTileRemoved = false;
    for (const tile of pendingKong.tiles) {
      if (!robbedTileRemoved && tile.code === pendingKong.robTile) {
        robbedTileRemoved = true;
        continue;
      }
      hand.push(tile);
    }
    if (!robbedTileRemoved) throw new Error("抢杠牌不在待确认牌组中");
  }

  private removeTilesFromHand(hand: Tile[], codes: readonly TileCode[]): void {
    this.takeTilesFromHand(hand, codes);
  }

  private takeTilesFromHand(hand: Tile[], codes: readonly TileCode[]): Tile[] {
    const remaining = [...hand];
    const taken: Tile[] = [];
    for (const code of codes) {
      const index = remaining.findIndex((tile) => tile.code === code);
      if (index < 0) throw new Error("操作所需手牌不存在");
      taken.push(remaining.splice(index, 1)[0]!);
    }
    hand.splice(0, hand.length, ...remaining);
    return taken;
  }

  private recordKongPayments(
    room: Room,
    seat: number,
    operation: "gang" | "angang" | "jiagang" | "specialgang" | "zhangmao",
  ): void {
    const reason = operation === "gang"
      ? "ming_gang"
      : operation === "angang"
        ? "an_gang"
        : operation === "jiagang"
          ? "jia_gang"
          : operation === "specialgang"
            ? "special_gang"
            : "zhangmao";
    this.recordPayments(room, calculateKongPayments(seat, reason));
  }

  private recordPayments(room: Room, payments: readonly ScorePaymentView[]): void {
    const game = room.game;
    if (!game) throw new Error("计分时牌局状态不存在");
    const deltas = calculateScoreDeltas(payments);
    game.scorePayments.push(...payments);
    for (let seat = 0; seat < 4; seat += 1) {
      game.scoreDeltas[seat] = (game.scoreDeltas[seat] ?? 0) + (deltas[seat] ?? 0);
      room.scoreTotals[seat] = (room.scoreTotals[seat] ?? 200) + (deltas[seat] ?? 0);
    }
  }

  private getRoom(rawCode: string): Room {
    const code = this.normalizeCode(rawCode);
    const room = this.rooms.get(code);
    if (!room) throw new RoomError("ROOM_NOT_FOUND", "没有找到这个房间");
    return room;
  }

  private toSession(room: Room, player: Player): Session {
    return {
      roomCode: room.code,
      playerId: player.id,
      playerToken: player.token,
      snapshot: this.snapshotForPlayer(room.code, player.token),
    };
  }

  private createPlayer(name: string, seat: number, isTestPlayer = false): Player {
    return {
      id: randomUUID(),
      token: randomUUID(),
      name,
      seat,
      ready: false,
      connected: true,
      isTestPlayer,
    };
  }

  private createCode(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const code = randomInt(100000, 1000000).toString();
      if (!this.rooms.has(code)) return code;
    }
    throw new RoomError("CODE_EXHAUSTED", "暂时无法创建房间，请稍后再试");
  }

  private normalizeCode(rawCode: string): string {
    return rawCode.trim();
  }

  private normalizeName(rawName: string): string {
    const name = rawName.trim().slice(0, 12);
    if (!name) throw new RoomError("NAME_REQUIRED", "请输入昵称");
    return name;
  }
}
