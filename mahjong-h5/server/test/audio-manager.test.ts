import assert from "node:assert/strict";
import test from "node:test";
import { actionVoicePath, effectSoundPath, tileVoicePath } from "../../client/src/audio-manager.js";
import type { TileCode } from "../../shared/protocol.js";

test("34种麻将牌全部映射到唯一真人报牌音频", () => {
  const numberTiles = (["wan", "tong", "tiao"] as const).flatMap((suit) =>
    Array.from({ length: 9 }, (_, index) => `${suit}-${index + 1}` as TileCode),
  );
  const honorTiles: TileCode[] = ["east", "south", "west", "north", "red", "green", "white"];
  const paths = [...numberTiles, ...honorTiles].map(tileVoicePath);
  assert.equal(paths.length, 34);
  assert.equal(new Set(paths).size, 34);
  assert.equal(tileVoicePath("tiao-1"), "/assets/babykylin/sounds/nv/1.mp3");
  assert.equal(tileVoicePath("wan-9"), "/assets/babykylin/sounds/nv/19.mp3");
  assert.equal(tileVoicePath("tong-9"), "/assets/babykylin/sounds/nv/29.mp3");
  assert.equal(tileVoicePath("east"), "/assets/babykylin/sounds/nv/61.mp3");
  assert.equal(tileVoicePath("north"), "/assets/babykylin/sounds/nv/91.mp3");
});

test("吃碰杠胡和关键牌桌音效均使用可公开访问的素材路径", () => {
  for (const action of ["chi", "peng", "gang", "hu"] as const) {
    assert.match(actionVoicePath(action), /^\/assets\/babykylin\/sounds\/nv\/.+\.mp3$/);
  }
  for (const effect of ["deal", "discard", "select", "shuffle", "timeup", "ui", "win", "lose"] as const) {
    assert.match(effectSoundPath(effect), /^\/assets\/babykylin\/sounds\/.+\.mp3$/);
  }
});
