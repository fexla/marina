/**
 * @file packages/pi-marina-bridge/extensions/inject.ts
 * @purpose Marina 环境下的 **skill 注入路径解析** 与 **Marina 系统提示词** 的纯函数。
 *   从 index.ts 拆出以便可单测(被 Marina 仓的 src/main/pi-bridge-inject.test.ts
 *   相对路径 import,同 binding.ts 的先例)。
 *
 * @关键设计(方案-pibridge-skill与提示词注入-20260909):
 * - show-in-marina skill 随本 package 分发(skills/show-in-marina/),但**不**声明在
 *   package.json 的 pi manifest 里 —— pi 对 package 资源的收集是 manifest 优先,
 *   有 manifest(pi.extensions)就不会再自动扫描顶层 skills/ 目录。因此该目录在
 *   pi 里是"休眠"的,只有 index.ts 在检测到 Marina env 后通过 resources_discover
 *   事件主动贡献 skillPaths 才被加载 —— 非 Marina 会话零污染(用户要求的语义)。
 * - 系统提示词通过 before_agent_start 追加。pi 每轮都从 base prompt 重建
 *   (agent-session.js emitBeforeAgentStart 传 _baseSystemPrompt),不会跨轮累积;
 *   这里仍做幂等 guard(含 MARINA_PROMPT_MARKER 即不重复追加),防御未来 pi 改为
 *   链式持久、或其它 extension 把我们追加过的 prompt 再次作为 base 传入。
 * - 提示词内容是 Marina 的输出习惯约定(大段输出走面板 / 瀑布式排版 / grilling
 *   批量澄清),来源是开发者项目 CLAUDE.md 中与 Marina 相关的三节,改写为
 *   pi + show-in-marina skill 的语境。skill 教"怎么用 CLI",提示词教"什么时候用"。
 *
 * @不要在这里做的事:
 * - 不订阅 pi 事件(那是 index.ts 的职责)
 * - 不发 HTTP(那是 index.ts 的职责)
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** skill 根目录名(相对包根)。包根 = extensions/ 的上一级。 */
export const MARINA_SKILLS_DIR = 'skills';

/**
 * extension 模块 URL(import.meta.url)→ 包根目录绝对路径。
 * extension 文件固定在 <pkg>/extensions/*.ts,包根 = dirname(file) 的上一级。
 * jiti 下 import.meta.url 可用(2026-09-09 用 pi 0.84.4 自带 jiti 实测,
 * 返回被加载文件的真实 file:// URL)。
 */
export function resolvePackageRoot(moduleUrl: string): string {
  return join(dirname(fileURLToPath(moduleUrl)), '..');
}

/** 包根 → skill 贡献目录(skills/),传给 resources_discover 的 skillPaths。 */
export function resolveSkillsDir(moduleUrl: string): string {
  return join(resolvePackageRoot(moduleUrl), MARINA_SKILLS_DIR);
}

/**
 * skills/ 目录是否存在(打包缺文件 / 复制不完整的护栏)。
 * 不存在时 index.ts 对 skill 与系统提示词**两个注入都不做** —— 提示词通篇
 * 引导模型"用 show-in-marina skill 展示",skill 缺席时只注入提示词会让模型
 * 反复找一个不存在的 skill,比两个都不注入更糟。
 */
export function skillsDirExists(skillsDir: string): boolean {
  return existsSync(skillsDir);
}

/**
 * 幂等标记。放在注入块首行,before_agent_start 每轮检查 base prompt 是否
 * 已含它来决定是否追加(见文件头"关键设计"第 2 条)。不要改这个字符串的
 * 语义 —— 它是新旧 prompt 互斥的唯一依据;改内容时保留标记原样即可。
 */
export const MARINA_PROMPT_MARKER = '<!-- marina-bridge-system-prompt -->';

/**
 * 注入的 Marina 系统提示词。中文:来源材料(CLAUDE.md)即中文,Marina 当前
 * 用户群也以中文为主;现代模型对中文行为指令遵从无差异。
 * 三节均要求"先读 show-in-marina skill 的 SKILL.md 再动手"式的渐进披露:
 * 这里只教"什么时候/往哪里放",CLI 用法由 skill 本体承载。
 */
export const MARINA_SYSTEM_PROMPT = `${MARINA_PROMPT_MARKER}

# Marina 环境约定

你正运行在 Marina 终端里。Marina 为这个终端提供了文件面板("已打开")、命令面板等展示面,通过 show-in-marina skill 使用(先用 read 读它的 SKILL.md 与 MARKDOWN-CAPABILITIES.md,再动手)。

## 输出与展示

给用户看的大段文字,写成 markdown 文件、用 show-in-marina skill 展示到面板,别堆在对话回复里。适用于:阶段性总结、工作进度检查报告(多表格/多节点)、计划/PRD/技术方案、code review 结果、调研报告、对比分析、决策记录等大段输出。

对话回复只留一两句提炼 + 文件路径,不要把全文复述一遍。例外:短结论、单条问答、需要直接执行的指令,正常在对话里回即可。

多轮任务可把同一份文档作为任务看板:每轮覆写同一文件并重新 show,面板原地刷新标签页,对话保持一行状态 + 指向文档。

## 瀑布式输出

对话是瀑布式的 —— 用户滚动时视线落在最底部。回复要把最重要的内容、想让用户首先看到的东西放在**最底部**,不要把关键结论埋在中间或顶部、底部堆冗余文字。

## 澄清提问(grilling)

需要用户拍板决策时:

1. **批量提问,不要一次一个**:把当前所有已成型的问题一次列出,让用户纵览全貌,标注问题之间的依赖关系。
2. **超过 3 个问题,写进 markdown 文档**用 show-in-marina 展示,对话只留提炼 + 路径。
3. **每个问题带完整上下文**:为什么问、依赖前面哪个决策、不同答案各导向什么。
4. **推论禁止充当事实**:你自己推导的结论拿去问用户前,必须标注「这是我的推论/假设,可能错」并写出依据(查了什么、读了哪段代码);先让用户确认推论成立,再问依赖它的决策。`;

/**
 * 幂等追加 Marina 提示词。base 已含标记 → 原样返回(见 MARINA_PROMPT_MARKER)。
 */
export function appendMarinaPrompt(base: string): string {
  if (base.includes(MARINA_PROMPT_MARKER)) return base;
  return `${base}\n\n${MARINA_SYSTEM_PROMPT}`;
}
