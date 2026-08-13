import type { SessionHandle } from "./session.js";

export interface GitCloneParams {
  branch?: string;
  depth?: number;
  directory?: string;
}

export interface GitCheckoutParams {
  create?: boolean;
  /** Repository to operate on (git -C); required when the repo was cloned into a subdirectory. */
  directory?: string;
}

export interface GitDiffParams {
  range?: string;
  base?: string;
  head?: string;
  path?: string;
  /** Repository to operate on (git -C); required when the repo was cloned into a subdirectory. */
  directory?: string;
}

export interface GitLogParams {
  maxCount?: number;
  range?: string;
  path?: string;
  /** Repository to operate on (git -C); required when the repo was cloned into a subdirectory. */
  directory?: string;
}

export interface GitFetchPRParams {
  directory?: string;
  remote?: string;
  branchPrefix?: string;
}

export class Git {
  constructor(private session: SessionHandle) {}

  async clone(repo: string, params?: GitCloneParams): Promise<string> {
    const args: Record<string, string> = { repo };
    if (params?.branch) args["branch"] = params.branch;
    if (params?.depth && params.depth > 0) args["depth"] = String(params.depth);
    if (params?.directory) args["directory"] = params.directory;
    return this.session.gitOperation("clone", args);
  }

  async checkout(ref: string, params?: GitCheckoutParams): Promise<string> {
    const args: Record<string, string> = { ref };
    if (params?.create) args["create"] = "true";
    if (params?.directory) args["directory"] = params.directory;
    return this.session.gitOperation("checkout", args);
  }

  async diff(params?: GitDiffParams): Promise<string> {
    const args: Record<string, string> = {};
    if (params?.range) args["range"] = params.range;
    if (params?.base) args["base"] = params.base;
    if (params?.head) args["head"] = params.head;
    if (params?.path) args["path"] = params.path;
    if (params?.directory) args["directory"] = params.directory;
    return this.session.gitOperation("diff", args);
  }

  async log(params?: GitLogParams): Promise<string> {
    const args: Record<string, string> = {};
    if (params?.maxCount && params.maxCount > 0) args["max_count"] = String(params.maxCount);
    if (params?.range) args["range"] = params.range;
    if (params?.path) args["path"] = params.path;
    if (params?.directory) args["directory"] = params.directory;
    return this.session.gitOperation("log", args);
  }

  async fetchPR(prNumber: number, params?: GitFetchPRParams): Promise<string> {
    if (prNumber <= 0) throw new Error("pr number must be > 0");

    const remote = params?.remote?.trim() || "origin";
    const branchPrefix = params?.branchPrefix?.trim() || "pr";
    const branch = `${branchPrefix}-${prNumber}`;
    const refspec = `pull/${prNumber}/head:${branch}`;

    const baseArgs: string[] = [];
    if (params?.directory?.trim()) {
      baseArgs.push("-C", params.directory.trim());
    }

    const fetchResult = await this.session.exec("git", {
      args: [...baseArgs, "fetch", remote, refspec],
    });
    if (fetchResult.status !== "SUCCEEDED") {
      throw new Error(
        `git fetch PR failed (status=${fetchResult.status} exit_code=${fetchResult.exitCode}): ${new TextDecoder().decode(fetchResult.stderr).trim()}`,
      );
    }

    const checkoutResult = await this.session.exec("git", {
      args: [...baseArgs, "checkout", branch],
    });
    if (checkoutResult.status !== "SUCCEEDED") {
      throw new Error(
        `git checkout PR failed (status=${checkoutResult.status} exit_code=${checkoutResult.exitCode}): ${new TextDecoder().decode(checkoutResult.stderr).trim()}`,
      );
    }

    const fetchOut = new TextDecoder().decode(fetchResult.stdout).trim();
    const checkoutOut = new TextDecoder().decode(checkoutResult.stdout).trim();
    if (!fetchOut) return checkoutOut;
    if (!checkoutOut) return fetchOut;
    return fetchOut + "\n" + checkoutOut;
  }
}
