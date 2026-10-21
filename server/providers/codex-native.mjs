import { IMAGE_CAPABILITIES } from "./capabilities.mjs";
export function codexNativeProvider(rpc, generate) {
  return {
    id: "codex-native", label: "Codex 账号", auth: "chatgpt", models: [], capabilities: IMAGE_CAPABILITIES,
    links: { docs: "https://learn.chatgpt.com/docs/codex" },
    async status() {
      await rpc.start();
      const result = await rpc.request("account/read", { refreshToken: false });
      return { connected: result.account?.type === "chatgpt", message: result.account?.type === "chatgpt"
        ? "已连接本机 Codex 中登录的 ChatGPT 账号，无需填写 API Key。"
        : "请安装 Codex，并使用 ChatGPT 账号登录；也可从这里打开登录页面。" };
    },
    async login() {
      await rpc.start();
      const result = await rpc.request("account/login/start", { type: "chatgpt", useHostedLoginSuccessPage: true });
      const url = new URL(result.authUrl);
      if (url.protocol !== "https:" || url.hostname !== "auth.openai.com" || !result.loginId)
        throw new Error("Codex 未返回有效的官方登录页面，请在 Codex 中登录后刷新连接。");
      return { loginId: result.loginId, authUrl: url.href };
    },
    generate(_settings, options) { return generate(rpc, options); },
  };
}
