type RemoteVoicePlayer = {
  audio: HTMLAudioElement;
  mediaSource?: MediaSource;
  sourceBuffer?: SourceBuffer;
  pending: Blob[];
  mimeType: string;
  fallback: boolean;
};

export type VoiceToggleResult = { micOn: boolean; error?: string };

export class VoiceChannel {
  private mediaStream: MediaStream | undefined;
  private recorder: MediaRecorder | undefined;
  private remotePlayers = new Map<number, RemoteVoicePlayer>();
  private readonly sendJson: (message: object) => boolean;
  private readonly notice: (message: string) => void;
  private micEnabled = false;
  private speakerEnabled = true;

  constructor(options: { send: (message: object) => boolean; notice?: (message: string) => void }) {
    this.sendJson = options.send;
    this.notice = options.notice ?? (() => undefined);
  }

  get micOn(): boolean {
    return this.micEnabled;
  }

  get speakerOn(): boolean {
    return this.speakerEnabled;
  }

  async toggleMic(): Promise<VoiceToggleResult> {
    if (this.micEnabled) {
      this.stopMic();
      return { micOn: false };
    }
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
        throw new Error("当前页面不是 HTTPS，浏览器禁止使用麦克风");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const supported = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((type) =>
        MediaRecorder.isTypeSupported(type),
      );
      this.mediaStream = stream;
      this.recorder = new MediaRecorder(stream, supported ? { mimeType: supported } : undefined);
      this.recorder.ondataavailable = (event) => {
        if (event.data.size === 0 || !this.micEnabled) return;
        void event.data.arrayBuffer().then((buffer) => {
          this.sendJson({
            type: "voice_audio",
            data: bytesToBase64(new Uint8Array(buffer)),
            mimeType: event.data.type || this.recorder?.mimeType || "audio/webm",
          });
        });
      };
      this.recorder.start(500);
      this.micEnabled = true;
      this.notice("麦克风已打开，说话时其他玩家可听到");
      return { micOn: true };
    } catch (error) {
      this.micEnabled = false;
      const rawMessage = error instanceof Error ? error.message : "无法打开麦克风";
      const message = /permission|denied|notallowed/i.test(rawMessage)
        ? "麦克风权限被拒绝，请在浏览器设置中允许麦克风"
        : rawMessage;
      this.notice(message);
      return { micOn: false, error: message };
    }
  }

  toggleSpeaker(): { speakerOn: boolean } {
    this.speakerEnabled = !this.speakerEnabled;
    if (!this.speakerEnabled) this.clearRemotePlayers();
    this.notice(this.speakerEnabled ? "喇叭已打开，可听到其他开麦玩家" : "喇叭已关闭");
    return { speakerOn: this.speakerEnabled };
  }

  setSpeaker(enabled: boolean): void {
    this.speakerEnabled = enabled;
    if (!enabled) this.clearRemotePlayers();
  }

  handleAudio(fromSeat: number, data: string, mimeType: string): void {
    if (!this.speakerEnabled) return;
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(data);
    } catch {
      return;
    }
    const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: mimeType || "audio/webm" });
    const player = this.remotePlayers.get(fromSeat) ?? this.createRemotePlayer(fromSeat, blob.type);
    player.pending.push(blob);
    this.flushPlayer(player);
  }

  reset(): void {
    this.stopMic();
    this.clearRemotePlayers();
  }

  private stopMic(): void {
    if (this.recorder && this.recorder.state !== "inactive") {
      try {
        this.recorder.stop();
      } catch {
        // 录音器可能已经停止，忽略即可。
      }
    }
    this.recorder = undefined;
    this.mediaStream?.getTracks().forEach((track) => track.stop());
    this.mediaStream = undefined;
    this.micEnabled = false;
  }

  private clearRemotePlayers(): void {
    for (const player of this.remotePlayers.values()) {
      player.audio.pause();
      player.audio.removeAttribute("src");
      if (player.mediaSource && "MediaSource" in window && player.mediaSource.readyState === "open") {
        try {
          player.mediaSource.endOfStream();
        } catch {
          // 结束流失败不影响后续重开。
        }
      }
    }
    this.remotePlayers.clear();
  }

  private createRemotePlayer(fromSeat: number, mimeType: string): RemoteVoicePlayer {
    const audio = new Audio();
    audio.autoplay = true;
    const player: RemoteVoicePlayer = {
      audio,
      pending: [],
      mimeType,
      fallback: false,
    };
    if ("MediaSource" in window) {
      try {
        const mediaSource = new MediaSource();
        player.mediaSource = mediaSource;
        audio.src = URL.createObjectURL(mediaSource);
        mediaSource.addEventListener("sourceopen", () => {
          if (!player.mediaSource || player.mediaSource.readyState !== "open") return;
          try {
            player.sourceBuffer = player.mediaSource.addSourceBuffer(player.mimeType);
            player.sourceBuffer.mode = "segments";
            void audio.play().catch(() => undefined);
            this.flushPlayer(player);
          } catch {
            player.fallback = true;
            URL.revokeObjectURL(audio.src);
            audio.removeAttribute("src");
          }
        });
      } catch {
        player.fallback = true;
      }
    } else {
      player.fallback = true;
    }
    this.remotePlayers.set(fromSeat, player);
    return player;
  }

  private flushPlayer(player: RemoteVoicePlayer): void {
    if (player.fallback || (player.mediaSource && !player.sourceBuffer)) return;
    if (player.sourceBuffer && player.sourceBuffer.updating) return;
    const blob = player.pending.shift();
    if (!blob) return;
    if (player.fallback || !player.sourceBuffer) {
      const url = URL.createObjectURL(blob);
      player.audio.src = url;
      void player.audio.play().catch(() => undefined);
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      return;
    }
    void blob.arrayBuffer().then((buffer) => {
      if (player.sourceBuffer && !player.sourceBuffer.updating) {
        try {
          player.sourceBuffer.appendBuffer(new Uint8Array(buffer));
        } catch {
          player.fallback = true;
        }
      } else {
        player.pending.unshift(blob);
      }
    });
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
