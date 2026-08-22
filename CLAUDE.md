# 在做啦 · 协作说明

> 每个会话开局都会自动读到这个文件。**动手之前先看完**，尤其是「已验证的事实」那一节 ——
> 里面每一条都是花了真实 API 调用和真实渲染换来的，别重新踩。

线上：https://zaizuola.vercel.app　·　演示模式（不需要 key）：https://zaizuola.vercel.app/?mock=1

---

## 1. 这是什么

一个主打拖延的中文文字游戏。界面是聊天窗，对面是一个永远在催你的人。
你欠他一样东西，而且你根本没做。你唯一的任务：**拖**。

---

## 2. 核心机制（已定稿，不要推翻）

| 数值 | 角色 |
|---|---|
| **信任度** | 资源。100 封顶，归零结束。你花它买时间。 |
| **拖延值** | 分数。只增不减。排行榜按它排，不按天数。 |

**谎言账本** —— 玩家说的每句话进 `S.ledger`，每轮回喂给模型让它翻旧账。
谎话进账本（当场收益高，以后要圆），真话不进账本（收益低，永远抓不到）。
**这是游戏的灵魂。账本一旦失效，"抓矛盾"就从策略退化成随机惩罚。**

**开新坑（escalate）** —— 拖延的终极形态不是拖，是让这件事变成另一件更大更远的事。
玩家编一个更大的委托说服对方立项 → 信任 +45、阶段重置、得分倍率上升、旧委托进烂尾清单；
代价是每日衰减加重（−5 → −8 → −12 → −16）。**开坑越多，死得越快，分越高。**

**账本必须对玩家可见**（右栏抽屉）。看不见的账本 = 玩家只能靠记忆，机制会变成惩罚而不是策略。

---

## 3. 文件与职责

```
index.html      全部 UI + CSS。设计系统在最上面的 :root
content.js      场景 / 卡表 / 数值 / 文案       ← 改内容只动这里
game.js         状态机 / 结算 / prompt / 渲染
api/chat.js     Vercel Function 代理，藏 key + 限流 + 三级降级
vercel.json     函数超时 30s（默认 10s 不够）
.impeccable.md  设计准则：配色、字体、动效、五条原则  ← 碰 UI 前必读
```

零构建、零运行时第三方依赖。只有 JetBrains Mono 走 Google Fonts，挂了自动回落系统等宽。

---

## 4. 已验证的事实（**别再重跑，直接用**）

### 4.1 结构化输出必须用 `json_schema`，`json_object` 是坏的 ⚠️ 最重要

实测 `api.openai-next.com` 会**静默忽略** `response_format: {type:'json_object'}`
（提示词里不提 JSON，它就返回大白话）。加 prompt 约束治不好，试过，反而更糟：

| 机制 | 8 轮压测失败数 |
|---|---|
| `json_object` + prompt 里强调"只输出 JSON" | **3 / 8** |
| `json_object` + 首尾双重强调"以 { 开头" | **3 / 8**（更差） |
| `json_schema` + `strict: true` | **0 / 8** ✅ |

schema 定义在 `game.js` 的 `TURN_SCHEMA` / `REPORT_SCHEMA`。
字段说明写在 schema 的 `description` 里，**prompt 里不要再讲一遍格式**——
把格式说明从 prompt 删掉之后，判定质量明显变好（模型能专心演戏）。

`tools` + `tool_choice` 也可用，作为备选。

### 4.2 模型与延迟

`gpt-5.6-sol`，实测单轮 **4.5–8.5s**（平均约 6s）。回合制够用，
而且被"对方正在输入…"+ 打字机完全遮住了。**不要为了省这几秒去掉打字机**，它是体验本身。

### 4.3 开新坑的边界（回归过两次，注意别再弄丢）

模型默认会把"我妈住院了"判成 escalate，这会让任何人靠一句话白拿 +45 信任和阶段重置。
prompt 里那段「这三种情况一律 escalate: false」是修复，实测边界 **5/5**：

- 生病 / 家里出事 / 出差 → false（那是借口，不是新坑）
- "我要做得更好"没有具体内容 → false
- 提的东西不比原委托大 → false
- 只有**主动提出要多做一些**、大到对方愿意把原委托往后放 → true

### 4.4 UI 上踩过的坑

- `#game.on` **不能写 `position:relative`** —— 会覆盖 `.screen` 的 `position:fixed`，
  元素失去确定高度，`grid-template-rows` 的 `1fr` 退化成按内容撑开，
  中间那行会涨到 1368px，把输入框和手牌顶出视口。
- 文字对比度：`--t3` 必须 ≥ `#8A837B`。原来的 `#6E6761` 在页面底色上只有 **3.44:1**，
  而它承担着 10–12px 的卡牌描述和账本日期，不合格。现在四种前景 × 三种底色全过 AA。
- 结局页必须在 880px 高度内**一屏放下**，否则「上榜」按钮在折叠线以下，
  派对上传着玩没人会滚。靠「最佳借口 / 你答应过的事」并排来省高度。
- 噪点 `#grain` 的 opacity 不要超过 `.15`，超了整页发灰发脏。

---

## 5. 部署

```bash
vercel --prod --yes --scope keith9922s-projects
```

项目名 `zaizuola`，scope `keith9922s-projects`，生产别名 `zaizuola.vercel.app`（公开可访问）。
带 `-keith9922s-projects.vercel.app` 后缀的是预览地址，有 SSO 保护会 302，属正常。

环境变量（**key 绝不写进任何文件**）：

| 变量 | 必填 | 默认 |
|---|---|---|
| `AI_API_KEY` | 是 | — |
| `ZZL_MODEL` | 否 | `gpt-5.6-sol` |
| `ZZL_BASE` | 否 | `https://api.openai-next.com/v1` |

代理有三级降级：`json_schema` → `json_object` → 最小请求体，换任何上游都不会因参数不兼容卡死。
前端还有第四层：解析失败时如果模型确实说了句人话，直接当作 `reply` 救回来，不浪费台词。

---

## 6. 多会话协作约定 ⚠️

**已经有 git 了**（分支 `main`，暂无远端）。历史干净，`.env` 正确忽略。
之前发生过两个窗口同时改同一个文件、互相覆盖的事：

- `content.js` 里的 `FALLBACK` / `GENTLE_FALLBACK` / `MOCK_REPLIES` 被一次重构整组删掉
- prompt 里的「开新坑边界」修复**被回退过三次**
- 有一次部署上去的是两个窗口的混合半成品

### 约定

1. **动手前先 `git status` + `git log --oneline -5`。**
   工作区不干净说明另一个窗口正在改，先看清楚再动。
2. **改完就 commit，别攒。** 小步提交是这里最有效的防覆盖手段——
   被覆盖了 `git diff HEAD` 一眼就能看出来，`git checkout` 就能捞回来。
3. **一次会话尽量只占一个文件。** 改文案去 `content.js`，改 UI 去 `index.html`，
   改逻辑去 `game.js`。跨文件的大重构先 commit 一次再开始。
4. **用锚点替换，不要整文件重写。**
   `python3` + `assert old in s` + `replace(old, new, 1)`，锚点找不到就报错停下，别硬写。
5. **改完立刻验证再走**：`node --check`，以及把 `content.js` + `game.js` 一起 eval，
   检查有没有"引用了却没定义"的全局（`node --check` 查不出来，那些引用在函数体里）。
6. **验证 prompt 内容不要用 `buildSystem.toString()`** ——
   它现在只是 `buildStatic() + buildDynamic()` 的三行壳子，
   要检查就检查**合成后**的字符串。
7. **提交信息沿用现有风格**：`feat:` / `fix:` / `chore:` + 中文一句话。

### 常用

```bash
git status --short && git log --oneline -5     # 动手前
git diff HEAD -- game.js                       # 我的改动被谁盖了？
git add -A && git commit -m "feat: ..."        # 改完就提
vercel --prod --yes --scope keith9922s-projects # 部署前先确认工作区干净
```

## 7. 当前状态

**能玩了。** 9 个场景（含隐藏的「拼桌主持人」）、17 张卡、账本、开新坑、抽牌、
60s 计时、AI 结算报告、localStorage 排行榜、`~` 调参面板。

**待办：**

- [x] ~~线上缺 `AI_API_KEY`~~ 已配好，线上全链路可玩
- [ ] 节奏要用真模型调。现在起始信任 80 / 衰减 −5 是个待验的猜测，
      第一局跑完按 `~` 当场拖。压测里 mock 回复写得比真模型狠得多，别拿它当准
- [ ] 跨设备排行榜（现在 localStorage，各玩各的）。想做就加 `api/board.js` + Cloudflare KV
- [ ] 没绑自定义域名。要绑 `zaizuola.zhangrg.top` 的话走 my-infra 的 bind-domain playbook

做不完的功能，菜单里放个「在做啦」按钮，点了弹"在做啦"。这是设计的一部分，不是没做完。
