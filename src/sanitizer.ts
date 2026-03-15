/**
 * 敏感信息过滤器
 * 用于在 MCP 返回中隐藏 IP、密码等敏感信息
 */

import { IpMode } from "./sanitizer-config.js";

export interface SensitivePattern {
  pattern: RegExp;
  replacement: string;
  description: string;
}

// 不需要脱敏的本地回环 / 保留地址
const LOOPBACK_IPS = new Set([
  "127.0.0.1",
  "0.0.0.0",
  "255.255.255.255",
  "::1",
  "::",
]);

export class Sanitizer {
  private sensitiveValues: Set<string> = new Set();
  private patterns: SensitivePattern[] = [];
  private whitelist: Set<string>;
  private ipMode: IpMode;

  constructor(ipMode: IpMode = "all", whitelist: string[] = []) {
    this.ipMode = ipMode;
    this.whitelist = new Set([...LOOPBACK_IPS, ...whitelist]);

    // 仅在 "all" 模式下注册通用 IP 匹配正则
    if (ipMode === "all") {
      this.registerIpPatterns();
    }
    // "ssh-only" 模式：不注册通用正则，由 addSensitiveValues 精确匹配配置的地址
    // "none" 模式：不注册任何 IP 相关 pattern
  }

  /**
   * 注册 IP/IPv6/MAC 匹配正则（仅 all 模式使用）
   */
  private registerIpPatterns(): void {
    // IPv4-mapped IPv6: ::ffff:192.168.1.1 (必须在 IPv4 之前)
    this.addPattern({
      pattern: /::ffff:\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/gi,
      replacement: "[IPv6]",
      description: "IPv4-mapped IPv6 地址",
    });

    // MAC 地址: aa:bb:cc:dd:ee:ff 或 AA-BB-CC-DD-EE-FF (必须在 IPv6 之前)
    this.addPattern({
      pattern: /\b([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}\b/g,
      replacement: "[MAC]",
      description: "MAC 地址",
    });

    // IPv6 完整形式
    this.addPattern({
      pattern: /\b([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g,
      replacement: "[IPv6]",
      description: "IPv6 完整地址",
    });

    // IPv6 缩写形式 (含 ::)
    this.addPattern({
      pattern: /\b([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}\b/g,
      replacement: "[IPv6]",
      description: "IPv6 缩写 (前缀::后缀)",
    });

    this.addPattern({
      pattern: /\b([0-9a-fA-F]{1,4}:){1,7}:/g,
      replacement: "[IPv6]",
      description: "IPv6 缩写 (前缀::)",
    });

    this.addPattern({
      pattern: /::([0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4}\b/g,
      replacement: "[IPv6]",
      description: "IPv6 缩写 (::后缀)",
    });

    // IPv4 地址（放在最后）
    this.addPattern({
      pattern: /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g,
      replacement: "[IP]",
      description: "IPv4 地址",
    });
  }

  /**
   * 添加自定义正则模式
   */
  addPattern(pattern: SensitivePattern): void {
    this.patterns.push(pattern);
  }

  /**
   * 注册敏感值（如密码、私钥路径等）
   * 这些值会被精确匹配并替换
   */
  addSensitiveValue(value: string, minLength: number = 3): void {
    if (value && value.length >= minLength) {
      this.sensitiveValues.add(value);
    }
  }

  /**
   * 批量注册敏感值
   */
  addSensitiveValues(values: (string | undefined)[]): void {
    values.forEach((v) => {
      if (v) this.addSensitiveValue(v);
    });
  }

  /**
   * 清除所有注册的敏感值（保留模式）
   */
  clearSensitiveValues(): void {
    this.sensitiveValues.clear();
  }

  /**
   * 添加白名单地址（不会被脱敏）
   */
  addWhitelist(value: string): void {
    this.whitelist.add(value);
  }

  /**
   * 获取当前 IP 模式
   */
  getIpMode(): IpMode {
    return this.ipMode;
  }

  /**
   * 过滤文本中的敏感信息
   */
  sanitize(text: string): string {
    if (!text) return text;

    let result = text;

    // 1. 先替换精确匹配的敏感值（按长度降序，避免短串误匹配）
    const sortedValues = Array.from(this.sensitiveValues)
      .filter((v) => v.length >= 3)
      .sort((a, b) => b.length - a.length);

    for (const value of sortedValues) {
      // 转义正则特殊字符
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(escaped, "g");
      result = result.replace(regex, "[REDACTED]");
    }

    // 2. 应用正则模式（支持白名单）
    for (const { pattern, replacement } of this.patterns) {
      // 重置正则状态（因为使用了 /g 标志）
      pattern.lastIndex = 0;
      result = result.replace(pattern, (match) => {
        // 白名单中的地址不脱敏
        if (this.whitelist.has(match)) {
          return match;
        }
        return replacement;
      });
    }

    return result;
  }

  /**
   * 过滤对象中的敏感信息（递归处理）
   */
  sanitizeObject<T>(obj: T): T {
    if (obj === null || obj === undefined) {
      return obj;
    }

    if (typeof obj === "string") {
      return this.sanitize(obj) as T;
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.sanitizeObject(item)) as T;
    }

    if (typeof obj === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.sanitizeObject(value);
      }
      return result as T;
    }

    return obj;
  }
}

// 全局单例
let globalSanitizer: Sanitizer | null = null;

/**
 * 初始化全局 Sanitizer（启动时调用一次）
 */
export function initSanitizer(ipMode: IpMode = "all", whitelist: string[] = []): Sanitizer {
  globalSanitizer = new Sanitizer(ipMode, whitelist);
  return globalSanitizer;
}

export function getSanitizer(): Sanitizer {
  if (!globalSanitizer) {
    globalSanitizer = new Sanitizer();
  }
  return globalSanitizer;
}

/**
 * 便捷函数：过滤文本
 */
export function sanitize(text: string): string {
  return getSanitizer().sanitize(text);
}

/**
 * 便捷函数：过滤对象
 */
export function sanitizeObject<T>(obj: T): T {
  return getSanitizer().sanitizeObject(obj);
}
