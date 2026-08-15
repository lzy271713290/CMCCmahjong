# 幼麟麻将复用素材

来源：https://github.com/babykylin/babykylin_scmj

本目录暂存已经确定直接复用的牌桌素材：

- `table/mahjong_table.jpg`：绿色麻将桌背景。
- `table/play_scene.png` 与 `table/play_scene.plist`：准备、碰、杠、胡、方向盘、聊天和设置等牌桌控件图集。
- `MJ/`：玩家正面、出牌区及左右两家的麻将牌图集与切片描述。
- `sounds/nv/`：34种牌面女声报牌及吃、碰、杠、胡语音。
- `sounds/bgFight.mp3`：牌桌循环背景音乐。
- `sounds/*.mp3`：洗牌、发牌、弃牌、倒计时、按钮和胜负音效。
- `efx/`：碰、杠、胡、自摸等牌桌光效帧。

接入 H5 时保留原图，转换后的 Web 图集另存到 `generated/`，避免覆盖源素材。

音画资源从参考仓库对应 Git 对象原样导出，未修改参考仓库；H5 运行目录不保留 Cocos `.meta` 文件。参考仓库 README 将该版本标明为开源版本，本项目继续保留来源链接和本清单用于归属追踪。
