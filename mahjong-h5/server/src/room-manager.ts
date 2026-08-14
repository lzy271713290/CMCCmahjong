import { randomInt, randomUUID } from "node:crypto";
import type { RoomSnapshot } from "../../shared/protocol.js";

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
};

export type Session = {
  roomCode: string;
  playerId: string;
  playerToken: string;
  snapshot: RoomSnapshot;
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
    room.phase = "playing";
    room.revision += 1;
    return this.snapshot(room.code);
  }

  snapshot(rawCode: string): RoomSnapshot {
    const room = this.getRoom(rawCode);
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
    };
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
      snapshot: this.snapshot(room.code),
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
