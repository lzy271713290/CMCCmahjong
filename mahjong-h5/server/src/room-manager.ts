import { randomInt, randomUUID } from "node:crypto";
import type { DiscardView, MeldView, ReactionOption, RoomSnapshot, TileCode } from "../../shared/protocol.js";
import {
  createInitialGame,
  drawTileFromWall,
  drawTileFromWallEnd,
  findDiscardReactionOptions,
  selectReactionClaims,
  sortTiles,
  type InitialGameState,
} from "./game-model.js";

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
    resolution: "waiting" | "all_passed" | "meld_claimed" | "discard_hu";
    winningSeats: number[];
    claimedMeld?: MeldView;
    autoDiscards: Array<{ seat: number; tile: TileCode; wallRemaining: number }>;
    reactionWindows: ReactionWindowDiagnostic[];
    nextTurnSeat?: number;
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

  reactToDiscard(rawCode: string, playerToken: string, operationId: string | "pass"): ReactionProgress {
    const room = this.getRoom(rawCode);
    const player = room.players.find((candidate) => candidate.token === playerToken);
    if (!player) throw new RoomError("TOKEN_INVALID", "玩家身份已失效");
    const game = room.game;
    const pending = game?.pendingReaction;
    if (room.phase !== "playing" || !game || game.stage !== "awaiting_reactions" || !pending) {
      throw new RoomError("REACTION_NOT_AVAILABLE", "当前没有等待你响应的弃牌");
    }
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
        game.pendingReaction = undefined;
        game.lastDraw = undefined;
        game.stage = "round_ended";
        game.roundResult = {
          reason: "discard_hu",
          winnerSeats: winningSeats,
          fromSeat: pending.discard.seat,
          tile: pending.discard.tile,
        };
        resolution = "discard_hu";
      } else if (selectedClaims.length > 0) {
        const claim = selectedClaims[0]!;
        claimedMeld = this.applyMeldClaim(game, pending.discard, claim.seat, claim.option);
        resolution = "meld_claimed";
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
            melds: [...room.game.melds.values()].flat(),
            reaction: room.game.pendingReaction
              ? {
                  discard: room.game.pendingReaction.discard,
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
            roundResult: room.game.roundResult,
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
          game.pendingReaction = { discard, optionsBySeat, responses };
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
    const meld: MeldView = { seat, kind: option.kind as MeldView["kind"], tiles: option.displayTiles, fromSeat: discard.seat };
    game.melds.get(seat)?.push(meld);
    game.pendingReaction = undefined;
    game.lastDraw = undefined;
    game.turnSeat = seat;
    if (option.kind === "gang") drawTileFromWallEnd(game, seat);
    else game.stage = "awaiting_discard";
    return meld;
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
