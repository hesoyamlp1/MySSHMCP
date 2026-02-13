/**
 * Sanitizer 测试脚本
 * 运行: npx tsx test-sanitizer.ts
 */
import { Sanitizer } from "./src/sanitizer.js";

const sanitizer = new Sanitizer();
let passed = 0;
let failed = 0;

function test(description: string, input: string, expected: string) {
    const result = sanitizer.sanitize(input);
    if (result === expected) {
        passed++;
        console.log(`  ✅ ${description}`);
    } else {
        failed++;
        console.log(`  ❌ ${description}`);
        console.log(`     输入:   ${input}`);
        console.log(`     期望:   ${expected}`);
        console.log(`     实际:   ${result}`);
    }
}

console.log("\n=== IPv4 脱敏测试 ===");
test("普通 IPv4", "服务器 IP 是 192.168.1.100", "服务器 IP 是 [IP]");
test("多个 IPv4", "从 10.0.0.1 到 10.0.0.255", "从 [IP] 到 [IP]");
test("IP 嵌入文本", "inet 192.168.1.50/24 brd 192.168.1.255", "inet [IP]/24 brd [IP]");
test("白名单 127.0.0.1", "localhost: 127.0.0.1", "localhost: 127.0.0.1");
test("白名单 0.0.0.0", "bind 0.0.0.0:8080", "bind 0.0.0.0:8080");

console.log("\n=== IPv6 脱敏测试 ===");
test("完整 IPv6", "地址 2001:0db8:85a3:0000:0000:8a2e:0370:7334", "地址 [IPv6]");
test("IPv6 缩写 (::后缀)", "loopback ::1 test", "loopback ::1 test");  // ::1 in whitelist
test("IPv6 缩写 (前缀::后缀)", "地址 2001:db8::1 end", "地址 [IPv6] end");
test("IPv6 带前缀::  ", "地址 fe80:: 结束", "地址 [IPv6] 结束");
test("IPv4-mapped IPv6", "mapped ::ffff:192.168.1.1 end", "mapped [IPv6] end");

console.log("\n=== MAC 地址脱敏测试 ===");
test("MAC 冒号分隔", "mac: aa:bb:cc:dd:ee:ff", "mac: [MAC]");
test("MAC 横线分隔", "mac: AA-BB-CC-DD-EE-FF", "mac: [MAC]");
test("ifconfig 输出", "ether 08:00:27:1a:2b:3c txqueuelen", "ether [MAC] txqueuelen");

console.log("\n=== 精确值匹配测试 ===");
sanitizer.addSensitiveValue("my_secret_password");
sanitizer.addSensitiveValue("admin_user");
test("密码脱敏", "password: my_secret_password", "password: [REDACTED]");
test("用户名脱敏", "user: admin_user", "user: [REDACTED]");
test("短值忽略", "ab", "ab");  // 小于 3 字符不注册

console.log("\n=== 白名单测试 ===");
test("白名单 :: 保留", "bind :: port 80", "bind :: port 80");

console.log("\n=== 混合场景测试 ===");
test("ifconfig 输出综合",
    "eth0: inet 10.0.2.15 netmask 255.255.255.0 ether 08:00:27:ab:cd:ef",
    "eth0: inet [IP] netmask [IP] ether [MAC]"
);
test("SSH 错误消息",
    "Connection refused by 203.0.113.50 port 22",
    "Connection refused by [IP] port 22"
);

console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===\n`);
process.exit(failed > 0 ? 1 : 0);
