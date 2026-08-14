export type PlayerView = {
  id: string;
  name: string;
  seat: number;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
  isTestPlayer: boolean;
};

export type RoomSnapshot = {
  roomCode: string;
  revision: number;
  phase: "waiting" | "playing";
  players: PlayerView[];
  game?: {
    modelVersion: string;
    roundNumber: number;
    dealerSeat: number;
    wallRemaining: number;
    handTileCounts: number[];
  };
};

export type ClientMessage =
  | { type: "create_room"; name: string }
  | { type: "join_room"; roomCode: string; name: string }
  | { type: "reconnect"; roomCode: string; playerToken: string }
  | { type: "set_ready"; ready: boolean }
  | { type: "fill_test_players" }
  | { type: "start_game" }
  | { type: "ping" };

export type ServerMessage =
  | {
      type: "session";
      roomCode: string;
      playerId: string;
      playerToken: string;
      snapshot: RoomSnapshot;
    }
  | { type: "snapshot"; snapshot: RoomSnapshot }
  | { type: "error"; code: string; message: string }
  | { type: "pong" };
