import type { TileCode } from "../../shared/protocol.js";

export type ActionVoice = "chi" | "peng" | "gang" | "hu";
export type EffectSound = "deal" | "discard" | "select" | "shuffle" | "timeup" | "ui" | "win" | "lose";
export type AudioChannel = "voice" | "effects" | "music";
export type AudioSettings = { voice: boolean; effects: boolean; music: boolean };
export type AudioMonitorEvent = {
  event: "audio_ready" | "audio_settings_changed" | "audio_asset_failed" | "audio_bgm_started" | "audio_bgm_stopped" | "audio_voice_requested";
  channel?: AudioChannel;
  asset?: string;
  tile?: TileCode;
  reason?: string;
  voice?: boolean;
  effects?: boolean;
  music?: boolean;
};

const SOUND_ROOT = "/assets/babykylin/sounds";
const SETTINGS_KEY = "mahjong-audio-v2";

const honorVoiceIds: Record<string, number> = {
  east: 31,
  west: 41,
  south: 51,
  north: 61,
  red: 71,
  green: 81,
  white: 91,
};

const actionVoiceFiles: Record<ActionVoice, string> = {
  chi: `${SOUND_ROOT}/nv/chi.mp3`,
  peng: `${SOUND_ROOT}/nv/peng.mp3`,
  gang: `${SOUND_ROOT}/nv/gang.mp3`,
  hu: `${SOUND_ROOT}/nv/hu.mp3`,
};

const effectFiles: Record<EffectSound, string> = {
  deal: `${SOUND_ROOT}/deal.mp3`,
  discard: `${SOUND_ROOT}/give.mp3`,
  select: `${SOUND_ROOT}/select.mp3`,
  shuffle: `${SOUND_ROOT}/shuffle.mp3`,
  timeup: `${SOUND_ROOT}/timeup_alarm.mp3`,
  ui: `${SOUND_ROOT}/ui_click.mp3`,
  win: `${SOUND_ROOT}/win.mp3`,
  lose: `${SOUND_ROOT}/lose.mp3`,
};

export function tileVoicePath(tile: TileCode): string {
  const [suit, rawRank] = tile.split("-");
  const rank = Number(rawRank);
  const voiceId = suit === "tiao"
    ? rank
    : suit === "wan"
      ? 10 + rank
      : suit === "tong"
        ? 20 + rank
        : honorVoiceIds[tile];
  if (!voiceId) throw new Error(`没有找到牌面 ${tile} 的报牌语音`);
  return `${SOUND_ROOT}/nv/${voiceId}.mp3`;
}

export function actionVoicePath(action: ActionVoice): string {
  return actionVoiceFiles[action];
}

export function effectSoundPath(effect: EffectSound): string {
  return effectFiles[effect];
}

function readSettings(): AudioSettings {
  const defaults: AudioSettings = { voice: true, effects: true, music: true };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      if (localStorage.getItem("mahjong-sound") === "off") return { voice: false, effects: false, music: false };
      return defaults;
    }
    const parsed = JSON.parse(raw) as Partial<AudioSettings>;
    return {
      voice: parsed.voice !== false,
      effects: parsed.effects !== false,
      music: parsed.music !== false,
    };
  } catch {
    return defaults;
  }
}

export class MahjongAudioManager {
  private context?: AudioContext;
  private masterGain?: GainNode;
  private bgmGain?: GainNode;
  private bgmSource?: AudioBufferSourceNode;
  private bgmStarting = false;
  private bgmGeneration = 0;
  private readonly buffers = new Map<string, Promise<AudioBuffer>>();
  private activated = false;
  private inGame = false;
  private settings = readSettings();

  constructor(private readonly monitor: (event: AudioMonitorEvent) => void) {}

  getSettings(): AudioSettings {
    return { ...this.settings };
  }

  activate(): void {
    if (!this.hasAnySound()) return;
    try {
      this.context ??= new AudioContext();
      if (!this.masterGain) {
        this.masterGain = this.context.createGain();
        this.masterGain.connect(this.context.destination);
      }
      void this.context.resume();
      if (!this.activated) {
        this.activated = true;
        this.monitor({ event: "audio_ready", ...this.settings });
      }
      if (this.inGame) void this.startBgm();
    } catch (error) {
      this.monitor({ event: "audio_asset_failed", channel: "effects", reason: this.errorMessage(error) });
    }
  }

  setInGame(inGame: boolean): void {
    this.inGame = inGame;
    if (inGame && this.activated) void this.startBgm();
    if (!inGame) this.stopBgm();
  }

  updateSettings(next: AudioSettings): void {
    this.settings = { ...next };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    localStorage.setItem("mahjong-sound", this.hasAnySound() ? "on" : "off");
    this.monitor({ event: "audio_settings_changed", ...this.settings });
    if (this.hasAnySound()) this.activate();
    if (this.settings.music && this.inGame) {
      void this.startBgm();
    } else if (!this.settings.music) {
      this.stopBgm();
    }
  }

  playTile(tile: TileCode): void {
    if (!this.settings.voice) return;
    const path = tileVoicePath(tile);
    this.monitor({ event: "audio_voice_requested", channel: "voice", tile, asset: path.split("/").at(-1) });
    this.playOneShot(path, "voice", 0.9, true);
  }

  playAction(action: ActionVoice): void {
    if (!this.settings.voice) return;
    this.playOneShot(actionVoicePath(action), "voice", action === "hu" ? 1 : 0.92, true);
  }

  playEffect(effect: EffectSound, delayMs = 0): void {
    if (!this.settings.effects) return;
    window.setTimeout(() => this.playOneShot(effectSoundPath(effect), "effects", effect === "timeup" ? 0.72 : 0.58), delayMs);
  }

  private hasAnySound(): boolean {
    return this.settings.voice || this.settings.effects || this.settings.music;
  }

  private async startBgm(): Promise<void> {
    if (!this.settings.music || !this.inGame || !this.activated || this.bgmSource || this.bgmStarting) return;
    this.bgmStarting = true;
    const generation = ++this.bgmGeneration;
    try {
      const context = this.requireContext();
      const buffer = await this.load(`${SOUND_ROOT}/bgFight.mp3`, "music");
      if (generation !== this.bgmGeneration || !this.settings.music || !this.inGame || this.bgmSource) return;
      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = buffer;
      source.loop = true;
      gain.gain.value = 0.16;
      source.connect(gain).connect(this.requireMasterGain());
      source.start();
      source.addEventListener("ended", () => {
        if (this.bgmSource === source) this.bgmSource = undefined;
      });
      this.bgmSource = source;
      this.bgmGain = gain;
      this.monitor({ event: "audio_bgm_started", channel: "music", asset: "bgFight.mp3" });
    } catch (error) {
      this.monitor({ event: "audio_asset_failed", channel: "music", asset: "bgFight.mp3", reason: this.errorMessage(error) });
    } finally {
      if (generation === this.bgmGeneration) this.bgmStarting = false;
    }
  }

  private stopBgm(): void {
    this.bgmGeneration += 1;
    this.bgmStarting = false;
    if (!this.bgmSource) return;
    this.bgmSource.stop();
    this.bgmSource.disconnect();
    this.bgmGain?.disconnect();
    this.bgmSource = undefined;
    this.bgmGain = undefined;
    this.monitor({ event: "audio_bgm_stopped", channel: "music", asset: "bgFight.mp3" });
  }

  private async playOneShot(path: string, channel: "voice" | "effects", volume: number, duckMusic = false): Promise<void> {
    if (!this.activated) return;
    try {
      const context = this.requireContext();
      const buffer = await this.load(path, channel);
      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = buffer;
      gain.gain.value = volume;
      source.connect(gain).connect(this.requireMasterGain());
      if (duckMusic && this.bgmGain) {
        const now = context.currentTime;
        this.bgmGain.gain.cancelScheduledValues(now);
        this.bgmGain.gain.setTargetAtTime(0.045, now, 0.025);
        this.bgmGain.gain.setTargetAtTime(0.16, now + Math.min(buffer.duration, 1.3), 0.12);
      }
      source.start();
      source.addEventListener("ended", () => {
        source.disconnect();
        gain.disconnect();
      });
    } catch (error) {
      this.monitor({ event: "audio_asset_failed", channel, asset: path.split("/").at(-1), reason: this.errorMessage(error) });
    }
  }

  private requireContext(): AudioContext {
    if (!this.context) throw new Error("AudioContext unavailable");
    return this.context;
  }

  private requireMasterGain(): GainNode {
    if (!this.masterGain) throw new Error("audio gain unavailable");
    return this.masterGain;
  }

  private load(path: string, channel: AudioChannel): Promise<AudioBuffer> {
    const existing = this.buffers.get(path);
    if (existing) return existing;
    const pending = fetch(path)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then((data) => this.requireContext().decodeAudioData(data))
      .catch((error) => {
        this.buffers.delete(path);
        this.monitor({ event: "audio_asset_failed", channel, asset: path.split("/").at(-1), reason: this.errorMessage(error) });
        throw error;
      });
    this.buffers.set(path, pending);
    return pending;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message.slice(0, 120) : "unknown";
  }
}
