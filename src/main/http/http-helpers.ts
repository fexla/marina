/**
 * @file src/main/http/http-helpers.ts
 * @purpose LocalHttpGateway 与 FilePanelService 共用的 HTTP 传输辅助(纯函数,不持状态)。
 *   从 FilePanelService 原 HTTP 层提取(M3),保持语义/错误处理完全不变。
 *
 * @关键设计:
 * - 纯函数:不依赖任何 service/gateway 实例,单测零 mock。
 * - 与业务错误(FilePanelError)解耦:这里只做"把 JSON/二进制写回响应"和"读请求体",
 *   错误→状态码映射在调用方(service 的 sendError 处理 FilePanelError)。
 *
 * @对应文档:docs/架构整改-M1M2M3整体设计.md 决策 4(gateway 只抽传输层)。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** 响应体上限(字节):防恶意大 body,超过直接拒 + 断连。 */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * 写 JSON 响应。no-store:状态接口必须实时,客户端不该拿到旧快照。
 */
export function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    // 禁用缓存:状态接口必须实时,客户端不该拿到旧快照
    'Cache-Control': 'no-store',
  });
  res.end(json);
}

/**
 * 发 image/png 二进制(/screenshot 用)。同样 no-store,截图要实时。
 */
export function sendPng(res: ServerResponse, png: Buffer): void {
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Length': png.byteLength,
    'Cache-Control': 'no-store',
  });
  res.end(png);
}

/**
 * 读请求体为 UTF-8 字符串。防恶意大 body:超过 64KB 直接拒 + req.destroy()。
 */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      chunks.push(c);
      // 防恶意大 body:超过 64KB 直接拒
      if (Buffer.concat(chunks).byteLength > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
