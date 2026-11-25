import { InjectionCredentialInput } from "./injection-credentials.js";

export function githubInjectionCredentials(token: string): InjectionCredentialInput[] {
  token = token.trim();
  if (!token) throw new Error("GitHub token injection requires a nonempty github token");
  return [
    new InjectionCredentialInput("SDK_GITHUB_API", Buffer.from(token), [
      {
        origin: "https://api.github.com",
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
        pathPrefix: "/",
        header: "Authorization",
      },
    ]),
    new InjectionCredentialInput(
      "SDK_GITHUB_GIT",
      Buffer.from(Buffer.from("x-access-token:" + token).toString("base64")),
      [{ origin: "https://github.com", methods: ["GET", "POST"], pathPrefix: "/", header: "Authorization" }],
    ),
  ];
}

export function githubInjectionEnv(env: Record<string, string>): void {
  if (env.GH_HOST && env.GH_HOST !== "github.com") throw new Error("GitHub token injection supports github.com only");
  if (Object.keys(env).some((key) => key.startsWith("GIT_CONFIG")))
    throw new Error("GitHub token injection reserves GIT_CONFIG environment variables");
  env.GH_TOKEN = "secrets://SDK_GITHUB_API";
  env.GIT_TOKEN = env.GH_TOKEN;
  const settings = [
    ["http.https://github.com/.extraHeader", "Authorization: Basic secrets://SDK_GITHUB_GIT"],
    ["http.https://github.com/.version", "HTTP/1.1"],
    ["credential.https://github.com.helper", ""],
    ["http.https://github.com/.followRedirects", "false"],
  ];
  env.GIT_CONFIG_COUNT = String(settings.length);
  settings.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key!;
    env[`GIT_CONFIG_VALUE_${i}`] = value!;
  });
}
