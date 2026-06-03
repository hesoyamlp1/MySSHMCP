import net from "node:net";

/**
 * 对 host:port 做一次快速 TCP 试连，判断该端口当前有没有人在 listen。
 * 用途：判断某台 mac 的反向隧道是否在线——隧道一连上，VPS 上对应端口就有
 * sshd 在 listen；mac 睡了/断了，端口立刻没人听。所以「机器在不在线」
 * 约等于「这个端口能不能 connect 上」。
 *
 * 不发送任何数据、连上即断，timeout 默认 400ms，保证 list 仍然很快。
 */
export function probeTcp(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}
