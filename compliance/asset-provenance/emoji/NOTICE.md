# Emoji 短名映射来源与修改声明

本地 [unicode-emojis.json](unicode-emojis.json) 是从下列固定版本重新生成的短名到 Unicode 序列映射。它不包含 Emoji 图片、字形或字体；实际字形由用户系统字体渲染。本说明只涵盖该数据表，不代替其他组件的版权审查。

## 固定来源及完整原始许可

| 来源 | 固定版本 | 原始数据 | 完整原始许可 |
|---|---|---|---|
| GitHub gemoji | `fadaeaf1f1a9be82b321316a6c5502e43138b2f6` | [官方 db/emoji.json](https://raw.githubusercontent.com/github/gemoji/fadaeaf1f1a9be82b321316a6c5502e43138b2f6/db/emoji.json) | MIT；原文保留 `Copyright (c) 2019 GitHub, Inc.`，见证据目录中的 `gemoji-LICENSE.txt` |
| iamcal/emoji-data | `e77759c296ed37beb0dbd63908b43d8619509c6d` | [官方 emoji.json](https://raw.githubusercontent.com/iamcal/emoji-data/e77759c296ed37beb0dbd63908b43d8619509c6d/emoji.json) | MIT；原文保留 `Copyright (c) 2013 Cal Henderson`，见 `iamcal-LICENSE.txt` |
| Unicode Emoji | `17.0.0` | [官方 emoji-test.txt](https://unicode.org/Public/17.0.0/emoji/emoji-test.txt) | Unicode-3.0；见同源固定提交的 `unicode-LICENSE.txt`，不改写其中年份 |

Unicode 数据的头部版权为 `© 2025 Unicode®, Inc.`。其官方仓库 [unicode-org/unicodetools 的固定提交](https://github.com/unicode-org/unicodetools/tree/48afe632bf194a20bcd27c3488b49dc23274b684) 包含与上述发布文件 **逐字节相同** 的 `unicodetools/data/emoji/17.0/emoji-test.txt`，以及同提交根目录的 [LICENSE](https://raw.githubusercontent.com/unicode-org/unicodetools/48afe632bf194a20bcd27c3488b49dc23274b684/LICENSE)。该原文为 `UNICODE LICENSE V3`，版权行是 `Copyright © 2001-2024 Unicode, Inc.`；原文件的不同年份分别保留，不用当前网站许可或通用模板替换历史原文。

两份 MIT 数据分别履行各自的版权与许可保留义务；Unicode 来源条目另按 Unicode-3.0 履行。不将这些原文合并成删除年份或原始格式的模板。

## 本地派生规则

- 上游 `aliases` / `short_names` 各项展开为单键；值从 gemoji 的 `emoji` 或 iamcal 的 `unified` 序列解码。明确的同名来源优先，不能用另一个名字下的相同图符掩盖同名错误。
- `alias-policy.json` 对每一个运行时键明确指定 `sourceId` 和 `aliasOf`。本地兼容名字是本轮重新核对的互操作规则，不声称这些名字本身来自上游；例如 `Accept → gemoji:accept`、`woman_kneeling_right → iamcal:woman_kneeling_facing_right`。完整逐项证明在 `manifest.json`，含上游 JSON pointer / Unicode 行号、源值与本地值的码点、转换和来源散列。
- 既有的 FE0E / FE0F 显示差异保留。校验器只允许这两个选择符的增减，禁止通过“显示差异”改变实际字符、ZWJ、性别、地区或顺序。
- `red_haired`、`curly_haired`、`bald`、`white_haired` 四个本地组件名字分别指向 Unicode 17.0 原文 `red hair`、`curly hair`、`bald`、`white hair`，即 `1F9B0`、`1F9B1`、`1F9B2`、`1F9B3`。原文标记为 `component`，不误报为完整人物 Emoji；独立显示受系统字体支持影响。

## 纠错与兼容

整改前为 1,946 个键；整改后为 1,954 个键。原表的 SHA256、原键集合散列、所有修改前值及顺序锚均记录在策略中，门禁会重建原表核对，防止漏删正常别名或未记录地改变旧值。

1. 按固定官方同名值纠正 `basketball_man`、`couplekiss_man_woman`、`cricket`、`family_man_woman_boy`、`golfing_man`、`mountain_biking_man`、`no_good_man`、`policeman`、`sassy_woman`、`weight_lifting_man`、`long_drum`、`empty_nest`。例如 `cricket` 从球拍球改为昆虫，`long_drum` 从铁锹改为长鼓，`empty_nest` 从有蛋鸟巢改为空巢。
2. `playground_slide_icon` 从无线网络符号改为真正的滑梯，明确作为 `gemoji:playground_slide` 的兼容名字。
3. 移除三个明显错义名字：`lyre` 先前实际是 khanda，`memorial_tablet` 实际是无叶树，`coral_sea_islands` 实际是萨克岛旗。固定 Unicode 17.0 没有前两个名字的准确对应，本轮不猜码点，也不把错误地区名当作正确官方来源。
4. 增加 11 个准确的官方名字以保留纠错前的实际图符：`cricket_game`、`shovel`、`nest_with_eggs`、`khanda`、`leafless_tree`、`flag-sark`、`bouncing_ball_person`、`golfing`、`weight_lifting`、`couplekiss`、`wireless`。其余旧图符通过既有准确别名保留；每一个变化都具有 `preservedAs`，由门禁确认旧序列仍可使用。

这些是本地修改，不代表上游存在相同错误。此前声明的泛化“谱系”和“事实性 codepoint”不能证明来源；本轮用固定原数据、逐项派生与原始许可替换这一未决状态。

## 证据位置、复现与分发

源码仓库中的证据目录是 [`compliance/asset-provenance/emoji/`](https://github.com/sylx-c/ZiEdit/tree/master/compliance/asset-provenance/emoji)，包括两份上游 JSON、Unicode 发布文件与同提交镜像、三份独立完整许可证、`alias-policy.json`、逐条 `manifest.json` 及本声明副本。所有原文件 SHA256 和字节数记录于清单；门禁另硬编码固定原文件散列，不能仅重写清单来通过审查。

```sh
node scripts/verify-asset-provenance.mjs
node scripts/verify-asset-provenance.mjs --self-test
node scripts/verify-asset-provenance.mjs --fetch-check
node scripts/verify-asset-provenance.mjs --distribution --dist
```

默认离线校验。`--self-test` 会验证错误图符、丢失别名、隐藏同名冲突和错误头发组件均被拒绝；`--fetch-check` 额外取固定官方 URL 对照。`--distribution` 确认证据未声明为安装资源；`--dist` 确认前端构建产物不含证据目录。仅在人工复核策略后运行 `--write` 重建映射与清单，它不会自动猜测或更新 `aliasOf`，也不会下载“最新版”。

分发口径（2026-11-06 定稿）：安装包只随附许可原文与 NOTICE；本证据目录不出现在发行物中，通过上述公开仓库路径提供获取指引。安装包组装后的实际内容仍须由发行验收核实，不能仅据源码门禁推定。本声明不承诺其他资产或整个发行物已经通过版权审查。
