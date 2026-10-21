import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

const execute = promisify(execFile), service = "iSpine Local Workbench", account = "workspace-encryption-v1";
const prefix = Buffer.from("ispine-keychain-v1:");
// Construction and connection browsing never access the Keychain.
export function localKeyProtection({ platform = process.platform, run = execute } = {}) {
  if (platform !== "darwin") return undefined;
  const master = async (create) => {
    try {
      const { stdout } = await run("/usr/bin/security", ["find-generic-password", "-a", account, "-s", service, "-w"], { maxBuffer: 4096 });
      const key = Buffer.from(stdout.trim(), "base64");
      if (key.length !== 32) throw new Error("系统密钥无效。");
      return key;
    } catch (error) {
      if (!create || error.code !== 44) throw new Error("无法打开系统安全存储，原密文已保留。");
      const key = randomBytes(32);
      await run("/usr/bin/security", ["add-generic-password", "-a", account, "-s", service, "-w", key.toString("base64")], { maxBuffer: 4096 });
      return key;
    }
  };
  return {
    isAvailable: () => true,
    async encrypt(value) {
      const key = await master(true), iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
      try { const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return Buffer.concat([prefix, iv, cipher.getAuthTag(), data]); }
      finally { key.fill(0); }
    },
    async decrypt(value) {
      if (!value.subarray(0, prefix.length).equals(prefix)) throw new Error("旧桌面密文已保留，请在网页连接中重新验证该服务。");
      const key = await master(false), offset = prefix.length, decipher = createDecipheriv("aes-256-gcm", key, value.subarray(offset, offset + 12));
      try { decipher.setAuthTag(value.subarray(offset + 12, offset + 28)); return Buffer.concat([decipher.update(value.subarray(offset + 28)), decipher.final()]).toString("utf8"); }
      finally { key.fill(0); }
    },
  };
}
