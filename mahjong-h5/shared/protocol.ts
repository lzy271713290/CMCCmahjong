export type NumberedSuit = "wan" | "tong" | "tiao";
export type HonorTile = "east" | "south" | "west" | "north" | "red" | "green" | "white";
export type TileCode = `${NumberedSuit}-${number}` | HonorTile;
export type DiscardView = { seat: number; tile: TileCode };

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
    turnSeat: number;
    stage: "awaiting_discard" | "awaiting_reactions" | "round_ended";
    wallRemaining: number;
    handTileCounts: number[];
    viewerSeat?: number;
    selfHand?: TileCode[];
    selfDrawnTile?: TileCode;
    latestDiscard?: DiscardView;
    discards: DiscardView[];
  };
};

export type ClientMessage =
  | { type: "create_room"; name: string }
  | { type: "join_room"; roomCode: string; name: string }
  | { type: "reconnect"; roomCode: string; playerToken: string }
  | { type: "set_ready"; ready: boolean }
  | { type: "fill_test_players" }
  | { type: "start_game" }
  | { type: "discard_tile"; tile: TileCode }
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
