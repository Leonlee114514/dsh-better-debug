---
name: stuck-gate
description: "卡住闸门。Use when stuck: 2+ failed attempts at the same fix, an error repeating unchanged after your change, a problem you cannot reproduce but keep editing code for, any 「我猜是…」 without a probe, or any impulse to keep guessing. Forces five checks before the next attempt: build a red-capable feedback loop, search the exact error, minimize until every element carries weight, write 3-5 falsifiable hypotheses, treat a third failure at one layer as an architecture question."
metadata:
  version: "1.1"
  author: "Leonlee114514"
  source: "companion skill for the dsh-better-debug plugin"
---

# Stuck Gate（卡住闸门）

Trigger is **self-detection**, not the user's wording. Fire it the first time any of these is true in the current task:

- 同一处修了 **2 次以上**，症状没变，或变了但你无法解释为什么。
- 你正在写第 3 个「再试一次」的命令，而没有新的信息进来。
- 你刚在心里写了「大概是 / 我猜是 / 应该是版本问题」——**没有探针支撑**。
- 你不知道怎么让这个问题**稳定复现**，却在继续改代码。
- 性能/时序类问题你直接开始改实现，没有先测出数字。

Fire it **before** the next attempt. Not after.

**共同敌人**：用昂贵的动作（猜、从零造、第 4 次重试）逃避便宜的动作（验证、搜索、要现场）。

## The gate: 5 checks, in order, no skipping

1. **回路存在吗？** 必须有一条你**自己能在几秒内跑完、且当前就 red** 的命令（失败测试、最小脚本、`lsp_diagnostics`、一条 grep+diff、一个能稳定打出错误栈的调用）。
   - 建不出来 → **停止修改**。这是环境问题，不是代码问题：向用户要一份能复现的产物（日志、最小 repo、录屏、错误原文），或自己造一个 capture/replay。
   - 非确定性 → 目标不是 100% 复现，而是**把复现率抬到能观测**（循环 N 次、加时间戳、固定种子）。
2. **搜过了吗？** 用你的搜索工具查**错误原文整句** + 版本 + 栈顶符号，含 GitHub issue（closed 也要看）。时间盒 **10 分钟**。搜到 → 在自己的机器/版本/数据上验证一遍才算数。搜不到有两种含义：这组合没人踩过，或你的关键词是错的（换语言、换术语、去掉自造名词再搜）。
3. **最小化了吗？** 把输入/配置/代码砍到「再砍就不报错」。每个残留元素必须**承重**——不承重的元素是噪声，说明你在错误的现场。
4. **有几个可证伪假设？** 写 **3–5 条**，每条格式：`如果 X，那么我改 Y 会看到 Z`。给同行（或先给用户）看一遍再动手。**一次只动一个变量**，探针统一前缀（如 `[DEBUG-a4f2]`）方便一把删干净。
5. **三次失败 = 换层，不是第四次尝试。** 同一层连失败三次，说明架构假设错了：往上走一层（这真的该由这个组件负责吗？这个 seam 存在吗？），而不是在同层继续猜。

## 收尾（修好之后必做，否则闸门白跑）

- 回归测试写在修复**之前**；只在有正确 seam 时才写，别为了测试去新造 seam。
- commit message 里写下**正确的那个假设**（以及被排除的那几个），这是给下一个人的地图。
- 探针清理：`grep -rn "DEBUG-a4f2"` 必须为空。
- 把这次的事故复盘写成文档（issue / 笔记 / wiki 都行），让方法论与具体案例之间有据可查。

## 与 `dsh-better-debug` 插件的关系

插件只看**行为**：同一文件反复改、同一报错反复吃、改完不验证。它命中时会注入一句话提醒，
那句提醒指回本技能。两者互相独立——插件不依赖本技能存在，本技能也不需要插件。
插件负责「你想不起来的那一刻」，本技能负责「想起来了该做什么」。
