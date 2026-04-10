#!/usr/bin/env node

import { Command } from "commander";
import { select, input, password, confirm } from "@inquirer/prompts";
import { ConfigManager, ConfigScope } from "./config.js";
import { SSHManager, LOCAL_SERVER } from "./ssh-manager.js";
import { ServerConfig, ProxyConfig, ProxyJumpConfig } from "./types.js";

/**
 * 获取 ConfigManager 实例
 */
function getConfigManager(scope?: ConfigScope): ConfigManager {
  return new ConfigManager(undefined, scope);
}

/**
 * 格式化服务器信息显示（隐藏敏感信息）
 */
function formatServer(server: ServerConfig): string {
  const auth = server.privateKeyPath ? `key:${server.privateKeyPath}` : "password";
  const proxy = server.proxy ? ` [proxy:${server.proxy.host}:${server.proxy.port}]` : "";
  const jump = server.proxyJump ? ` [jump:${server.proxyJump.username}@${server.proxyJump.host}:${server.proxyJump.port || 22}]` : "";
  return `${server.name} (${server.username}@${server.host}:${server.port || 22}) [${auth}]${proxy}${jump}`;
}

/**
 * 格式化 scope 显示
 */
function formatScope(scope: ConfigScope): string {
  return scope === "local" ? "📁 项目级别" : "🌐 用户级别";
}

/**
 * list 命令
 */
async function listServers(options: { local?: boolean; global?: boolean; all?: boolean }): Promise<void> {
  // 先显示内置服务器
  console.log("=== 内置服务器 ===");
  console.log(`  • local (本地 shell)\n`);

  if (options.all) {
    // 显示两个级别的配置
    console.log("=== 项目级别 (local) ===");
    console.log(`路径: ${ConfigManager.getLocalPath()}`);
    if (ConfigManager.localConfigExists()) {
      const localManager = new ConfigManager(undefined, "local");
      const localServers = localManager.listServers();
      if (localServers.length === 0) {
        console.log("(空)\n");
      } else {
        localServers.forEach((s, i) => console.log(`  ${i + 1}. ${formatServer(s)}`));
        console.log("");
      }
    } else {
      console.log("(不存在)\n");
    }

    console.log("=== 用户级别 (global) ===");
    console.log(`路径: ${ConfigManager.getGlobalPath()}`);
    if (ConfigManager.globalConfigExists()) {
      const globalManager = new ConfigManager(undefined, "global");
      const globalServers = globalManager.listServers();
      if (globalServers.length === 0) {
        console.log("(空)");
      } else {
        globalServers.forEach((s, i) => console.log(`  ${i + 1}. ${formatServer(s)}`));
      }
    } else {
      console.log("(不存在)");
    }
    return;
  }

  const scope: ConfigScope | undefined = options.local ? "local" : options.global ? "global" : undefined;
  const configManager = getConfigManager(scope);
  const servers = configManager.listServers();

  console.log(`=== ${formatScope(configManager.getScope())} ===`);
  console.log(`路径: ${configManager.getConfigPath()}\n`);

  if (servers.length === 0) {
    console.log("(空)");
    console.log("\n使用 'mcp-ssh-pty add' 添加服务器");
    return;
  }

  servers.forEach((server, index) => {
    console.log(`  ${index + 1}. ${formatServer(server)}`);
  });
}

/**
 * add 命令 - 支持参数和交互式
 */
async function addServer(name?: string, options?: {
  host?: string;
  port?: string;
  user?: string;
  password?: string;
  key?: string;
  passphrase?: string;
  local?: boolean;
  global?: boolean;
  proxyHost?: string;
  proxyPort?: string;
  proxyType?: string;
  jumpHost?: string;
  jumpPort?: string;
  jumpUser?: string;
  jumpKey?: string;
  jumpPassword?: string;
}): Promise<void> {
  // 确定配置级别
  let scope: ConfigScope | undefined;
  if (options?.local) {
    scope = "local";
  } else if (options?.global) {
    scope = "global";
  } else {
    // 交互式选择
    scope = await select({
      message: "保存到哪个级别?",
      choices: [
        { name: "📁 项目级别 (当前目录/.mori/ssh/)", value: "local" as ConfigScope },
        { name: "🌐 用户级别 (~/.mori/ssh/)", value: "global" as ConfigScope },
      ],
    });
  }

  const configManager = getConfigManager(scope);

  let serverName = name;
  let host = options?.host;
  let port = options?.port ? parseInt(options.port) : 22;
  let username = options?.user;
  let authPassword = options?.password;
  let privateKeyPath = options?.key;
  let passphrase = options?.passphrase;

  // 交互式获取缺失的参数
  if (!serverName) {
    serverName = await input({
      message: "服务器名称:",
      validate: (v) => v.trim() ? true : "名称不能为空",
    });
  }

  if (!host) {
    host = await input({
      message: "主机地址:",
      validate: (v) => v.trim() ? true : "地址不能为空",
    });
  }

  if (!options?.port) {
    const portStr = await input({
      message: "端口:",
      default: "22",
    });
    port = parseInt(portStr) || 22;
  }

  if (!username) {
    username = await input({
      message: "用户名:",
      validate: (v) => v.trim() ? true : "用户名不能为空",
    });
  }

  // 认证方式
  if (!authPassword && !privateKeyPath) {
    const authType = await select({
      message: "认证方式:",
      choices: [
        { name: "私钥", value: "key" },
        { name: "密码", value: "password" },
      ],
    });

    if (authType === "key") {
      privateKeyPath = await input({
        message: "私钥路径:",
        default: "~/.ssh/id_rsa",
      });

      const needPassphrase = await confirm({
        message: "私钥是否有密码保护?",
        default: false,
      });

      if (needPassphrase) {
        passphrase = await password({
          message: "私钥密码:",
        });
      }
    } else {
      authPassword = await password({
        message: "登录密码:",
      });
    }
  }

  const server: ServerConfig = {
    name: serverName,
    host,
    port,
    username,
  };

  if (privateKeyPath) {
    server.privateKeyPath = privateKeyPath;
    if (passphrase) {
      server.passphrase = passphrase;
    }
  } else if (authPassword) {
    server.password = authPassword;
  }

  // 代理配置
  const hasProxyOptions = !!(options?.proxyHost || options?.proxyPort);
  let useProxy = hasProxyOptions;

  if (!hasProxyOptions) {
    useProxy = await confirm({
      message: "是否使用代理连接?",
      default: false,
    });
  }

  if (useProxy) {
    const proxyHost = options?.proxyHost || await input({
      message: "代理地址:",
      default: "127.0.0.1",
    });

    const proxyPort = options?.proxyPort
      ? parseInt(options.proxyPort)
      : parseInt(await input({
        message: "代理端口:",
        default: "10809",
      })) || 10809;

    const proxyType = options?.proxyType
      ? (parseInt(options.proxyType) as 4 | 5)
      : await select({
        message: "代理类型:",
        choices: [
          { name: "SOCKS5", value: 5 as const },
          { name: "SOCKS4", value: 4 as const },
        ],
      });

    server.proxy = {
      host: proxyHost,
      port: proxyPort,
      type: proxyType,
    };

    if (!hasProxyOptions) {
      const proxyNeedAuth = await confirm({
        message: "代理是否需要认证?",
        default: false,
      });

      if (proxyNeedAuth) {
        server.proxy.username = await input({
          message: "代理用户名:",
        });
        server.proxy.password = await password({
          message: "代理密码:",
        });
      }
    }
  }

  // ProxyJump 配置
  if (!useProxy) {
    const hasJumpOptions = !!(options?.jumpHost || options?.jumpUser);
    let useJump = hasJumpOptions;

    if (!hasJumpOptions) {
      useJump = await confirm({
        message: "是否使用 ProxyJump 跳板机?",
        default: false,
      });
    }

    if (useJump) {
      const jumpHost = options?.jumpHost || await input({
        message: "跳板机地址:",
        validate: (v) => v.trim() ? true : "地址不能为空",
      });

      const jumpPort = options?.jumpPort
        ? parseInt(options.jumpPort)
        : parseInt(await input({
          message: "跳板机端口:",
          default: "22",
        })) || 22;

      const jumpUser = options?.jumpUser || await input({
        message: "跳板机用户名:",
        validate: (v) => v.trim() ? true : "用户名不能为空",
      });

      const jumpConfig: ProxyJumpConfig = {
        host: jumpHost,
        port: jumpPort,
        username: jumpUser,
      };

      if (options?.jumpKey) {
        jumpConfig.privateKeyPath = options.jumpKey;
      } else if (options?.jumpPassword) {
        jumpConfig.password = options.jumpPassword;
      } else {
        const jumpAuthType = await select({
          message: "跳板机认证方式:",
          choices: [
            { name: "私钥", value: "key" },
            { name: "密码", value: "password" },
          ],
        });

        if (jumpAuthType === "key") {
          jumpConfig.privateKeyPath = await input({
            message: "跳板机私钥路径:",
            default: "~/.ssh/id_rsa",
          });
        } else {
          jumpConfig.password = await password({
            message: "跳板机密码:",
          });
        }
      }

      server.proxyJump = jumpConfig;
    }
  }

  // 检查是否已存在
  const existing = configManager.getServer(serverName);
  if (existing) {
    const overwrite = await confirm({
      message: `服务器 '${serverName}' 已存在，是否覆盖?`,
      default: false,
    });
    if (!overwrite) {
      console.log("已取消");
      return;
    }
  }

  configManager.addServer(server);
  console.log(`\n✓ 服务器 '${serverName}' 已添加`);
  console.log(`  级别: ${formatScope(scope)}`);
  console.log(`  配置文件: ${configManager.getConfigPath()}`);
}

/**
 * remove 命令
 */
async function removeServer(name?: string, options?: { local?: boolean; global?: boolean }): Promise<void> {
  const scope: ConfigScope | undefined = options?.local ? "local" : options?.global ? "global" : undefined;
  const configManager = getConfigManager(scope);
  const servers = configManager.listServers();

  console.log(`配置级别: ${formatScope(configManager.getScope())}\n`);

  if (servers.length === 0) {
    console.log("没有配置任何服务器");
    return;
  }

  let serverName = name;

  if (!serverName) {
    serverName = await select({
      message: "选择要删除的服务器:",
      choices: servers.map((s) => ({
        name: formatServer(s),
        value: s.name,
      })),
    });
  }

  const server = configManager.getServer(serverName);
  if (!server) {
    console.log(`服务器 '${serverName}' 不存在`);
    return;
  }

  const confirmed = await confirm({
    message: `确定要删除服务器 '${serverName}' 吗?`,
    default: false,
  });

  if (!confirmed) {
    console.log("已取消");
    return;
  }

  configManager.removeServer(serverName);
  console.log(`\n✓ 服务器 '${serverName}' 已删除`);
}

/**
 * test 命令 - 测试连接
 */
async function testServer(name?: string, options?: { local?: boolean; global?: boolean }): Promise<void> {
  const scope: ConfigScope | undefined = options?.local ? "local" : options?.global ? "global" : undefined;
  const configManager = getConfigManager(scope);
  const servers = configManager.listServers();

  let serverName = name;

  if (!serverName) {
    const choices = [
      { name: "local (本地 shell)", value: "local" },
      ...servers.map((s) => ({
        name: formatServer(s),
        value: s.name,
      })),
    ];

    serverName = await select({
      message: "选择要测试的服务器:",
      choices,
    });
  }

  const server = serverName === "local" ? LOCAL_SERVER : configManager.getServer(serverName);
  if (!server) {
    if (servers.length === 0) {
      console.log("没有配置任何服务器");
    } else {
      console.log(`服务器 '${serverName}' 不存在`);
    }
    return;
  }

  console.log(`\n测试连接到 '${serverName}'...`);
  if (serverName === "local") {
    console.log("  使用内置本地 shell");
  }
  if (server.proxy) {
    console.log(`  通过代理: ${server.proxy.host}:${server.proxy.port} (SOCKS${server.proxy.type || 5})`);
  }

  const sshManager = new SSHManager();

  try {
    await sshManager.connect(server);
    console.log("✓ 连接成功!");

    // 执行简单命令测试
    const shellManager = sshManager.getShellManager();
    const result = await shellManager.send("echo 'SSH connection test successful'");

    if (result.complete) {
      console.log("✓ Shell 正常工作");
    }

    await sshManager.disconnect();
    console.log("✓ 已断开连接");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`✗ 连接失败: ${message}`);
    process.exit(1);
  }
}

/**
 * config 命令 - 交互式配置
 */
async function interactiveConfig(): Promise<void> {
  // 先选择配置级别
  const scope = await select({
    message: "选择配置级别:",
    choices: [
      {
        name: `📁 项目级别 (${ConfigManager.localConfigExists() ? "已存在" : "新建"})`,
        value: "local" as ConfigScope,
      },
      {
        name: `🌐 用户级别 (${ConfigManager.globalConfigExists() ? "已存在" : "新建"})`,
        value: "global" as ConfigScope,
      },
    ],
  });

  const configManager = getConfigManager(scope);

  console.log(`\n当前配置: ${formatScope(scope)}`);
  console.log(`路径: ${configManager.getConfigPath()}\n`);

  while (true) {
    const action = await select({
      message: "选择操作:",
      choices: [
        { name: "📋 查看所有服务器", value: "list" },
        { name: "➕ 添加服务器", value: "add" },
        { name: "✏️  编辑服务器", value: "edit" },
        { name: "🗑️  删除服务器", value: "remove" },
        { name: "🔌 测试连接", value: "test" },
        { name: "🔄 切换配置级别", value: "switch" },
        { name: "📁 显示配置文件路径", value: "path" },
        { name: "🚪 退出", value: "exit" },
      ],
    });

    console.log("");

    switch (action) {
      case "list": {
        const servers = configManager.listServers();
        if (servers.length === 0) {
          console.log("没有配置任何服务器");
        } else {
          servers.forEach((s, i) => console.log(`  ${i + 1}. ${formatServer(s)}`));
        }
        break;
      }

      case "add":
        await addServerToManager(configManager);
        break;

      case "edit": {
        const servers = configManager.listServers();
        if (servers.length === 0) {
          console.log("没有配置任何服务器");
          break;
        }

        const editName = await select({
          message: "选择要编辑的服务器:",
          choices: servers.map((s) => ({
            name: formatServer(s),
            value: s.name,
          })),
        });

        const server = configManager.getServer(editName);
        if (server) {
          console.log("\n当前配置:");
          console.log(`  名称: ${server.name}`);
          console.log(`  主机: ${server.host}`);
          console.log(`  端口: ${server.port || 22}`);
          console.log(`  用户: ${server.username}`);
          console.log(`  认证: ${server.privateKeyPath ? `私钥(${server.privateKeyPath})` : "密码"}`);
          if (server.proxy) {
            console.log(`  代理: ${server.proxy.host}:${server.proxy.port} (SOCKS${server.proxy.type || 5})`);
          }
          if (server.proxyJump) {
            console.log(`  跳板机: ${server.proxyJump.username}@${server.proxyJump.host}:${server.proxyJump.port || 22}`);
          }
          console.log("\n重新输入新配置:\n");

          await addServerToManager(configManager, server.name);
        }
        break;
      }

      case "remove": {
        const servers = configManager.listServers();
        if (servers.length === 0) {
          console.log("没有配置任何服务器");
          break;
        }

        const removeName = await select({
          message: "选择要删除的服务器:",
          choices: servers.map((s) => ({
            name: formatServer(s),
            value: s.name,
          })),
        });

        const confirmed = await confirm({
          message: `确定要删除服务器 '${removeName}' 吗?`,
          default: false,
        });

        if (confirmed) {
          configManager.removeServer(removeName);
          console.log(`✓ 服务器 '${removeName}' 已删除`);
        } else {
          console.log("已取消");
        }
        break;
      }

      case "test": {
        const servers = configManager.listServers();
        if (servers.length === 0) {
          console.log("没有配置任何服务器");
          break;
        }

        const testName = await select({
          message: "选择要测试的服务器:",
          choices: servers.map((s) => ({
            name: formatServer(s),
            value: s.name,
          })),
        });

        const server = configManager.getServer(testName);
        if (server) {
          console.log(`\n测试连接到 '${testName}'...`);
          if (server.proxy) {
            console.log(`  通过代理: ${server.proxy.host}:${server.proxy.port} (SOCKS${server.proxy.type || 5})`);
          }
          const sshManager = new SSHManager();
          try {
            await sshManager.connect(server);
            console.log("✓ 连接成功!");
            await sshManager.disconnect();
            console.log("✓ 已断开连接");
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.log(`✗ 连接失败: ${message}`);
          }
        }
        break;
      }

      case "switch":
        // 递归调用，切换级别
        return interactiveConfig();

      case "path":
        console.log(`配置级别: ${formatScope(scope)}`);
        console.log(`配置文件路径: ${configManager.getConfigPath()}`);
        console.log(`文件是否存在: ${configManager.configExists() ? "是" : "否"}`);
        break;

      case "exit":
        console.log("再见!");
        return;
    }

    console.log("");
  }
}

/**
 * 向指定 ConfigManager 添加服务器
 */
async function addServerToManager(configManager: ConfigManager, existingName?: string): Promise<void> {
  const serverName = existingName || await input({
    message: "服务器名称:",
    validate: (v) => v.trim() ? true : "名称不能为空",
  });

  const host = await input({
    message: "主机地址:",
    validate: (v) => v.trim() ? true : "地址不能为空",
  });

  const portStr = await input({
    message: "端口:",
    default: "22",
  });
  const port = parseInt(portStr) || 22;

  const username = await input({
    message: "用户名:",
    validate: (v) => v.trim() ? true : "用户名不能为空",
  });

  const authType = await select({
    message: "认证方式:",
    choices: [
      { name: "私钥", value: "key" },
      { name: "密码", value: "password" },
    ],
  });

  const server: ServerConfig = {
    name: serverName,
    host,
    port,
    username,
  };

  if (authType === "key") {
    server.privateKeyPath = await input({
      message: "私钥路径:",
      default: "~/.ssh/id_rsa",
    });

    const needPassphrase = await confirm({
      message: "私钥是否有密码保护?",
      default: false,
    });

    if (needPassphrase) {
      server.passphrase = await password({
        message: "私钥密码:",
      });
    }
  } else {
    server.password = await password({
      message: "登录密码:",
    });
  }

  // 代理配置
  const useProxy = await confirm({
    message: "是否使用代理连接?",
    default: false,
  });

  if (useProxy) {
    const proxyHost = await input({
      message: "代理地址:",
      default: "127.0.0.1",
    });

    const proxyPortStr = await input({
      message: "代理端口:",
      default: "10809",
    });
    const proxyPort = parseInt(proxyPortStr) || 10809;

    const proxyType = await select({
      message: "代理类型:",
      choices: [
        { name: "SOCKS5", value: 5 as const },
        { name: "SOCKS4", value: 4 as const },
      ],
    });

    server.proxy = {
      host: proxyHost,
      port: proxyPort,
      type: proxyType,
    };

    // 代理认证（可选）
    const proxyNeedAuth = await confirm({
      message: "代理是否需要认证?",
      default: false,
    });

    if (proxyNeedAuth) {
      server.proxy.username = await input({
        message: "代理用户名:",
      });
      server.proxy.password = await password({
        message: "代理密码:",
      });
    }
  }

  // ProxyJump 配置（仅在不使用代理时可选）
  if (!server.proxy) {
    const useJump = await confirm({
      message: "是否使用 ProxyJump 跳板机?",
      default: false,
    });

    if (useJump) {
      const jumpHost = await input({
        message: "跳板机地址:",
        validate: (v) => v.trim() ? true : "地址不能为空",
      });

      const jumpPortStr = await input({
        message: "跳板机端口:",
        default: "22",
      });

      const jumpUser = await input({
        message: "跳板机用户名:",
        validate: (v) => v.trim() ? true : "用户名不能为空",
      });

      const jumpAuthType = await select({
        message: "跳板机认证方式:",
        choices: [
          { name: "私钥", value: "key" },
          { name: "密码", value: "password" },
        ],
      });

      const jumpConfig: ProxyJumpConfig = {
        host: jumpHost,
        port: parseInt(jumpPortStr) || 22,
        username: jumpUser,
      };

      if (jumpAuthType === "key") {
        jumpConfig.privateKeyPath = await input({
          message: "跳板机私钥路径:",
          default: "~/.ssh/id_rsa",
        });
      } else {
        jumpConfig.password = await password({
          message: "跳板机密码:",
        });
      }

      server.proxyJump = jumpConfig;
    }
  }

  configManager.addServer(server);
  console.log(`\n✓ 服务器 '${serverName}' 已保存`);
}

/**
 * 创建 CLI 程序
 */
export function createCLI(): Command {
  const program = new Command();

  program
    .name("mcp-ssh-pty")
    .description("SSH MCP Server with PTY shell support")
    .version("1.0.0");

  program
    .command("list")
    .description("列出所有已配置的服务器")
    .option("-l, --local", "只显示项目级别配置")
    .option("-g, --global", "只显示用户级别配置")
    .option("-a, --all", "显示所有级别配置")
    .action(listServers);

  program
    .command("add [name]")
    .description("添加新服务器")
    .option("-l, --local", "保存到项目级别")
    .option("-g, --global", "保存到用户级别")
    .option("-H, --host <host>", "主机地址")
    .option("-P, --port <port>", "端口")
    .option("-u, --user <user>", "用户名")
    .option("-p, --password <password>", "密码（⚠️ 会出现在进程列表中，建议使用交互式输入）")
    .option("-k, --key <path>", "私钥路径")
    .option("--passphrase <passphrase>", "私钥密码")
    .option("--proxy-host <host>", "代理地址")
    .option("--proxy-port <port>", "代理端口")
    .option("--proxy-type <type>", "代理类型 (4 或 5)")
    .option("--jump-host <host>", "ProxyJump 跳板机地址")
    .option("--jump-port <port>", "ProxyJump 跳板机端口")
    .option("--jump-user <user>", "ProxyJump 跳板机用户名")
    .option("--jump-key <path>", "ProxyJump 跳板机私钥路径")
    .option("--jump-password <password>", "ProxyJump 跳板机密码")
    .action(addServer);

  program
    .command("remove [name]")
    .alias("rm")
    .description("删除服务器")
    .option("-l, --local", "从项目级别删除")
    .option("-g, --global", "从用户级别删除")
    .action(removeServer);

  program
    .command("test [name]")
    .description("测试服务器连接")
    .option("-l, --local", "使用项目级别配置")
    .option("-g, --global", "使用用户级别配置")
    .action(testServer);

  program
    .command("config")
    .description("交互式配置管理")
    .action(interactiveConfig);

  return program;
}

// 如果直接运行此文件
export async function runCLI(): Promise<void> {
  const program = createCLI();
  await program.parseAsync(process.argv);
}
