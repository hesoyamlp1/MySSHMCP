/**
 * 敏感信息过滤器
 * 用于在 MCP 返回中隐藏 IP、密码等敏感信息
 */

export interface SensitivePattern {
  pattern: RegExp;
  replacement: string;
  description: string;
}

export class Sanitizer {
  private sensitiveValues: Set<string> = new Set();
  private patterns: SensitivePattern[] = [];

  constructor() {
    // 内置通用模式
    this.addPattern({
      pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
      replacement: "[IP]",
      description: "IPv4 地址",
    });

    this.addPattern({
      pattern: /\b([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g,
      replacement: "[IPv6]",
      description: "IPv6 地址",
    });

    this.addPattern({
      pattern: /\b([0-9a-fA-F]{1,4}:){1,7}:\b/g,
      replacement: "[IPv6]",
      description: "IPv6 简写",
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

    // 2. 应用正则模式
    for (const { pattern, replacement } of this.patterns) {
      // 重置正则状态（因为使用了 /g 标志）
      pattern.lastIndex = 0;
      result = result.replace(pattern, replacement);
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
