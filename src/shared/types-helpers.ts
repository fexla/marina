/**
 * @file types-helpers.ts
 * @purpose 通用类型工具,与领域模型解耦。
 *
 * 单独成文件是为了 protocol.ts / types.ts 引用更清晰
 * (避免循环 import 与"通用工具混在领域类型里"的认知负担)。
 */

/**
 * 递归 partial — 嵌套对象每层都可缺字段。
 * SettingsManager.update 与 ipc-protocol UpdateSettingsPayload 都使用此类型。
 */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};
