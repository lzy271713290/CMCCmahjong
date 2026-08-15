import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
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
  for (let rank = 1; rank <= 9; rank += 1) {
    assert.equal(tileVoicePath(`tiao-${rank}`), `/assets/babykylin/sounds/nv/${rank}.mp3`);
    assert.equal(tileVoicePath(`wan-${rank}`), `/assets/babykylin/sounds/nv/${10 + rank}.mp3`);
    assert.equal(tileVoicePath(`tong-${rank}`), `/assets/babykylin/sounds/nv/${20 + rank}.mp3`);
  }
  const expectedHonors: Array<[TileCode, number]> = [
    ["east", 31], ["west", 41], ["south", 51], ["north", 61],
    ["red", 71], ["green", 81], ["white", 91],
  ];
  for (const [tile, voiceId] of expectedHonors) {
    assert.equal(tileVoicePath(tile), `/assets/babykylin/sounds/nv/${voiceId}.mp3`);
  }
});

test("吃碰杠胡和关键牌桌音效均使用可公开访问的素材路径", () => {
  for (const action of ["chi", "peng", "gang", "hu"] as const) {
    assert.match(actionVoicePath(action), /^\/assets\/babykylin\/sounds\/nv\/.+\.mp3$/);
  }
  for (const effect of ["deal", "discard", "select", "shuffle", "timeup", "ui", "win", "lose"] as const) {
    assert.match(effectSoundPath(effect), /^\/assets\/babykylin\/sounds\/.+\.mp3$/);
  }
});

test("大厅规则帮助准确说明两类特殊杠", () => {
  const help = readFileSync(fileURLToPath(new URL("../../../client/public/index.html", import.meta.url)), "utf8");
  assert.match(help, /中发白和东南西北两类特殊杠/);
  assert.doesNotMatch(help, /幺鸡特殊杠/);
});
